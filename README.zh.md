<p align="center">
  <a href="https://www.dd322.cn/code">
    <img src="packages/app/public/logo-2000.png" alt="DuoDuo Code logo" width="200">
  </a>
</p>
<p align="center">会规划、会动手、会自查的开源 AI 编程 Agent — 桌面端 / TUI / Web。</p>
<p align="center">
  <a href="https://www.npmjs.com/package/duoduo-ai"><img alt="npm" src="https://img.shields.io/npm/v/duoduo-ai?style=flat-square" /></a>
  <a href="https://github.com/duduoduo521/duoduo-code/actions/workflows/build.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/duduoduo521/duoduo-code/build.yml?style=flat-square&branch=main" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

DuoDuo Code 是一个以 Agent 为中心的编程工具：你描述目标，它拆解任务、动手改代码、跑命令、验证结果，再向你汇报。围绕这条主线，它内置了一整套自研机制 — Rust 编写的智能层、代码库知识图谱、跨会话的项目记忆、多 Agent 并行调度，以及可一键安装技能与 MCP 服务器的智械市场。

## 核心机制

### 四阶段任务流水线

每个任务由 **调查 → 规划 → 执行 → 验证** 四个阶段驱动。主 Agent 通过 `proceed_to_*` 工具在阶段间显式推进，每个阶段有独立的上下文装配策略与产出物，而不是把所有事情塞进一整段对话。

### 多 Agent 并行与共享黑板

任务可拆时，主 Agent 会把子任务分派给多个子 Agent 并行处理（设置面板可开启「并行多智能体分发」）。并行结果按冲突分组收敛：互不冲突的并行执行，存在冲突的串行合并。子 Agent 之间通过**共享黑板**（`blackboard_*` 工具族：读 / 写 / 检索 / 提交草稿 / 提交定稿 / 批注）交换中间结论，而不是各自猜测对方做了什么。

### 代码库知识图谱

项目会被增量索引成一张**变量级粒度的知识图谱**（谁定义、谁读写、归属哪个函数），文件变更时按需增量重建，不做全量重扫。Agent 在对话中通过 `graph_query` 和 `symbol_search` 直接查询图谱与符号，找代码不再只靠全文搜索。桌面端提供**图谱看板**，可可视化浏览项目结构并一键重建索引。

### 项目记忆

重要结论会被沉淀为项目记忆，跨会话持久保存。新会话里 Agent 通过 `recall_memory` 取回此前的决策与上下文，不必每次从头认识你的项目。

### 编辑质量

- **Cascade QA** — 多阶段质量管线，以真实 LSP 诊断为依据验证每次编辑，不合格的改动会被打回重做
- **Super-RAG** — 结构化上下文检索，结合 AST 与图谱信号精准定位相关代码
- **Blueprint 预算** — 复杂任务的 Token 预算管理，避免大改动中途失控

### 快照与回滚

每次修改前自动留存快照，出问题可整体回滚；`snapshot_query` 工具还能在快照历史中检索过往编辑，方便追溯「这行代码是谁改的、为什么改」。

### 智械市场

内置的扩展市场聚合两个来源：**ModelScope 技能社区**与 **MCP 服务器注册表**。

- 搜索、筛选、一键安装技能（SKILL.md 驱动），安装后由 Agent 通过 `skill` 工具在对话中调用
- 一键安装 MCP 服务器并自动写入配置，支持重新核验连接配置
- 已安装的智械集中在设置页管理

### 模型

- **内置 DeepSeek** — 开箱即用，自动发现官方模型目录中的新模型，连接时即校验 API Key
- **自定义模型** — 在设置或 `duoduo.jsonc` 中添加任意 OpenAI 兼容的自定义供应商 / 模型

### 安全机制

| 防护 | 说明 |
|------|------|
| 权限门控 | 按工具与路径的细粒度 allow / deny / ask 审批 |
| 危险命令检测 | Rust 静态分类器：黑名单 + 语义覆盖 + 动态命令名 fail-closed |
| 密钥脱敏 | 工具输出中的密钥在送抵模型前被掩码 |
| SSRF 防护 | 网页抓取 / 仓库克隆拒绝私有与回环地址，校验重定向 |
| 路径防护 | 目录边界强制 + 敏感文件黑名单 |
| Prompt 注入围栏 | 外部指令与工具结果包裹 XML 围栏并转义元字符 |

