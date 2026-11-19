/**
 * De-identified fixtures captured from official agy.exe 1.5.9 (Windows)
 * and canonical NDJSON edge-case traces for protocol regression testing.
 */

export const REAL_AGY_1_5_9_MODELS_JSON_STDOUT = [
  'Fetching available models...',
  JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    response:
      'gemini-4-argon-medium\tGemini 4 Argon (Medium)\n' +
      'gemini-4-argon-high\tGemini 4 Argon (High)\n' +
      'gemini-4-argon-low\tGemini 4 Argon (Low)\n' +
      'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n' +
      'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)\n' +
      'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)\n' +
      'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)\n' +
      'gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)\n' +
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' +
      'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n' +
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n' +
      'claude-opus-5-5-low\tClaude Opus 5.5 (Low)\n' +
      'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)\n' +
      'claude-opus-5-5-high\tClaude Opus 5.5 (High)\n' +
      'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)\n' +
      'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)\n' +
      'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)\n' +
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n',
    duration_seconds: 0,
    num_turns: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0
    },
    command: {
      name: 'models',
      data: {
        models: [
          { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
          { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
          { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
          { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
          { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
          { id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)' },
          { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
          { id: 'gemini-pro-orchestrator-g1-pro', label: 'Orchestrator (Argon)' },
          { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
          { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
          { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
          { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
          { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
          { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
          { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
          { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
          { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
          { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
        ]
      }
    }
  })
].join('\n');

export const REAL_AGY_1_5_9_MODELS_TEXT_STDOUT = [
  'Fetching available models...',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
  'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
  'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
  'gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
].join('\n');

export const REAL_AGY_1_5_11_MODELS_TEXT_STDOUT = [
  'Fetching available models...',
  'gemini-4-neon-high\tGemini 4 Neon (High)',
  'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
  'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
  'gemini-4-neon-low\tGemini 4 Neon (Low)',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)',
  'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)',
  'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)',
  'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)',
  'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
  'gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
].join('\n');

export const REAL_AGY_1_5_11_MODELS_JSON_STDOUT = [
  'Fetching available models...',
  JSON.stringify({
    conversation_id: '',
    status: 'SUCCESS',
    response:
      'gemini-4-neon-high\tGemini 4 Neon (High)\n' +
      'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\n' +
      'gemini-4-neon-medium\tGemini 4 Neon (Medium)\n' +
      'gemini-4-neon-low\tGemini 4 Neon (Low)\n' +
      'gemini-4-argon-medium\tGemini 4 Argon (Medium)\n' +
      'gemini-4-argon-high\tGemini 4 Argon (High)\n' +
      'gemini-4-argon-low\tGemini 4 Argon (Low)\n' +
      'gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\n' +
      'gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)\n' +
      'gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)\n' +
      'gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)\n' +
      'gemini-pro-orchestrator-neon\tOrchestrator (Neon)\n' +
      'gemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)\n' +
      'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n' +
      'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n' +
      'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n' +
      'claude-opus-5-5-low\tClaude Opus 5.5 (Low)\n' +
      'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)\n' +
      'claude-opus-5-5-high\tClaude Opus 5.5 (High)\n' +
      'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)\n' +
      'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)\n' +
      'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)\n' +
      'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n',
    duration_seconds: 0,
    num_turns: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: 0
    },
    command: {
      name: 'models',
      data: {
        models: [
          { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)' },
          { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)' },
          { id: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)' },
          { id: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)' },
          { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
          { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)' },
          { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)' },
          { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)' },
          { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)' },
          { id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)' },
          { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)' },
          { id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)' },
          { id: 'gemini-pro-orchestrator-g1-pro', label: 'Orchestrator (Argon)' },
          { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
          { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
          { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
          { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low)' },
          { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)' },
          { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)' },
          { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low)' },
          { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)' },
          { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High)' },
          { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' }
        ]
      }
    }
  })
].join('\n');

export const NDJSON_SAMPLES = {
  doneOnlyText: [
    { event: 'init', conversation_id: 'conv-done-1', init: { tools: ['read_file'], permission_mode: 'default' } },
    { event: 'step_update', step_update: { step_index: 1, step_type: 'agent_response', state: 'DONE', text: 'Done only reply' } },
    { event: 'result', result: { conversation_id: 'conv-done-1', status: 'SUCCESS', response: 'Done only reply', usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } }
  ],
  toolOnlyDoneAndDup: [
    { event: 'init', conversation_id: 'conv-tool-1', init: { tools: ['read_file', 'run_command'], permission_mode: 'default' } },
    { event: 'step_update', step_update: { step_index: 1, step_type: 'tool', state: 'DONE', tool_name: 'read_file', tool_info: { parameters: { path: 'paper.txt' }, output: 'abstract text' } } },
    { event: 'step_update', step_update: { step_index: 1, step_type: 'tool', state: 'DONE', tool_name: 'read_file', tool_info: { output: 'duplicate done ignored' } } },
    { event: 'step_update', step_update: { step_index: 2, step_type: 'subagent_info', status: 'running' } },
    { event: 'custom_telemetry', payload: { ignored: true } },
    { event: 'step_update', step_update: { step_index: 3, step_type: 'agent_response', state: 'DONE', text_delta: 'Summary ready.' } },
    { event: 'result', result: { conversation_id: 'conv-tool-1', status: 'SUCCESS', response: 'Summary ready.', usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } },
    { event: 'result', result: { conversation_id: 'conv-tool-1', status: 'SUCCESS', response: 'Summary ready.', usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } }
  ]
};
