# Upstream Contract & Source Verification Matrix

> Last updated: 2026-11-17  
> Target Bridge Version: `agy-zotero-bridge v1.0.0`  
> Official `agy` CLI inspected: `%USERPROFILE%\.gemini\bin\agy.exe` (`1.5.9`)  
> Installed `llm-for-zotero` plugin inspected & E2E verified: `zotero-llm@github.com.yilewang.xpi` (`v3.9.18` / `v3.9.19`) on Zotero `10.0.8`

## 1. Source Verification Status

| Source | Status | What Was Verified | Notes |
| --- | --- | --- | --- |
| Installed `llm-for-zotero v3.9.18` / `v3.9.19` (`content/claude-bridge/bridge.mjs` & `content/scripts/llmforzotero.js` inside `.xpi`, plus live Zotero E2E) | ✅ Verified directly | Exact HTTP routes (`/healthz`, `/structured-completion`, `/models`, `/efforts`, `/tools`, `/mcp-servers`, `/commands`, `/permission-modes`, `/session-info`, `/account-quota`, `/run-turn`, `/run-action`, `/resolve-confirmation`, `/invalidate-session`, `/runtime-retention`, `/invalidate-all-hot-runtimes`), `RuntimeModelInfo` fields, `local_pdf_paths` contract, live Zotero `10.0.8` MCP (`27` tools, `protocolVersion: "2025-06-18"`), library search, single-paper close reading / experiment analysis, and cross-paper comparison | Direct write (`writeEnabled: true`) is now enabled by default per user request (`AGY_ZOTERO_MCP_ALLOW_WRITE=0` or `plan` mode restricts to read-only) |
| Official `agy.exe 1.5.9` (`--version`, `--help`, `models`, `help mcp`, `--settings`, `--input-format stream-json`, live smoke & Zotero UI E2E) | ✅ Verified directly | All CLI flags including `['--input-format', 'stream-json', '--output-format', 'stream-json', '--print=']`, `18` raw variants grouped into `7` base model IDs + base-model `--effort` execution (`agy -p ... --model gemini-3.8-flash --effort low`), `"Fetching available models..."` banner, 47 `init.tools`, `FinishedReason`, real `/structured-completion`, `--settings <file>` validation (MCP + `read_file(<dir>)`), and live Zotero UI execution | Persistent `stdin` multi-turn pooling (`AGY_PROCESS_POOL=1`) wired into `runTurnStream` (`v0` one-process-per-turn remains default unless `AGY_PROCESS_POOL=1`) |
| Built-in Antigravity customization docs (`antigravity-guide`, `agy-customizations`) | ✅ Verified directly | Workspace plugin discovery (`.agents/plugins/<name>/plugin.json` + `mcp_config.json`), Stdio vs Streamable HTTP MCP transport | Used to safely inject per-turn Zotero MCP inside `<scopedCwd>` without modifying `~/.gemini/config/mcp_config.json` |
| `agy-zotero-bridge` baseline (`v0.1.0`) | ✅ Verified directly | Original 10 integration tests & wire envelope | All 10 original baseline tests remain passing |
| Built-in `llm-for-zotero` Managed Bridge & `@anthropic-ai/claude-agent-sdk` (`claude-code-agy.mjs`, `src/claude-sdk/cli-shim.mjs`) | ✅ Verified against installed `.xpi` | Examined `resolveClaudeBridgeBinary`, `resolveWindowsClaudeShim`, `launchBridge()`, `CLAUDE_BRIDGE_READY`, and SDK `0.3.220` `--input-format stream-json` / `--output-format stream-json` `control_request` (`initialize`, `mcp_status`, `mcp_set_servers`, `set_model`, `set_permission_mode`, `get_context_usage`, `interrupt`) & `user` frames | Allows setting `claude-code-agy.mjs` or `claude-code-agy.cmd` directly in Zotero **Claude Code path** without manual server startup |

## 2. Verified `llm-for-zotero v3.9.18` Upstream Contract

