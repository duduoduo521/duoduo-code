import { writeFileSync } from "node:fs"
import { join } from "node:path"

// Lightweight schema contract snapshot for Rust/TS MessageV2 compatibility.
// Keep this in sync with packages/duoduo/src/session/message-v2.ts. The Rust
// tests read these snapshots and verify discriminators / required fields / tag
// values so schema drift fails CI.

const messageInfo = {
  messageInfo: {
    roles: ["user", "assistant"],
    userRequired: ["id", "sessionID", "role", "time", "agent", "model"],
    assistantRequired: [
      "id",
      "sessionID",
      "role",
      "time",
      "parentID",
      "modelID",
      "providerID",
      "mode",
      "agent",
      "path",
      "tokens",
    ],
    specialCaseFields: ["sessionID", "parentID", "modelID", "providerID"],
  },
}

const messagePart = {
  part: {
    types: [
      "text",
      "subtask",
      "reasoning",
      "file",
      "tool",
      "step-start",
      "step-finish",
      "snapshot",
      "patch",
      "agent",
      "retry",
      "compaction",
      "review",
    ],
    baseRequired: ["id", "sessionID", "messageID", "type"],
    toolStateStatuses: ["pending", "running", "completed", "error"],
    toolRequired: ["id", "sessionID", "messageID", "type", "callID", "tool", "state"],
  },
}

writeFileSync(join("schema", "message-info.json"), JSON.stringify(messageInfo, null, 2) + "\n")
writeFileSync(join("schema", "message-part.json"), JSON.stringify(messagePart, null, 2) + "\n")
