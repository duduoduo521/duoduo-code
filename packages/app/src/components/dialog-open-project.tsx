import { Button } from "@duoduo-ai/ui/button"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Icon, type IconProps } from "@duoduo-ai/ui/icon"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { RadioGroup } from "@duoduo-ai/ui/radio-group"
import { TextField } from "@duoduo-ai/ui/text-field"
import { showToast } from "@duoduo-ai/ui/toast"
import { createSignal, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLanguage } from "@/context/language"
import { formatErrorMessage } from "@/util/format-error-message"
import { DialogRemoteDirectory } from "./dialog-remote-directory"

type Mode = "choose" | "remote"

export interface DialogOpenProjectProps {
  onLocal: () => void
  // Receives the connected project's `worktree` (local mirror directory), NOT the
  // project id — `openProject` resolves a directory, so passing the id would make
  // the file tree read a non-existent "<id>" path and render blank.
  onRemoteConnected: (worktree: string) => void
  /** Edit mode: pre-fill an existing remote project's credentials. Host/port/path are read-only. */
  remoteEdit?: {
    projectID: string
    host: string
    port: string
    remotePath: string
    username: string
    auth: "ssh-key" | "password"
  }
}

function ChooseMode(props: { onLocal: () => void; onRemote: () => void }) {
  const language = useLanguage()
  const cards: Array<{
    key: string
    icon: IconProps["name"]
    title: string
    desc: string
    onClick: () => void
  }> = [
    {
      key: "local",
      icon: "folder",
      title: language.t("dialog.openProject.local.title"),
      desc: language.t("dialog.openProject.local.desc"),
      onClick: props.onLocal,
    },
    {
      key: "remote",
      icon: "server",
      title: language.t("dialog.openProject.remote.title"),
      desc: language.t("dialog.openProject.remote.desc"),
      onClick: props.onRemote,
    },
  ]

  return (
    <div class="grid grid-cols-2 gap-3">
      <For each={cards}>
        {(card) => (
          <button
            type="button"
            onClick={card.onClick}
            class="group flex flex-col gap-3.5 items-start text-left p-5 rounded-[var(--radius-lg)] border border-border-base bg-surface-base transition-all duration-[var(--duration-base)] ease-[var(--ease-out)] hover:bg-surface-base-hover hover:border-border-weak-selected hover:shadow-[var(--shadow-md)] cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          >
            <span class="flex size-11 items-center justify-center rounded-[var(--radius-md)] bg-background-base border border-border-weak-base text-text-weak transition-colors duration-[var(--duration-base)] group-hover:text-text-strong">
              <Icon name={card.icon} class="size-5" />
            </span>
            <span class="flex flex-col gap-1">
              <span class="text-14-medium text-text-strong">{card.title}</span>
              <span class="text-12-regular text-text-base leading-relaxed">{card.desc}</span>
            </span>
          </button>
        )}
      </For>
    </div>
  )
}

interface RemoteFormValues {
  host: string
  port: string
  remotePath: string
  username: string
  auth: "ssh-key" | "password"
}

