import { redactSensitive } from '../security/redact.mjs';

const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

function unwrapQuotedString(val) {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // Ignore malformed JSON string literals.
    }
  }
  return val;
}

/**
 * Normalizes agy CLI tool arguments by unwrapping double-encoded JSON strings
 * (e.g. `Path: "\"C:\\...\""`, `ToolName: "\"paper_read\""`), parsing `Arguments`,
 * and mirroring `Path` onto `path` / `file_path`.
 */
export function normalizeAgyToolArgs(rawArgs) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return rawArgs ?? {};
  const out = {};
  for (const [k, v] of Object.entries(rawArgs)) {
    out[k] = typeof v === 'string' ? unwrapQuotedString(v) : v;
  }
  if (typeof out.Arguments === 'string') {
    const trimmedArgs = out.Arguments.trim();
    if (trimmedArgs.startsWith('{') || trimmedArgs.startsWith('[')) {
      try {
        const parsedArgs = JSON.parse(trimmedArgs);
        if (parsedArgs && typeof parsedArgs === 'object') {
          out.parsedArguments = parsedArgs;
        }
      } catch {
        // Ignore partial or non-JSON arguments.
      }
    }
  }
  if (typeof out.Path === 'string' && out.Path.trim()) {
    if (!out.path) out.path = out.Path;
    if (!out.file_path) out.file_path = out.Path;
  }
  return out;
}

function resolveToolMeta(toolName, normalizedArgs) {
  const lower = str(toolName).trim().toLowerCase();
  const a = record(normalizedArgs);
  let targetTool = lower;
  let noteArgs = a;
  if (lower === 'call_mcp_tool') {
    targetTool = str(a.ToolName || a.toolName).trim().toLowerCase();
    noteArgs = a.parsedArguments && typeof a.parsedArguments === 'object' ? a.parsedArguments : a;
  } else {
    const slash = lower.lastIndexOf('/');
    const dbl = lower.lastIndexOf('__');
    if (slash >= 0) targetTool = lower.slice(slash + 1);
    else if (dbl >= 0) targetTool = lower.slice(dbl + 2);
  }
  return { targetTool, noteArgs };
}

function extractNoteWriteResult(rawOut, noteArgs) {
  let noteId = '';
  let title = '';
  let okFlag = true;

  const inspectObj = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (obj.ok === false) okFlag = false;
    const resObj = record(obj.result ?? obj);
    if (resObj.noteId !== undefined && resObj.noteId !== null && resObj.noteId !== '') {
      noteId = String(resObj.noteId);
    } else if (resObj.createdNoteReceipt?.note?.itemId) {
      noteId = String(resObj.createdNoteReceipt.note.itemId);
    } else if (obj.noteId !== undefined && obj.noteId !== null && obj.noteId !== '') {
      noteId = String(obj.noteId);
    }
    if (!title && (typeof resObj.title === 'string' || typeof resObj.note?.title === 'string')) {
      title = str(resObj.title || resObj.note?.title);
    }
  };

  if (rawOut && typeof rawOut === 'object') {
    inspectObj(rawOut);
    if (Array.isArray(rawOut.content)) {
      for (const part of rawOut.content) {
        if (typeof part?.text === 'string') {
          try {
            inspectObj(JSON.parse(part.text));
          } catch {}
        }
      }
    }
  } else if (typeof rawOut === 'string' && rawOut.trim()) {
    try {
      const parsed = JSON.parse(rawOut);
      inspectObj(parsed);
      if (Array.isArray(parsed?.content)) {
        for (const part of parsed.content) {
          if (typeof part?.text === 'string') {
            try {
              inspectObj(JSON.parse(part.text));
            } catch {}
          }
        }
      }
    } catch {
      const idMatch = /"noteId"\s*:\s*(\d+)/.exec(rawOut);
      if (idMatch) noteId = idMatch[1];
      if (/"ok"\s*:\s*false/i.test(rawOut)) okFlag = false;
    }
  }

  if (!okFlag) return null;
  return {
    noteId,
    title,
    targetItemId: noteArgs?.targetItemId ?? '',
    content: str(noteArgs?.content)
  };
}

/**
 * Classifies agy CLI errors into stable diagnostic categories and scrubs sensitive strings.
 */
