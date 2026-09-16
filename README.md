<p align="center">
  <a href="https://www.dd322.cn/code">
    <img src="packages/app/public/logo-2000.png" alt="DuoDuo Code logo" width="200">
  </a>
</p>
<p align="center">The open-source AI coding agent that plans, acts, and verifies — desktop / TUI / web.</p>
<p align="center">
  <a href="https://www.npmjs.com/package/duoduo-ai"><img alt="npm" src="https://img.shields.io/npm/v/duoduo-ai?style=flat-square" /></a>
  <a href="https://github.com/duduoduo521/duoduo-code/actions/workflows/build.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/duduoduo521/duoduo-code/build.yml?style=flat-square&branch=main" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> |
  <a href="README.zh.md">简体中文</a>
</p>

---

DuoDuo Code is an agent-first coding tool: you describe the goal, and it breaks the task down, edits code, runs commands, verifies the outcome, and reports back. Behind that loop sits a set of in-house mechanisms — a Rust-powered intelligence layer, a codebase knowledge graph, persistent project memory, parallel multi-agent dispatch, and a built-in market for installing skills and MCP servers in one click.

## How It Works

### Four-Phase Task Pipeline

Every task flows through **investigate → plan → execute → verify**. The primary agent advances between phases explicitly via `proceed_to_*` tools, and each phase gets its own context-assembly strategy and deliverables — nothing is crammed into one endless conversation.

### Parallel Agents + Shared Blackboard

When a task can be split, the primary agent fans subtasks out to multiple sub-agents working in parallel (enable "parallel multi-agent dispatch" in Settings). Results converge by conflict grouping: independent work runs concurrently, conflicting work merges serially. Sub-agents exchange intermediate findings through a **shared blackboard** (`blackboard_*` tools: read / write / find / submit draft / submit stable / annotate) instead of guessing what the others did.

### Codebase Knowledge Graph

Projects are incrementally indexed into a **variable-level knowledge graph** (who defines what, who reads/writes, which function owns it). Changed files are re-indexed on demand — never a full rescan. Agents query the graph and symbols directly with `graph_query` and `symbol_search`, so locating code no longer relies on plain text search. The desktop app ships a **graph kanban** panel for visual browsing and one-click reindexing.

### Project Memory

Important conclusions are distilled into project memory that persists across sessions. In a new session the agent retrieves prior decisions via `recall_memory` — it never has to re-learn your project from scratch.

### Edit Quality

- **Cascade QA** — a multi-stage quality pipeline that validates every edit against real LSP diagnostics; failing changes get reworked
- **Super-RAG** — structured context retrieval that combines AST and graph signals to pinpoint relevant code
- **Blueprint budget** — token budget management for complex tasks, so large changes don't derail mid-flight

### Snapshots & Rollback

Snapshots are captured automatically before changes and can be rolled back as a whole; the `snapshot_query` tool searches snapshot history for past edits, so "who changed this line, and why" is always answerable.

### Gear Market

The built-in extension market aggregates two sources: the **ModelScope skill community** and the **MCP server registry**.

- Search, filter, and install skills (SKILL.md-driven) in one click; installed skills are invoked by the agent via the `skill` tool
- Install MCP servers in one click with config written automatically; connection configs can be re-verified
- Installed gears are managed centrally in Settings

### Models

- **Built-in DeepSeek** — works out of the box, dynamically discovers new models from DeepSeek's catalog, and validates your API key on connect
- **Custom models** — add any OpenAI-compatible custom provider or model in Settings or `duoduo.jsonc`

### Security

| Protection | How |
|------------|-----|
| Permission gates | Fine-grained allow / deny / ask approval per tool and path |
| Dangerous command detection | Rust static classifier: blocklist + semantic coverage + fail-closed on dynamic command names |
| Secret masking | Secrets in tool output are masked before reaching the model |
| SSRF protection | Web fetch / repo clone reject private and loopback hosts; redirects are checked |
| Path protection | Directory-boundary enforcement + sensitive-file blocklist |
| Prompt-injection fencing | External instructions and tool results wrapped in XML fences with metacharacter escaping |

Full security model in [SECURITY.md](./SECURITY.md).

### Desktop App

- Knowledge graph kanban: visual browsing + one-click reindex
- Multi-session tabs, draggable panels, dark/light themes, English/Chinese UI
- Integrated terminal, file tree, web preview panel
- SSH remote projects: bidirectional SFTP sync with live status
- Git worktree support, desktop notifications (configurable per category)

## Agents & Tools

Switch primary agents with `Tab`; custom agents are declared in configuration:

| Agent | Role |
|-------|------|
| `build` | Primary, full-access development |
| `plan` | Primary, read-only analysis |
| `general` / `explore` / `scout` | Sub-agents for search and exploration workloads |
| `title` / `summary` / `compaction` | Internal agents (titles, summaries, compression) |
| Custom | Define prompts, permissions, and tools in config |

Builtin tools (all real registrations):

| Category | Tools |
|----------|-------|
| Files | `read` / `glob` / `grep` / `edit` / `write` / `apply_patch` / `code_comment` |
| Execution | `bash` / `webfetch` / `task` (delegates to sub-agents) |
| Memory & graph | `graph_query` / `symbol_search` / `recall_memory` / `snapshot_query` |
| Pipeline | `proceed_to_investigate` / `proceed_to_plan` / `proceed_to_execute` / `proceed_to_verify` |
| Collaboration | `blackboard_read` / `blackboard_write` / `blackboard_find` / `blackboard_submit_draft` / `blackboard_submit_stable` / `blackboard_annotate` |
| Other | `skill` / `todo` / `question` / `lsp` (experimental) / `plan` (experimental) |
| Extensions | Tools exposed by connected MCP servers; custom `.ts` tools under your project's `.duoduo/tool/` |

