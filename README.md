<p align="center">
  <a href="https://www.dd322.cn/code">
    <img src="packages/app/public/logo-2000.png" alt="DuoDuo IDE logo" width="200">
  </a>
</p>
<p align="center">The open-source, provider-agnostic AI coding agent.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/duoduo-ai"><img alt="npm" src="https://img.shields.io/npm/v/duoduo-ai?style=flat-square" /></a>
  <a href="https://github.com/duduoduo521/duoduo-code/actions/workflows/build.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/duduoduo521/duoduo-code/build.yml?style=flat-square&branch=dev" /></a>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

## Why DuoDuo IDE?

- **Provider-agnostic** — Not coupled to any single LLM provider. Use OpenAI, Anthropic, Google, local models, or any of 20+ providers.
- **100% open source** — Full transparency, community-driven development.
- **Client/server architecture** — Run the server anywhere, drive it from TUI, web, desktop, or mobile.
- **Built-in LSP support** — Real diagnostics, completions, and go-to-definition out of the box.
- **Terminal-first** — Built by neovim users; pushing the limits of what's possible in the terminal.

---

## Features

### Multi-Model Support

Connect to any LLM provider — switch freely without vendor lock-in.

| Provider | Provider | Provider |
|----------|----------|----------|
| OpenAI | Anthropic | Google |
| xAI | Groq | Mistral |
| Cohere | Amazon Bedrock | Azure |
| DeepInfra | Together | Perplexity |
| Vercel | Alibaba (Qwen) | OpenRouter |
| GitLab | Venice | Cloudflare AI Gateway |
| 讯飞星火 (iFlytek Spark) | GitHub Copilot | SAP AI Core |

### Agent System

| Agent | Mode | Description |
|-------|------|-------------|
| **build** | Primary | Default full-access agent for development work |
| **plan** | Primary | Read-only agent for analysis and code exploration |
| **general** | Sub-agent | Complex search and multi-step tasks (`@general`) |
| **explore** | Sub-agent | Fast codebase exploration and search (`@explore`) |
| **review** | Sub-agent | Code review with inline comments and suggestions |
| **compaction** | Internal | Session compression to manage context window |
| **title** | Internal | Auto-generate session titles |
| **summary** | Internal | Progress summary generation |
| Custom | User-defined | Create agents with custom prompts, tools, and permissions |

Switch between primary agents with `Tab`. Define custom agents in configuration.

### Tool System

| Tool | Description |
|------|-------------|
| `read` | Read file contents |
| `write` | Create or overwrite files |
| `edit` | Make targeted edits to existing files |
| `bash` | Execute shell commands |
| `grep` | Search file contents with regex |
| `glob` | Find files by pattern matching |
| `webfetch` | Fetch and extract web page content |
| `task` | Delegate work to sub-agents |
| `apply_patch` | Apply batch patches via unified diff |
| `code_comment` | Insert inline code review comments |
| `lsp` | LSP-powered diagnostics and operations |
| `question` | Ask the user for clarification |
| `skill` | Invoke agent skills |
| MCP tools | Any tool exposed by connected MCP servers |

### Code Editing

- **Smart completion** — Context-aware code suggestions
- **Inline editing** — Make precise edits without leaving the conversation
- **Multi-file editing** — Coordinate changes across multiple files
- **apply_patch** — Batch-apply unified diff patches for large changesets
- **Cascade QA** — Multi-stage quality assurance pipeline that validates edits against LSP diagnostics

### Session Management

- **Multiple parallel sessions** — Work on several tasks simultaneously
- **Session forking** — Branch a conversation to explore alternatives
- **Compaction** — Automatic context compression when approaching token limits
- **Overflow handling** — Graceful management of context window overflow with auto-discovered limits
- **Progress summary** — Auto-generated summaries of session progress

### Knowledge System

Powered by Rust crates for performance:

