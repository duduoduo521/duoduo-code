import "@/index.css"
import { registerCommonLanguages } from "@duoduo-ai/ui/codemirror/languages-common"
import { I18nProvider } from "@duoduo-ai/ui/context"
import { DialogProvider } from "@duoduo-ai/ui/context/dialog"
import { FileComponentProvider } from "@duoduo-ai/ui/context/file"
import { MarkedProvider } from "@duoduo-ai/ui/context/marked"
import { File } from "@duoduo-ai/ui/file"
import { Font } from "@duoduo-ai/ui/font"
import { logFrontendError } from "@/utils/frontend-logger"
import { Splash } from "@duoduo-ai/ui/logo"
import { ThemeProvider } from "@duoduo-ai/ui/theme/context"
import { MetaProvider } from "@solidjs/meta"
import { type BaseRouterProps, Navigate, Route, Router, useNavigate, useParams } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Effect } from "effect"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  ErrorBoundary,
  For,
  type JSX,
  lazy,
  onCleanup,
  type ParentProps,
  Show,
  Suspense,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { CommandProvider } from "@/context/command"
import { CommentsProvider } from "@/context/comments"
import { FileProvider } from "@/context/file"
import { GlobalSDKProvider } from "@/context/global-sdk"
import { GlobalSyncProvider, useGlobalSync } from "@/context/global-sync"
import { base64Encode } from "@duoduo-ai/shared/util/encode"
import { LanguageProvider, type Locale, useLanguage } from "@/context/language"
import { LayoutProvider } from "@/context/layout"
import { ModelsProvider } from "@/context/models"
import { NotificationProvider } from "@/context/notification"
import { PermissionProvider } from "@/context/permission"
import { PromptProvider } from "@/context/prompt"
import { ServerConnection, ServerProvider, serverName, useServer } from "@/context/server"
import { SettingsProvider } from "@/context/settings"
import { TerminalProvider } from "@/context/terminal"
import { SmartLayerProvider } from "@/addons/smart-layer/context"
import { MemoryProvider } from "@/addons/memory/memory-context"

import DirectoryLayout from "@/pages/directory-layout"
import Layout from "@/pages/layout"
import { ErrorPage } from "./pages/error"
import { useCheckServerHealth } from "./utils/server-health"

const HomeRoute = lazy(() => import("@/pages/home"))

const loadSession = () => import("@/pages/session")
const Session = lazy(loadSession)
// Suspense fallback for route-level lazy chunks / resource loading (e.g. a
// large project being opened). Opaque background + centered splash logo so the
// app shows a proper loading screen instead of a blank white/black flash.
const Loading = () => {
  const language = useLanguage()
  return (
    <div class="size-full bg-background-base flex flex-col items-center justify-center overflow-hidden">
      <Splash />
      <div class="text-13-regular text-text-weakest mt-5">{language.t("ui.app.loading")}</div>
    </div>
  )
}

if (typeof location === "object" && /\/session(?:\/|$)/.test(location.pathname)) {
  void loadSession()
}

// Register CodeMirror language extensions for syntax highlighting
registerCommonLanguages()

const SessionRoute = () => (
  <SessionProviders>
    <Session />
  </SessionProviders>
)

const SessionIndexRoute = () => <Navigate href="session" />

function UiI18nBridge(props: ParentProps) {
  const language = useLanguage()
  return <I18nProvider value={{ locale: language.intl, t: language.t }}>{props.children}</I18nProvider>
}

declare global {
  interface Window {
    __DUODUO__?: {
      updaterEnabled?: boolean
      deepLinks?: string[]
      wsl?: boolean
    }
    api?: {
      setTitlebar?: (theme: { mode: "light" | "dark" }) => Promise<void>
    }
  }
}

function QueryProvider(props: ParentProps) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000, // 5分钟内数据不标记为stale，避免频繁重请求
        gcTime: 30 * 60 * 1000, // 30分钟后垃圾回收，给更多缓存时间
        refetchOnWindowFocus: false, // 切回窗口不自动重请求，由SSE事件驱动刷新
      },
    },
  })
  return <QueryClientProvider client={client}>{props.children}</QueryClientProvider>
}

