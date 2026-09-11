import { Layer, ManagedRuntime } from "effect"

import { LSP } from "@/lsp"
import { FileWatcher } from "@/file/watcher"
import { Format } from "@/format"
import { File } from "@/file"
import { Vcs } from "@/project"
import { Snapshot } from "@/snapshot"
import { Bus } from "@/bus"
import { Config } from "@/config"
import { Global } from "../global"
import * as Observability from "./observability"

export const BootstrapLayer = Layer.mergeAll(
  Config.defaultLayer,
  Format.defaultLayer,
  LSP.defaultLayer,
  File.defaultLayer,
  FileWatcher.defaultLayer,
  Vcs.defaultLayer,
  Snapshot.defaultLayer,
  Bus.defaultLayer,
).pipe(
  // BootstrapRuntime is used by worktree bootstrap to run InstanceBootstrap,
  // which (transitively via Config/LSP/File/Vcs/Snapshot) requires the
  // @duoduo/Global service. Without this the worktree path throws
  // "Service not found: @duoduo/Global".
  Layer.provideMerge(Global.layer),
  Layer.provide(Observability.layer),
)

export const BootstrapRuntime = ManagedRuntime.make(BootstrapLayer, {
  memoMap: Layer.makeMemoMapUnsafe(),
})
