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

Use a [Conventional Commit](https://www.conventionalcommits.org/) subject in
the `type(scope): summary` form, for example
`feat(search): add symbol filtering` or `fix(cli): report invalid arguments`.
Keep each commit focused on one logical intent. Production code and its tests
belong together when they describe the same behavior; unrelated fixes,
documentation, dependency, and release changes should be separate commits.
Mark breaking changes with `!` and a `BREAKING CHANGE:` footer when a migration
needs more detail. The pull request template lists the checks reviewers expect.

Maintain `CHANGELOG.md` as a curated [Keep a Changelog](https://keepachangelog.com/en/2.0.0/)
record. Keep `## [Unreleased]` first, use only `Added`, `Changed`,
`Deprecated`, `Removed`, `Fixed`, and `Security`, and omit merge or housekeeping
noise. Before a release, ask the AI to review user-visible changes since the
last tag, rename `Unreleased` to the package version with an ISO date, add a
fresh empty `Unreleased` section, and run `bun run changelog:check`.

Releases are prepared on `dev` and merged to `main` with a commit containing
`[release]`; the release workflow validates the versioned changelog entry,
publishes the package, and creates the GitHub release after CI succeeds.