function AppShellProviders(props: ParentProps) {
  return (
    <SettingsProvider>
      <PermissionProvider>
        <LayoutProvider>
          <NotificationProvider>
            <ModelsProvider>
              <CommandProvider>
                <SmartLayerProvider>
                  <MemoryProvider>
                    <Layout>{props.children}</Layout>
                  </MemoryProvider>
                </SmartLayerProvider>
              </CommandProvider>
            </ModelsProvider>
          </NotificationProvider>
        </LayoutProvider>
      </PermissionProvider>
    </SettingsProvider>
  )
}

function SessionProviders(props: ParentProps) {
  return (
    <TerminalProvider>
      <FileProvider>
        <PromptProvider>
          <CommentsProvider>{props.children}</CommentsProvider>
        </PromptProvider>
      </FileProvider>
    </TerminalProvider>
  )
}

/**
 * Consumes Feishu-driven session focus requests published by GlobalSync.
 *
 * GlobalSyncProvider sits OUTSIDE the Router (it hosts the Router as a child),
 * so it cannot call `useNavigate` itself — that throws "'use' router
 * primitives can be only used inside a Route". This component lives in the
 * Router root, where router primitives are legal, and performs the actual
 * navigation.
 */
function SessionFocusNavigator() {
  const sync = useGlobalSync()
  const navigate = useNavigate()
  const params = useParams()
  createEffect(() => {
    const focus = sync.sessionFocus()
    if (!focus) return
    // The `:dir` route segment is the base64-encoded directory path. Re-encoding
    // `focus.directory` (the backend event scope) can yield a `:dir` that differs
    // from the active route (path normalization / scope mismatch), which
    // remounts DirectoryDataProvider under a different directory scope and fails
    // to load the target session — leaving the chat panel on the old session.
    // The Feishu session always belongs to the directory already open on the
    // desktop (the sidebar already shows it), so reuse the current `:dir` and
    // only switch `:id`. This guarantees the same DirectoryDataProvider instance
    // and lets the reactive `params.id` drive the chat update.
    const dir = params.dir ?? base64Encode(focus.directory)
    navigate(`/${dir}/session/${focus.sessionID}`)
    sync.clearSessionFocus()
  })
  return null
}

function RouterRoot(props: ParentProps<{ appChildren?: JSX.Element }>) {
  return (
    <AppShellProviders>
      <SessionFocusNavigator />
      <Suspense fallback={<Loading />}>
        {props.appChildren}
        {props.children}
      </Suspense>
    </AppShellProviders>
  )
}

export function AppBaseProviders(props: ParentProps<{ locale?: Locale }>) {
  return (
    <MetaProvider>
      <Font />
      <ThemeProvider
        onThemeApplied={(_, mode) => {
          void window.api?.setTitlebar?.({ mode })
        }}
      >
        <LanguageProvider locale={props.locale}>
          <UiI18nBridge>
            <ErrorBoundary
              fallback={(error) => {
                logFrontendError(
                  "error",
                  `Render error: ${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`,
                )
                return <ErrorPage error={error} />
              }}
            >
              <DialogProvider>
                <MarkedProvider>
                  <FileComponentProvider component={File}>{props.children}</FileComponentProvider>
                </MarkedProvider>
              </DialogProvider>
            </ErrorBoundary>
          </UiI18nBridge>
        </LanguageProvider>
      </ThemeProvider>
    </MetaProvider>
  )
}