## Installation

### CLI

```bash
# macOS / Linux
curl -fsSL https://www.dd322.cn/update/code/cli/cli | bash

# Windows (PowerShell)
irm https://www.dd322.cn/update/code/cli/cli.ps1 | iex

# Homebrew (macOS / Linux)
brew install duoduo-ai/tap/duoduocode
```

Installs to `$HOME/.duoduo/bin` by default; set `$DUODUO_BIN_DIR` to override.

### Desktop App

Download from [www.dd322.cn/code/download](https://www.dd322.cn/code/download). Auto-update is built in.

| Platform | Package |
|----------|---------|
| macOS (Apple Silicon / Intel) | `.dmg` |
| Windows | `.exe` installer |
| Linux | `.deb` / `.rpm` / AppImage |

## Configuration

Create a `duoduo.jsonc` in your project root or global config directory. Full reference: [schema/config.json](schema/config.json).

```jsonc
{
  // Default model and small model (sub-agents, titles, compaction)
  "model": "deepseek/deepseek-chat",
  "small_model": "deepseek/deepseek-chat",

  // Default primary agent
  "default_agent": "build",

  // Custom agents: prompt, permissions, tools
  "agent": {
    "my-agent": {
      "description": "Handles migration scripts",
      "prompt": "You focus on database migrations...",
      "mode": "primary",
      "permission": {
        "edit": { "*": "allow" },
        "bash": "ask"
      }
    }
  },

  // Providers: built-in DeepSeek takes a key; others use OpenAI-compatible endpoints
  "provider": {
    "deepseek": { "apiKey": "sk-..." },
    "my-provider": {
      "apiKey": "sk-...",
      "baseURL": "https://api.example.com/v1"
    }
  },

  // MCP servers: local process or remote SSE
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

  // Permissions: per tool and path
  "permission": {
    "read": { "*": "allow", "*.env": "ask" },
    "edit": { "*": "allow" },
    "bash": "ask"
  },

  // Context compaction
  "compaction": {
    "auto": true,
    "tail_turns": 4,
    "preserve_recent_tokens": 8000,
    "reserved": 40000
  }
}
```

## Architecture

```
Desktop (Tauri) / Web / TUI           packages/desktop · packages/app
        │
Server layer (TypeScript)             packages/duoduo — sessions · agents · tools · permissions · MCP · LSP
        │
Rust intelligence layer               crates/*
```

Main components:

| Part | Description |
|------|-------------|
| `packages/duoduo` | Core server: session management, agent loop, tool registry, provider routing, MCP / LSP clients |
| `packages/app` / `packages/ui` | Web UI and component library (SolidJS) |
| `packages/desktop` | Tauri desktop shell |
| `packages/sdk` | OpenAPI-generated client SDK |
| `crates/duo-smart-layer` | Intelligence layer: intent detection, pipeline orchestration, agent-loop scheduling |
| `crates/agent-executor` | Executor: parallel dispatch, snapshots, tool execution |
| `crates/knowledge-graph-store` | Codebase knowledge graph and incremental indexing |
| `crates/context-builder` | Context assembly (Super-RAG, blueprint budget) |
| `crates/ast-engine` | tree-sitter AST parsing |
| `crates/code-search` | Semantic code retrieval |
| `crates/blackboard-*` | Multi-agent shared blackboard |
| `crates/permission-eval` | Permission evaluation |
| `packages/plugin` | Custom tool SDK (`@duoduo-ai/plugin`) |

## Development

Requires [Bun](https://bun.sh/) 1.3+ (desktop builds also need the Rust toolchain).

```bash
bun install

# Start server + TUI
bun dev

# Start the API server only
bun dev serve --port 4096

# Web UI (separate terminal)
bun run --cwd packages/app dev

# Desktop development
bun run dev:desktop

# Typecheck
bun run typecheck
```

Building:

```bash
# Standalone executable for the current platform
./packages/duoduo/script/build.ts --single

# Desktop installers
bun run --cwd packages/desktop tauri build
```

## License

This project is a fork of and based on [opencode](https://github.com/anomalyco/opencode).

- opencode — Copyright (c) 2025 opencode — MIT License
- DuoDuo Code — Copyright (c) 2026 DuoDuo — [MIT](./LICENSE)

The full license notices for bundled third-party components are generated at build time by `scripts/generate-third-party-licenses.ts` and shipped inside each release package as `ThirdPartyLicenses.txt`; see also [NOTICE](./NOTICE).

## Disclaimer

DuoDuo Code is an AI-assisted coding tool that can read, write, and execute code on your behalf. Output is generated by machine learning models and may be incorrect, incomplete, insecure, or non-compliant with your project's licenses. **Always review changes before applying them.** You are solely responsible for any commands run, files modified, costs incurred, and consequences resulting from use. This software is provided "as is" without warranty of any kind (see [LICENSE](./LICENSE) and [SECURITY.md](./SECURITY.md)).

## Logo Copyright

The cartoon chinchilla Logo of this project is an original AI-assisted creation. Its private Git prior-art deposit was completed on 2026-04-28, with no reuse of any commercial stock assets; the ownership copyright notice is stored in the `/logo/asset_copyright.md` file.

If any third party claims that this artwork resembles a prior work, please contact the author at **duoduo@dd322.cn**, and all creation evidence will be promptly provided for verification and resolution.

---

**Join our community** on [www.dd322.cn/code](https://www.dd322.cn/code) — for questions or feedback, email **duoduo@dd322.cn**
