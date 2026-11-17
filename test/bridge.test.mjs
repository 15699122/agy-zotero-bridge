import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const folder = fileURLToPath(new URL('.', import.meta.url));
const bridge = fileURLToPath(new URL('../bridge.mjs', import.meta.url));
const claudeShim = fileURLToPath(new URL('../claude-code-agy.mjs', import.meta.url));
const binary = process.execPath;
const prefix = JSON.stringify([join(folder, 'mock-agy.mjs')]);
const port = 12350 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
let child, dir;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agy-zotero-test-'));
  child = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      AGY_BIN: binary,
      AGY_PREFIX_ARGS_JSON: prefix,
      AGY_CWD: dir,
      AGY_BRIDGE_STATE: join(dir, 'sessions.json'),
      AGY_BRIDGE_PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(base + '/healthz');
      if (r.ok) return;
    } catch {
      // Wait for server startup.
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('bridge server failed to start');
});

after(async () => {
  child?.kill();
  await rm(dir, { recursive: true, force: true });
});

async function post(path, data, baseUrl = base) {
  return fetch(baseUrl + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data)
  });
}

async function turn(userText, conversationKey = 'test', metadata = {}, scopeType = 'paper', scopeId = 'A12') {
  const r = await post('/run-turn', { conversationKey, userText, metadata, scopeType, scopeId });
  assert.equal(r.status, 200);
  return (await r.text()).trim().split('\n').map(JSON.parse);
}

// --- Original 10 baseline regression tests ---

test('health and model discovery match plugin contract', async () => {
  const h = await (await fetch(base + '/healthz')).json();
  assert.equal(h.protocolVersion, 2);
  assert.ok(h.capabilities.includes('model_catalog_v1'));
  const m = await (await fetch(base + '/models')).json();
  assert.deepEqual(m.models, ['gemini-mock']);
  assert.equal(m.modelInfos[0].displayName, 'Gemini Mock');
});

test('streams deltas, tool lifecycle, usage, final, outcome without duplicates', async () => {
  const frames = await turn('MOCK_TOOL');
  assert.equal(frames[0].type, 'start');
  const e = frames.filter((f) => f.type === 'event').map((f) => f.event);
  assert.equal(e.filter((v) => v.type === 'message_delta').map((v) => v.text).join(''), 'Hello');
  const calls = e.filter((v) => v.type === 'tool_call');
  const results = e.filter((v) => v.type === 'tool_result');
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal(calls[0].callId, results[0].callId);
  assert.equal(e.find((v) => v.type === 'usage').inputTokens, 10);
  assert.equal(e.find((v) => v.type === 'final').text, 'Hello');
  assert.equal(frames.at(-1).outcome.kind, 'completed');
});

test('stores conversation id by scoped key for resume', async () => {
  const s = await (await fetch(base + '/session-info?conversationKey=test&scopeType=paper&scopeId=A12')).json();
  assert.equal(s.session.providerSessionId, 'abc-test-session');
  assert.equal((await turn('again')).at(-1).outcome.kind, 'completed');
});

test('tool errors use matching callId; failed agy result is fallback', async () => {
  const tool = await turn('MOCK_TOOL_ERROR', 'toolError');
  const es = tool.filter((f) => f.type === 'event').map((f) => f.event);
  assert.equal(es.find((x) => x.type === 'tool_call').callId, es.find((x) => x.type === 'tool_error').callId);
  const bad = await turn('MOCK_FAIL', 'bad');
  assert.equal(bad.at(-1).outcome.kind, 'fallback');
  assert.match(bad.at(-1).outcome.reason, /failure from agy/);
});

test('missing result never reports success', async () => {
  const f = await turn('MOCK_NO_RESULT', 'no-result');
  assert.equal(f.at(-1).outcome.kind, 'fallback');
});

test('permission notice surfaces as status', async () => {
  const f = await turn('MOCK_SOFT_DENY', 'soft-deny');
  assert.ok(f.some((x) => x.event?.type === 'status' && x.event.text.includes('permission')));
});

test('yolo is rejected unless explicitly enabled', async () => {
  const f = await turn('hello', 'unsafe', { permissionMode: 'yolo' });
  assert.equal(f.at(-1).outcome.kind, 'fallback');
  assert.match(f.at(-1).outcome.reason, /disabled/);
});

test('unsupported interactive endpoints report 501', async () => {
  const r = await post('/resolve-confirmation', { requestId: 'x', approved: true });
  assert.equal(r.status, 501);
});

test('safe mode allows a later request after yolo refusal for same session', async () => {
  const f = await turn('MOCK_TOOL', 'unsafe');
  assert.equal(f.at(-1).outcome.kind, 'completed');
});

