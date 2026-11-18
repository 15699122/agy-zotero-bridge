# agy ↔ llm-for-zotero Bridge 开发计划（v0.2 → v1.0）

> 文档版本：1.0 · 编写日期：2026-11-17  
> 基线：`agy-zotero-bridge v0.1.0`（独立 Node.js HTTP 服务；非上游插件内置 Provider）  
> 目标环境：Windows 原生 PowerShell、Node.js ≥ 20、官方 agy CLI、llm-for-zotero 现有 `Use my own bridge` 入口。  
> **状态约定**：`✅ 已有` / `🟨 基础实现或待验证` / `❌ 未实现` / `⛔ 当前上游能力不支持`。**不得把模拟测试通过写成真实 agy/Zotero 已验证。**

## 0. 产品目标与工程边界

**目标**：让 agy 通过独立桥接器可靠地承担 llm-for-zotero 的文本问答、文献精读、跨文献检索比较、Notes 创建/追加和标签管理等任务，并且保持与插件当前 HTTP 事件协议兼容。先确保正确性、安全性与完整工作流，再优化常驻进程性能。

**优先路线**：继续维护独立桥（保留 `Use my own bridge` 兼容）；**不**直接覆盖或移除原 Claude Code Bridge。若端到端测试证明必须修改 Zotero 插件，再另外提出最小插件补丁、测试和回退方案。不要未经验证更改上游契约或假设 `agy` 与 Claude SDK 完全等价。

**非目标**：绕过 agy 权限保护、伪造内部思考文本、宣称无需认证、自动修改全局 agy 安全设置、在未授权时修改 Zotero 文献库、部署公网服务、自动使用多个账号绕过服务条款。

### 基线资产（必须先读取）

```text
agy-zotero-bridge/
├── bridge.mjs                 # v0.1.0 HTTP 服务 / agy v0 进程 / NDJSON 映射
├── package.json               # Node 20+，npm test
├── README.md
├── test/
│   ├── mock-agy.mjs
│   └── bridge.test.mjs
├── AGY_BRIDGE_DEVELOPMENT_PLAN.md  # 本计划
└── AGENT_DEVELOPMENT_PROMPT.md     # 供 Coding Agent 使用
```

上游事件与 HTTP 契约的**唯一权威来源**（应在每个兼容性阶段重新核对）：

- `https://github.com/yilewang/llm-for-zotero`，其中 `packages/claude-bridge/src/bridge/llm4zotero-contract.ts`
- `packages/claude-bridge/src/event-mapper/map-to-llm4zotero-event.ts`
- `packages/claude-bridge/src/event-mapper/map-provider-event.ts`
- `packages/claude-bridge/src/server/http-bridge.ts`
- `packages/claude-bridge/src/runtime.ts` 与 `src/providers/`、相关 `test/` 和 `tests/`

agy 官方文档需核对所安装版本：

- `https://antigravity.google/docs/cli/headless/`
- `https://antigravity.google/docs/cli/reference/`
- `https://antigravity.google/docs/cli-permissions`

**源代码验证要求**：不要把上游的文件路径、命令行参数或事件字段当作跨版本不变的事实；先检查真实文件、`agy --version`、`agy --help`、`agy models` 和实际运行 NDJSON。若文档与运行结果冲突，记录差异并以可重复测试确定行为，不要静默猜测。

## 1. 当前基线能力和已知缺口

| 范围 | 当前状态 | v0.1.0 事实及注意事项 |
| --- | --- | --- |
| `/healthz`、`/models`、`/permission-modes` | 🟨 | 返回协议结构；`--version` 不能证明已登录；模型解析未实测多版本 |
| `/run-turn` 流式文本 | ✅/🟨 | `start → event → outcome` 和 `message_delta` 已模拟通过；真实 agy/Windows 待验证 |
| 工具生命周期 / usage / final | 🟨 | 基础事件转换与工具 ID；需要真实 ACTIVE/DONE 事件录制和使用量字段核验 |
| 会话续接 / 持久化 | 🟨 | `conversationKey → conversation_id` 已有；需加强冲突、失效、作用域和异常恢复 |
| 取消请求 | 🟨 | 已模拟通过；Windows 子进程树清理与断开连接竞争条件待验证 |
| `/efforts` | 🟨 | 泛化等级，尚未按模型正确过滤 |
| `/tools` | 🟨 | 来自最近 `init`；描述和风险分类为启发式，不能作为授权依据 |
| Safe / Auto / Yolo | 🟨 | Yolo 默认禁用；Auto 依赖 CLI/平台支持；没有完整可审计规则管理 |
| `/structured-completion` | ❌ | 返回 HTTP 501；应优先解决兼容需求 |
| `/run-action` / `/resolve-confirmation` | ❌/⛔ | 返回 501；headless 交互审批不可假装实现 |
| `/mcp-servers`、Zotero MCP | ❌ | 当前返回空列表；没有逐轮 MCP 注入、权限验证或工具调用 |
| PDF/图片/附件多模态 | ❌ | 只支持部分上下文文本序列化，无真正附件协议 |
| Zotero Skills、系统指令 | 🟨 | 可从文件首轮注入指令；没有完整指令发现、路径安全和 Skills 生命周期 |
| 常驻 agy 会话/进程池 | ❌ | 每轮新进程，无复用和空闲回收 |

