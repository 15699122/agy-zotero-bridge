# Release Notes - v1.1.0

`agy-zotero-bridge` v1.1.0 是一个里程碑版本，深度适配 **Zotero + llm-for-zotero (v3.9.18 ~ v3.9.19+)**，重点引入了 **多模态学术图像解析、超长多文献批量上下文智能压缩、企业级进程池驻留加速（降低首字延迟 TTFT）、兼容 OpenAI 的本地语义向量（Embedding）引擎**，并彻底修复了大型编排模型（Orchestrator）在长笔记写入时的溢出卡死与退出异常。

---

## 🌟 核心新特性 (New Features)

### 1. 🖼️ M5-01: 原生多模态学术图表解析 (Multimodal Figure Inspection)
- 完整支持 Claude SDK 格式的 Base64 图像块解析与协议映射。
- 自动提取并物化图表至工作区安全临时目录，经魔数严格校验（PNG/JPEG/WEBP/GIF），通过 `view_file` 授权直接递交 `agy` 视觉模型分析。
- 支持针对论文高频出现的结构图、实验对比图、FDA/DAPI 染色荧光图及图表曲线进行精细化视觉问答。

### 2. 📚 M5-02: 结构化文献上下文自动安全压缩 (Tail-Safe Context Compaction)
- 针对 30+ 篇文献的大规模批量阅读场景，设计了专用的 Paper Scope Manifest 解析器。
- 在上下文超出阈值时，自动安全折叠并压缩历史文献元数据与冗余轮次，严格保护集合、标签及当前活跃讨论文献，避免超长上下文引发的 429 频控或截断。
- 内置 HTTP 与子进程级指数退避重试（Exponential Backoff with Jitter），稳妥化解高频请求下的临时限流。

### 3. ⚡ M7-01: 进程池常驻加速与首字延迟深度优化 (Process Pool Acceleration & TTFT Tuning)
- 默认开启进程池常驻（Process Pool），支持温进程保持与按会话作用域的平滑轮换。
- 新增主动衰老机制（按轮次与时间衰退淘汰），兼顾快速响应与系统内存健康。
- 优化温 CLI 模式与预热握手，大幅降低首次与连续问答的首字等待延迟（TTFT）。

### 4. 🧠 M7-02: OpenAI 兼容的语义向量引擎 (Semantic Embeddings Engine)
- 原生暴露 `/v1/embeddings` 与 `/embeddings` 端点，无缝对接 Zotero 的语义检索与知识库向量召回。
- 内置本地双语快速语义特征提取算法（L2 归一化余弦相似度），支持基于磁盘的 LRU 向量缓存，开箱即用、零额外依赖。
- 同时支持透明代理上游嵌入式 API，兼顾本地离线私密性与高精度嵌入需求。

---

## 🛠️ 重要缺陷修复与稳定性提升 (Bug Fixes & Hardening)

### 1. 修复 Orchestrator 长笔记写入溢出与卡死 (Fix Orchestrator 205 KB Spill Loop)
- **原因分析**：`note_write` 成功后返回超大体积的整篇笔记校验 JSON（单次高达 205 KB），导致 `agy` 底层被迫转入磁盘临时文件并进入 46 KB 分块反复阅读陷阱，长达十多分钟无法结算并引发 `print_timeout`。
- **解决方案**：在 MCP Stdio-HTTP 代理层对工具返回值进行结构化语义精简压缩（保留成功状态与关键定位标识，剔除回显的超大正文），将返回值压缩至百字节以内，彻底解决大模型反复读取问题。

### 2. 解决 MCP 工具别名 64 字符超长截断 (Fix MCP Alias Overflow)
- 缩减动态生成的 MCP 插件别名，确保完整工具标识符始终严格控制在 64 字符上限以内，杜绝底层 `mcp_client_session_instance.go:231` 抛出的工具名称超长警告。

### 3. 消除空文本导致非正常退出 ("No response." Exit Recovery)
- 修复了模型执行完笔记写入等纯工具动作后未输出文本总结时被标记为 `runtime_empty_response` ("No response.") 的问题；完善兜底摘要生成，确保整轮任务优雅结算并返回正确状态码。

### 4. 优化模型发现与配额感知 (Model Probe & Catalog Hardening)
- 完善 `models-cache.json` 磁盘缓存与探活机制，支持模型族群与思考等级（Effort: `low` / `medium` / `high` / `xhigh`）的无缝转换。
- 适配 Claude Sonnet 5.5 / Opus 5.5、Gemini 4 Hydrogen / Argon 以及 Gemini 3.8 Flash 等最新模型体系。

---

## 📦 发布产物 (Release Assets)

| 文件名 | 说明 |
| :--- | :--- |
| **`agy-zotero-bridge.mjs`** | 单文件全功能运行包（Node >= 20，内置零外部 npm 依赖），直接在 Zotero 设置中指定路径即可运行。 |
| **`agy-zotero-bridge.cmd`** | Windows 命令行启动包装器，方便直接配置至 Claude Code CLI 路径。 |
| **`SHA256SUMS.txt`** | 资产完整性校验文件。 |

---

## 🚀 升级与使用指引 (Quick Start)

1. 下载最新的 `agy-zotero-bridge.mjs`。
2. 打开 **Zotero** -> **首选项** -> **llm-for-zotero** -> **Agent**：
   - **Claude Code CLI 路径**：填入下载的 `agy-zotero-bridge.mjs` 绝对路径（或配套的 `.cmd` 路径）。
   - **流式输出**：建议保持 **勾选**（体验实时思考与工具调用卡片）。
   - **自动压缩**：建议保持 **取消勾选**（Bridge 已内置更安全的文献上下文自动压缩）。
   - **推荐模型**：日常精读与学术问答首选 **`Claude Sonnet 5.5 (Low)`** 或 **`Gemini 3.8 Flash (Low)`**。
