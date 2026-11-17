# Upstream Contract & Source Verification Matrix

> Last updated: 2026-11-17  
> Target Bridge Version: `agy-zotero-bridge v1.0.0`  
> Official `agy` CLI inspected: `%USERPROFILE%\.gemini\bin\agy.exe` (`1.5.9`)  
> Installed `llm-for-zotero` plugin inspected & E2E verified: `zotero-llm@github.com.yilewang.xpi` (`v3.9.18` / `v3.9.19`) on Zotero `10.0.8`

## 1. Source Verification Status

| Source | Status | What Was Verified | Notes |
| --- | --- | --- | --- |
| Installed `llm-for-zotero v3.9.18` / `v3.9.19` (`content/claude-bridge/bridge.mjs` & `content/scripts/llmforzotero.js` inside `.xpi`, plus live Zotero E2E) | ✅ Verified directly | Exact HTTP routes (`/healthz`, `/structured-completion`, `/models`, `/efforts`, `/tools`, `/mcp-servers`, `/commands`, `/permission-modes`, `/session-info`, `/account-quota`, `/run-turn`, `/run-action`, `/resolve-confirmation`, `/invalidate-session`, `/runtime-retention`, `/invalidate-all-hot-runtimes`), `RuntimeModelInfo` fields, `local_pdf_paths` contract, live Zotero `10.0.8` MCP (`27` tools, `protocolVersion: "2025-06-18"`), library search, single-paper close reading / experiment analysis, and cross-paper comparison | Direct write (`writeEnabled: true`) is now enabled by default per user request (`AGY_ZOTERO_MCP_ALLOW_WRITE=0` or `plan` mode restricts to read-only) |
| Official `agy.exe 1.5.9` (`--version`, `--help`, `models`, `help mcp`, `--settings`, `--input-format stream-json`, live smoke & Zotero UI E2E) | ✅ Verified directly | All CLI flags including `['--input-format', 'stream-json', '--output-format', 'stream-json', '--print=']`, 18 model IDs, `"Fetching available models..."` banner, 47 `init.tools`, `FinishedReason`, real `/structured-completion`, `--settings <file>` validation (MCP + `read_file(<dir>)`), and live Zotero UI execution | Persistent `stdin` multi-turn pooling (`AGY_PROCESS_POOL=1`) wired into `runTurnStream` (`v0` one-process-per-turn remains default unless `AGY_PROCESS_POOL=1`) |
| Built-in Antigravity customization docs (`antigravity-guide`, `agy-customizations`) | ✅ Verified directly | Workspace plugin discovery (`.agents/plugins/<name>/plugin.json` + `mcp_config.json`), Stdio vs Streamable HTTP MCP transport | Used to safely inject per-turn Zotero MCP inside `<scopedCwd>` without modifying `~/.gemini/config/mcp_config.json` |
| `agy-zotero-bridge` baseline (`v0.1.0`) | ✅ Verified directly | Original 10 integration tests & wire envelope | All 10 original baseline tests remain passing |

## 2. Verified `llm-for-zotero v3.9.18` Upstream Contract

### 2.1 `GET /healthz` & Capabilities
- `src/agent/externalBackendBridge.ts` checks `capabilities.includes("local_pdf_paths")` before allowing raw PDF turns.
- `src/claudeCode/structuredCompletion.ts` checks `capabilities.includes("structured_completion_v1")` before calling `POST /structured-completion`.
- `src/claudeCode/permissionModes.ts` checks `capabilities.includes("permission_modes_v1")`.
- Our bridge advertises: `["local_pdf_paths", "model_catalog_v1", "permission_modes_v1", "structured_completion_v1"]` and separates `agyInstalled` from `agyAuthenticated: null` (`authStatus: "unverified"`).

### 2.2 `GET /models` (`src/claudeCode/modelCatalog.ts`)
- Reads `{ models: string[], modelInfos: RuntimeModelInfo[] }`.
- Each `modelInfos` entry supports: `value`, `displayName`, `description`, `supportsEffort` (boolean), `supportedEffortLevels` (`string[]` excluding `'default'`), `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`.

