import { Match, Show, Switch, createMemo, For } from "solid-js"
import { Tooltip, type TooltipProps } from "@duoduo-ai/ui/tooltip"
import { ProgressCircle } from "@duoduo-ai/ui/progress-circle"
import { Button } from "@duoduo-ai/ui/button"
import type { Part } from "@duoduo-ai/sdk/v2/client"

import { useFile } from "@/context/file"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { getSessionContextMetrics } from "@/components/session/session-context-metrics"
import {
  estimateSessionContextBreakdown,
  buildBreakdownFromBackend,
  type SessionContextBreakdownKey,
} from "@/components/session/session-context-breakdown"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"

const BREAKDOWN_COLOR: Record<SessionContextBreakdownKey, string> = {
  system: "var(--syntax-info)",
  user: "var(--syntax-success)",
  assistant: "var(--syntax-property)",
  tool: "var(--syntax-warning)",
  other: "var(--syntax-comment)",
  messages: "var(--syntax-success)",
  systemPrompt: "var(--syntax-info)",
  tools: "var(--syntax-warning)",
  skills: "var(--syntax-property)",
}

/** Format token count in K units with Chinese-friendly numbers.
 *  e.g. 64000 → "6.4万" (zh) / "64K" (en)
 *       128000 → "12.8万" (zh) / "128K" (en)
 *       200000 → "20万" (zh) / "200K" (en)
 *       1000000 → "100万" (zh) / "1M" (en)
 */
function formatTokens(tokens: number, locale: string): string {
  if (locale === "zh") {
    if (tokens >= 1_0000_0000) {
      const yi = tokens / 1_0000_0000
      return `${formatChineseNumber(yi)}亿`
    }
    if (tokens >= 1_0000) {
      const wan = tokens / 1_0000
      return `${formatChineseNumber(wan)}万`
    }
    if (tokens >= 1000) {
      const qian = tokens / 1000
      return `${formatChineseNumber(qian)}千`
    }
    return String(tokens)
  }
  // en / fallback
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000
    return `${+m.toFixed(1)}M`
  }
  if (tokens >= 1000) {
    const k = tokens / 1000
    return `${+k.toFixed(1)}K`
  }
  return String(tokens)
}

/** Format a Chinese-unit number: trim trailing zeros after decimal point.
 *  20.0 → "20", 6.4 → "6.4", 12.8 → "12.8"
 */
function formatChineseNumber(n: number): string {
  const s = n.toFixed(1)
  return s.endsWith(".0") ? s.slice(0, -2) : s
}

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  placement?: TooltipProps["placement"]
}