| Component | Description |
|-----------|-------------|
| Knowledge Graph | Structured relationship storage for codebase understanding |
| Vector Store | Embedding-based semantic search |
| Smart Layer | Intent detection, quality assessment, and pipeline orchestration |
| Memory System | Persistent memory across sessions |

### File Tree

- Browse project files and directories
- Create, delete, and rename files/folders
- Multi-select operations
- Search and filter
- Drag-and-drop reordering

### Integrated Terminal

- Built on **ghostty-web** for a full-featured terminal experience
- Bash tool integration for command execution
- PTY support (Bun and Node.js runtimes)

### MCP (Model Context Protocol)

- Full MCP client implementation for connecting external tool servers
- Agent Client Protocol (ACP) support for inter-agent communication
- OAuth authentication flow for remote MCP servers
- Configurable timeout and environment variables

### Plugin System

Extend DuoDuo IDE with custom functionality:

- **Custom tools** — Register new tools via the `@duoduo-ai/plugin` SDK
- **Custom agents** — Define agents with custom prompts and permissions
- **Lifecycle hooks** — Transform system prompts, intercept events, and more

```typescript
import { tool } from "@duoduo-ai/plugin"

export default tool({
  name: "my-tool",
  description: "A custom tool",
  // ... implementation
})
```

### Code Quality

- **LSP integration** — Real-time diagnostics, hover info, go-to-definition
- **Cascade QA** — Multi-stage verification pipeline
- **Super-RAG** — Structured context retrieval for accurate code generation
- **Blueprint budget** — Token budget management for complex tasks

### Notifications

Desktop notifications for task events, configurable by category:

- Task completion
- Task failure
- Permission requests

### Settings

Comprehensive configuration via `duoduo.jsonc`:

- **Model configuration** — Default model, small model, per-agent model overrides
- **Agent configuration** — Custom agents, prompts, permissions, tool access
- **MCP servers** — Local (stdio) and remote (SSE) MCP server connections
- **Permission management** — Fine-grained allow/deny/ask rules per tool
- **Notification toggles** — Enable/disable notifications by category
- **UI language** — English and Chinese interfaces

### Interface

- 🌐 **Bilingual** — English and Chinese UI
- 🌙 **Theming** — Dark and light themes
- 📑 **Tabs** — Multi-tab session management
- 🔀 **Draggable panels** — Flexible layout with resizable panels

### Security

DuoDuo IDE runs with the privileges of the account that launches it and is **not**
wrapped in an OS-level sandbox. The agent can read files, run shell commands,
install extensions, and call external services. Review the full model and known
limitations in [SECURITY.md](./SECURITY.md) before running it against untrusted
code.

Enforced protections:

| Feature | Implementation |
|---------|---------------|
| Permission approval system | Fine-grained `allow` / `deny` / `ask` per tool and path (`gate_permission`) |
| Dangerous command detection | Rust static classifier (`bash_safety`): regex blocklist + semantic coverage + fail-closed on dynamic command names |
| Prompt-injection fencing | Gear/skill instructions, tool results, and strategy additions wrapped in XML fences and metacharacter-escaped; `<structural_contract>` declared in system prompt |
| Secret masking | Secrets in tool output masked before reaching the model (`sanitize_tool_output`) |
| SSRF protection | Private/loopback host rejection and redirect checks on `webfetch` / `clone_repo` |
| Path traversal prevention | Directory-boundary enforcement; sensitive-file blocklist (`is_sensitive_path`) |
| CORS/CSRF protection | Server-side CORS configuration and CSRF tokens |

**Not guaranteed:** OS sandboxing of command execution, and absolute resistance to
prompt injection (LLM compliance with the contract is probabilistic — the real
backstop is the permission gate plus OS isolation). See [SECURITY.md](./SECURITY.md).

---

## Installation

### CLI