### 2.3 `POST /structured-completion` (`src/claudeCode/structuredCompletion.ts`)
- Request: `{ prompt, model?, timeoutMs? }` (our bridge also accepts `messages`, `systemPrompt`, `schema` / `jsonSchema`).
- Response: `{ text, usage? }` (plus optional `data`/`parsed` when schema requested).
- Enforces `timeoutMs` (clamped `1000..600000`) and client abort without touching `sessions.json`.

### 2.4 `runtimeRequest.localDocuments` (`packages/claude-bridge/src/local-pdf.ts`)
- Zotero sends `localDocuments: [{ kind: "local_pdf", sourceKey: "zotero-pdf:<itemId>:<contextItemId>", itemId, contextItemId, title, name, mimeType: "application/pdf", absolutePath }]`.
- Bridge validates exact schema, regular file size >= 5 bytes, 5-byte `%PDF-` signature (and `allowedPdfRoots` when configured), adds parent dirs via `--add-dir`, treats raw-PDF turns as ephemeral (no `--conversation` resume/save), and replaces any occurrence of `absolutePath` in streamed deltas/events/outcomes with `[local-pdf-path:<sourceKey>]`.

### 2.5 Zotero MCP Endpoint (`src/agent/mcp/server.ts`, `src/codexAppServer/mcpSetup.ts`)
- **URL**: `http://127.0.0.1:23119/llm-for-zotero/mcp` (or Zotero's `httpServer.port`).
- **Transport**: JSON-RPC 2.0 (`protocolVersion: "2025-06-18"`), methods `initialize`, `notifications/initialized`, `tools/list`, `tools/call`.
- **Authentication**: Requires `Authorization: Bearer <codexZoteroMcpBearerToken>` (unauthenticated probes return `HTTP 401 {"error":"unauthorized"}`), plus per-turn `X-LLM-For-Zotero-Scope: <scopeToken>` which is registered at turn start and cleared immediately after `runTurn` ends (`"Zotero MCP scope token is invalid or expired"` if reused post-turn).
- **Per-Turn Injection & Ephemeral Permissions**:
  - During `POST /run-turn`, Zotero passes `body.mcpServers` containing the server `url` and `headers` (and `allowedTools` for read-only pre-approvals). The bridge isolates these into `<scopedCwd>/.agents/zotero-mcp-headers.json` and provisions `<scopedCwd>/.agents/plugins/llm-for-zotero/` using `src/mcp/stdio-http-proxy.mjs` so `agy` gets scoped Zotero tools without putting secrets into CLI args or modifying `~/.gemini/config/mcp_config.json`.
  - Because `agy.exe 1.5.9` auto-denies unconfigured `"mcp"` and external `"read_file"` calls in headless mode, the bridge generates ephemeral `<scopedCwd>/.agents/session-settings.json` with `permissions.allow` (`mcp(<server>/<tool>)`, plugin-namespaced aliases, and `read_file(<dir>)` for safe Zotero read roots) + `rules/AGENTS.md`, and passes `--settings <settingsFile>` for non-`plan` turns. Direct Zotero writes (`writeEnabled: true`) are enabled by default per user request; setting `AGY_ZOTERO_MCP_ALLOW_WRITE=0` or `permissionMode: "plan"` adds explicit `permissions.deny` rules and enforces hard write-blocking + `tools/list` filtering inside `stdio-http-proxy.mjs`.
  - Standalone probes (`probeZoteroMcp`, `capturedMcpServers` in `GET /mcp-servers?probe=1`) strip `X-LLM-For-Zotero-Scope` and retain only `Authorization`, and `stdio-http-proxy.mjs` retries discovery (`initialize`, `tools/list`, `notifications/initialized`) without the scope header if Zotero reports an expired scope token.
- **Curated Zotero MCP Tools (`v3.9.18`)**:
  - Read: `load_skill`, `library_search`, `library_read`, `library_retrieve`, `paper_read`, `literature_search`, `literature_read`, `past_chat_read`, `past_chat_search`, `past_chat_attach`, `record_paper_decisions`, `review_coverage`, `paper_digest`, `library_cite`, `read_attachment`, `reader_open`, `submit_document`.
  - Write / High-Risk: `library_update`, `note_write`, `note_write_batch`, `library_import`, `library_delete`, `zotero_script`, `undo`, `annotate_pdf`, `file_io`, `run_command`, `library_settings`, `request_user_input`, `task_update`.
