import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BridgeHttpError } from '../agy/process-runner.mjs';
import { redactSensitive } from '../security/redact.mjs';

const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function fnv1aHashPair(token) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + ((i + 1) & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return [h1 >>> 0, h2 >>> 0];
}

function stemAsciiToken(word) {
  let w = word;
  if (w.length > 5 && w.endsWith('ations')) w = `${w.slice(0, -6)}ate`;
  else if (w.length > 5 && w.endsWith('tion')) w = `${w.slice(0, -4)}t`;
  else if (w.length > 4 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

const ASCII_STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into',
  'is', 'of', 'on', 'or', 'that', 'the', 'to', 'via', 'with'
]);

function extractSemanticFeatures(text) {
  const counts = new Map();
  const add = (feat, weight = 1) => {
    counts.set(feat, (counts.get(feat) || 0) + weight);
  };

  const normalized = String(text || '').normalize('NFKC').toLowerCase();
  // Word / scientific alphanumeric tokens + hyphenated subtokens + stemmed forms + character 3/4-grams
  const rawMatches = normalized.match(/[a-z0-9][a-z0-9._+-]*/g) || [];
  const latinTokens = [];
  for (const rawTok of rawMatches) {
    if (rawTok.length < 2 || ASCII_STOPWORDS.has(rawTok)) continue;
    latinTokens.push(rawTok);
    const parts = rawTok.split(/[-_/]+/).filter((p) => p.length >= 2 && !ASCII_STOPWORDS.has(p));
    for (const part of parts) {
      if (part !== rawTok) latinTokens.push(part);
    }
  }

  for (const tok of latinTokens) {
    add(`w:${tok}`, 2.0);
    const stemmed = stemAsciiToken(tok);
    if (stemmed && stemmed !== tok) {
      add(`s:${stemmed}`, 1.6);
    }
    const padded = `^${stemmed || tok}$`;
    if (padded.length >= 4) {
      for (let i = 0; i <= padded.length - 3; i += 1) {
        add(`g3:${padded.slice(i, i + 3)}`, 0.35);
      }
    }
    if (padded.length >= 5) {
      for (let i = 0; i <= padded.length - 4; i += 1) {
        add(`g4:${padded.slice(i, i + 4)}`, 0.45);
      }
    }
  }

  // Word bigrams for adjacent English/scientific concepts
  for (let i = 0; i + 1 < latinTokens.length; i += 1) {
    const a = stemAsciiToken(latinTokens[i]);
    const b = stemAsciiToken(latinTokens[i + 1]);
    if (a.length >= 2 && b.length >= 2 && a !== b) {
      add(`wb:${a}_${b}`, 0.7);
    }
  }

  // CJK unigrams and contiguous bigrams/trigrams
  const cjkChars = [];
  for (const ch of normalized) {
    if (CJK_CHAR_RE.test(ch)) {
      cjkChars.push(ch);
      add(`cu:${ch}`, 0.7);
    } else if (cjkChars.length > 0 && ch.trim()) {
      cjkChars.push(' ');
    }
  }
  const cjkSeq = cjkChars.join('').split(' ').filter(Boolean);
  for (const seg of cjkSeq) {
    for (let i = 0; i + 1 < seg.length; i += 1) {
      add(`cb:${seg.slice(i, i + 2)}`, 1.5);
    }
    for (let i = 0; i + 2 < seg.length; i += 1) {
      add(`ct:${seg.slice(i, i + 3)}`, 1.0);
    }
  }

  return counts;
}

/**
 * Computes a deterministic, L2-normalized multilingual semantic embedding vector
 * via signed feature hashing + sublinear TF weighting (zero external dependencies).
 */
export function computeLocalSemanticEmbedding(text, dimensions = 256) {
  const dims = Math.max(16, Math.min(4096, Math.floor(Number(dimensions) || 256)));
  const vec = new Float64Array(dims);
  const features = extractSemanticFeatures(text);

  for (const [feat, weight] of features.entries()) {
    const tf = (1 + Math.log(Math.max(1, weight))) * Math.min(2.0, Math.sqrt(weight));
    const [h1, h2] = fnv1aHashPair(feat);
    const idx1 = h1 % dims;
    const sign1 = (h2 & 1) === 0 ? 1 : -1;
    vec[idx1] += sign1 * tf;

    const idx2 = (h2 >>> 1) % dims;
    const sign2 = (h1 & 1) === 0 ? 1 : -1;
    vec[idx2] += sign2 * tf * 0.5;
  }

  let normSq = 0;
  for (let i = 0; i < dims; i += 1) {
    normSq += vec[i] * vec[i];
  }
  const norm = Math.sqrt(normSq);
  const out = new Array(dims);
  if (norm > 0) {
    for (let i = 0; i < dims; i += 1) {
      out[i] = Number((vec[i] / norm).toFixed(6));
    }
  } else {
    for (let i = 0; i < dims; i += 1) {
      out[i] = 0;
    }
  }
  return out;
}