已验证：`npm test` 在当前本地环境运行 **10 个模拟测试，10 个通过**。这不是实际 CLI 或 Zotero UI 的端到端验收。

## 2. 不可破坏的对接协议（Contract）

### 2.1 HTTP 形状

保持插件可识别的端点和字段。`POST /run-turn` 返回 `Content-Type: application/x-ndjson`，一回合的正常封装为：

```jsonl
{"type":"start","runId":"agy-..."}
{"type":"event","event":{"type":"message_delta","text":"你好"}}
{"type":"event","event":{"type":"final","text":"你好"}}
{"type":"outcome","outcome":{"kind":"completed","runId":"agy-...","text":"你好","usedFallback":false}}
```

- 每次 HTTP 回合最多一个 `outcome`；失败则用 `fallback` 事件与 `outcome.kind=fallback`，不能既 completed 又 fallback。
- `final.text` 为**确认后的完整文本**，不可再次当增量拼接。
- 仅当收到有效的 `result.status === "SUCCESS"`、进程成功结束且未被取消时返回 completed。
- 不认识的 agy 字段应容错；关键必需字段缺失应返回可诊断错误，不得伪造结果。
- `model_catalog_v1` 返回 `{models: string[], modelInfos: RuntimeModelInfo[]}`；不支持的模型能力标记为 false 或省略，而非猜测为 true。
- `/tools` 中的 `source` 必须符合插件现有类型枚举；**工具是否可写/可调用不能只靠工具名正则判定**。
- 如果端点确实未实现，保持明确的 501/503 和稳定错误码，而不是输出看似成功的空结果。

### 2.2 agy NDJSON → 插件事件

| agy 流事件 | 插件事件 | 必须满足 |
| --- | --- | --- |
| `init` | `provider_event` + session mapping | 记录 `conversation_id`，不把诊断或 token 泄漏到前端日志 |
| `step_update/agent_response` + `text_delta` | `message_delta` | 每一块直接追加；`ACTIVE`/`DONE` 不能成为去重标准 |
| `step_update/tool` + `ACTIVE` | `tool_call` | 稳定的 `callId`；允许初始 parameters 不完整 |
| `step_update/tool` + `DONE` | `tool_result` 或 `tool_error` | 与调用开始同 `callId`；成功/失败只结算一次 |
| `step_update/subagent_info` | 可选进度/未知事件 | 不影响文本完整性与主回合结果 |
| `result/SUCCESS` | `usage`、`final` | `usage` 累计/增量语义与字段必须验证；防止全文重复 |
| `result` 非 SUCCESS | `fallback` / `outcome` | 保留结构化错误类型、stderr 安全摘要 |

`tool` 只有 `DONE` 而没有 `ACTIVE` 时也要合理显示一次调用+结果。若某 agy 版本使用新的步骤标识形式，先录制样本再扩展适配，不凭空推断。

### 2.3 请求隔离与安全

- 默认 HTTP 仅监听 `127.0.0.1`；可选 token 与现有插件 URL 前缀兼容。非本机地址必须显式启用并有安全审查。
- `conversationKey` + `scopeType/scopeId` 的命名空间隔离；防止不同文献/文件夹复用错误 `conversation_id`。
- 将 `runtimeRequest` 视为**外部数据**，大小、结构、附件路径和文本长度须有限制；不要将文献 PDF 的内容或恶意工具输出当作系统指令。
- 不能使用 `shell: true` 拼接用户 prompt/路径；保护 `AGY_BIN` 与可执行文件选择。
- `AGY_ALLOW_YOLO` 仅在用户显式开启后可用；**不得**自动改用 `--dangerously-skip-permissions` 来修复任何失败。
- Zotero Notes/标签等写操作需遵守用户授权、预览及可审计反馈；权限软拒绝只能展示，不能绕过。
- 输出/日志剔除 bearer、API Key、认证 Cookie、会话令牌和敏感本地路径；录制固件前脱敏。

## 3. 开发阶段与验收条件

### M0：基线锁定与自动化验证（所有阶段前置）

**任务**
1. 解压/读取 v0.1.0；`node --version`、`npm test`；记录 git 状态、现有功能和 501 路由。
2. 读取上游协议、测试、Zotero `Use my own bridge` 与 MCP 真实端点实现；形成 `docs/UPSTREAM_CONTRACT.md`，注明源文件/版本/关键字段。
3. 检查 agy CLI 的可执行文件解析（Windows `.exe`/`.cmd`、PATH）、认证状态、`--print-timeout`、`--add-dir`、`--disable-slash-commands`、stdin 模式及错误退出行为；必要时先写带 mock 的兼容探测。
4. 不覆盖或删除原桥功能；为后续工作建立单元/集成/真实 smoke 三层测试命名。

**验收**：原有 10 项测试持续通过；可从 README 独立复现基线；生成 `docs/UPSTREAM_CONTRACT.md` 和变更日志初稿。无需凭证也能完成 M0 的静态和模拟部分。

### M1：v0.2 — 协议正确性、健壮性及缺失基础端点（最高优先级）

