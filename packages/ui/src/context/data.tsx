import type { Message, Session, Part, SnapshotFileDiff, SessionStatus, ProviderListResponse } from "@duoduo-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import type { DiffResult } from "../diff-engine/compute"

type Data = {
  agent?: {
    name: string
    color?: string
  }[]
  provider?: ProviderListResponse
  session: Session[]
  session_status: {
    [sessionID: string]: SessionStatus
  }
  session_diff: {
    [sessionID: string]: SnapshotFileDiff[]
  }
  session_diff_preload?: {
    [sessionID: string]: DiffResult[]
  }
  message: {
    [sessionID: string]: Message[]
  }
  part: {
    [messageID: string]: Part[]
  }
}

export type NavigateToSessionFn = (sessionID: string) => void

export type SessionHrefFn = (sessionID: string) => string

// oxlint-disable-next-line unbound-method -- method does not reference this (closure-only / pre-bound)
export const { use: useData, provider: DataProvider } = createSimpleContext({
  name: "Data",
  init: (props: {
    data: Data
    directory: string
    onNavigateToSession?: NavigateToSessionFn
    onSessionHref?: SessionHrefFn
  }) => {
    return {
      get store() {
        return props.data
      },
      get directory() {
        return props.directory
      },
      navigateToSession: props.onNavigateToSession,
      sessionHref: props.onSessionHref,
    }
  },
})
