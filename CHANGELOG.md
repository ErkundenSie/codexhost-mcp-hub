# 更新日志 (Changelog)

本项目记录每个正式版本的主要新增功能、优化与问题修复。

## [v2.5.6] - 2026-11-27

### ✨ 新增功能
- **100% 覆盖 CodexHost 全部 20 个 Harness + VS Code（内置 AI 目标增至 24 个）**：
  - **VS Code (`vscode`)**：新增 `vscode-json` 格式（完整支持 JSONC `//`、`/* */` 注释与尾逗号），自动扫描全局 `User/mcp.json`（Windows `%APPDATA%\Code\User\mcp.json` / macOS `~/Library/Application Support/Code/User/mcp.json` / Linux `~/.config/Code/User/mcp.json`）与项目级 `.vscode/mcp.json`；使用官方顶层 `servers` 结构，写入时完整保留 `inputs`、`sandbox` 与单服务的 `gallery`、`version`、`envFile`、`oauth`、`dev` 元数据，并兼容商店含 `/` 名称（如 `io.github.upstash/context7`）。
  - **Oh My Pi (`omp`)**：支持 `~/.omp/agent/mcp.json`（标准 `mcpServers` JSON）。
  - **ZCode (`zcode`)**：新增 `zcode-json` 格式，支持 `~/.zcode/cli/config.json` 嵌套结构 `mcp.servers`（兼容读取回退 `mcpServers`，写入时保留同级 `mcp` 与全局配置）。
  - **Hermes (`hermes`)**：新增零依赖局部更新器 `backend/hermes-yaml.mjs`，支持 `~/.hermes/config.yaml` 的 `mcp_servers` 区块，逐字节保留其他顶层设置、注释以及单服务的 `timeout` / `tools` / `auth` 等扩展字段。
  - **Devin CLI (`devin`)**：支持 Windows `%APPDATA%\devin\mcp_config.json` 与 macOS / Linux `~/.config/devin/mcp_config.json`。
  - **Qoder / Qoder CN 独立拆分**：按 Qoder CLI 官方规范拆分为国际版 **Qoder**（`~/.qoder/settings.json`）与国内版 **Qoder CN**（`~/.qoder-cn/settings.json`），互不串写。

### 🛠️ 优化与修复
- `shared/models.mjs` 的 `normalizeTransport` 新增对 `transport` 字段（如 Devin 的 `"transport": "sse"`）的兼容识别；`normalizeServerName` 放行 `/` 以兼容 VS Code Gallery 命名空间 ID。
- 前端 AI 配置页与原文查看弹窗自动为所有 `*-yaml` 目标（DeepSeek、Hermes）展示 `YAML` 格式标签；项目级同步新增 `.vscode/mcp.json` 选项。
- 新增 VS Code JSONC、Hermes YAML 及 ZCode / OMP / Devin / Qoder / Qoder CN 单元测试与端到端回归测试（共 28 项测试全部通过）。

---

## [v2.5.5] - 2026-11-27

### ✨ 新增功能
- **支持 DeepSeek Desktop 与 DeepSeek Web（`@deepseek-ai/dsh`）**：自动扫描并同步 `~/.dsh/profiles/desktop/cordis.patch.yml` 与 `~/.dsh/profiles/web/cordis.patch.yml`，内置 AI 配置目标增至 **18 个**。
- **零依赖 Cordis YAML 局部更新器（`backend/dsh-yaml.mjs`）**：
  - 按 DeepSeek 官方 `ConfigEditor` / `@deepseek-ai/dsh-mcp-manager` 规范写入 `- id: mcp-manager` (`config.servers.<name>`)，自动完成 `http`/`sse` ↔ `streamable-http` 与 `stdio` 跨格式互转；
  - 兼容读取并就地更新已有的独立 `- insert:` `@deepseek-ai/dsh-mcp-client` 条目（保留 `id` 及 `toolCallTimeoutMs` 等扩展字段），杜绝 `serverName` 重名冲突；
  - 逐字节保留无关 Cordis 插件块（`ui-chat`、`llm-pi-ai`、`!!js` 表达式、注释及其他插件配置）。
- **YAML 生态集成**：支持自动生成/一键恢复 `.yml` 备份文件、AI 配置页与原文查看器展示 `YAML` 格式标签，并接入实时自动同步与 YAML 语法损坏熔断保护。

### 🛠️ 优化与修复
- **OAuth 本地回调端口安全防护**：回环监听自动规避浏览器/Fetch 禁用端口（如 `6000`、`6665–6669`、`10080`），防止浏览器偶发 `ERR_UNSAFE_PORT`。
- **YAML 解析与序列化健壮性加固**：收紧纯标量安全正则（避免 `.inf`/`.nan`/`+`/`-`/`@` 误作无引号标量），并在检测 MCP 块前剥离行内注释。
- **发布流程自动化升级**：新增 `CHANGELOG.md`，GitHub Actions 发布 Release 时自动提取对应版本更新日志写入 Release 正文。
- **文案与测试完善**：修正多 Profile/多客户端目标的表述为「18 个内置 AI 目标」；新增 DeepSeek YAML 单元与跨 AI 端到端回归测试（共 25 项测试全部通过）。

---

## [v2.5.4] - 2026-11-27

### ✨ 新增功能
- **纯 Node 内置 MCP OAuth 2.1 授权（零外部依赖、零子进程）**：支持 RFC 9728 / RFC 8414 / RFC 7591 动态客户端注册与 PKCE S256 浏览器授权、登录前确认弹窗、登录后弹窗选择写入目标 AI，以及后台自动续期并静默回写各家 AI 请求头。
- **同 URL 多账户聚合单卡与令牌隔离**：支持同一远程 MCP URL 下配置多个账号（按卡片 ID 独立隔离令牌与续期），单卡内一键切换不同账号与原生登录方案。
- **一次探测永久缓存（`authHintsByUrl`）**：首次加载/导入自动识别需要鉴权（HTTP 401）的远程 MCP 并持久化缓存，后续打开零重复网络请求。

### 🛠️ 优化与修复
- 插件设置中 `enableAutoSync` 与 `enableBuiltinOAuth` 默认开启；关闭实时监听时保留「自动同步」标签页及历史策略显示。
- 全面重写 `README.md`，清理冗余 i18n 与样式代码，新增 OAuth 并发回调防重入、登出清理请求头与插件市场静态安全扫描测试。

---

## [v2.5.3] - 2026-11-27

### ✨ 新增功能
- Streamable HTTP 连通探测支持在 MCP 卡片内以可折叠面板展示全部 `tools/list` 工具名与描述。

---

## [v2.5.2] - 2026-11-27

### 🛠️ 修复
- 移除 `backend/probe.mjs` 对 `child_process` 的引用，确保通过 CodexHost 官方扩展市场静态安全扫描。

---

## [v2.5.1] - 2026-11-26

### ✨ 新增功能
- 连通探测新增 MCP 工具数量与工具名称预览展示。

---

## [v2.5.0] - 2026-11-26

### ✨ 新增功能
- 新增 GitHub Copilot CLI 专用 `copilot-json` 格式适配（`type: "local"` 及自动保留自定义 `tools` 白名单）。
- 新增「查看配置」原文弹窗、跨重启持久化自动同步日志，以及 `stdio` 参数本地脚本路径校验。
