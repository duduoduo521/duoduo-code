import type { ValidComponent } from "solid-js"
import { createSimpleContext } from "./helper"

const ctx = createSimpleContext<ValidComponent, { component: ValidComponent }>({
  name: "FileComponent",
  init: (props) => props.component,
})

export const FileComponentProvider = ctx.provider
// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const useFileComponent = ctx.use
