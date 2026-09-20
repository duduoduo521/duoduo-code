import z from "zod"
import os from "os"
import { createWriteStream } from "node:fs"
import * as Tool from "./tool"
import path from "path"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { AppFileSystem } from "@duoduo-ai/shared/filesystem"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import * as Truncate from "./truncate"
import { Effect, Stream } from "effect"
import { Bus } from "../bus"
import { FileWatcher } from "../file/watcher"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Bom from "@/util/bom"
import { getPromptID } from "@/session/prompt-id-registry"
import { createSmartLayerClients } from "@/smart-layer"
import { fetchSkipSyntaxCheck } from "./blackboard"
import { makeSubmitStable } from "./cascade-flow"

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.DUODUO_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
const PS = new Set(["powershell", "pwsh"])
const CWD = new Set(["cd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "rmdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // 13-6: write-capable subset of the Rust FILES list
  // (bash_safety.rs:92-107). Read-only commands in the Rust list
  // (ls/grep/awk/head/… ) are deliberately NOT mirrored: after P0-1 the bash
  // main path is the Rust executor, which spatially scans all 100 entries —
  // this TS list only restores the boundary on the fallback path where it
  // matters (commands that can create/modify/delete files).
  "dd",
  "tee",
  "truncate",
  "ln",
  "install",
  "patch",
  "sed",
  "tar",
  "zip",
  "unzip",
  "gzip",
  "gunzip",
  "bzip2",
  "xz",
  // 13-6 audit follow-up: editors write files in place
  "vim",
  "nano",
  "emacs",
  "code",
  // `find` only reads, but `find <path> -delete` removes everything under
  // <path>. It is scanned so the spatial bound below sees its search root —
  // otherwise `find / -delete` would be an unguarded `rm -rf` equivalent.
  "find",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
  // 13-6: PowerShell write cmdlets / delete-and-rename aliases / cd aliases
  "set-item",
  "clear-content",
  "out-file",
  "tee-object",
  "compress-archive",
  "expand-archive",
  "export-csv",
  "del",
  "erase",
  "ri",
  "rd",
  "mi",
  "ren",
  "md",
  "chdir",
  "pushd",
  "popd",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

// Windows PowerShell 缺失的 Unix 工具；命令用到这些工具且首次执行失败时，
// 改用 Git Bash 重跑（Git Bash 自带这些工具）。
const MISSING_UNIX_TOOLS = ["head", "tail", "grep", "sed", "awk", "xargs", "wc", "uniq"]
function usesMissingUnixTool(command: string): boolean {
  return MISSING_UNIX_TOOLS.some((tool) => new RegExp(`(^|[^\\w-])${tool}([^\\w-]|$)`, "i").test(command))
}

const Parameters = z.object({
  command: z.string().describe("The command to execute"),
  timeout: z.number().describe("Optional timeout in milliseconds").optional(),
  workdir: z
    .string()
    .describe(
      `The working directory to run the command in. Defaults to the current directory. Use this instead of 'cd' commands.`,
    )
    .optional(),
  description: z
    .string()
    .describe(
      "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
    ),
})

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  /** Out-of-bounds targets of commands that destroy or overwrite files. */
  destructive: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type Chunk = {
  text: string
  size: number
}

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1]!.toLowerCase() !== "filesystem") return
    return match[2]!
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1]!.length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

function pathArgs(list: Part[], ps: boolean) {
  if (!ps) {
    return list
      .slice(1)
      .filter((item) => !item.text.startsWith("-") && !(list[0]?.text === "chmod" && item.text.startsWith("+")))
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return "...\n\n" + text.slice(-MAX_METADATA_LENGTH)
}

function tail(text: string, maxLines: number, maxBytes: number) {
  const lines = text.split("\n")
  if (lines.length <= maxLines && Buffer.byteLength(text, "utf-8") <= maxBytes) {
    return {
      text,
      cut: false,
    }
  }

  const out: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i]!, "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) {
      if (out.length === 0) {
        const buf = Buffer.from(lines[i]!, "utf-8")
        let start = buf.length - maxBytes
        if (start < 0) start = 0
        while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++
        out.unshift(buf.subarray(start).toString("utf-8"))
      }
      break
    }
    out.unshift(lines[i]!)
    bytes += size
  }
  return {
    text: out.join("\n"),
    cut: true,
  }
}

export const parse = Effect.fn("BashTool.parse")(function* (command: string, ps: boolean) {
  const tree = yield* Effect.promise(() => parser().then((p) => (ps ? p.ps : p.bash).parse(command)))
  if (!tree) throw new Error("Failed to parse command")
  return tree.rootNode
})

// ─── Hard-block command classification (AST-based) ──────────────────────────
// Replaces the former regex DANGEROUS_PATTERNS list. Design invariants:
//  - Hard blocks happen BEFORE ask() and never emit a permission.asked event,
//    so the "auto-accept permissions" switch (frontend shouldAutoRespond and
//    Rust gate_permission auto_accept) can never bypass them.
//  - Rules mirror crates/agent-executor/src/bash_safety.rs (Rust sub-agent
//    path). Both sides are pinned to the SAME shared test vectors:
//    test/fixture/bash-safety.vectors.json. Update vectors with any rule change.
//  - Everything NOT hard-blocked still flows through the existing ask()
//    permission gate (collect() adds every non-cd command) — "allow" here
//    means "not silently executed", not "unreviewed".

