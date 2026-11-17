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

- [ ] `M0-01` 读取全部基线文件与官方/上游协议；建立来源追踪表。
- [ ] `M0-02` 运行基线 10 测试；记录原版本与当前环境。
- [ ] `M1-01` 抽取可单测的 agy NDJSON parser / event mapper；保留旧接口。
- [ ] `M1-02` 添加真实格式 fixtures 的脱敏方案，覆盖异常、工具与增量。
- [ ] `M1-03` 处理超时、stderr、退出、Abort、Windows 子进程树与写入背压。
- [ ] `M1-04` 完成 `/structured-completion` 或提交明确的不支持证据。
- [ ] `M1-05` 模型/effort/healthz 真实能力探测与安全回退。
- [ ] `M1-06` 输出 `docs/TEST_REPORT.md`、回归测试与 v0.2 CHANGELOG。
- [ ] `M2-01` 验证 Zotero MCP endpoint、工具与鉴权实际合同。
- [ ] `M2-02` agy MCP 注册、只读检索与元数据可追踪。
- [ ] `M2-03` Notes/标签受控写入、预览与回读测试。
- [ ] `M2-04` MCP 错误恢复、失效凭据、权限与端点兼容性。
- [ ] `M3-01` 完整插件上下文、PDF/图像真实能力验证与实现。
- [ ] `M3-02` 用户 Skills/项目指令加载与信任边界。
- [ ] `M3-03` 六类文献工作流回归与引用/写入准确性检查。
- [ ] `M4-01` stdin stream-json 常驻进程模型、回合隔离、累计 usage 归一化。
- [ ] `M4-02` 进程池、空闲清理、错误恢复、取消与回滚。
- [ ] `M4-03` Windows/Zotero 长时稳定性、性能与发布文档。

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
