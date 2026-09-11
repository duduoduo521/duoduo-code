import { createSimpleContext } from "./helper"

export interface Args {
  model?: string
  agent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  fork?: boolean
}

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => props,
})