const DESTRUCTIVE = new Set(["rm", "chmod", "chown", "dd", "mkfs", "shutdown", "reboot", "halt", "poweroff", "sudo"])
const ALWAYS_BLOCK = new Set(["sudo", "shutdown", "reboot", "halt", "poweroff"])
const INTERPRETERS = new Set([
  "python", "python2", "python3", "perl", "ruby", "node", "bun", "deno", "php", "lua", "tclsh", "awk",
  "sh", "bash", "zsh", "dash", "ksh",
])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
const CODE_FLAGS = new Set(["-c", "-e", "-E", "--eval", "--expression"])
const WRAPPERS = new Set(["env", "nohup", "nice", "time", "timeout", "command", "builtin", "doas"])
const SAFE_DEV_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"])
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "aria2c", "httpie", "http"])
// Flags that make a downloader write to a file instead of stdout. Writing to a
// file is the first half of a "download then execute" chain; the second half is
// a separate command and therefore invisible to any single-command scan — so
// the first half is blocked instead.
const OUTPUT_FLAGS = new Set(["-o", "-O", "--output", "--output-document"])
// P0-3: heredoc bodies are invisible to the command scanner (see classifyCommand).
const HEREDOC_REASON =
  "heredoc body cannot be scanned — write the payload to a temp file (e.g. printf '%s\\n' line > /tmp/f) and run it instead"
// P0-4: depth cap for nested `-c` / `-exec` payload recursion.
const MAX_NESTED_DEPTH = 3
// Node types whose runtime value is invisible statically (expansion happens in
// the shell). raw_string (single quotes) is the opposite: NEVER expanded.
const DYNAMIC_NODE_TYPES = new Set(["expansion", "simple_expansion", "command_substitution", "arithmetic_expansion"])

export type BashVerdict = { blocked: false } | { blocked: true; reason: string }

function baseName(text: string) {
  const clean = unquote(text).replace(/\\/g, "")
  const name = clean.split("/").pop() ?? clean
  return name.toLowerCase()
}

function isDynamicToken(t: Part, ps: boolean) {
  if (t.type === "raw_string") return false
  if (DYNAMIC_NODE_TYPES.has(t.type)) return true
  return dynamic(t.text, ps)
}

// Token walk for classification. Unlike parts() (permission-pattern oriented,
// skips expansions and redirections), this keeps expansion nodes so hidden
// payloads (`bash -c $V`) stay visible to the classifier.
export function commandTokens(node: Node, ps: boolean): Part[] {
  if (ps) return parts(node)
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i)
    if (!c) continue
    if (c.type === "variable_assignment") continue
    if (c.type.includes("redirect")) continue
    out.push({ type: c.type, text: c.text })
  }
  return out
}

// A1: redirect WRITE targets are write paths — `echo x > /outside` must hit
// the spatial bound even though `echo` is not a FILES command. Only output
// redirects count (operator contains `>`); `< in` is a read. AST shapes
// verified against both grammars:
// - bash: `file_redirect` [file_descriptor?, operator, target(word|number|
//   concatenation)]; `2>&1` targets a `number` (fd dup, not a path).
// - powershell: `redirection` [file_redirection_operator, redirected_file_name
//   [generic_token]]; unspaced `2>$null` parses as a plain generic_token and
//   is dynamic-skipped downstream.
export function redirectWriteTargets(root: Node): string[] {
  const out: string[] = []
  const redirects: Node[] = []
  for (const r of root.descendantsOfType("file_redirect")) {
    if (r) redirects.push(r)
  }
  for (const r of redirects) {
    let write = false
    let target: string | undefined
    for (let i = 0; i < r.childCount; i++) {
      const c = r.child(i)
      if (!c) continue
      if (c.type === "file_descriptor") continue
      if (c.type === "number") continue
      if (c.type.includes(">")) {
        write = true
        continue
      }
      if (c.type === "word" || c.type === "string" || c.type === "raw_string" || c.type === "concatenation") {
        target = c.text
      }
    }
    if (write && target) out.push(target)
  }
  for (const r of root.descendantsOfType("redirection")) {
    if (!r) continue
    let write = false
    let target: string | undefined
    for (let i = 0; i < r.childCount; i++) {
      const c = r.child(i)
      if (!c) continue
      if (c.type === "file_redirection_operator") {
        if (c.text.includes(">")) write = true
        continue
      }
      if (c.type === "redirected_file_name") {
        for (let j = 0; j < c.childCount; j++) {
          const t = c.child(j)
          if (t && (t.type === "generic_token" || t.type === "string" || t.type === "raw_string")) target = t.text
        }
      }
    }
    if (write && target) out.push(target)
  }
  return out
}

