import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import {
  buildTurnPrompt,
  collectLocalDocuments,
  sanitizeLocalPdfText,
  sanitizeLocalPdfValue
} from '../context/prompt-builder.mjs';
import { prepareScopedMcpPlugin, writeScopedAgySettingsFile } from '../mcp/zotero-mcp.mjs';
import { classifyAgyError, createTurnEventMapper } from '../protocol/event-mapper.mjs';
import { redactSensitive } from '../security/redact.mjs';
import { resolveAgyModelAndEffort } from './cli-probe.mjs';
import { normalizeCumulativeUsage } from './process-pool.mjs';

const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');

export class BridgeHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Terminates a spawned agy process and its Windows child process tree cleanly.
 */
export function killProcessTree(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    child.stdin?.end();
  } catch {
    // Ignore errors when stdin is already closed.
  }

  try {
    child.kill();
  } catch {
    // Ignore errors when process is already exiting.
  }

  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.on('error', () => {});
      killer.unref();
    } catch {
      // Ignore taskkill launch failure.
    }
  }
}

/**
 * Resolves agy CLI permission flags without ever auto-enabling yolo.
 */
export function permissionArgs(body, config) {
  const metadata = record(record(body).metadata);
  const mode = str(metadata.permissionMode || config.defaultPermissionMode || 'default').trim().toLowerCase();
  switch (mode) {
    case 'yolo':
    case 'bypasspermissions':
      if (!config.allowYolo) {
        throw new Error('yolo permission mode disabled: set AGY_ALLOW_YOLO=1 only after explicit review');
      }
      return ['--dangerously-skip-permissions'];
    case 'auto':
      return ['--mode', 'auto', '--sandbox'];
    case 'acceptedits':
      return ['--mode', 'accept-edits'];
    case 'plan':
      return ['--mode', 'plan'];
    case 'default':
    case 'safe':
    case 'dontask':
    case '':
      return [];
    default:
      throw new Error(`Unsupported permission mode: ${mode}`);
  }
}

function waitForExitBounded(child, graceMs = 1500) {
  const exitPromise = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode, timedOutExit: false });
      return;
    }
    child.once('close', (code, signal) => resolve({ code, signal, timedOutExit: false }));
  });
  return {
    awaitNormal: () => exitPromise,
    awaitBounded: () =>
      Promise.race([
        exitPromise,
        new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: 'SIGKILL', timedOutExit: true }), graceMs))
      ])
  };
}

function clampTimeout(rawMs, fallbackMs) {
  const n = Number(rawMs);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return Math.max(1000, Math.min(600_000, Math.floor(n)));
}

