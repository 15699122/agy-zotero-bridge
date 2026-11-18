import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSensitive } from '../security/redact.mjs';

const PROXY_SCRIPT_PATH = fileURLToPath(new URL('./stdio-http-proxy.mjs', import.meta.url));

const READ_ONLY_NATIVE_TOOLS = new Set([
  'read_file',
  'view_file',
  'view_file_outline',
  'view_code_item',
  'grep_search',
  'find_by_name',
  'list_dir',
  'search_web',
  'read_resource',
  'list_resources',
  'list_permissions',
  'list_plugin_accounts',
  'search_marketplace',
  'command_status',
  'browser_get_dom',
  'browser_get_network_request',
  'browser_list_network_requests',
  'capture_browser_console_logs',
  'capture_browser_screenshot',
  'list_browser_pages',
  'read_browser_page',
  'read_url_content'
]);

const WRITE_NATIVE_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'run_command',
  'send_command_input',
  'delete_file',
  'delete_knowledge',
  'notebook_edit',
  'notebook_execution',
  'generate_image',
  'browser_click_element',
  'browser_drag_pixel_to_pixel',
  'browser_input',
  'browser_mouse_down',
  'browser_mouse_up',
  'browser_move_mouse',
  'browser_press_key',
  'browser_refresh_page',
  'browser_resize_window',
  'browser_scroll',
  'browser_scroll_dom',
  'browser_select_option',
  'browser_subagent',
  'click_browser_pixel',
  'execute_browser_javascript',
  'open_browser_url',
  'call_mcp_tool',
  'define_subagent',
  'invoke_subagent',
  'manage_inbox',
  'manage_subagents',
  'manage_task',
  'run_workflow',
  'schedule',
  'send_message',
  'ask_custom_permission',
  'ask_permission',
  'ask_question',
  'finish',
  'wait',
  'wait_5_seconds'
]);

// Verified against installed llm-for-zotero v3.9.18 src/agent/mcp/server.ts
export const ZOTERO_READ_TOOLS = new Set([
  'load_skill',
  'library_search',
  'library_read',
  'library_retrieve',
  'paper_read',
  'literature_search',
  'literature_read',
  'past_chat_read',
  'past_chat_search',
  'past_chat_attach',
  'record_paper_decisions',
  'review_coverage',
  'paper_digest',
  'library_cite',
  'read_attachment',
  'reader_open',
  'submit_document',
  // Legacy / descriptive aliases
  'audit_library',
  'discover_related',
  'library_statistics',
  'search_items',
  'search_library',
  'get_item',
  'get_items',
  'get_fulltext',
  'get_notes',
  'list_collections'
]);

export const ZOTERO_WRITE_TOOLS = new Set([
  'library_update',
  'note_write',
  'note_write_batch',
  'library_import',
  'library_delete',
  'zotero_script',
  'undo',
  'annotate_pdf',
  'file_io',
  'run_command',
  'library_settings',
  'request_user_input',
  'task_update',
  // Legacy aliases
  'create_note',
  'append_note',
  'update_note',
  'auto_tag',
  'add_tags',
  'remove_tags',
  'complete_metadata',
  'organize_unfiled'
]);

/**
 * Returns a shallow copy of headers omitting per-turn `X-LLM-For-Zotero-Scope`.
 */
