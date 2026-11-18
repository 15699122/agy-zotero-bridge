import { killProcessTree } from './process-runner.mjs';

const nonNegNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * Computes per-turn non-negative token deltas from cumulative session usage counters,
 * resetting cleanly if an underlying process restarts or reports lower counts.
 */
export function normalizeCumulativeUsage(currentUsage, previousCumulativeUsage = null) {
  const curr = currentUsage && typeof currentUsage === 'object' ? currentUsage : {};
  const current = {
    inputTokens: nonNegNum(curr.inputTokens ?? curr.input_tokens),
    outputTokens: nonNegNum(curr.outputTokens ?? curr.output_tokens),
    cacheReadInputTokens: nonNegNum(curr.cacheReadInputTokens ?? curr.cache_read_tokens),
    cacheCreationInputTokens: nonNegNum(curr.cacheCreationInputTokens ?? curr.cache_creation_tokens),
    contextTokens: nonNegNum(curr.contextTokens ?? curr.total_tokens)
  };

  if (!previousCumulativeUsage || typeof previousCumulativeUsage !== 'object') {
    return {
      ...current,
      cumulative: current
    };
  }

  const delta = (currVal, prevVal) => {
    const p = nonNegNum(prevVal);
    return currVal >= p ? currVal - p : currVal;
  };

  return {
    inputTokens: delta(current.inputTokens, previousCumulativeUsage.inputTokens),
    outputTokens: delta(current.outputTokens, previousCumulativeUsage.outputTokens),
    cacheReadInputTokens: delta(current.cacheReadInputTokens, previousCumulativeUsage.cacheReadInputTokens),
    cacheCreationInputTokens: delta(
      current.cacheCreationInputTokens,
      previousCumulativeUsage.cacheCreationInputTokens
    ),
    contextTokens: delta(current.contextTokens, previousCumulativeUsage.contextTokens),
    cumulative: current
  };
}

/**
 * M4/M7-01 session process pool (enabled by default unless AGY_PROCESS_POOL=0).
 * Tracks retention state, LRU capacity eviction, idle TTL cleanup,
 * max-turn / max-age rotation, and process-tree teardown.
 */
export class SessionProcessPool {
  constructor({
    enabled = true,
    maxSize = 4,
    idleTtlMs = 300_000,
    maxTurnsPerProcess = 20,
    maxProcessAgeMs = 25 * 60 * 1000,
    onKill = killProcessTree
  } = {}) {
    this.enabled = Boolean(enabled);
    this.maxSize = Math.max(1, Number(maxSize) || 4);
    this.idleTtlMs = Math.max(10, Number(idleTtlMs) || 300_000);
    this.maxTurnsPerProcess = Math.max(1, Number(maxTurnsPerProcess) || 20);
    this.maxProcessAgeMs = Math.max(1000, Number(maxProcessAgeMs) || 25 * 60 * 1000);
    this.onKill = onKill;
    this.entries = new Map();
    this.retainedKeys = new Set();
  }

