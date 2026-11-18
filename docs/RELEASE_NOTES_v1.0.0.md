# agy-zotero-bridge v1.0.0 正式版发布说明 (Release Notes)

🎉 **agy-zotero-bridge v1.0.0** 正式发布！

本版本为 **Zotero** 深度学术研读场景打通了 **Google Antigravity CLI (`agy`)** 的官方集成，针对主流文献插件 **`llm-for-zotero` (v3.9.19+)** 提供了开箱即用的桥接适配能力。用户无需配置复杂的 Python 依赖或手动维护本地后台服务，即可在 Zotero 原生界面中畅享 Gemini 4、Gemini 3.8 Flash、Claude Opus/Sonnet 5.5 等顶尖大模型的 Agent 驱动文献精读与文献库管理体验。

---

## 🌟 核心亮点特性

### 1. 零依赖单文件分发（Single-File Executable）
- **真正的单文件即用**：发布资产中提供了自包含的 `agy-zotero-bridge.mjs`（及 Windows 专用的 `agy-zotero-bridge.cmd`）。
- **零外部 npm 依赖**：全量代码使用原生 Node.js 内置 API 实现，无需 `npm install` 亦无需拉取数十兆的 `node_modules`。
- **内置智能调度**：单一文件集成了 **Claude Code CLI 伪装层**、**Managed 托管桥接服务** 以及 **Stdio-to-HTTP MCP 转发代理**，根据 Zotero 传入的调用参数自动无缝切换工作模式。

### 2. 双重接入模式：全托管 vs 自定义独立桥接
- **模式 A：全托管模式（推荐，填写即用）**：
  直接将 `agy-zotero-bridge.mjs` 的绝对路径填入 Zotero 设置中的 **Claude Code path**，并保持 *Use my own bridge* 为未勾选状态。Zotero 会在开启 Agent 会话时自动按需拉起和销毁桥接，随用随启。
- **模式 B：自定义独立桥接模式（Custom Bridge）**：
  在终端中执行 `node agy-zotero-bridge.mjs --bridge`，桥接器将在本地 `127.0.0.1:8765` 启动常驻 HTTP 服务，方便开发者进行跨网络部署或调试监听。

### 3. 基础模型与思维链层级（Thinking Level）正交分离
- 针对 `agy` 原生汇报的带有思考强度的模型变体（如 `gemini-3.8-flash-low`、`gemini-4-hydrogen-xhigh` 等），桥接器在内存中对其进行归一化聚合，向 Zotero 暴露干净的基础模型列表（如 `Gemini 4 Hydrogen`、`Gemini 3.8 Flash` 等）。
- 完美适配 Zotero 设置界面的 **“默认模型”** 下拉选单，并在 **“默认推理”** 中独立选择 `low` / `medium` / `high` / `xhigh`，杜绝了此前下拉选单被 18 个冗长变体占满的问题。

### 4. 完整的 Zotero 本地文献库读写权限支持
- **默认启用文献库读写 (`writeEnabled: true`)**：全面支持 Zotero 笔记生成、批量写回、文献元数据补全及标签自动化操作（`note_write`, `library_update`, `library_import`, `file_io` 等）。
- **安全与只读保护模式**：对只读阅读场景（如仅进行论文速览分析）或开启 Plan 模式时，桥接器自动切换为严格只读保护，拦截文献库变更并提供写后校验机制。

### 5. 跨文献对比与单篇论文精读（实测通过）
- 实现了论文阅读全套 MCP 协议与安全路径沙箱穿透。支持阅读本地缓存的 PDF 文献与大文本笔记。
- 在 Zotero 10.0.8 + Windows 环境下，针对**“单篇论文精读 / 实验分析”**与**“跨文献对比”**完成真实环境端到端验证。

---

## 🚀 极速上手指引

### 环境要求
1. **Node.js** 20.0.0 或更高版本。
2. 已安装并登录官方 **Antigravity CLI**（终端运行 `agy --version` 可正常输出版本，例如 `1.5.9`）。
3. Zotero 7 / 10 + 已安装 `llm-for-zotero` (v3.9.19 或更高)。

### 配置步骤（全托管模式）
1. 从本 Release 的 **Assets** 列表中下载 `agy-zotero-bridge.mjs`。
2. 将其保存在任意本地路径（例如 `D:\Tools\agy-zotero-bridge.mjs`）。
3. 打开 **Zotero** -> 点击顶部菜单 **编辑** -> **设置** (Preferences)。
4. 左侧切换至 **llm-for-zotero** -> 顶部选择 **Agent** 标签页 -> 展开底部的 **高级 (Advanced)**：
   - 确保 **Use my own bridge** 为 **未勾选** 状态。
   - 在 **Claude Code path** 输入框中，填入下载文件的绝对路径（**注意两边请勿带有引号**）：
     ```text
     D:\Tools\agy-zotero-bridge.mjs
     ```
5. 向上滚动点击 **Restart bridge**（重启桥接），接着点击“默认模型”右侧的 **刷新**。
6. 在“默认模型”与“默认推理”中选定喜欢的模型（如 `Gemini 4 Hydrogen` + `高`），即可直接在论文会话与文献库聊天中提问！

---

## 📦 资产校验信息 (SHA-256 Checksums)

详情请参阅 Release 附件中的 `SHA256SUMS.txt`：
```text
c614ef74e54e4c27878d65eb5822f3e8b090bc78d10b7b13735b5eaec5f81804  agy-zotero-bridge.mjs
1b55979bb95574c83e1fa8ff7b71569ce4b986b2d2f703e2264b38d338db7576  agy-zotero-bridge.cmd
```
