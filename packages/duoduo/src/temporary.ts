import yargs from "yargs"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { InstallationVersion } from "./installation/version"
import { hideBin } from "yargs/helpers"
import { Log } from "./node"

// oxlint-disable-next-line no-floating-promises -- intentional fire-and-forget (UI/SolidJS background work)
Log.init({
  print: false,
  retentionDays: Number(process.env.DUODUO_LOG_RETENTION_DAYS) || 7,
})

const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("duoduo")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .command(TuiThreadCommand)
  .parse()