// 批6 L2: TS mirror of Rust `bash_safety::write_form_reason` — the SAME
// write-form semantics must drive the Rust main-loop delegation decision and
// this TS edit-permission ask, so a delegated write-form bash call can never
// skip the ask. Keep both sides in lockstep (regex + fd-write scan, with the
// /dev/null, NUL and `2>&1` exemptions).
const WRITE_FORM_RE =
  /(?:(?:^|[^\d>])>{1,2}\s*[^\s&]|(?:^|\s)1>{1,2}\s*[^\s&]|(?:^|[^\w-])(?:sed[^\n]*\s(?:-i(?:\.\w+)?(?:\s|$)|--in-place)|tee\s|dd\s|truncate\s|shred\s|cp\s|mv\s|touch\s|mkdir\s|rmdir\s|install\s|patch\s|copy\s|move\s|del\s|erase\s|ri\s|rd\s|md\s|mi\s|ren\s))/
const FD_WRITE_RE = /(?:^|\s)\d>{1,2}\s*([^\s&]+)/g

export function bashWriteFormReason(command: string): string | undefined {
  if (WRITE_FORM_RE.test(command)) return "bash write form (redirection / in-place edit)"
  for (const m of command.matchAll(FD_WRITE_RE)) {
    const normalized = m[1]!.replaceAll("\\", "/").toLowerCase()
    if (normalized === "/dev/null" || normalized.endsWith("/dev/null") || normalized === "nul") continue
    return "bash write form (fd redirection)"
  }
  return undefined
}

/**
 * H1: the nested-payload spatial gate. Must enforce the FULL bound, matching
 * `bash_safety::nested_walk` (blocked + out_of_bounds doors) in
 * crates/agent-executor/src/bash_safety.rs. Previously only the destructive
 * door blocked, so a nested non-destructive out-of-bounds write
 * (`bash -c 'echo x > /tmp/leak'`) passed TS while Rust hard-blocked it and
 * delegated the command back for the ask flow — the write then executed for
 * real under auto-accept, turning the Rust hard block into a bypass.
 * `dirs` covers FILES-argument and redirect-write targets alike (collect
 * feeds both); `destructive` is the subset that must never reach ask.
 * Exported as a pure function so tests pin the gate without replicating the
 * walk (the walk itself is covered by the Rust nested_violation tests).
 */
export function nestedSpatialReason(scan: {
  destructive: ReadonlySet<string>
  dirs: ReadonlySet<string>
}): string | undefined {
  if (scan.destructive.size > 0)
    return `nested command writes outside the allowed directories: ${Array.from(scan.destructive).join(", ")}`
  if (scan.dirs.size > 0)
    return `nested command touches paths outside the allowed directories: ${Array.from(scan.dirs).join(", ")}`
  return undefined
}

// Resolve the effective command name: unwrap benign wrappers (env/nohup/…),
// strip path + backslashes, and re-join whitespace-split fragments so
// `r m -rf /` normalizes to `rm` (tree-sitter parses its name as just `r`).
function resolveName(tokens: Part[]): { name: string; args: Part[]; dynamicName: boolean } {
  let idx = 0
  let name = ""
  while (idx < tokens.length) {
    const tok = tokens[idx]!
    if (DYNAMIC_NODE_TYPES.has(tok.type) || dynamic(tok.text, false))
      return { name: "", args: tokens.slice(idx + 1), dynamicName: true }
    const n = baseName(tok.text)
    if (WRAPPERS.has(n)) {
      idx++
      while (
        idx < tokens.length &&
        (/^-/.test(tokens[idx]!.text) ||
          /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!.text) ||
          (n === "timeout" && /^\d/.test(tokens[idx]!.text)))
      )
        idx++
      continue
    }
    name = n
    idx++
    break
  }
  if (!name) return { name: "", args: [], dynamicName: false }
  let merged = name
  let j = idx
  while (j < tokens.length && merged.length < 10) {
    const frag = baseName(tokens[j]!.text)
    if (!/^[a-z]{1,3}$/.test(frag)) break
    merged += frag
    j++
    if (DESTRUCTIVE.has(merged) || merged.startsWith("mkfs")) {
      name = merged
      idx = j
      break
    }
  }
  return { name, args: tokens.slice(idx), dynamicName: false }
}

// Destructive primitives are hard-blocked only with a dangerous argument
// signature; bare usage (e.g. `rm file.txt`) still goes through ask().
//
// `rm` deliberately has NO rule here: whether deleting something is safe
// depends on *where* it is, not on the flags used. It is bounded by the
// spatial check in `collect()` instead, which also closes the `find X -delete`
// equivalent that a flag-based rule could never cover.
function dangerousArgs(name: string, args: Part[]): string | undefined {
  const texts = args.map((a) => unquote(a.text))
  if (name === "chmod") {
    if (texts.some((t) => t.includes("777") || t.includes("666"))) return "chmod with world-writable mode"
    return
  }
  if (name === "chown") {
    // 13-5: any chown is hard-blocked (Rust legacy pattern `chown\s` parity —
    // ownership changes are never part of an unattended edit loop).
    return "chown changes file ownership"
  }
  if (name === "dd") {
    if (texts.some((t) => t.startsWith("if=") || t.startsWith("of="))) return "dd with raw device/file target"
    return
  }
  return
}

function isDecoder(name: string, args: Part[]): boolean {
  const texts = args.map((a) => unquote(a.text))
  if (name === "base64") return texts.some((t) => t === "--decode" || /^-[a-z]*d[a-z]*$/i.test(t))
  if (name === "xxd") return texts.includes("-r")
  if (name === "openssl") return texts.includes("enc") && texts.includes("-d")
  return false
}