test('client disconnect cancels process and releases scoped conversation', async () => {
  const controller = new AbortController();
  const response = await fetch(base + '/run-turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({ conversationKey: 'cancel-case', userText: 'MOCK_CANCEL', scopeType: 'paper', scopeId: 'A12' })
  });
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  controller.abort();
  await new Promise((r) => setTimeout(r, 250));
  const follow = await turn('normal', 'cancel-case');
  assert.equal(follow.at(-1).outcome.kind, 'completed');
});

// --- New v0.2.0 integration tests ---

test('healthz separates installation and authentication status cleanly', async () => {
  const h = await (await fetch(base + '/healthz')).json();
  assert.equal(h.bridgeAlive, true);
  assert.equal(h.agyInstalled, true);
  assert.equal(h.agyAvailable, true);
  assert.equal(h.agyAuthenticated, null);
  assert.equal(h.authStatus, 'unverified');
  assert.ok(h.capabilities.includes('structured_completion_v1'));
});

test('efforts and tools endpoints reflect conservative defaults and accurate tool mutability', async () => {
  const eUnknown = await (await fetch(base + '/efforts?model=unknown-model')).json();
  assert.deepEqual(eUnknown.efforts, ['default']);

  const toolsPayload = await (await fetch(base + '/tools')).json();
  const readTool = toolsPayload.tools.find((t) => t.name === 'read_file');
  const cmdTool = toolsPayload.tools.find((t) => t.name === 'run_command');
  assert.equal(readTool.mutability, 'read');
  assert.equal(readTool.requiresConfirmation, false);
  assert.equal(cmdTool.mutability, 'write');
  assert.equal(cmdTool.requiresConfirmation, true);
});

test('structured-completion supports text, JSON schema, fenced JSON, invalid JSON rejection, and stays stateless', async () => {
  const beforeSessions = await readFile(join(dir, 'sessions.json'), 'utf8');

  const plainRes = await post('/structured-completion', { prompt: 'Summarize briefly' });
  assert.equal(plainRes.status, 200);
  const plain = await plainRes.json();
  assert.equal(plain.ok, true);
  assert.equal(plain.text, 'Hello');
  assert.equal(plain.usage.inputTokens, 10);

  const schemaRes = await post('/structured-completion', {
    prompt: 'Extract metadata',
    schema: { type: 'object', properties: { title: { type: 'string' } } }
  });
  assert.equal(schemaRes.status, 200);
  const schemaData = await schemaRes.json();
  assert.deepEqual(schemaData.data, { title: 'Paper A', tags: ['ml', 'zotero'] });

  const fencedRes = await post('/structured-completion', {
    prompt: 'MOCK_FENCED_JSON',
    schema: { type: 'object' }
  });
  assert.equal(fencedRes.status, 200);
  const fencedData = await fencedRes.json();
  assert.deepEqual(fencedData.data, { title: 'Paper B', year: 2026 });

  const badJsonRes = await post('/structured-completion', {
    prompt: 'MOCK_STRUCTURED_INVALID_JSON',
    schema: { type: 'object' }
  });
  assert.equal(badJsonRes.status, 502);

  const badReqRes = await post('/structured-completion', { prompt: '' });
  assert.equal(badReqRes.status, 400);

  const afterSessions = await readFile(join(dir, 'sessions.json'), 'utf8');
  assert.equal(afterSessions, beforeSessions);
});

test('structured-completion enforces timeoutMs cleanly', async () => {
  const res = await post('/structured-completion', {
    prompt: 'MOCK_CANCEL',
    timeoutMs: 1000
  });
  assert.equal(res.status, 504);
  const data = await res.json();
  assert.equal(data.error, 'timeout');
});

test('run-turn handles DONE-only, tool-only-DONE, duplicate DONE, and unknown/invalid lines cleanly', async () => {
  const doneFrames = await turn('MOCK_DONE_ONLY', 'done-only');
  const doneEvents = doneFrames.filter((f) => f.type === 'event').map((f) => f.event);
  assert.equal(doneEvents.filter((e) => e.type === 'message_delta').map((e) => e.text).join(''), 'Done only reply');
  assert.equal(doneEvents.filter((e) => e.type === 'final').length, 1);
  assert.equal(doneFrames.at(-1).outcome.kind, 'completed');

  const toolOnlyFrames = await turn('MOCK_TOOL_ONLY_DONE', 'tool-only-done');
  const toolOnlyEvents = toolOnlyFrames.filter((f) => f.type === 'event').map((f) => f.event);
  assert.equal(toolOnlyEvents.filter((e) => e.type === 'tool_call').length, 1);
  assert.equal(toolOnlyEvents.filter((e) => e.type === 'tool_result').length, 1);
  assert.equal(
    toolOnlyEvents.find((e) => e.type === 'tool_call').callId,
    toolOnlyEvents.find((e) => e.type === 'tool_result').callId
  );

  const dupFrames = await turn('MOCK_TOOL_DUP_DONE', 'tool-dup-done');
  const dupEvents = dupFrames.filter((f) => f.type === 'event').map((f) => f.event);
  assert.equal(dupEvents.filter((e) => e.type === 'tool_result').length, 1);

  const unknownFrames = await turn('MOCK_UNKNOWN_EVENTS', 'unknown-ev');
  assert.equal(unknownFrames.at(-1).outcome.kind, 'completed');
  assert.equal(unknownFrames.at(-1).outcome.text, 'Tolerated');
});

