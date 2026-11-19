#!/usr/bin/env node
/**
 * Zero-dependency MCP Stdio-to-Streamable-HTTP proxy for Zotero's /llm-for-zotero/mcp endpoint.
 * Reads JSON-RPC 2.0 lines from stdin, attaches scoped Bearer/Scope headers from a local
 * protected file or environment, and writes single-line JSON-RPC responses to stdout.
 */
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { redactSensitive } from '../security/redact.mjs';
import { classifyToolMetadata, stripScopeHeader } from './zotero-mcp.mjs';

function parseCliArgs(argv) {
  let serverName = 'llm_for_zotero';
  let headersFile = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--server' && argv[i + 1]) {
      serverName = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--headers-file' && argv[i + 1]) {
      headersFile = argv[i + 1];
      i += 1;
    }
  }
  return { serverName, headersFile };
}

export async function loadProxyTarget({ serverName, headersFile, env = process.env }) {
  if (headersFile) {
    try {
      const raw = await readFile(headersFile, 'utf8');
      const parsed = JSON.parse(raw);
      const entry = parsed?.servers?.[serverName];
      if (entry && typeof entry.url === 'string' && entry.url.trim()) {
        return {
          url: entry.url.trim(),
          headers: entry.headers && typeof entry.headers === 'object' ? entry.headers : {}
        };
      }
    } catch {
      // Fall through to env variables below.
    }
  }

  let envHeaders = {};
  if (env.ZOTERO_MCP_HEADERS_JSON) {
    try {
      const parsed = JSON.parse(env.ZOTERO_MCP_HEADERS_JSON);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        envHeaders = parsed;
      }
    } catch {
      envHeaders = {};
    }
  }
  if (env.ZOTERO_MCP_TOKEN && !envHeaders.Authorization && !envHeaders.authorization) {
    envHeaders.Authorization = `Bearer ${env.ZOTERO_MCP_TOKEN}`;
  }

  return {
    url: (env.ZOTERO_MCP_URL || 'http://127.0.0.1:23119/llm-for-zotero/mcp').trim(),
    headers: envHeaders
  };
}

function extractSsePayloads(sseText) {
  const payloads = [];
  for (const rawLine of sseText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      payloads.push(JSON.parse(data));
    } catch {
      // Ignore malformed SSE event chunks.
    }
  }
  return payloads;
}

function hasScopeHeader(headers = {}) {
  return Object.keys(headers || {}).some((k) => String(k).toLowerCase() === 'x-llm-for-zotero-scope');
}

function isDiscoveryMethod(method) {
  return method === 'initialize' || method === 'tools/list' || method === 'notifications/initialized';
}

function responseHasExpiredScope(bodyText, responses) {
  if (/zotero mcp scope token is invalid or expired/i.test(String(bodyText || ''))) return true;
  return Array.isArray(responses) &&
    responses.some((r) => /zotero mcp scope token is invalid or expired/i.test(String(r?.error?.message || '')));
}

function compactNoteVerificationInTree(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return false;
  if (Array.isArray(node)) {
    let changed = false;
    for (const entry of node) {
      if (compactNoteVerificationInTree(entry, depth + 1)) changed = true;
    }
    return changed;
  }

  let changed = false;
  if (node.noteVerification && typeof node.noteVerification === 'object' && !Array.isArray(node.noteVerification)) {
    const nv = node.noteVerification;
    const htmlStr = typeof nv.html === 'string' ? nv.html : '';
    const textStr = typeof nv.text === 'string' ? nv.text : '';
    if (htmlStr.length > 1200 || textStr.length > 1200) {
      const embeddedImageCount = (htmlStr.match(/<img\b/gi) || []).length;
      const embeddedCitationCount = (htmlStr.match(/data-citation-items=/gi) || []).length;
      node.noteVerification = {
        schemaVersion: nv.schemaVersion ?? 1,
        noteId: nv.noteId,
        verified: true,
        htmlLength: htmlStr.length,
        textLength: textStr.length,
        embeddedImageCount,
        embeddedCitationCount,
        preview: (textStr || htmlStr).slice(0, 400)
      };
      changed = true;
    }
  }

  for (const val of Object.values(node)) {
    if (val && typeof val === 'object' && compactNoteVerificationInTree(val, depth + 1)) {
      changed = true;
    }
  }
  return changed;
}