**任务**
1. 把 `bridge.mjs` 的路由、进程执行、NDJSON 解析、事件映射、会话存储、CLI 能力探测拆分为可测试模块（推荐 `src/http/`、`src/agy/`、`src/protocol/`、`src/session/`；可保留 `bridge.mjs` 作为入口）。避免为拆分而引入大量依赖。
2. 定义类型校验/边界：未知事件忽略+可选 trace、必需字段异常、超大 NDJSON 行、超大 stderr、JSON 格式错、短回复 DONE-only、工具 ONLY-DONE、重复 DONE、没有 result、非 0 退出码、认证失败、429/速率限制、不可用模型、超时、取消。
3. 完成 `/structured-completion`：按照上游真实请求/响应合同，单独发起非会话式文本生成并返回 `{text, usage?}`，遵守 `timeoutMs`、AbortSignal、错误状态和不污染现有会话；若真实 agy 不支持稳定完成，应保留 501 并写出技术障碍，不得输出伪结果。
4. 完善 `/models` 和按模型的 `/efforts`：从真实 `agy models` / CLI 帮助解析或采用经确认的版本化能力表；无法确认时保守返回 `default`，不要把通用档位全部宣称支持。
5. `/healthz` 将 `bridgeAlive`、`agyInstalled`、`agyAuthenticated`（如能安全主动验证）、版本及诊断分开；不可仅凭 `--version` 推断已登录。
6. 修复请求完成/HTTP 断开竞争、单会话并发、重试策略、存储写入错误、跨进程映射冲突、Windows 上子进程树停止；客户端断开须在有界时间内释放资源。
7. 建立**纯文本、工具成功、工具失败、软拒绝、取消、未知模型、无效 JSON、无 result、空输出、会话恢复**的去标识化 fixtures。真实 agy 样本只能在可认证环境下录制，标注 CLI 版本、平台与触发方式。
8. 审查是否需要实现 `local_pdf_paths` 能力标记；仅在真实路径处理通过测试后添加；暂不伪称支持附件。

**验收门槛**
- [ ] 全部原有测试通过；新增协议/取消/结构化生成/模型兼容/安全测试通过。
- [ ] 对相同文本/工具事件准确产生唯一一次 `final` 和 `outcome`，不会重复文本或误报成功。
- [ ] 模型不支持、审批软拒绝、缺失 terminal result 都可观察、可复现、可分类。
- [ ] Windows 原生真实 agy：文本流、继续会话、取消和 1 例工具操作已验证；若无法验证，状态写为 `BLOCKED: needs Windows authenticated CLI`，不能打勾。
- [ ] 文档包含版本、验证命令、结果和剩余限制。

### M2：v0.3 — Zotero MCP / 原生文献操作（功能关键路径）

**依赖**：M1 的基本协议可稳定运行，已验证 Zotero MCP 的真实 endpoint 和认证机制。

**任务**
1. 在插件源码查实 `/llm-for-zotero/mcp` 是否存在、怎样启用、传输协议（stdio / SSE / Streamable HTTP）、鉴权形式、端口和工具名称/Schema；记录验证来源。**不得仅凭旧对话中的路径推断接口必然存在。**
2. 读取实际 `agy mcp`/配置说明并用当前安装版本验证 MCP 注册/连接能力；将凭据存放在受保护的位置，不将 bearer token 加入可公开日志或测试固件。
3. 首选可回滚的、项目级 MCP 配置；只有在 agy 不支持时，才考虑经用户明确同意的全局配置；记录原配置、备份和撤销步骤。
4. 验证只读工具：检索 Zotero 文献、获取 metadata、读取全文/Notes、基于选中文献/文件夹进行跨文献检索与引用；使工具元数据正确填充 `/tools` 和 `/mcp-servers`（如协议支持）。
5. 验证写工具：创建/追加 Note、增加/删除标签、批量规范化；严格区分 dry-run / preview / apply，检查工具授权、单文献和文件夹作用域、失败回滚与部分成功报表。
6. `/run-action` 仅在有明确可调用工具、可靠的批准语义时实现受限动作；若 agy headless 仍无法单次回调审批，继续维持可解释的 501，**不能**假冒确认成功。`/resolve-confirmation` 同理。
7. 对 MCP 连接失败、工具超时、无权限、格式错误、插件退出、session reconnect 写回归测试。

**验收门槛**
- [ ] 真实 Zotero：只读文献检索和引用可以在安全模式下执行，返回可追踪的文献来源。
- [ ] 真实 Zotero 测试库：在明确授权后创建 Note 并读取核验；标签管理有 dry-run 预览和可审计结果。
- [ ] 不使用 Yolo 也能完成至少一个只读工作流；写操作不绕过确认规则。
- [ ] MCP 断连不导致虚假成功、静默数据丢失或不可控无限重试。

### M3：v0.4 — PDF/图片、文献上下文与 Skills

**依赖**：M1 可用；优先复用 M2 的 Zotero 读取工具。

