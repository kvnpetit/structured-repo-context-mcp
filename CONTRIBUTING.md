# Contributing

SRC uses Bun for dependency installation and repository checks. Node.js 22 or
newer is required at runtime, and CI currently runs Bun 1.4.2.

## Setup

```bash
git clone https://github.com/kvnpetit/structured-repo-context-mcp.git
cd structured-repo-context-mcp
bun install --frozen-lockfile
```

## Checks

Run the focused checks while developing:

```bash
bun run check
bun run test
```

Before opening a release or a change that affects packaging, also run:

```bash
bun run test:coverage
bun run build
bun run pack:verify
bun run conformance:local
```

`check` runs TypeScript, Biome, formatting, and the MCP/CLI contract
verification. Keep generated output such as `dist/`, `coverage/`, and
`.tsbuildinfo` out of commits.

## Changes and pull requests

Use a clear, imperative commit subject and keep changes focused. Update the
relevant documentation and include tests for behavior changes. The pull
request template lists the checks reviewers expect.

Before a release, ask the AI to review the changes since the last tag and
update the next version section in `CHANGELOG.md` manually. Check the result
for user-facing accuracy, links, and secrets before committing it. Releases
are prepared on `dev` and merged to `main` with a commit containing
`[release]`; the release workflow validates that changelog entry, publishes
the package, and creates the GitHub release after CI succeeds.
