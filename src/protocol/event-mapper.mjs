import { redactSensitive } from '../security/redact.mjs';

const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const str = (v) => (typeof v === 'string' ? v : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const text = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? ''));

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
  return {
    code,
    reason: redactSensitive(base, extraSecrets)
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
  const settledSteps = new Set();
  const unknownEvents = [];

  const recordUnknown = (label) => {
    if (unknownEvents.length < 50) unknownEvents.push(label);
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
        let callId = toolIds.get(idx);

        if (!callId) {
          callId = `${currentId || runId}:tool:${idx}`;
          toolIds.set(idx, callId);
          onEvent({
            type: 'tool_call',
            callId,
            name,
            args: info.parameters ?? s.parameters ?? s.args ?? {}
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
            onEvent({
              type: 'tool_result',
              callId,
              name,
              ok: true,
              content: info.output ?? s.output ?? ''
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
        !['stop', 'end_turn', 'complete', 'completed'].includes(finishedReason)
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
      totalToolCount: toolIds.size
    };
  }

  return {
    handleEvent,
    processLine,
    getState
  };
}