function compactLibraryReadNotes(data) {
  const results = data?.result?.results;
  if (!results || typeof results !== 'object') return false;
  const entries = Array.isArray(results) ? results : Object.values(results);
  let changed = false;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.notes)) continue;
    for (const note of entry.notes) {
      if (!note || typeof note !== 'object') continue;
      if (typeof note.noteText === 'string' && note.noteText.length > 2400) {
        const origLen = note.noteText.length;
        note.noteText =
          `${note.noteText.slice(0, 1200)}\n...[truncated ${origLen - 1600} chars; full note verified in Zotero (noteId=${note.noteId ?? ''}, wordCount=${note.wordCount ?? ''})]...\n${note.noteText.slice(-400)}`;
        changed = true;
      }
      if (typeof note.html === 'string' && note.html.length > 1200) {
        if (typeof note.noteText === 'string' && note.noteText.length > 0) {
          delete note.html;
        } else {
          note.html = note.html.slice(0, 400);
        }
        changed = true;
      }
    }
  }
  return changed;
}

function annotateReadAttachmentDiagnostics(data, rawArgs) {
  if (!data || typeof data !== 'object') return false;
  const payload =
    data.result && typeof data.result === 'object' && !Array.isArray(data.result) ? data.result : data;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;

  const contentType = String(payload.contentType || '').toLowerCase();
  const fileHint = String(payload.filePath || payload.title || payload.attachmentTitle || '');
  const sourceMode = String(payload.sourceMode || '').toLowerCase();
  const rawText = typeof payload.textContent === 'string' ? payload.textContent : '';
  const noteStr = String(payload.note || '');

  const badChars = (rawText.match(/[\uFFFD\u0000-\u0008\u000E-\u001F]/g) || []).length;
  const isLegacyDoc =
    (/(?:^|;)application\/msword\b/i.test(contentType) || /\.doc$/i.test(fileHint)) &&
    sourceMode !== 'docx' &&
    !/\.docx$/i.test(fileHint);

  if (
    (isLegacyDoc && (badChars >= 8 || !rawText.trim())) ||
    (!sourceMode && rawText.length >= 64 && badChars >= 16 && badChars / rawText.length >= 0.05)
  ) {
    payload.textContent = '';
    payload.wordCount = 0;
    payload.bridgeDiagnostic = {
      code: 'unsupported_binary_doc',
      message:
        'Legacy binary Word (.doc) attachments cannot be decoded as plain text by llm-for-zotero read_attachment. Do not retry reading this .doc file; ask the user to convert it to .docx (for text) or .pdf / MinerU .md (for figures and text).'
    };
    if (!payload.note) {
      payload.note = payload.bridgeDiagnostic.message;
    }
    return true;
  }

  const isDocx =
    sourceMode === 'docx' || /wordprocessingml\.document/i.test(contentType) || /\.docx$/i.test(fileHint);
  const missingLocalFile = /not available locally|could not resolve file path|attachment .* not found/i.test(noteStr);
  if (
    isDocx &&
    (!rawText.trim() || /No plain text could be extracted from this DOCX/i.test(noteStr)) &&
    !missingLocalFile
  ) {
    payload.bridgeDiagnostic = {
      code: 'empty_or_image_only_docx',
      message:
        'No plain text was extracted from this .docx attachment (llm-for-zotero parses word/document.xml text only and skips embedded figures/images). Inform the user to convert visual/scanned SI files to .pdf or MinerU Markdown.'
    };
    return true;
  }

  let changed = false;
  if (isDocx && rawText.trim().length > 0 && !payload.bridgeNotice) {
    payload.bridgeNotice =
      'DOCX text extracted from word/document.xml only; embedded figures/images inside .docx are not included.';
    changed = true;
  }
  if (rawText.length >= 49_950 && rawText.endsWith('\u2026') && !(Number(rawArgs?.maxChars) > 0)) {
    payload.truncatedAtDefaultMaxChars = true;
    payload.truncationHint =
      'Attachment text hit the default 50,000-char limit; call read_attachment again with a larger maxChars (e.g. 200000) if additional sections are needed.';
    changed = true;
  }

  return changed;
}

