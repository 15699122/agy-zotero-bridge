# Test & Verification Report (`v1.1.0` / `agy 1.5.11` follow-up)

> Date: 2026-11-19  
> Environment: Windows (PowerShell), Node.js `v26.13.1`, official `agy.exe` `1.5.11` (upgraded from `1.5.9`, `%USERPROFILE%\.gemini\bin\agy.exe`), Zotero `10.0.8` + `llm-for-zotero v3.9.19`

## 1. Automated Test Results (Mock CLI & Unit Tests)

> **Important distinction**: Automated `npm test` and `npm run test:unit` verify bridge logic, HTTP/NDJSON framing, `claude-code-agy.mjs` stdio `@anthropic-ai/claude-agent-sdk` shim protocol, managed `bridge.mjs` CLI flags (`CLAUDE_BRIDGE_READY`, `ADAPTER_AUTH_TOKEN`, `--exit-on-stdin-close`), error handling, `finished_reason` guards, secret/PDF-path redaction, local PDF `%PDF-` checks, MCP Bearer token capture, per-turn ephemeral `--settings` & `rules/AGENTS.md` generation, default direct-write permissions (`AGY_ZOTERO_MCP_ALLOW_WRITE=0` / `plan` opt-out), M4 persistent `stdin stream-json` process reuse + non-negative usage deltas, and cancellation against `test/mock-agy.mjs` and mock HTTP/MCP servers.

| Suite / Command | Scope | Pass / Total | Notes |
| --- | --- | --- | --- |
| `npm run test:unit` | Pure unit tests (`test/unit.test.mjs`) | 36 / 36 | Runs offline inside sandbox (real `agy 1.5.9` & `1.5.11` variant-to-base-model grouping incl. `Gemini 4 Neon` & `Orchestrator (Neon)`, `parseEffortLevelsFromHelp`, zero-hardcode auto-discovery of unseen models/tiers & fixed `supportsEffort: false` models, `CliProbe.hydrateDiskCache` + SWR background refresh + abortable `close()`, `isDiskModelCacheValid` TTL/`bridgeVersion`/`agyVersion` rules, MinerU `.md` + `.doc`/`.docx` routing rules + `read_attachment`/`paper_read` proxy diagnostics + manifest `attachmentTitle`/`contentSourceMode`, `splitModelVariant` & `resolveAgyModelAndEffort`, `parseClaudeShimArgs` & `ensureWindowsClaudeCmdShim`, managed bridge CLI flags, event mapper + `finished_reason` & `note_write` recovery, `stdio-http-proxy` payload compaction & short MCP aliases, error classification, secret redaction, path traversal, `localDocuments` `%PDF-`, M5-01 multimodal image materialization & `view_file(<dir>)`, M5-02 30+ paper scope manifest & tail-safe JSON compaction, M7-02 local EN/CJK semantic embedding L2 norm/similarity/disk cache & upstream 429 batch proxy, instruction path extraction, tool classification, workspace MCP/`session-settings.json`/`rules/AGENTS.md`, `stdio-http-proxy` RW default & RO opt-out, default `processPoolEnabled` config, `normalizeCumulativeUsage`, `SessionProcessPool` LRU/TTL/max-turns rotation with `keepRetained`) |
| `npm run test:bundle` | Single-file release bundle (`test/bundle.test.mjs`) | 3 / 3 | Verifies `dist/agy-zotero-bridge.mjs` exported surface (including M5 & M7-02 exports), CLI `--version` / `--help`, and SDK stdio `initialize` / `set_model` |
| `npm run test:integration` (unsandboxed loopback) | HTTP & shim integration (`test/bridge.test.mjs`) | 27 / 27 | Original 10 baseline integration tests + 17 integration tests (including M7-01 default retention PID reuse, `AGY_PROCESS_POOL=0` opt-out & `AGY_POOL_MAX_TURNS=2` rotation, `(model, effort)` normalization for `Gemini 3.8 Flash` / `Gemini 4 Neon` / `Orchestrator (Neon)`, end-to-end zero-hardcode dynamic CLI model & effort auto-discovery, `claude-code-agy.mjs` SDK stdio E2E, managed `bridge.mjs` lifecycle, M5-01 multimodal SDK image materialization, M5-02 transient 429 retry backoff, and M7-02 `/v1/embeddings` HTTP endpoint + LRU cache) |
| Combined Automated Total (`npm run test:unit` + `npm run test:bundle` + `npm run test:integration`) | Full suite | 66 / 66 | All automated tests passing after MinerU `.md` + `.doc`/`.docx` optimization and bundle rebuild |

