import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, isAbsolute, resolve, sep } from 'node:path';

export const DEFAULT_ALLOWED_EXTENSIONS = Object.freeze([
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.txt',
  '.md'
]);

const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * Scrubs tokens, API keys, auth headers, and sensitive credential paths from text.
 */
export function redactSensitive(input, extraSecrets = []) {
  let out = typeof input === 'string' ? input : String(input ?? '');
  if (!out) return '';

  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 4) {
      out = out.split(secret).join('[REDACTED]');
    }
  }

  // Bearer / Basic auth headers
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [REDACTED]');
  // Common API key formats (Google AIza, OpenAI/Anthropic sk-, GitHub tokens)
  out = out.replace(/\bAIza[0-9A-Za-z_-]{10,}\b/g, '[REDACTED]');
  out = out.replace(/\bsk-(?:ant-|proj-)?[0-9A-Za-z_-]{10,}\b/g, '[REDACTED]');
  out = out.replace(/\bgh[pousr]_[0-9A-Za-z_]{10,}\b/g, '[REDACTED]');
  // Key/value pairs in query strings, headers, or JSON-like logs
  out = out.replace(
    /((?:"|')?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|auth[_-]?token|token|secret|password|cookie|authorization)(?:"|')?\s*[:=]\s*(?:"|')?)([^\s"',;}{]+)((?:"|')?)/gi,
    '$1[REDACTED]$3'
  );
  // Credential file paths
  out = out.replace(
    /[^\s"']*?(?:oauth_creds\.json|google_accounts\.json|credentials\.json)[^\s"']*/gi,
    '[REDACTED_CREDENTIAL_PATH]'
  );
  // User home directory paths (Windows & POSIX)
  out = out.replace(/[A-Za-z]:\\Users\\[^\\/\s"']+/gi, '[USER_HOME]');
  out = out.replace(/\/(?:home|Users)\/[^/\s"']+/g, '[USER_HOME]');

  return out;
}

/**
 * Normalizes path comparison respecting Windows case-insensitivity.
 */
export function isPathWithin(targetPath, rootPath) {
  const norm = (p) => {
    const resolved = resolve(p);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const target = norm(targetPath);
  const root = norm(rootPath);
  if (target === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}

/**
 * Validates that a local file exists, is a readable regular file within allowedRoots,
 * has an allowed extension, and stays under maxBytes. Prevents ../ and symlink escapes.
 */
export async function validateLocalFilePath(filePath, options = {}) {
  const {
    allowedRoots = [],
    allowedExtensions = DEFAULT_ALLOWED_EXTENSIONS,
    maxBytes = DEFAULT_MAX_FILE_BYTES
  } = options;

  if (typeof filePath !== 'string' || !filePath.trim()) {
    return { valid: false, reason: 'empty_path' };
  }
  if (filePath.includes('\0')) {
    return { valid: false, reason: 'null_byte_in_path' };
  }
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    return { valid: false, reason: 'no_allowed_roots_configured' };
  }

  const normalizedRoots = [];
  for (const r of allowedRoots) {
    if (typeof r !== 'string' || !r.trim()) continue;
    try {
      normalizedRoots.push(await realpath(resolve(r)));
    } catch {
      normalizedRoots.push(resolve(r));
    }
  }
  if (normalizedRoots.length === 0) {
    return { valid: false, reason: 'no_valid_allowed_roots' };
  }

  const candidate = isAbsolute(filePath)
    ? resolve(filePath)
    : resolve(normalizedRoots[0], filePath);

  let resolvedPath;
  try {
    resolvedPath = await realpath(candidate);
  } catch (e) {
    return { valid: false, reason: e?.code === 'ENOENT' ? 'file_not_found' : 'path_unresolvable' };
  }

  const allowed = normalizedRoots.some((root) => isPathWithin(resolvedPath, root));
  if (!allowed) {
    return { valid: false, reason: 'path_outside_allowed_roots' };
  }

  const ext = extname(resolvedPath).toLowerCase();
  const extAllowSet = new Set(allowedExtensions.map((e) => e.toLowerCase()));
  if (!extAllowSet.has(ext)) {
    return { valid: false, reason: `disallowed_extension:${ext || 'none'}` };
  }

  let st;
  try {
    st = await stat(resolvedPath);
  } catch {
    return { valid: false, reason: 'stat_failed' };
  }
  if (!st.isFile()) {
    return { valid: false, reason: 'not_a_regular_file' };
  }
  if (st.size > maxBytes) {
    return { valid: false, reason: 'file_too_large' };
  }

  try {
    await access(resolvedPath, constants.R_OK);
  } catch {
    return { valid: false, reason: 'file_not_readable' };
  }

  return { valid: true, resolvedPath, size: st.size, ext };
}
