import { Component, For } from "solid-js"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { DialogConfirm } from "@/components/dialog-confirm"
import { useLanguage } from "@/context/language"

interface DialogAutoAcceptRiskProps {
  /** Invoked only when the user explicitly confirms they understand the risk. */
  onConfirm: () => void
}

/**
 * Shown the moment the user turns ON auto-accept permissions. Because auto-accept
 * blanket-approves every permission type (including destructive ones like file
 * deletion and shell execution), the user must consciously acknowledge the risk
 * before the switch takes effect.
 *
 * The switch only replaces "ask" with "allow" — it does not disable the command
 * classifier or the directory boundary, and the dialog says so explicitly so the
 * disclosure matches what actually happens.
 *
 * Rendered as the shared `DialogConfirm` so layout/typography match every other
 * confirm prompt, and it closes via `dialog.back()` so the Settings dialog it
 * was opened from stays open (a sub-dialog never tears down its parent).
 */
export const DialogAutoAcceptRisk: Component<DialogAutoAcceptRiskProps> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const items = [
    language.t("dialog.autoAcceptRisk.item.edit"),
    language.t("dialog.autoAcceptRisk.item.delete"),
    language.t("dialog.autoAcceptRisk.item.bash"),
    language.t("dialog.autoAcceptRisk.item.network"),
    language.t("dialog.autoAcceptRisk.item.misc"),
  ]

  return (
    <DialogConfirm
      danger
      title={language.t("dialog.autoAcceptRisk.title")}
      message={language.t("dialog.autoAcceptRisk.description")}
      detail={
        <>
          <p>{language.t("dialog.autoAcceptRisk.listTitle")}</p>
          <ul class="flex list-disc flex-col gap-1 pl-4">
            <For each={items}>{(item) => <li>{item}</li>}</For>
          </ul>
          <p>{language.t("dialog.autoAcceptRisk.notCovered")}</p>
        </>
      }
      confirmLabel={language.t("dialog.autoAcceptRisk.confirm")}
      cancelLabel={language.t("dialog.autoAcceptRisk.cancel")}
      onConfirm={() => {
        props.onConfirm()
        dialog.back()
      }}
      onCancel={() => dialog.back()}
    />
  )
}