test('run-turn classifies 429, auth failure, unknown model, non-zero exit after result, and scrubs secrets', async () => {
  const f429 = await turn('MOCK_429', 'err-429');
  assert.equal(f429.at(-1).outcome.kind, 'fallback');
  assert.equal(f429.at(-1).outcome.code, 'rate_limited');

  const fAuth = await turn('MOCK_AUTH_FAIL', 'err-auth');
  assert.equal(fAuth.at(-1).outcome.code, 'auth_failed');

  const fModel = await turn('MOCK_UNKNOWN_MODEL', 'err-model');
  assert.equal(fModel.at(-1).outcome.code, 'model_not_supported');

  const fExit = await turn('MOCK_NONZERO_EXIT', 'err-exit');
  assert.equal(fExit.at(-1).outcome.kind, 'fallback');
  assert.equal(fExit.at(-1).outcome.code, 'process_exit_error');

  const fSecret = await turn('MOCK_SECRET_STDERR', 'err-secret');
  const reason = fSecret.at(-1).outcome.reason;
  assert.equal(fSecret.at(-1).outcome.kind, 'fallback');
  assert.ok(!reason.includes('secret-token-12345'));
  assert.ok(!reason.includes('AIzaSyFakeKey1234567890'));
  assert.ok(!reason.includes('Alice'));
  assert.ok(!reason.includes('oauth_creds.json'));
});

test('concurrent turn on same scope is rejected while different scopes run concurrently', async () => {
  const slowController = new AbortController();
  const slowReq = fetch(base + '/run-turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: slowController.signal,
    body: JSON.stringify({ conversationKey: 'shared-conv', userText: 'MOCK_CANCEL', scopeType: 'paper', scopeId: 'P1' })
  });

  await new Promise((r) => setTimeout(r, 120));

  const sameScope = await turn('hello', 'shared-conv', {}, 'paper', 'P1');
  assert.equal(sameScope.at(-1).outcome.kind, 'fallback');
  assert.match(sameScope.at(-1).outcome.reason, /already running/);

  const otherScope = await turn('hello', 'shared-conv', {}, 'paper', 'P2');
  assert.equal(otherScope.at(-1).outcome.kind, 'completed');

  slowController.abort();
  await slowReq.catch(() => {});
  await new Promise((r) => setTimeout(r, 200));
});

test('token auth prefix, model banner stripping, and Zotero MCP probe work end-to-end', async () => {
  // Spin up a mock Zotero JSON-RPC 2.0 MCP endpoint
  const mcpServer = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const rpc = JSON.parse(raw);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (rpc.method === 'initialize') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2024-11-05' } }));
      return;
    }
    if (rpc.method === 'tools/list') {
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            tools: [
              { name: 'search_items', description: 'Search Zotero library', annotations: { readOnlyHint: true } },
              { name: 'create_note', description: 'Create Zotero note', annotations: { destructiveHint: false } }
            ]
          }
        })
      );
      return;
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'not found' } }));
  });

  await new Promise((r) => mcpServer.listen(0, '127.0.0.1', r));
  const mcpPort = mcpServer.address().port;

  const secPort = 14450 + Math.floor(Math.random() * 1500);
  const secDir = await mkdtemp(join(tmpdir(), 'agy-sec-test-'));
  const secChild = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      AGY_BIN: binary,
      AGY_PREFIX_ARGS_JSON: prefix,
      AGY_CWD: secDir,
      AGY_BRIDGE_STATE: join(secDir, 'sessions.json'),
      AGY_BRIDGE_PORT: String(secPort),
      AGY_BRIDGE_TOKEN: 'test-token-xyz',
      MOCK_MODELS_WITH_BANNER: '1',
      ZOTERO_MCP_URL: `http://127.0.0.1:${mcpPort}/llm-for-zotero/mcp`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    const secBase = `http://127.0.0.1:${secPort}`;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(secBase + '/test-token-xyz/healthz');
        if (r.ok) break;
      } catch {
        // wait
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const unauth = await fetch(secBase + '/healthz');
    assert.equal(unauth.status, 401);

    const modelsRes = await (await fetch(secBase + '/test-token-xyz/models')).json();
    assert.deepEqual(modelsRes.models, ['gemini-mock']);

    const mcpRes = await (await fetch(secBase + '/test-token-xyz/mcp-servers?probe=1')).json();
    assert.equal(mcpRes.servers[0].connected, true);
    assert.equal(mcpRes.servers[0].toolCount, 2);

    const toolsRes = await (await fetch(secBase + '/test-token-xyz/tools')).json();
    const searchTool = toolsRes.tools.find((t) => t.name === 'search_items');
    const noteTool = toolsRes.tools.find((t) => t.name === 'create_note');
    assert.equal(searchTool.source, 'mcp');
    assert.equal(searchTool.mutability, 'read');
    assert.equal(noteTool.mutability, 'write');
    assert.equal(noteTool.requiresConfirmation, true);
  } finally {
    secChild.kill();
    mcpServer.close();
    await rm(secDir, { recursive: true, force: true });
  }
});

