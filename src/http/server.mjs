import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { CliProbe } from '../agy/cli-probe.mjs';
import { SessionProcessPool } from '../agy/process-pool.mjs';
import { BridgeHttpError, runStructuredCompletion, runTurnStream } from '../agy/process-runner.mjs';
import { EmbeddingService } from '../embedding/embedding-service.mjs';
import { buildAgyMcpConfigSnippet, classifyToolMetadata, probeZoteroMcp, stripScopeHeader } from '../mcp/zotero-mcp.mjs';
import { redactSensitive } from '../security/redact.mjs';
import { SessionStore } from '../session/session-store.mjs';

const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, maxBody) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBody) {
      throw new BridgeHttpError(413, 'request_too_large', 'request too large');
    }
  }
  if (!raw.trim()) return {};
  try {
    return record(JSON.parse(raw));
  } catch {
    throw new BridgeHttpError(400, 'invalid_json', 'request body must be valid JSON');
  }
}

function getPermissionModesPayload(config) {
  return {
    modes: [
      { id: 'default', description: 'agy default (unapproved tools may be denied)', available: true },
      { id: 'auto', description: 'agy sandbox auto (requires supported version)', available: true },
      { id: 'plan', description: 'agy planning mode', available: true },
      { id: 'acceptEdits', description: 'agy accept-edits', available: true },
      { id: 'dontAsk', description: 'agy default no interactive approval', available: true },
      {
        id: 'bypassPermissions',
        description: 'agy bypass all permissions (unsafe)',
        available: config.allowYolo,
        ...(!config.allowYolo ? { disabledReason: 'Requires AGY_ALLOW_YOLO=1' } : {})
      }
    ],
    configuredDefaultMode: 'default'
  };
}

/**
 * Builds the HTTP request handler and shared runtime state for the bridge.
 */