完整安全模型见 [SECURITY.md](./SECURITY.md)。

### 桌面端

- 知识图谱看板：可视化浏览 + 一键重建索引
- 多会话标签页、可拖拽面板、深浅主题、中英双语
- 内置终端、文件树、网页预览面板
- SSH 远程项目：SFTP 双向自动同步，状态实时可见
- Git worktree 支持、桌面通知（按类别可配置）

## Agent 与工具

主 Agent 可用 `Tab` 切换，自定义 Agent 在配置中声明：

| Agent | 角色 |
|-------|------|
| `build` | 主 Agent，全权限开发 |
| `plan` | 主 Agent，只读分析 |
| `general` / `explore` / `scout` | 子 Agent，承担搜索、探索等分工 |
| `title` / `summary` / `compaction` | 内部 Agent（标题、摘要、压缩） |
| 自定义 | 在配置中定义提示词、权限与可用工具 |

内置工具一览（均为真实注册项）：

| 类别 | 工具 |
|------|------|
| 文件 | `read` / `glob` / `grep` / `edit` / `write` / `apply_patch` / `code_comment` |
| 执行 | `bash` / `webfetch` / `task`（派发子 Agent） |
| 记忆与图谱 | `graph_query` / `symbol_search` / `recall_memory` / `snapshot_query` |
| 流水线 | `proceed_to_investigate` / `proceed_to_plan` / `proceed_to_execute` / `proceed_to_verify` |
| 协作 | `blackboard_read` / `blackboard_write` / `blackboard_find` / `blackboard_submit_draft` / `blackboard_submit_stable` / `blackboard_annotate` |
| 其他 | `skill` / `todo` / `question` / `lsp`（实验）/ `plan`（实验） |
| 扩展 | 已连接 MCP 服务器提供的工具；项目 `.duoduo/tool/` 下的自定义 `.ts` 工具 |

## 安装

### CLI

```bash
# macOS / Linux
curl -fsSL https://www.dd322.cn/update/code/cli/cli | bash

# Windows (PowerShell)
irm https://www.dd322.cn/update/code/cli/cli.ps1 | iex

# Homebrew (macOS / Linux)
brew install duoduo-ai/tap/duoduocode
```

默认安装到 `$HOME/.duoduo/bin`，设置 `$DUODUO_BIN_DIR` 可自定义。

### 桌面应用