### 2.1 `GET /healthz` & Capabilities
- `src/agent/externalBackendBridge.ts` checks `capabilities.includes("local_pdf_paths")` before allowing raw PDF turns.
- `src/claudeCode/structuredCompletion.ts` checks `capabilities.includes("structured_completion_v1")` before calling `POST /structured-completion`.
- `src/claudeCode/permissionModes.ts` checks `capabilities.includes("permission_modes_v1")`.
- Our bridge advertises: `["local_pdf_paths", "model_catalog_v1", "permission_modes_v1", "structured_completion_v1"]` and separates `agyInstalled` from `agyAuthenticated: null` (`authStatus: "unverified"`).

### 2.2 `GET /models` (`src/claudeCode/modelCatalog.ts`) & Thinking Level Separation
- Reads `{ models: string[], modelInfos: RuntimeModelInfo[] }`.
- Each `modelInfos` entry supports: `value`, `displayName`, `description`, `supportsEffort` (boolean), `supportedEffortLevels` (`string[]` excluding `'default'`), `supportsAdaptiveThinking`, `supportsFastMode`, `supportsAutoMode`.
- Because `agy models` emits thinking-level variant IDs (e.g. `gemini-3.8-flash-low`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-high`), `splitModelVariant` + `parseModelsStdout` group raw variants by base model ID (`gemini-3.8-flash`, `Gemini 3.8 Flash`, `supportedEffortLevels: ['low', 'medium', 'high']`) so Zotero's `默认模型` dropdown stays concise and orthogonal to `默认推理`.
- During `/efforts`, `/run-turn`, and `/structured-completion`, `resolveAgyModelAndEffort` accepts both base model IDs and legacy suffixed IDs, pairs `--model <baseId>` with `--effort <level>` (converting `'auto'`/`'default'`/`'none'` to omitted `--effort`, clamping unsupported `xhigh`/`max` to the model's highest supported level, and preserving fixed-effort models).

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
- **Curated Zotero MCP Tools (`v3.9.18` / `v3.9.19`)**:
  - Read: `load_skill`, `library_search`, `library_read`, `library_retrieve`, `paper_read`, `literature_search`, `literature_read`, `past_chat_read`, `past_chat_search`, `past_chat_attach`, `record_paper_decisions`, `review_coverage`, `paper_digest`, `library_cite`, `read_attachment`, `reader_open`, `submit_document`.
  - Write / High-Risk: `library_update`, `note_write`, `note_write_batch`, `library_import`, `library_delete`, `zotero_script`, `undo`, `annotate_pdf`, `file_io`, `run_command`, `library_settings`, `request_user_input`, `task_update`.

## 3. Verified Upstream Extension Contracts (`M5` – `M7` Research)

### 3.1 Multimodal Screenshots, SDK Image Blocks & PDF Figure Crops (`M5-01`)
- **Upstream Sources**: `packages/claude-bridge/src/runtime.ts` (`parseImageDataUrl`, `loadAttachmentImagePayloads`, `buildPromptInput`), `src/services/pdf/pdfFigureCropCache.ts` (`PDF_FIGURE_CROP_STANDALONE_ROOT_DIR = "llm-for-zotero-pdf-figure-crops"`), `src/agent/skills/analyze-figures.md` (v12).
- **Contract**:
  - HTTP `/run-turn` may carry base64 `data:image/...;base64,...` screenshots in `runtimeRequest.screenshots[]` (up to 8 images) and local image entries (`category: "image"` or `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp` `storedPath`) in `runtimeRequest.attachments[]`.
  - Direct `Claude Code path` SDK `user` JSONL frames may carry `message.content[]` items with `{ type: "image", source: { type: "base64", media_type, data } }` or `image_url` data URLs.
  - Zotero MCP `paper_read({ mode: "figures" | "visual" | "capture" })` extracts figure crops to `<ZoteroDataDir|ProfileDir|tmpdir>/llm-for-zotero-pdf-figure-crops/<attachmentId>/figure_crops/crops/...` and returns crop paths in `artifacts[].storedPath`.
  - **Bridge Support**: Validates image buffer magic bytes (PNG/JPEG/GIF/WEBP, `<= 20 MB`), materializes base64 images into `<cwd>/.agents/multimodal-inputs/`, grants both `read_file(<dir>)` and `view_file(<dir>)` rules in `session-settings.json`, and injects explicit instructions for `read_file`/`view_file` inspection plus clean text-only fallback on `no_figures`/`error`.

### 3.2 Batch Literature Review & Ultra-Long Context Compaction (`M5-02`)
- **Upstream Sources**: `packages/claude-bridge/src/runtime.ts` (`collectPaperPathEntries`, limit 8/6/4), `src/agent/skills/literature-review.md` (v20), `src/agent/skills/compare-papers.md` (v13).
- **Contract**:
  - Multi-paper scopes (8–50+ items or collection/tag scopes) can exceed raw 200 KB JSON slices; naive string slicing produces invalid JSON and drops trailing `User request:` or paper IDs.
  - **Bridge Support**: `extractPaperScopeManifest` extracts all selected/fullText/pinned papers cleanly without an 8-paper cap; `compactRuntimeContext` progressively compacts heavy full-text/abstract/history fields into guaranteed valid JSON; `assembleTailSafePrompt` protects `User request:` and attachment tails; `AGY_RATE_LIMIT_MAX_RETRIES` / `AGY_RATE_LIMIT_RETRY_DELAY_MS` performs bounded backoff retry on transient pre-tool-execution HTTP 429s.

### 3.3 Customizable Note & Tag Templates (`M6-02` Research)
- **Upstream Sources**: `src/agent/skills/write-note.md` (v19), `src/agent/skills/reorganize-library.md` (v3), `prefs.js` (`seededSkillsDir`, `skillBodyHashes`, `obsidianVaultPath`, `obsidianAttachmentsFolder`, `notesDirectoryNickname`).
- **Findings**: Zotero notes (`note_write`) omit YAML frontmatter and embed crop `file://` image links directly, whereas Obsidian/Markdown notes (`submit_document` -> `file_io`) emit structured YAML frontmatter (`title`, `citekey`, `doi`, `year`, `journal`, `created`, `tags`). Customizations modified in `seededSkillsDir` are protected by `skillBodyHashes`. Planned template injection (`~/.agy-zotero-bridge/templates.json`) must preserve unchanged-save (`sourceMessageId`) and narrow figure-only note scopes.

### 3.4 Hot Runtime Pooling & TTFT Tuning (`M7-01` Research)
- **Upstream Sources**: `content/claude-bridge/bridge.mjs` (`hotRuntimePool`, `startHotTurn`, `warmHotRuntime`, `/runtime-retention`), `src/agent/mcp/server.ts` (`ZOTERO_MCP_SCOPE_HEADER`).
- **Findings**: Managed Zotero mode keeps `claude-code-agy.mjs` warm across turns via `hotRuntimePool`; HTTP Bridge mode supports warm `agy.exe --input-format stream-json --output-format stream-json --print=` pooling via `SessionProcessPool` (`AGY_PROCESS_POOL=1`). Because `stdio-http-proxy.mjs` reloads `.agents/zotero-mcp-headers.json` on each JSON-RPC message, per-turn `X-LLM-For-Zotero-Scope` rotation works without restarting warm child processes, provided `poolSignature` includes `readDirs` + `mcpSettingsFile` and `--print-timeout` / mid-turn crash isolation rules are respected.

### 3.5 Local Semantic Search & Embedding Proxy (`M7-02` ✅ Implemented)
- **Upstream Sources**: `content/scripts/llmforzotero.js` (`callEmbeddings`, `getResolvedEmbeddingConfig`, `orderEmbeddingResponse`), `prefs.js` (`embeddingProvider`, `embeddingApiBase`, `embeddingApiKey`, `embeddingModel`).
- **Contract & Implementation**: `llm-for-zotero` calls `POST <embeddingApiBase>/embeddings` expecting OpenAI `{ model, input }` -> `{ data: [{ index, embedding }] }` format and explicitly permits empty `embeddingApiKey` when `embeddingProvider === "custom"`. The bridge now exposes `POST /v1/embeddings` (plus `/embeddings` and `GET /v1/embeddings/status`), advertises `'embeddings_v1'` in `/healthz`, provides a built-in zero-dependency multilingual (EN + CJK) local semantic vectorizer (`agy-local-ngram-v1`) with persistent SHA-256 LRU disk caching, and proxies upstream OpenAI/Gemini/Ollama backends with chunked batching and automatic 429 retry backoff.
