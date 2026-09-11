import { Button } from "@duoduo-ai/ui/button"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { TextField } from "@duoduo-ai/ui/text-field"
import { showToast } from "@duoduo-ai/ui/toast"
import { createSignal, Show, type Component } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useSmartLayer } from "@/addons/smart-layer/context"

interface Props {
  providerID: string
  name?: string
  back?: "close"
}

// Built-in providers (e.g. deepseek) are shipped by the app itself. Their only
// user-editable credential is the API key, which lives in auth — not in the
// user config file. This dialog exposes exactly that one field and nothing
// else, so the user cannot edit baseURL / models / headers.
export const DialogEditBuiltinProvider: Component<Props> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const sl = useSmartLayer()
  const [key, setKey] = createSignal("")
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [saving, setSaving] = createSignal(false)

  const providerName = () => props.name ?? props.providerID

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    const apiKey = key()
    if (!apiKey?.trim()) {
      setError(language.t("provider.connect.apiKey.required"))
      return
    }
    setError(undefined)
    setSaving(true)
    try {
      await globalSDK.client.auth.set({
        providerID: props.providerID,
        auth: {
          type: "api",
          key: apiKey,
        },
      })
      // Persist to OS keyring for secure storage across restarts.
      if (sl.status === "connected" && sl.api) {
        sl.api.keyringStore(props.providerID, apiKey).catch((err: unknown) => {
          console.warn("Failed to store API key in OS keyring:", err)
        })
      }
      // auth.set only writes the auth file — the running server instance keeps
      // serving the stale provider state, and use-providers.ts reads the child
      // (project) store which a manual provider.list(refresh) never updates.
      // updateConfig({}) rebuilds the server instance and re-populates both the
      // global and every child provider store, exactly like the connect /
      // disconnect flows. An empty patch is a no-op for the config file itself.
      try {
        await globalSync.updateConfig({})
      } catch {
        // Auth was written successfully; a stale list is tolerable.
      }
      dialog.back()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("provider.connect.toast.connected.title", { provider: providerName() }),
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      showToast({ title: language.t("common.requestFailed"), description: message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={language.t("provider.connect.apiKey.label", { provider: providerName() })}
      transition
    >
      <form onSubmit={handleSubmit} class="flex flex-col items-start gap-4 px-2.5 pb-3">
        <div class="text-14-regular text-text-base">
          {language.t("provider.connect.apiKey.description", { provider: providerName() })}
        </div>
        <TextField
          autofocus
          type="text"
          label={language.t("provider.connect.apiKey.label", { provider: providerName() })}
          placeholder={language.t("provider.connect.apiKey.placeholder")}
          value={key()}
          onChange={setKey}
          validationState={error() ? "invalid" : undefined}
          error={error()}
        />
        <Show when={saving()}>
          <div class="text-12-regular text-text-weak">{language.t("common.saving")}</div>
        </Show>
        <Button class="w-auto self-end" type="submit" size="large" variant="primary" disabled={saving()}>
          {language.t("common.save")}
        </Button>
      </form>
    </Dialog>
  )
}
