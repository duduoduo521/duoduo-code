import { TuiConfig } from "@/cli/cmd/tui/config/tui"
import { createSimpleContext } from "./helper"

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useTuiConfig, provider: TuiConfigProvider } = createSimpleContext({
  name: "TuiConfig",
  init: (props: { config: TuiConfig.Info }) => {
    return props.config
  },
})