test('healthz advertises local_pdf_paths and run-turn validates and redacts localDocuments paths', async () => {
  const h = await (await fetch(base + '/healthz')).json();
  assert.ok(h.capabilities.includes('local_pdf_paths'));

  const validPdf = join(dir, 'zotero-doc.pdf');
  await writeFile(validPdf, '%PDF-1.7\n%test');

  const r = await post('/run-turn', {
    conversationKey: 'local-pdf-turn',
    scopeType: 'paper',
    scopeId: 'PDF1',
    userText: 'MOCK_ECHO_RAW_PDF',
    runtimeRequest: {
      localDocuments: [
        {
          kind: 'local_pdf',
          sourceKey: 'zotero-pdf:101:202',
          itemId: 101,
          contextItemId: 202,
          title: 'Test Paper',
          name: 'zotero-doc.pdf',
          mimeType: 'application/pdf',
          absolutePath: validPdf
        }
      ]
    }
  });
  assert.equal(r.status, 200);
  const frames = (await r.text()).trim().split('\n').map(JSON.parse);
  const deltaText = frames
    .filter((f) => f.event?.type === 'message_delta')
    .map((f) => f.event.text)
    .join('');
  const finalEvent = frames.find((f) => f.event?.type === 'final')?.event;
  assert.ok(!deltaText.includes(validPdf));
  assert.ok(deltaText.includes('[local-pdf-path:zotero-pdf:101:202]'));
  assert.ok(!finalEvent.text.includes(validPdf));
  assert.ok(finalEvent.text.includes('[local-pdf-path:zotero-pdf:101:202]'));
  assert.ok(!frames.at(-1).outcome.text.includes(validPdf));

  // Verify non-PDF file fails safely with fallback
  const badPdf = join(dir, 'not-pdf.pdf');
  await writeFile(badPdf, 'PLAIN_TEXT');
  const badRes = await post('/run-turn', {
    conversationKey: 'local-pdf-bad',
    scopeType: 'paper',
    scopeId: 'PDF2',
    userText: 'MOCK_ECHO_RAW_PDF',
    runtimeRequest: {
      localDocuments: [
        {
          kind: 'local_pdf',
          sourceKey: 'zotero-pdf:101:203',
          itemId: 101,
          contextItemId: 203,
          title: 'Bad Paper',
          name: 'not-pdf.pdf',
          mimeType: 'application/pdf',
          absolutePath: badPdf
        }
      ]
    }
  });
  const badFrames = (await badRes.text()).trim().split('\n').map(JSON.parse);
  assert.equal(badFrames.at(-1).outcome.kind, 'fallback');
  assert.match(badFrames.at(-1).outcome.reason, /zotero-pdf:101:203/);
});

