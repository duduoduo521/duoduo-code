import * as Agent from "./agent"
import { Permission } from "@/permission"

import PROMPT_REVIEW from "./prompt/review.txt"

// ---------------------------------------------------------------------------
// Review Agent Definition
// ---------------------------------------------------------------------------

export const ReviewAgent: Agent.Info = {
  name: "review",
  description: "Reviews code changes and generates inline comments with suggestions",
  mode: "subagent",
  native: true,
  options: {},
  permission: Permission.fromConfig({
    "*": "deny",
    code_comment: "allow",
    read: "allow",
    grep: "allow",
    glob: "allow",
    external_directory: {
      "*": "ask",
    },
  }),
  prompt: PROMPT_REVIEW,
}

export * as Review from "./review"
