<p align="center">
  <a href="https://www.dd322.cn/code">
    <img src="packages/app/public/logo-2000.png" alt="DuoDuo IDE logo" width="200">
  </a>
</p>
<p align="center">开源的、不绑定供应商的 AI 编程 Agent。</p>
<p align="center">
  <a href="https://www.npmjs.com/package/duoduo-ai"><img alt="npm" src="https://img.shields.io/npm/v/duoduo-ai?style=flat-square" /></a>
  <a href="https://github.com/duduoduo521/duoduo-code/actions/workflows/build.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/duduoduo521/duoduo-code/build.yml?style=flat-square&branch=main" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## 为什么选择 DuoDuo IDE？

- **不绑定供应商** — 不依赖任何单一 LLM 供应商。可使用 OpenAI、Anthropic、Google、本地模型等 20+ 供应商。
- **100% 开源** — 完全透明，社区驱动开发。
- **客户端/服务器架构** — 服务器可运行于任何位置，通过 TUI、Web、桌面或移动端驱动。
- **内置 LSP 支持** — 开箱即用的诊断、补全和跳转定义。
- **终端优先** — 由 Neovim 用户打造，持续探索终端的极限。

---

## 功能特性

### 多模型支持

连接任意 LLM 供应商，自由切换，无供应商锁定。

| 供应商 | 供应商 | 供应商 |
|--------|--------|--------|
| OpenAI | Anthropic | Google |
| xAI | Groq | Mistral |
| Cohere | Amazon Bedrock | Azure |
| DeepInfra | Together | Perplexity |
| Vercel | 阿里云通义千问 (Qwen) | OpenRouter |
| GitLab | Venice | Cloudflare AI Gateway |
| 讯飞星火 | GitHub Copilot | SAP AI Core |

### Agent 系统

| Agent | 模式 | 说明 |
|-------|------|------|
| **build** | 主 Agent | 默认全权限 Agent，用于开发工作 |
| **plan** | 主 Agent | 只读 Agent，用于代码分析与探索 |
| **general** | 子 Agent | 复杂搜索和多步任务（`@general`） |
| **explore** | 子 Agent | 快速代码库探索和搜索（`@explore`） |
| **review** | 子 Agent | 代码审查，生成行内评论和建议 |
| **compaction** | 内部 | 会话压缩，管理上下文窗口 |
| **title** | 内部 | 自动生成会话标题 |
| **summary** | 内部 | 进度摘要生成 |
| 自定义 | 用户定义 | 通过配置创建自定义 Agent |

使用 `Tab` 键在主 Agent 之间切换。可在配置中定义自定义 Agent。

### 工具系统

| 工具 | 说明 |
|------|------|
| `read` | 读取文件内容 |
| `write` | 创建或覆盖文件 |
| `edit` | 对现有文件进行精确编辑 |
| `bash` | 执行 Shell 命令 |
| `grep` | 使用正则搜索文件内容 |
| `glob` | 按模式匹配查找文件 |
| `webfetch` | 获取并提取网页内容 |
| `task` | 将工作委派给子 Agent |
| `apply_patch` | 通过统一差异格式批量应用补丁 |
| `code_comment` | 插入行内代码审查评论 |
| `lsp` | 基于 LSP 的诊断和操作 |
| `question` | 向用户请求澄清 |
| `skill` | 调用 Agent 技能 |
| `todowrite` | 创建并跟踪结构化任务清单 |
| `plan_exit` | 退出规划模式并开始执行 |
| `graph_query` | 查询项目知识图谱 |
| `symbol_search` | 代码符号语义搜索 |
| `recall_memory` | 回忆已沉淀的项目记忆 |
| `search_modifications` | 在代码快照历史中检索过往修改 |
| `proceed_to_<phase>` | 推进流水线阶段（`investigate` / `plan` / `execute` / `verify`） |
| `blackboard_*` | 多 Agent 共享黑板（读 / 写 / 检索 / 提交 / 批注） |
| MCP 工具 | 已连接的 MCP 服务器暴露的任何工具 |

### 代码编辑

- **智能补全** — 上下文感知的代码建议
- **行内编辑** — 无需离开对话即可进行精确编辑
- **多文件编辑** — 跨多个文件协调修改
- **apply_patch** — 批量应用统一差异补丁，适用于大型变更集
- **Cascade QA** — 多阶段质量保证流水线，根据 LSP 诊断验证编辑

### 会话管理

- **多会话并行** — 同时处理多个任务
- **会话分叉** — 分支对话以探索不同方案
- **会话压缩 (Compaction)** — 接近 Token 限制时自动压缩上下文
- **上下文溢出处理** — 优雅管理上下文窗口溢出，支持自动发现限制
- **进度摘要** — 自动生成会话进度摘要

### 知识系统

由 Rust Crate 驱动，性能卓越：

