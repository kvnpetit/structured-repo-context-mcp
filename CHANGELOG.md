# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Entries are curated for users; the commit history remains the detailed
implementation record. The historical `v1.0.0` commit is retained for
completeness, while `1.0.1` was the first version published to npm.

## [Unreleased]

### Fixed

- Historical changelog links now resolve to the public GitHub commit or release
  that represents each version, including the Git-only `v1.0.0` baseline.

## [2.0.0] - 2026-09-11

This release consolidates local code intelligence, bounded MCP and CLI
contracts, project context, durable tasks, secure HTTP transport, quality gates,
and cross-platform runtime support.

### Added

- Local code intelligence foundations for symbols, definitions, references,
  call graphs, and dependency relationships
  ([2f0287e](https://github.com/kvnpetit/structured-repo-context-mcp/commit/2f0287ef61fe2dcbb047a8ecb0e257c71058aa52)).
- Repository context and memory capabilities covering project onboarding,
  repository maps, artifacts, catalog, memory, task context, diagnostics,
  observability, snapshots, maintenance, SCIP import, and semantic navigation
  ([135684a](https://github.com/kvnpetit/structured-repo-context-mcp/commit/135684a80208192fb8edacd2514bb226d527e9ca)).
- HTTP transport, tool profiles and allow-lists, resource templates, prompts,
  durable task handles, pagination, redaction, provenance, freshness, and
  confidence signals.
- A native retrieval quality benchmark with deterministic fixtures and a CI
  release gate
  ([a135642](https://github.com/kvnpetit/structured-repo-context-mcp/commit/a13564283729e8b2271635a43dec5c8284642a1f)).

### Changed

- **Breaking:** MCP runtime and Node packages now use the v2 API, with bounded
  `schema_version: 1` result envelopes shared by MCP and CLI adapters
  ([611b46e](https://github.com/kvnpetit/structured-repo-context-mcp/commit/611b46e7e214fe6bd52e725fc867f4e28541eac9)).
- **Breaking:** the package root is side-effect-free; start the executable with
  `src-mcp serve`
  ([a0934b8](https://github.com/kvnpetit/structured-repo-context-mcp/commit/a0934b8e47f306b3f677324eee56ddcd57b644cd)).
- Durable task persistence and concurrency handling are hardened
  ([ead583f](https://github.com/kvnpetit/structured-repo-context-mcp/commit/ead583fb4b5e27f163dcfe6c13078ab21b4aaf17)).
- Indexed retrieval and watcher lifecycle behavior are hardened
  ([b7e9b31](https://github.com/kvnpetit/structured-repo-context-mcp/commit/b7e9b31a744543fe8c9e00765633077c13ea6402)).
- CLI and MCP feature execution, validation, output formatting, and lifecycle
  handling now share one execution surface
  ([a0934b](https://github.com/kvnpetit/structured-repo-context-mcp/commit/a0934b8e47f306b3f677324eee56ddcd57b644cd)).
- `update_index` processes files in parallel with configurable concurrency
  ([1c0e54c](https://github.com/kvnpetit/structured-repo-context-mcp/commit/1c0e54ce2378f36d6dd9b23150f15625ac9fb9db)).
- Quality checks use Bun and Biome with an exact, isolated linker and peer
  dependency policy
  ([21ec74b](https://github.com/kvnpetit/structured-repo-context-mcp/commit/21ec74bfec8c87db9f6a582590370069c9dfa5b4)),
  ([50445f](https://github.com/kvnpetit/structured-repo-context-mcp/commit/50445f86c3c948059c7a88a029aea0af6a59ea3a)).
- Runtime and development dependencies are aligned with the supported Bun and
  Node versions; production builds set `NODE_ENV=production`
  ([e2dd865](https://github.com/kvnpetit/structured-repo-context-mcp/commit/e2dd8652d3016a1c80b576749944a07572beda45)),
  ([026282d](https://github.com/kvnpetit/structured-repo-context-mcp/commit/026282d97812d8d497a083e5db0667505dd4c9b4)),
  ([9607ebd](https://github.com/kvnpetit/structured-repo-context-mcp/commit/9607ebd87bd66c9d1f099b16ad8d2ad9c7f20b1c)).
- Release, contract, conformance, mutation, package, and deterministic
  benchmark gates are part of the documented release process
  ([21b905f](https://github.com/kvnpetit/structured-repo-context-mcp/commit/21b905f53859b4f00b88c56787d741f2e1802ee8)),
  ([4756b26](https://github.com/kvnpetit/structured-repo-context-mcp/commit/4756b2609b443aba167e3535d39ae05837c002ef)).
- Architecture, Bun workflow, release process, remote HTTP prerequisites, and
  security boundaries are documented
  ([a9bfbae](https://github.com/kvnpetit/structured-repo-context-mcp/commit/a9bfbae49f2bfdca4eec02ec0e711e7178727343)),
  ([35af6e3](https://github.com/kvnpetit/structured-repo-context-mcp/commit/35af6e3ddcb069ce8f969c6b34326f3b52160d47)),
  ([0f2b073](https://github.com/kvnpetit/structured-repo-context-mcp/commit/0f2b0731c3449201509d7547562abacca771ca7c)).
- Test infrastructure is compatible with Bun and Vitest, including stable
  cross-platform and language-server fixtures
  ([7197612](https://github.com/kvnpetit/structured-repo-context-mcp/commit/71976126bf37fc4f68e6b4c2b08dab4d3f291f42)),
  ([965c535](https://github.com/kvnpetit/structured-repo-context-mcp/commit/965c535ec3b020cb6e30332b59b342484ceb3e50)),
  ([ec8fcaa](https://github.com/kvnpetit/structured-repo-context-mcp/commit/ec8fcaafc5be4ed53408850f2a2924ab215468ca)).

### Removed

- Generated changelog dependencies were removed in favor of manually reviewed,
  workflow-validated release notes
  ([e52e668](https://github.com/kvnpetit/structured-repo-context-mcp/commit/e52e6682afa406dd93cbf22a6f4507fa7d4eca8d)),
  ([d223989](https://github.com/kvnpetit/structured-repo-context-mcp/commit/d2239891df3b2dd54957c2f5ccd09a87e2e7329b)).
- Obsolete Dependabot configuration was removed after dependency ownership was
  consolidated
  ([466ffd8](https://github.com/kvnpetit/structured-repo-context-mcp/commit/466ffd8bcb56378a5b43d74d7c2e59f77d684f56)).

### Fixed

- Shared file collection and ignore-filter utilities apply consistent indexing
  exclusions and safety budgets
  ([f8a32d5](https://github.com/kvnpetit/structured-repo-context-mcp/commit/f8a32d5186eaf28934e8d3fa77135a6ec2225f4b)).
- Watcher-triggered indexing preserves enrichment options, logical project
  paths, canonical paths, and cross-platform behavior
  ([be2cc42](https://github.com/kvnpetit/structured-repo-context-mcp/commit/be2cc42d4a8eb35af25f7f1534b4687d1570426e)),
  ([e7fb89f](https://github.com/kvnpetit/structured-repo-context-mcp/commit/e7fb89f3bed3046d099f81051ce9c2110ae5c0ab)),
  ([c337c98](https://github.com/kvnpetit/structured-repo-context-mcp/commit/c337c9872de68c698cdc042ad61dec50a206f4e8)).
- Indexed-file deletion validates absolute paths, and embedding errors are
  surfaced with appropriate log levels
  ([bc2fe91](https://github.com/kvnpetit/structured-repo-context-mcp/commit/bc2fe912b2552c777f08b7c22029edd20226c614)),
  ([e766750](https://github.com/kvnpetit/structured-repo-context-mcp/commit/e7667504f14734ab5169b61c0f044a33e81734b9)).
- Parser casts and redundant AST-root traversals were removed
  ([3954b74](https://github.com/kvnpetit/structured-repo-context-mcp/commit/3954b74967c326a25b31892daa5f1aa3fe179867)),
  ([9638d8d](https://github.com/kvnpetit/structured-repo-context-mcp/commit/9638d8d527bdc96b2f06458bdc352c819d632468)).
- Inspection responses preserve UTF-8 source boundaries
  ([0a9ebb3](https://github.com/kvnpetit/structured-repo-context-mcp/commit/0a9ebb349db4745d670a2de2fd9c6706e7216f3e)).
- MCP resource and tool registration uses the current supported API
  ([611b46e](https://github.com/kvnpetit/structured-repo-context-mcp/commit/611b46e7e214fe6bd52e725fc867f4e28541eac9)).

### Security

- Workspace containment, local tool launch restrictions, response bounds, HTTP
  host/origin/bearer/body/concurrency/timeout controls, and untrusted-source
  instruction handling are hardened
  ([3e9299d](https://github.com/kvnpetit/structured-repo-context-mcp/commit/3e9299d81c35ae25a8b9f053a4c83b5e4cac4ef9)).
- LanceDB, hash-cache, callgraph-cache, and CodeQL state directories remain
  inside the selected project; existing symlinks and junctions are rejected and
  native state paths are revalidated
  ([a5e0b0e](https://github.com/kvnpetit/structured-repo-context-mcp/commit/a5e0b0efbe89ea8f3e986c3e764cdcd737477733)),
  ([2172a40](https://github.com/kvnpetit/structured-repo-context-mcp/commit/2172a40344635158e6b3473664d9375444c1d4fd)).
- Source reads use checked descriptors with no-follow support where available,
  post-open link checks, and size limits.
- Recursive file collection is bounded by file count, aggregate bytes, directory
  depth, and cancellation; custom query input is bounded before Tree-sitter
  execution and native match materialization.
- Non-loopback HTTP requires explicit trusted TLS-proxy opt-in while retaining
  bearer authentication, configured roots, and host allow-lists.
- Local Git and SCIP helpers are isolated from credentials, implicit network
  access, and editor prompts; privileged release actions and checkout
  credentials are pinned and restricted
  ([1147dce](https://github.com/kvnpetit/structured-repo-context-mcp/commit/1147dcedca11f33fbfad534f7ef6cd651cc7c054)),
  ([f0c8b03](https://github.com/kvnpetit/structured-repo-context-mcp/commit/f0c8b030adebaff0396b7c89c0d645f436e9e5f0)).
- The patched `sharp` dependency and Apache Arrow/LanceDB peer range are pinned
  ([fe5cc09](https://github.com/kvnpetit/structured-repo-context-mcp/commit/fe5cc098f3536fd318f3e49227142a56cf645c87)),
  ([1d6ec1c](https://github.com/kvnpetit/structured-repo-context-mcp/commit/1d6ec1c25231f017a577cb5250a27023abb5d19b)).

## [1.0.3] - 2026-01-20

### Removed

- The obsolete LLM reranker implementation and its public configuration were
  removed after search ranking was consolidated.

### Fixed

- Watcher auto-indexing now triggers on the first run
  ([734e2b4](https://github.com/kvnpetit/structured-repo-context-mcp/commit/734e2b46a747efa98472acd4c4ebd0ca3db5b246)).

## [1.0.2] - 2026-01-20

### Changed

- The production bundle migrated from `tsc` to `tsdown`, and the GitHub Actions
  workflow and Trusted Publishing setup were improved.

### Fixed

- Logger output uses stderr so MCP protocol messages remain valid
  ([439429d](https://github.com/kvnpetit/structured-repo-context-mcp/commit/439429d47723fea5cb107d0f4b13507d44dcb8b6)).

## [1.0.1] - 2026-01-20

### Added

- First npm registry package published as `src-mcp@1.0.1`; the preceding
  `v1.0.0` tag remains a Git-only release.

## [1.0.0] - 2026-01-20

This was the initial Git-only release; it was not published to npm.

### Added

- Tree-sitter WASM parsers and SCM queries
  ([6bc7514](https://github.com/kvnpetit/structured-repo-context-mcp/commit/6bc7514e034fbfc54c8c5f8a4c66e58c0e7939f7)).
- Persistent call-graph caching with hash-based invalidation
  ([5a5d5a3](https://github.com/kvnpetit/structured-repo-context-mcp/commit/5a5d5a396f6cde8de6c24ddc9c88e5eca84d38b7)).
- CLI watcher startup, parsing and symbol extraction, embeddings with Ollama
  and LanceDB, cross-file import context, semantic chunking, LLM enrichment,
  and TypeScript path-alias resolution
  ([6b213f9](https://github.com/kvnpetit/structured-repo-context-mcp/commit/6b213f97f1f21face7506aff4c181ffffb1c3f15)),
  ([023f1ac](https://github.com/kvnpetit/structured-repo-context-mcp/commit/023f1ace80f265a32c9ef67c017e35f07050f956)),
  ([c40d4f7](https://github.com/kvnpetit/structured-repo-context-mcp/commit/c40d4f7efe47741c14e59a09ae7627a1e96681b5)),
  ([c3edf0d](https://github.com/kvnpetit/structured-repo-context-mcp/commit/c3edf0ddbffe232a48ebe879a382772be877837b)),
  ([03de1dd](https://github.com/kvnpetit/structured-repo-context-mcp/commit/03de1dd685fc13161334adf5c1c2510ce7be082c)),
  ([d7d0277](https://github.com/kvnpetit/structured-repo-context-mcp/commit/d7d0277840bb3e2cbd6f6537343f33871af22a65)),
  ([855caec](https://github.com/kvnpetit/structured-repo-context-mcp/commit/855caece66944da884c7777118b2a9fee9031fb2)).
- Code analysis, call-graph, semantic search, shared feature utilities, and
  update-index MCP tools
  ([c027dff](https://github.com/kvnpetit/structured-repo-context-mcp/commit/c027dff5d5d401524a87c48dc586e8a6c749b197)),
  ([efc620b](https://github.com/kvnpetit/structured-repo-context-mcp/commit/efc620b5ad739a30dfc9b4bab434d2eb3d1ac055)),
  ([b51309b](https://github.com/kvnpetit/structured-repo-context-mcp/commit/b51309b480732cea3c715d6a7c1a3eac1b536cf6)),
  ([6229b10](https://github.com/kvnpetit/structured-repo-context-mcp/commit/6229b10bd0a94d895daa277eb501afdaf91e2c19)),
  ([537c6c6](https://github.com/kvnpetit/structured-repo-context-mcp/commit/537c6c6ac8eff06c10657eaa16ce9b421dcdfb29)).
- Hybrid search, BM25/RRF fusion, call context, and configurable indexing
  parallelism were introduced
  ([25e08e5](https://github.com/kvnpetit/structured-repo-context-mcp/commit/25e08e5589fc47224badd7404156685bed7a6e2f)),
  ([8d2aa9b](https://github.com/kvnpetit/structured-repo-context-mcp/commit/8d2aa9b62aa40ec510384a6f28603c86e1a482b1)),
  ([f7532d8](https://github.com/kvnpetit/structured-repo-context-mcp/commit/f7532d80ef5459f244b2e78e6bead479b1b0c3cd)).

### Fixed

- Unwritable call-graph caches, async CLI promise rejections, CRLF line endings,
  and CI Trusted Publishing setup were handled
  ([986e9eb](https://github.com/kvnpetit/structured-repo-context-mcp/commit/986e9eb2b4cd3d0f3e2fe79b89e9ac62b73891c5)),
  ([1a978f8](https://github.com/kvnpetit/structured-repo-context-mcp/commit/1a978f83790cb8e4a17b9d8f468738d3b01655d4)),
  ([4dc9468](https://github.com/kvnpetit/structured-repo-context-mcp/commit/4dc94683ac3309ec572067f93f6afbcf3fa32855)),
  ([f9c4ce9](https://github.com/kvnpetit/structured-repo-context-mcp/commit/f9c4ce92c98693e4d092ec0416608f5cfe2d4a74)).
- Lint and type-safety issues in the test suite were resolved
  ([276bc86](https://github.com/kvnpetit/structured-repo-context-mcp/commit/276bc86035ed541823879d21a29902d073ffba98)),
  ([161c4dd](https://github.com/kvnpetit/structured-repo-context-mcp/commit/161c4ddb25409c2409cc55209c3b444420ad28a6)).

[Unreleased]: https://github.com/kvnpetit/structured-repo-context-mcp/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/kvnpetit/structured-repo-context-mcp/compare/v1.0.3...v2.0.0
[1.0.3]: https://github.com/kvnpetit/structured-repo-context-mcp/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/kvnpetit/structured-repo-context-mcp/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/kvnpetit/structured-repo-context-mcp/releases/tag/v1.0.1
[1.0.0]: https://github.com/kvnpetit/structured-repo-context-mcp/commit/bfb09e2a546913a434bc1294aff19405511360d9
