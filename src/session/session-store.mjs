import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { isPathWithin, redactSensitive } from '../security/redact.mjs';

const str = (v) => (typeof v === 'string' ? v : '');
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const cleanSegment = (v) => str(v).replace(/[^\p{L}\p{N}_.@-]/gu, '_').slice(0, 100) || 'unknown';

async function atomicRenameWithRetry(tempPath, targetPath, retries = 3) {
  let lastError;
  for (let i = 0; i <= retries; i++) {
    try {
      await rename(tempPath, targetPath);
      return;
    } catch (e) {
      lastError = e;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(e?.code) || i === retries) throw e;
      await new Promise((r) => setTimeout(r, 20 * (i + 1)));
    }
  }
  throw lastError;
}

/**
 * Scoped session persistence and active-turn locking for agy conversations.
 */
export class SessionStore {
  constructor({ root, stateFile }) {
    this.root = resolve(root);
    this.stateFile = resolve(stateFile);
    this.sessions = new Map();
    this.active = new Set();
    this.stateWrite = Promise.resolve();
    this.lastSaveError = null;
  }

  sessionKey(body) {
    const b = record(body);
    const base = String(b.conversationKey ?? '').trim();
    if (!base) throw new Error('conversationKey is required');
    const type = str(b.scopeType).trim();
    const id = str(b.scopeId).trim();
    return type && id ? `${base}::${type}:${id}` : base;
  }

  scopedCwd(body) {
    const b = record(body);
    const scopeType = str(b.scopeType).trim();
    const scopeId = str(b.scopeId).trim();
    if (!scopeType || !scopeId) return this.root;

    const profile = /^(profile-[\w-]+)/.exec(scopeId)?.[1];
    const target = resolve(
      this.root,
      ...(profile ? [cleanSegment(profile)] : []),
      'scopes',
      cleanSegment(scopeType),
      cleanSegment(scopeId),
      'conversations',
      cleanSegment(str(b.conversationKey))
    );

    if (!isPathWithin(target, this.root)) {
      throw new Error('scoped cwd escaped workspace root');
    }
    return target;
  }

  async load() {
    try {
      const raw = await readFile(this.stateFile, 'utf8');
      const data = JSON.parse(raw);
      for (const [k, v] of Object.entries(record(data))) {
        if (typeof v === 'string' && v.trim()) {
          this.sessions.set(k, v.trim());
        }
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') {
        console.error('[agy-bridge] invalid state:', redactSensitive(e?.message || e));
      }
    }
  }

  save() {
    this.stateWrite = this.stateWrite
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.stateFile), { recursive: true });
        const temp = `${this.stateFile}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(Object.fromEntries(this.sessions), null, 2), 'utf8');
        await atomicRenameWithRetry(temp, this.stateFile);
        this.lastSaveError = null;
      })
      .catch((e) => {
        this.lastSaveError = redactSensitive(e?.message || e);
        console.error('[agy-bridge] failed to persist session map:', this.lastSaveError);
      });
    return this.stateWrite;
  }

  get(key) {
    return this.sessions.get(key);
  }

  set(key, providerSessionId) {
    this.sessions.set(key, providerSessionId);
  }

  delete(key) {
    return this.sessions.delete(key);
  }

  isActive(key) {
    return this.active.has(key);
  }

  acquire(key) {
    if (this.active.has(key)) {
      throw new Error('Another turn is already running for this scoped conversation');
    }
    this.active.add(key);
  }

  release(key) {
    this.active.delete(key);
  }
}
