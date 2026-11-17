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

const CANONICAL_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Splits a concrete agy variant ID/label (e.g. `gemini-3.8-flash-low` /
 * `Gemini 3.8 Flash (Low)`) into its base model ID, clean display name, and effort level.
 */
export function splitModelVariant(modelId, displayName = '') {
  const id = str(modelId).trim();
  const rawLabel = str(displayName).trim();
  const match = /^(.+)-(low|medium|high|xhigh|max)$/i.exec(id);
  if (!match) {
    return {
      baseId: id,
      baseLabel: rawLabel || id,
      effort: '',
      rawId: id
    };
  }

  const baseId = match[1];
  const effort = match[2].toLowerCase();
  const strippedLabel = rawLabel.replace(/\s*\((?:low|medium|high|xhigh|max)\)\s*$/i, '').trim();
  const baseLabel = !strippedLabel || strippedLabel.toLowerCase() === id.toLowerCase() ? baseId : strippedLabel;
  return {
    baseId,
    baseLabel,
    effort,
    rawId: id
  };
}

/**
 * Infers conservative effort levels and model capability flags from real agy model IDs.
 * Unknown models conservatively report only ['default'].
 */
export function inferModelCapabilities(modelId, displayName = '', discoveredEfforts = []) {
  const { baseId, baseLabel, effort } = splitModelVariant(modelId, displayName);
  const lower = baseId.toLowerCase();

  const discoveredSet = new Set(
    (Array.isArray(discoveredEfforts) ? discoveredEfforts : [])
      .map((e) => str(e).trim().toLowerCase())
      .filter((e) => CANONICAL_EFFORT_ORDER.includes(e))
  );
  if (effort && CANONICAL_EFFORT_ORDER.includes(effort)) {
    discoveredSet.add(effort);
  }

  let rawLevels = [];
  if (Array.isArray(discoveredEfforts) && discoveredEfforts.length > 0) {
    rawLevels = [...discoveredSet];
  } else if (lower.startsWith('gemini-4-hydrogen')) {
    rawLevels = [...new Set(['low', 'medium', 'high', 'xhigh', ...discoveredSet])];
  } else if (
    lower.startsWith('gemini-4-argon') ||
    lower.startsWith('gemini-3.8-flash') ||
    lower.startsWith('claude-opus-5-5') ||
    lower.startsWith('claude-sonnet-5-5')
  ) {
    rawLevels = [...new Set(['low', 'medium', 'high', ...discoveredSet])];
  } else if (lower.startsWith('gpt-oss-120b')) {
    rawLevels = ['medium'];
  } else {
    rawLevels = [...discoveredSet];
  }

  const supportedEffortLevels = [...new Set(rawLevels)]
    .filter((e) => CANONICAL_EFFORT_ORDER.includes(e))
    .sort((a, b) => CANONICAL_EFFORT_ORDER.indexOf(a) - CANONICAL_EFFORT_ORDER.indexOf(b));
  const supportedEfforts = ['default', ...supportedEffortLevels];

  return {
    value: baseId,
    displayName: baseLabel || baseId,
    supportsEffort: supportedEffortLevels.length > 0,
    supportedEffortLevels,
    supportedEfforts,
    supportsFastMode: false,
    supportsAdaptiveThinking: supportedEffortLevels.length > 1,
    supportsAutoMode: false
  };
}

/**
 * Resolves a requested (model, effort) pair—supporting both grouped base IDs and legacy
 * effort-suffixed IDs—into normalized `--model` and `--effort` CLI values.
 */
export function resolveAgyModelAndEffort(rawModel, rawEffort) {
  const modelInput = str(rawModel).trim();
  const effortNorm = str(rawEffort).trim().toLowerCase();
  const explicitEffort = !effortNorm || ['default', 'auto', 'none'].includes(effortNorm) ? '' : effortNorm;

  if (!modelInput || modelInput.toLowerCase() === 'default') {
    return { model: '', effort: explicitEffort };
  }

  const { baseId, effort: embeddedEffort } = splitModelVariant(modelInput);
  const desiredEffort = explicitEffort || embeddedEffort;
  const caps = inferModelCapabilities(baseId);
  const supported = caps.supportedEffortLevels;

  if (baseId.toLowerCase() === 'gemini-pro-orchestrator-g1-pro') {
    return { model: baseId, effort: '' };
  }

  if (supported.length === 1) {
    return { model: baseId, effort: supported[0] };
  }

  if (supported.length > 1) {
    if (!desiredEffort) {
      return { model: baseId, effort: '' };
    }
    if (supported.includes(desiredEffort)) {
      return { model: baseId, effort: desiredEffort };
    }
    if (desiredEffort === 'max' || desiredEffort === 'xhigh') {
      return { model: baseId, effort: supported.at(-1) };
    }
    return {
      model: baseId,
      effort: supported.includes('medium') ? 'medium' : supported[0]
    };
  }

  return { model: modelInput, effort: explicitEffort };
}

function groupModelEntries(rawEntries) {
  const groups = new Map();
  for (const entry of rawEntries) {
    const id = str(entry?.id).trim();
    if (!id) continue;
    const label = str(entry?.label).trim() || id;
    const { baseId, baseLabel, effort } = splitModelVariant(id, label);
    if (!baseId) continue;

    let group = groups.get(baseId);
    if (!group) {
      group = { baseId, baseLabel, efforts: new Set() };
      groups.set(baseId, group);
    } else if (group.baseLabel === baseId && baseLabel !== baseId) {
      group.baseLabel = baseLabel;
    }
    if (effort) {
      group.efforts.add(effort);
    }
  }
  return [...groups.values()].map((g) => inferModelCapabilities(g.baseId, g.baseLabel, [...g.efforts]));
}

/**
 * Parses output from `agy --output-format json models` or `agy models`.
 * Groups thinking-level variant IDs (e.g. `-low`/`-medium`/`-high`/`-xhigh`) into
 * base models with aggregated `supportedEffortLevels` and tolerates leading banners.
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
        const grouped = groupModelEntries(list.map((m) => ({ id: str(m?.id), label: str(m?.label) || str(m?.id) })));
        if (grouped.length > 0) return grouped;
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
        const grouped = groupModelEntries(list.map((m) => ({ id: str(m?.id), label: str(m?.label) || str(m?.id) })));
        if (grouped.length > 0) return grouped;
      }
    } catch {
      // Fall through to plaintext line parsing.
    }
  }

  // 2. Plaintext TSV/column parsing, skipping status banners
  const rawEntries = [];
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
        rawEntries.push({ id, label: label || id });
      }
      continue;
    }

    const match = /^(?:[•*\-]\s*)?([a-z0-9][a-z0-9._-]*)\s{2,}(.+)$/i.exec(cleanLine);
    if (match && /[-.\d]/.test(match[1])) {
      rawEntries.push({ id: match[1], label: match[2].trim() });
    }
  }

  return groupModelEntries(rawEntries);
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
      const normalizedModel = splitModelVariant(trimmed).baseId;
      const found = infos.find((m) => m.value.toLowerCase() === normalizedModel.toLowerCase());
      const resolved = found || inferModelCapabilities(normalizedModel);
      return {
        model: normalizedModel,
        efforts: resolved.supportedEfforts,
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