export function classifyAgyError(rawMessage, stderr = '', exitCode = 0, extraSecrets = []) {
  const combined = `${str(rawMessage) || String(rawMessage ?? '')}\n${str(stderr)}`.trim();
  let code = 'agy_error';

  if (/\b(?:cancelled|aborted)\b/i.test(combined)) {
    code = 'cancelled';
  } else if (/\b(?:timeout|timed out|etimedout)\b/i.test(combined)) {
    code = 'timeout';
  } else if (/\b429\b|rate[_\s-]?limit|too many requests|quota exceeded|resource[_\s-]?exhausted/i.test(combined)) {
    code = 'rate_limited';
  } else if (/unauthenticated|unauthorized|not logged in|login required|auth(?:entication)?\s*(?:fail|required|expired|invalid)|invalid credentials|\boauth\b/i.test(combined)) {
    code = 'auth_failed';
  } else if (/model.*?(?:not found|unsupported|unavailable|invalid|unknown)|(?:unknown|unsupported)\s+model/i.test(combined)) {
    code = 'model_not_supported';
  } else if (/permission denied|not approved|blocked by permission|\beacces\b/i.test(combined)) {
    code = 'permission_denied';
  } else if (/without a terminal result|missing_result/i.test(combined)) {
    code = 'missing_result';
  } else if (exitCode && exitCode !== 0) {
    code = 'process_exit_error';
  }

  const base = str(rawMessage) || String(rawMessage ?? '') || `agy exited with code ${exitCode}`;
  let reason = redactSensitive(base, extraSecrets);
  if (
    code === 'rate_limited' &&
    !/reduce batch|lower thinking effort|switch model/i.test(reason)
  ) {
    reason = `${reason} (Hint: reduce batch paper count, lower thinking effort, or switch model and retry.)`;
  }
  return {
    code,
    reason
  };
}

/**
 * Stateful mapper converting agy `--output-format stream-json` NDJSON objects
 * into llm-for-zotero RuntimeEvent frames without duplicating deltas, tool calls, or final text.
 */