### Original 10 Baseline Integration Tests (`test/bridge.test.mjs`)
1. `health and model discovery match plugin contract` — PASS
2. `streams deltas, tool lifecycle, usage, final, outcome without duplicates` — PASS
3. `stores conversation id by scoped key for resume` — PASS
4. `tool errors use matching callId; failed agy result is fallback` — PASS
5. `missing result never reports success` — PASS
6. `permission notice surfaces as status` — PASS
7. `yolo is rejected unless explicitly enabled` — PASS
8. `unsupported interactive endpoints report 501` — PASS
9. `safe mode allows a later request after yolo refusal for same session` — PASS
10. `client disconnect cancels process and releases scoped conversation` — PASS

### New v0.2.0 – v1.0.0 Integration Tests (`test/bridge.test.mjs`)
11. `healthz separates installation and authentication status cleanly` — PASS
12. `efforts and tools endpoints reflect conservative defaults and accurate tool mutability` — PASS
13. `structured-completion supports text, JSON schema, fenced JSON, invalid JSON rejection, and stays stateless` — PASS
14. `structured-completion enforces timeoutMs cleanly` — PASS
15. `run-turn handles DONE-only, tool-only-DONE, duplicate DONE, and unknown/invalid lines cleanly` — PASS
16. `run-turn classifies 429, auth failure, unknown model, non-zero exit after result, and scrubs secrets` — PASS
17. `concurrent turn on same scope is rejected while different scopes run concurrently` — PASS
18. `token auth prefix, model banner stripping, and Zotero MCP probe work end-to-end` — PASS
19. `healthz advertises local_pdf_paths and run-turn validates and redacts localDocuments paths` — PASS
20. `mcp-servers handles 401 before turn and captures Bearer token + tools during Zotero run-turn` — PASS
21. `runtime-retention, invalidate-session, and invalidate-all-hot-runtimes support default retention, opt-out, and turn rotation` — PASS
22. `run-turn and efforts normalize base models, legacy suffixed variants, and auto effort cleanly` — PASS
23. `claude-code-agy.mjs speaks Claude Code CLI stream-json protocol for direct Claude Code path use` — PASS
24. `bridge.mjs supports managed CLI flags, ADAPTER_AUTH_TOKEN, CLAUDE_BRIDGE_READY, and stdin close exit` — PASS
25. `M5-01 & M5-02: SDK shim materializes multimodal image blocks and HTTP bridge retries transient 429` — PASS
26. `M7-02 /v1/embeddings, /embeddings, and /v1/embeddings/status work over HTTP with LRU cache` — PASS
27. `automatic CLI model & effort discovery adapts end-to-end without hardcoded model names` — PASS

## 2. Live E2E Observations (`agy.exe 1.5.9` / `1.5.11` + Zotero `10.0.8` + `llm-for-zotero v3.9.19`)

Verified against the user's live Windows machine:

