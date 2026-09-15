# @duoduo-ai/duoduo

The core package of DuoDuoCode — a provider-agnostic AI coding agent that runs
in the terminal. It hosts the agent loop, the tool system, session management,
and the LSP / memory / snapshot integrations.

> See the [repository README](../../README.md) for the project overview,
> installation and configuration docs.

## Development

```bash
bun install          # from the repository root
bun run dev          # run the CLI from the repository root
bun run typecheck    # typecheck this package
bun run test:ci      # offline unit test suite
```

The CLI binary is compiled with `bun run script/build.ts --single`
(see [CONTRIBUTING.md](../../CONTRIBUTING.md) for the full guide).
