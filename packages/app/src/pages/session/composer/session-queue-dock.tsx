import { For, Show } from "solid-js"
import { Icon } from "@duoduo-ai/ui/icon"
import { IconButton } from "@duoduo-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import { promptQueue } from "@/components/prompt-input/queue"

/**
 * Queue dock for the session composer (Plan A).
 *
 * Shows prompts queued while the session was busy, each with a "queued" badge
 * and a remove action. A failed dequeue attempt (send error after the session
 * turned idle) is marked `failed` and stays here with a retry button instead
 * of being retried in a hot loop.
 */
export function SessionQueueDock(props: { sessionID?: string }) {
  const language = useLanguage()
  const items = () => (props.sessionID ? promptQueue.items(props.sessionID) : [])

  return (
    <Show when={props.sessionID && items().length > 0}>
      <div
        data-component="session-queue-dock"
        class="w-full mb-2 rounded-md border border-border-weak-base bg-background-base/70 px-3 py-2 flex flex-col gap-1.5"
      >
        <div class="flex items-center gap-1.5 text-12-regular text-text-weak">
          <Icon name="prompt" class="size-3.5 shrink-0" />
          <span>{language.t("session.queue.title")}</span>
        </div>
        <For each={items()}>
          {(item) => (
            <div
              classList={{
                "flex items-center gap-2 rounded px-2 py-1.5 border border-border-weak-base": true,
                "bg-background-stronger": !item.failed,
                "bg-surface-critical-weak border-transparent": !!item.failed,
              }}
            >
              <span class="text-13-regular text-text-base truncate flex-1 min-w-0" title={item.preview}>
                {item.preview}
              </span>
              <Show
                when={!item.failed}
                fallback={
                  <button
                    type="button"
                    class="text-11-regular text-icon-critical-base shrink-0 rounded-full border border-border-critical-base px-1.5 py-0.5 hover:bg-surface-critical-weak transition-colors"
                    onClick={() => {
                      if (!props.sessionID) return
                      promptQueue.retry(props.sessionID, item.id)
                    }}
                  >
                    {language.t("session.queue.retry")}
                  </button>
                }
              >
                <span
                  class="text-11-regular text-text-weak shrink-0 rounded-full border border-border-weak-base px-1.5 py-0.5"
                  style={{ animation: "var(--animate-pulse-scale)" }}
                >
                  {language.t("session.queue.badge")}
                </span>
              </Show>
              <IconButton
                icon="close-small"
                variant="ghost"
                class="size-5 shrink-0"
                aria-label={language.t("session.queue.remove")}
                onClick={() => {
                  if (!props.sessionID) return
                  promptQueue.remove(props.sessionID, item.id)
                }}
              />
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
