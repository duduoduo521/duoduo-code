import { UI } from "../ui"
import { cmd } from "./cmd"
import { AppRuntime } from "@/effect/app-runtime"
import { Git } from "@/git"
import { Instance } from "@/project/instance"
import { Process } from "@/util"

export const PrCommand = cmd({
  command: "pr <number>",
  describe: "fetch and checkout a GitHub PR branch, then run duoduo",
  builder: (yargs) =>
    yargs.positional("number", {
      type: "number",
      describe: "PR number to checkout",
      demandOption: true,
    }),
  async handler(args) {
    await Instance.provide({
      directory: process.cwd(),
      async fn() {
        try {
        const project = Instance.project
        if (project.vcs !== "git") {
          UI.error("Could not find git repository. Please run this command from a git repository.")
          process.exit(1)
        }

        const prNumber = args.number
        const localBranchName = `pr/${prNumber}`
        UI.println(`Fetching and checking out PR #${prNumber}...`)

        // Use gh pr checkout with custom branch name
        const result = await Process.run(
          ["gh", "pr", "checkout", `${prNumber}`, "--branch", localBranchName, "--force"],
          {
            nothrow: true,
          },
        )

        if (result.code !== 0) {
          UI.error(`Failed to checkout PR #${prNumber}. Make sure you have gh CLI installed and authenticated.`)
          process.exit(1)
        }

        // Fetch PR info for fork handling and session link detection
        const prInfoResult = await Process.text(
          [
            "gh",
            "pr",
            "view",
            `${prNumber}`,
            "--json",
            "headRepository,headRepositoryOwner,isCrossRepository,headRefName,body",
          ],
          { nothrow: true },
        )

        let sessionId: string | undefined

        if (prInfoResult.code === 0) {
          const prInfoText = prInfoResult.text
          if (prInfoText.trim()) {
            let prInfo: any
            try {
              prInfo = JSON.parse(prInfoText)
            } catch {
              // gh CLI 返回非 JSON 输出，跳过 fork 处理
            }

            // Handle fork PRs
            if (prInfo && prInfo.isCrossRepository && prInfo.headRepository && prInfo.headRepositoryOwner) {
              const forkOwner = prInfo.headRepositoryOwner.login
              const forkName = prInfo.headRepository.name
              const remoteName = forkOwner

              // Check if remote already exists
              const remotes = await AppRuntime.runPromise(
                Git.Service.use((git) => git.run(["remote"], { cwd: Instance.worktree })),
              ).then((x) => x.text().trim())
              if (!remotes.split("\n").includes(remoteName)) {
                await AppRuntime.runPromise(
                  Git.Service.use((git) =>
                    git.run(["remote", "add", remoteName, `https://github.com/${forkOwner}/${forkName}.git`], {
                      cwd: Instance.worktree,
                    }),
                  ),
                )
                UI.println(`Added fork remote: ${remoteName}`)
              }

              // Set upstream to the fork so pushes go there
              const headRefName = prInfo.headRefName
              await AppRuntime.runPromise(
                Git.Service.use((git) =>
                  git.run(["branch", `--set-upstream-to=${remoteName}/${headRefName}`, localBranchName], {
                    cwd: Instance.worktree,
                  }),
                ),
              )
            }
          }
        }

        UI.println(`Successfully checked out PR #${prNumber} as branch '${localBranchName}'`)
        UI.println()
        UI.println("Starting duoduo...")
        UI.println()

        const duoduoArgs = sessionId ? ["-s", sessionId] : []
        const duoduoProcess = Process.spawn(["duoduocode", ...duoduoArgs], {
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
          cwd: process.cwd(),
        })
        const code = await duoduoProcess.exited
        if (code !== 0) throw new Error(`duoduo exited with code ${code}`)
        } finally {
          await Instance.dispose().catch(() => {})
        }
      },
    })
  },
})
