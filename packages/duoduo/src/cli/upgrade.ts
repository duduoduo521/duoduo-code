import { Bus } from "@/bus"
import { Config } from "@/config"
import { AppRuntime } from "@/effect/app-runtime"
import { Flag } from "@/flag/flag"
import { Installation } from "@/installation"
import { InstallationVersion } from "@/installation/version"
import { Log } from "@/util"

const log = Log.create({ service: "upgrade" })

export async function upgrade() {
  const config = await AppRuntime.runPromise(Config.Service.use((cfg) => cfg.getGlobal()))
  if (config.autoupdate === false || Flag.DUODUO_DISABLE_AUTOUPDATE) return
  const method = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.method()))
  const latest = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.latest(method))).catch((e) => {
    log.warn("failed to check latest version", { error: e })
    return undefined
  })
  if (!latest) return

  if (Flag.DUODUO_ALWAYS_NOTIFY_UPDATE) {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (InstallationVersion === latest) return

  const kind = Installation.getReleaseType(InstallationVersion, latest)

  if (config.autoupdate === "notify" || kind !== "patch") {
    await Bus.publish(Installation.Event.UpdateAvailable, { version: latest })
    return
  }

  if (method === "unknown") return
  await AppRuntime.runPromise(Installation.Service.use((svc) => svc.upgrade(method, latest)))
    .then(() => Bus.publish(Installation.Event.Updated, { version: latest }))
    .catch((e) => {
      log.error("auto-upgrade failed", { error: e, version: latest })
    })
}
