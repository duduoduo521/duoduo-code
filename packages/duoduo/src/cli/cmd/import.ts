import type { Argv } from "yargs"
import type { Session as SDKSession, Message, Part } from "@duoduo-ai/sdk/v2"
import { Session } from "../../session"
import { MessageV2 } from "../../session/message-v2"
import { cmd } from "./cmd"
import { bootstrap } from "../bootstrap"
import { Database } from "../../storage"
import { SessionTable, MessageTable, PartTable } from "../../session/session.sql"
import { Instance } from "../../project/instance"
import { EOL } from "os"
import { Filesystem } from "../../util"

export const ImportCommand = cmd({
  command: "import <file>",
  describe: "import session data from JSON file",
  builder: (yargs: Argv) => {
    return yargs.positional("file", {
      describe: "path to JSON file",
      type: "string",
      demandOption: true,
    })
  },
  handler: async (args) => {
    await bootstrap(process.cwd(), async () => {
      let exportData:
        | {
            info: SDKSession
            messages: Array<{
              info: Message
              parts: Part[]
            }>
          }
        | undefined

      exportData = await Filesystem.readJson<NonNullable<typeof exportData>>(args.file).catch(() => undefined)
      if (!exportData) {
        process.stderr.write(`File not found or invalid: ${args.file}${EOL}`)
        process.exitCode = 1
        return
      }

      const info = Session.Info.parse({
        ...exportData.info,
        projectID: Instance.project.id,
      })
      const row = Session.toRow(info)
      Database.useProject((db) =>
        db
          .insert(SessionTable)
          .values(row)
          .onConflictDoUpdate({ target: SessionTable.id, set: { project_id: row.project_id } })
          .run(),
      )

      for (const msg of exportData.messages) {
        const msgInfo = MessageV2.Info.zod.parse(msg.info)
        const { id, sessionID: _, ...msgData } = msgInfo
        Database.useProject((db) =>
          db
            .insert(MessageTable)
            .values({
              id,
              session_id: row.id,
              time_created: msgInfo.time?.created ?? Date.now(),
              data: msgData,
            })
            .onConflictDoNothing()
            .run(),
        )

        for (const part of msg.parts) {
          const partInfo = MessageV2.Part.zod.parse(part)
          const { id: partId, sessionID: _s, messageID, ...partData } = partInfo
          Database.useProject((db) =>
            db
              .insert(PartTable)
              .values({
                id: partId,
                message_id: messageID,
                session_id: row.id,
                data: partData,
              })
              .onConflictDoNothing()
              .run(),
          )
        }
      }

      process.stdout.write(`Imported session: ${exportData.info.id}`)
      process.stdout.write(EOL)
    })
  },
})