export function stripScopeHeader(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (String(k).toLowerCase() === 'x-llm-for-zotero-scope') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Classifies tool mutability and risk using explicit allow/deny metadata first
 * rather than naive substring heuristics alone.
 */
export function classifyToolMetadata(name, description = '', annotations = {}, source = 'claude-runtime') {
  const n = String(name || '').trim();
  const lower = n.toLowerCase();

  if (annotations && (annotations.destructiveHint === true || annotations.destructive === true)) {
    return {
      name: n,
      description: description || `Write/destructive tool: ${n}`,
      inputSchema: { type: 'object' },
      mutability: 'write',
      riskLevel: 'high',
      requiresConfirmation: true,
      source
    };
  }

  if (annotations && annotations.readOnlyHint === true && annotations.destructiveHint !== true && annotations.destructive !== true) {
    return {
      name: n,
      description: description || `Tool: ${n}`,
      inputSchema: { type: 'object' },
      mutability: 'read',
      riskLevel: 'low',
      requiresConfirmation: false,
      source
    };
  }

  if (READ_ONLY_NATIVE_TOOLS.has(lower) || ZOTERO_READ_TOOLS.has(lower)) {
    return {
      name: n,
      description: description || `Read-only tool: ${n}`,
      inputSchema: { type: 'object' },
      mutability: 'read',
      riskLevel: 'low',
      requiresConfirmation: false,
      source
    };
  }

  if (WRITE_NATIVE_TOOLS.has(lower) || ZOTERO_WRITE_TOOLS.has(lower)) {
    return {
      name: n,
      description: description || `Write/execution tool: ${n}`,
      inputSchema: { type: 'object' },
      mutability: 'write',
      riskLevel: 'high',
      requiresConfirmation: true,
      source
    };
  }

  if (/^(?:read|get|list|search|find|view|inspect|audit|discover|library_stat)[_-]/i.test(lower)) {
    return {
      name: n,
      description: description || `Tool: ${n}`,
      inputSchema: { type: 'object' },
      mutability: 'read',
      riskLevel: 'medium',
      requiresConfirmation: false,
      source
    };
  }

  // Conservative fallback: unknown tools are treated as potentially mutating.
  return {
    name: n,
    description: description || `agy/MCP tool: ${n}`,
    inputSchema: { type: 'object' },
    mutability: 'write',
    riskLevel: 'high',
    requiresConfirmation: true,
    source
  };
}

/**
 * Probes the local llm-for-zotero Streamable HTTP / JSON-RPC 2.0 MCP endpoint safely.
 * Sends initialize -> notifications/initialized -> tools/list matching mcpSetup.ts.
 * Never throws when Zotero is offline or unauthenticated.
 */
export async function probeZoteroMcp({
  url = 'http://127.0.0.1:23119/llm-for-zotero/mcp',
  timeoutMs = 2500,
  headers = {}
} = {}) {
  const cleanHeaders = stripScopeHeader(headers);
  const rpc = async (id, method, params = {}) => {
    const payload = id === undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params };
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...cleanHeaders
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.httpStatus = res.status;
      throw err;
    }
    if (res.status === 202 || res.status === 204) {
      return {};
    }
    const text = await res.text();
    if (!text.trim()) return {};
    const data = JSON.parse(text);
    if (data.error) {
      throw new Error(data.error.message || `JSON-RPC error ${data.error.code}`);
    }
    return data.result || {};
  };

  try {
    const init = await rpc(1, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agy-zotero-bridge', version: '0.2.0' }
    });
    await rpc(undefined, 'notifications/initialized', {}).catch(() => {});
    const list = await rpc(2, 'tools/list', {});
    const tools = Array.isArray(list.tools)
      ? list.tools
          .map((t) => ({
            name: String(t.name || ''),
            description: String(t.description || ''),
            inputSchema: t.inputSchema || { type: 'object' },
            annotations: t.annotations || {}
          }))
          .filter((t) => t.name)
      : [];

    return {
      id: 'llm_for_zotero',
      name: 'llm-for-zotero',
      transport: 'streamable-http',
      url,
      connected: true,
      status: 'connected',
      protocolVersion: init.protocolVersion || '2025-06-18',
      tools
    };
  } catch (e) {
    const httpStatus = e?.httpStatus;
    const hasAuth = Object.keys(cleanHeaders).some((k) => k.toLowerCase() === 'authorization');
    if (httpStatus === 401) {
      return {
        id: 'llm_for_zotero',
        name: 'llm-for-zotero',
        transport: 'streamable-http',
        url,
        connected: false,
        status: hasAuth ? 'unauthorized_invalid_token' : 'unauthorized_needs_zotero_turn_or_token',
        httpStatus: 401,
        tools: [],
        error: hasAuth
          ? 'HTTP 401: Zotero MCP rejected Bearer token'
          : 'HTTP 401: Zotero MCP server is active and requires Bearer auth (automatically supplied on Zotero /run-turn or via ZOTERO_MCP_TOKEN)'
      };
    }
    return {
      id: 'llm_for_zotero',
      name: 'llm-for-zotero',
      transport: 'streamable-http',
      url,
      connected: false,
      status: 'unreachable',
      tools: [],
      error: redactSensitive(e?.message || e)
    };
  }
}

