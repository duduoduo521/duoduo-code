import { For, Show } from "solid-js"
import type { PermissionRequest } from "@duoduo-ai/sdk/v2"
import { Button } from "@duoduo-ai/ui/button"
import { DockPrompt } from "@duoduo-ai/ui/dock-prompt"
import { Icon } from "@duoduo-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { planOperationSummary, planPreview, planPreviewImpactWarnings } from "./session-permission-dock-utils"

export function SessionPermissionDock(props: {
  request: PermissionRequest
  responding: boolean
  onDecide: (response: "once" | "always" | "reject") => void
}) {
  const language = useLanguage()

  const preview = () => planPreview(props.request.metadata)
  const impactWarnings = () => planPreviewImpactWarnings(preview())

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.permission}.description`
    const value = language.t(key as Parameters<typeof language.t>[0])
    if (value === key) return ""
    return value
  }

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="secondary"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button variant="primary" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <Show when={toolDescription()}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-hint">{toolDescription()}</div>
        </div>
      </Show>

      <Show when={props.request.patterns.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.patterns}>
              {(pattern) => <code class="text-12-regular text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>

      <Show when={props.request.permission === "plan_confirm" && preview()}>
        {(item) => (
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div class="min-w-0 space-y-2 text-12-regular text-text-base">
              <Show when={item().summary}>{(summary) => <div class="text-text-base">{summary()}</div>}</Show>
              <Show when={item().risks?.length}>
                <ul class="list-disc pl-4 text-text-weak">
                  <For each={item().risks}>{(risk) => <li>{risk}</li>}</For>
                </ul>
              </Show>
              <Show when={impactWarnings().length}>
                <div class="rounded-sm border border-warning/30 bg-warning/10 p-2">
                  <div class="mb-1 text-11-medium text-warning">Dependency impact warnings</div>
                  <ul class="list-disc pl-4 text-text-weak">
                    <For each={impactWarnings()}>{(warning) => <li>{warning}</li>}</For>
                  </ul>
                </div>
              </Show>
              <Show when={item().astOperations?.length}>
                <div class="rounded-sm bg-surface-raised-base p-2">
                  <div class="mb-1 text-11-medium text-text-base">Planned AST operations</div>
                  <ul class="list-disc pl-4 text-11-regular text-text-weak">
                    <For each={item().astOperations}>{(operation) => <li>{planOperationSummary(operation)}</li>}</For>
                  </ul>
                </div>
              </Show>
              <Show when={item().operationImpact?.length}>
                <pre class="max-h-40 overflow-auto rounded-sm bg-surface-raised-base p-2 text-11-regular text-text-weak">
                  {JSON.stringify(item().operationImpact, null, 2)}
                </pre>
              </Show>
            </div>
          </div>
        )}
      </Show>

      <Show when={props.request.metadata?.hasDelete === true}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div class="rounded-sm border border-warning/30 bg-warning/10 p-2">
            <div class="mb-1 text-11-medium text-warning">{language.t("permission.deleteWarning.title")}</div>
            <Show when={props.request.metadata != null && Array.isArray(props.request.metadata.deleteReferences) && (props.request.metadata.deleteReferences as Array<{ file: string; references: string[] }>).length > 0}>
              <div class="mb-1 text-11-regular text-text-weak">{language.t("permission.deleteWarning.references")}</div>
              <ul class="list-disc pl-4 text-11-regular text-text-weak">
                <For each={(props.request.metadata?.deleteReferences as Array<{ file: string; references: string[] }>) ?? []}>
                  {(ref) => (
                    <li>
                      <code>{ref.file}</code> ← {ref.references.join(", ")}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
