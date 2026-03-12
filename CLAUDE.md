# drive-vacuum : Claude Code Guidelines

## Toolchain

- **Runtime**: always use `bun` / `bunx` (never `npm`, `npx`, `yarn`, `pnpm`, or bare `node`)
- **Linting**: `bunx oxlint` (never `eslint`)
- **Formatting**: `bunx oxfmt` (never `prettier`)
- **Type checking**: `bunx tsgo --noEmit` (never `tsc`)

## Contribution rules

- Commit by **logical unit** (one concern per commit), never bulk-commit
- Clear imperative commit messages with conventional prefixes: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`
- Work on branches (`<type>/<short-description>`), not directly on `main`
- Never add AI co-authoring lines or mention AI tools in commits/PRs