```bash
# Quick install (macOS / Linux)
curl -fsSL https://www.dd322.cn/update/code/cli/cli | bash

# Quick install (Windows, PowerShell)
irm https://www.dd322.cn/update/code/cli/cli.ps1 | iex

# Homebrew Tap (macOS / Linux, recommended)
brew install duoduo-ai/tap/duoduocode
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Desktop App

Download from the [releases page](https://github.com/duduoduo521/duoduo-code/releases) or [www.dd322.cn/code/download](https://www.dd322.cn/code/download).

| Platform              | Download                                |
| --------------------- | --------------------------------------- |
| macOS (Apple Silicon) | `DuoDuoCode-<version>-aarch64.dmg` |
| macOS (Intel)         | `DuoDuoCode-<version>-x64.dmg`     |
| Windows               | `DuoDuoCode-<version>-x64-setup.exe`    |
| Linux                 | `.deb`, `.rpm`, or AppImage             |

安装包见上表，安装后内置自动更新；也可从[发布页](https://github.com/duduoduo521/duoduo-code/releases)或下载页获取。

### Install Directory

The install script installs to `$HOME/.duoduo/bin` by default. Set `$DUODUO_BIN_DIR` to override the installation directory.

```bash
DUODUO_BIN_DIR=/usr/local/bin curl -fsSL https://www.dd322.cn/update/code/cli/cli | bash
DUODUO_BIN_DIR=$HOME/.local/bin curl -fsSL https://www.dd322.cn/update/code/cli/cli | bash
```

---

## Configuration

DuoDuo IDE uses a `duoduo.jsonc` configuration file. Create it in your project root or global config directory.

### Model Configuration

```jsonc
{
  // Default model for all agents
  "model": "anthropic/claude-sonnet-4-20250514",

  // Smaller model for sub-agents and compaction
  "small_model": "anthropic/claude-haiku-4-20250506",

  // Default agent
  "default_agent": "build",

  // Enable/disable specific providers
  "enabled_providers": ["anthropic", "openai"],
  "disabled_providers": ["venice"]
}
```

### Provider Configuration

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

### Agent Configuration

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
      "description": "A custom agent for specific tasks",
      "prompt": "You are a specialized agent...",
      "mode": "primary",
      "permission": {
        "edit": { "*": "allow" },
        "bash": "ask"
      }
    }
  }
}
```

### MCP Servers

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

### Permissions

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

### Compaction

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

For full configuration reference, see [schema/config.json](schema/config.json).

---

## Supported Models

DuoDuo IDE supports models from all connected providers. Models are auto-discovered from each provider's model catalog and can be filtered per provider:

| Provider | Example Models |
|----------|---------------|
| OpenAI | GPT-4o, o3, o4-mini |
| Anthropic | Claude Sonnet 4, Claude Haiku 4 |
| Google | Gemini 2.5 Pro, Gemini 2.5 Flash |
| xAI | Grok 3, Grok 3 Mini |
| Alibaba (Qwen) | Qwen3-235B, Qwen3-Coder |
| Mistral | Mistral Large, Codestral |
| Cohere | Command R+ |
| Amazon Bedrock | Claude, Llama via Bedrock |
| Azure | GPT-4o via Azure OpenAI |
| 讯飞星火 | Spark 4.0 Ultra |
| GitHub Copilot | GPT-4o via Copilot |
| Local models | Any OpenAI-compatible endpoint |

Each model can be configured with cost tracking, context limits, modalities, and provider-specific options.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Clients                        │
│  ┌─────────┐  ┌─────────┐  ┌─────────────────┐ │
│  │   TUI   │  │ Web App │  │ Desktop (Tauri) │ │
│  └────┬────┘  └────┬────┘  └────────┬────────┘ │
└───────┼─────────────┼────────────────┼──────────┘
        │             │                │
        └─────────────┼────────────────┘
                      │ HTTP / WebSocket
┌─────────────────────┼───────────────────────────┐
│              Server (packages/duoduo)            │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  Agent   │ │ Session  │ │   Smart Layer    │ │
│  │ System   │ │ Manager  │ │ (Intent/Quality) │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │ Provider │ │   MCP    │ │   Permission     │ │
│  │ Router   │ │  Client  │ │     System       │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  Tools   │ │   LSP    │ │    Quality /     │ │
│  │ Registry │ │  Client  │ │   Cascade QA     │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────┐ │
│  │  Plugin  │ │   ACP    │ │   Compaction     │ │
│  │   SDK    │ │  Server  │ │    Engine        │ │
│  └──────────┘ └──────────┘ └──────────────────┘ │
└─────────────────────────────────────────────────┘
                      │