function annotatePaperReadErrorHint(textOrData) {
  const hint =
    'If the target is a MinerU .md, .txt, .html, or .docx attachment (or a PDF-less item), call read_attachment({ target: { contextItemId } }) directly instead of paper_read; legacy .doc binaries must be converted to .docx or .pdf.';
  if (typeof textOrData === 'string') {
    if (!/no PDF or text attachment was found/i.test(textOrData) || textOrData.includes('[Bridge hint:')) {
      return textOrData;
    }
    return `${textOrData}\n[Bridge hint: ${hint}]`;
  }
  if (!textOrData || typeof textOrData !== 'object') return false;
  const messages = [
    textOrData.error,
    textOrData.message,
    textOrData.result?.error,
    textOrData.result?.message
  ].filter((v) => typeof v === 'string');
  if (messages.some((m) => /no PDF or text attachment was found/i.test(m)) && !textOrData.bridgeHint) {
    textOrData.bridgeHint = hint;
    return true;
  }
  return false;
}

/**
 * Compacts oversized Zotero MCP tool responses (`note_write` verification HTML/text,
 * long `library_read` note bodies, `paper_read` figures metadata, and >8 KB pretty JSON)
 * and enriches `read_attachment` / `paper_read` diagnostics for `.md` and `.doc`/`.docx` flows.
 */
export function compactMcpToolCallResponse(toolName, rawArgs, rpcResponse) {
  if (!rpcResponse || typeof rpcResponse !== 'object') return rpcResponse;
  const normalizedTool = String(toolName || '').trim().toLowerCase();

  let nextRpc = rpcResponse;
  if (normalizedTool === 'paper_read' && typeof rpcResponse.error?.message === 'string') {
    const hintedErr = annotatePaperReadErrorHint(rpcResponse.error.message);
    if (hintedErr !== rpcResponse.error.message) {
      nextRpc = {
        ...rpcResponse,
        error: {
          ...rpcResponse.error,
          message: hintedErr
        }
      };
    }
  }

  const content = nextRpc?.result?.content;
  if (!Array.isArray(content) || content.length === 0) return nextRpc;

  let anyChanged = false;
  const nextContent = content.map((item) => {
    if (!item || item.type !== 'text' || typeof item.text !== 'string') return item;
    let data;
    try {
      data = JSON.parse(item.text);
    } catch {
      if (normalizedTool === 'paper_read') {
        const hinted = annotatePaperReadErrorHint(item.text);
        if (hinted !== item.text) {
          anyChanged = true;
          return { ...item, text: hinted };
        }
      }
      return item;
    }
    if (typeof data === 'string' && normalizedTool === 'paper_read') {
      const hinted = annotatePaperReadErrorHint(data);
      if (hinted !== data) {
        anyChanged = true;
        return { ...item, text: JSON.stringify(hinted) };
      }
      return item;
    }
    if (!data || typeof data !== 'object') return item;

    let modified = compactNoteVerificationInTree(data);
    if (normalizedTool === 'library_read' || data?.result?.results) {
      if (compactLibraryReadNotes(data)) modified = true;
    }
    if (data?.result?.mode === 'figures' && Array.isArray(data.result.figures)) {
      for (const fig of data.result.figures) {
        if (fig && fig.paperContext && typeof fig.paperContext === 'object') {
          fig.paperContext = {
            libraryID: fig.paperContext.libraryID,
            itemId: fig.paperContext.itemId,
            contextItemId: fig.paperContext.contextItemId,
            citationLabel: fig.paperContext.citationLabel
          };
          modified = true;
        }
      }
    }
    if (normalizedTool === 'read_attachment') {
      if (annotateReadAttachmentDiagnostics(data, rawArgs)) modified = true;
    } else if (normalizedTool === 'paper_read') {
      if (annotatePaperReadErrorHint(data)) modified = true;
    }

    if (!modified && item.text.length <= 8000) return item;
    anyChanged = true;
    return {
      ...item,
      text: JSON.stringify(data)
    };
  });

  if (!anyChanged) return nextRpc;
  return {
    ...nextRpc,
    result: {
      ...nextRpc.result,
      content: nextContent
    }
  };
}