export function createTurnEventMapper({
  runId,
  model = '',
  onEvent,
  onTools = () => {},
  maxNdjsonLine = 2_000_000,
  extraSecrets = []
}) {
  let currentId = '';
  let output = '';
  let resultSeen = false;
  let success = false;
  let finalEmitted = false;
  let usageSummary = null;
  let nextToolIndex = 0;
  let invalidJsonLines = 0;

  const toolIds = new Map();
  const toolMeta = new Map();
  const settledSteps = new Set();
  const settledNoteWrites = [];
  const unknownEvents = [];

  const recordUnknown = (label) => {
    if (unknownEvents.length < 50) unknownEvents.push(label);
  };

  const synthesizeFallbackOutput = () => {
    if (output.trim()) return output;
    if (settledNoteWrites.length === 0) return '';
    const lastNote = settledNoteWrites.at(-1);
    const idSuffix = lastNote.noteId ? `（Note ID: \`${lastNote.noteId}\`）` : '';
    if (lastNote.content.trim()) {
      return `${lastNote.content.trim()}\n\n---\n✅ **Zotero 子笔记已创建并验证**${idSuffix}。`;
    }
    const titleSuffix = lastNote.title ? `：${lastNote.title}` : '';
    return `✅ **Zotero 笔记已写入并验证**${idSuffix}${titleSuffix}。`;
  };

  function handleEvent(ev) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      recordUnknown('non_object');
      return;
    }

    if (ev.event === 'init') {
      currentId = str(ev.conversation_id) || currentId;
      if (Array.isArray(ev.init?.tools)) {
        const tools = ev.init.tools.filter((t) => typeof t === 'string' && t.trim());
        if (tools.length) onTools(tools);
      }
      onEvent({
        type: 'provider_event',
        providerType: 'agy_session',
        sessionId: currentId || undefined,
        payload: { permissionMode: ev.init?.permission_mode },
        ts: Date.now()
      });
      return;
    }

    if (ev.event === 'step_update') {
      const s = record(ev.step_update);
      if (s.step_type === 'agent_response') {
        if (typeof s.text_delta === 'string' && s.text_delta.length > 0) {
          output += s.text_delta;
          onEvent({ type: 'message_delta', text: s.text_delta });
        } else if (s.state === 'DONE') {
          const fullText = str(s.text) || str(s.content) || str(record(s.message).content);
          if (fullText) {
            if (!output) {
              output = fullText;
              onEvent({ type: 'message_delta', text: fullText });
            } else if (fullText.startsWith(output) && fullText.length > output.length) {
              const delta = fullText.slice(output.length);
              output = fullText;
              onEvent({ type: 'message_delta', text: delta });
            }
          }
        }
        return;
      }

      if (s.step_type === 'tool') {
        const idxRaw = s.step_index ?? s.tool_call_id ?? s.id ?? nextToolIndex++;
        const idx = String(idxRaw);
        const info = record(s.tool_info);
        const name = str(s.tool_name || info.name || s.name) || 'unknown';
        const rawArgs = info.parameters ?? s.parameters ?? s.args;
        const normalizedArgs = normalizeAgyToolArgs(rawArgs ?? {});
        const resolvedMeta = resolveToolMeta(name, normalizedArgs);
        const prevMeta = toolMeta.get(idx);
        if (!prevMeta || (rawArgs !== undefined && !str(prevMeta.noteArgs?.content) && str(resolvedMeta.noteArgs?.content))) {
          toolMeta.set(idx, resolvedMeta);
        }
        let callId = toolIds.get(idx);

        if (!callId) {
          callId = `${currentId || runId}:tool:${idx}`;
          toolIds.set(idx, callId);
          onEvent({
            type: 'tool_call',
            callId,
            name,
            args: normalizedArgs
          });
        }

        if (s.state === 'DONE' && !settledSteps.has(idx)) {
          settledSteps.add(idx);
          const err = info.error ?? s.error;
          if (err) {
            const rawErr = str(record(err).message) || text(err);
            onEvent({
              type: 'tool_error',
              callId,
              name,
              error: redactSensitive(rawErr, extraSecrets),
              round: num(s.round)
            });
          } else {
            const outContent = info.output ?? s.output ?? '';
            const meta = toolMeta.get(idx);
            if (meta && (meta.targetTool === 'note_write' || meta.targetTool === 'note_write_batch')) {
              const noteRec = extractNoteWriteResult(outContent, meta.noteArgs);
              if (noteRec) settledNoteWrites.push(noteRec);
            }
            onEvent({
              type: 'tool_result',
              callId,
              name,
              ok: true,
              content: outContent
            });
          }
        }
        return;
      }

      if (s.step_type === 'subagent_info') {
        return;
      }

      recordUnknown(`step_update:${str(s.step_type) || 'unknown'}`);
      return;
    }

    if (ev.event === 'result') {
      if (resultSeen) {
        return;
      }
      resultSeen = true;
      const r = record(ev.result);
      currentId = str(r.conversation_id) || currentId;

      if (r.status !== 'SUCCESS') {
        const rawErr = str(r.error) || `agy result status ${r.status ?? 'UNKNOWN'}`;
        const classified = classifyAgyError(rawErr, '', 0, extraSecrets);
        const err = new Error(classified.reason);
        err.errorCode = classified.code;
        throw err;
      }

      const finishedReason = str(r.finished_reason).trim().toLowerCase();
      if (
        finishedReason &&
        !['stop', 'end_turn', 'complete', 'completed'].includes(finishedReason) &&
        !(finishedReason === 'print_timeout' && settledNoteWrites.length > 0)
      ) {
        let code = 'agy_error';
        if (finishedReason === 'print_timeout') code = 'timeout';
        else if (finishedReason === 'interrupted') code = 'cancelled';
        const err = new Error(`agy turn ended early: ${finishedReason}`);
        err.errorCode = code;
        throw err;
      }

      success = true;
      const response = str(r.response);
      if (!output && response) {
        onEvent({ type: 'message_delta', text: response });
      } else if (response.startsWith(output) && response.length > output.length) {
        onEvent({ type: 'message_delta', text: response.slice(output.length) });
      }
      output = response || output;
      if (!output.trim() && settledNoteWrites.length > 0) {
        output = synthesizeFallbackOutput();
        if (output) {
          onEvent({ type: 'message_delta', text: output });
        }
      }

      const u = record(r.usage);
      usageSummary = {
        inputTokens: Math.max(0, num(u.input_tokens)),
        outputTokens: Math.max(0, num(u.output_tokens)),
        cacheReadInputTokens: Math.max(0, num(u.cache_read_tokens)),
        cacheCreationInputTokens: 0,
        contextTokens: Math.max(0, num(u.total_tokens))
      };

      onEvent({
        type: 'usage',
        ...usageSummary,
        sessionId: currentId || undefined,
        model: model || undefined
      });

      if (!finalEmitted) {
        finalEmitted = true;
        onEvent({ type: 'final', text: output });
      }
      return;
    }

    recordUnknown(str(ev.event) || 'unknown');
  }

  function processLine(line) {
    if (typeof line !== 'string') return { parsed: false };
    if (line.length > maxNdjsonLine) {
      throw new Error('oversized agy NDJSON event');
    }
    const trimmed = line.trim();
    if (!trimmed) return { parsed: false, empty: true };
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      invalidJsonLines += 1;
      return { parsed: false, invalidJson: true };
    }
    handleEvent(ev);
    return { parsed: true };
  }

  function getState() {
    return {
      sessionId: currentId,
      output,
      resultSeen,
      success,
      finalEmitted,
      usage: usageSummary,
      invalidJsonLines,
      unknownEvents: [...unknownEvents],
      settledToolCount: settledSteps.size,
      totalToolCount: toolIds.size,
      settledNoteWrites: settledNoteWrites.length,
      synthesizedOutput: synthesizeFallbackOutput()
    };
  }

  return {
    handleEvent,
    processLine,
    getState
  };
}
