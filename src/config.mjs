import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const BRIDGE_VERSION = 'agy-v1.0.0';

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

/**
 * Creates validated runtime configuration from environment variables.
 */
export function createConfig(env = process.env) {
  const host = (env.AGY_BRIDGE_HOST || '127.0.0.1').trim();
  const allowRemote = env.AGY_ALLOW_REMOTE === '1';
  if (!isLoopbackHost(host) && !allowRemote) {
    throw new Error(`Refusing to bind to non-loopback host "${host}" without AGY_ALLOW_REMOTE=1`);
  }

  const portRaw = env.AGY_BRIDGE_PORT ?? '8765';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid AGY_BRIDGE_PORT: ${portRaw}`);
  }

  const binary = resolveAgyBinary(env);
  const prefixArgs = parseStringArrayEnv(env.AGY_PREFIX_ARGS_JSON, 'AGY_PREFIX_ARGS_JSON');
  const extraDirs = parseStringArrayEnv(env.AGY_EXTRA_DIRS_JSON, 'AGY_EXTRA_DIRS_JSON').map((d) => resolve(d));
  const allowedPdfRoots = parseStringArrayEnv(env.AGY_ALLOWED_PDF_ROOTS_JSON, 'AGY_ALLOWED_PDF_ROOTS_JSON').map((d) => resolve(d));

  const root = resolve(env.AGY_CWD || process.cwd());
  const stateFile = resolve(env.AGY_BRIDGE_STATE || join(homedir(), '.agy-zotero-bridge', 'sessions.json'));

  return {
    bridgeVersion: BRIDGE_VERSION,
    host,
    port,
    allowRemote,
    binary,
    prefixArgs,
    root,
    stateFile,
    token: env.AGY_BRIDGE_TOKEN || '',
    allowYolo: env.AGY_ALLOW_YOLO === '1',
    defaultModel: env.AGY_DEFAULT_MODEL || '',
    defaultEffort: env.AGY_DEFAULT_EFFORT || '',
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
    processPoolEnabled: env.AGY_PROCESS_POOL === '1',
    poolMaxSize: Math.max(1, Number(env.AGY_POOL_MAX_SIZE || 4)),
    poolIdleTtlMs: Math.max(5000, Number(env.AGY_POOL_IDLE_TTL_MS || 300_000)),
    maxPrompt: 600_000,
    maxBody: 4_000_000,
    maxNdjsonLine: 2_000_000,
    maxStderr: 20_000,
    defaultTurnTimeoutMs: Number(env.AGY_TURN_TIMEOUT_MS || 30 * 60 * 1000),
    defaultStructuredTimeoutMs: Number(env.AGY_STRUCTURED_TIMEOUT_MS || 120_000)
  };
}
