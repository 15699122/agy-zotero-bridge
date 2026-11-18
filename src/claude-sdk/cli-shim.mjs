import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CliProbe, resolveAgyModelAndEffort } from '../agy/cli-probe.mjs';
import { normalizeCumulativeUsage } from '../agy/process-pool.mjs';
import { killProcessTree, permissionArgs } from '../agy/process-runner.mjs';
import { BRIDGE_VERSION, createConfig } from '../config.mjs';
import { discoverSafeReadDirs, materializeTurnImages, renderMultimodalImagePrompt } from '../context/prompt-builder.mjs';
import { prepareScopedMcpPlugin, probeZoteroMcp, writeScopedAgySettingsFile } from '../mcp/zotero-mcp.mjs';
import { classifyAgyError, createTurnEventMapper } from '../protocol/event-mapper.mjs';
import { redactSensitive } from '../security/redact.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const BOOLEAN_FLAGS = new Set([
  '--version',
  '-v',
  '--help',
  '-h',
  '--verbose',
  '--allow-dangerously-skip-permissions',
  '--strict-mcp-config',
  '--include-partial-messages',
  '--fork-session',
  '--no-session-persistence',
  '--continue'
]);

/**
 * Parses CLI flags passed by `@anthropic-ai/claude-agent-sdk` (supporting both `--flag val`
 * and `--flag=val`, repeatable `--add-dir`, and `--tools ""`).
 */
export function parseClaudeShimArgs(argv = []) {
  const out = {
    version: false,
    help: false,
    outputFormat: 'text',
    inputFormat: 'text',
    model: '',
    effort: '',
    permissionMode: 'default',
    allowYoloFlag: false,
    resume: '',
    sessionId: '',
    mcpConfig: '',
    allowedTools: [],
    disallowedTools: [],
    hasToolsFlag: false,
    tools: 'default',
    settingSources: [],
    jsonSchema: '',
    settings: '',
    addDirs: [],
    noSessionPersistence: false,
    maxTurns: '',
    promptParts: []
  };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] ?? '');
    if (!raw.startsWith('-')) {
      out.promptParts.push(raw);
      continue;
    }

    const eqIdx = raw.indexOf('=');
    const flag = eqIdx > 0 ? raw.slice(0, eqIdx) : raw;
    const inlineVal = eqIdx > 0 ? raw.slice(eqIdx + 1) : undefined;

    if (BOOLEAN_FLAGS.has(flag)) {
      if (flag === '--version' || flag === '-v') out.version = true;
      else if (flag === '--help' || flag === '-h') out.help = true;
      else if (flag === '--allow-dangerously-skip-permissions') out.allowYoloFlag = true;
      else if (flag === '--no-session-persistence') out.noSessionPersistence = true;
      continue;
    }

    const takeVal = () => {
      if (inlineVal !== undefined) return inlineVal;
      if (i + 1 < argv.length) {
        i += 1;
        return String(argv[i] ?? '');
      }
      return '';
    };

    switch (flag) {
      case '--output-format':
        out.outputFormat = takeVal();
        break;
      case '--input-format':
        out.inputFormat = takeVal();
        break;
      case '--model':
        out.model = takeVal();
        break;
      case '--effort':
        out.effort = takeVal();
        break;
      case '--permission-mode':
        out.permissionMode = takeVal();
        break;
      case '--resume':
        out.resume = takeVal();
        break;
      case '--session-id':
        out.sessionId = takeVal();
        break;
      case '--mcp-config':
        out.mcpConfig = takeVal();
        break;
      case '--allowedTools':
        out.allowedTools.push(
          ...takeVal()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        );
        break;
      case '--disallowedTools':
        out.disallowedTools.push(
          ...takeVal()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        );
        break;
      case '--tools':
        out.hasToolsFlag = true;
        out.tools = takeVal();
        break;
      case '--setting-sources':
        out.settingSources.push(
          ...takeVal()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        );
        break;
      case '--json-schema':
        out.jsonSchema = takeVal();
        break;
      case '--settings':
        out.settings = takeVal();
        break;
      case '--add-dir': {
        const dir = takeVal().trim();
        if (dir) out.addDirs.push(dir);
        break;
      }
      case '--max-turns':
        out.maxTurns = takeVal();
        break;
      case '--permission-prompt-tool':
      case '--debug-file':
      case '--fallback-model':
      case '--agent':
      case '--betas':
      case '--resume-session-at':
      case '--channels':
      case '--plugin-dir':
      case '--plugin-dir-no-mcp':
      case '--thinking':
      case '--max-thinking-tokens':
      case '--thinking-display':
      case '--max-budget-usd':
      case '--task-budget':
      case '--managed-settings':
      case '--workload':
        takeVal();
        break;
      default:
        // Consume value if next token looks non-flag and no inline '=' was present
        if (inlineVal === undefined && i + 1 < argv.length && !String(argv[i + 1]).startsWith('-')) {
          i += 1;
        }
        break;
    }
  }

  return out;
}