export function createBridgeApp(config) {
  const sessionStore = new SessionStore({ root: config.root, stateFile: config.stateFile });
  const cliProbe = new CliProbe(config);
  const processPool = new SessionProcessPool({
    enabled: config.processPoolEnabled,
    maxSize: config.poolMaxSize,
    idleTtlMs: config.poolIdleTtlMs,
    maxTurnsPerProcess: config.poolMaxTurnsPerProcess,
    maxProcessAgeMs: config.poolMaxProcessAgeMs
  });
  const embeddingService = new EmbeddingService(config);
  let knownTools = [];
  let discoveredMcpTools = [];
  const capturedMcpServers = new Map();

  const updateTools = (tools) => {
    knownTools = [...new Set(tools)];
  };

  const updateCapturedMcp = (servers) => {
    for (const [name, entry] of Object.entries(servers || {})) {
      if (entry && typeof entry.url === 'string') {
        capturedMcpServers.set(name, { url: entry.url, headers: stripScopeHeader(entry.headers || {}) });
      }
    }
  };

  async function handler(req, res) {
    try {
      const url = new URL(req.url || '/', `http://${config.host}:${config.port}`);
      if (config.token) {
        const prefix = '/' + config.token;
        if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        url.pathname = url.pathname.slice(prefix.length) || '/';
      }

      const path = url.pathname;

      if (req.method === 'GET' && path === '/healthz') {
        const health = await cliProbe.checkHealth();
        sendJson(res, 200, health);
        return;
      }

      if (req.method === 'GET' && path === '/models') {
        const infos = await cliProbe.getModels(url.searchParams.get('refresh') === '1');
        sendJson(res, 200, { models: infos.map((x) => x.value), modelInfos: infos });
        return;
      }

      if (req.method === 'GET' && path === '/efforts') {
        const modelId = url.searchParams.get('model') || '';
        const payload = await cliProbe.getEfforts(modelId);
        sendJson(res, 200, payload);
        return;
      }

      if (req.method === 'GET' && path === '/tools') {
        const nativeTools = knownTools.map((name) =>
          classifyToolMetadata(name, `agy native tool: ${name}`, {}, 'claude-runtime')
        );
        const mcpTools = discoveredMcpTools.map((t) =>
          classifyToolMetadata(t.name, t.description, t.annotations, 'mcp')
        );
        sendJson(res, 200, { tools: [...nativeTools, ...mcpTools] });
        return;
      }

      if (req.method === 'GET' && path === '/commands') {
        sendJson(res, 200, { commands: [] });
        return;
      }

      if (req.method === 'GET' && path === '/permission-modes') {
        sendJson(res, 200, getPermissionModesPayload(config));
        return;
      }

      if (req.method === 'GET' && path === '/session-info') {
        const params = Object.fromEntries(url.searchParams);
        const k = sessionStore.sessionKey(params);
        sendJson(res, 200, {
          session: {
            originalConversationKey: String(params.conversationKey),
            scopedConversationKey: k,
            providerSessionId: sessionStore.get(k),
            scopeType: params.scopeType,
            scopeId: params.scopeId,
            scopeLabel: params.scopeLabel,
            cwd: sessionStore.scopedCwd(params)
          }
        });
        return;
      }

      if (req.method === 'GET' && path === '/account-quota') {
        sendJson(res, 200, { quota: null });
        return;
      }

      if (req.method === 'GET' && path === '/mcp-servers') {
        const shouldProbe =
          config.zoteroMcpEnabled ||
          url.searchParams.get('probe') === '1' ||
          capturedMcpServers.size > 0;
        if (!shouldProbe) {
          sendJson(res, 200, {
            servers: [],
            hint: buildAgyMcpConfigSnippet({ url: config.zoteroMcpUrl })
          });
          return;
        }

        const targets =
          capturedMcpServers.size > 0
            ? [...capturedMcpServers.entries()].map(([name, entry]) => ({
                name,
                url: entry.url,
                headers: entry.headers
              }))
            : [
                {
                  name: 'llm_for_zotero',
                  url: config.zoteroMcpUrl,
                  headers: config.zoteroMcpToken
                    ? { Authorization: `Bearer ${config.zoteroMcpToken}` }
                    : {}
                }
              ];

        const statuses = [];
        const allMcpTools = [];
        for (const t of targets) {
          const status = await probeZoteroMcp({ url: t.url, headers: t.headers });
          if (status.connected) {
            allMcpTools.push(...status.tools);
          }
          statuses.push({
            id: t.name || status.id,
            name: t.name || status.name,
            transport: status.transport,
            url: status.url,
            connected: status.connected,
            status: status.status,
            protocolVersion: status.protocolVersion,
            toolCount: status.tools.length,
            writeEnabled: config.zoteroMcpAllowWrite,
            ...(status.error ? { error: status.error } : {})
          });
        }
        if (allMcpTools.length > 0) {
          discoveredMcpTools = allMcpTools;
        }

        sendJson(res, 200, {
          servers: statuses,
          setup: buildAgyMcpConfigSnippet({ url: config.zoteroMcpUrl })
        });
        return;
      }

      if (req.method === 'POST' && path === '/run-turn') {
        const body = await readJsonBody(req, config.maxBody);
        if (cliProbe.modelsCache.infos.length === 0) {
          await cliProbe.hydrateDiskCache();
        }
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        await runTurnStream({
          body,
          res,
          config,
          sessionStore,
          processPool,
          knownModels: cliProbe.modelsCache.infos,
          knownEfforts: cliProbe.knownEffortLevels,
          onTools: updateTools,
          onMcpConfigured: updateCapturedMcp
        });
        return;
      }

      if (req.method === 'POST' && path === '/structured-completion') {
        const body = await readJsonBody(req, config.maxBody);
        if (cliProbe.modelsCache.infos.length === 0) {
          await cliProbe.hydrateDiskCache();
        }
        const result = await runStructuredCompletion({
          body,
          res,
          config,
          knownModels: cliProbe.modelsCache.infos,
          knownEfforts: cliProbe.knownEffortLevels
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && (path === '/v1/embeddings/status' || path === '/embeddings/status')) {
        sendJson(res, 200, embeddingService.getStatus());
        return;
      }

      if (req.method === 'POST' && (path === '/v1/embeddings' || path === '/embeddings')) {
        const body = await readJsonBody(req, config.maxBody);
        const controller = new AbortController();
        const onClose = () => {
          if (!res.writableFinished) controller.abort();
        };
        res.once('close', onClose);
        try {
          const payload = await embeddingService.embed({
            input: body.input,
            model: typeof body.model === 'string' ? body.model : '',
            dimensions: Number(body.dimensions) || 0,
            authHeader: req.headers.authorization || '',
            signal: controller.signal
          });
          sendJson(res, 200, payload);
        } finally {
          res.off('close', onClose);
        }
        return;
      }

      if (req.method === 'POST' && path === '/invalidate-session') {
        const body = await readJsonBody(req, config.maxBody);
        const k = sessionStore.sessionKey(body);
        sessionStore.delete(k);
        processPool.invalidate(k);
        await sessionStore.save();
        sendJson(res, 200, {
          originalConversationKey: String(body.conversationKey),
          scopedConversationKey: k,
          invalidated: true
        });
        return;
      }

      if (req.method === 'POST' && path === '/runtime-retention') {
        const body = await readJsonBody(req, config.maxBody);
        const k = sessionStore.sessionKey(body);
        const shouldRetain = body.retain !== undefined ? Boolean(body.retain) : true;
        const retained = processPool.retain(k, shouldRetain);
        sendJson(res, 200, {
          originalConversationKey: String(body.conversationKey),
          scopedConversationKey: k,
          retained
        });
        return;
      }

      if (req.method === 'POST' && path === '/invalidate-all-hot-runtimes') {
        const count = processPool.invalidateAll();
        sendJson(res, 200, { invalidated: true, count });
        return;
      }

      if (req.method === 'POST' && (path === '/run-action' || path === '/resolve-confirmation')) {
        sendJson(res, 501, {
          error: 'unsupported_by_agy_headless_v0',
          reason: 'agy CLI headless mode does not support interactive mid-turn confirmation callbacks'
        });
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    } catch (e) {
      const msg = redactSensitive(e?.message || e, [config.token]);
      if (!res.headersSent) {
        let status = e instanceof BridgeHttpError ? e.status : 500;
        if (status === 500 && /required|nonempty|too large|must be|unsupported permission mode|escaped/i.test(msg)) {
          status = /too large/i.test(msg) ? 413 : 400;
        }
        sendJson(res, status, {
          error: e instanceof BridgeHttpError ? e.code : 'bridge_error',
          message: msg
        });
      } else if (!res.destroyed && !res.writableEnded) {
        res.write(JSON.stringify({ type: 'event', event: { type: 'fallback', reason: msg } }) + '\n');
        res.write(
          JSON.stringify({
            type: 'outcome',
            outcome: { kind: 'fallback', runId: 'agy-error', reason: msg, usedFallback: true }
          }) + '\n'
        );
        res.end();
      }
    }
  }

  return {
    config,
    sessionStore,
    cliProbe,
    processPool,
    embeddingService,
    handler,
    async init() {
      await mkdir(config.root, { recursive: true });
      await sessionStore.load();
      await embeddingService.load();
      await cliProbe.hydrateDiskCache();
    },
    async close() {
      cliProbe.close();
      processPool.close();
    }
  };
}

/**
 * Creates and initializes the Node HTTP server without forcing module-level side effects.
 */
export async function startBridgeServer(config) {
  const app = createBridgeApp(config);
  await app.init();
  const server = createServer(app.handler);
  server.once('close', () => {
    app.close?.();
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, config.host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  return { server, app };
}
