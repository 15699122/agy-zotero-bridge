# Release Notes - v1.2.0

> **发布版本**: `v1.2.0`  
> **发布日期**: 2026-11-19  
> **适用插件**: `llm-for-zotero` (v3.9.18 ~ v3.9.19+)  
> **核心组件**: Google Antigravity CLI (`agy` v1.5.9 ~ v1.5.12+)

---

## 概述 (Overview)

`v1.2.0` 是一个面向**全自动模型感知**与**混合格式文献/补充材料（SI）智能路由**的重大功能版本。

在本版本中，桥接器彻底摆脱了过去依赖硬编码模型名单的维护负担，引入了**零维护命令行自适应探测**机制，能够自动捕获 Google 发布的全新模型与推理（Thinking/Effort）等级；同时，针对科研工作流中高频出现的 **MinerU Markdown 主文献 + Word (`.doc`/`.docx`) 补充材料** 场景，重构了精准路由与代理层诊断系统，解决了长文本截断、乱码及工具调用失败等体验痛点。

---

## 主要更新内容 (Key Features & Highlights)

### 1. 零维护命令行模型与推理级别自动探测 (Zero-Maintenance Dynamic Model & Effort Discovery)
- **免手动维护**: 实时解析 `agy.exe models --json`（或 TSV 表格输出）及 `--help --effort` 帮助文档，自动提取可用基模型（Base Model）及其对应的推理级别（`low`, `medium`, `high`, `xhigh`, `max`）。Google 云端上线或 CLI 新增任何模型均可自动识别，无需等待桥接器发版。
- **智能过滤无推理等级模型**: 针对部分原生不支持 `--effort` 的模型（如 `gemini-4-carbon`），探测器自动打标 `supportsEffort: false` 并在下发调用时主动剥离 `--effort` 参数，彻底根除 CLI 报错。
- **SWR (Stale-While-Revalidate) 缓存与版本感知**: 
  - 内存级 SWR 探测（默认 2 分钟），避免频繁启动 `agy.exe` 进程造成延迟；
  - 磁盘缓存文件 `models-cache.json` 自动绑定 `bridgeVersion` 与 `agyVersion`，任一组件更新立即触发主动刷新，且在系统停机或进程退出时干净释放。
- **全面跟进 Google 最新模型族**: 内置对 **Gemini 4 Neon** (`gemini-4-neon`)、**Orchestrator (Neon)** (`gemini-pro-orchestrator-neon`)、**Gemini 4 Carbon** (`gemini-4-carbon`) 以及未来通配 `gemini-pro-orchestrator-*` 的离线降级识别。

### 2. MinerU Markdown 主文献与 `.doc` / `.docx` 补充材料精准路由
- **自适应工具分流**:
  - **PDF 格式主文献**: 严格路由至 `paper_read` 工具链，支持按章节深度检索与精准图表截取（`mode: "targeted"` / `mode: "figures"`）。
  - **无 PDF 的 MinerU `.md` 主文献、`.txt`、`.html` 及 `.docx` 补充材料**: 在工作区规则（`rules/AGENTS.md`）中显式引导模型直接使用 `read_attachment({ target: { contextItemId } })`，严禁对非 PDF 附件滥用 `paper_read`（彻底解决 `no PDF or text attachment was found for it` 报错）。
- **MinerU 图表独立审阅**: 当文献仅有 MinerU `.md` 输出而无原始 PDF 时，允许模型通过 `read_file` / `view_file` 按需审阅目录下的图片附件。

### 3. 增强型代理诊断与截断提示 (Proxy Diagnostics & Truncation Guidance)
- **旧版 Word 二进制 (`.doc`) 自动清洗与指引**: 针对 Word 97–2003 二进制格式在 `read_attachment` 中被误解为纯文本产生的无意义乱码，代理层自动截断并返回结构化诊断信息 `unsupported_binary_doc`，明确指引用户将其另存为 `.docx` 或 `.pdf`。
- **`.docx` 结构化提取提示**: 标注 `.docx` 文本仅解析自 `word/document.xml`（不含嵌入图片），防止模型对遗漏图表产生幻觉；对纯图片/空白 `.docx` 给出 `empty_or_image_only_docx` 警告。
- **50,000 字符截断自愈提示**: 当遇到 `read_attachment` 默认上限截断时，自动附带 `truncationHint`，提示模型以更大的 `maxChars`（如 `200000`）重新请求。
- **`paper_read` 拦截兜底**: 当 `paper_read` 偶发抛出目标不可解析错误时，代理层在回传给模型的消息末尾追加 `[Bridge hint]`，指导其无缝切换到 `read_attachment`。

### 4. 运行时权限放行与作用域元数据增强
- **多文献作用域清单增强**: 多篇文献检索清单中完整透传 `attachmentTitle` 与 `contentSourceMode`，杜绝长文本折叠时关键附件信息丢失。
- **安全路径自动探测放行**: 运行时自动提取 `attachmentPath`、`filePath` 及 MinerU 缓存目录，写入会话级只读权限名单（`read_file(<dir>)` / `view_file(<dir>)`），无需用户手动配置复杂路径权限。

---

## 验证与测试 (Verification & Quality Assurance)

- **测试套件全覆盖**: 
  - 单元测试（Unit Tests）: `36 / 36` 通过
  - 单文件打包验证（Bundle Tests）: `3 / 3` 通过
  - 端到端集成测试（Integration Tests）: `27 / 27` 通过
  - **总计: 66 / 66 测试项全绿通过**。
- **实机运行确认**: 成功适配已自动升级至 `1.5.12` 的 `agy.exe`，动态探测并正确分组全部 9 个基模型与 5 级 Thinking Levels。

---

## 资产与使用方式 (Release Assets & Getting Started)

| 资产文件 | 说明 | 校验方式 |
| :--- | :--- | :--- |
| `agy-zotero-bridge.mjs` | 单文件完全自包含桥接器脚本（无依赖） | SHA256SUMS.txt |
| `agy-zotero-bridge.cmd` | Windows 快捷启动批处理入口 | SHA256SUMS.txt |
| `SHA256SUMS.txt` | 构建产物校验哈希文件 | sha256sum |

### 快速接入指引
1. 下载 `agy-zotero-bridge.mjs` 到本地任意目录；
2. 在 Zotero 侧边栏打开 **LLM for Zotero** 偏好设置：
   - 模式选择: **Claude Code path** 或自定义桥接模式；
   - 路径填入: `agy-zotero-bridge.mjs` 的绝对路径；
3. 点击 **Restart bridge** 重启桥接器即可享受完整自适应与混合文献审阅体验！
