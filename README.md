# MCP Hub — CodexHost 统一 MCP 中心（`manifestVersion: 2`）

在 CodexHost 的 **Desktop** 与 **Web** 之间提供一个跨端统一的 MCP（Model Context Protocol）管理与多 AI 配置同步插件：一次配置 MCP，一键安全同步到本机各家 AI 的原生配置文件中。即使后续关闭或卸载 CodexHost，各家 AI 的 MCP 配置依然完整保留。

## 核心功能

- **自动扫描 16 家本机 AI**：自动检测并读取 Codex、Pi、Claude Code、Antigravity (`agy`)、Grok、Cursor / Cursor CLI、GitHub Copilot CLI、CodeBuddy、Claude Desktop、OpenCode、Qwen Code、Gemini CLI、Kiro CLI、Kimi Code、WorkBuddy、Qoder 等原生 MCP 配置，并支持自定义路径与自定义 JSON 目标。
- **快速配置向导 & 卡片单条应用**：
  - 顶部「快速配置」两步向导：默认全选 MCP → 选择目标 AI 与覆盖保护 → 一键批量添加或移除；
  - 单条 MCP 卡片内直接勾选/取消各家 AI，卡片底部「撤销 / 应用」即时写入该条 MCP，互不干扰。
- **同名多配置别名支持**：如果不同 AI 存在同名但配置不同的 MCP，导入时会全部展示并自动附带来源别名（如 `Codex` / `Pi`），分别托管互不误覆盖。
- **一键汇总导入 & JSON 粘贴**：从本机已检测 AI 按真实配置现状一键导入，或直接粘贴标准 `mcpServers` / OpenCode JSON。
- **安全增量同步 + 自动备份恢复**：
  - Codex / Grok TOML 采用局部段落级更新，保留原文件注释、模型与其他配置；
  - 自动排除并保护官方内置 MCP（如 Codex Desktop 的 `node_repl`），不误删各 AI 里手工维护的非托管项；
  - 每次写入前自动备份原配置文件（最多保留 40 份），支持在「项目与备份」页一键恢复。
- **防套娃保护**：自动识别指向本机 CodexHost（`127.0.0.1:4398/mcp`）的回环 MCP，避免误同步到全部内部 AI。
- **项目级配置同步**：支持按项目目录扫描或写入 `.mcp.json`、`.cursor/mcp.json`、`.codex/config.toml`、`opencode.json`。
- **HTTP / SSE 连通性测试**：快速探测远程 MCP 端点可达性与鉴权状态。

## 目录结构

```text
codexhost-mcp-hub/
├── manifest.json                 # manifestVersion: 2 插件清单
├── assets/
│   ├── icon.png                  # 插件图标 (256x256 PNG)
│   └── preview.png               # 插件预览图 (960x540 PNG)
├── shared/
│   ├── i18n.mjs                  # 中英文文案
│   └── models.mjs                # MCP 规范化、JSON 导入解析、内置识别与指纹对比
├── page/
│   ├── index.mjs                 # Desktop + Web 配置页入口 (mount)
│   ├── dom.mjs                   # 通用 DOM 构建与格式化辅助函数
│   ├── modals.mjs                # 快速配置、添加/编辑 MCP 与确认弹窗
│   ├── tabs/
│   │   ├── servers.mjs           # MCP 列表标签页
│   │   ├── targets.mjs           # AI 配置标签页
│   │   └── project-backups.mjs   # 项目与备份标签页
│   └── style.css                 # 使用 --cx-page-* 主题变量（支持浅/深色）
├── backend/
│   ├── index.mjs                 # 共享 Host 单实例 Node 后端入口 (activate)
│   ├── adapters.mjs              # 16 家内置 AI + 自定义目标 + 项目级适配器
│   ├── toml.mjs                  # Codex / Grok TOML 注释保留型局部更新器
│   ├── store.mjs                 # 中心库持久化与自动备份管理
│   └── probe.mjs                 # HTTP/SSE 连通性测试与 stdio 校验
├── scripts/
│   ├── generate-assets.mjs       # 纯 Node PNG 图标与预览图生成脚本
│   └── pack.mjs                  # 纯 Node 打包脚本（输出 dist/mcp-hub-<version>.zip）
└── test/
    └── hub.test.mjs              # 自动化单元测试
```

## 构建与打包

本插件**零外部运行时依赖**（全部使用标准 ESM 与 Node 内置模块）：

```bash
# 重新生成图标与预览图（可选）
node scripts/generate-assets.mjs

# 打包为 .zip（输出至 dist/mcp-hub-<version>.zip）
node scripts/pack.mjs

# 运行自动化测试（含 ZIP 结构与 CRC 校验）
node --test test/hub.test.mjs
```

## 安装与更新

1. 打开 CodexHost Desktop（**设置 → 插件**）或 CodexHost Web（左侧一级导航 **插件**）；
2. 若已安装旧版 `mcp-hub`，请先卸载旧版（或通过插件详情更新）；
3. 点击 **导入插件** 并上传打包好的 `dist/mcp-hub-2.3.1.zip`；
4. 启用 **「MCP 统一中心」** 后，即可在顶部标签栏或「插件页面」打开配置页。

## 发布到 GitHub

1. 在 GitHub 推送本仓库源码（`dist/` 默认已忽略）；
2. 运行 `node scripts/pack.mjs` 生成 `dist/mcp-hub-<version>.zip`；
3. 创建 GitHub Release（例如 tag `v2.3.1`），将 `.zip` 作为 Release 资产上传，即可通过仓库链接或 `.zip` 分发给其他用户。