- `agy.exe 1.5.11` live catalog follow-up (`2026-11-19`): `agy.exe --version` → `1.5.11`; `agy.exe --output-format json models` → **23** raw CLI variants grouped cleanly into **9** base models (`Gemini 4 Neon`, `Gemini 4 Argon`, `Gemini 4 Hydrogen`, `Orchestrator (Neon)`, `Orchestrator (Argon)`, `Gemini 3.8 Flash`, `Claude Opus 5.5`, `Claude Sonnet 5.5`, `GPT-OSS 120B`); `agy.exe changelog` confirmed `Gemini 4 Carbon` & `Orchestrator (Carbon)` naming across enterprise/API-key accounts in `1.5.8–1.5.10`.
- `agy.exe 1.5.9` baseline: `agy.exe --version` → `1.5.9`; `CliProbe.getModels(true)` → Parsed **18** raw CLI variants grouped into **7** base models cleanly despite `"Fetching available models..."` banner, and `agy.exe -p "Reply OK" --model gemini-3.8-flash --effort low --output-format json --disable-slash-commands` returned `SUCCESS`.
- **CLI Smoke & Flag Validation (`agy.exe 1.5.9`)**:
  - `POST /structured-completion` with JSON Schema → returned `{"ok":true,"text":"{\"bridge\":\"agy\",\"status\":\"ok\"}","data":{"bridge":"agy","status":"ok"},"usage":{"inputTokens":10567,"outputTokens":106,...}}`
  - `GET /tools` after real `agy.exe` turn → returned all **47** real `agy.exe` tools from `init.tools`.
  - `agy.exe 1.5.9 --settings <session-settings.json> --output-format json models` → accepted generated `permissions.allow` / `permissions.deny` object cleanly (both MCP rules and `read_file(<dir>)` grants; while invalid `[]` JSON exited non-zero with `--settings must be a JSON object of settings.json keys`).
- **Live Zotero `10.0.8` + `llm-for-zotero v3.9.19` E2E**:
  - `GET /mcp-servers?probe=1` → returned `connected: true`, `status: "connected"`, `protocolVersion: "2025-06-18"`, `toolCount: 27` for `llm_for_zotero_profile_a28d39e2` (`v1.0.0` defaults `writeEnabled: true`).
  - Live `Library chat` turn (`gemini-3.8-flash-low`) → executed Zotero MCP library search in `default` safe mode via workspace `.agents/plugins/llm-for-zotero/` + ephemeral `--settings session-settings.json` and returned accurate paper titles, authors, and years.
  - User manually verified **single-paper close reading / experiment analysis**, **cross-paper comparison**, and separated **base model + Thinking Level** dropdowns in Zotero `10.0.8` (`llm-for-zotero v3.9.19`).

## 3. Remaining E2E Tests to Try in Zotero UI

| Item | Status | Reason | Minimal Verification Step |
| --- | --- | --- | --- |
| Live Managed Zotero mode via **Claude Code path** (`claude-code-agy.mjs`) | Ready for UI test (mock/SDK protocol verified) | Zotero built-in bridge manages startup automatically when *Use my own bridge* is off | Set **Claude Code path** to `<repo>\claude-code-agy.mjs`, uncheck *Use my own bridge*, click **Restart bridge** & Refresh models |
| Live Zotero Note/Tag direct write (`note_write`, tags) & readback | Ready in `v1.0.0` (`writeEnabled: true` default) | User authorized removing default read-only restriction; mock/unit verified | Restart bridge, test creating/appending a note or adding a tag on a target item in Zotero UI and check readback confirmation |
| Live multi-turn persistent daemon pool reuse (`M7-01` default retention & SDK warm shim) | Enabled by default / mock-verified | Default retention-aware pooling (`AGY_PROCESS_POOL` unset) + `--input-format stream-json` + `AGY_POOL_MAX_TURNS` rotation verified in automated tests and `--input-format stream-json` flags checked on `agy.exe 1.5.9` | Run multiple consecutive follow-up turns in an open Zotero chat tab (either Managed or Custom Bridge mode) and observe TTFT improvement without cold-start stalls |

## 4. Rollback Plan

- Stop `node .\bridge.mjs` (`Ctrl+C`).
- To restore strict read-only MCP protection immediately, launch with `$env:AGY_ZOTERO_MCP_ALLOW_WRITE="0"`; set `$env:AGY_PROCESS_POOL="0"` to force independent per-turn cold processes.
- `sessions.json` format is unchanged; no global `agy` settings (`~/.gemini/config/mcp_config.json`, `~/.gemini/antigravity-cli/settings.json`) or Zotero plugin files were modified.
