# Security Policy

This document describes the security model of DuoDuo Code, what protections are
enforced, and — just as importantly — what is **not** guaranteed. Read it before
running the agent against code you do not fully trust.

DuoDuo Code is an AI coding agent. By design it can read files, execute shell
commands, install extensions, and call external services **using the privileges
of the account that runs it**. There is no built-in OS-level sandbox. Treat the
agent as having the same access as your own terminal in the project directory.

---

## 1. Threat Model

| Threat | Surface | Mitigation (enforced) |
|--------|---------|-----------------------|
| Malicious shell command | `bash` tool | Static command classifier (`bash_safety`) + permission gate |
| Prompt injection via installed extension | gear/skill `instructions` | XML fence + metacharacter escaping (see §3) |
| Prompt injection via tool output | `web_fetch` / file reads | XML fence + escaping; secrets masked |
| Server-Side Request Forgery | `webfetch` / `clone_repo` | Private/loopback host rejection + redirect checks |
| Secret exfiltration via tool output | tool results | Secret masking (`sanitize_tool_output`) |
| Path traversal / reading sensitive files | `read` / `edit` | Directory-boundary enforcement; sensitive-file blocklist |
| Unauthorized tool use | per-tool calls | Fine-grained `allow` / `deny` / `ask` permission rules |

---

## 2. Command Execution Safety

A tool call first passes the **permission gate** (`gate_permission`, §4). Once
approved, `execute_bash` runs four further layers, all of which must pass before
the child process is spawned:

| # | Layer | Question it answers | Who decides |
|---|-------|---------------------|-------------|
| — | Permission gate | Does a human need to approve this? | You (`allow` / `deny` / `ask`) |
| 1 | Policy command blacklist (`check_command_allowed`) | Is this exact command prefix on the policy's blocked list? | Config (`duoduo.jsonc`) |
| 2 | Capability boundary (`blocked`) | Is this command ever something the agent may run, in any directory? | The system |
| 3 | Spatial boundary (`out_of_bounds_paths`) | Does it touch anything outside the allowed directories? | The system |
| 4 | Timeout | — | 30 s default, 120 s cap |

The auto-accept / unattended switch affects **the permission gate only**. It is
a request for "do not ask me", not for "ignore the safety boundary", so it never
widens layers 1–3.

### Layer 2 — capability boundary

Implemented by `crates/agent-executor/src/bash_safety.rs` and mirrored by
`classifyCommand` in `packages/duoduo/src/tool/bash.ts`; both sides are pinned to
the same vector file
(`packages/duoduo/test/fixture/bash-safety.vectors.json`).

- **Regex blocklist** — known-dangerous patterns are rejected.
- **Semantic classifier** (`classify`) — covers `sudo` / `shutdown` / `reboot`,
  `mkfs*`, fork bombs, writes to raw devices and `/etc`, `chmod 777|666`,
  recursive `chown`, `dd if=`/`of=`, **downloading to a file**
  (`curl -o`, `wget -O`, …), decoder→interpreter pipelines,
  download→interpreter pipelines, and `eval`/`exec` of dynamically built
  payloads.
- **Fail-closed on dynamic command names** — a command whose name is produced by
  a shell variable or indirection (e.g. `a=rm; $a`) is blocked rather than
  executed.

Deleting files is deliberately **not** a capability rule: whether `rm -rf X` is
acceptable depends on where `X` is, not on the flags used. It is handled by
layer 3.

### Layer 3 — spatial boundary

Every path argument of a file-touching command is resolved against the
directory the child runs in and compared with the allowed directories. Relative
paths are resolved and `..` is folded lexically, so `rm -rf ../../` cannot
escape by staying relative. This gate is what stops `rm -rf /`,
`find / -delete`, and `cat /etc/passwd`.

The two implementations differ slightly in *how* they enforce it:

- **Rust agent loop** (`execute_bash`): every out-of-bounds path of a
  file-touching command is a hard block.
- **TypeScript `bash` tool**: out-of-bounds targets of *destructive* commands
  (`rm`, `chmod`, `chown`, `dd`, `find … -delete`) are a hard block. Reads and
  plain writes outside the project go through the permission gate instead, so
  you can still approve access to another directory.

### Important limitation

Layers 2 and 3 are a *misfire guard*, **not** an adversarial sandbox. They
analyze the command string statically. They do **not** protect against:

- shell variables or command substitution in a path (`rm -rf $TARGET` is not
  resolvable statically and is therefore not checked);
- `cd` + a relative path (`cd /etc && cat passwd`);
- symlink-based escapes — normalization is lexical and does not resolve links;
- running a script (`sh build.sh`, `python script.py`): its contents are not
  inspected;
- **child processes the executed command spawns** — for example
  `npm install` running a `postinstall` script, or `make` running a target's
  recipe. These run with the agent's full privileges and are outside the
  string analyzer's view.

