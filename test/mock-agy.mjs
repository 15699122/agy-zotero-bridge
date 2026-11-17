#!/usr/bin/env node
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const ix = (x) => args.indexOf(x);

if (args.includes('--version')) {
  console.log('agy mock 1.5.9');
  process.exit(0);
}

if (args.includes('models')) {
  if (process.env.MOCK_MODELS_WITH_BANNER === '1') {
    console.log('Fetching available models...');
  }
  if (args.includes('json')) {
    console.log(JSON.stringify({ command: { data: { models: [{ id: 'gemini-mock', label: 'Gemini Mock' }] } } }));
  } else {
    console.log('gemini-mock\tGemini Mock');
  }
  process.exit(0);
}

const hasSchema = ix('--json-schema') >= 0;
const cid = ix('--conversation') >= 0 ? args[ix('--conversation') + 1] : 'abc-test-session';
const emit = (x) => console.log(JSON.stringify(x));
const isStdinStreamJson = ix('--input-format') >= 0 && args[ix('--input-format') + 1] === 'stream-json';

function handlePrompt(prompt, turnNumber = 1, cumUsage = { inTok: 0, outTok: 0, cacheTok: 0 }) {
  if (prompt.includes('MOCK_NO_RESULT')) {
    process.exit(0);
  }

  if (prompt.includes('MOCK_SECRET_STDERR')) {
    console.error('Authorization: Bearer secret-token-12345 api_key=AIzaSyFakeKey1234567890 C:\\Users\\Alice\\.gemini\\oauth_creds.json');
    process.exit(1);
  }

  if (/\bMOCK_TOOL\b/.test(prompt)) {
    emit({
      event: 'step_update',
      step_update: { step_index: 1, step_type: 'tool', state: 'ACTIVE', tool_name: 'read_file', tool_info: { parameters: { path: 'example.txt' } } }
    });
    emit({
      event: 'step_update',
      step_update: { step_index: 1, step_type: 'tool', state: 'DONE', tool_name: 'read_file', tool_info: { output: 'hello' } }
    });
  }

  if (prompt.includes('MOCK_TOOL_ONLY_DONE')) {
    emit({
      event: 'step_update',
      step_update: { step_index: 7, step_type: 'tool', state: 'DONE', tool_name: 'read_file', tool_info: { parameters: { path: 'only-done.txt' }, output: 'ok' } }
    });
  }

  if (prompt.includes('MOCK_TOOL_DUP_DONE')) {
    emit({
      event: 'step_update',
      step_update: { step_index: 8, step_type: 'tool', state: 'ACTIVE', tool_name: 'read_file', tool_info: { parameters: { path: 'dup.txt' } } }
    });
    emit({
      event: 'step_update',
      step_update: { step_index: 8, step_type: 'tool', state: 'DONE', tool_name: 'read_file', tool_info: { output: 'first' } }
    });
    emit({
      event: 'step_update',
      step_update: { step_index: 8, step_type: 'tool', state: 'DONE', tool_name: 'read_file', tool_info: { output: 'second' } }
    });
  }

  if (prompt.includes('MOCK_TOOL_ERROR')) {
    emit({
      event: 'step_update',
      step_update: { step_index: 2, step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { error: { message: 'permission denied' } } }
    });
  }

  if (prompt.includes('MOCK_FAIL')) {
    emit({ event: 'result', result: { conversation_id: cid, status: 'ERROR', error: 'failure from agy', response: '' } });
    if (!isStdinStreamJson) process.exit(0);
    return;
  }

  if (prompt.includes('MOCK_429')) {
    emit({ event: 'result', result: { conversation_id: cid, status: 'ERROR', error: 'HTTP 429 rate limit exceeded', response: '' } });
    if (!isStdinStreamJson) process.exit(0);
    return;
  }

  if (prompt.includes('MOCK_AUTH_FAIL')) {
    emit({ event: 'result', result: { conversation_id: cid, status: 'ERROR', error: 'unauthenticated: login required', response: '' } });
    if (!isStdinStreamJson) process.exit(0);
    return;
  }

  if (prompt.includes('MOCK_UNKNOWN_MODEL')) {
    emit({ event: 'result', result: { conversation_id: cid, status: 'ERROR', error: 'unsupported model: nonexistent-99', response: '' } });
    if (!isStdinStreamJson) process.exit(0);
    return;
  }

  if (prompt.includes('MOCK_SOFT_DENY')) {
    console.error('permission denied: not approved');
  }

  if (prompt.includes('MOCK_CANCEL')) {
    setTimeout(() => {}, 30_000);
    process.stdin.resume();
    return;
  }

  if (prompt.includes('MOCK_POOL_INFO')) {
    cumUsage.inTok += 15;
    cumUsage.outTok += 5;
    cumUsage.cacheTok += 2;
    const total = cumUsage.inTok + cumUsage.outTok + cumUsage.cacheTok;
    const payload = JSON.stringify({ pid: process.pid, turn: turnNumber });
    emit({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text: payload } });
    emit({
      event: 'result',
      result: {
        conversation_id: cid,
        status: 'SUCCESS',
        response: payload,
        usage: {
          input_tokens: cumUsage.inTok,
          output_tokens: cumUsage.outTok,
          cache_read_tokens: cumUsage.cacheTok,
          total_tokens: total
        }
      }
    });
    return;
  }

  if (prompt.includes('MOCK_DONE_ONLY')) {
    emit({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text: 'Done only reply' } });
    emit({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: 'Done only reply', usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } } });
  } else if (prompt.includes('MOCK_NONZERO_EXIT')) {
    emit({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: 'Partial', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    console.error('unexpected crash after result');
    process.exit(2);
  } else if (prompt.includes('MOCK_UNKNOWN_EVENTS')) {
    console.log('{invalid json line');
    emit({ event: 'step_update', step_update: { step_index: 4, step_type: 'subagent_info', status: 'ok' } });
    emit({ event: 'telemetry_ping', ts: 12345 });
    emit({ event: 'step_update', step_update: { step_index: 5, step_type: 'agent_response', state: 'DONE', text_delta: 'Tolerated' } });
    emit({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: 'Tolerated', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } } });
  } else if (prompt.includes('MOCK_ECHO_SETTINGS')) {
    const settingsIdx = ix('--settings');
    const settingsPath = settingsIdx >= 0 ? args[settingsIdx + 1] || '' : '';
    const payload = JSON.stringify({ hasSettingsFlag: settingsIdx >= 0, settingsPath });
    emit({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text: payload } });
    emit({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: payload, usage: { input_tokens: 4, output_tokens: 4, total_tokens: 8 } } });
  } else if (prompt.includes('MOCK_ECHO_MODEL_EFFORT')) {
    const modelIdx = ix('--model');
    const effortIdx = ix('--effort');
    const payload = JSON.stringify({
      model: modelIdx >= 0 ? args[modelIdx + 1] || null : null,
      effort: effortIdx >= 0 ? args[effortIdx + 1] || null : null
    });
    emit({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text: payload } });
    emit({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: payload, usage: { input_tokens: 4, output_tokens: 4, total_tokens: 8 } } });
  } else if (prompt.includes('MOCK_ECHO_RAW_PDF')) {
    const m = /"absolutePath":"((?:[^"\\]|\\.)*)"/.exec(prompt);
    const echoed = m ? JSON.parse(`"${m[1]}"`) : 'UNKNOWN_PATH';
    const msg = `Read ${echoed} successfully.`;
    const half = Math.floor(msg.length / 2);
    emit({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: msg.slice(0, half) } });
    emit({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: msg.slice(half) } });
    emit({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: msg, usage: { input_tokens: 8, output_tokens: 5, total_tokens: 13 } } });
  } else if (prompt.includes('MOCK_STRUCTURED_INVALID_JSON')) {
    emit({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: 'not valid json output', usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } });
  } else if (prompt.includes('MOCK_FENCED_JSON')) {
    const payload = '```json\n{"title":"Paper B","year":2026}\n```';
    emit({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: payload, usage: { input_tokens: 6, output_tokens: 8, total_tokens: 14 } } });
  } else if (hasSchema || prompt.includes('MOCK_STRUCTURED_JSON')) {
    const payload = JSON.stringify({ title: 'Paper A', tags: ['ml', 'zotero'] });
    emit({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response: payload, usage: { input_tokens: 6, output_tokens: 8, total_tokens: 14 } } });
  } else {
    emit({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Hel' } });
    emit({ event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: 'lo' } });
    emit({
      event: 'result',
      result: {
        conversation_id: cid,
        status: 'SUCCESS',
        response: 'Hello',
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, cache_read_tokens: 1 }
      }
    });
  }
}

emit({
  event: 'init',
  conversation_id: cid,
  init: { cwd: process.cwd(), tools: ['read_file', 'run_command'], permission_mode: 'request-review' }
});

if (isStdinStreamJson) {
  let turnNumber = 0;
  const cumUsage = { inTok: 0, outTok: 0, cacheTok: 0 };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    turnNumber += 1;
    const content = typeof msg?.message?.content === 'string' ? msg.message.content : '';
    handlePrompt(content, turnNumber, cumUsage);
  });
  rl.on('close', () => {
    process.exit(0);
  });
} else {
  const prompt = ix('-p') >= 0 ? args[ix('-p') + 1] || '' : '';
  handlePrompt(prompt, 1);
}