/**
 * Generates exact non-mutating registration instructions for agy MCP.
 */
export function buildAgyMcpConfigSnippet({
  name = 'llm-for-zotero',
  url = 'http://127.0.0.1:23119/llm-for-zotero/mcp'
} = {}) {
  return {
    cliCommand: `agy mcp add --type http --header "Authorization: Bearer <ZOTERO_MCP_TOKEN>" ${name} ${url}`,
    mcpConfigJson: {
      mcpServers: {
        [name]: {
          url,
          headers: {
            Authorization: 'Bearer <ZOTERO_MCP_TOKEN>'
          }
        }
      }
    }
  };
}

/**
 * Builds session-only `agy` settings (`permissions.allow` / `permissions.deny`)
 * for Zotero MCP servers and safe Zotero read directories without touching global
 * `~/.gemini/antigravity-cli/settings.json` or granting wildcards like `mcp(*)` / `read_file(*)`.
 */
export function buildScopedAgySettings({ serverNames = [], allowedTools = [], readDirs = [], allowWrite = true } = {}) {
  const candidateServers = new Set();
  const addServerCandidates = (raw) => {
    const name = String(raw || '').trim();
    if (!name) return;
    candidateServers.add(name);
    candidateServers.add(`llm-for-zotero_${name}`);
    candidateServers.add(`llm_for_zotero_${name}`);
    candidateServers.add('llm-for-zotero');
    candidateServers.add('llm_for_zotero');
  };

  for (const name of serverNames) {
    addServerCandidates(name);
  }

  const allowedToolNames = new Set(ZOTERO_READ_TOOLS);
  for (const rawEntry of Array.isArray(allowedTools) ? allowedTools : []) {
    const entry = String(rawEntry || '').trim();
    if (!entry) continue;
    let toolName = entry;
    if (entry.startsWith('mcp__')) {
      const splitIdx = entry.indexOf('__', 5);
      if (splitIdx !== -1) {
        const srv = entry.slice(5, splitIdx).trim();
        toolName = entry.slice(splitIdx + 2).trim();
        if (srv) addServerCandidates(srv);
      }
    }
    if (!toolName) continue;
    if (allowWrite || classifyToolMetadata(toolName, '', {}, 'mcp').mutability === 'read') {
      allowedToolNames.add(toolName);
    }
  }
  if (allowWrite) {
    for (const wTool of ZOTERO_WRITE_TOOLS) {
      allowedToolNames.add(wTool);
    }
  }

  const allowSet = new Set();
  const denySet = new Set();
  for (const srv of candidateServers) {
    allowSet.add(`mcp(${srv}/*)`);
    for (const tool of allowedToolNames) {
      allowSet.add(`mcp(${srv}/${tool})`);
    }
    if (!allowWrite) {
      for (const wTool of ZOTERO_WRITE_TOOLS) {
        denySet.add(`mcp(${srv}/${wTool})`);
      }
    }
  }

  for (const rawDir of Array.isArray(readDirs) ? readDirs : []) {
    const dir = String(rawDir || '').trim();
    if (!dir || dir === '/' || dir === '*' || /^[A-Za-z]:[\\/]?$/.test(dir)) continue;
    allowSet.add(`read_file(${dir})`);
    allowSet.add(`view_file(${dir})`);
    if (dir.includes('\\')) {
      const posixDir = dir.replace(/\\/g, '/');
      allowSet.add(`read_file(${posixDir})`);
      allowSet.add(`view_file(${posixDir})`);
    }
  }

  return {
    permissions: {
      allow: [...allowSet],
      ...(denySet.size > 0 ? { deny: [...denySet] } : {})
    }
  };
}

