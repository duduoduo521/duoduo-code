/**
 * Quality Report Dialog — displays a quality validation report for a code artifact.
 *
 * Shows overall pass/fail status, score, individual check results,
 * and improvement suggestions.
 *
 * Usage:
 *   <QualityReportDialog report={report} onClose={() => setShow(false)} />
 */

import { Show, For } from "solid-js"
import { useLanguage } from "../../context/language"
import type { QualityCheck, QualityReport } from "../smart-layer/types"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Button } from "@duoduo-ai/ui/button"
import { Progress } from "@duoduo-ai/ui/progress"

interface QualityReportDialogProps {
  report: QualityReport
  onClose: () => void
}

export function QualityReportDialog(props: QualityReportDialogProps) {
  const language = useLanguage()

  const overallLabel = () => {
    return props.report.passed ? language.t("quality.report.passed") : language.t("quality.report.failed")
  }

  const overallColor = () => {
    return props.report.passed ? "text-green-400" : "text-red-400"
  }

  const scorePercent = () => {
    return Math.round(props.report.score * 100)
  }

  const scoreColor = () => {
    const s = props.report.score
    if (s >= 0.8) return "text-green-400"
    if (s >= 0.6) return "text-yellow-400"
    return "text-red-400"
  }

  return (
    <Dialog
      title={language.t("quality.report.title")}
      class="max-w-lg"
      action={
        <Button variant="secondary" size="small" onClick={props.onClose}>
          {language.t("common.close")}
        </Button>
      }
    >
      <div data-component="quality-report-dialog" class="flex flex-col gap-4">
        {/* Overall Status */}
        <div class="flex items-center justify-between p-3 rounded bg-background-stronger">
          <div class="flex flex-col gap-1">
            <span class="text-sm text-text-weak">{language.t("quality.report.overall")}</span>
            <span class={`text-lg font-semibold ${overallColor()}`}>{overallLabel()}</span>
          </div>
          <div class="flex flex-col items-end gap-1">
            <span class="text-sm text-text-weak">{language.t("quality.report.score")}</span>
            <span class={`text-lg font-semibold ${scoreColor()}`}>{scorePercent()}%</span>
          </div>
        </div>

        {/* Score bar */}
        <Progress value={scorePercent()} minValue={0} maxValue={100}>
          <div class="h-2 rounded-full bg-background-base overflow-hidden">
            <div
              class={`h-full rounded-full transition-all duration-500 ${
                props.report.score >= 0.8 ? "bg-green-500" : props.report.score >= 0.6 ? "bg-yellow-500" : "bg-red-500"
              }`}
              style={{ width: `${scorePercent()}%` }}
            />
          </div>
        </Progress>

        {/* Individual Checks */}
        <Show when={props.report.checks.length > 0}>
          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-text-weak font-medium">{language.t("quality.report.checks")}</span>
            <For each={props.report.checks}>{(check) => <QualityCheckRow check={check} />}</For>
          </div>
        </Show>

        {/* Suggestions */}
        <Show when={props.report.suggestions.length > 0}>
          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-text-weak font-medium">{language.t("quality.report.suggestions")}</span>
            <ul class="flex flex-col gap-1 pl-4">
              <For each={props.report.suggestions}>
                {(suggestion) => <li class="text-xs text-text-base leading-relaxed list-disc">{suggestion}</li>}
              </For>
            </ul>
          </div>
        </Show>

        {/* Close button is rendered in the dialog header action slot */}
      </div>
    </Dialog>
  )
}

// ─── Quality Check Row ───

function QualityCheckRow(props: { check: QualityCheck }) {
  const language = useLanguage()

  const statusIcon = () => {
    return props.check.passed ? "✓" : "✗"
  }

  const statusColor = () => {
    return props.check.passed ? "text-green-400" : "text-red-400"
  }

  const scorePercent = () => {
    return Math.round(props.check.score * 100)
  }

  return (
    <div class="flex items-center gap-2 px-2 py-1.5 rounded bg-background-stronger">
      <span class={`text-xs ${statusColor()}`}>{statusIcon()}</span>
      <span class="text-xs text-text-strong flex-1">{props.check.name}</span>
      <span class="text-[11px] text-text-weak">{scorePercent()}%</span>
    </div>
  )
}