function RemoteForm(props: {
  onBack: () => void
  onConnected: (worktree: string) => void
  /** edit mode: only credentials are editable; host/port/remotePath are read-only. */
  mode?: "create" | "edit"
  initial?: RemoteFormValues
  projectID?: string
  /** edit mode only: called after credentials are saved (no navigation). */
  onSaved?: () => void
}) {
  const language = useLanguage()
  const globalSDK = useGlobalSDK()
  const isEdit = props.mode === "edit"
  const [host, setHost] = createSignal(props.initial?.host ?? "")
  const [port, setPort] = createSignal(props.initial?.port ?? "22")
  const [remotePath, setRemotePath] = createSignal(props.initial?.remotePath ?? "")
  const [username, setUsername] = createSignal(props.initial?.username ?? "")
  const [secret, setSecret] = createSignal("")
  const [privateKey, setPrivateKey] = createSignal("")
  const [auth, setAuth] = createSignal<"ssh-key" | "password">(props.initial?.auth ?? "password")
  const dialog = useDialog()

  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal("")
  // 浏览阶段已通过连通测试的连接参数快照。submit 时若参数未变则复用该
  // 已验证结果，跳过重复的远程列目录探测（后端连接池也会复用同一 SSH 连接）。
  const [verified, setVerified] = createSignal<{
    host: string
    port: string
    remotePath: string
    username: string
    auth: "ssh-key" | "password"
  } | null>(null)

  // 新建连接（非 edit）：密码/密钥必填。edit 模式：密码/密钥留空表示保留原值，
  // 交给后端回退，因此不强制填写。
  const notReady = () =>
    !host().trim() ||
    !remotePath().trim() ||
    !username().trim() ||
    (!isEdit && (auth() === "password" ? !secret().trim() : !privateKey().trim()))

  // 浏览前必须校验：服务器地址、端口、用户名、密码/密钥 全部填写（仅新建模式使用）。
  const browseIncomplete = () =>
    !host().trim() ||
    !port().trim() ||
    !username().trim() ||
    (auth() === "password" ? !secret().trim() : !privateKey().trim())

  const showConnectErrorDialog = (message: string) => {
    dialog.show(
      () => (
        <Dialog
          title={language.t("dialog.openProject.remote.connectTestFailed")}
          size="normal"
          fit
          closeAction={() => dialog.back()}
        >
          <div class="flex flex-col gap-4 px-[var(--dialog-gutter)] pb-5 pt-4">
            <div class="text-14-regular text-text-strong">{message}</div>
            <div class="flex items-center justify-end">
              <Button
                variant="primary"
                size="large"
                onClick={() => dialog.back()}
              >
                {language.t("common.ok")}
              </Button>
            </div>
          </div>
        </Dialog>
      ),
      undefined,
      "back",
    )
  }

  // 浏览远程目录：作为独立弹窗挂到 dialog 栈（Portal 到 body）。
  // 不能内联嵌在表单弹窗 DOM 里——父弹窗 content 的 will-change:transform 会成为
  // fixed 定位的 containing block，其 overflow 也会裁剪，固定尺寸的浏览弹窗
  // 无法真正全屏居中。dismiss="back"：关闭后返回表单弹窗，且表单填写状态保留。
  const openBrowserDialog = () => {
    dialog.show(
      () => (
        <DialogRemoteDirectory
          remote={{
            host: host().trim(),
            port: Number.parseInt(port().trim() || "22", 10),
            username: username().trim(),
            auth: auth(),
            secret: secret().trim(),
            privateKey: privateKey(),
          }}
          initialDir={remotePath().trim() || "/"}
          onSelect={(dir) => {
            setRemotePath(dir)
            dialog.back()
          }}
          onClose={() => dialog.back()}
        />
      ),
      undefined,
      "back",
    )
  }

  // 点击浏览：先校验信息完整性，再做一次连接性测试。
  // 测试失败弹小型确认弹窗让用户点确定去修改；成功才打开目录浏览。
  const openBrowser = async () => {
    if (browseIncomplete()) {
      setError(language.t("dialog.openProject.remote.browseRequired"))
      return
    }
    setError("")
    setSubmitting(true)
    try {
      const client = globalSDK.createClient({})
      const res = await client.project.remoteList({
        host: host().trim(),
        port: Number.parseInt(port().trim() || "22", 10),
        username: username().trim(),
        auth: auth(),
        secret: auth() === "password" ? secret().trim() : "",
        privateKey: auth() === "ssh-key" ? privateKey() : "",
        dir: remotePath().trim() || "/",
      })
      if (!res.data) {
        const detail = res.error ? formatErrorMessage(res.error) : ""
        showConnectErrorDialog(
          detail || language.t("dialog.openProject.remote.connectFailed"),
        )
        return
      }
      setVerified({
        host: host().trim(),
        port: port().trim(),
        remotePath: remotePath().trim() || "/",
        username: username().trim(),
        auth: auth(),
      })
      openBrowserDialog()
    } catch (e: unknown) {
      showConnectErrorDialog(formatErrorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  const submit = async () => {
    setError("")
    if (notReady()) {
      setError(language.t("dialog.openProject.remote.required"))
      return
    }
    setSubmitting(true)
    const client = globalSDK.createClient({})
    // edit 模式：仅更新凭证，连接身份(host/port/remotePath)不可变，用 initial 原值。
    if (isEdit) {
      try {
        const res = await client.project.updateRemoteCredential({
          projectID: props.projectID ?? "",
          auth: auth(),
          username: username().trim(),
          secret: auth() === "password" ? secret().trim() : privateKey().trim(),
          privateKey: auth() === "ssh-key" ? privateKey() : undefined,
        })
        if (res.error) {
          showConnectErrorDialog(formatErrorMessage(res.error))
          return
        }
        showToast({
          variant: "success",
          title: language.t("dialog.openProject.remote.credentialUpdated"),
        })
        props.onSaved?.()
      } catch (e: unknown) {
        showConnectErrorDialog(formatErrorMessage(e))
      } finally {
        setSubmitting(false)
      }
      return
    }
    const v = verified()
    const paramsUnchanged =
      !!v &&
      v.host === host().trim() &&
      v.port === port().trim() &&
      v.remotePath === (remotePath().trim() || "/") &&
      v.username === username().trim() &&
      v.auth === auth()
    try {
      // 浏览阶段已通过连通测试且参数未变时，复用该验证结果，跳过重复的远程列目录探测。
      // 否则先测试连通性（列出根目录），通过后再真正连接，避免打开未验证的目录。
      if (!paramsUnchanged) {
        const probe = await client.project.remoteList({
          host: host().trim(),
          port: Number.parseInt(port().trim() || "22", 10),
          username: username().trim(),
          auth: auth(),
          secret: auth() === "password" ? secret().trim() : "",
          privateKey: auth() === "ssh-key" ? privateKey() : "",
          dir: remotePath().trim() || "/",
        })
        if (!probe.data) {
          const detail = probe.error ? formatErrorMessage(probe.error) : ""
          showConnectErrorDialog(
            detail || language.t("dialog.openProject.remote.connectFailed"),
          )
          return
        }
      }
      // 连通测试通过，执行真正的连接。
      const res = await client.project.connectRemote({
        host: host().trim(),
        port: Number.parseInt(port().trim() || "22", 10),
        remotePath: remotePath().trim() || "/",
        auth: auth(),
        username: username().trim(),
        secret: auth() === "password" ? secret().trim() : undefined,
        privateKey: auth() === "ssh-key" ? privateKey() : undefined,
      })
      if (res.error || !res.data?.id) {
        const detail =
          res.error && "errors" in res.error && Array.isArray(res.error.errors)
            ? res.error.errors.map((e) => Object.values(e)[0]).join("; ")
            : ""
        showConnectErrorDialog(
          detail || language.t("dialog.openProject.remote.connectFailed"),
        )
        return
      }
      showToast({
        variant: "success",
        title: language.t("dialog.openProject.remote.connected"),
      })
      props.onConnected(res.data.worktree)
    } catch (e: unknown) {
      showConnectErrorDialog(formatErrorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div class="flex flex-col gap-3">
        <div class="grid grid-cols-[1fr_8rem] gap-3">
          <TextField
            label={language.t("dialog.openProject.remote.host")}
            placeholder="192.168.1.10"
            value={host()}
            autofocus={!isEdit}
            disabled={submitting() || isEdit}
            onChange={setHost}
          />
          <TextField
            label={language.t("dialog.openProject.remote.port")}
            placeholder="22"
            value={port()}
            disabled={submitting() || isEdit}
            onChange={setPort}
          />
        </div>
        <TextField
          label={language.t("dialog.openProject.remote.username")}
          placeholder="root"
          value={username()}
          disabled={submitting()}
          onChange={setUsername}
        />
        <div class="flex flex-col gap-2">
          <span class="text-12-medium text-text-strong">{language.t("dialog.openProject.remote.auth")}</span>
          <RadioGroup
            size="small"
            fill
            options={["ssh-key", "password"] as const}
            current={auth()}
            value={(x) => x}
            label={(x) =>
              x === "ssh-key"
                ? language.t("dialog.openProject.remote.sshKey")
                : language.t("dialog.openProject.remote.password")
            }
            onSelect={(v) => {
              if (v) setAuth(v)
            }}
          />
        </div>
        <Show when={auth() === "ssh-key"}>
          <TextField
            label={language.t("dialog.openProject.remote.privateKey")}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            multiline
            rows={4}
            value={privateKey()}
            disabled={submitting()}
            onChange={setPrivateKey}
          />
        </Show>
        <Show when={auth() === "password"}>
          <TextField
            label={language.t("dialog.openProject.remote.secret")}
            type="password"
            placeholder="••••••••"
            value={secret()}
            disabled={submitting()}
            onChange={setSecret}
          />
        </Show>

        <div class="flex flex-col gap-2">
          <span class="text-12-medium text-text-strong">{language.t("dialog.openProject.remote.path")}</span>
          <div class="flex items-center gap-2">
            <input
              class="flex-1 cursor-default rounded-md border border-border-base bg-surface-base px-3 py-2 text-14-regular text-text-strong placeholder:text-[color-mix(in_oklab,var(--text-weaker)_70%,transparent)] outline-none focus:border-border-strong disabled:opacity-50"
              placeholder={language.t("dialog.openProject.remote.pathPlaceholder")}
              value={remotePath()}
              readonly
              disabled={submitting() || isEdit}
            />
            <Show when={!isEdit}>
              <button
                class="shrink-0 rounded-md border border-border-base px-3 py-2 text-14-regular text-text-strong hover:bg-surface-weak disabled:cursor-not-allowed disabled:opacity-50"
                disabled={submitting() || browseIncomplete()}
                onClick={openBrowser}
                title={language.t("dialog.openProject.remote.browseTitle")}
              >
                {language.t("dialog.openProject.remote.browseTitle")}
              </button>
            </Show>
          </div>
        </div>

      <Show when={error()}>
        <div class="text-12-regular text-text-on-critical-base bg-surface-critical-weak rounded-md px-3 py-2">
          {error()}
        </div>
      </Show>

      <div class="flex items-center justify-end gap-2 pt-3">
        <Button variant="secondary" size="large" onClick={props.onBack} disabled={submitting()}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="primary" size="large" icon={isEdit ? "check" : "link"} onClick={submit} disabled={submitting() || notReady()}>
          {submitting()
            ? language.t("common.connecting")
            : isEdit
              ? language.t("dialog.openProject.remote.saveCredentials")
              : language.t("dialog.openProject.remote.connect")}
        </Button>
      </div>

    </div>
  )
}

export function DialogOpenProject(props: DialogOpenProjectProps) {
  const language = useLanguage()
  const dialog = useDialog()
  const [mode, setMode] = createSignal<Mode>("choose")

  const onLocal = () => {
    dialog.close()
    props.onLocal()
  }

  const onRemote = () => setMode("remote")

  const onBack = () => setMode("choose")

  const onConnected = (worktree: string) => {
    dialog.close()
    props.onRemoteConnected(worktree)
  }

  const onSaved = () => dialog.close()

  // Edit mode: skip the choose/remote selection and render the credential form directly.
  if (props.remoteEdit) {
    return (
      <Dialog title={language.t("dialog.openProject.remote.editTitle")} fit closeAction={onSaved}>
        {/* fit 模式高度随内容自适应（非 fit 容器固定 512px，表单略高会出滚动条）；
            fit 的宽度是收缩的，因此给 body 显式定宽。 */}
        <div class="flex flex-1 min-h-0 flex-col w-[520px] max-w-full px-5 pb-5 pt-3">
          <RemoteForm
            mode="edit"
            initial={{
              host: props.remoteEdit.host,
              port: props.remoteEdit.port,
              remotePath: props.remoteEdit.remotePath,
              username: props.remoteEdit.username,
              auth: props.remoteEdit.auth,
            }}
            projectID={props.remoteEdit.projectID}
            onBack={onSaved}
            onConnected={onSaved}
            onSaved={onSaved}
          />
        </div>
      </Dialog>
    )
  }

  return (
    <Show
      when={mode() === "choose"}
      fallback={
        <Dialog
          title={language.t("dialog.openProject.remote.formTitle")}
          fit
          closeAction={onBack}
        >
          {/* Description intentionally rendered inside the body: the global
              `description` slot sits BELOW the header hairline (with a -6px
              upward pull), which reads as an orphaned paragraph stuck under
              the divider. Keep it out of that slot. fit 模式高度随内容自适应，
              避免非 fit 固定 512px 容器差一点高度就出滚动条；fit 宽度收缩，
              需要显式定宽。 */}
          <div class="flex flex-1 min-h-0 flex-col w-[520px] max-w-full px-5 pb-5 pt-3">
            <p class="text-13-regular text-text-base pb-3">
              {language.t("dialog.openProject.remote.formDesc")}
            </p>
            <RemoteForm onBack={onBack} onConnected={onConnected} />
          </div>
        </Dialog>
      }
      >
      <Dialog title={language.t("dialog.openProject.title")} fit>
        <div class="flex flex-1 min-h-0 flex-col px-5 pb-5 pt-3">
          <p class="text-13-regular text-text-base pb-3">
            {language.t("dialog.openProject.description")}
          </p>
          <ChooseMode onLocal={onLocal} onRemote={onRemote} />
        </div>
      </Dialog>
      </Show>
  )
}