/**
 * Builds workspace plugin rules (`plugins/llm-for-zotero/rules/AGENTS.md`) so `agy`
 * uses Zotero MCP tools directly, navigates `paper_read` modes efficiently, cites sources
 * cleanly per paper, respects read-only mode, and reads back modified items after writes.
 */
export function buildScopedZoteroRulesMarkdown({ serverNames = [], allowWrite = true } = {}) {
  const serversList = serverNames.length ? serverNames.map((n) => `\`${n}\``).join(', ') : '`llm-for-zotero`';
  const lines = [
    '# Zotero MCP Workspace Rules',
    '',
    '1. **Direct Zotero MCP Tool Usage**: Use `call_mcp_tool` on the active Zotero MCP server(s) (' +
      serversList +
      ') for Zotero library searches (`library_search`), reading items/notes/fulltext (`library_read`, `library_retrieve`, `paper_read`), and loading Zotero skills (`load_skill`). Do NOT run shell commands (`run_command`), because shell execution is disabled in headless safe mode.',
    '2. **Close Reading & Multimodal Figures (`paper_read`)**: Omit `activeItemId` and `activeContextItemId` to target the active paper in the current chat turn. Call `paper_read({ mode: "overview" })` at most once for high-level summary/metadata, then call `paper_read({ mode: "outline" })` to get the section list (`sectionIds` and chunk ranges), and then call `paper_read({ mode: "targeted", sectionIds: [...] })` or `paper_read({ mode: "targeted", query: "..." })` for detailed methodology, experimental setup, results, and discussion. For figure/table/diagram questions, call `paper_read({ mode: "figures", figureLabels: [...] })` (or `mode: "visual"` for rendered pages / `mode: "capture"` for the active reader view), and use `read_file` or `view_file` on any returned figure crop paths (`artifacts[].storedPath`) or materialized image paths from this prompt to inspect panels visually alongside captions and `targeted` text. Use returned crop `file://` links as-is in `note_write`; do NOT inspect `figure_crops` metadata or read/embed raw MinerU source image paths. If crop extraction fails (`no_figures` / `error`), state clearly that analysis relies on captions and text only.',
    '3. **Multi-Paper Citation & Modality Honesty**: When answering across multiple papers, always attribute findings explicitly by paper title, author/year, and Zotero `libraryID`/`itemKey`/`itemId` without mixing content across papers. Clearly separate direct textual evidence from visual inspection of crop/screenshot images, and never claim to have inspected pixels that were not opened via `read_file`/`view_file`.',
    allowWrite
      ? '4. **Direct Zotero Library Modification & Readback Verification**: Write tools (`note_write`, `note_write_batch`, `library_update`, `library_import`, `library_delete`, `annotate_pdf`, `file_io`, `undo`, `zotero_script`, etc.) are enabled (`writeEnabled: true`) and may be invoked directly via `call_mcp_tool` to create or modify Zotero notes, tags, collections, and items. Before modifying items, notes, or tags, inspect the target item first, support dry-run preview if requested, and immediately read back the modified item/note via `library_read` or `paper_read` to confirm the change succeeded.'
      : '4. **Strict Read-Only Mode**: Write mode is disabled (`writeEnabled: false`). Only invoke read-only Zotero MCP tools; do not attempt to create/edit notes, tags, metadata, or delete library items, and clearly inform the user if a task requires write permission.',
    '5. **Batch Literature Review & Ultra-Long Context (8–50+ Papers)**: When comparing or reviewing many papers or a collection/tag scope, never try to read every full paper in one unbatched step. Follow a 3-tier strategy: (a) establish the paper ledger using the supplied Multi-Paper Scope Manifest, `library_search`, `library_retrieve({ intent: "enumerate" | "summarize" })`, or `paper_digest`; (b) batch `paper_read` with `targets` (3–6 related papers per call) and drill down via `mode: "outline"` -> `mode: "targeted"`; (c) record coverage via `review_coverage` / `record_paper_decisions` and explicitly state the coverage frontier (how many papers were read in full vs in part vs metadata-only) and preserve negative or contradictory findings.'
  ];
  return lines.join('\n') + '\n';
}