function stripJsonCodeFence(text) {
  const trimmed = str(text).trim();
  const match = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

/**
 * Streaming sanitizer for local PDF paths across `message_delta` chunks so paths
 * spanning chunk boundaries cannot leak into Zotero transcripts.
 */
function createDeltaSanitizer(replacements) {
  let held = '';
  return {
    push(chunk) {
      if (!replacements?.length || !chunk) return chunk;
      const combined = sanitizeLocalPdfText(held + chunk, replacements);
      let holdLen = 0;
      for (const { pattern } of replacements) {
        const maxPrefix = Math.min(combined.length, pattern.length - 1);
        for (let len = maxPrefix; len > holdLen; len -= 1) {
          if (combined.endsWith(pattern.slice(0, len))) {
            holdLen = len;
            break;
          }
        }
      }
      if (holdLen === 0) {
        held = '';
        return combined;
      }
      held = combined.slice(-holdLen);
      return combined.slice(0, -holdLen);
    },
    flush() {
      if (!held) return '';
      const out = sanitizeLocalPdfText(held, replacements);
      held = '';
      return out;
    }
  };
}

function buildSanitizedEventEmitter(emitEventRaw, localPdfReplacements) {
  const deltaSanitizer = createDeltaSanitizer(localPdfReplacements);
  return (ev) => {
    if (!localPdfReplacements.length) {
      emitEventRaw(ev);
      return;
    }
    if (ev.type === 'message_delta') {
      const text = deltaSanitizer.push(ev.text);
      if (text) emitEventRaw({ ...ev, text });
      return;
    }
    if (ev.type === 'final') {
      const trailing = deltaSanitizer.flush();
      if (trailing) emitEventRaw({ type: 'message_delta', text: trailing });
      emitEventRaw(sanitizeLocalPdfValue(ev, localPdfReplacements));
      return;
    }
    emitEventRaw(sanitizeLocalPdfValue(ev, localPdfReplacements));
  };
}

function createPooledChildRuntime({
  key,
  poolSignature,
  spawnArgs,
  cwd,
  config,
  processPool,
  sessionId = ''
}) {
  const child = spawn(config.binary, [...config.prefixArgs, ...spawnArgs], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const runtime = {
    child,
    rl,
    signature: poolSignature,
    closed: false,
    exitInfo: { code: null, signal: null },
    childError: null,
    activeTurn: null
  };

  const entry = processPool.register(key, {
    child,
    sessionId,
    meta: runtime,
    cumulativeUsage: null,
    busy: true
  });

  child.on('error', (e) => {
    runtime.childError = e;
    runtime.activeTurn?.onError(e);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    runtime.activeTurn?.onStderr(d);
  });
  rl.on('line', (line) => {
    runtime.activeTurn?.onLine(line);
  });
  child.once('close', (code, signal) => {
    runtime.closed = true;
    runtime.exitInfo = { code, signal };
    rl.close();
    runtime.activeTurn?.onClose(runtime.exitInfo);
    if (processPool.get(key) === entry) {
      processPool.invalidate(key);
    }
  });

  return entry;
}

async function runPooledTurn({
  entry,
  prompt,
  runId,
  model,
  config,
  controller,
  timeoutMs,
  emitSanitizedEvent,
  onTools
}) {
  const runtime = entry.meta;
  let turnStderr = '';
  let latestCumulativeUsage = null;
  let settled = false;

  const mapper = createTurnEventMapper({
    runId,
    model,
    onEvent: (ev) => {
      if (ev.type === 'usage') {
        const normalized = normalizeCumulativeUsage(ev, entry.cumulativeUsage);
        latestCumulativeUsage = normalized.cumulative;
        const { cumulative: _omit, ...deltaUsage } = normalized;
        emitSanitizedEvent({ ...ev, ...deltaUsage });
        return;
      }
      emitSanitizedEvent(ev);
    },
    onTools,
    maxNdjsonLine: config.maxNdjsonLine,
    extraSecrets: [config.token]
  });

  if (runtime.childError) throw runtime.childError;
  if (runtime.closed || runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
    const err = new Error('pooled agy process exited before turn');
    err.errorCode = 'process_exit_error';
    throw err;
  }

  return await new Promise((resolveTurn, rejectTurn) => {
    const fail = (err) => {
      if (settled) return;
      settled = true;
      runtime.activeTurn = null;
      controller.signal.removeEventListener('abort', onAbort);
      rejectTurn(err);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      runtime.activeTurn = null;
      controller.signal.removeEventListener('abort', onAbort);
      resolveTurn({
        state: mapper.getState(),
        stderr: turnStderr,
        exitInfo: { code: 0, signal: null },
        latestCumulativeUsage
      });
    };

    const onAbort = () => {
      try {
        runtime.child.stdin?.end();
      } catch {
        // Ignore stdin close error.
      }
      killProcessTree(runtime.child);
      const err = new Error('aborted');
      err.errorCode = 'cancelled';
      fail(err);
    };

    runtime.activeTurn = {
      onStderr(d) {
        turnStderr = (turnStderr + d).slice(-config.maxStderr);
      },
      onLine(line) {
        if (controller.signal.aborted || settled) return;
        try {
          mapper.processLine(line);
        } catch (err) {
          fail(err);
          return;
        }
        const st = mapper.getState();
        if (st.resultSeen) {
          if (st.success) succeed();
          else fail(new Error('agy did not complete successfully'));
        }
      },
      onError(e) {
        fail(e);
      },
      onClose(exitInfo) {
        const snippet = turnStderr ? `: ${turnStderr.slice(-1200)}` : '';
        if (exitInfo?.code && exitInfo.code !== 0) {
          const err = new Error(`agy process exited with code ${exitInfo.code}${snippet}`);
          err.errorCode = 'process_exit_error';
          fail(err);
        } else {
          const err = new Error(`agy exited without a terminal result${snippet}`);
          err.errorCode = 'missing_result';
          fail(err);
        }
      }
    };

    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) {
      onAbort();
      return;
    }

    try {
      const payload = JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n';
      runtime.child.stdin.write(payload, 'utf8', (writeErr) => {
        if (writeErr) fail(writeErr);
      });
    } catch (writeErr) {
      fail(writeErr);
    }
  }).finally(() => {
    runtime.activeTurn = null;
  });
}

/**
 * Executes a single streaming `/run-turn` against agy headless `--output-format stream-json`
 * (or reuses a warm `--input-format stream-json` child when `AGY_PROCESS_POOL=1`).
 */
export async function runTurnStream({ body, res, config, sessionStore, processPool, onTools, onMcpConfigured }) {
  const runId = 'agy-' + randomUUID();
  let localPdfReplacements = [];

  const emit = (value) => {
    if (!res.destroyed && !res.writableEnded) {
      res.write(JSON.stringify(value) + '\n');
    }
  };
  const emitEventRaw = (event) => emit({ type: 'event', event });
  const emitFallback = (reason, code = 'agy_error') => {
    const cleanReason = sanitizeLocalPdfText(reason, localPdfReplacements);
    emitEventRaw({ type: 'fallback', reason: cleanReason, code });
    emit({ type: 'outcome', outcome: { kind: 'fallback', runId, reason: cleanReason, code, usedFallback: true } });
  };

  emit({ type: 'start', runId });

  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  let key = '';
  let child = null;
  let usingPooledRuntime = false;
  let acquired = false;
  let success = false;
  let stderr = '';
  let exitInfo = { code: null, signal: null };

  const onResClose = () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  };
  res.once('close', onResClose);

  try {
    const b = record(body);
    if (typeof b.userText !== 'string' || !b.userText.trim()) {
      throw new Error('userText must be nonempty');
    }

    key = sessionStore.sessionKey(b);
    sessionStore.acquire(key);
    acquired = true;

    const metadata = record(b.metadata);
    const hasLocalPdfTurn = collectLocalDocuments(b.runtimeRequest).length > 0;
    const oldId =
      hasLocalPdfTurn || metadata.forceFreshSession === true
        ? ''
        : sessionStore.get(key) || str(b.providerSessionId);

    const cwd = sessionStore.scopedCwd(b);
    await mkdir(cwd, { recursive: true });

    const permFlags = permissionArgs(b, config);
    const effectivePermissionMode = str(metadata.permissionMode || config.defaultPermissionMode || 'default')
      .trim()
      .toLowerCase();
    const allowWriteForTurn = effectivePermissionMode === 'plan' ? false : config.zoteroMcpAllowWrite;

    const built = await buildTurnPrompt(b, { resumed: Boolean(oldId), config, cwd });
    localPdfReplacements = built.localPdfReplacements;

    let mcpSettingsFile = '';
    const mcpServers = record(b.mcpServers);
    const allowedTools = Array.isArray(b.allowedTools)
      ? b.allowedTools
      : Array.isArray(metadata.allowedTools)
        ? metadata.allowedTools
        : [];
    if (Object.keys(mcpServers).length > 0) {
      const preparedMcp = await prepareScopedMcpPlugin({
        cwd,
        mcpServers,
        allowedTools,
        readDirs: built.extraAddDirs,
        allowWrite: allowWriteForTurn
      });
      if (preparedMcp) {
        mcpSettingsFile = preparedMcp.settingsFile || '';
        onMcpConfigured?.(preparedMcp.servers);
      } else {
        emitEventRaw({
          type: 'status',
          text: 'agy bridge v1.0: no supported HTTP MCP server entries found in mcpServers.'
        });
      }
    }
    if (!mcpSettingsFile && built.extraAddDirs.length > 0) {
      const written = await writeScopedAgySettingsFile({
        cwd,
        allowedTools,
        readDirs: built.extraAddDirs,
        allowWrite: allowWriteForTurn
      });
      mcpSettingsFile = written.settingsFile || '';
    }

    if (built.rejectedLocalFiles.length > 0) {
      const summary = built.rejectedLocalFiles
        .map((f) => `${redactSensitive(f.path, [config.token])} (${f.reason})`)
        .join(', ');
      emitEventRaw({
        type: 'status',
        text: `Rejected local attachment paths: ${summary}`
      });
    }

    const timeoutMs = clampTimeout(metadata.timeoutMs ?? b.timeoutMs, config.defaultTurnTimeoutMs);
    const printTimeoutFlag = `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`;

    const rawModel = str(metadata.model || config.defaultModel);
    const rawEffort = str(metadata.effort || config.defaultEffort);
    const { model, effort } = resolveAgyModelAndEffort(rawModel, rawEffort);

    if (controller.signal.aborted) {
      throw new Error('cancelled');
    }

    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const emitSanitizedEvent = buildSanitizedEventEmitter(emitEventRaw, localPdfReplacements);
    const canUsePool = Boolean(
      processPool?.enabled &&
        !hasLocalPdfTurn &&
        metadata.forceFreshSession !== true &&
        effectivePermissionMode !== 'plan'
    );

    let state;
    if (canUsePool) {
      usingPooledRuntime = true;
      const poolSignature = JSON.stringify({
        cwd,
        model,
        effort,
        effectivePermissionMode,
        allowWriteForTurn,
        mcpSettingsFile,
        readDirs: built.extraAddDirs
      });
      let poolEntry = processPool.get(key);
      const isLiveSameSignature = Boolean(
        poolEntry &&
          poolEntry.child &&
          !poolEntry.meta?.closed &&
          poolEntry.child.exitCode === null &&
          poolEntry.child.signalCode === null &&
          poolEntry.meta?.signature === poolSignature
      );
      if (!isLiveSameSignature) {
        if (poolEntry) processPool.invalidate(key);
        const poolArgs = [
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--print=',
          '--print-timeout',
          printTimeoutFlag,
          '--disable-slash-commands'
        ];
        if (oldId) poolArgs.push('--conversation', oldId);
        if (model && model !== 'default') poolArgs.push('--model', model);
        if (effort && effort !== 'default') poolArgs.push('--effort', effort);
        poolArgs.push(...permFlags);
        if (mcpSettingsFile) poolArgs.push('--settings', mcpSettingsFile);
        for (const dir of built.extraAddDirs) poolArgs.push('--add-dir', dir);

        poolEntry = createPooledChildRuntime({
          key,
          poolSignature,
          spawnArgs: poolArgs,
          cwd,
          config,
          processPool,
          sessionId: oldId
        });
      } else {
        processPool.touch(key);
        processPool.setBusy(key, true);
      }

      child = poolEntry.child;
      const pooledResult = await runPooledTurn({
        entry: poolEntry,
        prompt: built.prompt,
        runId,
        model,
        config,
        controller,
        timeoutMs,
        emitSanitizedEvent,
        onTools
      });
      state = pooledResult.state;
      stderr = pooledResult.stderr;
      exitInfo = pooledResult.exitInfo;
      if (pooledResult.latestCumulativeUsage) {
        poolEntry.cumulativeUsage = pooledResult.latestCumulativeUsage;
      }
      if (state.sessionId) {
        poolEntry.sessionId = state.sessionId;
      }
      processPool.setBusy(key, false);
    } else {
      if (processPool?.get(key)) {
        processPool.invalidate(key);
      }

      const args = [
        '-p',
        built.prompt,
        '--output-format',
        'stream-json',
        '--print-timeout',
        printTimeoutFlag,
        '--disable-slash-commands'
      ];
      if (oldId) args.push('--conversation', oldId);
      if (model && model !== 'default') args.push('--model', model);
      if (effort && effort !== 'default') args.push('--effort', effort);
      args.push(...permFlags);
      if (mcpSettingsFile && effectivePermissionMode !== 'plan') {
        args.push('--settings', mcpSettingsFile);
      }
      for (const dir of built.extraAddDirs) {
        args.push('--add-dir', dir);
      }

      for (let attempt = 0; attempt <= config.rateLimitMaxRetries; attempt += 1) {
        stderr = '';
        exitInfo = { code: null, signal: null };
        child = spawn(config.binary, [...config.prefixArgs, ...args], {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });

        let childError = null;
        child.on('error', (e) => {
          childError = e;
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (d) => {
          stderr = (stderr + d).slice(-config.maxStderr);
        });

        const onAbort = () => killProcessTree(child);
        controller.signal.addEventListener('abort', onAbort, { once: true });

        const exitTracker = waitForExitBounded(child, 1500);
        const mapper = createTurnEventMapper({
          runId,
          model,
          onEvent: emitSanitizedEvent,
          onTools,
          maxNdjsonLine: config.maxNdjsonLine,
          extraSecrets: [config.token]
        });

        let mapperError = null;
        const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
        try {
          for await (const line of rl) {
            if (controller.signal.aborted) break;
            try {
              mapper.processLine(line);
            } catch (err) {
              mapperError = err;
              killProcessTree(child);
              break;
            }
          }
        } finally {
          rl.close();
          controller.signal.removeEventListener('abort', onAbort);
        }

        exitInfo = controller.signal.aborted
          ? await exitTracker.awaitBounded()
          : await exitTracker.awaitNormal();

        if (childError) throw childError;
        if (timedOut) {
          const err = new Error(`agy turn timed out after ${timeoutMs}ms`);
          err.errorCode = 'timeout';
          throw err;
        }
        if (controller.signal.aborted) {
          const err = new Error('cancelled');
          err.errorCode = 'cancelled';
          throw err;
        }

        const attemptState = mapper.getState();
        let attemptErr = mapperError;
        if (!attemptErr && !attemptState.resultSeen) {
          const snippet = stderr ? `: ${stderr.slice(-1200)}` : '';
          attemptErr = new Error(`agy exited without a terminal result${snippet}`);
          attemptErr.errorCode = 'missing_result';
        } else if (!attemptErr && exitInfo.code !== 0) {
          attemptErr = new Error(`agy process exited with code ${exitInfo.code}: ${stderr.slice(-1200)}`);
          attemptErr.errorCode = 'process_exit_error';
        } else if (!attemptErr && !attemptState.success) {
          attemptErr = new Error('agy did not complete successfully');
        }

        if (!attemptErr) {
          state = attemptState;
          break;
        }

        const classified = classifyAgyError(attemptErr.message, stderr, exitInfo.code, [config.token]);
        if (
          classified.code === 'rate_limited' &&
          !controller.signal.aborted &&
          attemptState.settledToolCount === 0 &&
          attempt < config.rateLimitMaxRetries
        ) {
          killProcessTree(child);
          child = null;
          emitEventRaw({
            type: 'status',
            text: `Rate limit (429) encountered; retrying turn after backoff (${attempt + 1}/${config.rateLimitMaxRetries})...`
          });
          await new Promise((resolveDelay) => {
            const delayMs = config.rateLimitRetryDelayMs * (attempt + 1);
            const t = setTimeout(() => {
              controller.signal.removeEventListener('abort', onBackoffAbort);
              resolveDelay();
            }, delayMs);
            const onBackoffAbort = () => {
              clearTimeout(t);
              resolveDelay();
            };
            controller.signal.addEventListener('abort', onBackoffAbort, { once: true });
          });
          if (timedOut) {
            const err = new Error(`agy turn timed out after ${timeoutMs}ms`);
            err.errorCode = 'timeout';
            throw err;
          }
          if (controller.signal.aborted) {
            const err = new Error('cancelled');
            err.errorCode = 'cancelled';
            throw err;
          }
          continue;
        }

        throw attemptErr;
      }
    }

    success = true;
    if (!hasLocalPdfTurn && state.sessionId) {
      sessionStore.set(key, state.sessionId);
      await sessionStore.save();
    }

    if (/permission|denied|not approved|blocked/i.test(stderr)) {
      emitEventRaw({
        type: 'status',
        text: sanitizeLocalPdfText(
          'agy permission notice: ' + redactSensitive(stderr.slice(-1000), [config.token]),
          localPdfReplacements
        )
      });
    }

    emit({
      type: 'outcome',
      outcome: {
        kind: 'completed',
        runId,
        text: sanitizeLocalPdfText(state.output, localPdfReplacements),
        usedFallback: false
      }
    });
  } catch (e) {
    if (usingPooledRuntime && key) {
      processPool.invalidate(key);
    }
    if (timedOut) {
      if (!res.destroyed) emitFallback('agy turn timed out', 'timeout');
    } else if (controller.signal.aborted) {
      if (!res.destroyed) emitFallback('cancelled', 'cancelled');
    } else {
      const classified = classifyAgyError(e?.message || e, stderr, exitInfo.code, [config.token]);
      const code = e?.errorCode || classified.code;
      if (!res.destroyed) emitFallback(classified.reason, code);
    }
  } finally {
    clearTimeout(timer);
    if (child && !success) {
      if (usingPooledRuntime && key) {
        processPool.invalidate(key);
      } else {
        killProcessTree(child);
      }
    }
    if (acquired) {
      sessionStore.release(key);
    }
    res.off('close', onResClose);
    if (!res.writableEnded) {
      res.end();
    }
  }
}

function buildStructuredPrompt(body) {
  const b = record(body);
  const system = str(b.systemPrompt || b.system || b.instruction).trim();

  let mainPrompt = str(b.prompt || b.userPrompt || b.userText).trim();
  if (!mainPrompt && Array.isArray(b.messages)) {
    const parts = [];
    for (const msg of b.messages) {
      const m = record(msg);
      const role = str(m.role || 'user').toUpperCase();
      const content =
        typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((c) => str(record(c).text || c)).join('\n')
            : JSON.stringify(m.content ?? '');
      if (content.trim()) {
        parts.push(`${role}: ${content.trim()}`);
      }
    }
    mainPrompt = parts.join('\n\n').trim();
  }

  if (!mainPrompt) {
    throw new BridgeHttpError(400, 'invalid_request', 'prompt or messages must be nonempty');
  }

  return system ? `${system}\n\n---\n\n${mainPrompt}` : mainPrompt;
}

function extractSchema(body, config) {
  const b = record(body);
  const raw =
    b.schema ??
    b.jsonSchema ??
    b.outputSchema ??
    record(record(b.responseFormat).json_schema).schema ??
    record(record(b.response_format).json_schema).schema;

  if (raw === undefined || raw === null) return null;

  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new BridgeHttpError(400, 'invalid_schema', 'schema must be valid JSON');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new BridgeHttpError(400, 'invalid_schema', 'schema must be a JSON object');
  }

  const serialized = JSON.stringify(obj);
  if (serialized.length > config.maxBody) {
    throw new BridgeHttpError(400, 'invalid_schema', 'schema exceeds maximum size');
  }
  return { obj, serialized };
}