**任务**
1. 检查上游 `runtimeRequest` / `attachments` / `localPdfs` / 作用域数据实际合同，支持插件传来的真实文献上下文，避免长上下文盲目截断和跨文献混合。
2. PDF 和图像：确认 agy 是否真的接受本地文件输入、路径或多模态 payload；能支持则实现受控 `--add-dir`/明确路径传递；若不支持，优先通过 Zotero MCP 提取文本和图表引用，清楚告知图像不可读。**不得把文件路径当作已经读取了 PDF 内容。**
3. 文件访问必须验证实际存在、根目录白名单、体积、合法类型与权限；杜绝 `../` 逃逸及非授权目录全量开放。
4. 系统指令/Skills：构建版本可追踪、仅首次注入的 Bootstrap，识别用户的自定义 Skills 与 Zotero 上下文，区分可信指令与低信任文献内容；支持可关闭、可测试、不重复注入。
5. 验证 6 项日常任务：论文精读、概念解释、实验分析、跨文献比较、文献检索、标签管理。逐项记录输入范围、预期结果、引用准确性、写入授权和测试结论。

**验收门槛**
- [ ] 对同一篇 PDF 的文本与图表分别说明能力边界，结果符合真实 agy 工具能力。
- [ ] 至少一个多文献任务正确引用每篇文献来源，避免内容串文献。
- [ ] Skills 开关与新会话首轮注入可重复测试，续接不重复注入。
- [ ] Zotero 测试库内 Notes/标签操作能回读核验。

### M4：v1.0 — 常驻进程、稳定性与交付

**依赖**：M1/M2/M3 工作流达到测试门槛；仅在官方 agy stdin stream-json 被当前版本验证后启动。

**任务**
1. 实现每会话一个常驻进程：stdin 写入 `{"event":"user","message":{"content":"..."}}`；stdout 按每个 `result` 分轮；禁止交错请求/不同会话串流；stderr 独立处理。
2. 管理进程池：session 锁、上限、空闲 TTL、自动回收、重启后恢复、崩溃隔离、取消终止进程/销毁池条目，保证不会重放可能产生副作用的工具调用。
3. `usage`、`num_turns` 可能是**累计值**；必要时内部转换成 per-turn 指标并同时保留原始信息（不应产生负值）。
4. 在 Windows 原生环境测试 1/5/20 并发、长回答、10 次以上会话轮转、断网/认证过期、重复断开、进程崩溃和内存稳定性；记录启动时延/首 token 时延，但不承诺未经测量的加速。
5. 更新安装、升级、备份、卸载、隐私和恢复文档，附上真机 smoke report；对未实现特性保持能力声明的真实性。

**验收门槛**
- [ ] 可在真实 Windows 环境连续工作并自动回收空闲进程；没有跨会话串流。
- [ ] 相同真实任务与 v0 比较的性能/资源统计有环境、次数与测量方法。
- [ ] 断开、取消、失败、重启均不会产生重复写入或虚假 completed。
- [ ] 用户可一键回退到 v0 的独立进程模式；旧会话迁移和不兼容情况有说明。

## 4. 测试矩阵、证据与阶段闸门

| 层级 | 必需 | 不可用时如何处理 |
| --- | --- | --- |
| Unit（纯解析/会话/权限） | 每次改动运行 `npm test`；模拟多种 NDJSON 格式 | 必须修复，不可跳过 |
| Integration（mock CLI + HTTP） | 每阶段覆盖所有影响的端点与断连/取消/超时 | 必须修复，不可跳过 |
| CLI smoke（真实 agy + 已认证） | M1 起：纯文本/工具/会话/模型/权限 | 无账号或不支持平台时标记 BLOCKED；不编造成功 |
| Zotero E2E（测试库） | M2 起：检索、Notes、标签、PDF/图片 | 无 Zotero 实例时标记 BLOCKED，并给出最小手动复测脚本 |
| Security（权限/凭据/路径/写操作） | 所有阶段必做；MCP 上线前必须通过 | 未通过不得宣称可用于真实写操作 |
| Regression（原桥兼容） | `start/event/outcome`、模型/工具/会话端点 | 失败即阶段未完成 |

**每次提交或阶段交付必须记录**：所改文件、设计决定、运行的命令与原始测试摘要、CLI/插件版本、真实测试与模拟测试区分、未实现项、回滚方法、后续待办。建议使用 `docs/TEST_REPORT.md`、`CHANGELOG.md`。

## 5. 实现次序（面向执行的任务清单）

