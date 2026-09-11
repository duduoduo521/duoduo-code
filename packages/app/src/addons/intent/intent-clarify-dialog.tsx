/**
 * Intent Clarify Dialog — displays the result of intent clarification from the smart layer.
 *
 * Shows the classified intent type, confidence score, extracted entities,
 * detected ambiguities, and suggested interaction mode.
 *
 * Usage:
 *   <IntentClarifyDialog result={clarificationResult} onClose={() => setShow(false)} />
 */

import { Show, For } from "solid-js"
import { useLanguage } from "../../context/language"
import type { ClarificationResult, Entity, Ambiguity, SuggestedMode } from "../smart-layer/types"
import { Dialog } from "@duoduo-ai/ui/dialog"
import { Button } from "@duoduo-ai/ui/button"

interface IntentClarifyDialogProps {
  result: ClarificationResult
  onApplyMode?: (mode: SuggestedMode) => void
  onClose: () => void
}

export function IntentClarifyDialog(props: IntentClarifyDialogProps) {
  const language = useLanguage()

  const confidencePercent = () => {
    return Math.round(props.result.confidence * 100)
  }

  const confidenceColor = () => {
    const c = props.result.confidence
    if (c >= 0.8) return "text-green-400"
    if (c >= 0.5) return "text-yellow-400"
    return "text-red-400"
  }

  const confidenceBarColor = () => {
    const c = props.result.confidence
    if (c >= 0.8) return "bg-green-500"
    if (c >= 0.5) return "bg-yellow-500"
    return "bg-red-500"
  }

  const modeLabel = (mode: SuggestedMode): string => {
    switch (mode) {
      case "Chat":
        return language.t("intent.mode.chat")
      case "Agent":
        return language.t("intent.mode.agent")
    }
  }

  const modeIcon = (mode: SuggestedMode): string => {
    switch (mode) {
      case "Chat":
        return "💬"
      case "Agent":
        return "🤖"
    }
  }

  return (
    <Dialog title={language.t("intent.clarify.title")} class="max-w-md">
      <div data-component="intent-clarify-dialog" class="flex flex-col gap-4">
        {/* Intent Type + Confidence */}
        <div class="flex items-center justify-between p-3 rounded bg-background-stronger">
          <div class="flex flex-col gap-1">
            <span class="text-[11px] text-text-weak">{language.t("intent.clarify.intentType")}</span>
            <span class="text-sm font-semibold text-text-strong">{props.result.intentType}</span>
          </div>
          <div class="flex flex-col items-end gap-1">
            <span class="text-[11px] text-text-weak">{language.t("intent.clarify.confidence")}</span>
            <span class={`text-sm font-semibold ${confidenceColor()}`}>{confidencePercent()}%</span>
          </div>
        </div>

        {/* Confidence bar */}
        <div class="h-1.5 rounded-full bg-background-base overflow-hidden">
          <div
            class={`h-full rounded-full transition-all duration-500 ${confidenceBarColor()}`}
            style={{ width: `${confidencePercent()}%` }}
          />
        </div>

        {/* Suggested Mode */}
        <div class="flex items-center gap-3 p-3 rounded bg-background-stronger">
          <span class="text-lg">{modeIcon(props.result.suggestedMode)}</span>
          <div class="flex flex-col gap-0.5 flex-1">
            <span class="text-[11px] text-text-weak">{language.t("intent.clarify.suggestedMode")}</span>
            <span class="text-sm font-medium text-text-strong">{modeLabel(props.result.suggestedMode)}</span>
          </div>
          <Show when={props.onApplyMode}>
            {(onApply) => (
              <Button variant="primary" size="small" onClick={() => onApply()(props.result.suggestedMode)}>
                {language.t("intent.clarify.applyMode")}
              </Button>
            )}
          </Show>
        </div>

        {/* Entities */}
        <Show when={props.result.entities.length > 0}>
          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-text-weak font-medium">{language.t("intent.clarify.entities")}</span>
            <div class="flex flex-col gap-1">
              <For each={props.result.entities}>{(entity) => <EntityRow entity={entity} />}</For>
            </div>
          </div>
        </Show>

        {/* Ambiguities */}
        <Show when={props.result.ambiguities.length > 0}>
          <div class="flex flex-col gap-1.5">
            <span class="text-xs text-text-weak font-medium">{language.t("intent.clarify.ambiguities")}</span>
            <div class="flex flex-col gap-1.5">
              <For each={props.result.ambiguities}>{(ambiguity) => <AmbiguityRow ambiguity={ambiguity} />}</For>
            </div>
          </div>
        </Show>

        {/* Close button */}
        <div class="flex justify-end pt-2 border-t border-border-weak-base">
          <Button variant="secondary" size="small" onClick={props.onClose}>
            {language.t("common.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

// ─── Entity Row ───

function EntityRow(props: { entity: Entity }) {
  return (
    <div class="flex items-center gap-2 px-2 py-1.5 rounded bg-background-stronger">
      <span class="text-xs text-text-weak min-w-[60px]">{props.entity.name}</span>
      <span class="text-xs text-text-strong flex-1 break-all">{props.entity.value}</span>
    </div>
  )
}

// ─── Ambiguity Row ───

function AmbiguityRow(props: { ambiguity: Ambiguity }) {
  const language = useLanguage()

  return (
    <div class="flex flex-col gap-1.5 p-2 rounded bg-background-stronger ring-1 ring-yellow-500/20">
      <span class="text-xs text-yellow-400">{props.ambiguity.question}</span>
      <div class="flex flex-wrap gap-1">
        <For each={props.ambiguity.options}>
          {(option) => (
            <span class="px-2 py-0.5 text-[11px] rounded bg-background-base text-text-weak hover:text-text-base cursor-pointer transition-colors">
              {option}
            </span>
          )}
        </For>
      </div>
    </div>
  )
}
