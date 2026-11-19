import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { redactSensitive } from '../security/redact.mjs';

const runFile = promisify(execFile);
const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');

const CANONICAL_EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const EXCLUDED_EFFORT_TOKENS = new Set(['default', 'auto', 'none', 'string', 'level', 'levels', 'value', 'effort']);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeEffortTokens(tokens) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(tokens) ? tokens : []) {
    const token = str(raw).trim().toLowerCase();
    if (!token || EXCLUDED_EFFORT_TOKENS.has(token)) continue;
    if (!/^[a-z][a-z0-9_-]{0,15}$/.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function normalizeEffortOrder(discovered = []) {
  const sanitized = sanitizeEffortTokens(discovered);
  if (sanitized.length >= 2 && sanitized.includes('low') && sanitized.includes('high')) {
    const out = [...sanitized];
    for (const c of CANONICAL_EFFORT_ORDER) {
      if (!out.includes(c)) out.push(c);
    }
    return out;
  }
  const out = [...CANONICAL_EFFORT_ORDER];
  for (const token of sanitized) {
    if (!out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * Extracts supported `--effort` levels from `agy --help` output (e.g. `(low|medium|high|xhigh|max)`).
 */
export function parseEffortLevelsFromHelp(helpStdout) {
  const raw = str(helpStdout);
  if (!raw.trim()) return [];
  const discovered = [];
  const seen = new Set();

  for (const line of raw.split(/\r?\n/)) {
    if (!/--effort\b/i.test(line)) continue;
    const parenMatches = [...line.matchAll(/\(([a-z0-9_|,\s/-]+)\)/ig)];
    for (let i = parenMatches.length - 1; i >= 0; i -= 1) {
      const inner = parenMatches[i][1];
      const parts = sanitizeEffortTokens(inner.split(/[|,/\s]+/));
      if (parts.length >= 2 || (parts.length === 1 && /medium|high|low|xhigh|max/i.test(parts[0]))) {
        for (const token of parts) {
          if (!seen.has(token)) {
            seen.add(token);
            discovered.push(token);
          }
        }
        break;
      }
    }
  }
  return discovered;
}

/**
 * Splits a concrete agy variant ID/label (e.g. `gemini-3.8-flash-low` /
 * `Gemini 3.8 Flash (Low)`) into its base model ID, clean display name, and effort level.
 */
export function splitModelVariant(modelId, displayName = '', knownEfforts = CANONICAL_EFFORT_ORDER) {
  const id = str(modelId).trim();
  const rawLabel = str(displayName).trim();
  const tokens = normalizeEffortOrder(knownEfforts)
    .slice()
    .sort((a, b) => b.length - a.length);
  const alt = tokens.map(escapeRegex).join('|');
  const match = alt ? new RegExp(`^(.+)-(${alt})$`, 'i').exec(id) : null;
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
  const labelRe = new RegExp(`\\s*\\((?:${alt})\\)\\s*$`, 'i');
  const strippedLabel = rawLabel.replace(labelRe, '').trim();
  const baseLabel = !strippedLabel || strippedLabel.toLowerCase() === id.toLowerCase() ? baseId : strippedLabel;
  return {
    baseId,
    baseLabel,
    effort,
    rawId: id
  };
}

function isOrchestratorModel(modelId) {
  const lower = str(modelId).trim().toLowerCase();
  return lower === 'gemini-pro-orchestrator' || lower.startsWith('gemini-pro-orchestrator-');
}

function pickEffortForSupportedLevels(modelId, supported, desiredEffort) {
  if (!Array.isArray(supported) || supported.length === 0) {
    return { model: modelId, effort: desiredEffort };
  }
  if (supported.length === 1) {
    return { model: modelId, effort: supported[0] };
  }
  if (!desiredEffort) {
    return { model: modelId, effort: '' };
  }
  if (supported.includes(desiredEffort)) {
    return { model: modelId, effort: desiredEffort };
  }
  if (desiredEffort === 'max' || desiredEffort === 'xhigh') {
    return { model: modelId, effort: supported.at(-1) };
  }
  return {
    model: modelId,
    effort: supported.includes('medium') ? 'medium' : supported[0]
  };
}

/**
 * Infers effort levels and model capability flags from discovered efforts, falling back
 * to offline model family rules only when live discovery metadata is unavailable.
 */
export function inferModelCapabilities(
  modelId,
  displayName = '',
  discoveredEfforts = [],
  knownEfforts = CANONICAL_EFFORT_ORDER
) {
  const effortOrder = normalizeEffortOrder([
    ...(Array.isArray(knownEfforts) ? knownEfforts : []),
    ...(Array.isArray(discoveredEfforts) ? discoveredEfforts : [])
  ]);
  const { baseId, baseLabel, effort } = splitModelVariant(modelId, displayName, effortOrder);
  const lower = baseId.toLowerCase();
  const allowedSet = new Set(effortOrder);

  const discoveredSet = new Set(
    (Array.isArray(discoveredEfforts) ? discoveredEfforts : [])
      .map((e) => str(e).trim().toLowerCase())
      .filter((e) => allowedSet.has(e))
  );
  if (effort && allowedSet.has(effort)) {
    discoveredSet.add(effort);
  }

  let rawLevels = [];
  if (discoveredSet.size > 0) {
    rawLevels = [...discoveredSet];
  } else if (isOrchestratorModel(lower)) {
    rawLevels = [];
  } else if (lower.startsWith('gemini-4-neon') || lower.startsWith('gemini-4-hydrogen')) {
    rawLevels = ['low', 'medium', 'high', 'xhigh'];
  } else if (
    lower.startsWith('gemini-4-argon') ||
    lower.startsWith('gemini-4-carbon') ||
    lower.startsWith('gemini-3.8-flash') ||
    lower.startsWith('claude-opus-5-5') ||
    lower.startsWith('claude-sonnet-5-5')
  ) {
    rawLevels = ['low', 'medium', 'high'];
  } else if (lower.startsWith('gpt-oss-120b')) {
    rawLevels = ['medium'];
  } else {
    rawLevels = [];
  }

  const supportedEffortLevels = [...new Set(rawLevels)]
    .filter((e) => allowedSet.has(e))
    .sort((a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b));
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
 * Resolves a requested (model, effort) pair—supporting live-discovered models, fixed/non-effort
 * models, grouped base IDs, and legacy effort-suffixed IDs—into `--model` and `--effort`.
 */
export function resolveAgyModelAndEffort(
  rawModel,
  rawEffort,
  knownModels = [],
  knownEfforts = CANONICAL_EFFORT_ORDER
) {
  const modelInput = str(rawModel).trim();
  const effortNorm = str(rawEffort).trim().toLowerCase();
  const explicitEffort = !effortNorm || ['default', 'auto', 'none'].includes(effortNorm) ? '' : effortNorm;

  if (!modelInput || modelInput.toLowerCase() === 'default') {
    return { model: '', effort: explicitEffort };
  }

  const effortOrder = normalizeEffortOrder(knownEfforts);
  const { baseId, effort: embeddedEffort } = splitModelVariant(modelInput, '', effortOrder);
  const desiredEffort = explicitEffort || embeddedEffort;

  if (isOrchestratorModel(baseId)) {
    return { model: baseId, effort: '' };
  }

  const knownList = Array.isArray(knownModels) ? knownModels : [];
  const found = knownList.find((m) => str(m?.value).trim().toLowerCase() === baseId.toLowerCase());
  if (found) {
    const resolvedModel = str(found.value).trim() || baseId;
    const foundLevels = Array.isArray(found.supportedEffortLevels) ? found.supportedEffortLevels : [];
    if (found.supportsEffort === false || foundLevels.length === 0) {
      return { model: resolvedModel, effort: '' };
    }
    return pickEffortForSupportedLevels(resolvedModel, foundLevels, desiredEffort);
  }

  const caps = inferModelCapabilities(baseId, '', [], effortOrder);
  const supported = caps.supportedEffortLevels;
  if (supported.length > 0) {
    return pickEffortForSupportedLevels(baseId, supported, desiredEffort);
  }

  if (embeddedEffort) {
    return { model: baseId, effort: desiredEffort };
  }

  return { model: modelInput, effort: explicitEffort };
}

function extractJsonModelsList(parsed) {
  const p = record(parsed);
  const cmdList = record(record(p.command).data).models;
  if (Array.isArray(cmdList) && cmdList.length > 0) return cmdList;
  const dataList = record(p.data).models;
  if (Array.isArray(dataList) && dataList.length > 0) return dataList;
  if (Array.isArray(p.models) && p.models.length > 0) return p.models;
  return [];
}

function extractExplicitJsonEfforts(entry) {
  const e = record(entry);
  const candidates = [];
  const arrayKeys = [
    'efforts',
    'supportedEffortLevels',
    'supported_effort_levels',
    'supportedEfforts',
    'supported_efforts',
    'thinkingLevels',
    'thinking_levels'
  ];
  for (const key of arrayKeys) {
    if (Array.isArray(e[key])) candidates.push(...e[key]);
  }
  if (typeof e.effort === 'string') candidates.push(e.effort);
  if (typeof e.thinking_level === 'string') candidates.push(e.thinking_level);
  return sanitizeEffortTokens(candidates);
}

function groupModelEntries(rawEntries, effortOrder = CANONICAL_EFFORT_ORDER) {
  const groups = new Map();
  for (const entry of rawEntries) {
    const id = str(entry?.id).trim();
    if (!id) continue;
    const label = str(entry?.label).trim() || id;
    const { baseId, baseLabel, effort } = splitModelVariant(id, label, effortOrder);
    if (!baseId) continue;

    let group = groups.get(baseId);
    if (!group) {
      group = {
        baseId,
        baseLabel,
        efforts: new Set(),
        explicitNoEffort: Boolean(entry?.explicitNoEffort)
      };
      groups.set(baseId, group);
    } else {
      if (group.baseLabel === baseId && baseLabel !== baseId) {
        group.baseLabel = baseLabel;
      }
      if (entry?.explicitNoEffort) group.explicitNoEffort = true;
    }
    if (effort && !group.explicitNoEffort) {
      group.efforts.add(effort);
    }
    for (const extra of Array.isArray(entry?.explicitEfforts) ? entry.explicitEfforts : []) {
      if (!group.explicitNoEffort) group.efforts.add(extra);
    }
  }
  return [...groups.values()].map((g) => {
    if (g.explicitNoEffort) {
      return {
        value: g.baseId,
        displayName: g.baseLabel || g.baseId,
        supportsEffort: false,
        supportedEffortLevels: [],
        supportedEfforts: ['default'],
        supportsFastMode: false,
        supportsAdaptiveThinking: false,
        supportsAutoMode: false
      };
    }
    return inferModelCapabilities(g.baseId, g.baseLabel, [...g.efforts], effortOrder);
  });
}

function parseModelsStdoutWithMeta(stdout, { knownEfforts = CANONICAL_EFFORT_ORDER } = {}) {
  const baseOrder = normalizeEffortOrder(knownEfforts);
  const raw = str(stdout);
  if (!raw.trim()) return { infos: [], effortOrder: baseOrder };

  const normalizeJsonList = (list) => {
    const extraEfforts = [];
    const entries = list.map((m) => {
      const explicitEfforts = extractExplicitJsonEfforts(m);
      extraEfforts.push(...explicitEfforts);
      return {
        id: str(m?.id || m?.value).trim(),
        label: str(m?.label || m?.displayName || m?.display_name || m?.name).trim(),
        explicitEfforts,
        explicitNoEffort: m?.supportsEffort === false || m?.supports_effort === false
      };
    });
    const effortOrder = normalizeEffortOrder([...baseOrder, ...extraEfforts]);
    return {
      infos: groupModelEntries(entries, effortOrder),
      effortOrder
    };
  };

  // 1. Try JSON parsing (tolerating leading status lines like "Fetching available models...")
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const list = extractJsonModelsList(parsed);
      if (list.length > 0) {
        const res = normalizeJsonList(list);
        if (res.infos.length > 0) return res;
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
      const list = extractJsonModelsList(parsed);
      if (list.length > 0) {
        const res = normalizeJsonList(list);
        if (res.infos.length > 0) return res;
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

  return {
    infos: groupModelEntries(rawEntries, baseOrder),
    effortOrder: baseOrder
  };
}

/**
 * Parses output from `agy --output-format json models` or `agy models`.
 * Groups thinking-level variant IDs and explicit JSON effort metadata into base models
 * with aggregated `supportedEffortLevels`, tolerating leading banners.
 */
export function parseModelsStdout(stdout, { knownEfforts = CANONICAL_EFFORT_ORDER } = {}) {
  return parseModelsStdoutWithMeta(stdout, { knownEfforts }).infos;
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
 * Checks whether a persisted models-cache.json payload is still fresh and matches
 * the active bridge and agy CLI versions.
 */
export function isDiskModelCacheValid(
  parsed,
  { now = Date.now(), ttlMs = 15 * 60_000, bridgeVersion = '', agyVersion = '' } = {}
) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
  if (!Number.isFinite(parsed.at)) return false;
  const ageMs = now - parsed.at;
  if (ageMs < 0 || ageMs >= ttlMs) return false;
  if (!Array.isArray(parsed.infos) || parsed.infos.length === 0) return false;
  if (str(parsed.bridgeVersion) !== str(bridgeVersion)) return false;
  if (str(agyVersion) && str(parsed.agyVersion) !== str(agyVersion)) return false;
  return true;
}

/**
 * Probes the local agy CLI for version, models, efforts, and health diagnostics.
 */
export class CliProbe {
  constructor(config) {
    this.config = config;
    this.modelsCache = { at: 0, infos: [], source: 'uninitialized', error: null };
    this.knownEffortLevels = [...CANONICAL_EFFORT_ORDER];
    this.helpEffortsDiscovered = false;
    this.liveRefreshPromise = null;
    this.activeRefreshControllers = new Set();
  }

  _isMockBinary() {
    return Array.isArray(this.config.prefixArgs) && this.config.prefixArgs.some((a) => a.includes('mock-agy'));
  }

  _getCacheFilePath() {
    if (this._isMockBinary() || !this.config.stateFile) return '';
    return join(dirname(this.config.stateFile), 'models-cache.json');
  }

  close() {
    for (const controller of this.activeRefreshControllers) {
      try {
        controller.abort();
      } catch {
        // Ignore abort errors on teardown.
      }
    }
    this.activeRefreshControllers.clear();
  }

  async getVersion({ signal } = {}) {
    const prefix = Array.isArray(this.config.prefixArgs) ? this.config.prefixArgs : [];
    try {
      const { stdout } = await runFile(
        this.config.binary,
        [...prefix, '--version'],
        { cwd: tmpdir(), timeout: 5000, windowsHide: true, ...(signal ? { signal } : {}) }
      );
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async getHelpEffortLevels({ force = false, signal } = {}) {
    if (!force && this.helpEffortsDiscovered) {
      return this.knownEffortLevels;
    }
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) return this.knownEffortLevels;
      signal.addEventListener('abort', onParentAbort, { once: true });
    }
    this.activeRefreshControllers.add(controller);
    const prefix = Array.isArray(this.config.prefixArgs) ? this.config.prefixArgs : [];
    try {
      const { stdout } = await runFile(
        this.config.binary,
        [...prefix, '--help'],
        { cwd: tmpdir(), timeout: 5000, windowsHide: true, signal: controller.signal }
      );
      const parsed = parseEffortLevelsFromHelp(stdout);
      if (parsed.length > 0) {
        this.knownEffortLevels = normalizeEffortOrder(parsed);
      }
      this.helpEffortsDiscovered = true;
    } catch {
      // Keep current knownEffortLevels if --help fails or is aborted.
    } finally {
      if (signal) signal.removeEventListener('abort', onParentAbort);
      this.activeRefreshControllers.delete(controller);
    }
    return this.knownEffortLevels;
  }

  async hydrateDiskCache({ allowBackgroundRefresh = true } = {}) {
    if (this.modelsCache.infos.length > 0) return this.modelsCache.infos;
    const cacheFile = this._getCacheFilePath();
    if (!cacheFile) return [];

    const ttlMs = Number.isFinite(this.config.modelsCacheTtlMs) ? this.config.modelsCacheTtlMs : 15 * 60_000;
    const revalidateMs = Number.isFinite(this.config.modelsCacheRevalidateMs)
      ? this.config.modelsCacheRevalidateMs
      : 2 * 60_000;

    try {
      const raw = await readFile(cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.infos) || parsed.infos.length === 0) {
        return [];
      }
      if (Array.isArray(parsed.effortLevels) && parsed.effortLevels.length > 0) {
        this.knownEffortLevels = normalizeEffortOrder(parsed.effortLevels);
      }
      const now = Date.now();
      const validFresh = isDiskModelCacheValid(parsed, {
        now,
        ttlMs,
        bridgeVersion: this.config.bridgeVersion || '',
        agyVersion: ''
      });
      this.modelsCache = {
        at: validFresh ? parsed.at : 0,
        infos: parsed.infos,
        source: validFresh ? parsed.source || 'disk-cache' : 'stale-disk-cache',
        error: null
      };
      if (allowBackgroundRefresh && (!validFresh || (revalidateMs > 0 && now - parsed.at >= revalidateMs))) {
        this.refreshInBackground();
      }
      return this.modelsCache.infos;
    } catch {
      return [];
    }
  }

  refreshInBackground() {
    if (this._isMockBinary() || this.liveRefreshPromise) return null;
    return this._runLiveDiscovery({ forceHelp: true }).catch(() => {});
  }

  _runLiveDiscovery({ forceHelp = true, staleDiskFallback = [], prefetchedAgyVersion = '' } = {}) {
    if (this.liveRefreshPromise) {
      return this.liveRefreshPromise;
    }

    const prefix = Array.isArray(this.config.prefixArgs) ? this.config.prefixArgs : [];
    const runPromise = (async () => {
      const controller = new AbortController();
      this.activeRefreshControllers.add(controller);
      try {
        const helpEfforts = await this.getHelpEffortLevels({ force: forceHelp, signal: controller.signal });
        let infos = [];
        let source = 'none';
        let lastErr = null;
        let discoveredEfforts = [...helpEfforts];

        try {
          const { stdout } = await runFile(
            this.config.binary,
            [...prefix, '--output-format', 'json', 'models'],
            { cwd: tmpdir(), timeout: 12_000, maxBuffer: 1_000_000, windowsHide: true, signal: controller.signal }
          );
          const parsed = parseModelsStdoutWithMeta(stdout, { knownEfforts: helpEfforts });
          infos = parsed.infos;
          discoveredEfforts = parsed.effortOrder;
          if (infos.length > 0) source = 'json';
        } catch (e) {
          if (controller.signal.aborted) throw e;
          lastErr = redactSensitive(e?.message || e, [this.config.token]);
        }

        if (!infos.length) {
          try {
            const { stdout } = await runFile(
              this.config.binary,
              [...prefix, 'models'],
              { cwd: tmpdir(), timeout: 12_000, maxBuffer: 1_000_000, windowsHide: true, signal: controller.signal }
            );
            const parsed = parseModelsStdoutWithMeta(stdout, { knownEfforts: helpEfforts });
            infos = parsed.infos;
            discoveredEfforts = parsed.effortOrder;
            if (infos.length > 0) source = 'plaintext';
          } catch (e) {
            if (controller.signal.aborted) throw e;
            lastErr = redactSensitive(e?.message || e, [this.config.token]);
            if (staleDiskFallback.length > 0) {
              infos = staleDiskFallback;
              source = 'stale-disk-cache';
            } else if (!this.modelsCache.infos.length) {
              throw e;
            }
          }
        }

        if (!infos.length && staleDiskFallback.length > 0) {
          infos = staleDiskFallback;
          source = 'stale-disk-cache';
        } else if (!infos.length && this.modelsCache.infos.length > 0 && lastErr) {
          infos = this.modelsCache.infos;
          source = this.modelsCache.source || 'stale-memory-cache';
        }

        if (discoveredEfforts.length > 0) {
          this.knownEffortLevels = discoveredEfforts;
        }

        const now = Date.now();
        const isStaleFallback = source === 'stale-disk-cache' || source === 'stale-memory-cache';
        this.modelsCache = {
          at: isStaleFallback ? 0 : now,
          infos,
          source,
          error: infos.length && !isStaleFallback ? null : lastErr
        };

        const cacheFile = this._getCacheFilePath();
        if (cacheFile && infos.length > 0 && !isStaleFallback) {
          try {
            const agyVersion = prefetchedAgyVersion || (await this.getVersion({ signal: controller.signal })) || '';
            await mkdir(dirname(cacheFile), { recursive: true });
            await writeFile(
              cacheFile,
              JSON.stringify({
                at: now,
                bridgeVersion: this.config.bridgeVersion || '',
                agyVersion,
                effortLevels: this.knownEffortLevels,
                source,
                infos
              }),
              'utf8'
            );
          } catch {
            // Best-effort disk caching only.
          }
        }

        return infos;
      } finally {
        this.activeRefreshControllers.delete(controller);
        if (this.liveRefreshPromise === runPromise) {
          this.liveRefreshPromise = null;
        }
      }
    })();

    this.liveRefreshPromise = runPromise;
    return runPromise;
  }

  async getModels(refresh = false, { allowBackgroundRefresh = true } = {}) {
    const ttlMs = Number.isFinite(this.config.modelsCacheTtlMs) ? this.config.modelsCacheTtlMs : 15 * 60_000;
    const revalidateMs = Number.isFinite(this.config.modelsCacheRevalidateMs)
      ? this.config.modelsCacheRevalidateMs
      : 2 * 60_000;
    const isMock = this._isMockBinary();
    const now = Date.now();

    if (
      !refresh &&
      ttlMs > 0 &&
      this.modelsCache.infos.length > 0 &&
      this.modelsCache.at > 0 &&
      now - this.modelsCache.at < ttlMs
    ) {
      if (allowBackgroundRefresh && !isMock && revalidateMs > 0 && now - this.modelsCache.at >= revalidateMs) {
        this.refreshInBackground();
      }
      return this.modelsCache.infos;
    }

    const cacheFile = this._getCacheFilePath();
    let staleDiskFallback = [];
    let currentAgyVersion = '';

    if (!refresh && cacheFile && (this.modelsCache.infos.length === 0 || this.modelsCache.at === 0)) {
      try {
        const raw = await readFile(cacheFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.infos) && parsed.infos.length > 0) {
          staleDiskFallback = parsed.infos;
          if (Array.isArray(parsed.effortLevels) && parsed.effortLevels.length > 0) {
            this.knownEffortLevels = normalizeEffortOrder(parsed.effortLevels);
          }
          currentAgyVersion = (await this.getVersion()) || '';
          if (
            isDiskModelCacheValid(parsed, {
              now: Date.now(),
              ttlMs,
              bridgeVersion: this.config.bridgeVersion || '',
              agyVersion: currentAgyVersion
            })
          ) {
            this.modelsCache = {
              at: parsed.at,
              infos: parsed.infos,
              source: parsed.source || 'disk-cache',
              error: null
            };
            if (allowBackgroundRefresh && !isMock && revalidateMs > 0 && Date.now() - parsed.at >= revalidateMs) {
              this.refreshInBackground();
            }
            return parsed.infos;
          }
        }
      } catch {
        // Ignore missing/invalid disk cache and run live discovery below.
      }
    }

    return await this._runLiveDiscovery({
      forceHelp: true,
      staleDiskFallback,
      prefetchedAgyVersion: currentAgyVersion
    });
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
      const normalizedModel = splitModelVariant(trimmed, '', this.knownEffortLevels).baseId;
      const found = infos.find((m) => m.value.toLowerCase() === normalizedModel.toLowerCase());
      const resolved = found || inferModelCapabilities(normalizedModel, '', [], this.knownEffortLevels);
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
    const isMock = this._isMockBinary();
    const oauthPath = join(homedir(), '.gemini', 'oauth_creds.json');
    const authCredentialsPresent = isMock ? null : await fileExists(oauthPath);

    return {
      ok: true,
      bridgeAlive: true,
      protocolVersion: 2,
      capabilities: ['embeddings_v1', 'local_pdf_paths', 'model_catalog_v1', 'permission_modes_v1', 'structured_completion_v1'],
      bridgeVersion: this.config.bridgeVersion,
      managedBy: this.config.managedBy || 'agy-zotero-bridge',
      agyVersion: version,
      agyInstalled: installed,
      agyAvailable: installed,
      agyAuthenticated: null,
      authStatus: 'unverified',
      embeddings: {
        enabled: true,
        provider: this.config.embeddingProvider,
        model: this.config.embeddingModel,
        dimensions: this.config.embeddingDimensions,
        endpoint: '/v1/embeddings'
      },
      processPool: {
        enabled: this.config.processPoolEnabled,
        maxSize: this.config.poolMaxSize,
        idleTtlMs: this.config.poolIdleTtlMs,
        maxTurnsPerProcess: this.config.poolMaxTurnsPerProcess,
        maxProcessAgeMs: this.config.poolMaxProcessAgeMs
      },
      diagnostics: {
        binary: this.config.binary,
        authCredentialsPresent,
        modelsCached: this.modelsCache.infos.length,
        modelsSource: this.modelsCache.source,
        modelsCacheAgeMs: this.modelsCache.at > 0 ? Math.max(0, Date.now() - this.modelsCache.at) : null,
        knownEffortLevels: this.knownEffortLevels,
        note: '--version checks installation only; run an authenticated turn or models query to confirm live credentials'
      },
      ts: Date.now()
    };
  }
}