function openSessionContext(args: {
  view: ReturnType<ReturnType<typeof useLayout>["view"]>
  layout: ReturnType<typeof useLayout>
  tabs: ReturnType<ReturnType<typeof useLayout>["tabs"]>
}) {
  if (!args.view.reviewPanel.opened()) args.view.reviewPanel.open()
  if (args.layout.fileTree.opened() && args.layout.fileTree.tab() !== "all") args.layout.fileTree.setTab("all")
  void args.tabs.open("context")
  args.tabs.setActive("context")
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const file = useFile()
  const layout = useLayout()
  const language = useLanguage()
  const providers = useProviders()
  const { params, tabs, view } = useSessionLayout()

  const variant = createMemo(() => props.variant ?? "button")
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
  })
  const messages = createMemo(() => (params.id ? (sync.data.message[params.id] ?? []) : []))

  const metrics = createMemo(() => getSessionContextMetrics(messages(), providers.all()))
  const context = createMemo(() => metrics().context)

  const breakdown = createMemo(() => {
    const c = context()
    if (!c?.contextTokens) return []
    if (c.breakdown) return buildBreakdownFromBackend(c.breakdown, c.contextTokens)
    return estimateSessionContextBreakdown({
      messages: messages(),
      parts: sync.data.part as Record<string, Part[] | undefined>,
      input: c.contextTokens,
    })
  })

  const breakdownLabel = (key: SessionContextBreakdownKey) => {
    if (key === "system") return language.t("context.breakdown.system")
    if (key === "user") return language.t("context.breakdown.user")
    if (key === "assistant") return language.t("context.breakdown.assistant")
    if (key === "tool") return language.t("context.breakdown.tool")
    if (key === "messages") return language.t("context.breakdown.messages")
    if (key === "systemPrompt") return language.t("context.breakdown.systemPrompt")
    if (key === "tools") return language.t("context.breakdown.tools")
    if (key === "skills") return language.t("context.breakdown.skills")
    return language.t("context.breakdown.other")
  }

  const openContext = () => {
    if (!params.id) return

    if (tabState.activeTab() === "context") {
      tabs().close("context")
      return
    }
    openSessionContext({
      view: view(),
      layout,
      tabs: tabs(),
    })
  }

  const circle = () => (
    <div class="flex items-center justify-center">
      <ProgressCircle size={16} strokeWidth={2} percentage={context()?.usage ?? 0} />
    </div>
  )

  const loc = createMemo(() => language.locale())
  const fmt = (tokens: number) => formatTokens(tokens, loc())

  const tooltipValue = () => {
    const textBase = "var(--text-base)"
    const textStrong = "var(--text-strong)"

    return (
      <div class="flex flex-col gap-2 p-3" style={{ width: "max-content", "min-width": "200px", "max-width": "280px" }}>
        <Show when={context()}>
          {(ctx) => (
            <>
              {/* Context capacity line */}
              <div class="flex items-baseline justify-between gap-3 text-11-regular">
                <span style={{ color: textBase }}>{language.t("context.usage.capacity")}</span>
                <Show when={ctx().limit}>
                  {(limit) => (
                    <span class="tabular-nums" style={{ color: textStrong }}>
                      {fmt(ctx().contextTokens)}/{fmt(limit())} ({ctx().usage ?? 0}%)
                    </span>
                  )}
                </Show>
                <Show when={!ctx().limit}>
                  <span class="tabular-nums" style={{ color: textStrong }}>
                    {fmt(ctx().contextTokens)}
                  </span>
                </Show>
              </div>

              {/* Breakdown segments — label left, percent right */}
              <Show when={breakdown().length > 0}>
                <div class="flex flex-col gap-1">
                  <For each={breakdown()}>
                    {(segment) => (
                      <div class="flex items-center gap-2 text-11-regular">
                        <div
                          class="size-2 rounded-sm shrink-0"
                          style={{ "background-color": BREAKDOWN_COLOR[segment.key] }}
                        />
                        <span
                          class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap"
                          style={{ color: textBase }}
                        >
                          {breakdownLabel(segment.key)}
                        </span>
                        <span
                          class="tabular-nums shrink-0"
                          style={{ color: textStrong, "min-width": "4ch", "text-align": "right" }}
                        >
                          {segment.percent}%
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              {/* Cache hit rate */}
              <Show when={ctx().cacheHitRate != null}>
                <div class="flex items-center justify-between gap-3 text-11-regular">
                  <span style={{ color: textBase }}>{language.t("context.usage.cacheHitRate")}</span>
                  <span class="tabular-nums" style={{ color: textStrong }}>
                    {ctx().cacheHitRate}%
                  </span>
                </div>
              </Show>
            </>
          )}
        </Show>
      </div>
    )
  }

  return (
    <Show when={params.id}>
      <Tooltip value={tooltipValue()} placement={props.placement ?? "top"}>
        <Switch>
          <Match when={variant() === "indicator"}>{circle()}</Match>
          <Match when={true}>
            <Button
              type="button"
              variant="ghost"
              class="size-6"
              onClick={openContext}
              aria-label={language.t("context.usage.view")}
            >
              {circle()}
            </Button>
          </Match>
        </Switch>
      </Tooltip>
    </Show>
  )
}
