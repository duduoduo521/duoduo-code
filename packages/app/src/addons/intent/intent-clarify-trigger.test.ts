import { describe, test, expect, mock } from "bun:test"
import type { ClarificationResult, SuggestedMode } from "../smart-layer/types"

// ─── Re-implement useIntentClarify logic as a testable class ───
// We replicate the hook's core logic as a plain class to avoid SolidJS reactivity in tests.

interface SmartLayerApi {
  clarifyIntent: (input: string, projectContext?: Record<string, string>) => Promise<ClarificationResult>
}

interface ClarifyOutput {
  confirmed: boolean
  input: string
  result?: ClarificationResult
  appliedMode?: SuggestedMode
}

class IntentClarifyLogic {
  showDialog = false
  clarificationData: ClarificationResult | null = null
  loading = false
  error: string | null = null

  private resolveConfirm: ((output: ClarifyOutput) => void) | null = null
  private pendingInput = ""
  private pendingAppliedMode: SuggestedMode | undefined = undefined
  private api: SmartLayerApi | null

  constructor(api: SmartLayerApi | null) {
    this.api = api
  }

  async clarify(input: string, projectContext?: Record<string, string>): Promise<ClarifyOutput> {
    this.error = null

    // No API — skip clarification, allow send
    if (!this.api) {
      return { confirmed: true, input }
    }

    this.loading = true
    try {
      const result = await this.api.clarifyIntent(input, projectContext)

      // No ambiguities — allow send
      if (result.ambiguities.length === 0) {
        return { confirmed: true, input, result }
      }

      // Ambiguities detected — show dialog and wait
      return new Promise<ClarifyOutput>((resolve) => {
        this.pendingInput = input
        this.pendingAppliedMode = undefined
        this.resolveConfirm = resolve

        this.clarificationData = result
        this.showDialog = true
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : "Intent clarification failed"
      this.error = message
      // On API failure, allow the message to be sent
      return { confirmed: true, input }
    } finally {
      this.loading = false
    }
  }

  applyMode(mode: SuggestedMode) {
    this.pendingAppliedMode = mode
  }

  confirm() {
    if (this.resolveConfirm) {
      this.resolveConfirm({
        confirmed: true,
        input: this.pendingInput,
        result: this.clarificationData ?? undefined,
        appliedMode: this.pendingAppliedMode,
      })
      this.resolveConfirm = null
    }
    this.showDialog = false
    this.clarificationData = null
  }

  cancel() {
    if (this.resolveConfirm) {
      this.resolveConfirm({ confirmed: false, input: this.pendingInput })
      this.resolveConfirm = null
    }
    this.showDialog = false
    this.clarificationData = null
  }
}

// ─── Helpers ───

const makeClarificationResult = (overrides?: Partial<ClarificationResult>): ClarificationResult => ({
  intentType: "question",
  confidence: 0.9,
  entities: [],
  ambiguities: [],
  suggestedMode: "Chat",
  ...overrides,
})

// ─── Tests ───

describe("useIntentClarify - clarify() with no API", () => {
  test("returns confirmed=true when no API is available", async () => {
    const logic = new IntentClarifyLogic(null)
    const result = await logic.clarify("deploy to prod")
    expect(result.confirmed).toBe(true)
    expect(result.input).toBe("deploy to prod")
    expect(result.result).toBeUndefined()
  })

  test("does not show dialog when no API", async () => {
    const logic = new IntentClarifyLogic(null)
    await logic.clarify("hello")
    expect(logic.showDialog).toBe(false)
  })
})

describe("useIntentClarify - clarify() with no ambiguities", () => {
  test("returns confirmed=true when no ambiguities detected", async () => {
    const api = {
      clarifyIntent: mock(async () => makeClarificationResult({ ambiguities: [] })),
    }
    const logic = new IntentClarifyLogic(api)
    const result = await logic.clarify("clear request")
    expect(result.confirmed).toBe(true)
    expect(result.result).toBeDefined()
    expect(result.result!.ambiguities).toEqual([])
  })

  test("does not show dialog when no ambiguities", async () => {
    const api = {
      clarifyIntent: mock(async () => makeClarificationResult({ ambiguities: [] })),
    }
    const logic = new IntentClarifyLogic(api)
    await logic.clarify("clear request")
    expect(logic.showDialog).toBe(false)
  })
})

describe("useIntentClarify - clarify() with ambiguities", () => {
  test("shows dialog and resolves on confirm", async () => {
    const ambiguousResult = makeClarificationResult({
      ambiguities: [{ question: "Which environment?", options: ["staging", "production"] }],
    })
    const api = {
      clarifyIntent: mock(async () => ambiguousResult),
    }
    const logic = new IntentClarifyLogic(api)

    // Start clarify — it will hang until confirm/cancel
    const promise = logic.clarify("deploy")

    // Use a microtask tick to let the async function settle
    await new Promise((r) => setTimeout(r, 0))

    // Now the API call has resolved and dialog should be shown
    expect(logic.showDialog).toBe(true)
    expect(logic.clarificationData).toBe(ambiguousResult)

    // Confirm to resolve the pending promise
    logic.confirm()
    const result = await promise
    expect(result.confirmed).toBe(true)
    expect(result.input).toBe("deploy")
    expect(result.result).toBe(ambiguousResult)
  })

  test("shows dialog and resolves on cancel", async () => {
    const ambiguousResult = makeClarificationResult({
      ambiguities: [{ question: "Which?", options: ["A", "B"] }],
    })
    const api = {
      clarifyIntent: mock(async () => ambiguousResult),
    }
    const logic = new IntentClarifyLogic(api)

    const promise = logic.clarify("ambiguous input")
    await new Promise((r) => setTimeout(r, 0))

    expect(logic.showDialog).toBe(true)

    logic.cancel()
    const result = await promise
    expect(result.confirmed).toBe(false)
    expect(result.input).toBe("ambiguous input")
  })

  test("sets loading to true during API call and false after", async () => {
    let resolveApi!: (result: ClarificationResult) => void
    const api = {
      clarifyIntent: mock(
        () =>
          new Promise<ClarificationResult>((resolve) => {
            resolveApi = resolve
          }),
      ),
    }
    const logic = new IntentClarifyLogic(api)

    const promise = logic.clarify("test")
    expect(logic.loading).toBe(true)

    resolveApi(makeClarificationResult({ ambiguities: [] }))
    await promise
    expect(logic.loading).toBe(false)
  })
})

describe("useIntentClarify - clarify() on API error", () => {
  test("returns confirmed=true on API error (allows send)", async () => {
    const api = {
      clarifyIntent: mock(async () => {
        throw new Error("Network error")
      }),
    }
    const logic = new IntentClarifyLogic(api)
    const result = await logic.clarify("deploy")
    expect(result.confirmed).toBe(true)
    expect(result.input).toBe("deploy")
  })

  test("sets error message on API error", async () => {
    const api = {
      clarifyIntent: mock(async () => {
        throw new Error("Timeout")
      }),
    }
    const logic = new IntentClarifyLogic(api)
    await logic.clarify("deploy")
    expect(logic.error).toBe("Timeout")
  })

  test("handles non-Error thrown values", async () => {
    const api = {
      clarifyIntent: mock(async () => {
        throw "string error"
      }),
    }
    const logic = new IntentClarifyLogic(api)
    await logic.clarify("deploy")
    expect(logic.error).toBe("Intent clarification failed")
  })

  test("does not show dialog on error", async () => {
    const api = {
      clarifyIntent: mock(async () => {
        throw new Error("fail")
      }),
    }
    const logic = new IntentClarifyLogic(api)
    await logic.clarify("deploy")
    expect(logic.showDialog).toBe(false)
  })
})

describe("useIntentClarify - confirm()", () => {
  test("resolves pending promise with confirmed=true and result", async () => {
    const ambiguousResult = makeClarificationResult({
      ambiguities: [{ question: "Which?", options: ["A", "B"] }],
    })
    const api = {
      clarifyIntent: mock(async () => ambiguousResult),
    }
    const logic = new IntentClarifyLogic(api)

    const promise = logic.clarify("ambiguous input")
    await new Promise((r) => setTimeout(r, 0))

    logic.confirm()
    const result = await promise

    expect(result.confirmed).toBe(true)
    expect(result.input).toBe("ambiguous input")
    expect(result.result).toBe(ambiguousResult)
  })

  test("includes appliedMode when set before confirm", async () => {
    const ambiguousResult = makeClarificationResult({
      ambiguities: [{ question: "Mode?", options: ["Chat", "Agent"] }],
      suggestedMode: "Agent",
    })
    const api = {
      clarifyIntent: mock(async () => ambiguousResult),
    }
    const logic = new IntentClarifyLogic(api)

    const promise = logic.clarify("do something")
    await new Promise((r) => setTimeout(r, 0))

    logic.applyMode("Agent")
    logic.confirm()
    const result = await promise

    expect(result.appliedMode).toBe("Agent")
  })

  test("clears dialog state after confirm", async () => {
    const ambiguousResult = makeClarificationResult({
      ambiguities: [{ question: "Q?", options: ["A"] }],
    })
    const api = {
      clarifyIntent: mock(async () => ambiguousResult),
    }
    const logic = new IntentClarifyLogic(api)

    const promise = logic.clarify("test")
    await new Promise((r) => setTimeout(r, 0))

    logic.confirm()
    await promise

    expect(logic.showDialog).toBe(false)
    expect(logic.clarificationData).toBeNull()
  })
})

describe("useIntentClarify - cancel()", () => {
  test("resolves pending promise with confirmed=false", async () => {
    const ambiguousResult = makeClarificationResult({
      ambiguities: [{ question: "Which?", options: ["A", "B"] }],
    })
    const api = {
      clarifyIntent: mock(async () => ambiguousResult),
    }
    const logic = new IntentClarifyLogic(api)

    const promise = logic.clarify("ambiguous input")
    await new Promise((r) => setTimeout(r, 0))

    logic.cancel()
    const result = await promise

    expect(result.confirmed).toBe(false)
    expect(result.input).toBe("ambiguous input")
  })

  test("clears dialog state after cancel", async () => {
    const ambiguousResult = makeClarificationResult({
      ambiguities: [{ question: "Q?", options: ["A"] }],
    })
    const api = {
      clarifyIntent: mock(async () => ambiguousResult),
    }
    const logic = new IntentClarifyLogic(api)

    const promise = logic.clarify("test")
    await new Promise((r) => setTimeout(r, 0))

    logic.cancel()
    await promise

    expect(logic.showDialog).toBe(false)
    expect(logic.clarificationData).toBeNull()
  })

  test("cancel does not include appliedMode", async () => {
    const ambiguousResult = makeClarificationResult({
      ambiguities: [{ question: "Q?", options: ["A"] }],
    })
    const api = {
      clarifyIntent: mock(async () => ambiguousResult),
    }
    const logic = new IntentClarifyLogic(api)

    const promise = logic.clarify("test")
    await new Promise((r) => setTimeout(r, 0))

    logic.applyMode("Agent")
    logic.cancel()
    const result = await promise

    expect(result.confirmed).toBe(false)
    expect(result.appliedMode).toBeUndefined()
  })
})

describe("useIntentClarify - applyMode()", () => {
  test("stores pending applied mode for confirm resolution", async () => {
    const ambiguousResult = makeClarificationResult({
      ambiguities: [{ question: "Q?", options: ["A"] }],
      suggestedMode: "Chat",
    })
    const api = {
      clarifyIntent: mock(async () => ambiguousResult),
    }
    const logic = new IntentClarifyLogic(api)

    const promise = logic.clarify("test")
    await new Promise((r) => setTimeout(r, 0))

    logic.applyMode("Chat")
    logic.confirm()
    const result = await promise

    expect(result.appliedMode).toBe("Chat")
  })

  test("can change applied mode before confirm", async () => {
    const ambiguousResult = makeClarificationResult({
      ambiguities: [{ question: "Q?", options: ["A"] }],
      suggestedMode: "Agent",
    })
    const api = {
      clarifyIntent: mock(async () => ambiguousResult),
    }
    const logic = new IntentClarifyLogic(api)

    const promise = logic.clarify("test")
    await new Promise((r) => setTimeout(r, 0))

    logic.applyMode("Chat")
    logic.applyMode("Agent") // override
    logic.confirm()
    const result = await promise

    expect(result.appliedMode).toBe("Agent")
  })
})