/**
 * Parses `--mcp-config` JSON strings or file paths into a `{ serverName: config }` map.
 */
async function loadMcpServersArg(rawMcpConfig) {
  const raw = String(rawMcpConfig || '').trim();
  if (!raw) return {};

  let text = raw;
  if (!raw.startsWith('{')) {
    try {
      text = await readFile(raw, 'utf8');
    } catch {
      return {};
    }
  }

  try {
    const parsed = JSON.parse(text);
    const candidate = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : parsed;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return {};
    return Object.fromEntries(
      Object.entries(candidate).filter(([, cfg]) => cfg && typeof cfg === 'object' && !Array.isArray(cfg) && (cfg.url || cfg.serverUrl))
    );
  } catch {
    return {};
  }
}

/**
 * Extracts plain text prompt content from an SDK `user` JSONL line.
 */
export function extractSdkUserText(msg) {
  const content = msg?.message?.content ?? msg?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Extracts base64 image blocks from an SDK `user` JSONL line (`type: "image"` or data-URI `image_url`).
 */
export function extractSdkUserImageBlocks(msg) {
  const content = msg?.message?.content ?? msg?.content;
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'image' && part.source && typeof part.source === 'object') {
      if (part.source.type === 'base64' && typeof part.source.data === 'string' && typeof part.source.media_type === 'string') {
        blocks.push({ mediaType: part.source.media_type, data: part.source.data });
      } else if (part.source.type === 'url' && typeof part.source.url === 'string') {
        const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(part.source.url.trim());
        if (m) blocks.push({ mediaType: m[1].toLowerCase(), data: m[2].replace(/\s+/g, '') });
      }
      continue;
    }
    if (part.type === 'image_url') {
      const rawUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      if (typeof rawUrl === 'string') {
        const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(rawUrl.trim());
        if (m) blocks.push({ mediaType: m[1].toLowerCase(), data: m[2].replace(/\s+/g, '') });
      }
    }
  }
  return blocks;
}

/**
 * Ensures `node_modules/@anthropic-ai/claude-code/cli.js` exists inside `repoRoot`
 * so `llm-for-zotero`'s `resolveWindowsClaudeShim()` works when `claude-code-agy.cmd`
 * is configured in Windows **Claude Code path**.
 */