/**
 * Writes session-only `<cwd>/.agents/session-settings.json` with Zotero MCP and read-dir rules.
 */
export async function writeScopedAgySettingsFile({
  cwd,
  serverNames = [],
  allowedTools = [],
  readDirs = [],
  allowWrite = true
} = {}) {
  const agentsDir = join(cwd, '.agents');
  const settingsFile = join(agentsDir, 'session-settings.json');
  const settings = buildScopedAgySettings({
    serverNames,
    allowedTools,
    readDirs,
    allowWrite
  });
  await mkdir(agentsDir, { recursive: true });
  await writeFile(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  return { settingsFile, settings };
}

/**
 * Provisions a workspace-local `.agents/plugins/llm-for-zotero/` bundle and ephemeral
 * `.agents/session-settings.json` inside `cwd` so `agy` receives scoped Zotero MCP tools,
 * workspace rules, and read/write MCP/read_file allow-rules without modifying global config.
 */
export async function prepareScopedMcpPlugin({ cwd, mcpServers, allowedTools = [], readDirs = [], allowWrite = true }) {
  if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
    return null;
  }

  const normalizedServers = {};
  const headersByServer = {};
  const summary = [];

  for (const [rawName, rawConfig] of Object.entries(mcpServers)) {
    const name = String(rawName || '').trim();
    if (!name || !rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) continue;
    const url = typeof rawConfig.url === 'string' ? rawConfig.url.trim() : typeof rawConfig.serverUrl === 'string' ? rawConfig.serverUrl.trim() : '';
    if (!url) continue;

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') continue;

    const rawHeaders = rawConfig.headers && typeof rawConfig.headers === 'object' && !Array.isArray(rawConfig.headers)
      ? rawConfig.headers
      : {};
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).map(([k, v]) => [String(k), String(v ?? '')])
    );

    normalizedServers[name] = { url, headers };
    headersByServer[name] = { url, headers };
    summary.push({ name, url, hasAuth: Object.keys(headers).some((k) => k.toLowerCase() === 'authorization') });
  }

  if (summary.length === 0) return null;

  const agentsDir = join(cwd, '.agents');
  const pluginDir = join(agentsDir, 'plugins', 'llm-for-zotero');
  const rulesDir = join(pluginDir, 'rules');
  const headersFile = join(agentsDir, 'zotero-mcp-headers.json');
  const rulesFile = join(rulesDir, 'AGENTS.md');
  const serverNames = Object.keys(normalizedServers);

  await mkdir(rulesDir, { recursive: true });
  await writeFile(
    headersFile,
    JSON.stringify({ servers: headersByServer, updatedAt: Date.now() }, null, 2),
    { encoding: 'utf8', mode: 0o600 }
  );
  const { settingsFile, settings } = await writeScopedAgySettingsFile({
    cwd,
    serverNames,
    allowedTools,
    readDirs,
    allowWrite
  });
  await writeFile(
    rulesFile,
    buildScopedZoteroRulesMarkdown({ serverNames, allowWrite }),
    'utf8'
  );

  await writeFile(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ name: 'llm-for-zotero' }, null, 2),
    'utf8'
  );

  const mcpServersConfig = {};
  for (const name of serverNames) {
    mcpServersConfig[name] = {
      command: process.execPath,
      args: [PROXY_SCRIPT_PATH, '--server', name, '--headers-file', headersFile],
      env: {
        ZOTERO_MCP_ALLOW_WRITE: allowWrite ? '1' : '0'
      }
    };
  }

  await writeFile(
    join(pluginDir, 'mcp_config.json'),
    JSON.stringify({ mcpServers: mcpServersConfig }, null, 2),
    'utf8'
  );

  return {
    pluginDir,
    headersFile,
    settingsFile,
    rulesFile,
    settings,
    servers: normalizedServers,
    summary
  };
}
