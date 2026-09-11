import { Component, Show, createSignal, onMount } from "solid-js"
import { Icon } from "@duoduo-ai/ui/icon"
import { TextField } from "@duoduo-ai/ui/text-field"
import { Button } from "@duoduo-ai/ui/button"
import { useLanguage } from "@/context/language"
import { useSmartLayer } from "@/addons/smart-layer/context"
import { showToast } from "@duoduo-ai/ui/toast"
import { SettingsList } from "./settings-list"
import { SettingsPage } from "./settings-page"

export const SettingsIm: Component = () => {
  const language = useLanguage()
  const sl = useSmartLayer()

  const [feishuAppId, setFeishuAppId] = createSignal("")
  const [feishuAppSecret, setFeishuAppSecret] = createSignal("")
  const [feishuDomain, setFeishuDomain] = createSignal("feishu")
  const [feishuConfigured, setFeishuConfigured] = createSignal(false)
  const [defaultProjectPath, setDefaultProjectPath] = createSignal("")
  const [notifyOnComplete, setNotifyOnComplete] = createSignal(false)

  const MASKED = "\u2022\u2022\u2022\u2022"

  onMount(async () => {
    try {
      const data = await sl.api?.get<Record<string, any>>("/im/config")
      if (data) {
        // 后端返回 snake_case 字段（ImConfig 无 camelCase rename）
        const feishu = data.feishu
        const hasAppId = !!(feishu && feishu.app_id)
        const hasSecret = !!(feishu && feishu.app_secret)
        setFeishuConfigured(hasAppId && hasSecret)
        if (hasAppId) setFeishuAppId(feishu.app_id)
        if (feishu && feishu.domain) setFeishuDomain(feishu.domain)
        // 已保存的 secret 不回填空明文，仅用占位符标记“已配置”；保存时跳过占位符以保留原值
        if (hasSecret) setFeishuAppSecret(MASKED)
        if (data.default_project_path) setDefaultProjectPath(data.default_project_path)
        setNotifyOnComplete(!!data.notify_on_complete)
      }
    } catch {
      // 首次加载无配置时忽略错误
    }
  })

  const isMasked = (v: string) => v.includes("\u2022\u2022\u2022\u2022")

  const saveImConfig = async () => {
    try {
      const envVars: Record<string, string> = {}
      if (feishuAppId() && !isMasked(feishuAppId())) envVars.DUO_IM_FEISHU_APP_ID = feishuAppId()
      // 仅在用户实际输入了新 secret 时发送；占位符（已有配置）跳过，由后端保留原值
      if (feishuAppSecret() && !isMasked(feishuAppSecret())) envVars.DUO_IM_FEISHU_APP_SECRET = feishuAppSecret()
      if (feishuDomain()) envVars.DUO_IM_FEISHU_DOMAIN = feishuDomain()
      if (defaultProjectPath()) envVars.DUO_IM_DEFAULT_PROJECT_PATH = defaultProjectPath()
      envVars.DUO_IM_NOTIFY_ON_COMPLETE = notifyOnComplete() ? "true" : "false"

      if (feishuAppId() && !isMasked(feishuAppId())) {
        envVars.DUO_IM_ENABLED = "true"
      }

      if (!sl.api) throw new Error(language.t("settings.im.slNotConnected"))
      const res = await sl.api.post<{ success?: boolean; error?: string }>("/im/config", envVars)
      // 后端保存失败也返回 HTTP 200，必须以 success 字段判断
      if (res && res.success === false) {
        throw new Error(res.error || language.t("common.saveFailed"))
      }

      showToast({ variant: "success", title: language.t("common.saved") })
    } catch (e: any) {
      showToast({ variant: "error", title: language.t("common.saveFailed"), description: e?.message })
    }
  }

  return (
    <SettingsPage
      title={language.t("settings.im.title")}
      description={language.t("settings.im.description")}
    >

      <div class="flex items-center gap-1.5 text-13-regular text-text-on-critical-base">
        <Icon name="circle-alert" class="text-icon-critical-base shrink-0" />
        <span>{language.t("settings.im.warning")}</span>
      </div>

      <SettingsList>
        <div class="flex flex-col gap-4 py-3">
          <div class="text-13-medium text-text-strong">{language.t("settings.im.feishu.title")}</div>
          <Show when={feishuConfigured()}>
            <div class="text-12-regular text-text-positive">✓ {language.t("settings.im.configured")}</div>
          </Show>

          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">App ID</div>
            <TextField value={feishuAppId()} onChange={setFeishuAppId} placeholder="cli_xxxxxxxxxxxx" type="text" />
          </div>

          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">App Secret</div>
            <TextField
              value={feishuAppSecret()}
              onChange={setFeishuAppSecret}
              placeholder="••••••••••••••••••••"
              type="password"
            />
          </div>

          <details class="flex flex-col gap-2">
            <summary class="cursor-pointer select-none text-12-regular text-text-weak">
              {language.t("settings.im.advancedDomain")}
            </summary>
            <div class="flex flex-col gap-2 pt-1">
              <div class="text-12-regular text-text-weak">Domain</div>
              <div class="flex gap-2">
                <Button
                  variant={feishuDomain() === "feishu" ? "primary" : "secondary"}
                  size="small"
                  onClick={() => setFeishuDomain("feishu")}
                >
                  feishu.cn
                </Button>
                <Button
                  variant={feishuDomain() === "lark" ? "primary" : "secondary"}
                  size="small"
                  onClick={() => setFeishuDomain("lark")}
                >
                  larksuite.com
                </Button>
              </div>
            </div>
          </details>
        </div>
      </SettingsList>

      <SettingsList>
        <div class="flex flex-col gap-4 py-3">
          <div class="text-13-medium text-text-strong">{language.t("settings.im.general.title")}</div>

          <div class="flex flex-col gap-2">
            <div class="text-12-regular text-text-weak">{language.t("settings.im.defaultProjectPath")}</div>
            <TextField
              value={defaultProjectPath()}
              onChange={setDefaultProjectPath}
              placeholder={language.t("settings.im.defaultProjectPath.placeholder")}
              type="text"
            />
            <div class="text-11-regular text-text-weak">
              {language.t("settings.im.defaultProjectPath.hint")}
            </div>
          </div>

          <label class="flex items-center gap-2 text-13-regular text-text-base">
            <input
              type="checkbox"
              checked={notifyOnComplete()}
              onChange={(e) => setNotifyOnComplete(e.currentTarget.checked)}
            />
            {language.t("settings.im.notifyOnComplete")}
          </label>
        </div>
      </SettingsList>

      <div class="flex items-start gap-2 p-3 bg-surface-raised-base rounded-sm">
        <Icon name="help" size="small" class="text-text-weak shrink-0 mt-0.5" />
        <div class="text-13-regular text-text-base">{language.t("settings.im.config.note")}</div>
      </div>

      <div class="flex justify-end">
        <Button onClick={saveImConfig}>{language.t("common.save")}</Button>
      </div>
    </SettingsPage>
  )
}
