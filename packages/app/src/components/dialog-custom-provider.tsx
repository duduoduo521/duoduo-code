import { Button } from "@duoduo-ai/ui/button"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Icon } from "@duoduo-ai/ui/icon"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { useMutation } from "@tanstack/solid-query"
import { TextField } from "@duoduo-ai/ui/text-field"
import { showToast } from "@duoduo-ai/ui/toast"
import { batch, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"

import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useSmartLayer } from "@/addons/smart-layer/context"
import {
  type FormState,
  headerRow,
  modelRow,
  validateCustomProvider,
} from "./dialog-custom-provider-form"

type Preset = string

type Props = {
  back?: "providers" | "close"
  preset?: Preset
  /** When set, the dialog opens in edit mode for the given provider (baseURL / apiKey can be changed). */
  editProviderID?: string
}

export function DialogCustomProvider(props: Props) {
  const dialog = useDialog()
  const globalSync = useGlobalSync()
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const sl = useSmartLayer()

  // Local framework preset templates
  const LOCAL_PRESETS: Record<string, Partial<FormState>> = {
    ollama: {
      providerID: "ollama",
      name: "Ollama",
      baseURL: "http://localhost:11434/v1",
      apiKey: "",
    },
    "lm-studio": {
      providerID: "lm-studio",
      name: "LM Studio",
      baseURL: "http://localhost:1234/v1",
      apiKey: "",
    },
    "llama-cpp": {
      providerID: "llama-cpp",
      name: "llama.cpp",
      baseURL: "http://localhost:8080/v1",
      apiKey: "",
    },
    vllm: {
      providerID: "vllm",
      name: "vLLM",
      baseURL: "http://localhost:8000/v1",
      apiKey: "",
    },
    tgi: {
      providerID: "tgi",
      name: "TGI",
      baseURL: "http://localhost:8080/v1",
      apiKey: "",
    },
    lmdeploy: {
      providerID: "lmdeploy",
      name: "LMDeploy",
      baseURL: "http://localhost:23333/v1",
      apiKey: "",
    },
    sglang: {
      providerID: "sglang",
      name: "SGLang",
      baseURL: "http://localhost:30000/v1",
      apiKey: "",
    },
    mlx: {
      providerID: "mlx",
      name: "MLX",
      baseURL: "http://localhost:8080/v1",
      apiKey: "",
    },
  }

  const baseForm: FormState = {
    providerID: "",
    name: "",
    baseURL: "",
    apiKey: "",
    models: [modelRow()],
    headers: [headerRow()],
    err: {},
  }

  const presetData = props.preset && props.preset !== "custom" ? (LOCAL_PRESETS[props.preset] ?? null) : null

  // In edit mode, pre-fill the form from the existing provider config so the
  // user can change baseURL / apiKey / models / headers without re-adding.
  const editData = (() => {
    if (!props.editProviderID) return null
    const existing = globalSync.data.config.provider?.[props.editProviderID]
    if (!existing) return null
    // Built-in/connected providers (e.g. deepseek) store only the API key in
    // config — their model list lives in the live provider data. Load models
    // from there so the user can actually see and edit each model's
    // context/output limit. Prefer config.models only when it already holds
    // entries (user-added custom models), otherwise fall back to the live
    // models which carry the real ids and current limits.
    const live = globalSync.data.provider.all?.find((p) => p.id === props.editProviderID)
    const liveModels = live?.models ?? {}
    const configModels = existing.models ?? {}
    const source = Object.keys(configModels).length > 0 ? configModels : liveModels
    const models = Object.entries(source).map(([id, m]) => ({
      ...modelRow(),
      id,
      name: m.name ?? "",
      contextLimit: m.limit?.context != null ? String(m.limit.context) : "128000",
      outputLimit: m.limit?.output != null ? String(m.limit.output) : "32000",
      temperature: m.temperature != null ? String(m.temperature) : "0.2",
      // Config stores snake_case `top_p`; runtime model uses camelCase `topP`.
      topP: (m.topP ?? (m as any).top_p) != null ? String(m.topP ?? (m as any).top_p) : "0.25",
      reasoning: m.reasoning === true,
    }))
    const headerEntries = Object.entries(existing.options?.headers ?? {})
    const headers =
      headerEntries.length > 0
        ? headerEntries.map(([key, value]) => ({ ...headerRow(), key, value: String(value) }))
        : [headerRow()]
    return {
      providerID: props.editProviderID,
      name: existing.name ?? props.editProviderID,
      baseURL: existing.options?.baseURL ?? "",
      apiKey: "",
      models: models.length > 0 ? models : [modelRow()],
      headers,
      err: {},
    }
  })()

  const initialForm: FormState = editData
    ? editData
    : presetData
      ? { ...baseForm, ...presetData, models: [modelRow()], headers: [headerRow()] }
      : baseForm

  const [form, setForm] = createStore<FormState>(initialForm)

  const addModel = () => {
    setForm(
      "models",
      produce((rows) => {
        rows.push(modelRow())
      }),
    )
  }

  const removeModel = (index: number) => {
    if (form.models.length <= 1) return
    setForm(
      "models",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const addHeader = () => {
    setForm(
      "headers",
      produce((rows) => {
        rows.push(headerRow())
      }),
    )
  }

  const removeHeader = (index: number) => {
    if (form.headers.length <= 1) return
    setForm(
      "headers",
      produce((rows) => {
        rows.splice(index, 1)
      }),
    )
  }

  const setField = (key: "providerID" | "name" | "baseURL" | "apiKey", value: string) => {
    setForm(key, value)
    if (key === "apiKey") return
    setForm("err", key, undefined)
  }

  const setModel = (index: number, key: "id" | "name", value: string) => {
    batch(() => {
      setForm("models", index, key, value)
      setForm("models", index, "err", key, undefined)
    })
  }

  const setModelParam = (
    index: number,
    key: "contextLimit" | "outputLimit" | "temperature" | "topP",
    value: string,
  ) => {
    if (key === "temperature" || key === "topP") {
      // Allow digits and a single decimal point (e.g. 0.7).
      const cleaned = value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1")
      setForm("models", index, key, cleaned)
      return
    }
    // context / max output are always integers
    const digits = value.replace(/\D/g, "")
    setForm("models", index, key, digits)
  }

  const setHeader = (index: number, key: "key" | "value", value: string) => {
    batch(() => {
      setForm("headers", index, key, value)
      setForm("headers", index, "err", key, undefined)
    })
  }

  const validate = () => {
    const output = validateCustomProvider({
      form,
      t: language.t,
      disabledProviders: globalSync.data.config.disabled_providers ?? [],
      existingProviderIDs: new Set(globalSync.data.provider.all.map((p) => p.id)),
      editProviderID: props.editProviderID,
    })
    batch(() => {
      setForm("err", output.err)
      output.models.forEach((err, index) => setForm("models", index, "err", err))
      output.headers.forEach((err, index) => setForm("headers", index, "err", err))
    })
    return output.result
  }

  const saveMutation = useMutation(() => ({
    mutationFn: async (result: NonNullable<ReturnType<typeof validate>>) => {
      const disabledProviders = globalSync.data.config.disabled_providers ?? []
      const nextDisabled = disabledProviders.filter((id) => id !== result.providerID)

      // Only touch stored credentials when the user actually entered a key.
      // In edit mode a blank key means "keep the existing key".
      if (result.key) {
        await globalSDK.client.auth.set({
          providerID: result.providerID,
          auth: {
            type: "api",
            key: result.key,
          },
        })
        // Also persist to OS keyring for secure storage across restarts.
        // Fire-and-forget — failure is non-critical (auth.set already succeeded).
        if (sl.status === "connected" && sl.api) {
          sl.api.keyringStore(result.providerID, result.key).catch((err) => {
            console.warn("Failed to store API key in OS keyring:", err)
          })
        }
      }

      // Build the config payload. In edit mode, merge over the existing
      // config so unrelated fields (e.g. env, extra options) are preserved.
      const headerConfig = Object.fromEntries(
        form.headers
          .map((h) => [h.key.trim(), h.value.trim()])
          .filter(([k, v]) => !!k && !!v),
      )
      const configToSave = props.editProviderID
        ? (() => {
            const existing = globalSync.data.config.provider?.[props.editProviderID]
            return {
              ...existing,
              npm: result.config.npm,
              name: result.config.name,
              models: result.config.models,
              options: {
                ...existing?.options,
                baseURL: result.config.options.baseURL,
                ...(Object.keys(headerConfig).length ? { headers: headerConfig } : {}),
              },
              ...(existing?.env && !result.config.env ? { env: existing.env } : {}),
            }
          })()
        : result.config

      // Auto-test on submit: verify the model is reachable AND probe
      // prompt-caching support. Blocks the save if the model can't
      // be reached (so a broken model can't be added); otherwise
      // remembers the caching capability on each model entry.
      // In edit mode we skip the test when the key is unchanged (blank),
      // since we can't present the old key to the test endpoint.
      const shouldTest =
        sl.api && result.config.options.baseURL && (props.editProviderID === undefined || result.key !== undefined)
      if (shouldTest) {
        const firstModelID = Object.keys(result.config.models)[0]
        if (firstModelID) {
          const firstModel = result.config.models[firstModelID] as Record<string, unknown> | undefined
          const test = await sl.api.testProvider({
            provider: result.providerID,
            model: firstModelID,
            apiKey: result.key ?? undefined,
            baseURL: result.config.options.baseURL,
            temperature: typeof firstModel?.temperature === "number" ? firstModel.temperature : undefined,
            topP: typeof firstModel?.top_p === "number" ? firstModel.top_p : undefined,
          })
          if (!test || !test.ok) {
            throw new Error(
              test?.error ?? language.t("provider.custom.testFailed"),
            )
          }
          // Remember: stamp promptCaching onto every model entry.
          const models = configToSave.models as Record<string, Record<string, unknown>>
          for (const id of Object.keys(models)) {
            models[id]!.promptCaching = test.promptCaching
          }
        }
      }

      await globalSync.updateConfig({
        provider: { [result.providerID]: configToSave },
        disabled_providers: nextDisabled,
      })
      return result
    },
    onSuccess: (result) => {
      // Return to the previous dialog (e.g. Settings) when this was opened as
      // a sub-dialog; with an empty history back() closes everything, which
      // matches the old close() behavior for standalone flows.
      dialog.back()
      if (props.editProviderID) {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.custom.toast.updated.title", { provider: result.name }),
          description: language.t("provider.custom.toast.updated.description", { provider: result.name }),
        })
      } else {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.connect.toast.connected.title", { provider: result.name }),
          description: language.t("provider.connect.toast.connected.description", { provider: result.name }),
        })
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    },
  }))

  const save = (e: SubmitEvent) => {
    e.preventDefault()
    if (saveMutation.isPending) return

    const result = validate()
    if (!result) return
    saveMutation.mutate(result)
  }

  return (
    <Dialog
      title={undefined}
      transition
    >
      {/* Scrolling is owned by the dialog-body CSS (overflow-y:auto + flex:1 +
          min-height:0). Adding a second scroll container here produced two
          independent scrollbars (outer body + inner div), so keep this div
          as plain flow content. */}
      <div class="flex flex-col gap-6 px-2.5 pb-3">
        <div class="px-2.5 flex gap-4 items-center">
          <Icon name="providers" class="size-5 shrink-0 icon-strong-base" />
          <div class="text-16-medium text-text-strong">
            {props.editProviderID
              ? language.t("provider.custom.title.edit")
              : props.preset && props.preset !== "custom"
                ? (LOCAL_PRESETS[props.preset]?.name ?? language.t("provider.custom.title"))
                : language.t("provider.custom.title")}
          </div>
        </div>

        <form onSubmit={save} class="px-2.5 pb-6 flex flex-col gap-6">
          <p class="text-14-regular text-text-base">{language.t("provider.custom.description.prefix")}</p>

          <div class="flex flex-col gap-4">
            <TextField
              autofocus={!props.editProviderID}
              disabled={!!props.editProviderID}
              label={language.t("provider.custom.field.providerID.label")}
              placeholder={language.t("provider.custom.field.providerID.placeholder")}
              description={
                props.editProviderID
                  ? language.t("provider.custom.field.providerID.editDescription")
                  : language.t("provider.custom.field.providerID.description")
              }
              value={form.providerID}
              onChange={(v) => setField("providerID", v)}
              validationState={form.err.providerID ? "invalid" : undefined}
              error={form.err.providerID}
            />

            <TextField
              autofocus={!!props.editProviderID}
              label={language.t("provider.custom.field.baseURL.label")}
              placeholder={language.t("provider.custom.field.baseURL.placeholder")}
              value={form.baseURL}
              onChange={(v) => setField("baseURL", v)}
              validationState={form.err.baseURL ? "invalid" : undefined}
              error={form.err.baseURL}
            />
            <TextField
              label={language.t("provider.custom.field.apiKey.label")}
              placeholder={language.t("provider.custom.field.apiKey.placeholder")}
              description={
                props.editProviderID
                  ? language.t("provider.custom.field.apiKey.editDescription")
                  : language.t("provider.custom.field.apiKey.description")
              }
              value={form.apiKey}
              onChange={(v) => setField("apiKey", v)}
            />
          </div>

          <div class="flex flex-col gap-3">
            <label class="text-12-medium text-text-weak">{language.t("provider.custom.models.label")}</label>
            <For each={form.models}>
              {(m, i) => (
                <div data-row={m.row}>
                  <div class="flex gap-2 items-start">
                    <div class="flex-1">
                      <TextField
                        label={language.t("provider.custom.models.id.label")}
                        hideLabel
                        placeholder={language.t("provider.custom.models.id.placeholder")}
                        value={m.id}
                        onChange={(v) => setModel(i(), "id", v)}
                        validationState={m.err.id ? "invalid" : undefined}
                        error={m.err.id}
                      />
                    </div>

                    <IconButton
                      type="button"
                      icon="trash"
                      variant="ghost"
                      class="mt-1.5"
                      onClick={() => removeModel(i())}
                      disabled={form.models.length <= 1}
                      aria-label={language.t("provider.custom.models.remove")}
                    />
                  </div>
                  <div class="grid grid-cols-2 gap-2 mt-2">
                    <TextField
                      label={language.t("settings.providers.model.contextLimit")}
                      value={m.contextLimit}
                      onChange={(v) => setModelParam(i(), "contextLimit", v)}
                    />
                    <TextField
                      label={language.t("settings.providers.model.outputLimit")}
                      value={m.outputLimit}
                      onChange={(v) => setModelParam(i(), "outputLimit", v)}
                    />
                    <TextField
                      label={language.t("provider.custom.models.temperature")}
                      value={m.temperature}
                      onChange={(v) => setModelParam(i(), "temperature", v)}
                      validationState={m.err.temperature ? "invalid" : undefined}
                      error={m.err.temperature}
                    />
                    <TextField
                      label={language.t("provider.custom.models.topP")}
                      value={m.topP}
                      onChange={(v) => setModelParam(i(), "topP", v)}
                      validationState={m.err.topP ? "invalid" : undefined}
                      error={m.err.topP}
                    />
                  </div>
                  <label class="flex items-center gap-2 mt-2 text-12-medium text-text-weak cursor-pointer">
                    <input
                      type="checkbox"
                      checked={m.reasoning}
                      onChange={(e) => setForm("models", i(), "reasoning", e.currentTarget.checked)}
                    />
                    {language.t("provider.custom.models.reasoning")}
                  </label>
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addModel} class="self-end">
              {language.t("provider.custom.models.add")}
            </Button>
          </div>

          <div class="flex flex-col gap-3">
            <label class="text-12-medium text-text-weak">{language.t("provider.custom.headers.label")}</label>
            <For each={form.headers}>
              {(h, i) => (
                <div class="flex gap-2 items-start" data-row={h.row}>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.headers.key.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.key.placeholder")}
                      value={h.key}
                      onChange={(v) => setHeader(i(), "key", v)}
                      validationState={h.err.key ? "invalid" : undefined}
                      error={h.err.key}
                    />
                  </div>
                  <div class="flex-1">
                    <TextField
                      label={language.t("provider.custom.headers.value.label")}
                      hideLabel
                      placeholder={language.t("provider.custom.headers.value.placeholder")}
                      value={h.value}
                      onChange={(v) => setHeader(i(), "value", v)}
                      validationState={h.err.value ? "invalid" : undefined}
                      error={h.err.value}
                    />
                  </div>
                  <IconButton
                    type="button"
                    icon="trash"
                    variant="ghost"
                    class="mt-1.5"
                    onClick={() => removeHeader(i())}
                    disabled={form.headers.length <= 1}
                    aria-label={language.t("provider.custom.headers.remove")}
                  />
                </div>
              )}
            </For>
            <Button type="button" size="small" variant="ghost" icon="plus-small" onClick={addHeader} class="self-end">
              {language.t("provider.custom.headers.add")}
            </Button>
          </div>

          <Button
            class="w-auto self-end"
            type="submit"
            size="large"
            variant="primary"
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? language.t("common.saving") : language.t("common.submit")}
          </Button>
        </form>
      </div>
    </Dialog>
  )
}