┌─────────────────────┼───────────────────────────┐
│           Rust Crates (crates/)                  │
│  ┌───────────────┐ ┌────────────┐ ┌───────────┐ │
│  │ Knowledge     │ │   Vector   │ │  Memory   │ │
│  │ Graph Store   │ │   Store    │ │  System   │ │
│  └───────────────┘ └────────────┘ └───────────┘ │
│  ┌───────────────┐ ┌────────────┐ ┌───────────┐ │
│  │  Security     │ │   AST      │ │  Code     │ │
│  │  Design       │ │  Engine    │ │  Search   │ │
│  └───────────────┘ └────────────┘ └───────────┘ │
└─────────────────────────────────────────────────┘
```

### Key Packages

| Package | Description |
|---------|-------------|
| `packages/duoduo` | Core server — agent logic, session management, tool registry, provider routing |
| `packages/app` | Shared web UI components (SolidJS) |
| `packages/desktop` | Native desktop app (Tauri) |
| `packages/plugin` | Plugin SDK (`@duoduo-ai/plugin`) |
| `packages/sdk` | Generated API client SDK |
| `packages/shared` | Shared utilities and types |

---

## Contributing

We welcome contributions! Please read the [contributing guide](./CONTRIBUTING.md) before submitting a pull request.

### Development Setup

Requirements: [Bun](https://bun.sh/) 1.3+

```bash
# Install dependencies
bun install

# Start dev server
bun dev

# Start with a specific directory
bun dev /path/to/project

# Start API server
bun dev serve --port 4096

# Start web app (separate terminal)
bun run --cwd packages/app dev

# Start desktop app
bun run --cwd packages/desktop tauri dev
```

### Building

```bash
# Build standalone executable
./packages/duoduo/script/build.ts --single

# Build desktop app
bun run --cwd packages/desktop tauri build
```

### PR Guidelines

- All PRs must reference an existing issue
- Follow conventional commit format (`feat:`, `fix:`, `docs:`, etc.)
- Keep PRs small and focused
- UI changes require screenshots/videos
- No AI-generated PR descriptions

---

## License

This project is a fork of and based on [opencode](https://github.com/anomalyco/opencode).

- opencode — Copyright (c) 2025 opencode — MIT License
- DuoDuo AI IDE — Copyright (c) 2026 DuoDuo — [MIT](./LICENSE)

The full license notices for bundled third-party components are generated at build time by `scripts/generate-third-party-licenses.ts` and shipped inside each release package as `ThirdPartyLicenses.txt`; see also [NOTICE](./NOTICE).

## Disclaimer

DuoDuo IDE is an AI-assisted coding tool that can read, write, and execute code on your behalf. Output is generated by machine learning models and may be incorrect, incomplete, insecure, or non-compliant with your project's licenses. **Always review changes before applying them.** You are solely responsible for any commands run, files modified, costs incurred, and consequences resulting from use. This software is provided "as is" without warranty of any kind (see [LICENSE](./LICENSE) and [SECURITY.md](./SECURITY.md)).

## Logo Copyright

The cartoon chinchilla Logo of this project is an original AI-assisted creation. Its private Git prior-art deposit was completed on 2026-04-28, with no reuse of any commercial stock assets; the ownership copyright notice is stored in the `/logo/asset_copyright.md` file.

If any third party claims that this artwork resembles a prior work, please contact the author at **duoduo@dd322.cn**, and all creation evidence will be promptly provided for verification and resolution.

---

**Join our community** on [www.dd322.cn/code](https://www.dd322.cn/code) — for questions or feedback, email **duoduo@dd322.cn**
