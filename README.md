# agy → llm-for-zotero Bridge (`v1.1.0`)

Standalone, zero-dependency Node 20+ integration that drives the official Antigravity CLI (`agy`) for `llm-for-zotero` in **both** modes:
1. **Managed Mode (Direct `Claude Code path` — No manual server needed)**: Fill `<repo>\claude-code-agy.mjs` (or `claude-code-agy.cmd` on Windows) directly into Zotero Settings → **Agent** → **Advanced** → **Claude Code path**, and leave **Use my own bridge** unchecked. Zotero automatically launches and manages the runtime!
2. **Custom Bridge Mode (`Use my own bridge`)**: Run `node .\bridge.mjs` yourself and point Zotero's Bridge URL to `http://127.0.0.1:8765`.

Both modes provide grouped base-model discovery + independent Thinking Level (`effort`) selection, Zotero MCP read & direct write capabilities (`writeEnabled: true` by default; `plan` mode / `AGY_ZOTERO_MCP_ALLOW_WRITE=0` opt-out), ephemeral per-turn `--settings` permissions, workspace plugin rules, `local_pdf_paths` support, structured completion, local semantic embeddings (`/v1/embeddings`), and default retention-aware persistent `stdin stream-json` process pooling (`AGY_PROCESS_POOL=0` opt-out).

## 1. Quick Setup (Windows / PowerShell)