- [x] `M0-01` 读取全部基线文件与官方/上游协议；建立来源追踪表。
- [x] `M0-02` 运行基线 10 测试；记录原版本与当前环境。
- [x] `M1-01` 抽取可单测的 agy NDJSON parser / event mapper；保留旧接口。
- [x] `M1-02` 添加真实格式 fixtures 的脱敏方案，覆盖异常、工具与增量。
- [x] `M1-03` 处理超时、stderr、退出、Abort、Windows 子进程树与写入背压。
- [x] `M1-04` 完成 `/structured-completion` 或提交明确的不支持证据。
- [x] `M1-05` 模型/effort/healthz 真实能力探测与安全回退。
- [x] `M1-06` 输出 `docs/TEST_REPORT.md`、回归测试与 v0.2 CHANGELOG。
- [x] `M2-01` 验证 Zotero MCP endpoint、工具与鉴权实际合同。
- [x] `M2-02` agy MCP 注册、只读检索与元数据可追踪。
- [x] `M2-03` Notes/标签受控写入、预览与回读测试。
- [x] `M2-04` MCP 错误恢复、失效凭据、权限与端点兼容性。
- [x] `M3-01` 完整插件上下文、PDF/图像真实能力验证与实现。
- [x] `M3-02` 用户 Skills/项目指令加载与信任边界。
- [x] `M3-03` 六类文献工作流回归与引用/写入准确性检查。
- [x] `M4-01` stdin stream-json 常驻进程模型、回合隔离、累计 usage 归一化。
- [x] `M4-02` 进程池、空闲清理、错误恢复、取消与回滚。
- [x] `M4-03` Windows/Zotero 长时稳定性、性能与发布文档。
- [x] `M4-04` 单文件可执行包装（`dist/agy-zotero-bridge.mjs`）、基础模型/Thinking Level 正交分离与 GitHub Actions 自动 Release（v1.0.0 已正式发布）。

---

## 8. v1.1+ 后续演进规划（Post-v1.0 Roadmap）

> **当前基线**：`v1.0.0` 已实现单文件独立发布、直接 `Claude Code path` 托管启动、`writeEnabled: true` 默认读写与真实 Zotero 端到端验证。以下规划面向高阶学术研读、自动化配置便利性与长会话性能优化。

### 方向 A：高阶文献研读与多模态能力增强（`M5` ✅ 已完成并验证）
1. **`M5-01` 多模态图表/实验架构图深度解析（✅ 已完成）**：
   - **目标**：突破纯文本 / MinerU 文本层的局限，充分利用 Gemini 3.8 / 4 原生 Vision 能力对扫描件及论文插图（折线图、电镜图、流程图等）进行精准数据提取与分析。
   - **已实现内容**：
     - 在 `src/context/prompt-builder.mjs` 中新增 `parseImageDataUrl`、`validateImageBuffer`（PNG/JPEG/GIF/WEBP 魔数头与 20 MB 大小校验）、`materializeTurnImages` 及 `renderMultimodalImagePrompt`，支持将 `runtimeRequest.screenshots`（Base64 Data URL）、SDK `user` 帧中的 base64 `image`/`image_url` 内容块落盘至工作区 `.agents/multimodal-inputs/`，并自动放行图像附件路径与 Zotero figure crop 缓存目录。
     - 在 `src/mcp/zotero-mcp.mjs` 的 `buildScopedAgySettings` 中同时下发 `read_file(<dir>)` 与 `view_file(<dir>)` 会话级只读授权；在 `buildScopedZoteroRulesMarkdown` 中明确指引 `agy` 配合 `paper_read({ mode: "figures" | "visual" | "capture" })` 提取图表裁剪图后直接调用 `read_file`/`view_file` 查看像素内容，同时保留 `no_figures`/失败场景的纯文本降级诚信约束。
     - 在 `src/claude-sdk/cli-shim.mjs` 中新增 `extractSdkUserImageBlocks` 并将其接入 `executeTurn` 与单文件打包产物 `dist/agy-zotero-bridge.mjs`。
2. **`M5-02` 大规模文献综述与超长上下文优化（✅ 已完成）**：
   - **目标**：支持用户一次性勾选 20～50 篇文献进行领域综述或批量筛选时，防止上下文溢出或触发 429 速率限制。
   - **已实现内容**：
     - 在 `src/context/prompt-builder.mjs` 中新增 `extractPaperScopeManifest`、`compactRuntimeContext`、`renderBatchScopeGuidance` 与尾部保护组装函数 `assembleTailSafePrompt`：面对 8–50+ 篇多文献或 >200KB `runtimeRequest` 时不再生硬截断 JSON 字符串，而是渐进折叠重型全文字段并生成包含全部 `libraryID`/`itemId`/`contextItemId`/`itemKey` 的合法 JSON 清单与 3 阶段分层检索提示，确保 `User request:` 始终完整保留。
     - 在 `src/mcp/zotero-mcp.mjs` 工作区规则中新增批处理综述（`library_retrieve` -> 3–6 篇分批 `paper_read` `targets`/`outline`->`targeted` -> `review_coverage` 覆盖边界报告）约束。
     - 在 `src/config.mjs`、`src/protocol/event-mapper.mjs`、`src/agy/process-runner.mjs` 与 `src/claude-sdk/cli-shim.mjs` 中新增 `AGY_RATE_LIMIT_MAX_RETRIES` / `AGY_RATE_LIMIT_RETRY_DELAY_MS`：在无工具副作用产生前遭遇瞬时 HTTP 429 时自动指数退避重试，并在最终 429 失败时附加减批/降推理强度提示。

### 方向 B：交互体验与自动化配置便利性（`M6`）
1. **`M6-01` Windows 一键部署与自动关联脚本（`scripts/setup-zotero.ps1`）**：
   - **目标**：消除新手手动复制路径时可能误带中文弯引号（`“...”`）、路径转义或忘记取消勾选 *Use my own bridge* 的配置门槛。
   - **大致开发内容**：
     - 编写自动检测工具：检查 `node --version` (>=20)、`agy --version` 登录状态、自动下载或定位最新单文件版 `agy-zotero-bridge.mjs`。
     - 安全检查 Zotero 进程是否关闭，定位 `%APPDATA%\Zotero\Zotero\Profiles\*.default\prefs.js` 并备份，自动写入标准无引号的 `claudeCodeCliPath` 与 `claudeCodeBridgeMode: "managed"` 配置。