test('mcp-servers handles 401 before turn and captures Bearer token + tools during Zotero run-turn', async () => {
  const expectedToken = 'zotero-bearer-secret-999';
  let rejectExpiredScopeHeader = false;
  const authMcp = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    let raw = '';
    for await (const c of req) raw += c;
    const rpc = JSON.parse(raw);
    if (rejectExpiredScopeHeader && req.headers['x-llm-for-zotero-scope']) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id ?? null,
          error: {
            code: -32603,
            message:
              'Internal error: Zotero MCP scope token is invalid or expired. Start a new Codex turn from Zotero so tools bind to the current profile and library.'
          }
        })
      );
      return;
    }
    if (rpc.method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (rpc.method === 'initialize') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18' } }));
      return;
    }
    if (rpc.method === 'tools/list') {
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpc.id,
          result: {
            tools: [
              { name: 'library_search', description: 'Search Zotero library' },
              { name: 'note_write', description: 'Write Zotero note' }
            ]
          }
        })
      );
      return;
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'not found' } }));
  });

  await new Promise((r) => authMcp.listen(0, '127.0.0.1', r));
  const mcpPort = authMcp.address().port;

  const p2 = 16100 + Math.floor(Math.random() * 1500);
  const d2 = await mkdtemp(join(tmpdir(), 'agy-mcp-auth-'));
  const c2 = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      AGY_BIN: binary,
      AGY_PREFIX_ARGS_JSON: prefix,
      AGY_CWD: d2,
      AGY_BRIDGE_STATE: join(d2, 'sessions.json'),
      AGY_BRIDGE_PORT: String(p2),
      ZOTERO_MCP_URL: `http://127.0.0.1:${mcpPort}/llm-for-zotero/mcp`
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    const b2 = `http://127.0.0.1:${p2}`;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(b2 + '/healthz');
        if (r.ok) break;
      } catch {
        // wait
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const beforeTurn = await (await fetch(b2 + '/mcp-servers?probe=1')).json();
    assert.equal(beforeTurn.servers[0].connected, false);
    assert.equal(beforeTurn.servers[0].status, 'unauthorized_needs_zotero_turn_or_token');

    const extraNoteFolder = join(d2, 'zotero-notes');
    await writeFile(join(d2, 'marker.txt'), 'ok');
    const { mkdir: mkdirFs } = await import('node:fs/promises');
    await mkdirFs(extraNoteFolder, { recursive: true });

    const turnRes = await post(
      '/run-turn',
      {
        conversationKey: 'mcp-capture-conv',
        scopeType: 'open',
        scopeId: 'lib-1',
        metadata: {
          customInstruction: `Notes folder: ${extraNoteFolder}`
        },
        userText: 'MOCK_ECHO_SETTINGS',
        allowedTools: ['mcp__llm_for_zotero__library_search', 'mcp__llm_for_zotero__note_write'],
        mcpServers: {
          llm_for_zotero: {
            type: 'http',
            url: `http://127.0.0.1:${mcpPort}/llm-for-zotero/mcp`,
            headers: {
              Authorization: `Bearer ${expectedToken}`,
              'X-LLM-For-Zotero-Scope': 'scope-token-abc'
            }
          }
        }
      },
      b2
    );
    assert.equal(turnRes.status, 200);
    const turnFrames = (await turnRes.text()).trim().split('\n').map(JSON.parse);
    const spawnedSettings = JSON.parse(turnFrames.at(-1).outcome.text);
    assert.equal(spawnedSettings.hasSettingsFlag, true);
    assert.ok(spawnedSettings.settingsPath.endsWith('session-settings.json'));
    const writtenSettings = JSON.parse(await readFile(spawnedSettings.settingsPath, 'utf8'));
    assert.ok(writtenSettings.permissions.allow.includes('mcp(llm_for_zotero/library_search)'));
    assert.ok(writtenSettings.permissions.allow.includes('mcp(llm-for-zotero_llm_for_zotero/library_search)'));
    assert.ok(writtenSettings.permissions.allow.includes(`read_file(${extraNoteFolder})`));
    assert.ok(writtenSettings.permissions.allow.includes('mcp(llm_for_zotero/note_write)'));
    assert.equal(writtenSettings.permissions.deny, undefined);

    const noMcpReadDirRes = await post(
      '/run-turn',
      {
        conversationKey: 'read-dir-no-mcp',
        scopeType: 'paper',
        scopeId: 'R1',
        userText: 'MOCK_ECHO_SETTINGS'
      },
      b2
    );
    const noMcpFrames = (await noMcpReadDirRes.text()).trim().split('\n').map(JSON.parse);
    const noMcpSpawned = JSON.parse(noMcpFrames.at(-1).outcome.text);
    assert.equal(noMcpSpawned.hasSettingsFlag, true);
    const noMcpSettings = JSON.parse(await readFile(noMcpSpawned.settingsPath, 'utf8'));
    assert.ok(noMcpSettings.permissions.allow.includes(`read_file(${d2})`));

    // Simulate Zotero clearing X-LLM-For-Zotero-Scope immediately after the turn ends.
    rejectExpiredScopeHeader = true;

    const afterTurnText = await (await fetch(b2 + '/mcp-servers?probe=1')).text();
    assert.ok(!afterTurnText.includes(expectedToken));
    const afterTurn = JSON.parse(afterTurnText);
    assert.equal(afterTurn.servers[0].connected, true);
    assert.equal(afterTurn.servers[0].toolCount, 2);
    assert.equal(afterTurn.servers[0].writeEnabled, true);

    const toolsAfter = await (await fetch(b2 + '/tools')).json();
    assert.equal(toolsAfter.tools.find((t) => t.name === 'library_search').mutability, 'read');
    assert.equal(toolsAfter.tools.find((t) => t.name === 'note_write').mutability, 'write');
    assert.equal(toolsAfter.tools.find((t) => t.name === 'note_write').requiresConfirmation, true);

    const planRes = await post(
      '/run-turn',
      {
        conversationKey: 'mcp-plan-conv',
        scopeType: 'open',
        scopeId: 'lib-1',
        metadata: { permissionMode: 'plan' },
        userText: 'MOCK_ECHO_SETTINGS',
        mcpServers: {
          llm_for_zotero: {
            type: 'http',
            url: `http://127.0.0.1:${mcpPort}/llm-for-zotero/mcp`,
            headers: { Authorization: `Bearer ${expectedToken}` }
          }
        }
      },
      b2
    );
    const planFrames = (await planRes.text()).trim().split('\n').map(JSON.parse);
    assert.equal(JSON.parse(planFrames.at(-1).outcome.text).hasSettingsFlag, false);
  } finally {
    c2.kill();
    authMcp.close();
    await rm(d2, { recursive: true, force: true });
  }
});

