import { EOL } from "os"
import { Project } from "../../../project"
import { Log } from "../../../util"
import { cmd } from "../cmd"

export const ScrapCommand = cmd({
  command: "scrap",
  describe: "list all known projects",
  builder: (yargs) => yargs,
  async handler() {
    const timer = Log.Default.time("scrap")
    // oxlint-disable-next-line await-thenable -- oxlint span misattribution; await target is a valid thenable
    const list = await Project.list()
    process.stdout.write(JSON.stringify(list, null, 2) + EOL)
    timer.stop()
  },
})