2. **`M6-02` 可定制的 Zotero / Obsidian 笔记与标签模板**：
   - **目标**：使 Agent 生成的文献笔记和标签体系高度契合用户个人的科研知识库规范。
   - **大致开发内容**：
     - 支持通过环境变量或本地配置文件（如 `~/.agy-zotero-bridge/templates.json`）注入自定义笔记结构（元数据表、创新点、实验对照、局限性、思考题）。
     - 在 `src/context/prompt-builder.mjs` 首轮系统指令注入阶段自动加载用户模板，并要求在写回后执行结构化校验。

### 方向 C：性能深化与语义检索扩展（`M7`）
1. **`M7-01` 常驻进程池默认化与首字时延调优**：
   - **目标**：在多轮连续追问场景下降低 `agy.exe` 冷启动开销，缩短首字响应时间（TTFT）。
   - **大致开发内容**：
     - 对 `SessionProcessPool`（`src/agy/process-pool.mjs`）在 Windows 托管模式下的内存占用、空闲自动回收（TTL）及异常崩塌隔离进行长时压测。
     - 评估并制定安全的默认开启条件（如仅对同一会话连续对话保持温启动，切换文献库或模型时自动重建）。
2. **`M7-02` 本地语义向量检索桥接（✅ 已完成并验证）**：
   - **目标**：增强海量本地文献库中的模糊语义检索能力，辅助 Zotero 现有关键词搜索。
   - **已实现内容**：
     - 在 `src/embedding/embedding-service.mjs` 与 `src/config.mjs` 中实现 `EmbeddingService`、`computeLocalSemanticEmbedding`（零依赖双语中英文/词干/字符 n-gram 签名哈希 + L2 归一化向量引擎）和持久化 SHA-256 LRU 磁盘缓存（`embeddings-cache.json`）。
     - 在 `src/http/server.mjs` 新增 OpenAI 兼容的 `POST /v1/embeddings`（及 `POST /embeddings` 别名）和 `GET /v1/embeddings/status` 路由；在 `src/agy/cli-probe.mjs` `/healthz` 中广播 `embeddings_v1` 能力。
     - 支持零密钥开箱本地语义模式，也支持通过 `AGY_EMBEDDING_API_BASE` 透传代理至 OpenAI / Gemini / Ollama 并自动提供分片批处理与 429 指数退避重试。
     - 已通过 `scripts/bundle.mjs` 集成打包进单文件分发包 `dist/agy-zotero-bridge.mjs`。

---

## 9. 专项技术研究报告（`M6-02`、`M7-01`、`M7-02`）

> 以下结论均基于对本地已安装 `llm-for-zotero v3.9.19`（`content/scripts/llmforzotero.js`、`content/claude-bridge/bridge.mjs`）、Zotero `prefs.js` 与 `agy.exe 1.5.9` 源码/契约的直接源码级核查。

### 9.1 `M6-02` 可定制的 Zotero / Obsidian 笔记与标签模板研究

1. **上游技能契约（`write-note.md` v19 & `reorganize-library.md` v3）**：
   - `llm-for-zotero` 内置了 `write-note.md`（版本 19）与 `reorganize-library.md`（版本 3），并在 Zotero 启动时播种至 `<ZoteroDataDir>/agent-runtime/profile-<hash>/.agents/skills/`（在本机测试环境即 `seededSkillsDir`）。
   - 插件在 `prefs.js` 中维护 `extensions.zotero.llmForZotero.skillBodyHashes`（FNV-1a 校验映射），当用户或桥接器修改 `.agents/skills/*.md` 后，插件会保留用户修改而不会静默覆盖；同时 `write-note.md` 明确声明：**"User customizations take precedence over formatting defaults, within the current request and host permissions."**
2. **双路持久化管线（Zotero 原生笔记 vs Obsidian Markdown）**：
   - **Zotero 原生笔记（`note_write` / `note_write_batch`）**：
     - 严格省略 YAML frontmatter，默认精读结构为：`Paper Title -> Summary -> Key Findings -> Methodology -> My Notes -> References -> --- / Written by LLM-for-Zotero.`。
     - 支持原样保存已有回复（传递 `sourceMessageId` 时禁止改写内容）；支持内嵌 `paper_read({ mode: "figures" })` 返回的 `file://` 图表裁剪链接（由 `note_write` 自动导入与校验）。
     - 将模型生成的“批判性问题/疑问”与用户自己的 `My Notes` 严格区分。
   - **Obsidian / Markdown 文件导出（`submit_document` -> `file_io`）**：
     - 先调用 `submit_document` 定稿（绑定宿主机生成的 figure assets 与 `documentEvidenceRefs`），再将返回的 `documentId` 与 `visibleMarkdown` 传给 `file_io` 写入配置的 `obsidianVaultPath` 目录及相对附件目录 `obsidianAttachmentsFolder`。
     - 完整精读 Markdown 默认 YAML frontmatter 为：`title`, `citekey`, `doi`, `year`, `journal`, `created`, `tags: [zotero, paper-note]`；通用笔记为 `title`, `created`, `tags: [zotero]`。
     - 引用格式强制约定：仅当 `citekey` 非空时使用 `[@citekey]`，否则使用可读的 Author-Year 引述。