async function postJsonRpcOnce(message, targetUrl, headers, fetchImpl) {
  const hasId = message && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, 'id');
  const res = await fetchImpl(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers
    },
    body: JSON.stringify(message)
  });

  if (res.status === 202 || res.status === 204) {
    return { bodyText: '', responses: [] };
  }

  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  const bodyText = await res.text().catch(() => '');

  if (!res.ok) {
    const errMsg = redactSensitive(`MCP HTTP ${res.status}${bodyText.trim() ? `: ${bodyText.trim().slice(0, 300)}` : ''}`);
    return {
      bodyText,
      responses: hasId ? [{ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: errMsg } }] : []
    };
  }

  if (!bodyText.trim()) {
    return { bodyText, responses: [] };
  }

  if (contentType.includes('text/event-stream')) {
    return { bodyText, responses: extractSsePayloads(bodyText) };
  }

  const parsed = JSON.parse(bodyText);
  return { bodyText, responses: Array.isArray(parsed) ? parsed : [parsed] };
}

/**
 * Forwards one parsed JSON-RPC 2.0 message to the target Streamable HTTP MCP server.
 * Enforces hard read-only guards when `allowWrite` is false and strips expired scope
 * headers cleanly when retrying discovery methods.
 */
export async function forwardJsonRpcMessage(
  message,
  target,
  fetchImpl = fetch,
  options = {}
) {
  const allowWrite =
    options?.allowWrite !== undefined ? Boolean(options.allowWrite) : process.env.ZOTERO_MCP_ALLOW_WRITE !== '0';

  if (!allowWrite && message?.method === 'tools/call') {
    const toolName = String(message?.params?.name || '').trim();
    if (classifyToolMetadata(toolName, '', {}, 'mcp').mutability !== 'read') {
      return [
        {
          jsonrpc: '2.0',
          id: message?.id ?? null,
          error: {
            code: -32001,
            message: `Zotero MCP write tool "${toolName}" is blocked in read-only mode (unset AGY_ZOTERO_MCP_ALLOW_WRITE=0 to enable)`
          }
        }
      ];
    }
  }

  const initialHeaders = target?.headers || {};
  let outcome = await postJsonRpcOnce(message, target.url, initialHeaders, fetchImpl);

  if (
    isDiscoveryMethod(message?.method) &&
    hasScopeHeader(initialHeaders) &&
    responseHasExpiredScope(outcome.bodyText, outcome.responses)
  ) {
    outcome = await postJsonRpcOnce(message, target.url, stripScopeHeader(initialHeaders), fetchImpl);
  }

  if (!allowWrite && message?.method === 'tools/list') {
    return outcome.responses.map((resp) => {
      if (!resp || !resp.result || !Array.isArray(resp.result.tools)) return resp;
      const filteredTools = resp.result.tools.filter(
        (t) => classifyToolMetadata(t?.name, t?.description, t?.annotations, 'mcp').mutability === 'read'
      );
      return {
        ...resp,
        result: {
          ...resp.result,
          tools: filteredTools
        }
      };
    });
  }

  if (message?.method === 'tools/call' && Array.isArray(outcome.responses)) {
    const calledTool = message?.params?.name;
    const calledArgs = message?.params?.arguments;
    return outcome.responses.map((resp) => compactMcpToolCallResponse(calledTool, calledArgs, resp));
  }

  return outcome.responses;
}

async function runProxy() {
  const { serverName, headersFile } = parseCliArgs(process.argv.slice(2));
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  for await (const rawLine of rl) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'
      );
      continue;
    }

    const hasId = msg && typeof msg === 'object' && Object.prototype.hasOwnProperty.call(msg, 'id');
    try {
      const target = await loadProxyTarget({ serverName, headersFile });
      const responses = await forwardJsonRpcMessage(msg, target);
      for (const resp of responses) {
        process.stdout.write(JSON.stringify(resp) + '\n');
      }
    } catch (e) {
      if (hasId) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: redactSensitive(e?.message || e) }
          }) + '\n'
        );
      }
    }
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runProxy();
}