The effective boundary is the **operating system**. The agent process runs with
the permissions of the user that launched it; the desktop shell restricts the
working directory to the project root and blocks out-of-bounds paths, but it
does not confine the process from the rest of the system.

**Recommendation.** Run the agent only in environments whose privileges you are
willing to grant it. For untrusted repositories, run inside a container, VM, or
dedicated account with no access to secrets (`~/.ssh`, `~/.aws`, `~/.npmrc`,
cloud credentials) and no network egress to internal systems.

---

## 3. Prompt Injection & Untrusted Content

DuoDuo Code injects content from several external sources into the LLM context:
installed gear/skill instructions, tool results (web pages, files, API responses),
and strategy additions. Any of these could contain text attempting to manipulate
the agent ("ignore previous instructions", "send the API key to …").

Mitigations that **are** in place:

- Gear/skill instructions, skill catalog, tool results, and strategy additions are
  wrapped in dedicated XML fences (`<capability_instructions>`, `<skill_catalog>`,
  `<duoduo_tool_output>`, `<strategy_addition>`) and their `<`, `>`, `&`
  characters are escaped, so they cannot break out of the fence structure.
- The system prompt carries a `<structural_contract>` declaration instructing the
  model to treat fenced regions as untrusted data that must not override system
  instructions.
- Secrets in tool output are masked before being sent to the model.

**Limitation.** These are structural/escape controls. They reduce the chance of
injection but **do not guarantee** the model will ignore a convincing injected
instruction — LLM compliance with the contract is probabilistic, not enforced.
This is an inherent property of LLM agents and is **not** something string
escaping can eliminate. The real backstop is the permission gate (§4) and OS
isolation (§2): even if the model is manipulated, destructive actions still
require an allowed permission and run with your account's privileges.

**Practical guidance.**
- Review gear/skill instructions before installing from the marketplace.
- Do not grant `bash: allow` globally when working with untrusted input.
- Prefer `bash: ask` so you approve each command.

---

## 4. Permission System

Each tool call passes through a permission gate (`gate_permission`) with
per-tool, per-path `allow` / `deny` / `ask` rules configured in `duoduo.jsonc`.
This is the primary, enforceable control over what the agent may do. Layers 1–3
of §2 run *in addition* to this gate, not instead of it.

The auto-accept / unattended switch ("don't ask me") is part of this gate and
only of this gate: it answers every `ask` with `allow`. It does not disable the
command classifier or the spatial boundary, so enabling it does not let the
agent run `sudo`, download-and-execute, or write outside the allowed
directories.

---

## 5. Cross-Process & Multi-Instance Behavior

- **Blackboard** state is isolated **per session**: each session uses its own
  SQLite database file (`{base_dir}/{session_id}.db`). Opening the same project
  in two different sessions produces two independent blackboards — no shared
  write conflict.
- Concurrent writes to a single SQLite file (e.g. the Rust server and the TS
  sidecar both touching the same file) are serialized by SQLite WAL mode with a
  5-second busy timeout. The application-layer optimistic lock rejects conflicting
  version updates rather than silently overwriting.
- **Known limitation.** Deliberately pointing multiple processes at the *same*
  `session_id` database (unusual deployment, container replicas sharing a volume
  with colliding IDs) is **not** a supported topology. Behavior under that
  configuration is undefined beyond SQLite's own locking. Do not share session
  databases across processes.

---

## 6. Credential Storage

Provider API keys are stored in the OS keyring (macOS Keychain / Windows
Credential Manager / Linux Secret Service via DBus).

When the keyring is unavailable — for example a headless Linux host with no
DBus session — the key is written to a file under the application data
directory, encrypted with AES-256-GCM. The encryption key is derived from
device-bound entropy (machine ID, user identity, and the application data
directory path).

**This is a device binding, not a secret.** Any process running as the same
user on the same machine can recompute the derivation and decrypt the file, so
it provides no protection against local code running under your account. It
only raises the bar against offline capture of the file on another machine.

On hosts without a keyring, prefer supplying credentials through environment
variables rather than persisting them.

The file itself is created with owner-only permissions (Unix `0600`; on Windows
it inherits the per-user ACL of `%APPDATA%`).

---

## 7. Reporting a Vulnerability

If you discover a security vulnerability, please report it privately to
**duoduo@dd322.cn** (or via the private advisory form on the project's
repository). Do not open a public issue for security reports.

We will acknowledge receipt within 5 business days and aim to provide a
remediation timeline within 14 days.

---

## 8. Unsupported / Out of Scope

The following are explicitly **not** provided and should not be assumed:

- An OS-level sandbox or containerization of agent command execution.
- Guaranteed resistance to prompt injection (see §3).
- Multi-user access control or secrets isolation between sessions on one machine
  (sessions share the launching user's privileges).