function pipelineOf(node: Node): Node | undefined {
  let p: Node | null = node.parent
  while (p) {
    if (p.type === "pipeline") return p
    p = p.parent
  }
  return undefined
}

function hasPipePredecessorIn(pipe: Node, cmd: Node): boolean {
  const first = pipe.descendantsOfType("command")[0]
  return !!first && first.id !== cmd.id
}

export function classifyCommand(root: Node, raw: string, ps: boolean): BashVerdict {
  // ── Raw-text rules (grammar-independent; run even on partially-parsed input) ──
  const squeezed = raw.replace(/\s+/g, "")
  if (squeezed.includes(":(){:|:&};:")) return { blocked: true, reason: "fork bomb" }
  // P0-3: a heredoc body is a text token, not a `command` node — the scanner
  // below is blind to its lines, and feeding it to a shell executes them
  // unreviewed. AST check first (authoritative), raw-text fallback for
  // partially-parsed input. The delimiter must end the line, so an arithmetic
  // left shift (`$((a << b))`) never matches.
  if (root.descendantsOfType("heredoc_redirect").length > 0)
    return { blocked: true, reason: HEREDOC_REASON }
  if (/(^|[^<])<<-?[ \t]*(?:[A-Za-z_][A-Za-z0-9_]*|'[^']*'|"[^"]*")[ \t]*(?:#.*)?\r?$/m.test(raw))
    return { blocked: true, reason: HEREDOC_REASON }
  // 13-5: process substitution runs the inner command unreviewed and feeds its
  // output as a file argument (Rust legacy pattern `<\(` parity).
  if (raw.includes("<("))
    return {
      blocked: true,
      reason: "process substitution cannot be scanned — run the inner command separately",
    }
  for (const m of raw.matchAll(/>{1,2}\s*([^\s;|&<>]+)/g)) {
    const target = unquote(m[1]!)
    if (target.startsWith("/dev/") && !SAFE_DEV_TARGETS.has(target))
      return { blocked: true, reason: `redirect to raw device ${target}` }
    if (target.startsWith("/etc/")) return { blocked: true, reason: `redirect into ${target}` }
  }

  // ── AST rules ──
  // pipeline node id → startIndex of the earliest decode stage seen in it
  const pipeDecoders = new Map<number, number>()
  // pipeline node id → startIndex of the earliest download stage seen in it
  const pipeDownloaders = new Map<number, number>()
  for (const node of commands(root)) {
    const tokens = commandTokens(node, ps)
    if (tokens.length === 0) continue
    const { name, args, dynamicName } = resolveName(tokens)
    // Fail-closed: a dynamic command name ($V …, a=rm; $a …) cannot be
    // statically verified — block it outright instead of leaving it to the
    // ask() gate, which auto-accept modes would silently bypass (mirrors
    // the Rust side, see bash_safety.rs).
    if (dynamicName) return { blocked: true, reason: "dynamic command name cannot be statically verified" }
    if (!name) continue

    if (ALWAYS_BLOCK.has(name) || name.startsWith("mkfs")) return { blocked: true, reason: `${name} is not allowed` }

    const sig = dangerousArgs(name, args)
    if (sig) return { blocked: true, reason: sig }

    // P0-5: a DESTRUCTIVE command with an expanded (hidden) argument bypasses
    // the spatial bound — the runtime path is invisible to the scan. Hard-block
    // (unattended hard-deny, no ask), with the fix in the message.
    if (DESTRUCTIVE.has(name) && args.some((a) => isDynamicToken(a, ps)))
      return {
        blocked: true,
        reason: `${name} with expanded (hidden) argument — expand the variable to a concrete path and re-run`,
      }

    // Downloading to a file: see OUTPUT_FLAGS.
    if (DOWNLOADERS.has(name) && args.some((a) => OUTPUT_FLAGS.has(unquote(a.text))))
      return { blocked: true, reason: `${name} writing to a file` }

    if (name === "find") {
      const i = args.findIndex((a) => a.text === "-exec" || a.text === "-execdir" || a.text === "-ok")
      const sub = i >= 0 ? args[i + 1] : undefined
      if (sub && DESTRUCTIVE.has(baseName(sub.text))) return { blocked: true, reason: `find -exec ${baseName(sub.text)}` }
    }
    if (name === "xargs") {
      const firstCmd = args.find((a) => !a.text.startsWith("-"))
      if (firstCmd && DESTRUCTIVE.has(baseName(firstCmd.text)))
        return { blocked: true, reason: `xargs ${baseName(firstCmd.text)}` }
    }

    // 13-5: exec replaces the shell process — hard-block unconditionally
    // (Rust legacy pattern `exec\s` parity). Dynamic eval stays the rule below.
    if (name === "exec") return { blocked: true, reason: "exec is not allowed" }

    // eval with expanded payload = statically invisible code.
    if (name === "eval" && args.some((a) => isDynamicToken(a, ps)))
      return { blocked: true, reason: `${name} with expanded (hidden) payload` }

    if (!ps) {
      const pipe = pipelineOf(node)
      if (pipe && isDecoder(name, args)) pipeDecoders.set(pipe.id, node.startIndex)
      if (pipe && DOWNLOADERS.has(name)) pipeDownloaders.set(pipe.id, node.startIndex)

      // decode stage → interpreter stage in the SAME pipeline = obfuscated
      // execution, regardless of the interpreter's (literal-looking) args.
      if (pipe && INTERPRETERS.has(name)) {
        const at = pipeDecoders.get(pipe.id)
        if (at !== undefined && at < node.startIndex)
          return { blocked: true, reason: "decoded payload piped into interpreter" }
        // download stage → interpreter stage = remote code execution.
        const dl = pipeDownloaders.get(pipe.id)
        if (dl !== undefined && dl < node.startIndex)
          return { blocked: true, reason: "downloaded payload piped into interpreter" }
      }

      // piping anything into a shell executes hidden input
      if (pipe && SHELLS.has(name) && hasPipePredecessorIn(pipe, node))
        return { blocked: true, reason: `piping into ${name}` }

      // interpreter code flag with expanded payload = hidden code. Literal
      // payloads stay reviewable via ask() and are allowed here.
      if (INTERPRETERS.has(name)) {
        const fi = args.findIndex((a) => CODE_FLAGS.has(a.text))
        if (fi >= 0) {
          const payload = args[fi + 1]
          if (!payload || isDynamicToken(payload, ps))
            return { blocked: true, reason: `${name} ${args[fi]!.text} with expanded (hidden) payload` }
        }
      }
    }
  }
  return { blocked: false }
}

// P0-4: a shell `-c` literal payload or a `find -exec` / `xargs` sub-command
// is a full command in its own right — the outer scan must also see it.
// Returns the inner command string (unquoted for `-c`), or undefined when the
// construct carries no statically visible payload (dynamic payloads are
// already hard-blocked by classifyCommand's expanded-payload rule).
export function innerPayloadOf(name: string, args: Part[]): string | undefined {
  if (SHELLS.has(name)) {
    const i = args.findIndex((a) => a.text === "-c")
    const payload = i >= 0 ? args[i + 1] : undefined
    if (!payload || isDynamicToken(payload, false)) return undefined
    return unquote(payload.text)
  }
  if (name === "find") {
    const i = args.findIndex((a) => a.text === "-exec" || a.text === "-execdir" || a.text === "-ok")
    if (i < 0) return undefined
    const rest = args.slice(i + 1).map((a) => a.text)
    const end = rest.findIndex((t) => t === ";" || t === "\\;")
    const sub = (end >= 0 ? rest.slice(0, end) : rest).join(" ").trim()
    return sub || undefined
  }
  if (name === "xargs") {
    const rest = args
      .filter((a) => !a.text.startsWith("-"))
      .map((a) => a.text)
    return rest.length ? rest.join(" ") : undefined
  }
  return undefined
}

const ask = Effect.fn("BashTool.ask")(function* (ctx: Tool.Context, scan: Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return AppFileSystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    yield* ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  yield* ctx.ask({
    permission: "bash",
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
})

function cmd(shell: string, name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && PS.has(name)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define(
  "bash",
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const fs = yield* AppFileSystem.Service
    const trunc = yield* Truncate.Service
    const bus = yield* Bus.Service

    const cygpath = Effect.fn("BashTool.cygpath")(function* (shell: string, text: string) {
      const lines = yield* spawner
        .lines(ChildProcess.make(shell, ["-lc", 'cygpath -w -- "$1"', "_", text]))
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      const file = lines[0]?.trim()
      if (!file) return
      return AppFileSystem.normalizePath(file)
    })

    const resolvePath = Effect.fn("BashTool.resolvePath")(function* (text: string, root: string, shell: string) {
      if (process.platform === "win32") {
        if (Shell.posix(shell) && text.startsWith("/") && AppFileSystem.windowsPath(text) === text) {
          const file = yield* cygpath(shell, text)
          if (file) return file
        }
        return AppFileSystem.normalizePath(path.resolve(root, AppFileSystem.windowsPath(text)))
      }
      return path.resolve(root, text)
    })

    const argPath = Effect.fn("BashTool.argPath")(function* (arg: string, cwd: string, ps: boolean, shell: string) {
      const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
      const file = text && prefix(text)
      if (!file || dynamic(file, ps)) return
      const next = ps ? provider(file) : file
      if (!next) return
      return yield* resolvePath(next, cwd, shell)
    })

    const collect = Effect.fn("BashTool.collect")(function* (root: Node, cwd: string, ps: boolean, shell: string) {
      const scan: Scan = {
        dirs: new Set<string>(),
        destructive: new Set<string>(),
        patterns: new Set<string>(),
        always: new Set<string>(),
      }

      for (const node of commands(root)) {
        const command = parts(node)
        const tokens = command.map((item) => item.text)
        // Resolve through `env`/`nohup`/`timeout`/… the same way the classifier
        // does, so `env rm -rf /` is scanned as `rm` and not dismissed as an
        // unknown command name.
        const cmd = resolveName(commandTokens(node, ps)).name

        if (cmd && FILES.has(cmd)) {
          // `find` only reads on its own; `-delete` is what makes it the
          // equivalent of a recursive remove.
          const destructive =
            DESTRUCTIVE.has(cmd) || (cmd === "find" && tokens.some((t) => t === "-delete"))
          for (const arg of pathArgs(command, ps)) {
            const resolved = yield* argPath(arg, cwd, ps, shell)
            log.info("resolved path", { arg, resolved })
            if (!resolved || Instance.containsPath(resolved)) continue
            const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
            scan.dirs.add(dir)
            if (destructive) scan.destructive.add(dir)
          }
        }

        if (tokens.length && (!cmd || !CWD.has(cmd))) {
          scan.patterns.add(source(node))
          scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
        }
      }

      // A1: redirect write targets hit the same spatial bound as FILES
      // command arguments. Plain writes keep the approval flow (scan.dirs →
      // ask), matching the design for non-destructive FILES writes. Dynamic
      // targets are skipped by argPath (same policy as FILES args — they
      // stay reviewable via the ask patterns). /dev/null and NUL are
      // universal bit buckets, not project escapes.
      for (const target of redirectWriteTargets(root)) {
        const resolved = yield* argPath(target, cwd, ps, shell)
        if (!resolved || Instance.containsPath(resolved)) continue
        const normalized = resolved.replaceAll("\\", "/").toLowerCase()
        if (normalized === "/dev/null" || normalized.endsWith("/dev/null") || normalized === "nul") continue
        const dir = (yield* fs.isDir(resolved)) ? resolved : path.dirname(resolved)
        scan.dirs.add(dir)
      }

      return scan
    })

    // P0-4: recursively classify and spatially scan nested command payloads
    // (`bash -c '…'`, `find -exec …`, `xargs …`). Each level runs the SAME two
    // gates as the top level — classifyCommand (capability) and collect
    // (spatial bound) — so `find . -exec sh -c 'rm -rf /' \;` cannot hide the
    // destructive write from the spatial check. Depth-capped.
    const scanNestedCommands = Effect.fn("BashTool.scanNested")(function* (
      raw: string,
      ps: boolean,
      cwd: string,
      shell: string,
      depth: number,
    ): Generator<Effect.Effect<any, any, any>, string | undefined, any> {
      if (depth > MAX_NESTED_DEPTH) return "nested command payload beyond depth 3"
      let inner: Node
      try {
        inner = yield* parse(raw, ps)
      } catch {
        return undefined
      }
      const verdict = classifyCommand(inner, raw, ps)
      if (verdict.blocked) return verdict.reason
      const scan = yield* collect(inner, cwd, ps, shell)
      // H1: full spatial bound (destructive + plain out-of-bounds), see
      // nestedSpatialReason above — but ONLY for a real nested payload
      // (depth > 0). The depth-0 call re-parses the TOP-LEVEL command: its
      // out-of-bounds paths must keep the ask flow (reads outside the project
      // ask; they are not hard-blocked), matching Rust nested_walk which only
      // walks -c/-exec payloads. Inside a payload the ask flow cannot see the
      // paths, so there the bound is a hard block that auto-accept cannot
      // wave through.
      if (depth > 0 && (scan.destructive.size > 0 || scan.dirs.size > 0))
        return nestedSpatialReason(scan)
      for (const node of commands(inner)) {
        const tokens = commandTokens(node, ps)
        if (tokens.length === 0) continue
        const { name, args, dynamicName } = resolveName(tokens)
        if (dynamicName || !name) continue
        const payload = innerPayloadOf(name, args)
        if (payload === undefined) continue
        const found = yield* scanNestedCommands(payload, ps, cwd, shell, depth + 1)
        if (found) return found
      }
      return undefined
    })

    // Allow list: everything else is dropped, so host credentials never reach
    // the shell. Mirrors `duo_utils::env::SANITIZED_ENV_WHITELIST` (Rust side,
    // used by the sub-agent's `execute_bash`) — keep the two in sync.
    // `process.env` is case-insensitive on Windows, so the canonical upper-case
    // spelling also matches `Path`/`SystemRoot` etc.
    const ALLOWED_ENV = [
      // Binary / module resolution
      "PATH",
      "PATHEXT",
      "NODE_PATH",
      // Home + temp directories
      "HOME",
      "USERPROFILE",
      "TMP",
      "TEMP",
      "TMPDIR",
      // Windows essentials (without these `cmd` cannot start a child at all)
      "SYSTEMROOT",
      "SYSTEMDRIVE",
      "WINDIR",
      "COMSPEC",
      "APPDATA",
      "LOCALAPPDATA",
      "PROGRAMDATA",
      // Locale
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "LC_MESSAGES",
      // Terminal
      "TERM",
      "COLORTERM",
      "TERM_PROGRAM",
      "TERM_PROGRAM_VERSION",
      // User identity + editor/shell preferences
      "USER",
      "SHELL",
      "EDITOR",
      "PWD",
      "OLDPWD",
      "HOSTNAME",
      // XDG base directories
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
    ]
    const safeEnv: Record<string, string> = {}
    for (const key of ALLOWED_ENV) {
      if (process.env[key]) safeEnv[key] = process.env[key]!
    }

    const shellEnv = Effect.fn("BashTool.shellEnv")(function* (ctx: Tool.Context, cwd: string) {
      const extra = { env: {} }
      return {
        ...safeEnv,
        ...extra.env,
      }
    })

    const run = Effect.fn("BashTool.run")(function* (
      input: {
        shell: string
        name: string
        command: string
        cwd: string
        env: NodeJS.ProcessEnv
        timeout: number
        description: string
      },
      ctx: Tool.Context,
    ) {
      const bytes = Truncate.MAX_BYTES
      const lines = Truncate.MAX_LINES
      const keep = bytes * 2
      let full = ""
      let last = ""
      const list: Chunk[] = []
      let used = 0
      let file = ""
      let sink: ReturnType<typeof createWriteStream> | undefined
      let cut = false
      let expired = false
      let aborted = false

      yield* ctx.metadata({
        metadata: {
          output: "",
          description: input.description,
        },
      })

      const execStart = Date.now()
      log.info("bash command start", { command: input.command, cwd: input.cwd, timeout: input.timeout })

      const code: number | null = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(cmd(input.shell, input.name, input.command, input.cwd, input.env))

          yield* Effect.forkScoped(
            Stream.runForEach(Stream.decodeText(handle.all), (chunk) => {
              const size = Buffer.byteLength(chunk, "utf-8")
              list.push({ text: chunk, size })
              used += size
              while (used > keep && list.length > 1) {
                const item = list.shift()
                if (!item) break
                used -= item.size
                cut = true
              }

              last = preview(last + chunk)

              if (file) {
                sink?.write(chunk)
              } else {
                full += chunk
                if (Buffer.byteLength(full, "utf-8") > bytes) {
                  return trunc.write(full).pipe(
                    Effect.andThen((next) =>
                      Effect.sync(() => {
                        file = next
                        cut = true
                        sink = createWriteStream(next, { flags: "a" })
                        full = ""
                      }),
                    ),
                    Effect.andThen(
                      ctx.metadata({
                        metadata: {
                          output: last,
                          description: input.description,
                        },
                      }),
                    ),
                  )
                }
              }

              return ctx.metadata({
                metadata: {
                  output: last,
                  description: input.description,
                },
              })
            }),
          )

          const abort = Effect.callback<void>((resume) => {
            if (ctx.abort.aborted) return resume(Effect.void)
            const handler = () => resume(Effect.void)
            ctx.abort.addEventListener("abort", handler, { once: true })
            return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
          })

          const timeout = Effect.sleep(`${input.timeout + 100} millis`)

          const exit = yield* Effect.raceAll([
            handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
            abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
            timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
          ])

          if (exit.kind === "abort") {
            aborted = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }
          if (exit.kind === "timeout") {
            expired = true
            yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
          }

          return exit.kind === "exit" ? exit.code : null
        }),
      ).pipe(Effect.orDie)

      log.info("bash command done", {
        command: input.command,
        cwd: input.cwd,
        exit: code,
        ms: Date.now() - execStart,
        expired,
        aborted,
      })

      const meta: string[] = []
      if (expired) {
        meta.push(
          `bash tool terminated command after exceeding timeout ${input.timeout} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`,
        )
      }
      if (aborted) meta.push("User aborted the command")
      const raw = list.map((item) => item.text).join("")
      const end = tail(raw, lines, bytes)
      if (end.cut) cut = true
      if (!file && end.cut) {
        file = yield* trunc.write(raw)
      }

      let output = end.text
      if (!output) output = "(no output)"

      if (cut && file) {
        output = `...output truncated...\n\nFull output saved to: ${file}\n\n` + output
      }

      if (meta.length > 0) {
        output += "\n\n<bash_metadata>\n" + meta.join("\n") + "\n</bash_metadata>"
      }
      if (sink) {
        const stream = sink
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              stream.end(() => resolve())
              stream.on("error", () => resolve())
            }),
        )
      }

      return {
        title: input.description,
        metadata: {
          output: last || preview(output),
          exit: code,
          description: input.description,
          truncated: cut,
          ...(cut && file ? { outputPath: file } : {}),
        },
        output,
      }
    })

    return () =>
      Effect.sync(() => {
        const shell = Shell.acceptable()
        const name = Shell.name(shell)
        const chain =
          name === "powershell"
            ? "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
            : "If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead."
        log.info("bash tool using shell", { shell })

        return {
          description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
            .replaceAll("${os}", process.platform)
            .replaceAll("${shell}", name)
            .replaceAll("${chaining}", chain)
            .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
            .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES)),
          parameters: Parameters,
          execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const cwd = params.workdir
                ? yield* resolvePath(params.workdir, Instance.directory, shell)
                : Instance.directory
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = params.timeout ?? DEFAULT_TIMEOUT

              const ps = PS.has(name)
              const root = yield* parse(params.command, ps)

              // AST-based hard block (mirrors Rust agentic_loop.rs execute_bash
              // overlay; pinned by test/fixture/bash-safety.vectors.json).
              // Runs BEFORE ask() so auto-accept can never bypass it.
              const verdict = classifyCommand(root, params.command, ps)
              if (verdict.blocked) {
                return {
                  title: params.description,
                  metadata: {
                    output: `Blocked: ${verdict.reason}`,
                    exit: 1,
                    description: params.description,
                    truncated: false,
                  },
                  output: `Blocked: command was classified as dangerous (${verdict.reason}) and was not executed. If you believe this is a false positive, please use a different approach.`,
                }
              }

              // P0-4: nested payloads (shell -c / find -exec / xargs) go
              // through the same capability + spatial gates as the top level.
              const nestedReason = yield* scanNestedCommands(params.command, ps, cwd, shell, 0)
              if (nestedReason) {
                return {
                  title: params.description,
                  metadata: {
                    output: `Blocked: ${nestedReason}`,
                    exit: 1,
                    description: params.description,
                    truncated: false,
                  },
                  output: `Blocked: ${nestedReason}. If you believe this is a false positive, please use a different approach.`,
                }
              }

              const scan = yield* collect(root, cwd, ps, shell)
              if (!Instance.containsPath(cwd)) scan.dirs.add(cwd)

              // Spatial bound. `ask()` below is a permission gate, and the
              // auto-accept switch turns every ask into an allow — so a delete
              // that reaches outside the project must not travel through it.
              // Reads and plain writes keep the approval flow: the user can
              // still grant access to another directory.
              if (scan.destructive.size > 0) {
                const escapes = Array.from(scan.destructive).join(", ")
                return {
                  title: params.description,
                  metadata: {
                    output: `Blocked: command writes outside the allowed directories: ${escapes}`,
                    exit: 1,
                    description: params.description,
                    truncated: false,
                  },
                  output: `Blocked: command writes outside the allowed directories: ${escapes}. Ask the user to grant access to that directory first.`,
                }
              }

              // 批6 L2: explicit file-writing bash forms go through the SAME
              // permission system as the write tools (permission "edit") —
              // same ask flow, rules and auto-accept behavior as edit/write.
              // Patterns are the redirect targets when statically visible,
              // otherwise the working directory. The generic bash ask is
              // skipped for write forms so the command prompts exactly once.
              const writeFormReason = bashWriteFormReason(params.command)
              const redirectTargets = redirectWriteTargets(root)
              const isWriteForm = Boolean(writeFormReason) || redirectTargets.length > 0
              if (isWriteForm) {
                const patterns =
                  redirectTargets.length > 0
                    ? Array.from(
                        new Set(
                          redirectTargets.map((t) => path.relative(Instance.worktree, path.resolve(cwd, t))),
                        ),
                      )
                    : [path.relative(Instance.worktree, cwd)]
                yield* ctx.ask({
                  permission: "edit",
                  patterns,
                  always: [],
                  metadata: {},
                })
              } else {
                yield* ask(ctx, scan)
              }

              // 批6 L4: explicit redirect targets enter the blackboard ledger
              // via the same makeSubmitStable primitive the write tools use —
              // bash writes then share the write tools' concurrency safety
              // (FileLockManager + optimistic version check). Best-effort:
              // unchanged/binary/unreadable targets are skipped and failures
              // never roll the executed command back (the per-round snapshot
              // cascade covers every file on disk regardless).
              const promptID = getPromptID(ctx.sessionID)
              const smartClients = promptID ? createSmartLayerClients() : null
              const skipSyntaxCheck = yield* fetchSkipSyntaxCheck(smartClients)
              const submitStable = makeSubmitStable({
                blackboard: smartClients?.blackboard,
                promptID,
                agentId: ctx.agent,
                skipSyntaxCheck,
              })
              const ledgerTargets = Array.from(new Set(redirectTargets.map((t) => path.resolve(cwd, t))))
              const preRead = new Map<string, string>()
              for (const t of ledgerTargets) {
                const pre = yield* Bom.readFile(fs, t).pipe(Effect.catch(() => Effect.succeed(null)))
                if (pre) preRead.set(t, pre.text)
              }

              let result = yield* run(
                {
                  shell,
                  name,
                  command: params.command,
                  cwd,
                  env: yield* shellEnv(ctx, cwd),
                  timeout,
                  description: params.description,
                },
                ctx,
              )

              // X2：命令因缺失 Unix 工具（head/tail/grep/sed/awk 等）在 Windows
              // PowerShell 上失败时（典型 exit 255），改用 Git Bash 重跑。
              // 仅在首次失败且 gitbash 可用时触发一次，成功路径不受影响。
              if ((result.metadata.exit ?? 0) !== 0 && usesMissingUnixTool(params.command)) {
                const gb = Shell.gitbash()
                if (gb) {
                  result = yield* run(
                    {
                      shell: gb,
                      name: Shell.name(gb),
                      command: params.command,
                      cwd,
                      env: yield* shellEnv(ctx, cwd),
                      timeout,
                      description: params.description,
                    },
                    ctx,
                  )
                }
              }

              // 批6 L4: post-run ledger reconciliation — only targets whose
              // text actually changed are submitted (sources of cp/mv, bit
              // buckets and deletions fall out naturally).
              for (const t of ledgerTargets) {
                const pre = preRead.get(t)
                if (pre === undefined) continue
                const post = yield* Bom.readFile(fs, t).pipe(Effect.catch(() => Effect.succeed(null)))
                if (!post || post.text === pre || post.text.includes("\u0000") || post.text.includes("\uFFFD")) continue
                yield* submitStable(t, post.text)
              }

              yield* bus.publish(FileWatcher.Event.Updated, {
                file: cwd,
                event: "change",
              })

              return result
            }),
        }
      })
  }),
)
