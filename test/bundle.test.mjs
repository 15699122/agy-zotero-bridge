import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as bundle from '../dist/agy-zotero-bridge.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = resolve(__dirname, '../dist/agy-zotero-bridge.mjs');
const mockAgy = resolve(__dirname, './mock-agy.mjs');

test('single-file bundle exports matches source interface', () => {
  assert.equal(bundle.BRIDGE_VERSION, 'agy-v1.0.0');
  assert.equal(typeof bundle.createConfig, 'function');
  assert.equal(typeof bundle.startBridgeServer, 'function');
  assert.equal(typeof bundle.runClaudeCodeAgyShim, 'function');
  assert.equal(typeof bundle.parseClaudeShimArgs, 'function');
  assert.equal(typeof bundle.CliProbe, 'function');
  assert.equal(typeof bundle.SessionStore, 'function');
  assert.equal(typeof bundle.SessionProcessPool, 'function');
  assert.equal(typeof bundle.createBridgeApp, 'function');
});

test('single-file bundle executes as CLI shim (--version & --help)', async () => {
  const versionProc = spawn(process.execPath, [BUNDLE_PATH, '--version']);
  let vOut = '';
  versionProc.stdout.on('data', (d) => { vOut += d; });
  const [vCode] = await Promise.all([
    new Promise((r) => versionProc.on('close', r))
  ]);
  assert.equal(vCode, 0);
  assert.match(vOut, /Claude Code \/ agy-zotero-bridge agy-v1\.0\.0/);

  const helpProc = spawn(process.execPath, [BUNDLE_PATH, '--help']);
  let hOut = '';
  helpProc.stdout.on('data', (d) => { hOut += d; });
  const [hCode] = await Promise.all([
    new Promise((r) => helpProc.on('close', r))
  ]);
  assert.equal(hCode, 0);
  assert.match(hOut, /Drop-in executable for llm-for-zotero/);
});

test('single-file bundle responds to stream-json initialize and set_model cleanly', async () => {
  const tmpDir = await mkdtemp(join(tmpdir(), 'agy-bundle-test-'));
  try {
    const child = spawn(
      process.execPath,
      [BUNDLE_PATH, '--output-format', 'stream-json', '--input-format', 'stream-json'],
      {
        cwd: tmpDir,
        env: {
          ...process.env,
          AGY_BIN: process.execPath,
          AGY_PREFIX_ARGS_JSON: JSON.stringify([mockAgy])
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    const lines = [];
    const waiters = [];
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      try {
        const parsed = JSON.parse(line);
        lines.push(parsed);
        while (waiters.length > 0 && waiters[0].pred(parsed)) {
          waiters.shift().resolve(parsed);
        }
      } catch {}
    });

    const waitForFrame = (pred, label) => {
      const existing = lines.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`Timeout waiting for frame: ${label}`)), 4000);
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(timer);
            res(f);
          }
        });
      });
    };

    child.stdin.write(JSON.stringify({
      type: 'control_request',
      request_id: 'req-init',
      request: { subtype: 'initialize', hooks: null }
    }) + '\n');

    const initResp = await waitForFrame(
      (l) => l.type === 'control_response' && l.response?.subtype === 'success' && l.response?.request_id === 'req-init',
      'initialize control response'
    );
    assert.equal(initResp.response.subtype, 'success');
    assert.ok(Array.isArray(initResp.response.response.models));

    child.stdin.write(JSON.stringify({
      type: 'control_request',
      request_id: 'req-model',
      request: { subtype: 'set_model', model: 'gemini-4-hydrogen' }
    }) + '\n');

    const modelResp = await waitForFrame(
      (l) => l.type === 'control_response' && l.response?.subtype === 'success' && l.response?.request_id === 'req-model',
      'set_model control response'
    );
    assert.equal(modelResp.response.subtype, 'success');

    child.stdin.end();
    await new Promise((r) => child.on('close', r));
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