/**
 * Executes a stateless, non-conversational completion for `POST /structured-completion`.
 * Supports optional `--json-schema` enforcement and strictly isolates from session storage.
 */
export async function runStructuredCompletion({ body, res, config }) {
  const b = record(body);
  const prompt = buildStructuredPrompt(b);
  if (prompt.length > config.maxPrompt) {
    throw new BridgeHttpError(400, 'prompt_too_large', 'prompt exceeds maximum length');
  }

  const schema = extractSchema(b, config);
  const timeoutMs = clampTimeout(b.timeoutMs ?? record(b.metadata).timeoutMs, config.defaultStructuredTimeoutMs);
  const rawModel = str(b.model || record(b.metadata).model || config.defaultModel);
  const rawEffort = str(b.effort || record(b.metadata).effort || config.defaultEffort);
  const { model, effort } = resolveAgyModelAndEffort(rawModel, rawEffort);
  const perm = permissionArgs(
    { metadata: { permissionMode: str(b.permissionMode || record(b.metadata).permissionMode || 'default') } },
    config
  );

  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--print-timeout',
    `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`,
    '--disable-slash-commands'
  ];
  if (model && model !== 'default') args.push('--model', model);
  if (effort && effort !== 'default') args.push('--effort', effort);
  if (schema) args.push('--json-schema', schema.serialized);
  args.push(...perm);

  const controller = new AbortController();
  let timedOut = false;
  const onClose = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.once('close', onClose);

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let child = null;
  let stderr = '';
  let exitInfo = { code: null, signal: null };
  let success = false;

  try {
    await mkdir(config.root, { recursive: true });
    if (controller.signal.aborted) {
      throw new BridgeHttpError(499, 'cancelled', 'cancelled');
    }

    child = spawn(config.binary, [...config.prefixArgs, ...args], {
      cwd: config.root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    let childError = null;
    child.on('error', (e) => {
      childError = e;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-config.maxStderr);
    });

    const onAbort = () => killProcessTree(child);
    controller.signal.addEventListener('abort', onAbort, { once: true });

    const exitTracker = waitForExitBounded(child, 1500);
    const mapper = createTurnEventMapper({
      runId: 'agy-struct-' + randomUUID(),
      model,
      onEvent: () => {},
      maxNdjsonLine: config.maxNdjsonLine,
      extraSecrets: [config.token]
    });

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (controller.signal.aborted) break;
        mapper.processLine(line);
      }
    } finally {
      rl.close();
      controller.signal.removeEventListener('abort', onAbort);
    }

    exitInfo = controller.signal.aborted
      ? await exitTracker.awaitBounded()
      : await exitTracker.awaitNormal();

    if (childError) {
      throw new BridgeHttpError(502, 'cli_spawn_error', redactSensitive(childError.message, [config.token]));
    }
    if (timedOut) {
      throw new BridgeHttpError(504, 'timeout', `structured completion timed out after ${timeoutMs}ms`);
    }
    if (controller.signal.aborted) {
      throw new BridgeHttpError(499, 'cancelled', 'cancelled');
    }

    const state = mapper.getState();
    if (!state.resultSeen) {
      throw new BridgeHttpError(
        502,
        'missing_result',
        redactSensitive(`agy exited without a terminal result${stderr ? ': ' + stderr.slice(-800) : ''}`, [config.token])
      );
    }
    if (exitInfo.code !== 0 || !state.success) {
      const classified = classifyAgyError(`agy exited with code ${exitInfo.code}`, stderr, exitInfo.code, [config.token]);
      throw new BridgeHttpError(502, classified.code, classified.reason);
    }

    success = true;
    const rawText = state.output;
    if (schema) {
      const cleaned = stripJsonCodeFence(rawText);
      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        throw new BridgeHttpError(
          502,
          'structured_completion_invalid_json',
          'agy returned output that could not be parsed as valid JSON for requested schema'
        );
      }
      return {
        ok: true,
        text: cleaned,
        data: parsed,
        parsed,
        ...(state.usage ? { usage: state.usage } : {}),
        ...(model ? { model } : {}),
        provider: 'agy'
      };
    }

    return {
      ok: true,
      text: rawText,
      ...(state.usage ? { usage: state.usage } : {}),
      ...(model ? { model } : {}),
      provider: 'agy'
    };
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
    if (child && !success) {
      killProcessTree(child);
    }
  }
}
