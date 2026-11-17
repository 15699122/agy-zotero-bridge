# Changelog

## v1.0.0 (2026-11-17)

### Fixed (Base Model & Thinking Level Separation)
- **Grouped Model Catalog & `(model, effort)` Normalization (`src/agy/cli-probe.mjs`, `src/agy/process-runner.mjs`)**: Added `splitModelVariant` and `resolveAgyModelAndEffort` so `agy models` thinking-level variants (e.g. `gemini-3.8-flash-low/medium/high`, `gemini-4-hydrogen-xhigh`, `claude-opus-5-5-*`, `claude-sonnet-5-5-*`, `gpt-oss-120b-medium`) are grouped into clean base models with `supportedEffortLevels` in `GET /models`, letting Zotero's `默认模型` dropdown select the model and `默认推理` select the Thinking Level independently. `GET /efforts`, `runTurnStream`, and `runStructuredCompletion` normalize both base IDs and legacy suffixed IDs, omit `--effort` when Zotero sends `'auto'`/`'default'`, clamp unsupported `xhigh`/`max` requests safely, and preserve fixed-effort models (`gemini-pro-orchestrator-g1-pro`, `gpt-oss-120b`).

### Changed (User-Requested Direct Zotero Library Modification)
- **Direct Zotero Write Access Enabled by Default (`writeEnabled: true`)**: Updated `createConfig`, `buildScopedAgySettings`, `buildScopedZoteroRulesMarkdown`, `prepareScopedMcpPlugin`, `writeScopedAgySettingsFile`, `stdio-http-proxy.mjs`, and `runTurnStream` so Zotero MCP write tools (`note_write`, `note_write_batch`, `library_update`, `library_import`, `library_delete`, `annotate_pdf`, `file_io`, `undo`, `zotero_script`, etc.) are permitted directly by default with post-write readback verification rules. Strict read-only mode remains available via `AGY_ZOTERO_MCP_ALLOW_WRITE=0` or `permissionMode: "plan"`.

### Added (M4 Persistent Pool & Live M3 Confirmation)
- **Live Zotero Manual Verification**: User confirmed single-paper close reading / experiment analysis and cross-paper comparison passed live testing on Zotero `10.0.8` + `llm-for-zotero v3.9.19`.
- **Full M4 Persistent `stdin stream-json` Process Reuse (`src/agy/process-runner.mjs`)**: Verified `agy.exe 1.5.9` `--input-format stream-json --output-format stream-json --print=` interface; wired warm child creation, per-turn signature validation, `{"event":"user","message":{"content":...}}` streaming, cumulative usage delta normalization (`normalizeCumulativeUsage`), and immediate error/abort process-tree cleanup when `AGY_PROCESS_POOL=1`.
- **Expanded Tests (`test/mock-agy.mjs`, `test/unit.test.mjs`, `test/bridge.test.mjs`)**: Total **47 / 47** passing tests (`25` unit tests + `22` integration tests), verifying default `writeEnabled: true`, `AGY_ZOTERO_MCP_ALLOW_WRITE=0` opt-out, persistent PID reuse across pooled turns, `/invalidate-session` respawn, and grouped base-model / `(model, effort)` normalization.

## v0.3.0 (2026-11-17)

### Added & Verified Live (Zotero `10.0.8` + `llm-for-zotero v3.9.19`)
- **Live Read-Only Zotero E2E Verified**: Confirmed `GET /mcp-servers?probe=1` returns `connected: true` (`toolCount: 27`, `protocolVersion: "2025-06-18"`, `writeEnabled: false`) and Zotero `Library chat` (`gemini-3.8-flash-low`) retrieves paper titles, authors, and years via Zotero MCP without `yolo` or global config mutation.
- **Workspace Plugin Rules (`src/mcp/zotero-mcp.mjs`)**: Generates `.agents/plugins/llm-for-zotero/rules/AGENTS.md` per scoped workspace (`buildScopedZoteroRulesMarkdown`) directing `agy` to call Zotero MCP tools directly instead of attempting disabled `run_command` shell probes, enforcing multi-paper citation attribution, and requiring readback verification when `AGY_ZOTERO_MCP_ALLOW_WRITE=1`.
- **Early Cut-Off Guard (`src/protocol/event-mapper.mjs`)**: Rejects `result` events whose `finished_reason` indicates truncation (`print_timeout`, `interrupted`, or error reasons) even if `status === "SUCCESS"`, mapping cleanly to `timeout` / `cancelled`.
- **Opt-In M4 Process Pool & Usage Normalization (`src/agy/process-pool.mjs`, `src/http/server.mjs`, `src/config.mjs`)**: Added `SessionProcessPool` (`AGY_PROCESS_POOL=1`, `AGY_POOL_MAX_SIZE`, `AGY_POOL_IDLE_TTL_MS`) with LRU eviction, `.unref()` TTL timers, `/runtime-retention`, `/invalidate-session`, `/invalidate-all-hot-runtimes` integration, and non-negative `normalizeCumulativeUsage` deltas.
- **Expanded Automated Coverage**: Total **44 / 44** passing tests (`23` unit tests in `test/unit.test.mjs`, `21` integration tests in `test/bridge.test.mjs`).