test('runtime-retention, invalidate-session, and invalidate-all-hot-runtimes respect pool opt-in', async () => {
  // Default server has AGY_PROCESS_POOL disabled -> retained: false
  const defaultRet = await (
    await post('/runtime-retention', { conversationKey: 'pool-conv-1', scopeType: 'paper', scopeId: 'S1', retain: true })
  ).json();
  assert.equal(defaultRet.retained, false);

  const defaultInv = await (
    await post('/invalidate-session', { conversationKey: 'pool-conv-1', scopeType: 'paper', scopeId: 'S1' })
  ).json();
  assert.equal(defaultInv.invalidated, true);

  const defaultAll = await (await post('/invalidate-all-hot-runtimes', {})).json();
  assert.equal(defaultAll.invalidated, true);
  assert.equal(defaultAll.count, 0);

  // Start an opt-in AGY_PROCESS_POOL=1 instance and verify retention & invalidation
  const p3 = 17600 + Math.floor(Math.random() * 1500);
  const d3 = await mkdtemp(join(tmpdir(), 'agy-pool-test-'));
  const c3 = spawn(process.execPath, [bridge], {
    env: {
      ...process.env,
      AGY_BIN: binary,
      AGY_PREFIX_ARGS_JSON: prefix,
      AGY_CWD: d3,
      AGY_BRIDGE_STATE: join(d3, 'sessions.json'),
      AGY_BRIDGE_PORT: String(p3),
      AGY_PROCESS_POOL: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    const b3 = `http://127.0.0.1:${p3}`;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(b3 + '/healthz');
        if (r.ok) break;
      } catch {
        // wait
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const r1 = await (
      await post('/runtime-retention', { conversationKey: 'conv-pool', scopeType: 'paper', scopeId: 'A1', retain: true }, b3)
    ).json();
    assert.equal(r1.retained, true);

    const r2 = await (
      await post('/runtime-retention', { conversationKey: 'conv-pool', scopeType: 'paper', scopeId: 'A1', retain: false }, b3)
    ).json();
    assert.equal(r2.retained, false);

    // Multi-turn pooled execution reuses the exact same child process PID and normalizes cumulative usage deltas.
    const poolTurn1Res = await post(
      '/run-turn',
      { conversationKey: 'conv-pool', scopeType: 'paper', scopeId: 'A1', userText: 'MOCK_POOL_INFO' },
      b3
    );
    assert.equal(poolTurn1Res.status, 200);
    const poolTurn1Frames = (await poolTurn1Res.text()).trim().split('\n').map(JSON.parse);
    const poolTurn1Data = JSON.parse(poolTurn1Frames.at(-1).outcome.text);
    const poolTurn1Usage = poolTurn1Frames.find((f) => f.event?.type === 'usage').event;
    assert.equal(poolTurn1Data.turn, 1);
    assert.equal(poolTurn1Usage.inputTokens, 15);
    assert.equal(poolTurn1Usage.outputTokens, 5);
    assert.equal(poolTurn1Usage.cacheReadInputTokens, 2);

    const poolTurn2Res = await post(
      '/run-turn',
      { conversationKey: 'conv-pool', scopeType: 'paper', scopeId: 'A1', userText: 'MOCK_POOL_INFO' },
      b3
    );
    assert.equal(poolTurn2Res.status, 200);
    const poolTurn2Frames = (await poolTurn2Res.text()).trim().split('\n').map(JSON.parse);
    const poolTurn2Data = JSON.parse(poolTurn2Frames.at(-1).outcome.text);
    const poolTurn2Usage = poolTurn2Frames.find((f) => f.event?.type === 'usage').event;
    assert.equal(poolTurn2Data.pid, poolTurn1Data.pid);
    assert.equal(poolTurn2Data.turn, 2);
    assert.equal(poolTurn2Usage.inputTokens, 15);
    assert.equal(poolTurn2Usage.outputTokens, 5);
    assert.equal(poolTurn2Usage.cacheReadInputTokens, 2);

    const inv = await (
      await post('/invalidate-session', { conversationKey: 'conv-pool', scopeType: 'paper', scopeId: 'A1' }, b3)
    ).json();
    assert.equal(inv.invalidated, true);

    const info = await (
      await fetch(b3 + '/session-info?conversationKey=conv-pool&scopeType=paper&scopeId=A1')
    ).json();
    assert.equal(info.session.providerSessionId, undefined);

    const poolTurn3Res = await post(
      '/run-turn',
      { conversationKey: 'conv-pool', scopeType: 'paper', scopeId: 'A1', userText: 'MOCK_POOL_INFO' },
      b3
    );
    const poolTurn3Frames = (await poolTurn3Res.text()).trim().split('\n').map(JSON.parse);
    const poolTurn3Data = JSON.parse(poolTurn3Frames.at(-1).outcome.text);
    assert.notEqual(poolTurn3Data.pid, poolTurn1Data.pid);
    assert.equal(poolTurn3Data.turn, 1);

    const invAll = await (await post('/invalidate-all-hot-runtimes', {}, b3)).json();
    assert.equal(invAll.invalidated, true);
    assert.equal(invAll.count, 1);
  } finally {
    await post('/invalidate-all-hot-runtimes', {}, `http://127.0.0.1:${p3}`).catch(() => {});
    c3.kill();
    await rm(d3, { recursive: true, force: true });
  }
});

test('run-turn and efforts normalize base models, legacy suffixed variants, and auto effort cleanly', async () => {
  const eBase = await (await fetch(base + '/efforts?model=gemini-3.8-flash')).json();
  assert.equal(eBase.model, 'gemini-3.8-flash');
  assert.deepEqual(eBase.efforts, ['default', 'low', 'medium', 'high']);

  const eLegacy = await (await fetch(base + '/efforts?model=gemini-3.8-flash-low')).json();
  assert.equal(eLegacy.model, 'gemini-3.8-flash');
  assert.deepEqual(eLegacy.efforts, ['default', 'low', 'medium', 'high']);

  const f1 = await turn('MOCK_ECHO_MODEL_EFFORT', 'model-effort-1', { model: 'gemini-3.8-flash', effort: 'low' });
  assert.deepEqual(JSON.parse(f1.at(-1).outcome.text), { model: 'gemini-3.8-flash', effort: 'low' });

  const f2 = await turn('MOCK_ECHO_MODEL_EFFORT', 'model-effort-2', { model: 'gemini-3.8-flash-low', effort: 'high' });
  assert.deepEqual(JSON.parse(f2.at(-1).outcome.text), { model: 'gemini-3.8-flash', effort: 'high' });

  const f3 = await turn('MOCK_ECHO_MODEL_EFFORT', 'model-effort-3', { model: 'gemini-3.8-flash', effort: 'auto' });
  assert.deepEqual(JSON.parse(f3.at(-1).outcome.text), { model: 'gemini-3.8-flash', effort: null });
});

test('claude-code-agy.mjs speaks Claude Code CLI stream-json protocol for direct Claude Code path use', async () => {
  const shimDir = await mkdtemp(join(tmpdir(), 'agy-claude-shim-e2e-'));
  try {
    // 1. Check --version
    const verOut = await new Promise((resolveVer, rejectVer) => {
      const p = spawn(process.execPath, [claudeShim, '--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('error', rejectVer);
      p.on('close', (code) => {
        assert.equal(code, 0);
        resolveVer(out.trim());
      });
    });
    assert.match(verOut, /^2\.1\.0.*agy-zotero-bridge/);

    // 2. Drive initialize + empty probe + full tool/text turn + get_context_usage + follow-up turn
    const mcpCfg = JSON.stringify({
      mcpServers: {
        llm_for_zotero_p1: {
          type: 'http',
          url: 'http://127.0.0.1:1/mcp',
          headers: { Authorization: 'Bearer shim-secret-tok' }
        }
      }
    });
    const proc = spawn(
      process.execPath,
      [
        claudeShim,
        '--output-format',
        'stream-json',
        '--verbose',
        '--input-format',
        'stream-json',
        '--model',
        'gemini-3.8-flash-low',
        '--effort',
        'high',
        '--mcp-config',
        mcpCfg,
        '--allowedTools',
        'mcp__llm_for_zotero_p1__library_search'
      ],
      {
        cwd: shimDir,
        env: {
          ...process.env,
          AGY_BIN: binary,
          AGY_PREFIX_ARGS_JSON: prefix
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );

    const lines = [];
    const waiters = [];
    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const parsed = JSON.parse(line);
      lines.push(parsed);
      while (waiters.length > 0 && waiters[0].pred(parsed)) {
        waiters.shift().resolve(parsed);
      }
    });
    const waitForFrame = (pred, label) => {
      const existing = lines.find(pred);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveFrame, rejectFrame) => {
        const timer = setTimeout(() => rejectFrame(new Error(`Timed out waiting for ${label}`)), 5000);
        waiters.push({
          pred,
          resolve: (v) => {
            clearTimeout(timer);
            resolveFrame(v);
          }
        });
      });
    };

    proc.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'init-1',
        request: { subtype: 'initialize', systemPrompt: ['System rules line.'] }
      }) + '\n'
    );
    const initResp = await waitForFrame(
      (f) => f.type === 'control_response' && f.response?.request_id === 'init-1',
      'initialize control_response'
    );
    assert.equal(initResp.response.subtype, 'success');
    assert.equal(initResp.response.response.models[0].value, 'gemini-mock');

    // Empty probe message should not emit a turn result
    proc.stdin.write(
      JSON.stringify({
        type: 'user',
        session_id: '',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: '' }] }
      }) + '\n'
    );

    // Real user turn with tool lifecycle
    proc.stdin.write(
      JSON.stringify({
        type: 'user',
        session_id: '',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'MOCK_TOOL' }] }
      }) + '\n'
    );
    const res1 = await waitForFrame((f) => f.type === 'result', 'first turn result');
    assert.equal(res1.subtype, 'success');
    assert.equal(res1.is_error, false);
    assert.equal(res1.result, 'Hello');
    assert.equal(res1.session_id, 'abc-test-session');
    assert.ok(lines.some((f) => f.type === 'system' && f.subtype === 'init' && f.session_id === 'abc-test-session'));
    assert.ok(lines.some((f) => f.type === 'assistant' && f.message?.content?.[0]?.type === 'tool_use'));
    assert.ok(lines.some((f) => f.type === 'user' && f.message?.content?.[0]?.type === 'tool_result'));
    assert.ok(lines.some((f) => f.type === 'stream_event' && f.event?.delta?.text === 'Hel'));

    // Ephemeral workspace MCP plugin & settings created without touching global config
    const pluginJson = JSON.parse(await readFile(join(shimDir, '.agents', 'plugins', 'llm-for-zotero', 'plugin.json'), 'utf8'));
    assert.equal(pluginJson.name, 'llm-for-zotero');

    // get_context_usage query
    proc.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'ctx-1',
        request: { subtype: 'get_context_usage' }
      }) + '\n'
    );
    const ctxResp = await waitForFrame(
      (f) => f.type === 'control_response' && f.response?.request_id === 'ctx-1',
      'get_context_usage'
    );
    assert.equal(ctxResp.response.response.totalTokens, 12);

    // Follow-up turn checks normalized base model + effort
    const turn2StartIdx = lines.length;
    proc.stdin.write(
      JSON.stringify({
        type: 'user',
        session_id: 'abc-test-session',
        parent_tool_use_id: null,
        message: { role: 'user', content: 'MOCK_ECHO_MODEL_EFFORT' }
      }) + '\n'
    );
    const res2 = await waitForFrame(
      (f) => lines.indexOf(f) >= turn2StartIdx && f.type === 'result',
      'second turn result'
    );
    assert.deepEqual(JSON.parse(res2.result), { model: 'gemini-3.8-flash', effort: 'high' });

    proc.stdin.end();
    const exitCode = await new Promise((resolveExit) => proc.once('close', resolveExit));
    rl.close();
    assert.equal(exitCode, 0);
  } finally {
    await rm(shimDir, { recursive: true, force: true });
  }
});

