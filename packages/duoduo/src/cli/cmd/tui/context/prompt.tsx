import { createSimpleContext } from "./helper"
import type { PromptRef } from "../component/prompt"

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: usePromptRef, provider: PromptRefProvider } = createSimpleContext({
  name: "PromptRef",
  init: () => {
    let current: PromptRef | undefined

    return {
      get current() {
        return current
      },
      set(ref: PromptRef | undefined) {
        current = ref
      },
    }
  },
})