function ConnectionGate(props: ParentProps<{ disableHealthCheck?: boolean }>) {
  const server = useServer()
  const checkServerHealth = useCheckServerHealth()

  const [checkMode, setCheckMode] = createSignal<"blocking" | "background">("blocking")
  const [initialCheckDone, setInitialCheckDone] = createSignal(false)
  const [showSplash, setShowSplash] = createSignal(true)

  // Only re-fetch when the server key actually changes, not on every object reference change.
  // server.current is a memo that creates new object refs on any store mutation (e.g. persisted
  // storage hydration), which would cause createResource to re-execute and Suspense to flash Splash.
  const serverKey = createMemo(() => (server.current ? ServerConnection.key(server.current) : undefined))

  // performs repeated health check with a grace period for
  // non-http connections, otherwise fails instantly
  const [startupHealthCheck, healthCheckActions] = createResource(serverKey, (key) =>
    props.disableHealthCheck || !key
      ? true
      : Effect.gen(function* () {
          const conn = server.current!
          const { http, type } = conn

          while (true) {
            const res = yield* Effect.promise(() => checkServerHealth(http))
            if (res.healthy) return true
            if (checkMode() === "background" || type === "http") return false
          }
        }).pipe(
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.ensuring(Effect.sync(() => setCheckMode("background"))),
          Effect.runPromise,
        ),
  )

  // Once health check passes, dismiss splash permanently and mark initial check done.
  createEffect(() => {
    if (startupHealthCheck.latest === true) {
      setInitialCheckDone(true)
      setShowSplash(false)
    }
  })

  return (
    <Show when={!showSplash()} fallback={null}>
      <Show
        when={initialCheckDone() || startupHealthCheck()}
        fallback={
          <ConnectionError
            onRetry={() => {
              if (checkMode() === "background") void healthCheckActions.refetch()
            }}
            onServerSelected={(key) => {
              setCheckMode("blocking")
              server.setActive(key)
              void healthCheckActions.refetch()
            }}
          />
        }
      >
        {props.children}
      </Show>
    </Show>
  )
}

function ConnectionError(props: { onRetry?: () => void; onServerSelected?: (key: ServerConnection.Key) => void }) {
  const language = useLanguage()
  const server = useServer()
  const others = () => server.list.filter((s) => ServerConnection.key(s) !== server.key)
  const name = createMemo(() => server.name || server.key)
  const serverToken = "\u0000server\u0000"
  const unreachable = createMemo(() => language.t("app.server.unreachable", { server: serverToken }).split(serverToken))

  const timer = setInterval(() => props.onRetry?.(), 1000)
  onCleanup(() => clearInterval(timer))

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base gap-6 p-6">
      <div class="flex flex-col items-center max-w-md text-center">
        <Splash style={{ width: "12%", "max-width": "48px", height: "auto", "margin-bottom": "16px" }} />
        <p class="text-14-regular text-text-base">
          {unreachable()[0]}
          <span class="text-text-strong font-medium">{name()}</span>
          {unreachable()[1]}
        </p>
        <p class="mt-1 text-12-regular text-text-weak">{language.t("app.server.retrying")}</p>
      </div>
      <Show when={others().length > 0}>
        <div class="flex flex-col gap-2 w-full max-w-sm">
          <span class="text-12-regular text-text-base text-center">{language.t("app.server.otherServers")}</span>
          <div class="flex flex-col gap-1 bg-surface-base rounded-lg p-2">
            <For each={others()}>
              {(conn) => {
                const key = ServerConnection.key(conn)
                return (
                  <button
                    type="button"
                    class="flex items-center gap-3 w-full px-3 py-2 rounded-md hover:bg-surface-raised-base-hover transition-colors text-left"
                    onClick={() => props.onServerSelected?.(key)}
                  >
                    <span class="text-14-regular text-text-strong truncate">{serverName(conn)}</span>
                  </button>
                )
              }}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}

function ServerKey(props: ParentProps) {
  const server = useServer()
  return (
    <Show when={server.key} keyed>
      {props.children}
    </Show>
  )
}

export function AppInterface(props: {
  children?: JSX.Element
  defaultServer: ServerConnection.Key
  servers?: Array<ServerConnection.Any>
  router?: Component<BaseRouterProps>
  disableHealthCheck?: boolean
}) {
  return (
    <ServerProvider
      defaultServer={props.defaultServer}
      disableHealthCheck={props.disableHealthCheck}
      servers={props.servers}
    >
      <ConnectionGate disableHealthCheck={props.disableHealthCheck}>
        <ServerKey>
          <QueryProvider>
            <GlobalSDKProvider>
              <GlobalSyncProvider>
                <Dynamic
                  component={props.router ?? Router}
                  root={(routerProps) => <RouterRoot appChildren={props.children}>{routerProps.children}</RouterRoot>}
                >
                  <Route path="/" component={HomeRoute} />

                  <Route path="/:dir" component={DirectoryLayout}>
                    <Route path="/" component={SessionIndexRoute} />
                    <Route path="/session/:id?" component={SessionRoute} />
                  </Route>
                </Dynamic>
              </GlobalSyncProvider>
            </GlobalSDKProvider>
          </QueryProvider>
        </ServerKey>
      </ConnectionGate>
    </ServerProvider>
  )
}