  #scheduleIdleTimer(scopedKey, entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (entry.busy) return;
    const timer = setTimeout(() => {
      if (!entry.busy && this.entries.get(scopedKey) === entry) {
        this.invalidate(scopedKey);
      }
    }, this.idleTtlMs);
    timer.unref?.();
    entry.timer = timer;
  }

  #evictOneIdleLru() {
    for (const [k, entry] of this.entries.entries()) {
      if (!entry.busy) {
        return this.invalidate(k);
      }
    }
    return false;
  }

  retain(scopedKey, shouldRetain = true) {
    if (!this.enabled || !scopedKey) return false;
    if (shouldRetain) {
      this.retainedKeys.add(scopedKey);
      const existing = this.entries.get(scopedKey);
      if (existing) this.#scheduleIdleTimer(scopedKey, existing);
      return true;
    }
    this.retainedKeys.delete(scopedKey);
    this.invalidate(scopedKey);
    return false;
  }

  isRetained(scopedKey) {
    return this.enabled && Boolean(scopedKey) && this.retainedKeys.has(scopedKey);
  }

  register(scopedKey, { child = null, sessionId = '', meta = {}, cumulativeUsage = null, busy = false } = {}) {
    if (!this.enabled || !scopedKey) return null;

    const prev = this.entries.get(scopedKey);
    if (prev) {
      if (prev.timer) clearTimeout(prev.timer);
      if (prev.child && prev.child !== child) {
        this.onKill?.(prev.child);
      }
      this.entries.delete(scopedKey);
    } else {
      while (this.entries.size >= this.maxSize) {
        if (!this.#evictOneIdleLru()) break;
      }
    }

    const now = Date.now();
    const entry = {
      scopedKey,
      child,
      sessionId,
      meta,
      cumulativeUsage,
      busy: Boolean(busy),
      turnCount: 0,
      createdAt: now,
      lastUsedAt: now,
      timer: null
    };
    this.entries.set(scopedKey, entry);
    this.#scheduleIdleTimer(scopedKey, entry);
    return entry;
  }

  isReusable(scopedKey, signature) {
    if (!this.enabled || !scopedKey) return false;
    const entry = this.entries.get(scopedKey);
    if (!entry || !entry.child) return false;
    if (entry.meta?.closed || entry.child.exitCode !== null || entry.child.signalCode !== null) {
      return false;
    }
    if (entry.meta?.signature !== signature) return false;
    if ((entry.turnCount || 0) >= this.maxTurnsPerProcess) return false;
    if (Date.now() - entry.createdAt >= this.maxProcessAgeMs) return false;
    return true;
  }

  recordTurn(scopedKey, { sessionId = '', cumulativeUsage = null } = {}) {
    const entry = this.entries.get(scopedKey);
    if (!entry) return null;
    entry.turnCount = (entry.turnCount || 0) + 1;
    entry.lastUsedAt = Date.now();
    if (sessionId) entry.sessionId = sessionId;
    if (cumulativeUsage) entry.cumulativeUsage = cumulativeUsage;
    if (entry.turnCount >= this.maxTurnsPerProcess || Date.now() - entry.createdAt >= this.maxProcessAgeMs) {
      this.invalidate(scopedKey, { keepRetained: true });
      return null;
    }
    return entry;
  }

  get(scopedKey) {
    return this.entries.get(scopedKey) || null;
  }

  touch(scopedKey) {
    const entry = this.entries.get(scopedKey);
    if (!entry) return null;
    entry.lastUsedAt = Date.now();
    this.entries.delete(scopedKey);
    this.entries.set(scopedKey, entry);
    this.#scheduleIdleTimer(scopedKey, entry);
    return entry;
  }

  setBusy(scopedKey, busy) {
    const entry = this.entries.get(scopedKey);
    if (!entry) return null;
    entry.busy = Boolean(busy);
    entry.lastUsedAt = Date.now();
    this.#scheduleIdleTimer(scopedKey, entry);
    return entry;
  }

  invalidate(scopedKey, { keepRetained = false } = {}) {
    if (!keepRetained) {
      this.retainedKeys.delete(scopedKey);
    }
    const entry = this.entries.get(scopedKey);
    if (!entry) return false;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(scopedKey);
    if (entry.child) {
      this.onKill?.(entry.child);
    }
    return true;
  }

  invalidateAll() {
    const count = this.entries.size;
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.child) {
        this.onKill?.(entry.child);
      }
    }
    this.entries.clear();
    this.retainedKeys.clear();
    return count;
  }

  getStats() {
    return {
      enabled: this.enabled,
      size: this.entries.size,
      maxSize: this.maxSize,
      idleTtlMs: this.idleTtlMs,
      maxTurnsPerProcess: this.maxTurnsPerProcess,
      maxProcessAgeMs: this.maxProcessAgeMs,
      retainedCount: this.retainedKeys.size
    };
  }

  close() {
    return this.invalidateAll();
  }
}