test('bridge.mjs supports managed CLI flags, ADAPTER_AUTH_TOKEN, CLAUDE_BRIDGE_READY, and stdin close exit', async () => {
  const zoteroRoot = await mkdtemp(join(tmpdir(), 'agy-managed-bridge-test-'));
  const childProc = spawn(
    process.execPath,
    [
      bridge,
      '--host',
      '127.0.0.1',
      '--port',
      '0',
      '--zotero-root',
      zoteroRoot,
      '--managed-by',
      'llm-for-zotero',
      '--exit-on-stdin-close',
      '1'
    ],
    {
      env: {
        ...process.env,
        AGY_BIN: binary,
        AGY_PREFIX_ARGS_JSON: prefix,
        ADAPTER_AUTH_TOKEN: 'managed-secret-tok'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );

  try {
    const ready = await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => rejectReady(new Error('Timed out waiting for CLAUDE_BRIDGE_READY')), 5000);
      const rl = createInterface({ input: childProc.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        if (line.startsWith('CLAUDE_BRIDGE_READY ')) {
          clearTimeout(timer);
          rl.close();
          resolveReady(JSON.parse(line.slice('CLAUDE_BRIDGE_READY '.length)));
        }
      });
    });

    assert.ok(Number.isInteger(ready.port) && ready.port > 0);
    const unauth = await fetch(`http://127.0.0.1:${ready.port}/healthz`);
    assert.equal(unauth.status, 401);

    const health = await (await fetch(`http://127.0.0.1:${ready.port}/managed-secret-tok/healthz`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.managedBy, 'llm-for-zotero');

    childProc.stdin.end();
    const exitCode = await new Promise((resolveExit) => childProc.once('close', resolveExit));
    assert.equal(exitCode, 0);
  } finally {
    childProc.kill();
    await rm(zoteroRoot, { recursive: true, force: true });
  }
});
