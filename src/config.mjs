import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const BRIDGE_VERSION = 'agy-v1.1.0';

function parseStringArrayEnv(raw, envName) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${envName} must be valid JSON array of strings`);
  }
  if (!Array.isArray(parsed) || !parsed.every((a) => typeof a === 'string')) {
    throw new Error(`${envName} must contain strings`);
  }
  return parsed;
}

export function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

/**
 * Resolves the agy executable path, checking standard Windows location when AGY_BIN is unset.
 */
export function resolveAgyBinary(env = process.env) {
  const explicit = typeof env.AGY_BIN === 'string' ? env.AGY_BIN.trim() : '';
  if (explicit) return explicit;

  if (process.platform === 'win32') {
    const candidate = join(homedir(), '.gemini', 'bin', 'agy.exe');
    try {
      accessSync(candidate, constants.F_OK);
      return candidate;
    } catch {
      // Fallback to PATH resolution below.
    }
  }
  return 'agy';
}

function expandHomePath(rawPath) {
  const raw = String(rawPath || '').trim();
  if (!raw) return '';
  if (raw === '~') return resolve(homedir());
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return resolve(homedir(), raw.slice(2));
  return resolve(raw);
}

function parseDirectoryCsv(raw) {
  if (!raw || !String(raw).trim()) return [];
  return String(raw)
    .split(',')
    .map((entry) => expandHomePath(entry))
    .filter(Boolean);
}

function parseBoolFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const norm = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(norm)) return true;
  if (['0', 'false', 'no', 'off'].includes(norm)) return false;
  return fallback;
}

/**
 * Parses managed-bridge CLI flags (`--host`, `--port`, `--zotero-root`, etc.).
 */
export function parseBridgeCliArgs(argv = []) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = String(argv[i] ?? '');
    if (!raw.startsWith('--')) continue;
    const eqIdx = raw.indexOf('=');
    const flag = eqIdx > 0 ? raw.slice(0, eqIdx) : raw;
    const inlineVal = eqIdx > 0 ? raw.slice(eqIdx + 1) : undefined;

    const takeVal = () => {
      if (inlineVal !== undefined) return inlineVal;
      if (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) {
        i += 1;
        return String(argv[i] ?? '');
      }
      return undefined;
    };

    switch (flag) {
      case '--host':
        out.host = takeVal();
        break;
      case '--port':
        out.port = takeVal();
        break;
      case '--zotero-root':
        out.zoteroRoot = takeVal();
        break;
      case '--runtime-cwd':
        out.runtimeCwd = takeVal();
        break;
      case '--state-dir':
        out.stateDir = takeVal();
        break;
      case '--additional-directories':
        out.additionalDirectories = takeVal();
        break;
      case '--managed-by':
        out.managedBy = takeVal();
        break;
      case '--exit-on-stdin-close':
        out.exitOnStdinClose = takeVal() ?? '1';
        break;
      default:
        // Consume value for compatible managed flags (e.g. --claude-path, --log-file, --setting-sources)
        takeVal();
        break;
    }
  }
  return out;
}

/**
 * Creates validated runtime configuration from environment variables and CLI flags.
 */
export function createConfig(env = process.env, argv = []) {
  const cli = Array.isArray(argv) && argv.length > 0 ? parseBridgeCliArgs(argv) : {};

  const host = (cli.host || env.AGY_BRIDGE_HOST || env.ADAPTER_HOST || '127.0.0.1').trim();
  const allowRemote = env.AGY_ALLOW_REMOTE === '1';
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error(`Refusing to bind to non-loopback host "${host}" without AGY_ALLOW_REMOTE=1`);
  }

  const portRaw = cli.port ?? env.AGY_BRIDGE_PORT ?? env.ADAPTER_PORT ?? '8765';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid AGY_BRIDGE_PORT: ${portRaw}`);
  }

  const zoteroRootRaw = String(cli.zoteroRoot || env.ZOTERO_ROOT || '').trim();
  const zoteroRoot = zoteroRootRaw ? expandHomePath(zoteroRootRaw) : '';

  const binary = resolveAgyBinary(env);
  const prefixArgs = parseStringArrayEnv(env.AGY_PREFIX_ARGS_JSON, 'AGY_PREFIX_ARGS_JSON');
  const cliExtraDirs = parseDirectoryCsv(cli.additionalDirectories || env.ADAPTER_ADDITIONAL_DIRECTORIES);
  const envExtraDirs = parseStringArrayEnv(env.AGY_EXTRA_DIRS_JSON, 'AGY_EXTRA_DIRS_JSON').map((d) => expandHomePath(d));
  const extraDirs = [...new Set([...(zoteroRoot ? [zoteroRoot] : []), ...envExtraDirs, ...cliExtraDirs])];
  const allowedPdfRoots = parseStringArrayEnv(env.AGY_ALLOWED_PDF_ROOTS_JSON, 'AGY_ALLOWED_PDF_ROOTS_JSON').map((d) =>
    resolve(d)
  );

  const root = expandHomePath(
    cli.runtimeCwd || env.AGY_CWD || env.ADAPTER_RUNTIME_CWD || (zoteroRoot ? join(zoteroRoot, 'agent-runtime') : process.cwd())
  );
  const stateDirRaw = String(
    cli.stateDir || env.ADAPTER_STATE_DIR || (zoteroRoot ? join(zoteroRoot, 'agent-state') : '')
  ).trim();
  const stateFile = expandHomePath(
    env.AGY_BRIDGE_STATE || (stateDirRaw ? join(stateDirRaw, 'sessions.json') : join(homedir(), '.agy-zotero-bridge', 'sessions.json'))
  );

  return {
    bridgeVersion: BRIDGE_VERSION,
    managedBy: String(cli.managedBy || env.ADAPTER_MANAGED_BY || '').trim(),
    exitOnStdinClose: parseBoolFlag(cli.exitOnStdinClose ?? env.ADAPTER_EXIT_ON_STDIN_CLOSE, false),
    host,
    port,
    allowRemote,
    binary,
    prefixArgs,
    root,
    stateFile,
    token: env.AGY_BRIDGE_TOKEN || env.ADAPTER_AUTH_TOKEN || '',
    allowYolo: env.AGY_ALLOW_YOLO === '1',
    defaultModel: env.AGY_DEFAULT_MODEL || '',
    defaultEffort: env.AGY_DEFAULT_EFFORT || '',
    modelsCacheTtlMs: Math.max(0, Number(env.AGY_MODELS_CACHE_TTL_MS ?? 15 * 60 * 1000)),
    modelsCacheRevalidateMs: Math.max(0, Number(env.AGY_MODELS_REVALIDATE_MS ?? 2 * 60 * 1000)),
    defaultPermissionMode: env.AGY_PERMISSION_MODE || 'default',
    systemPromptFile: env.AGY_SYSTEM_PROMPT_FILE || '',
    skillsDir: env.AGY_SKILLS_DIR || '',
    enableSkills: env.AGY_ENABLE_SKILLS !== '0',
    extraDirs,
    allowedPdfRoots,
    zoteroMcpUrl: env.ZOTERO_MCP_URL || 'http://127.0.0.1:23119/llm-for-zotero/mcp',
    zoteroMcpToken: env.ZOTERO_MCP_TOKEN || '',
    zoteroMcpEnabled: env.AGY_ZOTERO_MCP_ENABLED === '1',
    zoteroMcpAllowWrite: env.AGY_ZOTERO_MCP_ALLOW_WRITE !== '0',
    processPoolEnabled: env.AGY_PROCESS_POOL !== '0',
    processPoolAlways: env.AGY_PROCESS_POOL === '1',
    poolMaxSize: Math.max(1, Number(env.AGY_POOL_MAX_SIZE || 4)),
    poolIdleTtlMs: Math.max(5000, Number(env.AGY_POOL_IDLE_TTL_MS || 300_000)),
    poolMaxTurnsPerProcess: Math.max(1, Number(env.AGY_POOL_MAX_TURNS || 20)),
    poolMaxProcessAgeMs: Math.max(10_000, Number(env.AGY_POOL_MAX_AGE_MS || 45 * 60 * 1000)),
    maxPrompt: 600_000,
    maxBody: 4_000_000,
    maxNdjsonLine: 2_000_000,
    maxStderr: 20_000,
    defaultTurnTimeoutMs: Number(env.AGY_TURN_TIMEOUT_MS || 30 * 60 * 1000),
    defaultStructuredTimeoutMs: Number(env.AGY_STRUCTURED_TIMEOUT_MS || 120_000),
    rateLimitMaxRetries: Math.max(0, Math.min(3, Number(env.AGY_RATE_LIMIT_MAX_RETRIES ?? 1))),
    rateLimitRetryDelayMs: Math.max(50, Math.min(30_000, Number(env.AGY_RATE_LIMIT_RETRY_DELAY_MS ?? 1500))),
    embeddingProvider: String(env.AGY_EMBEDDING_PROVIDER || 'auto').trim().toLowerCase(),
    embeddingApiBase: String(env.AGY_EMBEDDING_API_BASE || '').trim().replace(/\/+$/, ''),
    embeddingApiKey: String(env.AGY_EMBEDDING_API_KEY || '').trim(),
    embeddingModel: String(env.AGY_EMBEDDING_MODEL || 'agy-local-ngram-v1').trim(),
    embeddingDimensions: Math.max(16, Math.min(4096, Number(env.AGY_EMBEDDING_DIMENSIONS || 256))),
    embeddingBatchSize: Math.max(1, Math.min(256, Number(env.AGY_EMBEDDING_BATCH_SIZE || 32))),
    embeddingCacheFile: expandHomePath(
      env.AGY_EMBEDDING_CACHE_FILE || join(dirname(stateFile), 'embeddings-cache.json')
    ),
    embeddingCacheMaxEntries: Math.max(64, Math.min(20_000, Number(env.AGY_EMBEDDING_CACHE_MAX_ENTRIES || 2048)))
  };
}