### Option 0: Single-File Release (Zero Repository Cloning Required)
Download `agy-zotero-bridge.mjs` (and optionally `agy-zotero-bridge.cmd`) from [GitHub Releases](https://github.com/15699122/agy-zotero-bridge/releases):
1. Place `agy-zotero-bridge.mjs` anywhere on your computer (e.g. `C:\Tools\agy-zotero-bridge.mjs`).
2. Open Zotero → **Settings** → **llm-for-zotero** → **Agent** → expand **高级 / Advanced**:
   - Uncheck **Use my own bridge**.
   - In **Claude Code path**, enter the full path:
     ```text
     C:\Tools\agy-zotero-bridge.mjs
     ```
3. Click **Restart bridge** and **刷新** (Refresh models).

### Option A: Direct `Claude Code path` from Source Repository
1. Install **Node.js 20+** and authenticate `agy` (`agy --version` / `agy models`).
   *(On Windows, the bridge automatically checks `%USERPROFILE%\.gemini\bin\agy.exe` if `AGY_BIN` is unset.)*
2. Open Zotero → **Settings** → **llm-for-zotero** → **Agent** → expand **高级 / Advanced**:
   - Uncheck **Use my own bridge**.
   - In **Claude Code path**, enter the full path to `claude-code-agy.mjs`:
     ```text
     <path-to-repo>\claude-code-agy.mjs
     ```
     *(On Windows you can also enter `<path-to-repo>\claude-code-agy.cmd`; `ensureWindowsClaudeCmdShim()` provisions `node_modules\@anthropic-ai\claude-code\cli.js` for Zotero's Windows `.cmd` shim resolver.)*
3. Click **Restart bridge** (or toggle Claude Code mode / Refresh models) and select your base model + Reasoning Effort in Zotero.

### Option B: Standalone Server (`Use my own bridge`)
1. Run the bridge from this directory:
   ```powershell
   $env:AGY_CWD = "$env:USERPROFILE\Zotero\agent-runtime"
   $env:AGY_BRIDGE_PORT = "8765"
   node .\bridge.mjs
   ```
2. Check **Use my own bridge** in `llm-for-zotero` and enter `http://127.0.0.1:8765`.

### Option C: Semantic Search (`POST /v1/embeddings` Bridge)
1. Start the HTTP bridge (`node .\bridge.mjs` or `node .\agy-zotero-bridge.mjs --bridge`).
2. In Zotero → **Settings** → **llm-for-zotero** → **Customization / 自定义** → **Semantic Search**:
   - Enable Semantic Search.
   - Select **Custom** provider, set **API Base** to `http://127.0.0.1:8765/v1` (leave API Key blank in zero-dependency local semantic mode, or set `AGY_EMBEDDING_API_BASE` + `AGY_EMBEDDING_API_KEY` to proxy with SHA-256 disk caching and automatic 429 retry to Gemini/OpenAI/Ollama), and set **Model** to `agy-local-ngram-v1`.

> **Security notice**: Keep `AGY_BRIDGE_HOST=127.0.0.1` (loopback only). Non-loopback bindings are refused unless `AGY_ALLOW_REMOTE=1` is explicitly set. Never enable `AGY_ALLOW_YOLO=1` unless you explicitly accept unprompted tool execution.

## 2. Testing & Smoke Verification

Run unit tests (no network sockets required):
```powershell
npm run test:unit
```

Run full test suite (unit + mock HTTP integration tests):
```powershell
npm test
```

Run reproducible real-CLI PowerShell smoke script (requires an authenticated `agy` installation and a running bridge):
```powershell
.\scripts\smoke-real-agy.ps1
```

## 3. Project Structure

```text
agy-zotero-bridge/
├── bridge.mjs                     # HTTP bridge entrypoint (supports standalone & managed CLI flags)
├── claude-code-agy.mjs            # Drop-in executable for Zotero "Claude Code path" (all platforms)
├── claude-code-agy.cmd            # Windows .cmd wrapper for Zotero "Claude Code path"
├── src/
│   ├── config.mjs                 # Validated env/CLI config & Windows agy.exe resolution
│   ├── claude-sdk/cli-shim.mjs    # Claude Code CLI/SDK stdio stream-json & control_request shim
│   ├── http/server.mjs            # HTTP routing, token auth, JSON/NDJSON responses
│   ├── agy/cli-probe.mjs          # Version, model banner parsing, effort & health probes
│   ├── agy/process-pool.mjs       # Default retention-aware M4/M7 pool, LRU/TTL & turn/age rotation, usage deltas
│   ├── agy/process-runner.mjs     # /run-turn, /structured-completion, Windows taskkill tree cleanup
│   ├── embedding/embedding-service.mjs # M7-02 OpenAI /v1/embeddings bridge (local semantic + upstream cache)
│   ├── protocol/event-mapper.mjs  # agy stream-json -> RuntimeEvent mapper & error classifier
│   ├── session/session-store.mjs  # Scoped conversation locks & atomic state persistence
│   ├── context/prompt-builder.mjs # First-turn instructions/skills, localDocuments & Zotero context
│   ├── mcp/zotero-mcp.mjs         # Tool mutability, workspace plugin, ephemeral --settings & rules
│   ├── mcp/stdio-http-proxy.mjs   # Stdio-to-Streamable-HTTP Zotero MCP proxy with read-only guard
│   └── security/redact.mjs        # Token/key/path scrubbing & local attachment path validator
├── scripts/smoke-real-agy.ps1     # Real Windows PowerShell smoke verification script
├── docs/
│   ├── UPSTREAM_CONTRACT.md       # Upstream & agy 1.5.9 contract tracking
│   └── TEST_REPORT.md             # Baseline & v0.2.0 verification results
├── test/
│   ├── fixtures/ndjson-samples.mjs
│   ├── mock-agy.mjs
│   ├── unit.test.mjs
│   └── bridge.test.mjs
├── CHANGELOG.md
└── package.json
```

## 4. Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `AGY_BIN` | auto (`~/.gemini/bin/agy.exe` on win32, else `agy`) | CLI executable path |
| `AGY_CWD` | current directory | Base workspace for scoped Zotero conversations |
| `AGY_BRIDGE_HOST` | `127.0.0.1` | Listen interface (non-loopback requires `AGY_ALLOW_REMOTE=1`) |
| `AGY_BRIDGE_PORT` | `8765` | HTTP listen port |
| `AGY_BRIDGE_STATE` | `%USERPROFILE%\.agy-zotero-bridge\sessions.json` | Persistent scoped session mapping |
| `AGY_BRIDGE_TOKEN` | unset | Optional URL token prefix (`/<token>/...`); redacted from logs |
| `AGY_DEFAULT_MODEL` | unset | Default model ID from `agy models` |
| `AGY_DEFAULT_EFFORT` | unset | Default effort level |
| `AGY_MODELS_CACHE_TTL_MS` | `900000` (15m) | Memory & disk model catalog cache TTL (`0` disables caching; auto-invalidates on `bridgeVersion` or `agy --version` change) |
| `AGY_MODELS_REVALIDATE_MS` | `120000` (2m) | Stale-while-revalidate (SWR) background refresh threshold (`0` disables SWR; picks up server-side new models without CLI version bumps) |
| `AGY_PERMISSION_MODE` | `default` | `default`, `safe`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `yolo` |
| `AGY_ALLOW_YOLO` | unset | Set `1` only after explicit review to permit `yolo`/`bypassPermissions` |
| `AGY_SYSTEM_PROMPT_FILE` | unset | UTF-8 instructions injected on the first turn of new sessions |
| `AGY_SKILLS_DIR` | unset | Directory of `SKILL.md` / `*.md` files injected on turn 1 (`AGY_ENABLE_SKILLS=0` disables) |
| `AGY_EXTRA_DIRS_JSON` | `[]` | JSON array of extra directories passed via `--add-dir` |
| `AGY_ALLOWED_PDF_ROOTS_JSON` | `[]` | Allowed root directories for validating local PDF/attachment paths |
| `AGY_ZOTERO_MCP_ENABLED` | unset | Set `1` to actively probe Zotero MCP on `GET /mcp-servers` |
| `ZOTERO_MCP_URL` | `http://127.0.0.1:23119/llm-for-zotero/mcp` | Local `llm-for-zotero` JSON-RPC 2.0 MCP endpoint |
| `ZOTERO_MCP_TOKEN` | unset | Optional Bearer token for standalone `/mcp-servers?probe=1` checks (auto-captured during Zotero `/run-turn`) |
| `AGY_ZOTERO_MCP_ALLOW_WRITE` | `1` (enabled) | Set `0` to enforce strict read-only Zotero MCP mode (`writeEnabled: false`) |
| `AGY_PROCESS_POOL` | unset (retention-aware default) | Retention-aware pooling & SDK warm child reuse enabled by default; set `0` to disable or `1` to force pooling on unmounted HTTP turns |
| `AGY_POOL_MAX_SIZE` | `4` | Max concurrent retained warm processes in `SessionProcessPool` |
| `AGY_POOL_IDLE_TTL_MS` | `300000` (5m) | Idle timeout before evicting warm pooled processes |
| `AGY_POOL_MAX_TURNS` | `20` | Max turns per warm child process before automatic clean rotation |
| `AGY_POOL_MAX_AGE_MS` | `1500000` (25m) | Max warm process age (ms) before automatic clean rotation |
| `AGY_TURN_TIMEOUT_MS` | `1800000` (30m) | Default `/run-turn` timeout cap |
| `AGY_STRUCTURED_TIMEOUT_MS` | `120000` (2m) | Default `/structured-completion` timeout cap |
| `AGY_RATE_LIMIT_MAX_RETRIES` | `1` | Max automatic backoff retries on pre-tool-execution HTTP 429 |
| `AGY_RATE_LIMIT_RETRY_DELAY_MS` | `1500` | Base delay (ms) between HTTP 429 retries |
| `AGY_EMBEDDING_PROVIDER` | `auto` | Embedding backend (`auto`, `local`, `openai`, `gemini`, `ollama`) |
| `AGY_EMBEDDING_API_BASE` | unset | Upstream `/embeddings` API base URL when proxying external providers |
| `AGY_EMBEDDING_API_KEY` | unset | Upstream embedding API key (optional when caller sends `Authorization: Bearer ...`) |
| `AGY_EMBEDDING_MODEL` | `agy-local-ngram-v1` | Default embedding model ID |
| `AGY_EMBEDDING_DIMENSIONS` | `256` | Default vector dimensionality (`16..4096`) |
| `AGY_EMBEDDING_BATCH_SIZE` | `32` | Max inputs per upstream `/embeddings` batch request |
| `AGY_EMBEDDING_CACHE_FILE` | `%USERPROFILE%\.agy-zotero-bridge\embeddings-cache.json` | Persistent LRU embedding cache file |
| `AGY_PREFIX_ARGS_JSON` | `[]` | Optional launcher prefix arguments (used by mock test harness) |

## 5. Implemented Endpoints

| Route | Status | Behavior |
| --- | --- | --- |
| `GET /healthz` | ✅ | Separates `bridgeAlive`, `agyInstalled`, `agyVersion`, `agyAuthenticated: null` (`authStatus: 'unverified'`), `processPool` status, `embeddings`, and capabilities |
| `GET /models` | ✅ | Automatically probes `agy --help` + `agy --output-format json models` (with plaintext fallback), strips status banners, caches via version-aware disk cache + SWR (`AGY_MODELS_REVALIDATE_MS`), returns `models` + `modelInfos` |
| `GET /efforts` | ✅ | Returns model-aware efforts (`?model=<id>`) and `byModel`; unknown models conservatively return `['default']` |
| `GET /tools` | ✅ | Returns `agy` native tools + discovered MCP tools classified with explicit read/write/confirmation metadata |
| `GET /commands` | ✅ | Returns `{ commands: [] }` |
| `GET /permission-modes` | ✅ | Returns `default`, `auto`, `plan`, `acceptEdits`, `dontAsk`, and `bypassPermissions` (disabled unless `AGY_ALLOW_YOLO=1`) |
| `GET /session-info` | ✅ | Returns scoped key, provider session ID, and contained workspace `cwd` |
| `GET /account-quota` | ✅ | Returns `{ quota: null }` |
| `GET /mcp-servers` | ✅ | Returns empty list + setup snippet until Zotero turn / `?probe=1`; reports `writeEnabled: true` by default |
| `POST /run-turn` | ✅ | NDJSON `start` → `event` → `outcome`; automatically reuses warm `--input-format stream-json` workers for retained tabs (`AGY_PROCESS_POOL=1` forces all turns, `AGY_PROCESS_POOL=0` disables), `finished_reason` guards, ephemeral `--settings`, timeouts, Windows kill, redaction |
| `POST /structured-completion` | ✅ | Stateless non-session text/JSON-schema completion via `--json-schema`, enforcing `timeoutMs` and client abort |
| `POST /v1/embeddings`, `/embeddings`, `GET /v1/embeddings/status` | ✅ | OpenAI-compatible embedding endpoint with zero-dependency bilingual local semantic hashing, SHA-256 disk cache, and upstream batch/429 proxy |
| `POST /invalidate-session` | ✅ | Removes scoped session mapping, kills/invalidates any pooled process, and saves atomically |
| `POST /runtime-retention`, `/invalidate-all-hot-runtimes` | ✅ | Default retention-aware lifecycle management & bulk invalidation (`retained: false` when `AGY_PROCESS_POOL=0`) |
| `POST /run-action`, `/resolve-confirmation` | ⛔ `501` | Returns `501 unsupported_by_agy_headless_v0` (interactive mid-turn approval callbacks are not supported in `agy` print mode) |

## 6. Known Boundaries & Rollback

- **Automated vs Live E2E**: All **66** automated tests (`36` unit + `3` bundle + `27` integration) verify protocol, `claude-code-agy.mjs` direct `Claude Code path` SDK stdio shim (including M7-01 warm `stdin stream-json` worker reuse), managed `bridge.mjs` CLI flags (`--port 0`, `--zotero-root`, `--exit-on-stdin-close 1`, `ADAPTER_AUTH_TOKEN`, `CLAUDE_BRIDGE_READY`), zero-hardcode automatic CLI model & `--help` `--effort` discovery (plus `Gemini 4 Neon`, `Gemini 4 Carbon`, `Orchestrator (Neon)`, `Gemini 4 Hydrogen`, `Gemini 4 Argon`, `Gemini 3.8 Flash`, and `Claude Opus/Sonnet 5.5` offline fallbacks), discovery-first disk hydration, version-aware & SWR (`AGY_MODELS_REVALIDATE_MS`) `models-cache.json` refresh, MinerU `.md` + `.doc`/`.docx` Supporting Information routing rules & `read_attachment`/`paper_read` proxy diagnostics, `finished_reason` truncation safety, security, cancellation, `local_pdf_paths`, M5-01 multimodal image materialization, M5-02 30+ paper scope manifests + tail-safe JSON compaction + transient 429 retry, M7-02 `/v1/embeddings` semantic endpoint + LRU cache, MCP auth/settings/rules injection, default Zotero write support (`AGY_ZOTERO_MCP_ALLOW_WRITE=0` opt-out), M7-01 retention-aware `SessionProcessPool` PID reuse / `AGY_POOL_MAX_TURNS` rotation + cumulative usage deltas, and error behavior against mock CLI/MCP endpoints. Live Windows CLI & E2E verification covers `agy.exe 1.5.11` / `1.5.12` `models` (`23` variants grouped into `9` base models) + `changelog`, as well as Zotero `10.0.8` + `llm-for-zotero v3.9.19` for `models`, `/structured-completion`, `/mcp-servers?probe=1`, library search, single-paper close reading & experiment analysis, cross-paper comparison, and grouped model/reasoning separation in **Use my own bridge** mode. Live Zotero Managed mode via **Claude Code path** (`claude-code-agy.mjs`), live Zotero write execution (`note_write` / tag updates), and live multi-turn warm-pool TTFT comparison across extended conversations can now be exercised directly in Zotero UI.
- **Process Execution Default**: Retention-aware persistent pooling is enabled by default (`AGY_PROCESS_POOL` unset: HTTP bridge pools mounted `/runtime-retention` tabs; SDK shim pools consecutive turns in `Claude Code path`). Set `AGY_PROCESS_POOL=1` to force pooling on unmounted HTTP turns, or `AGY_PROCESS_POOL=0` to revert completely to cold one-process-per-turn invocations.
- **Rollback**: Stop `bridge.mjs`, set `$env:AGY_ZOTERO_MCP_ALLOW_WRITE="0"` to restore strict read-only MCP enforcement, set `$env:AGY_PROCESS_POOL="0"` to return to stateless one-process-per-turn execution, or switch `llm-for-zotero` back from *Use my own bridge* to its built-in backend.