3. **桥接器模板定制架构设计方案**：
   - **三层注入机制**：支持 `AGY_NOTE_TEMPLATE_FILE` 环境变量或默认读取 `~/.agy-zotero-bridge/templates.json`（与 `prefs.js` `notesDirectoryNickname` 兼容），按 `zotero_note`、`markdown_obsidian` 与 `tag_taxonomy` 三部分覆盖预设结构。
   - **首轮无污染注入**：仅在非续接首轮通过 `src/context/prompt-builder.mjs` 注入模板约定，同时在 `rules/AGENTS.md` 中保留“仅在用户显式请求写笔记或打标签时生效”、“先通过 `library_search` 复用现有标签与集合避免重复创建”、“写后立刻 `library_read`/`file_io` 回读核验”四项安全守则。
   - **范围保护**：当用户请求的是“仅保存原回答（`sourceMessageId`）”或“仅导出某张图表裁剪（figure-only）”时，桥接器提示词明确禁止强行套用完整精读模板。

### 9.2 `M7-01` 常驻进程池默认化与首字时延（TTFT）调优研究

1. **双拓扑运行态对比（Managed CLI Shim vs Custom HTTP Bridge）**：
   - **Managed 模式（`claude-code-agy.mjs` / `dist/agy-zotero-bridge.mjs` + Zotero `content/claude-bridge/bridge.mjs`）**：
     - 经核查 `content/claude-bridge/bridge.mjs`，上游自带 `hotRuntimePool`（通过 `startHotTurn`、`retainHotRuntime`、`warmHotRuntime` 与 `/runtime-retention` 控制生命周期），可将 `claude-code-agy.mjs` 进程本身保持为 stdio 常驻热进程。
     - 但目前 `cli-shim.mjs` 的 `executeTurn()` 在每一轮内部仍对 `agy.exe` 采用短生命周期 `-p ... --conversation <id>` 单轮拉起方式，未复用 `agy.exe` 本身的 `--input-format stream-json --output-format stream-json --print=` 长驻子进程。
   - **Custom HTTP Bridge 模式（`bridge.mjs --bridge`）**：
     - 桥接器已实现基于 `SessionProcessPool`（`src/agy/process-pool.mjs`）的 M4 进程池（`AGY_PROCESS_POOL=1` 时启用），通过 `conversationKey` 复用热 `agy.exe` 子进程，使用 `normalizeCumulativeUsage()` 处理累计 token 转增量 delta。
2. **每轮 `X-LLM-For-Zotero-Scope` 热轮换兼容性机制（重要发现）**：
   - 核查 `zotero-llm` 源码确认：`X-LLM-For-Zotero-Scope` 请求头是每轮动态生成、回合结束即失效的临时作用域令牌，且在工具调用中通过 HTTP Header 传给 `http://127.0.0.1:23119/llm-for-zotero/mcp`。
   - **为什么常驻 `agy.exe` 无需因此重启**：桥接器每轮在写入 stdin `user` 消息前先调用 `prepareScopedMcpPlugin()` 覆盖更新 `<cwd>/.agents/zotero-mcp-headers.json`，而 `src/mcp/stdio-http-proxy.mjs` 在 `runProxy()` 每次收到来自 `agy.exe` 的 JSON-RPC 请求时都会重新执行 `loadProxyTarget()` 读取最新 `zotero-mcp-headers.json`。因此常驻 `agy.exe` + 常驻 stdio proxy 组合**天然支持跨轮 Scope Token 热更新**。
3. **默认化前必须满足的三项安全/工程约束**：
   - **约束 1：完整配置签名隔离（已在本轮修复）**：除 `cwd/model/effort/permissionMode/allowWriteForTurn` 外，`mcpSettingsFile` 与 `readDirs`（`--add-dir`）变化时必须触发 `poolSignature` 失效并重建 `agy.exe`（已在 `src/agy/process-runner.mjs` 修复补充）；`plan` 模式或 `localDocuments` 原生 PDF 轮次必须继续绕过池化以确保强隔离。
   - **约束 2：`--print-timeout` 作用域陷阱**：实测 `agy.exe 1.5.9` 传入 `--input-format stream-json --print-timeout <T>` 时，该超时若作用于常驻进程总存活时长或空转上限，长期挂机可能导致暖进程意外退出；默认化前需在 `poolSignature` / `createPooledChildRuntime` 中配合最大存活轮次/最大生命周期轮换（例如达到 20 轮或接近 TTL 时优雅回收重拉），并将单轮超时严格交由桥接器 `AbortController` 控制。
   - **约束 3：取消与异常崩溃防重放隔离**：当某轮发生网络中断、客户端 `abort` 或 429 重试切换时，必须立即 `killProcessTree` 并 `processPool.invalidate(key)`，严禁在已发生过工具副作用（`settledToolCount > 0`）的脏进程上静默续跑。