| 组件 | 说明 |
|------|------|
| 知识图谱 (Knowledge Graph) | 结构化关系存储，用于代码库理解 |
| 向量存储 (Vector Store) | 基于嵌入的语义搜索 |
| 智能层 (Smart Layer) | 意图检测、质量评估和流水线编排 |
| 记忆系统 (Memory) | 跨会话的持久化记忆 |

### 文件树

- 浏览项目文件和目录
- 创建、删除和重命名文件/文件夹
- 多选操作
- 搜索和过滤
- 拖拽排序

### 集成终端

- 基于 **ghostty-web** 的全功能终端体验
- Bash 工具集成，执行命令
- PTY 支持（Bun 和 Node.js 运行时）

### MCP (Model Context Protocol)

- 完整的 MCP 客户端实现，连接外部工具服务器
- Agent Client Protocol (ACP) 支持，实现 Agent 间通信
- 远程 MCP 服务器的 OAuth 认证流程
- 可配置超时和环境变量

### 插件系统

通过自定义功能扩展 DuoDuo IDE：

- **自定义工具** — 通过 `@duoduo-ai/plugin` SDK 注册新工具
- **自定义 Agent** — 定义具有自定义提示和权限的 Agent
- **生命周期钩子** — 转换系统提示、拦截事件等

```typescript
import { tool } from "@duoduo-ai/plugin"

export default tool({
  name: "my-tool",
  description: "A custom tool",
  // ... implementation
})
```

### 代码质量

- **LSP 集成** — 实时诊断、悬停信息、跳转定义
- **Cascade QA** — 多阶段验证流水线
- **Super-RAG** — 结构化上下文检索，精准生成代码
- **Blueprint 预算** — 复杂任务的 Token 预算管理

### 通知

桌面通知，按类别可配置：

- 任务完成
- 任务失败
- 权限请求

### 设置

通过 `duoduo.jsonc` 进行全面配置：

- **模型配置** — 默认模型、小模型、按 Agent 覆盖模型
- **Agent 配置** — 自定义 Agent、提示、权限、工具访问
- **MCP 服务器** — 本地 (stdio) 和远程 (SSE) MCP 服务器连接
- **权限管理** — 按工具和路径的细粒度 allow/deny/ask 规则
- **通知开关** — 按类别启用/禁用通知
- **界面语言** — 中英文界面

### 界面

- 🌐 **双语** — 中英文界面
- 🌙 **主题** — 暗色/亮色主题
- 📑 **标签页** — 多标签会话管理
- 🔀 **可拖拽面板** — 灵活布局，面板可调整大小

### 安全

DuoDuo IDE 以启动它的账户权限运行，**没有被 OS 级沙箱包裹**。Agent 可以读取文件、执行 shell 命令、安装扩展、调用外部服务。在用于不可信代码之前，请先阅读 [SECURITY.md](./SECURITY.md) 了解完整安全模型与已知边界。

已实施的防护：

| 特性 | 实现方式 |
|------|----------|
| 权限审批系统 | 按工具和路径的细粒度 `allow` / `deny` / `ask`（`gate_permission`） |
| 危险命令检测 | Rust 静态分类器（`bash_safety`）：正则黑名单 + 语义覆盖 + 动态命令名 fail-closed |
| Prompt 注入围栏 | gear/skill 指令、工具结果、策略附加均包裹 XML 围栏并转义元字符；系统 prompt 声明 `<structural_contract>` |
| 密钥脱敏 | 工具结果中的密钥在送抵模型前被掩码（`sanitize_tool_output`） |
| SSRF 防护 | `webfetch` / `clone_repo` 的私有/回环主机拒绝与重定向检查 |
| 路径穿越防护 | 目录边界强制执行；敏感文件黑名单（`is_sensitive_path`） |
| CORS/CSRF 防护 | 服务端 CORS 配置和 CSRF 令牌 |

**不保证**：命令执行的 OS 级沙箱，以及对 prompt 注入的绝对免疫（模型对声明的遵守是概率性的——真正的兜底仍是权限门 + OS 隔离）。详见 [SECURITY.md](./SECURITY.md)。

---

## 安装

### 命令行

```bash
# 快速安装（macOS / Linux）
curl -fsSL https://www.dd322.cn/update/code/cli/cli | bash

# 快速安装（Windows，PowerShell）
irm https://www.dd322.cn/update/code/cli/cli.ps1 | iex

# Homebrew Tap（macOS / Linux，推荐）
brew install duoduo-ai/tap/duoduocode
```

> [!TIP]
> 安装前请先移除 0.1.x 之前的旧版本。

### 桌面应用

