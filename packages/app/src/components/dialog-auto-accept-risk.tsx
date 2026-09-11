import { Component, For } from "solid-js"
import { useDialog } from "@duoduo-ai/ui/context/dialog"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Button } from "@duoduo-ai/ui/button"
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

  const handleCancel = () => dialog.close()

  const handleConfirm = () => {
    props.onConfirm()
    dialog.close()
  }

  return (
    <Dialog
      title={language.t("dialog.autoAcceptRisk.title")}
      description={language.t("dialog.autoAcceptRisk.description")}
    >
      <div class="flex flex-col gap-3">
        <p class="text-12-regular text-text-weak">{language.t("dialog.autoAcceptRisk.listTitle")}</p>
        <ul class="flex list-disc flex-col gap-1 pl-4 text-12-regular text-text-strong">
          <For each={items}>{(item) => <li>{item}</li>}</For>
        </ul>
        <p class="text-12-regular text-text-weak">{language.t("dialog.autoAcceptRisk.notCovered")}</p>
        <div class="mt-2 flex justify-end gap-2">
          <Button variant="ghost" onClick={handleCancel}>
            {language.t("dialog.autoAcceptRisk.cancel")}
          </Button>
          <Button variant="primary" onClick={handleConfirm}>
            {language.t("dialog.autoAcceptRisk.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
