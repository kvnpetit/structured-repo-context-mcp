# Changelog

All notable changes are recorded here in release order. The historical `v1.0.0`
tag is kept for completeness, but `1.0.1` is the first version published to
the npm registry. The `2.0.0` entry is the reviewed release candidate and is
published only when the release workflow runs.

## [2.0.0](https://github.com/kvnpetit/structured-repo-context-mcp/compare/v1.0.3...v2.0.0) (2026-09-10)

This is the complete release-candidate ledger for the changes made after
`v1.0.3`. The entry is intentionally detailed so the published release notes
remain useful without relying on commit history. The version is published only
by the guarded release workflow after a reviewed `[release]` commit reaches
`main`.

### Breaking Changes

* migrate the MCP runtime to the v2 server and Node packages, and expose bounded
  `schema_version: 1` result envelopes across MCP and CLI adapters
  ([611b46e](https://github.com/kvnpetit/structured-repo-context-mcp/commit/611b46e7e214fe6bd52e725fc867f4e28541eac9))
* make the package root side-effect-free; use `src-mcp serve` to start the
  executable server
  ([a0934b8](https://github.com/kvnpetit/structured-repo-context-mcp/commit/a0934b8e47f306b3f677324eee56ddcd57b644cd))

### Features

* add local code-intelligence foundations for symbols, definitions, references,
  call graphs, and dependency relationships
  ([2f0287e](https://github.com/kvnpetit/structured-repo-context-mcp/commit/2f0287ef61fe2dcbb047a8ecb0e257c71058aa52))
* expand repository context and memory tools with project onboarding, repository
  maps, artifacts, catalog, memory, task context, diagnostics, observability,
  snapshots, maintenance, SCIP import, and semantic navigation
  ([135684a](https://github.com/kvnpetit/structured-repo-context-mcp/commit/135684a80208192fb8edacd2514bb226d527e9ca))
* unify CLI and MCP feature execution, validation, output formatting, and
  lifecycle handling
  ([a0934b8](https://github.com/kvnpetit/structured-repo-context-mcp/commit/a0934b8e47f306b3f677324eee56ddcd57b644cd))
* parallelize `update_index` file processing with configurable concurrency
  ([1c0e54c](https://github.com/kvnpetit/structured-repo-context-mcp/commit/1c0e54ce2378f36d6dd9b23150f15625ac9fb9db))
* add HTTP transport, tool profiles and allow-lists, resource templates, prompts,
  durable task handles, pagination, redaction, provenance, freshness, and
  confidence signals
  ([135684a](https://github.com/kvnpetit/structured-repo-context-mcp/commit/135684a80208192fb8edacd2514bb226d527e9ca))
* add a native retrieval quality benchmark with deterministic fixtures and a
  release gate
  ([a135642](https://github.com/kvnpetit/structured-repo-context-mcp/commit/a13564283729e8b2271635a43dec5c8284642a1f))

### Reliability and Bug Fixes

* extract shared file collection and ignore-filter utilities so every feature
  applies the same indexing exclusions and safety budgets
  ([f8a32d5](https://github.com/kvnpetit/structured-repo-context-mcp/commit/f8a32d5186eaf28934e8d3fa77135a6ec2225f4b))
* pass enrichment options through watcher-triggered indexing
  ([be2cc42](https://github.com/kvnpetit/structured-repo-context-mcp/commit/be2cc42d4a8eb35af25f7f1534b4687d1570426e))
* validate absolute paths before deleting indexed file data
  ([bc2fe91](https://github.com/kvnpetit/structured-repo-context-mcp/commit/bc2fe912b2552c777f08b7c22029edd20226c614))
* surface previously swallowed embedding errors with the correct log levels
  ([e766750](https://github.com/kvnpetit/structured-repo-context-mcp/commit/e7667504f14734ab5169b61c0f044a33e81734b9))
* remove unsafe parser casts and redundant AST-root work
  ([3954b74](https://github.com/kvnpetit/structured-repo-context-mcp/commit/3954b74967c326a25b31892daa5f1aa3fe179867)),
  ([9638d8d](https://github.com/kvnpetit/structured-repo-context-mcp/commit/9638d8d527bdc96b2f06458bdc352c819d632468))
* preserve logical project paths and canonicalize watcher paths across platforms
  ([e7fb89f](https://github.com/kvnpetit/structured-repo-context-mcp/commit/e7fb89f3bed3046d099f81051ce9c2110ae5c0ab)),
  ([c337c98](https://github.com/kvnpetit/structured-repo-context-mcp/commit/c337c9872de68c698cdc042ad61dec50a206f4e8))
* enforce UTF-8-safe source boundaries for inspection responses
  ([0a9ebb3](https://github.com/kvnpetit/structured-repo-context-mcp/commit/0a9ebb349db4745d670a2de2fd9c6706e7216f3e))
* modernize the test infrastructure for Bun and Vitest compatibility, including
  cross-platform and language-server fixture paths
  ([7197612](https://github.com/kvnpetit/structured-repo-context-mcp/commit/71976126bf37fc4f68e6b4c2b08dab4d3f291f42)),
  ([965c535](https://github.com/kvnpetit/structured-repo-context-mcp/commit/965c535ec3b020cb6e30332b59b342484ceb3e50)),
  ([ec8fcaa](https://github.com/kvnpetit/structured-repo-context-mcp/commit/ec8fcaafc5be4ed53408850f2a2924ab215468ca))

### Security and Resource Controls

* harden workspace containment, local tool launch restrictions, response bounds,
  HTTP host, origin, bearer, body, concurrency, timeout, and untrusted-source
  instruction controls
  ([3e9299d](https://github.com/kvnpetit/structured-repo-context-mcp/commit/3e9299d81c35ae25a8b9f053a4c83b5e4cac4ef9))
* keep LanceDB, hash-cache, callgraph-cache, and CodeQL state directories inside
  the selected project, reject existing symlinks/junctions, and revalidate before
  native state operations
* read source files through a checked descriptor with no-follow support where the
  host provides it, a post-open link check, and the existing size limit
* bound recursive file collection by file count, aggregate bytes, directory depth,
  and cancellation, and pass request cancellation into full indexing and updates
* bound custom query input before Tree-sitter execution and reject oversized query
  content before native match materialization
* require an explicit trusted TLS-proxy opt-in for non-loopback HTTP, while
  retaining bearer authentication, configured roots, and host allow-lists
* isolate local Git and SCIP helper processes from credentials and implicit network
  or editor prompts
  ([3e9299d](https://github.com/kvnpetit/structured-repo-context-mcp/commit/3e9299d81c35ae25a8b9f053a4c83b5e4cac4ef9))
* pin privileged release actions, disable checkout credential persistence, and
  keep the npm publication toolchain fixed
  ([f0c8b03](https://github.com/kvnpetit/structured-repo-context-mcp/commit/f0c8b030adebaff0396b7c89c0d645f436e9e5f0))
* pin the patched `sharp` dependency and align Apache Arrow with LanceDB's peer
  range
  ([fe5cc09](https://github.com/kvnpetit/structured-repo-context-mcp/commit/fe5cc098f3536fd318f3e49227142a56cf645c87)),
  ([1d6ec1c](https://github.com/kvnpetit/structured-repo-context-mcp/commit/1d6ec1c25231f017a577cb5250a27023abb5d19b))

### Tooling, Packaging, and Release

* migrate quality checks from ESLint and Prettier to Bun and Biome, with the
  repository's exact formatter, linter, and import-organization policy
  ([21ec74b](https://github.com/kvnpetit/structured-repo-context-mcp/commit/21ec74bfec8c87db9f6a582590370069c9dfa5b4))
* use Bun's isolated linker, exact lockfile installation, peer dependency mode,
  workspace linking, and minimum release age policy
  ([50445f8](https://github.com/kvnpetit/structured-repo-context-mcp/commit/50445f86c3c948059c7a88a029aea0af6a59ea3a))
* update dependencies to the latest compatible versions and set production
  `NODE_ENV` for builds
  ([e2dd865](https://github.com/kvnpetit/structured-repo-context-mcp/commit/e2dd8652d3016a1c80b576749944a07572beda45)),
  ([9607ebd](https://github.com/kvnpetit/structured-repo-context-mcp/commit/9607ebd87bd66c9d1f099b16ad8d2ad9c7f20b1c))
* remove generated changelog dependencies and replace them with manually
  maintained, workflow-validated release notes
  ([e52e668](https://github.com/kvnpetit/structured-repo-context-mcp/commit/e52e6682afa406dd93cbf22a6f4507fa7d4eca8)),
  ([d223989](https://github.com/kvnpetit/structured-repo-context-mcp/commit/d2239891df3b2dd54957c2f5ccd09a87e2e7329b))
* add contract, conformance, mutation, package, and deterministic benchmark
  release gates
  ([21b905f](https://github.com/kvnpetit/structured-repo-context-mcp/commit/21b905f53859b4f00b88c56787d741f2e1802ee8))
* prepare the `2.0.0` package metadata and release workflow
  ([4756b26](https://github.com/kvnpetit/structured-repo-context-mcp/commit/4756b2609b443aba167e3535d39ae05837c002ef))

### Documentation and Repository Maintenance

* document the architecture, Bun workflow, release process, remote HTTP
  prerequisites, and security boundaries
  ([a9bfbae](https://github.com/kvnpetit/structured-repo-context-mcp/commit/a9bfbae49f2bfdca4eec02ec0e711e7178727343)),
  ([35af6e3](https://github.com/kvnpetit/structured-repo-context-mcp/commit/35af6e3ddcb069ce8f969c6b34326f3b52160d47)),
  ([0f2b073](https://github.com/kvnpetit/structured-repo-context-mcp/commit/0f2b0731c3449201509d7547562abacca771ca7c))
* remove obsolete Dependabot configuration after consolidating dependency update
  ownership
  ([466ffd8](https://github.com/kvnpetit/structured-repo-context-mcp/commit/466ffd8bcb56378a5b43d74d7c2e59f77d684f56))

## [1.0.3](https://github.com/kvnpetit/structured-repo-context-mcp/compare/v1.0.2...v1.0.3) (2026-01-20)

### Bug Fixes

* **watcher:** auto-indexing not triggering on first run ([734e2b4](https://github.com/kvnpetit/structured-repo-context-mcp/commit/734e2b46a747efa98472acd4c4ebd0ca3db5b246))

### Changes

* remove the obsolete LLM reranker implementation and its public configuration after consolidating search ranking

## [1.0.2](https://github.com/kvnpetit/structured-repo-context-mcp/compare/v1.0.1...v1.0.2) (2026-01-20)

### Bug Fixes

* use stderr for all logger output to prevent MCP protocol corruption ([439429d](https://github.com/kvnpetit/structured-repo-context-mcp/commit/439429d47723fea5cb107d0f4b13507d44dcb8b6))

### Build and CI

* migrate the production bundle from `tsc` to `tsdown`
* improve the GitHub Actions workflow and Trusted Publishing setup

## [1.0.1](https://github.com/kvnpetit/structured-repo-context-mcp/compare/v1.0.0...v1.0.1) (2026-01-20)

### Packaging

* publish the first npm registry package as `src-mcp@1.0.1`; the preceding `v1.0.0` tag remains a Git-only release

## 1.0.0 (2026-01-20)

### Features

* **assets:** add tree-sitter WASM parsers and SCM queries ([6bc7514](https://github.com/kvnpetit/structured-repo-context-mcp/commit/6bc7514e034fbfc54c8c5f8a4c66e58c0e7939f7))
* **callgraph:** add persistent caching with hash-based invalidation ([5a5d5a3](https://github.com/kvnpetit/structured-repo-context-mcp/commit/5a5d5a396f6cde8de6c24ddc9c88e5eca84d38b7))
* **cli:** auto-start watcher on serve command ([6b213f9](https://github.com/kvnpetit/structured-repo-context-mcp/commit/6b213f97f1f21face7506aff4c181ffffb1c3f15))
* **core:** add parsing and symbol extraction modules ([023f1ac](https://github.com/kvnpetit/structured-repo-context-mcp/commit/023f1ace80f265a32c9ef67c017e35f07050f956))
* **embeddings:** add call graph extraction and storage ([bf7ca7b](https://github.com/kvnpetit/structured-repo-context-mcp/commit/bf7ca7bd6c675c446ce14a578b47d1c3698d8824))
* **embeddings:** add core embeddings module with Ollama and LanceDB ([c40d4f7](https://github.com/kvnpetit/structured-repo-context-mcp/commit/c40d4f7efe47741c14e59a09ae7627a1e96681b5))
* **embeddings:** add cross-file context resolution for imports ([c3edf0d](https://github.com/kvnpetit/structured-repo-context-mcp/commit/c3edf0ddbffe232a48ebe879a382772be877837b))
* **embeddings:** add file watcher with hash cache and debounce ([03de1dd](https://github.com/kvnpetit/structured-repo-context-mcp/commit/03de1dd685fc13161334adf5c1c2510ce7be082c))
* **embeddings:** add semantic chunking and LLM-based enrichment ([d7d0277](https://github.com/kvnpetit/structured-repo-context-mcp/commit/d7d0277840bb3e2cbd6f6537343f33871af22a65))
* **embeddings:** implement path aliases resolution from tsconfig.json ([855caec](https://github.com/kvnpetit/structured-repo-context-mcp/commit/855caece66944da884c7777118b2a9fee9031fb2))
* **embeddings:** integrate cross-file context into enrichment pipeline ([a046438](https://github.com/kvnpetit/structured-repo-context-mcp/commit/a046438b08a6cb1658fd4371233551288b203ea7))
* **features:** add code analysis MCP tools ([c027dff](https://github.com/kvnpetit/structured-repo-context-mcp/commit/c027dff5d5d401524a87c48dc586e8a6c749b197))
* **features:** add get-call-graph feature with tests ([efc620b](https://github.com/kvnpetit/structured-repo-context-mcp/commit/efc620b5ad739a30dfc9b4bab434d2eb3d1ac055))
* **features:** add semantic search features ([b51309b](https://github.com/kvnpetit/structured-repo-context-mcp/commit/b51309b480732cea3c715d6a7c1a3eac1b536cf6))
* **features:** add shared utilities for features ([6229b10](https://github.com/kvnpetit/structured-repo-context-mcp/commit/6229b10bd0a94d895daa277eb501afdaf91e2c19))
* **features:** add update-index feature with tests ([537c6c6](https://github.com/kvnpetit/structured-repo-context-mcp/commit/537c6c6ac8eff06c10657eaa16ce9b421dcdfb29))
* improve MCP server implementation ([0954f15](https://github.com/kvnpetit/structured-repo-context-mcp/commit/0954f15a456f53c0985f300ab9b582709eca5a80))
* **indexing:** add parallel file processing with configurable concurrency ([8d2aa9b](https://github.com/kvnpetit/structured-repo-context-mcp/commit/8d2aa9b62aa40ec510384a6f28603c86e1a482b1))
* **search:** add hybrid search with BM25 and RRF fusion ([25e08e5](https://github.com/kvnpetit/structured-repo-context-mcp/commit/25e08e5589fc47224badd7404156685bed7a6e2f))
* **search:** add LLM re-ranking for improved result relevance ([388094b](https://github.com/kvnpetit/structured-repo-context-mcp/commit/388094be2e0234f35304ab94429f0c50d0d27a6f))
* **search:** enable call context by default for richer results ([f7532d8](https://github.com/kvnpetit/structured-repo-context-mcp/commit/f7532d80ef5459f244b2e78e6bead479b1b0c3cd))
* **search:** enable LLM re-ranking by default with lightweight model ([4a51c65](https://github.com/kvnpetit/structured-repo-context-mcp/commit/4a51c65270f652567eecf6e9edb613735e5419fb))

### Bug Fixes

* **callgraph:** handle unwritable cache directory gracefully ([986e9eb](https://github.com/kvnpetit/structured-repo-context-mcp/commit/986e9eb2b4cd3d0f3e2fe79b89e9ac62b73891c5))
* **ci:** add npm update for Trusted Publishing ([f9c4ce9](https://github.com/kvnpetit/structured-repo-context-mcp/commit/f9c4ce92c98693e4d092ec0416608f5cfe2d4a74))
* **cli:** handle async promise rejections properly ([1a978f8](https://github.com/kvnpetit/structured-repo-context-mcp/commit/1a978f83790cb8e4a17b9d8f468738d3b01655d4))
* normalize CRLF line endings for cross-platform compatibility ([4dc9468](https://github.com/kvnpetit/structured-repo-context-mcp/commit/4dc94683ac3309ec572067f93f6afbcf3fa32855))
* **test:** resolve lint errors and type safety issues ([276bc86](https://github.com/kvnpetit/structured-repo-context-mcp/commit/276bc86035ed541823879d21a29902d073ffba98))
* **test:** resolve lint errors in watcher.test.ts ([161c4dd](https://github.com/kvnpetit/structured-repo-context-mcp/commit/161c4ddb25409c2409cc55209c3b444420ad28a6))