从 [发布页](https://github.com/duduoduo521/duoduo-code/releases) 或 [www.dd322.cn/code/download](https://www.dd322.cn/code/download) 下载。

| 平台                  | 下载文件                                |
| --------------------- | --------------------------------------- |
| macOS (Apple Silicon) | `DuoDuoCode-<version>-aarch64.dmg` |
| macOS (Intel)         | `DuoDuoCode-<version>-x64.dmg`     |
| Windows               | `DuoDuoCode-<version>-x64-setup.exe`    |
| Linux                 | `.deb`、`.rpm` 或 AppImage              |

安装包见上表，安装后内置自动更新；也可从[发布页](https://github.com/duduoduo521/duoduo-code/releases)或下载页获取。

### 安装目录

安装脚本默认安装到 `$HOME/.duoduo/bin`。设置 `$DUODUO_BIN_DIR` 可自定义安装目录。

```bash
DUODUO_BIN_DIR=/usr/local/bin curl -fsSL https://www.dd322.cn/update/code/cli/cli | bash
DUODUO_BIN_DIR=$HOME/.local/bin curl -fsSL https://www.dd322.cn/update/code/cli/cli | bash
```

---

## 配置

DuoDuo IDE 使用 `duoduo.jsonc` 配置文件。可在项目根目录或全局配置目录中创建。

### 模型配置

```jsonc
{
  // 所有 Agent 的默认模型
  "model": "anthropic/claude-sonnet-4-20250514",

  // 子 Agent 和压缩使用的小模型
  "small_model": "anthropic/claude-haiku-4-20250506",

  // 默认 Agent
  "default_agent": "build",

  // 启用/禁用特定供应商
  "enabled_providers": ["anthropic", "openai"],
  "disabled_providers": ["venice"]
}
```

### 供应商配置

```jsonc
{
  "provider": {
    "anthropic": {
      "apiKey": "sk-ant-..."
    },
    "openai": {
      "apiKey": "sk-..."
    },
    "alibaba": {
      "apiKey": "sk-...",
      "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1"
    }
  }
}
```

### Agent 配置

```jsonc
{
  "agent": {
    "build": {
      "model": "anthropic/claude-sonnet-4-20250514",
      "temperature": 0.3
    },
    "plan": {
      "model": "anthropic/claude-sonnet-4-20250514"
    },
    "my-custom-agent": {
      "description": "用于特定任务的自定义 Agent",
      "prompt": "你是一个专门的 Agent...",
      "mode": "primary",
      "permission": {
        "edit": { "*": "allow" },
        "bash": "ask"
      }
    }
  }
}
```

### MCP 服务器

```jsonc
{
  "mcp": {
    "my-local-server": {
      "type": "local",
      "command": ["npx", "-y", "@my/mcp-server"],
      "environment": {
        "API_KEY": "..."
      },
      "timeout": 30000
    },
    "my-remote-server": {
      "type": "remote",
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "Bearer ..."
      },
      "oauth": {
        "clientId": "...",
        "scope": "read write"
      }
    }
  }
}
```

### 权限

```jsonc
{
  "permission": {
    "read": { "*": "allow", "*.env": "ask" },
    "edit": { "*": "allow" },
    "bash": "ask",
    "webfetch": "allow",
    "external_directory": { "*": "ask" }
  }
}
```

### 会话压缩

```jsonc
{
  "compaction": {
    "auto": true,
    "tail_turns": 4,
    "preserve_recent_tokens": 8000,
    "reserved": 40000
  }
}
```

完整配置参考请查看 [schema/config.json](schema/config.json)。

---

## 支持的模型

DuoDuo IDE 支持所有已连接供应商的模型。模型从各供应商自身的模型目录自动发现，可按供应商过滤：

| 供应商 | 示例模型 |
|--------|----------|
| OpenAI | GPT-4o, o3, o4-mini |
| Anthropic | Claude Sonnet 4, Claude Haiku 4 |
| Google | Gemini 2.5 Pro, Gemini 2.5 Flash |
| xAI | Grok 3, Grok 3 Mini |
| 阿里云通义千问 | Qwen3-235B, Qwen3-Coder |
| Mistral | Mistral Large, Codestral |
| Cohere | Command R+ |
| Amazon Bedrock | Claude, Llama via Bedrock |
| Azure | GPT-4o via Azure OpenAI |
| 讯飞星火 | Spark 4.0 Ultra |
| GitHub Copilot | GPT-4o via Copilot |
| 本地模型 | 任何 OpenAI 兼容端点 |

每个模型可配置成本追踪、上下文限制、模态和供应商特定选项。

---

## 架构

```
┌─────────────────────────────────────────────────┐
│                   客户端                          │
│  ┌─────────┐  ┌─────────┐  ┌─────────────────┐ │
│  │   TUI   │  │ Web 应用 │  │ 桌面端 (Tauri)  │ │
│  └────┬────┘  └────┬────┘  └────────┬────────┘ │
└───────┼─────────────┼────────────────┼──────────┘
        │             │                │
        └─────────────┼────────────────┘
                      │ HTTP / WebSocket
┌─────────────────────┼───────────────────────────┐
│              服务器 (packages/duoduo)             │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  Agent   │ │  会话    │ │    智能层         │ │
│  │   系统   │ │  管理器  │ │ (意图/质量)      │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  供应商  │ │   MCP    │ │    权限系统       │ │
│  │   路由   │ │   客户端 │ │                  │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  工具    │ │   LSP    │ │   质量 /         │ │
│  │  注册表  │ │   客户端 │ │   Cascade QA     │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  插件    │ │   ACP    │ │   压缩引擎       │ │
│  │   SDK    │ │   服务器 │ │                  │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
└─────────────────────────────────────────────────┘
                      │
┌─────────────────────┼───────────────────────────┐
│           Rust Crate (crates/)                   │
│  ┌───────────────┐ ┌────────────┐ ┌───────────┐ │
│  │   知识图谱    │ │  向量存储  │ │  记忆系统 │ │
│  │  (Knowledge   │ │  (Vector   │ │  (Memory  │ │
│  │   Graph)      │ │   Store)   │ │  System)  │ │
│  └───────────────┘ └────────────┘ └───────────┘ │
│  ┌───────────────┐ ┌────────────┐ ┌───────────┐ │
│  │   安全设计    │ │  AST 引擎  │ │  代码搜索 │ │
│  │  (Security    │ │  (AST      │ │  (Code    │ │
│  │   Design)     │ │   Engine)  │ │  Search)  │ │
│  └───────────────┘ └────────────┘ └───────────┘ │
└─────────────────────────────────────────────────┘
```

### 核心包

| 包 | 说明 |
|----|------|
| `packages/duoduo` | 核心服务器 — Agent 逻辑、会话管理、工具注册、供应商路由 |
| `packages/app` | 共享 Web UI 组件 (SolidJS) |
| `packages/desktop` | 原生桌面应用 (Tauri) |
| `packages/plugin` | 插件 SDK (`@duoduo-ai/plugin`) |
| `packages/sdk` | 生成的 API 客户端 SDK |
| `packages/shared` | 共享工具和类型 |

---

## 参与贡献

欢迎贡献！请在提交 PR 前阅读 [贡献指南](./CONTRIBUTING.md)。

### 开发环境

要求：[Bun](https://bun.sh/) 1.3+

```bash
# 安装依赖
bun install

# 启动开发服务器
bun dev

# 指定目录启动
bun dev /path/to/project

# 启动 API 服务器
bun dev serve --port 4096

# 启动 Web 应用（另开终端）
bun run --cwd packages/app dev

# 启动桌面应用
bun run --cwd packages/desktop tauri dev
```

### 构建

```bash
# 构建独立可执行文件
./packages/duoduo/script/build.ts --single

# 构建桌面应用
bun run --cwd packages/desktop tauri build
```

### PR 规范

- 所有 PR 必须关联已有 Issue
- 遵循约定式提交格式（`feat:`、`fix:`、`docs:` 等）
- 保持 PR 小而聚焦
- UI 变更需附带截图/视频
- 禁止 AI 生成的 PR 描述

---

## 许可证

本项目基于 [opencode](https://github.com/anomalyco/opencode) 二次开发。

- opencode — Copyright (c) 2025 opencode — MIT License
- DuoDuo AI IDE — Copyright (c) 2026 DuoDuo — [MIT](./LICENSE)

第三方开源组件的完整许可证声明在构建时由 `scripts/generate-third-party-licenses.ts` 自动生成，随每个发行包以 `ThirdPartyLicenses.txt` 提供；另见 [NOTICE](./NOTICE)。

## 免责声明

DuoDuo IDE 是 AI 辅助编程工具，能够代您读取、写入并执行代码。其输出由机器学习模型生成，可能存在错误、不完整、安全隐患或与项目许可证冲突的情况。**请在应用任何改动前自行审查。** 您需对运行的所有命令、被修改的文件、产生的费用以及由此带来的任何后果独自负责。本软件按"现状"提供，不附带任何担保（详见 [LICENSE](./LICENSE) 与 [SECURITY.md](./SECURITY.md)）。

## Logo 版权声明

本项目卡通毛丝鼠 Logo 为独立 AI 原创形象，2026 年 4 月 28 日已完成私有 Git 前置存证，未复用任何商用图库素材，权属版权声明存放于 /logo/asset_copyright.md 文件。

若任何第三方主张本画面与在先作品存在近似争议，请通过 **duoduo@dd322.cn** 联系作者，我将第一时间调取全部创作存证材料核对并协商处理。

---

**加入我们的社区** 请访问 [www.dd322.cn/code](https://www.dd322.cn/code) —— 如有疑问或反馈，欢迎邮件 **duoduo@dd322.cn**