export async function ensureWindowsClaudeCmdShim(repoRoot = REPO_ROOT) {
  const pkgDir = join(resolve(repoRoot), 'node_modules', '@anthropic-ai', 'claude-code');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      {
        name: '@anthropic-ai/claude-code',
        version: '2.1.0',
        type: 'module',
        bin: {
          claude: './cli.js'
        }
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  await writeFile(
    join(pkgDir, 'cli.js'),
    "#!/usr/bin/env node\nimport { runClaudeCodeAgyShim } from '../../../src/claude-sdk/cli-shim.mjs';\nawait runClaudeCodeAgyShim();\n",
    'utf8'
  );
  return pkgDir;
}

/**
 * Runs the Claude Code CLI / `@anthropic-ai/claude-agent-sdk` stdio `stream-json`
 * subprocess shim backed by `agy`.
 */
export async function runClaudeCodeAgyShim({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr
} = {}) {
  const parsed = parseClaudeShimArgs(argv);

  if (parsed.version) {
    stdout.write(`2.1.0 (Claude Code / agy-zotero-bridge ${BRIDGE_VERSION})\n`);
    return 0;
  }

  if (parsed.help) {
    stdout.write(
      `agy-zotero-bridge Claude Code CLI shim (${BRIDGE_VERSION})\n` +
        'Drop-in executable for llm-for-zotero "Claude Code path". Supports --version and --output-format stream-json --input-format stream-json.\n'
    );
    return 0;
  }

  const workCwd = resolve(cwd || process.cwd());
  const config = createConfig({ ...env, AGY_CWD: env.AGY_CWD || workCwd });
  const cliProbe = new CliProbe(config);

  let activeModel = parsed.model || config.defaultModel || '';
  let activeEffort = parsed.effort || config.defaultEffort || '';
  let activePermissionMode = parsed.permissionMode || config.defaultPermissionMode || 'default';
  let activeJsonSchema = parsed.jsonSchema || '';
  let activeResumeId = parsed.noSessionPersistence ? '' : parsed.resume || '';
  let activeMcpServers = await loadMcpServersArg(parsed.mcpConfig);
  let systemPromptText = '';
  let appendSystemPromptText = '';
  let systemPromptDelivered = false;
  let lastContextTokens = 0;
  let activeChild = null;
  let interruptRequested = false;
  let warmRuntime = null;

  const closeWarmRuntime = () => {
    if (!warmRuntime) return;
    const rt = warmRuntime;
    warmRuntime = null;
    try {
      rt.rl?.close();
    } catch {}
    killProcessTree(rt.child);
  };

  const isWarmRuntimeReusable = (signature) => {
    if (!warmRuntime || !warmRuntime.child) return false;
    if (warmRuntime.closed || warmRuntime.child.exitCode !== null || warmRuntime.child.signalCode !== null) {
      return false;
    }
    if (warmRuntime.signature !== signature) return false;
    if ((warmRuntime.turnCount || 0) >= config.poolMaxTurnsPerProcess) return false;
    if (Date.now() - warmRuntime.createdAt >= config.poolMaxProcessAgeMs) return false;
    return true;
  };

  const spawnWarmRuntime = (spawnArgs, signature) => {
    closeWarmRuntime();
    const child = spawn(config.binary, [...config.prefixArgs, ...spawnArgs], {
      cwd: workCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const rt = {
      child,
      rl,
      signature,
      createdAt: Date.now(),
      turnCount: 0,
      cumulativeUsage: null,
      closed: false,
      exitInfo: { code: null, signal: null },
      childError: null,
      activeTurn: null
    };
    child.on('error', (err) => {
      rt.childError = err;
      rt.activeTurn?.onError(err);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      rt.activeTurn?.onStderr(chunk);
    });
    rl.on('line', (line) => {
      rt.activeTurn?.onLine(line);
    });
    child.once('close', (code, signal) => {
      rt.closed = true;
      rt.exitInfo = { code, signal };
      rl.close();
      rt.activeTurn?.onClose(rt.exitInfo);
      if (warmRuntime === rt) warmRuntime = null;
    });
    warmRuntime = rt;
    return rt;
  };

  const writeJsonLine = (obj) => {
    stdout.write(JSON.stringify(obj) + '\n');
  };

  async function executeTurn(userText, imageBlocks = []) {
    const startedAt = Date.now();
    interruptRequested = false;
    const fallbackSessionId = activeResumeId || parsed.sessionId || randomUUID();
    let emittedInit = false;
    let toolsFromInit = [];

    const emitInitIfNeeded = (sessionId) => {
      if (emittedInit) return;
      emittedInit = true;
      writeJsonLine({
        type: 'system',
        subtype: 'init',
        session_id: sessionId || fallbackSessionId,
        tools: toolsFromInit
      });
    };

    try {
      await mkdir(workCwd, { recursive: true });

      const { model, effort } = resolveAgyModelAndEffort(activeModel, activeEffort);
      const permFlags = permissionArgs({ metadata: { permissionMode: activePermissionMode } }, config);
      const effectivePermissionMode = String(activePermissionMode || 'default').trim().toLowerCase();
      const allowWriteForTurn = effectivePermissionMode === 'plan' ? false : config.zoteroMcpAllowWrite;
      const noToolsMode = parsed.hasToolsFlag && parsed.tools === '';

      const { imageAssets, rejectedImages, imageReadDirs } = await materializeTurnImages({
        sdkImageBlocks: imageBlocks,
        cwd: workCwd,
        allowedRoots: [...config.allowedPdfRoots, ...config.extraDirs]
      });

      const headSections = [];
      if (!systemPromptDelivered && !activeResumeId) {
        if (systemPromptText.trim()) headSections.push(systemPromptText.trim());
        if (appendSystemPromptText.trim()) headSections.push(appendSystemPromptText.trim());
      }
      if (rejectedImages.length > 0 && imageAssets.length === 0) {
        headSections.push(
          `Attachment notice: ${rejectedImages.length} image block(s) could not be materialized (${rejectedImages
            .map((r) => r.reason)
            .join(', ')}).`
        );
      }

      const tailSections = [];
      if (imageAssets.length > 0) {
        tailSections.push(renderMultimodalImagePrompt(imageAssets));
      }
      if (userText.trim() || tailSections.length === 0) {
        tailSections.push(userText || 'Please inspect the attached image(s).');
      }

      const sep = '\n\n---\n\n';
      const tailText = tailSections.join(sep);
      let fullPrompt = tailText;
      if (tailText.length >= config.maxPrompt) {
        fullPrompt = tailText.slice(tailText.length - config.maxPrompt);
      } else if (headSections.length > 0) {
        const headText = headSections.join(sep);
        const remaining = config.maxPrompt - tailText.length - sep.length;
        if (remaining > 0) {
          fullPrompt =
            headText.length <= remaining
              ? `${headText}${sep}${tailText}`
              : `${headText.slice(0, remaining)}${sep}${tailText}`;
        }
      }

      let readDirs = [];
      let settingsFile = '';
      if (!noToolsMode) {
        readDirs = await discoverSafeReadDirs({
          root: workCwd,
          extraDirs: [...config.extraDirs, ...parsed.addDirs],
          allowedPdfRoots: config.allowedPdfRoots,
          instructionTexts: [systemPromptText, appendSystemPromptText, userText],
          imageReadDirs
        });

        if (Object.keys(activeMcpServers).length > 0) {
          const preparedMcp = await prepareScopedMcpPlugin({
            cwd: workCwd,
            mcpServers: activeMcpServers,
            allowedTools: parsed.allowedTools,
            readDirs,
            allowWrite: allowWriteForTurn
          });
          settingsFile = preparedMcp?.settingsFile || '';
        }
        if (!settingsFile && readDirs.length > 0) {
          const written = await writeScopedAgySettingsFile({
            cwd: workCwd,
            allowedTools: parsed.allowedTools,
            readDirs,
            allowWrite: allowWriteForTurn
          });
          settingsFile = written.settingsFile || '';
        }
      }

      const canPoolShim = Boolean(
        parsed.inputFormat === 'stream-json' &&
          config.processPoolEnabled &&
          !noToolsMode &&
          effectivePermissionMode !== 'plan' &&
          !activeJsonSchema &&
          !parsed.noSessionPersistence
      );

      let finalState = null;
      let finalLastUsage = null;
      let finalFailure = null;
      let finalClassified = null;

      const emitSdkEvent = (ev, mapper, isPooled, pooledState) => {
        const sessionId = mapper.getState().sessionId || ev.sessionId || fallbackSessionId;
        if (ev.type === 'provider_event' && ev.providerType === 'agy_session') {
          emitInitIfNeeded(sessionId);
          return;
        }
        if (ev.type === 'message_delta') {
          emitInitIfNeeded(sessionId);
          writeJsonLine({
            type: 'stream_event',
            session_id: sessionId,
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: ev.text }
            }
          });
          return;
        }
        if (ev.type === 'tool_call') {
          emitInitIfNeeded(sessionId);
          writeJsonLine({
            type: 'assistant',
            session_id: sessionId,
            parent_tool_use_id: null,
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: ev.callId,
                  name: ev.name,
                  input: ev.args ?? {}
                }
              ]
            }
          });
          return;
        }
        if (ev.type === 'tool_result') {
          emitInitIfNeeded(sessionId);
          writeJsonLine({
            type: 'user',
            session_id: sessionId,
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: ev.callId,
                  content: ev.content ?? '',
                  is_error: ev.ok === false
                }
              ]
            }
          });
          return;
        }
        if (ev.type === 'tool_error') {
          emitInitIfNeeded(sessionId);
          writeJsonLine({
            type: 'user',
            session_id: sessionId,
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: ev.callId,
                  content: ev.error || 'tool_error',
                  is_error: true
                }
              ]
            }
          });
          return;
        }
        if (ev.type === 'usage') {
          let usagePayload = ev;
          if (isPooled && pooledState) {
            const normalized = normalizeCumulativeUsage(ev, pooledState.prevCumulativeUsage);
            pooledState.latestCumulativeUsage = normalized.cumulative;
            usagePayload = normalized;
          }
          const lastUsageObj = {
            input_tokens: usagePayload.inputTokens,
            output_tokens: usagePayload.outputTokens,
            cache_creation_input_tokens: usagePayload.cacheCreationInputTokens || 0,
            cache_read_input_tokens: usagePayload.cacheReadInputTokens || 0
          };
          if (pooledState) pooledState.lastUsage = lastUsageObj;
          lastContextTokens =
            usagePayload.contextTokens ||
            usagePayload.inputTokens + usagePayload.outputTokens + (usagePayload.cacheReadInputTokens || 0);
          writeJsonLine({
            type: 'stream_event',
            session_id: sessionId,
            event: {
              type: 'message_delta',
              usage: lastUsageObj
            }
          });
        }
      };

      if (canPoolShim) {
        const shimSignature = JSON.stringify({
          workCwd,
          model,
          effort,
          effectivePermissionMode,
          allowWriteForTurn,
          settingsFile,
          readDirs
        });
        const poolPrintTimeoutSec = Math.max(120, Math.ceil(((config.poolMaxProcessAgeMs || 1_500_000) + 60_000) / 1000));

        for (let attempt = 0; attempt <= config.rateLimitMaxRetries; attempt += 1) {
          let rt = isWarmRuntimeReusable(shimSignature) ? warmRuntime : null;
          if (!rt) {
            const poolArgs = [
              '--input-format',
              'stream-json',
              '--output-format',
              'stream-json',
              '--print=',
              '--print-timeout',
              `${poolPrintTimeoutSec}s`,
              '--disable-slash-commands'
            ];
            if (activeResumeId) poolArgs.push('--conversation', activeResumeId);
            if (model && model !== 'default') poolArgs.push('--model', model);
            if (effort && effort !== 'default') poolArgs.push('--effort', effort);
            poolArgs.push(...permFlags);
            if (settingsFile) poolArgs.push('--settings', settingsFile);
            for (const dir of readDirs) poolArgs.push('--add-dir', dir);
            rt = spawnWarmRuntime(poolArgs, shimSignature);
          }

          activeChild = rt.child;
          let turnStderr = '';
          const pooledState = { prevCumulativeUsage: rt.cumulativeUsage, latestCumulativeUsage: null, lastUsage: null };
          const mapper = createTurnEventMapper({
            runId: `agy-shim-${randomUUID()}`,
            model,
            onTools: (tools) => {
              toolsFromInit = tools;
            },
            onEvent: (ev) => emitSdkEvent(ev, mapper, true, pooledState),
            maxNdjsonLine: config.maxNdjsonLine,
            extraSecrets: [config.token]
          });

          let turnError = null;
          let turnExitCode = 0;
          try {
            if (rt.childError) throw rt.childError;
            if (rt.closed || rt.child.exitCode !== null || rt.child.signalCode !== null) {
              throw new Error('pooled agy process exited before turn');
            }

            await new Promise((resolveTurn, rejectTurn) => {
              let settled = false;
              let settleTimer = null;
              const clearSettle = () => {
                if (settleTimer) {
                  clearTimeout(settleTimer);
                  settleTimer = null;
                }
              };
              const failTurn = (err) => {
                if (settled) return;
                settled = true;
                clearSettle();
                rt.activeTurn = null;
                rejectTurn(err);
              };
              const succeedTurn = () => {
                if (settled) return;
                settled = true;
                clearSettle();
                rt.activeTurn = null;
                resolveTurn();
              };

              rt.activeTurn = {
                onStderr(chunk) {
                  turnStderr = (turnStderr + chunk).slice(-config.maxStderr);
                },
                onLine(line) {
                  if (settled) return;
                  try {
                    mapper.processLine(line);
                  } catch (err) {
                    failTurn(err);
                    return;
                  }
                  const st = mapper.getState();
                  if (st.resultSeen) {
                    if (st.success) {
                      clearSettle();
                      settleTimer = setTimeout(() => {
                        if (settled) return;
                        const code = rt.exitInfo?.code ?? rt.child.exitCode;
                        if (code !== null && code !== 0) {
                          turnExitCode = code;
                          failTurn(new Error(`agy process exited with code ${code}`));
                          return;
                        }
                        succeedTurn();
                      }, 15);
                    } else {
                      failTurn(new Error('agy did not complete successfully'));
                    }
                  }
                },
                onError(e) {
                  failTurn(e);
                },
                onClose(exitInfo) {
                  turnExitCode = exitInfo?.code ?? 1;
                  if (turnExitCode !== 0) {
                    failTurn(new Error(`agy process exited with code ${turnExitCode}`));
                  } else {
                    failTurn(new Error('agy exited without a terminal result'));
                  }
                }
              };

              const payload = JSON.stringify({ event: 'user', message: { content: fullPrompt } }) + '\n';
              rt.child.stdin.write(payload, 'utf8', (writeErr) => {
                if (writeErr) failTurn(writeErr);
              });
            });
          } catch (err) {
            turnError = err;
          }

          activeChild = null;
          if (turnStderr.trim()) {
            stderr.write(redactSensitive(turnStderr, [config.token]));
          }

          const state = mapper.getState();
          const failure =
            turnError ||
            (interruptRequested ? new Error('interrupted') : null) ||
            (!state.resultSeen ? new Error('agy exited without a terminal result') : null) ||
            (!state.success ? new Error('agy did not complete successfully') : null);

          finalState = state;
          finalLastUsage = pooledState.lastUsage;
          finalFailure = failure;

          if (!failure) {
            if (pooledState.latestCumulativeUsage) {
              rt.cumulativeUsage = pooledState.latestCumulativeUsage;
            }
            rt.turnCount = (rt.turnCount || 0) + 1;
            if (rt.turnCount >= config.poolMaxTurnsPerProcess || Date.now() - rt.createdAt >= config.poolMaxProcessAgeMs) {
              closeWarmRuntime();
            }
            finalClassified = null;
            break;
          }

          closeWarmRuntime();
          finalClassified = classifyAgyError(failure.message, turnStderr, turnExitCode || 1, [config.token]);
          if (
            finalClassified.code === 'rate_limited' &&
            !interruptRequested &&
            state.settledToolCount === 0 &&
            attempt < config.rateLimitMaxRetries
          ) {
            await new Promise((r) => setTimeout(r, config.rateLimitRetryDelayMs * (attempt + 1)));
            continue;
          }
          break;
        }
      } else {
        closeWarmRuntime();
        const args = ['-p', fullPrompt, '--output-format', 'stream-json', '--disable-slash-commands'];
        if (activeResumeId && !parsed.noSessionPersistence) {
          args.push('--conversation', activeResumeId);
        }
        if (model && model !== 'default') args.push('--model', model);
        if (effort && effort !== 'default') args.push('--effort', effort);
        if (activeJsonSchema) args.push('--json-schema', activeJsonSchema);
        args.push(...permFlags);
        if (settingsFile && effectivePermissionMode !== 'plan') {
          args.push('--settings', settingsFile);
        }
        for (const dir of readDirs) {
          args.push('--add-dir', dir);
        }

        for (let attempt = 0; attempt <= config.rateLimitMaxRetries; attempt += 1) {
          let turnStderr = '';
          let childError = null;
          const nonPooledState = { lastUsage: null };

          const child = spawn(config.binary, [...config.prefixArgs, ...args], {
            cwd: workCwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          });
          activeChild = child;

          child.on('error', (err) => {
            childError = err;
          });
          child.stderr.setEncoding('utf8');
          child.stderr.on('data', (chunk) => {
            turnStderr = (turnStderr + chunk).slice(-config.maxStderr);
          });

          const mapper = createTurnEventMapper({
            runId: `agy-shim-${randomUUID()}`,
            model,
            onTools: (tools) => {
              toolsFromInit = tools;
            },
            onEvent: (ev) => emitSdkEvent(ev, mapper, false, nonPooledState),
            maxNdjsonLine: config.maxNdjsonLine,
            extraSecrets: [config.token]
          });

          let mapperError = null;
          const rlOut = createInterface({ input: child.stdout, crlfDelay: Infinity });
          try {
            for await (const line of rlOut) {
              try {
                mapper.processLine(line);
              } catch (err) {
                mapperError = err;
                killProcessTree(child);
                break;
              }
            }
          } finally {
            rlOut.close();
          }

          const exitInfo = await new Promise((resolveExit) => {
            if (childError || child.exitCode !== null || child.signalCode !== null) {
              resolveExit({ code: child.exitCode ?? 1, signal: child.signalCode });
              return;
            }
            const finish = (code, signal) => resolveExit({ code, signal });
            child.once('close', finish);
            child.once('error', () => finish(child.exitCode ?? 1, child.signalCode));
          });
          activeChild = null;

          if (turnStderr.trim()) {
            stderr.write(redactSensitive(turnStderr, [config.token]));
          }

          const state = mapper.getState();
          const failure =
            childError ||
            mapperError ||
            (interruptRequested ? new Error('interrupted') : null) ||
            (!state.resultSeen ? new Error('agy exited without a terminal result') : null) ||
            (exitInfo.code !== 0 ? new Error(`agy process exited with code ${exitInfo.code}`) : null) ||
            (!state.success ? new Error('agy did not complete successfully') : null);

          finalState = state;
          finalLastUsage = nonPooledState.lastUsage;
          finalFailure = failure;

          if (!failure) {
            finalClassified = null;
            break;
          }

          finalClassified = classifyAgyError(failure.message, turnStderr, exitInfo.code ?? 1, [config.token]);
          if (
            finalClassified.code === 'rate_limited' &&
            !interruptRequested &&
            state.settledToolCount === 0 &&
            attempt < config.rateLimitMaxRetries
          ) {
            await new Promise((r) => setTimeout(r, config.rateLimitRetryDelayMs * (attempt + 1)));
            continue;
          }
          break;
        }
      }

      const sessionId = finalState?.sessionId || fallbackSessionId;
      emitInitIfNeeded(sessionId);

      if (finalFailure) {
        writeJsonLine({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          errors: [{ message: finalClassified?.reason || 'agy error' }],
          duration_ms: Date.now() - startedAt,
          num_turns: 1,
          session_id: sessionId
        });
        return;
      }

      systemPromptDelivered = true;
      if (!parsed.noSessionPersistence && finalState.sessionId) {
        activeResumeId = finalState.sessionId;
      }

      const activeModelKey = model || 'agy';
      const usageOut = finalLastUsage || {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      };

      writeJsonLine({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: finalState.output,
        duration_ms: Date.now() - startedAt,
        num_turns: 1,
        session_id: sessionId,
        usage: usageOut,
        modelUsage: {
          [activeModelKey]: {
            inputTokens: usageOut.input_tokens,
            outputTokens: usageOut.output_tokens,
            cacheCreationInputTokens: usageOut.cache_creation_input_tokens,
            cacheReadInputTokens: usageOut.cache_read_input_tokens,
            contextWindow: 200_000
          }
        }
      });
    } catch (err) {
      activeChild = null;
      emitInitIfNeeded(fallbackSessionId);
      const classified = classifyAgyError(err?.message || err, '', 1, [config.token]);
      writeJsonLine({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [{ message: classified.reason }],
        duration_ms: Date.now() - startedAt,
        num_turns: 1,
        session_id: fallbackSessionId
      });
    }
  }

  async function handleControlRequest(frame) {
    const requestId = frame.request_id;
    const req = frame.request && typeof frame.request === 'object' ? frame.request : {};
    const subtype = String(req.subtype || '');

    try {
      let response = {};
      if (subtype === 'initialize') {
        if (typeof req.systemPrompt === 'string') {
          systemPromptText = req.systemPrompt;
        } else if (Array.isArray(req.systemPrompt)) {
          systemPromptText = req.systemPrompt.filter((s) => typeof s === 'string').join('\n\n');
        }
        if (typeof req.appendSystemPrompt === 'string') {
          appendSystemPromptText = req.appendSystemPrompt;
        }
        if (req.jsonSchema && !activeJsonSchema) {
          activeJsonSchema = typeof req.jsonSchema === 'string' ? req.jsonSchema : JSON.stringify(req.jsonSchema);
        }
        let models = [];
        try {
          models = await cliProbe.getModels(false);
        } catch {
          models = [];
        }
        response = { models, commands: [], agents: [], account: null };
      } else if (subtype === 'mcp_status') {
        const mcpServers = [];
        for (const [name, entry] of Object.entries(activeMcpServers)) {
          if (!entry?.url) continue;
          const status = await probeZoteroMcp({ url: entry.url, headers: entry.headers || {} });
          mcpServers.push({
            name,
            status: status.connected ? 'connected' : 'failed',
            ...(status.protocolVersion ? { serverInfo: { protocolVersion: status.protocolVersion } } : {}),
            ...(status.error ? { error: status.error } : {}),
            config: { url: entry.url },
            tools: status.tools
          });
        }
        response = { mcpServers };
      } else if (subtype === 'mcp_set_servers') {
        const nextServers = req.servers && typeof req.servers === 'object' ? req.servers : {};
        activeMcpServers = Object.fromEntries(
          Object.entries(nextServers).filter(([, cfg]) => cfg && typeof cfg === 'object' && (cfg.url || cfg.serverUrl))
        );
        response = { added: Object.keys(activeMcpServers), removed: [], errors: {} };
      } else if (subtype === 'set_model') {
        activeModel = String(req.model || '').trim();
        response = {};
      } else if (subtype === 'set_permission_mode') {
        activePermissionMode = String(req.mode || 'default').trim();
        response = {};
      } else if (subtype === 'get_context_usage') {
        response = { totalTokens: lastContextTokens, maxTokens: 200_000 };
      } else if (subtype === 'interrupt') {
        interruptRequested = true;
        if (activeChild) killProcessTree(activeChild);
        closeWarmRuntime();
        response = {};
      }

      writeJsonLine({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response
        }
      });
    } catch (err) {
      writeJsonLine({
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: redactSensitive(err?.message || err, [config.token])
        }
      });
    }
  }

  // Fallback for one-shot plaintext/prompt invocation if stdin isn't stream-json
  if (parsed.inputFormat !== 'stream-json') {
    const prompt = parsed.promptParts.join(' ').trim();
    if (prompt) {
      await executeTurn(prompt);
    }
    return 0;
  }

  let turnChain = Promise.resolve();
  const rlIn = createInterface({ input: stdin, crlfDelay: Infinity });

  rlIn.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let frame;
    try {
      frame = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (frame?.type === 'control_request') {
      void handleControlRequest(frame);
      return;
    }

    if (frame?.type === 'user') {
      const userText = extractSdkUserText(frame);
      const imageBlocks = extractSdkUserImageBlocks(frame);
      if (!userText.trim() && imageBlocks.length === 0) {
        // SDK metadata probes (supportedModels / supportedCommands / mcpServerStatus) pass prompt: ""
        return;
      }
      turnChain = turnChain.then(() => executeTurn(userText, imageBlocks)).catch((err) => {
        stderr.write(redactSensitive(err?.message || err, [config.token]) + '\n');
      });
    }
  });

  await new Promise((resolveDone) => {
    rlIn.once('close', () => {
      void turnChain.finally(() => {
        closeWarmRuntime();
        resolveDone();
      });
    });
  });

  return 0;
}
