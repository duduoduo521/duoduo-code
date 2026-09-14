import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@duoduo-ai/sdk/v2/client"
import { Button } from "@duoduo-ai/ui/button"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Icon } from "@duoduo-ai/ui/icon"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { List, type ListRef } from "@duoduo-ai/ui/list"
import { Spinner } from "@duoduo-ai/ui/spinner"
import { TextField } from "@duoduo-ai/ui/text-field"
import { showToast } from "@duoduo-ai/ui/toast"
import { createEffect, createMemo, createResource, Match, onCleanup, onMount, Switch } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Link } from "@/components/link"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { normalizeProviderList } from "@/context/global-sync/utils"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSmartLayer } from "@/addons/smart-layer/context"

export function DialogConnectProvider(props: { provider: string }) {
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const providers = useProviders()

  const alive = { value: true }
  const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }

  onCleanup(() => {
    alive.value = false
    if (timer.current === undefined) return
    clearTimeout(timer.current)
    timer.current = undefined
  })

  const provider = createMemo(
    () =>
      providers.all().find((x) => x.id === props.provider) ??
      globalSync.data.provider.all?.find((x) => x.id === props.provider),
  )
  const fallback = createMemo<ProviderAuthMethod[]>(() => [
    {
      type: "api" as const,
      label: language.t("provider.connect.method.apiKey"),
    },
  ])
  const [auth] = createResource(
    () => props.provider,
    async () => {
      const cached = globalSync.data.provider_auth[props.provider]
      if (cached) return cached
      const res = await globalSDK.client.provider.auth()
      if (!alive.value) return fallback()
      globalSync.set("provider_auth", res.data ?? {})
      return res.data?.[props.provider] ?? fallback()
    },
  )
  const loading = createMemo(() => auth.loading && !globalSync.data.provider_auth[props.provider])
  const methods = createMemo(() => auth.latest ?? globalSync.data.provider_auth[props.provider] ?? fallback())
  const [store, setStore] = createStore({
    methodIndex: undefined as undefined | number,
    authorization: undefined as undefined | ProviderAuthAuthorization,
    state: "pending" as undefined | "pending" | "complete" | "error" | "prompt",
    error: undefined as string | undefined,
  })

  type Action =
    | { type: "method.select"; index: number }
    | { type: "method.reset" }
    | { type: "auth.prompt" }
    | { type: "auth.pending" }
    | { type: "auth.complete"; authorization: ProviderAuthAuthorization }
    | { type: "auth.error"; error: string }

  function dispatch(action: Action) {
    setStore(
      produce((draft) => {
        if (action.type === "method.select") {
          draft.methodIndex = action.index
          draft.authorization = undefined
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "method.reset") {
          draft.methodIndex = undefined
          draft.authorization = undefined
          draft.state = undefined
          draft.error = undefined
          return
        }
        if (action.type === "auth.prompt") {
          draft.state = "prompt"
          draft.error = undefined
          return
        }
        if (action.type === "auth.pending") {
          draft.state = "pending"
          draft.error = undefined
          return
        }
        if (action.type === "auth.complete") {
          draft.state = "complete"
          draft.authorization = action.authorization
          draft.error = undefined
          return
        }
        draft.state = "error"
        draft.error = action.error
      }),
    )
  }

  const method = createMemo(() => (store.methodIndex !== undefined ? methods().at(store.methodIndex) : undefined))

  const methodLabel = (value?: { type?: string; label?: string }) => {
    if (!value) return ""
    if (value.type === "api") return language.t("provider.connect.method.apiKey")
    return value.label ?? ""
  }

  function formatError(value: unknown, fallback: string): string {
    if (value && typeof value === "object" && "data" in value) {
      const data = (value as { data?: { message?: unknown } }).data
      if (typeof data?.message === "string" && data.message) return data.message
    }
    if (value && typeof value === "object" && "error" in value) {
      const nested = formatError((value as { error?: unknown }).error, "")
      if (nested) return nested
    }
    if (value && typeof value === "object" && "message" in value) {
      const message = (value as { message?: unknown }).message
      if (typeof message === "string" && message) return message
    }
    if (value instanceof Error && value.message) return value.message
    if (typeof value === "string" && value) return value
    return fallback
  }

  async function selectMethod(index: number, inputs?: Record<string, string>) {
    if (timer.current !== undefined) {
      clearTimeout(timer.current)
      timer.current = undefined
    }

    const method = methods()[index]!
    dispatch({ type: "method.select", index })

    if (method.type === "oauth") {
      if (method.prompts?.length && !inputs) {
        dispatch({ type: "auth.prompt" })
        return
      }
      dispatch({ type: "auth.pending" })
      const start = Date.now()
      await globalSDK.client.provider.oauth
        .authorize(
          {
            providerID: props.provider,
            method: index,
            inputs,
          },
          { throwOnError: true },
        )
        .then((x) => {
          if (!alive.value) return
          const elapsed = Date.now() - start
          const delay = 1000 - elapsed

          if (delay > 0) {
            if (timer.current !== undefined) clearTimeout(timer.current)
            timer.current = setTimeout(() => {
              timer.current = undefined
              if (!alive.value) return
              dispatch({ type: "auth.complete", authorization: x.data })
            }, delay)
            return
          }
          dispatch({ type: "auth.complete", authorization: x.data })
        })
        .catch((e) => {
          if (!alive.value) return
          dispatch({ type: "auth.error", error: formatError(e, language.t("common.requestFailed")) })
        })
    }
  }

  function OAuthPromptsView() {
    const [formStore, setFormStore] = createStore({
      value: {} as Record<string, string>,
      index: 0,
    })

    const prompts = createMemo<NonNullable<ProviderAuthMethod["prompts"]>>(() => {
      const value = method()
      if (value?.type !== "oauth") return []
      return value.prompts ?? []
    })
    const matches = (prompt: NonNullable<ReturnType<typeof prompts>[number]>, value: Record<string, string>) => {
      if (!prompt.when) return true
      const actual = value[prompt.when.key]
      if (actual === undefined) return false
      return prompt.when.op === "eq" ? actual === prompt.when.value : actual !== prompt.when.value
    }
    const current = createMemo(() => {
      const all = prompts()
      const index = all.findIndex((prompt, index) => index >= formStore.index && matches(prompt, formStore.value))
      if (index === -1) return
      return {
        index,
        prompt: all[index],
      }
    })
    const valid = createMemo(() => {
      const item = current()
      if (!item?.prompt || item.prompt.type !== "text") return false
      const value = formStore.value[item.prompt.key] ?? ""
      return value.trim().length > 0
    })

    async function next(index: number, value: Record<string, string>) {
      if (store.methodIndex === undefined) return
      const next = prompts().findIndex((prompt, i) => i > index && matches(prompt, value))
      if (next !== -1) {
        setFormStore("index", next)
        return
      }
      await selectMethod(store.methodIndex, value)
    }

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()
      const item = current()
      if (!item?.prompt || item.prompt.type !== "text") return
      if (!valid()) return
      await next(item.index, formStore.value)
    }

    const item = () => current()
    const text = createMemo(() => {
      const prompt = item()?.prompt
      if (!prompt || prompt.type !== "text") return
      return prompt
    })
    const select = createMemo(() => {
      const prompt = item()?.prompt
      if (!prompt || prompt.type !== "select") return
      return prompt
    })

    return (
      <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
        <Switch>
          <Match when={item()?.prompt?.type === "text"}>
            <TextField
              type="text"
              label={text()?.message ?? ""}
              placeholder={text()?.placeholder}
              value={text() ? (formStore.value[text()!.key] ?? "") : ""}
              onChange={(value) => {
                const prompt = text()
                if (!prompt) return
                setFormStore("value", prompt.key, value)
              }}
            />
            <Button class="w-auto self-end" type="submit" size="large" variant="primary" disabled={!valid()}>
              {language.t("common.continue")}
            </Button>
          </Match>
          <Match when={item()?.prompt?.type === "select"}>
            <div class="w-full flex flex-col gap-1.5">
              <div class="text-14-regular text-text-base">{select()?.message}</div>
              <div>
                <List
                  items={select()?.options ?? []}
                  key={(x) => x.value}
                  current={select()?.options.find((x) => x.value === formStore.value[select()!.key])}
                  onSelect={(value) => {
                    if (!value) return
                    const prompt = select()
                    if (!prompt) return
                    const nextValue = {
                      ...formStore.value,
                      [prompt.key]: value.value,
                    }
                    setFormStore("value", prompt.key, value.value)
                    void next(item()!.index, nextValue)
                  }}
                >
                  {(option) => (
                    <div class="w-full flex items-center gap-x-2">
                      <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                        <div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                      </div>
                      <span>{option.label}</span>
                      <span class="text-14-regular text-text-weak">{option.hint}</span>
                    </div>
                  )}
                </List>
              </div>
            </div>
          </Match>
        </Switch>
      </form>
    )
  }

  let listRef: ListRef | undefined
  function handleKey(e: KeyboardEvent) {
    if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
      return
    }
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  // Auto-advance only when there is exactly ONE method AND it is API-key based.
  // For OAuth methods we must NOT auto-select(0): that would call
  // provider.oauth.authorize() on open and immediately bounce the user out to an
  // external browser window — reading as a 100%-opaque flash. OAuth stays on the
  // method-selection screen until the user explicitly clicks it.
  let auto = false
  createEffect(() => {
    if (auto) return
    if (loading()) return
    const ms = methods()
    if (ms.length === 1 && ms[0]?.type === "api") {
      auto = true
      void selectMethod(0)
    }
  })

  async function complete() {
    // A previous disconnect may have parked this provider in
    // config.disabled_providers (see settings-providers.tsx disableProvider).
    // If so, remove it now: the server filters disabled providers out of
    // provider.list(), which would otherwise hide the freshly connected
    // provider from both the "Connected" list and the model picker even
    // though auth.set() succeeded.
    //
    // Use the EXACT same flow as dialog-custom-provider.tsx's save: just call
    // updateConfig() with the cleared disabled_providers. updateConfig runs
    // bootstrap() internally, which re-populates the provider store (global +
    // child dirs) and sets `bootingRoot` so the server's async global.disposed
    // event (instance rebuild) is a no-op via the "recent" guard — i.e. no
    // white flash, exactly like the custom-provider dialog. No manual
    // dispose, no suppress flag, no surgical provider.list calls.
    const disabled = globalSync.data.config.disabled_providers ?? []
    const filtered = disabled.filter((id) => id !== props.provider)
    await globalSync.updateConfig({ disabled_providers: filtered })
    // updateConfig() runs bootstrap(true), but the provider list query can still
    // be served from a stale instance-state cache that was built before auth.set()
    // wrote the key. The model selector uses the same explicit refresh to work
    // around this, so mirror it here: force the server to rebuild the current
    // instance's provider state from the latest auth and mirror the result into
    // the global store immediately.
    try {
      const refreshed = await globalSDK.client.provider.list({ refresh: "true" })
      if (refreshed.data) {
        globalSync.set("provider", normalizeProviderList(refreshed.data))
      }
    } catch {
      // updateConfig already succeeded; a stale list is tolerable
    }
    // Return to the previous dialog (e.g. Settings) when opened as a
    // sub-dialog; with an empty history back() behaves like close().
    dialog.back()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.connect.toast.connected.title", { provider: provider()?.name ?? "" }),
      description: language.t("provider.connect.toast.connected.description", { provider: provider()?.name ?? "" }),
    })
  }

  function MethodSelection() {
    return (
      <>
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.selectMethod", { provider: provider()?.name ?? "" })}
        </div>
        <div>
          <List
            ref={(ref) => {
              listRef = ref
            }}
            items={methods}
            key={(m) => m?.label}
            onSelect={async (selected, index) => {
              if (!selected) return
              void selectMethod(index)
            }}
          >
            {(i) => (
              <div class="w-full flex items-center gap-x-2">
                <div class="w-4 h-2 rounded-[1px] bg-input-base shadow-xs-border-base flex items-center justify-center">
                  <div class="w-2.5 h-0.5 ml-0 bg-icon-strong-base hidden" data-slot="list-item-extra-icon" />
                </div>
                <span>{methodLabel(i)}</span>
              </div>
            )}
          </List>
        </div>
      </>
    )
  }

  function ApiAuthView() {
    const [formStore, setFormStore] = createStore({
      value: "",
      error: undefined as string | undefined,
      // Covers the WHOLE submit (verification + save + provider refresh), not
      // just verification — otherwise the button re-enables between verify
      // success and dialog close and can be double-clicked.
      busy: false,
    })
    // SmartLayer context may be unavailable when this dialog is mounted outside
    // the SmartLayerProvider tree (e.g. via a portal/owner-less dialog). The
    // keyring store is a non-critical optimization, so tolerate its absence
    // instead of crashing the whole view.
    let sl: ReturnType<typeof useSmartLayer> | undefined
    try {
      sl = useSmartLayer()
    } catch {
      sl = undefined
    }
    let inputRef: HTMLInputElement | undefined

    // The dialog's onOpenAutoFocus fires before this view exists (the
    // single-method auto-select mounts it one tick later), so focus the
    // API-key input explicitly once it is in the DOM.
    onMount(() => inputRef?.focus())

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()
      if (formStore.busy) return

      const form = e.currentTarget as HTMLFormElement
      const formData = new FormData(form)
      const apiKey = formData.get("apiKey") as string

      if (!apiKey?.trim()) {
        setFormStore("error", language.t("provider.connect.apiKey.required"))
        return
      }

      setFormStore("error", undefined)
      setFormStore("busy", true)

      try {
        // Order matters: verify via the official model list FIRST — one request
        // both validates the key (401 on a bad key) and returns the latest
        // model ids. Only after it succeeds do we save the key; the post-save
        // provider.list refresh then merges that list into the picker.
        if (props.provider === "deepseek") {
          try {
            const res = await globalSDK.client.provider.verify({
              providerID: "deepseek",
              apiKey,
            })
            const data = res.data
            if (!data?.ok) {
              setFormStore(
                "error",
                data?.error === "invalid_api_key"
                  ? language.t("provider.connect.apiKey.invalid")
                  : language.t("provider.connect.apiKey.verificationFailed"),
              )
              return
            }
          } catch {
            // Sidecar unreachable — don't block connecting on a failed check.
          }
        }

        await globalSDK.client.auth.set({
          providerID: props.provider,
          auth: {
            type: "api",
            key: apiKey,
          },
        })
        // Also persist to OS keyring for secure storage across restarts.
        // This is fire-and-forget — auth.set already succeeded so the credential is
        // usable. But a keyring failure is surfaced to the user instead of being
        // silently swallowed, so they know the key is only stored in plaintext config.
        if (sl?.status === "connected" && sl.api) {
          sl.api.keyringStore(props.provider, apiKey).catch((err) => {
            console.warn("Failed to store API key in OS keyring:", err)
            showToast({
              variant: "default",
              title: language.t("provider.connect.keyring.failedTitle"),
              description: language.t("provider.connect.keyring.failedHint"),
            })
          })
        }
        await complete()
      } finally {
        // Reset on every failure path so the button recovers; on the success
        // path the dialog is already closing (busy reset is harmless there).
        setFormStore("busy", false)
      }
    }

    return (
      <div class="flex flex-col gap-6">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.apiKey.description", { provider: provider()?.name ?? "" })}
        </div>
        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
          <TextField
            ref={inputRef}
            autofocus
            type="text"
            label={language.t("provider.connect.apiKey.label", { provider: provider()?.name ?? "" })}
            placeholder={language.t("provider.connect.apiKey.placeholder")}
            name="apiKey"
            value={formStore.value}
            onChange={(v) => setFormStore("value", v)}
            validationState={formStore.error ? "invalid" : undefined}
            error={formStore.error}
          />
          <Button class="w-auto self-end" type="submit" size="large" variant="primary" disabled={formStore.busy}>
            {formStore.busy
              ? language.t("provider.connect.apiKey.connecting")
              : language.t("common.continue")}
          </Button>
        </form>
      </div>
    )
  }

  function OAuthCodeView() {
    const [formStore, setFormStore] = createStore({
      value: "",
      error: undefined as string | undefined,
    })

    async function handleSubmit(e: SubmitEvent) {
      e.preventDefault()

      const form = e.currentTarget as HTMLFormElement
      const formData = new FormData(form)
      const code = formData.get("code") as string

      if (!code?.trim()) {
        setFormStore("error", language.t("provider.connect.oauth.code.required"))
        return
      }

      setFormStore("error", undefined)
      const result = await globalSDK.client.provider.oauth
        .callback({
          providerID: props.provider,
          method: store.methodIndex,
          code,
        })
        .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
        .catch((error) => ({ ok: false as const, error }))
      if (result.ok) {
        await complete()
        return
      }
      setFormStore("error", formatError(result.error, language.t("provider.connect.oauth.code.invalid")))
    }

    return (
      <div class="flex flex-col gap-6">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.oauth.code.visit.prefix")}
          <Link href={store.authorization!.url}>{language.t("provider.connect.oauth.code.visit.link")}</Link>
          {language.t("provider.connect.oauth.code.visit.suffix", { provider: provider()?.name ?? "" })}
        </div>
        <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4">
          <TextField
            autofocus
            type="text"
            label={language.t("provider.connect.oauth.code.label", { method: method()?.label ?? "" })}
            placeholder={language.t("provider.connect.oauth.code.placeholder")}
            name="code"
            value={formStore.value}
            onChange={(v) => setFormStore("value", v)}
            validationState={formStore.error ? "invalid" : undefined}
            error={formStore.error}
          />
          <Button class="w-auto self-end" type="submit" size="large" variant="primary">
            {language.t("common.continue")}
          </Button>
        </form>
      </div>
    )
  }

  function OAuthAutoView() {
    const code = createMemo(() => {
      const instructions = store.authorization?.instructions
      if (instructions?.includes(":")) {
        return instructions.split(":")[1]?.trim()
      }
      return instructions
    })

    onMount(() => {
      void (async () => {
        const result = await globalSDK.client.provider.oauth
          .callback({
            providerID: props.provider,
            method: store.methodIndex,
          })
          .then((value) => (value.error ? { ok: false as const, error: value.error } : { ok: true as const }))
          .catch((error) => ({ ok: false as const, error }))

        if (!alive.value) return

        if (!result.ok) {
          const message = formatError(result.error, language.t("common.requestFailed"))
          dispatch({ type: "auth.error", error: message })
          return
        }

        await complete()
      })()
    })

    return (
      <div class="flex flex-col gap-6">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.oauth.auto.visit.prefix")}
          <Link href={store.authorization!.url}>{language.t("provider.connect.oauth.auto.visit.link")}</Link>
          {language.t("provider.connect.oauth.auto.visit.suffix", { provider: provider()?.name ?? "" })}
        </div>
        <TextField
          label={language.t("provider.connect.oauth.auto.confirmationCode")}
          class="font-mono"
          value={code()}
          readOnly
          copyable
        />
        <div class="text-14-regular text-text-base flex items-center gap-4">
          <Spinner />
          <span>{language.t("provider.connect.status.waiting")}</span>
        </div>
      </div>
    )
  }

  return (
    <Dialog
      title={undefined}
    >
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        <div class="px-2.5 flex gap-4 items-center">
          <Icon name="providers" class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong">
            <Switch>
              <Match when={props.provider === "anthropic" && method()?.label?.toLowerCase().includes("max")}>
                {language.t("provider.connect.title.anthropicProMax")}
              </Match>
              <Match when={true}>{language.t("provider.connect.title", { provider: provider()?.name ?? "" })}</Match>
            </Switch>
          </div>
        </div>
        <div class="px-2.5 pb-10 flex flex-col gap-6">
          <div onKeyDown={handleKey} tabIndex={0} autofocus={store.methodIndex === undefined ? true : undefined}>
            <Switch>
              <Match when={loading()}>
                <div class="text-14-regular text-text-base">
                  <div class="flex items-center gap-x-2">
                    <Spinner />
                    <span>{language.t("provider.connect.status.inProgress")}</span>
                  </div>
                </div>
              </Match>
              <Match when={store.methodIndex === undefined}>
                <MethodSelection />
              </Match>
              <Match when={store.state === "pending"}>
                <div class="text-14-regular text-text-base">
                  <div class="flex items-center gap-x-2">
                    <Spinner />
                    <span>{language.t("provider.connect.status.inProgress")}</span>
                  </div>
                </div>
              </Match>
              <Match when={store.state === "prompt"}>
                <OAuthPromptsView />
              </Match>
              <Match when={store.state === "error"}>
                <div class="text-14-regular text-text-base">
                  <div class="flex items-center gap-x-2">
                    <Icon name="circle-ban-sign" class="text-icon-critical-base" />
                    <span>{language.t("provider.connect.status.failed", { error: store.error ?? "" })}</span>
                  </div>
                </div>
              </Match>
              <Match when={method()?.type === "api"}>
                <ApiAuthView />
              </Match>
              <Match when={method()?.type === "oauth"}>
                <Switch>
                  <Match when={store.authorization?.method === "code"}>
                    <OAuthCodeView />
                  </Match>
                  <Match when={store.authorization?.method === "auto"}>
                    <OAuthAutoView />
                  </Match>
                </Switch>
              </Match>
            </Switch>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
