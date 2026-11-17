import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { redactSensitive } from '../security/redact.mjs';

const runFile = promisify(execFile);
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');

/**
 * Infers conservative effort levels and model capability flags from real agy model IDs.
 * Unknown models conservatively report only ['default'].
 */
export function inferModelCapabilities(modelId, displayName = '') {
  const id = str(modelId).trim();
  const lower = id.toLowerCase();

  let supportedEfforts = ['default'];
  let supportsAdaptiveThinking = false;

  if (lower.startsWith('gemini-4-hydrogen')) {
    supportedEfforts = ['default', 'low', 'medium', 'high', 'xhigh'];
    supportsAdaptiveThinking = true;
  } else if (
    lower.startsWith('gemini-4-argon') ||
    lower.startsWith('gemini-3.8-flash') ||
    lower.startsWith('claude-opus-5-5') ||
    lower.startsWith('claude-sonnet-5-5')
  ) {
    supportedEfforts = ['default', 'low', 'medium', 'high'];
    supportsAdaptiveThinking = true;
  }

  const supportedEffortLevels = supportedEfforts.filter((e) => e !== 'default');

  return {
    value: id,
    displayName: str(displayName).trim() || id,
    supportsEffort: supportedEffortLevels.length > 0,
    supportedEffortLevels,
    supportedEfforts,
    supportsFastMode: false,
    supportsAdaptiveThinking,
    supportsAutoMode: false
  };
}

/**
 * Parses output from `agy --output-format json models` or `agy models`.
 * Tolerates leading status lines such as "Fetching available models...".
 */
export function parseModelsStdout(stdout) {
  const raw = str(stdout);
  if (!raw.trim()) return [];

  // 1. Try JSON parsing (tolerating leading status lines like "Fetching available models...")
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const list = record(record(parsed.command).data).models;
      if (Array.isArray(list) && list.length > 0) {
        const mapped = list
          .map((m) => inferModelCapabilities(str(m.id), str(m.label) || str(m.id)))
          .filter((x) => x.value);
        if (mapped.length > 0) {
          return [...new Map(mapped.map((i) => [i.value, i])).values()];
        }
      }
    } catch {
      // Continue checking remaining lines.
    }
  }

  // Fallback JSON slice if multi-line JSON object appears after status lines
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
      const list = record(record(parsed.command).data).models;
      if (Array.isArray(list) && list.length > 0) {
        const mapped = list
          .map((m) => inferModelCapabilities(str(m.id), str(m.label) || str(m.id)))
          .filter((x) => x.value);
        if (mapped.length > 0) {
          return [...new Map(mapped.map((i) => [i.value, i])).values()];
        }
      }
    } catch {
      // Fall through to plaintext line parsing.
    }
  }

  // 2. Plaintext TSV/column parsing, skipping status banners
  const infos = [];
  for (const rawLine of lines) {
    const cleanLine = rawLine.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!cleanLine) continue;
    if (/^(?:fetching|loading|available\s+models|model\s+id|model\s+label|[-=]+)\b/i.test(cleanLine)) {
      continue;
    }

    if (cleanLine.includes('\t')) {
      const [idPart, ...rest] = cleanLine.split('\t');
      const id = idPart.replace(/^(?:[•*\-]\s*)?/, '').trim();
      const label = rest.join(' ').trim();
      if (/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
        infos.push(inferModelCapabilities(id, label || id));
      }
      continue;
    }

    const match = /^(?:[•*\-]\s*)?([a-z0-9][a-z0-9._-]*)\s{2,}(.+)$/i.exec(cleanLine);
    if (match && /[-.\d]/.test(match[1])) {
      infos.push(inferModelCapabilities(match[1], match[2].trim()));
    }
  }

  return [...new Map(infos.map((i) => [i.value, i])).values()];
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probes the local agy CLI for version, models, efforts, and health diagnostics.
 */
export class CliProbe {
  constructor(config) {
    this.config = config;
    this.modelsCache = { at: 0, infos: [], source: 'uninitialized', error: null };
  }

  async getVersion() {
    try {
      const { stdout } = await runFile(
        this.config.binary,
        [...this.config.prefixArgs, '--version'],
        { cwd: this.config.root, timeout: 5000, windowsHide: true }
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async getModels(refresh = false) {
    if (!refresh && this.modelsCache.infos.length > 0 && Date.now() - this.modelsCache.at < 60_000) {
      return this.modelsCache.infos;
    }

    let infos = [];
    let source = 'none';
    let lastErr = null;

    try {
      const { stdout } = await runFile(
        this.config.binary,
        [...this.config.prefixArgs, '--output-format', 'json', 'models'],
        { cwd: this.config.root, timeout: 12_000, maxBuffer: 1_000_000, windowsHide: true }
      );
      infos = parseModelsStdout(stdout);
      if (infos.length > 0) source = 'json';
    } catch (e) {
      lastErr = redactSensitive(e?.message || e, [this.config.token]);
    }

    if (!infos.length) {
      try {
        const { stdout } = await runFile(
          this.config.binary,
          [...this.config.prefixArgs, 'models'],
          { cwd: this.config.root, timeout: 12_000, maxBuffer: 1_000_000, windowsHide: true }
        );
        infos = parseModelsStdout(stdout);
        if (infos.length > 0) source = 'plaintext';
      } catch (e) {
        lastErr = redactSensitive(e?.message || e, [this.config.token]);
        if (!this.modelsCache.infos.length) {
          throw e;
        }
      }
    }

    this.modelsCache = {
      at: Date.now(),
      infos,
      source,
      error: infos.length ? null : lastErr
    };
    return infos;
  }

  async getEfforts(modelId = '') {
    let infos = this.modelsCache.infos;
    if (!infos.length) {
      try {
        infos = await this.getModels(false);
      } catch {
        infos = [];
      }
    }

    const byModel = Object.fromEntries(infos.map((m) => [m.value, m.supportedEfforts]));
    const trimmed = str(modelId).trim();

    if (trimmed) {
      const found = infos.find((m) => m.value === trimmed);
      return {
        model: trimmed,
        efforts: found ? found.supportedEfforts : ['default'],
        verified: false,
        byModel
      };
    }

    const union = new Set(['default']);
    for (const info of infos) {
      for (const level of info.supportedEfforts) {
        union.add(level);
      }
    }
    if (union.size === 1) {
      return {
        efforts: ['default', 'low', 'medium', 'high'],
        verified: false,
        byModel
      };
    }
    return {
      efforts: [...union],
      verified: false,
      byModel
    };
  }

  async checkHealth() {
    const version = await this.getVersion();
    const installed = Boolean(version);
    const isMock = this.config.prefixArgs.some((a) => a.includes('mock-agy'));
    const oauthPath = join(homedir(), '.gemini', 'oauth_creds.json');
    const authCredentialsPresent = isMock ? null : await fileExists(oauthPath);

    return {
      ok: true,
      bridgeAlive: true,
      protocolVersion: 2,
      capabilities: ['local_pdf_paths', 'model_catalog_v1', 'permission_modes_v1', 'structured_completion_v1'],
      bridgeVersion: this.config.bridgeVersion,
      managedBy: 'agy-zotero-bridge',
      agyVersion: version,
      agyInstalled: installed,
      agyAvailable: installed,
      agyAuthenticated: null,
      authStatus: 'unverified',
      diagnostics: {
        binary: this.config.binary,
        authCredentialsPresent,
        modelsCached: this.modelsCache.infos.length,
        modelsSource: this.modelsCache.source,
        note: '--version checks installation only; run an authenticated turn or models query to confirm live credentials'
      },
      ts: Date.now()
    };
  }
}
