/**
 * Intent Clarify Trigger — intercepts message sending to perform intent clarification.
 *
 * Before a message is sent, `clarify(input)` calls the smart-layer `clarifyIntent` API.
 * If ambiguities are detected, the dialog is shown for user confirmation.
 * The caller awaits the result: confirmed input proceeds, cancelled aborts the send.
 *
 * Usage:
 *   const { clarify, IntentClarifyDialogSlot } = useIntentClarify()
 *
 *   // Before sending:
 *   const result = await clarify("deploy to prod")
 *   if (result.confirmed) { sendMessage(result.input) }
 *
 *   // In JSX:
 *   <IntentClarifyDialogSlot />
 */

import { createSignal, Show } from "solid-js"
import { useSmartLayer } from "../smart-layer/context"
import type { ClarificationResult, SuggestedMode } from "../smart-layer/types"
import { IntentClarifyDialog } from "./intent-clarify-dialog"

// ─── Types ───

export interface ClarifyOutput {
  /** Whether the user confirmed (true) or cancelled (false) */
  confirmed: boolean
  /** The original user input */
  input: string
  /** The clarification result from the API, if available */
  result?: ClarificationResult
  /** The mode the user chose to apply, if any */
  appliedMode?: SuggestedMode
}

export interface IntentClarifyState {
  /** Call to check intent before sending. Resolves when user confirms or cancels. */
  clarify: (input: string, projectContext?: Record<string, string>) => Promise<ClarifyOutput>
  /** Whether the clarification dialog is visible */
  showDialog: boolean
  /** The current clarification data (null when dialog is hidden) */
  clarificationData: ClarificationResult | null
  /** Whether a clarify API call is in progress */
  loading: boolean
  /** Error from the last clarify call, if any */
  error: string | null
  /** Apply a suggested mode from the dialog (updates pendingAppliedMode for confirm) */
  applyMode: (mode: SuggestedMode) => void
  /** Programmatically confirm the dialog */
  confirm: () => void
  /** Programmatically cancel the dialog */
  cancel: () => void
}

// ─── Hook ───

export function useIntentClarify(): IntentClarifyState {
  const sl = useSmartLayer()

  const [showDialog, setShowDialog] = createSignal(false)
  const [clarificationData, setClarificationData] = createSignal<ClarificationResult | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // Pending promise resolvers — only one clarification flow at a time
  let resolveConfirm: ((output: ClarifyOutput) => void) | null = null
  let pendingInput: string = ""
  let pendingAppliedMode: SuggestedMode | undefined = undefined

  const clarify = async (input: string, projectContext?: Record<string, string>): Promise<ClarifyOutput> => {
    // Reset state
    setError(null)

    // Smart layer unavailable — skip clarification, allow send
    if (!sl.api) {
      return { confirmed: true, input }
    }

    setLoading(true)
    try {
      const result = await sl.api.clarifyIntent(input, projectContext)

      // No ambiguities — no need to show dialog, allow send
      if (result.ambiguities.length === 0) {
        return { confirmed: true, input, result }
      }

      // Ambiguities detected — show dialog and wait for user decision
      return new Promise<ClarifyOutput>((resolve) => {
        pendingInput = input
        pendingAppliedMode = undefined
        resolveConfirm = resolve

        setClarificationData(result)
        setShowDialog(true)
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : "Intent clarification failed"
      setError(message)
      // On API failure, allow the message to be sent without clarification
      return { confirmed: true, input }
    } finally {
      setLoading(false)
    }
  }

  const applyMode = (mode: SuggestedMode) => {
    pendingAppliedMode = mode
  }

  const confirm = () => {
    if (resolveConfirm) {
      const data = clarificationData()
      resolveConfirm({
        confirmed: true,
        input: pendingInput,
        result: data ?? undefined,
        appliedMode: pendingAppliedMode,
      })
      resolveConfirm = null
    }
    setShowDialog(false)
    setClarificationData(null)
  }

  const cancel = () => {
    if (resolveConfirm) {
      resolveConfirm({ confirmed: false, input: pendingInput })
      resolveConfirm = null
    }
    setShowDialog(false)
    setClarificationData(null)
  }

  return {
    clarify,
    get showDialog() {
      return showDialog()
    },
    get clarificationData() {
      return clarificationData()
    },
    get loading() {
      return loading()
    },
    get error() {
      return error()
    },
    applyMode,
    confirm,
    cancel,
  }
}

// ─── Component ───

interface IntentClarifyTriggerProps {
  /** The clarify state, usually from useIntentClarify() */
  state: IntentClarifyState
  /** Optional callback when user applies a suggested mode from the dialog */
  onApplyMode?: (mode: SuggestedMode) => void
}

export function IntentClarifyTrigger(props: IntentClarifyTriggerProps) {
  const handleApplyMode = (mode: SuggestedMode) => {
    // Propagate mode back to the hook's pendingAppliedMode so confirm() includes it
    props.state.applyMode(mode)
    // Also notify external callback
    props.onApplyMode?.(mode)
  }

  const handleClose = () => {
    props.state.cancel()
  }

  return (
    <Show when={props.state.showDialog && props.state.clarificationData}>
      {(data) => <IntentClarifyDialog result={data()} onApplyMode={handleApplyMode} onClose={handleClose} />}
    </Show>
  )
}