/**
 * Computes cosine similarity between two numeric embedding vectors.
 */
export function cosineSimilarity(vecA, vecB) {
  if (!Array.isArray(vecA) || !Array.isArray(vecB) || vecA.length === 0 || vecA.length !== vecB.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i += 1) {
    const a = Number(vecA[i]) || 0;
    const b = Number(vecB[i]) || 0;
    dot += a * b;
    normA += a * a;
    normB += b * b;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

function estimateTokenCount(texts) {
  let chars = 0;
  for (const t of texts) chars += String(t || '').length;
  return Math.max(texts.length, Math.ceil(chars / 4));
}

function extractBearerHeader(authHeader) {
  const raw = String(authHeader || '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  return match ? match[1].trim() : '';
}

function parseUpstreamEmbeddingsPayload(payload, expectedCount) {
  if (Array.isArray(payload?.data)) {
    const items = [...payload.data];
    if (items.every((item) => typeof item?.index === 'number')) {
      items.sort((a, b) => a.index - b.index);
    }
    const vectors = items.map((item) => item?.embedding);
    if (vectors.length === expectedCount && vectors.every((v) => Array.isArray(v))) {
      return vectors;
    }
  }
  if (Array.isArray(payload?.embeddings)) {
    const vectors = payload.embeddings;
    if (vectors.length === expectedCount && vectors.every((v) => Array.isArray(v))) {
      return vectors;
    }
  }
  if (Array.isArray(payload?.embedding) && expectedCount === 1) {
    return [payload.embedding];
  }
  throw new BridgeHttpError(502, 'invalid_upstream_embeddings', 'Upstream embedding response shape invalid');
}

/**
 * OpenAI-compatible Semantic Search embedding service (`POST /v1/embeddings` & `/embeddings`)
 * supporting deterministic zero-dependency local semantic embeddings, upstream OpenAI/Gemini/Ollama
 * forwarding with 429 retry backoff, and bounded LRU disk caching.
 */
export class EmbeddingService {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.cache = new Map();
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      upstreamCalls: 0,
      localCalls: 0,
      rateLimitRetries: 0
    };
  }

  #touchCache(key, vector) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else {
      while (this.cache.size >= (this.config.embeddingCacheMaxEntries || 2048)) {
        const oldestKey = this.cache.keys().next().value;
        if (oldestKey === undefined) break;
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, vector);
  }

  async load() {
    if (!this.config.embeddingCacheFile) return;
    try {
      const raw = await readFile(this.config.embeddingCacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.entries)) {
        for (const item of parsed.entries) {
          if (item && typeof item.key === 'string' && Array.isArray(item.vector)) {
            this.#touchCache(item.key, item.vector);
          }
        }
      }
    } catch {
      // Cache file does not exist or is unreadable; start cleanly empty.
    }
  }

  async save() {
    if (!this.config.embeddingCacheFile) return;
    try {
      await mkdir(dirname(this.config.embeddingCacheFile), { recursive: true });
      const entries = [];
      for (const [key, vector] of this.cache.entries()) {
        entries.push({ key, vector });
      }
      const tempPath = `${this.config.embeddingCacheFile}.tmp.${process.pid}.${Date.now()}`;
      await writeFile(tempPath, JSON.stringify({ version: 1, entries }), 'utf8');
      await rename(tempPath, this.config.embeddingCacheFile);
    } catch {
      // Ignore cache persistence errors silently.
    }
  }

  resolveBackend(requestedModel = '', authHeader = '') {
    const providerPref = String(this.config.embeddingProvider || 'auto').trim().toLowerCase();
    const apiBase = String(this.config.embeddingApiBase || '').trim().replace(/\/+$/, '');
    const apiKey = String(this.config.embeddingApiKey || '').trim() || extractBearerHeader(authHeader);
    const defaultModel = this.config.embeddingModel || 'agy-local-ngram-v1';
    const model = String(requestedModel || '').trim() || defaultModel;

    if (providerPref === 'local' || !apiBase) {
      return {
        mode: 'local',
        provider: 'local',
        model
      };
    }

    return {
      mode: 'upstream',
      provider: providerPref === 'auto' ? 'upstream' : providerPref,
      apiBase,
      apiKey,
      model
    };
  }

  async #fetchUpstreamBatch(batchTexts, backend, dims, signal) {
    const endpoint = backend.apiBase.endsWith('/embeddings')
      ? backend.apiBase
      : `${backend.apiBase}/embeddings`;
    const headers = {
      'Content-Type': 'application/json'
    };
    if (backend.apiKey) {
      headers.Authorization = `Bearer ${backend.apiKey}`;
    }

    const bodyPayload = {
      model: backend.model,
      input: batchTexts,
      ...(dims && this.config.embeddingProvider !== 'ollama' ? { dimensions: dims } : {})
    };

    const maxRetries = Math.max(0, Number(this.config.rateLimitMaxRetries ?? 1));
    const baseDelayMs = Math.max(50, Number(this.config.rateLimitRetryDelayMs ?? 1500));

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        ...(signal ? { signal } : {})
      });

      if (response.status === 429 && attempt < maxRetries) {
        this.stats.rateLimitRetries += 1;
        await new Promise((resolveDelay, rejectDelay) => {
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolveDelay();
          }, baseDelayMs * (attempt + 1));
          const onAbort = () => {
            clearTimeout(timer);
            rejectDelay(new BridgeHttpError(499, 'cancelled', 'cancelled'));
          };
          if (signal?.aborted) {
            onAbort();
          } else {
            signal?.addEventListener('abort', onAbort, { once: true });
          }
        });
        continue;
      }

      if (!response.ok) {
        const errText = redactSensitive(await response.text().catch(() => ''), [
          this.config.token,
          this.config.embeddingApiKey,
          backend.apiKey
        ]);
        throw new BridgeHttpError(
          response.status === 429 ? 429 : 502,
          response.status === 429 ? 'rate_limited' : 'upstream_embedding_error',
          `Upstream embedding error (${response.status}): ${errText.slice(0, 500)}`
        );
      }

      const data = await response.json();
      return parseUpstreamEmbeddingsPayload(data, batchTexts.length);
    }

    throw new BridgeHttpError(429, 'rate_limited', 'Upstream embedding rate limit exceeded');
  }

  async embed({ input, model = '', dimensions = 0, authHeader = '', signal = null } = {}) {
    let rawInputs;
    if (typeof input === 'string') {
      if (!input.trim()) {
        throw new BridgeHttpError(400, 'invalid_embedding_input', 'input must be a non-empty string or array of strings');
      }
      rawInputs = [input];
    } else if (Array.isArray(input) && input.length > 0 && input.every((item) => typeof item === 'string')) {
      rawInputs = input;
    } else {
      throw new BridgeHttpError(400, 'invalid_embedding_input', 'input must be a non-empty string or array of strings');
    }

    const backend = this.resolveBackend(model, authHeader);
    const dims =
      Number.isFinite(Number(dimensions)) && Number(dimensions) > 0
        ? Math.max(16, Math.min(4096, Math.floor(Number(dimensions))))
        : this.config.embeddingDimensions || 256;

    const results = new Array(rawInputs.length);
    const misses = [];

    for (let i = 0; i < rawInputs.length; i += 1) {
      const text = rawInputs[i];
      const cacheKey = createHash('sha256')
        .update(`${backend.mode}:${backend.provider}:${backend.model}:${dims}:${text}`)
        .digest('hex');
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.stats.cacheHits += 1;
        this.#touchCache(cacheKey, cached);
        results[i] = cached;
      } else {
        this.stats.cacheMisses += 1;
        misses.push({ index: i, text, cacheKey });
      }
    }

    if (misses.length > 0) {
      if (backend.mode === 'local') {
        this.stats.localCalls += 1;
        for (const miss of misses) {
          const vec = computeLocalSemanticEmbedding(miss.text, dims);
          this.#touchCache(miss.cacheKey, vec);
          results[miss.index] = vec;
        }
      } else {
        this.stats.upstreamCalls += 1;
        const batchSize = Math.max(1, Number(this.config.embeddingBatchSize || 32));
        for (let offset = 0; offset < misses.length; offset += batchSize) {
          const chunk = misses.slice(offset, offset + batchSize);
          const batchVectors = await this.#fetchUpstreamBatch(
            chunk.map((c) => c.text),
            backend,
            dims,
            signal
          );
          for (let j = 0; j < chunk.length; j += 1) {
            const vec = batchVectors[j];
            this.#touchCache(chunk[j].cacheKey, vec);
            results[chunk[j].index] = vec;
          }
        }
      }
      await this.save();
    }

    const tokens = estimateTokenCount(rawInputs);
    return {
      object: 'list',
      data: results.map((embedding, index) => ({
        object: 'embedding',
        index,
        embedding
      })),
      model: backend.model,
      provider: backend.provider,
      usage: {
        prompt_tokens: tokens,
        total_tokens: tokens
      }
    };
  }

  getStatus() {
    return {
      ok: true,
      provider: this.config.embeddingProvider,
      upstreamConfigured: Boolean(this.config.embeddingApiBase),
      apiBase: this.config.embeddingApiBase || null,
      defaultModel: this.config.embeddingModel,
      dimensions: this.config.embeddingDimensions,
      batchSize: this.config.embeddingBatchSize,
      cacheSize: this.cache.size,
      maxCacheEntries: this.config.embeddingCacheMaxEntries,
      stats: { ...this.stats }
    };
  }
}