### 9.3 `M7-02` 本地语义向量检索桥接（Semantic Search Bridge ✅ 已实现并验证）

1. **上游插件向量配置与调用契约（`llmforzotero.js`）**：
   - 通过核查 `callEmbeddings`、`getResolvedEmbeddingConfig`、`resolveAutoEmbeddingProvider` 与 `orderEmbeddingResponse` 确认：
     - Zotero 首选项键为：`enableSemanticSearch`、`embeddingProvider`、`embeddingApiBase`、`embeddingApiKey`、`embeddingModel`。
     - 协议形态：完全采用 **OpenAI Compatible `POST <embeddingApiBase>/embeddings`**，请求体 `{ model, input }`（支持字符串或字符串数组批量输入），响应体期望 `{ data: [{ index, embedding: number[] }] }`（按 `index` 排序提取浮点数组）。
     - **关键发现**：`callEmbeddings` 源码中明确判断 `if (!apiKey && embeddingProvider !== "custom") throw ...`，即当用户在 Zotero 设置中选择 `custom` 作为 `embeddingProvider` 时，**允许 `embeddingApiKey` 为空**，非常适合直连本地 `127.0.0.1` 代理服务！
2. **`agy.exe 1.5.9` 能力边界确认**：
   - 对 `agy.exe 1.5.9` 全部命令行接口的调研表明：`agy` 是交互/无头对话与编码 Agent CLI，**没有暴露独立的向量嵌入子命令（如 `agy embeddings`）或返回原始 `float[]` 稠密向量的开关**。因此不能强行让 `agy.exe` 伪造或计算向量数值。
3. **可行的三条技术实施路径评估**：
   - **路径 1（零开发直连方案 — 推荐个人快速使用）**：
     - 用户直接在 Zotero 设置 -> 自定义 -> Semantic Search 中配置 `embeddingProvider: "gemini"`（配合 `https://generativelanguage.googleapis.com/v1beta/openai` + `gemini-embedding-001`）或本地运行 **Ollama**（`embeddingProvider: "custom"`, `embeddingApiBase: "http://127.0.0.1:11434/v1"`, `embeddingModel: "bge-m3"` / `"nomic-embed-text"`），无需经由桥接器二次中转。
   - **路径 2（桥接器 `/v1/embeddings` 本地缓存与限流代理 — 后续可实现项）**：
     - 在 `src/http/server.mjs` 新增仅监听回环地址的 `POST /v1/embeddings` 端点，Zotero 配置 `embeddingProvider = "custom"`、`embeddingApiBase = "http://127.0.0.1:8765/v1"`。
     - 桥接器负责：(a) 基于文本内容 SHA-256 的本地持久化向量缓存（`<stateDir>/embeddings-cache.sqlite` 或分片 JSON），避免重建索引或切换模型重复计费；(b) 自动分批限流退避（应对 Gemini/OpenAI 批量嵌入 429）；(c) 统一转发到用户配置的本机 Ollama 或上游 Embedding API。
   - **路径 3（Zotero MCP 内置混合检索互补 — 现有即用）**：
     - 在用户未开启 Semantic Search（如本机 `enableSemanticSearch: false`）时，通过已打通的 Zotero MCP 工具 `library_retrieve`（`enumerate` / `summarize` / `verify`）配合多同义词查询变体，已经能够直接面向本地全文索引实现高质量的跨文献证据检索，与语义向量检索形成天然互补。

## 6. Coding Agent 的执行规则

1. **先做 M0，再完成 M1。** M1 验收后才进入 M2；M2 关键安全门槛通过后进入 M3；M4 永远最后。
2. 在有本地源码时直接修改、增加测试并执行，不要仅写建议、伪代码或 TODO 视为完成；不要凭空假设接口存在。
3. 能在当前环境验证的项目尽可能全做；真实登录或用户授权不可用时，用 mock + 可复现的 smoke 脚本完成可做部分，清楚标记 `BLOCKED`，不要求上传凭据或粘贴 token。
4. 默认仅修改此桥接项目。需要编辑 Zotero 插件、全局 agy 配置、操作用户真实文献库、发布/推送代码、开通 Yolo 或公网监听时，**先征得明确授权**；未经授权只提供变更草案与测试方案。
5. **不得用放宽安全策略或跳过测试来换取成功**。有争议则优先保守实现、保留 501 并写清阻塞证据。
6. 每个阶段结束必须输出一个简洁报告：`已完成 / 已测试（mock vs real）/ 失败或阻塞 / 剩余风险 / 下一任务`。

## 7. 首次执行建议

在项目根目录运行：

```powershell
node --version
npm test
agy --version
agy --help
agy models
```

`agy` 未安装或未认证时，仍可实施 M0/M1 的纯代码与模拟测试；真实账号认证由用户在自己的终端完成。**不必为此停止整个可离线开发的阶段。**

**首个可交付版本：v0.2.0。** 交付的必要内容是源码、测试、更新 README、`docs/UPSTREAM_CONTRACT.md`、`docs/TEST_REPORT.md`、`CHANGELOG.md`；不得仅输出说明文档而没有相应实现（如因环境限制无法实现，要在报告中说明具体阻碍）。
