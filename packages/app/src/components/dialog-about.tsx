import { Component, Show, createSignal } from "solid-js"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Button } from "@duoduo-ai/ui/button"
import { Splash } from "@duoduo-ai/ui/logo"
import { Icon } from "@duoduo-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { showToast } from "@duoduo-ai/ui/toast"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { APP_DOMAIN } from "@/config/domains"

function LicenseDialog() {
  const language = useLanguage()

  return (
    <Dialog size="x-large" title={language.t("about.openSourceLicenses")} fit transition>
      <iframe
        src="/THIRD-PARTY-LICENSES.html"
        class="w-full border-none"
        style={{ height: "min(80vh, 900px)" }}
        title="Open Source Licenses"
      />
    </Dialog>
  )
}

export const DialogAbout: Component = () => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()

  const currentYear = new Date().getFullYear()

  const updateStatus = () => platform.updateStatus?.() ?? "none"
  const updateVersion = () => platform.updateVersion?.() ?? ""

  const [checking, setChecking] = createSignal(false)

  const handleCheckUpdate = async () => {
    if (!platform.checkUpdate) return
    setChecking(true)
    try {
      const info = await platform.checkUpdate()
      if (!info.updateAvailable) {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("about.upToDate"),
        })
      }
      // If update is available, checkUpdate starts download automatically.
      // The titlebar UpdateStatusIndicator shows progress.
      // On download complete, the useUpdatePolling in layout.tsx will show a toast.
    } catch {
      showToast({
        variant: "error",
        icon: "circle-x",
        title: language.t("about.updateError"),
      })
    } finally {
      setChecking(false)
    }
  }

  const handleInstallRestart = () => {
    if (platform.updateAndRestart) void platform.updateAndRestart()
  }

  return (
    <Dialog size="normal" fit transition>
      <div class="flex flex-col items-center gap-5 py-6 px-6 w-full">
        {/* Logo */}
        <Splash style={{ width: "20%", "max-width": "80px", height: "auto" }} />

        {/* App name & version */}
        <div class="flex flex-col items-center gap-1">
          <h2 class="text-18-semibold text-text-strong">{language.t("app.name.desktop")}</h2>
          <span class="text-12-regular text-text-weak">v{platform.version?.() ?? "0.0.0"}</span>
        </div>

        {/* Description */}
        <p class="text-13-regular text-text-base text-center max-w-xs">{language.t("about.description")}</p>

        {/* Links */}
        <div class="flex flex-col items-center gap-2 w-full">
          <Button
            variant="secondary"
            size="normal"
            class="w-full"
            onClick={() => platform.openLink(APP_DOMAIN)}
          >
            <Icon name="link" size="small" class="mr-2" />
            {language.t("about.website")}
          </Button>
          <Button
            variant="secondary"
            size="normal"
            class="w-full"
            onClick={() => platform.openLink("https://github.com/duduoduo521/duoduo-code")}
          >
            <Icon name="github" size="small" class="mr-2" />
            {language.t("about.github")}
          </Button>
          <Button
            variant="secondary"
            size="normal"
            class="w-full"
            onClick={() => platform.openLink("https://gitee.com/duduoduo521/duoduo-code")}
          >
            <Icon name="branch" size="small" class="mr-2" />
            {language.t("about.gitee")}
          </Button>
        </div>

        {/* Update section (desktop only) */}
        {/* oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound) */}
        <Show when={platform.platform === "desktop" && platform.checkUpdate}>
          <Show
            when={updateStatus() === "downloaded"}
            fallback={
              <Button
                variant="ghost"
                size="small"
                class="w-full"
                disabled={checking() || updateStatus() === "downloading" || updateStatus() === "checking"}
                onClick={handleCheckUpdate}
              >
                <Icon name="download" size="small" class="mr-2" />
                <Show
                  when={updateStatus() === "downloading" || updateStatus() === "checking"}
                  fallback={checking() ? language.t("about.checking") : language.t("about.checkUpdate")}
                >
                  {language.t("about.downloading")}
                </Show>
              </Button>
            }
          >
            <div class="flex flex-col items-center gap-2 w-full">
              <p class="text-13-regular text-text-base text-center">
                {language.t("about.updateDownloaded", { version: updateVersion() })}
              </p>
              <Button variant="secondary" size="normal" class="w-full" onClick={handleInstallRestart}>
                <Icon name="download" size="small" class="mr-2" />
                {language.t("toast.update.action.restart")}
              </Button>
            </div>
          </Show>
        </Show>

        {/* Based on */}
        <p class="text-11-regular text-text-weak text-center max-w-xs">{language.t("about.basedOn")}</p>

        {/* Open Source Licenses */}
        <button
          type="button"
          class="text-11-regular text-accent hover:underline cursor-pointer bg-transparent border-none p-0"
          onClick={() => dialog.show(() => <LicenseDialog />)}
        >
          {language.t("about.openSourceLicenses")}
        </button>

        {/* Copyright */}
        <p class="text-11-regular text-text-weak text-center">
          © {currentYear} DuoDuo AI. {language.t("about.copyright")}
        </p>
      </div>
    </Dialog>
  )
}