### Fixed
- **Paper Close-Reading `read_file` Headless Auto-Denial & `paper_read` Guidance (`src/context/prompt-builder.mjs`, `src/mcp/zotero-mcp.mjs`, `src/agy/process-runner.mjs`)**: Added safe non-root Zotero read-directory discovery (`~/Zotero`, `~/OneDrive`, `~/Documents`, `~/Downloads`, and existing paths extracted from `customInstruction`) passed via `--add-dir` and ephemeral `read_file(<dir>)` entries in `session-settings.json`, plus explicit `paper_read` (`overview` -> `outline` -> `targeted` with `sectionIds`/`query`) instructions in `.agents/plugins/llm-for-zotero/rules/AGENTS.md`.

## v0.2.0 (2026-11-17)

### Added
- **Modular Architecture (`src/`)**: Split `bridge.mjs` cleanly into focused ESM modules (`src/config.mjs`, `src/http/server.mjs`, `src/agy/cli-probe.mjs`, `src/agy/process-runner.mjs`, `src/protocol/event-mapper.mjs`, `src/session/session-store.mjs`, `src/context/prompt-builder.mjs`, `src/mcp/zotero-mcp.mjs`, `src/security/redact.mjs`) while preserving `node bridge.mjs` entrypoint and HTTP backwards compatibility.
- **`POST /structured-completion`**: Stateless headless completion endpoint with `--json-schema` support, `timeoutMs` clamping, client abort cleanup, markdown JSON fence stripping, and strict JSON validation (never touches session storage).
- **Real `agy 1.5.9` Model & Effort Discovery**: `parseModelsStdout` now strips leading `"Fetching available models..."` status lines emitted by `agy.exe 1.5.9`; `GET /efforts` supports per-model capability queries (`?model=<id>`) with conservative `['default']` fallback for unknown models.
- **Separated Health Diagnostics (`GET /healthz`)**: Distinguishes `bridgeAlive`, `agyInstalled`, `agyAvailable`, and `agyAuthenticated: null` (`authStatus: 'unverified'`) rather than inferring authentication from `--version`.
- **Error Classification & Secret Redaction**: Structured classification (`rate_limited`, `auth_failed`, `model_not_supported`, `permission_denied`, `missing_result`, `timeout`, `cancelled`, `process_exit_error`) and automatic scrubbing of Bearer tokens, API keys, bridge tokens, credential filenames, and user home paths.
- **Windows Process Tree Cleanup & Atomic Persistence**: Uses `taskkill /PID ... /T /F` alongside `child.kill()` on Windows and retryable atomic temp-file renames for `sessions.json`.
- **M2/M3 Safe Foundations (Aligned with `llm-for-zotero v3.9.18`)**:
  - `src/mcp/zotero-mcp.mjs` & `src/mcp/stdio-http-proxy.mjs`: Supports `initialize` -> `notifications/initialized` -> `tools/list`, clear `HTTP 401` diagnostics, dynamic per-turn capture of Zotero `body.mcpServers` Bearer/Scope headers into workspace-local `<scopedCwd>/.agents/plugins/llm-for-zotero/` (without writing tokens into `mcp_config.json` or `~/.gemini/config/mcp_config.json`), and exact classification of all 47 `agy 1.5.9` tools + `llm-for-zotero v3.9.18` MCP tools.
  - `src/agy/cli-probe.mjs`: Emits `supportsEffort`, `supportedEffortLevels` (upstream `modelCatalog.ts` shape), and advertises `local_pdf_paths` in `/healthz`.
  - `src/context/prompt-builder.mjs`, `src/agy/process-runner.mjs`, & `src/security/redact.mjs`: Upstream `runtimeRequest.localDocuments` (`%PDF-` signature validation, `--add-dir`, ephemeral non-resumed turn, streaming `[local-pdf-path:...]` redaction), untrusted `<zotero_reference_context>` wrapping, first-turn-only skill loading (`AGY_SKILLS_DIR`), and strict `validateLocalFilePath` checks.
- **Tests & Smoke Tooling**: Added `test/fixtures/ndjson-samples.mjs`, `test/unit.test.mjs` (19 unit tests), 10 new HTTP integration tests in `test/bridge.test.mjs` (total 39 tests), `scripts/smoke-real-agy.ps1`, `docs/UPSTREAM_CONTRACT.md`, and `docs/TEST_REPORT.md`.

### Fixed
- **Headless Zotero MCP Permissions via Ephemeral `--settings`**: `src/mcp/zotero-mcp.mjs` and `src/agy/process-runner.mjs` now emit session-only `<scopedCwd>/.agents/session-settings.json` (`permissions.allow` for read-only Zotero MCP targets across plugin-namespaced aliases and `permissions.deny` for write tools when read-only) passed via `agy --settings`, preventing headless `"mcp"` auto-denials without enabling `yolo` or modifying global `settings.json`.
- **Expired `X-LLM-For-Zotero-Scope` Header Handling & Hard Proxy Read-Only Guard**: `src/http/server.mjs` and `probeZoteroMcp` strip ephemeral per-turn `X-LLM-For-Zotero-Scope` headers for post-turn `/mcp-servers?probe=1` checks; `src/mcp/stdio-http-proxy.mjs` blocks write `tools/call` and filters write tools from `tools/list` when read-only, and retries discovery methods (`initialize`, `tools/list`, `notifications/initialized`) without expired scope headers.

### Changed
- `POST /run-turn` client disconnect listener now checks `!res.writableFinished` before aborting and resolves child exit within a bounded grace window.
- `bridge.mjs` redacts configured `AGY_BRIDGE_TOKEN` in startup console logs and rejects non-loopback `AGY_BRIDGE_HOST` unless `AGY_ALLOW_REMOTE=1`.

## v0.1.0 (2026-11-17)
- Initial standalone `agy` headless v0 HTTP bridge baseline (`bridge.mjs`, 10 mock integration tests).