从 [www.dd322.cn/code/download](https://www.dd322.cn/code/download) 下载，安装后内置自动更新。

| 平台 | 安装包 |
|------|--------|
| macOS (Apple Silicon / Intel) | `.dmg` |
| Windows | `.exe` 安装程序 |
| Linux | `.deb` / `.rpm` / AppImage |

## 配置

在项目根目录或全局配置目录创建 `duoduo.jsonc`。完整字段见 [schema/config.json](schema/config.json)。

```jsonc
{
  // 默认模型与小模型（子 Agent、标题、压缩用）
  "model": "deepseek/deepseek-chat",
  "small_model": "deepseek/deepseek-chat",

  // 默认主 Agent
  "default_agent": "build",

  // 自定义 Agent：提示词、权限、可用工具
  "agent": {
    "my-agent": {
      "description": "负责迁移脚本",
      "prompt": "你专注于数据库迁移…",
      "mode": "primary",
      "permission": {
        "edit": { "*": "allow" },
        "bash": "ask"
      }
    }
  },

  // 供应商：内置 DeepSeek 直接填 Key；其他走 OpenAI 兼容端点
  "provider": {
    "deepseek": { "apiKey": "sk-..." },
    "my-provider": {
      "apiKey": "sk-...",
      "baseURL": "https://api.example.com/v1"
    }
  },

  // MCP 服务器：本地进程或远程 SSE
  "mcp": {
    "my-local": {
      "type": "local",
      "command": ["npx", "-y", "@my/mcp-server"]
    },
    "my-remote": {
      "type": "remote",
      "url": "https://mcp.example.com/sse"
    }
  },

  // 权限：按工具与路径
  "permission": {
    "read": { "*": "allow", "*.env": "ask" },
    "edit": { "*": "allow" },
    "bash": "ask"
  },

  // 上下文压缩
  "compaction": {
    "auto": true,
    "tail_turns": 4,
    "preserve_recent_tokens": 8000,
    "reserved": 40000
  }
}
```

## 架构

```
桌面端 (Tauri) / Web / TUI            packages/desktop · packages/app
        │
服务层（TypeScript）                  packages/duoduo — 会话 · Agent · 工具 · 权限 · MCP · LSP
        │
Rust 智能层                           crates/*
```

主要组成：

| 部分 | 说明 |
|------|------|
| `packages/duoduo` | 核心服务：会话管理、Agent 循环、工具注册、供应商路由、MCP / LSP 客户端 |
| `packages/app` / `packages/ui` | Web 界面与组件库（SolidJS） |
| `packages/desktop` | Tauri 桌面壳 |
| `packages/sdk` | 由 OpenAPI 生成的客户端 SDK |
| `crates/duo-smart-layer` | 智能层：意图识别、流水线编排、Agent 循环调度 |
| `crates/agent-executor` | 执行器：并行调度、快照、工具执行 |
| `crates/knowledge-graph-store` | 代码库知识图谱与增量索引 |
| `crates/context-builder` | 上下文装配（Super-RAG、Blueprint 预算） |
| `crates/ast-engine` | tree-sitter AST 解析 |
| `crates/code-search` | 代码语义检索 |
| `crates/blackboard-*` | 多 Agent 共享黑板 |
| `crates/permission-eval` | 权限求值 |
| `packages/plugin` | 自定义工具开发 SDK（`@duoduo-ai/plugin`） |

## 开发

要求 [Bun](https://bun.sh/) 1.3+（桌面构建另需 Rust 工具链）。

```bash
bun install

# 启动服务 + TUI
bun dev

# 只启动 API 服务器
bun dev serve --port 4096

# Web 界面（另开终端）
bun run --cwd packages/app dev

# 桌面端开发
bun run dev:desktop

# 类型检查
bun run typecheck
```

构建：

```bash
# 当前平台的独立可执行文件
./packages/duoduo/script/build.ts --single

# 桌面安装包
bun run --cwd packages/desktop tauri build
```

## 许可证

本项目基于 [opencode](https://github.com/anomalyco/opencode) 二次开发。

- opencode — Copyright (c) 2025 opencode — MIT License
- DuoDuo Code — Copyright (c) 2026 DuoDuo — [MIT](./LICENSE)

第三方组件的完整许可证声明由 `scripts/generate-third-party-licenses.ts` 在构建时生成，随发行包以 `ThirdPartyLicenses.txt` 提供；另见 [NOTICE](./NOTICE)。

## 免责声明

DuoDuo Code 是 AI 辅助编程工具，能够代您读取、写入并执行代码。其输出由机器学习模型生成，可能存在错误、不完整、安全隐患或与项目许可证冲突的情况。**请在应用任何改动前自行审查。** 您需对运行的所有命令、被修改的文件、产生的费用以及由此带来的任何后果独自负责。本软件按"现状"提供，不附带任何担保（详见 [LICENSE](./LICENSE) 与 [SECURITY.md](./SECURITY.md)）。

## Logo 版权声明

本项目卡通毛丝鼠 Logo 为独立 AI 原创形象，2026 年 4 月 28 日已完成私有 Git 前置存证，未复用任何商用图库素材，权属版权声明存放于 /logo/asset_copyright.md 文件。

若任何第三方主张本画面与在先作品存在近似争议，请通过 **duoduo@dd322.cn** 联系作者，我将第一时间调取全部创作存证材料核对并协商处理。

---

**加入我们的社区** 请访问 [www.dd322.cn/code](https://www.dd322.cn/code) —— 如有疑问或反馈，欢迎邮件 **duoduo@dd322.cn**
