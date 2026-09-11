# SRC (Structured Repo Context)

> **Transform your codebase into AI-ready context** — MCP server + CLI for semantic code search that makes your code truly understandable for AI assistants

**SRC is both:**

- 🔌 **An MCP Server** — Integrates with Claude Desktop, Cursor, and any MCP-compatible AI assistant
- 💻 **A Standalone CLI** — Use directly from your terminal for indexing and searching

[![CI](https://github.com/kvnpetit/structured-repo-context-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/kvnpetit/structured-repo-context-mcp/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/kvnpetit/structured-repo-context-mcp/branch/main/graph/badge.svg)](https://codecov.io/gh/kvnpetit/structured-repo-context-mcp)
[![npm version](https://img.shields.io/npm/v/src-mcp.svg)](https://www.npmjs.com/package/src-mcp)
[![npm downloads](https://img.shields.io/npm/dm/src-mcp.svg)](https://www.npmjs.com/package/src-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/MCP-Compatible-blue.svg)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue.svg)](https://www.typescriptlang.org/)
[![Ollama](https://img.shields.io/badge/Ollama-Optional-orange.svg)](https://ollama.com)

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Installation](#installation)
4. [MCP Tools Reference](#mcp-tools-reference)
5. [CLI Reference](#cli-reference)
6. [Configuration](#configuration)
7. [Supported Languages](#supported-languages)
8. [How It Works](#how-it-works)
9. [Comparison](#comparison)
10. [Troubleshooting](#troubleshooting)
11. [Links](#links)

---

## Overview

### The Problem

AI assistants struggle to understand your entire codebase:

- They only see small snippets of code at a time
- Manual copy-pasting of context is tedious and error-prone
- Keyword search misses semantic relationships between code
- Code changes get lost in conversation history

### The Solution

SRC indexes your codebase into semantic, searchable chunks that LLMs actually understand:

| Feature                 | Description                                                                     |
| ----------------------- | ------------------------------------------------------------------------------- |
| **Hybrid Search**       | Vector + BM25 + RRF fusion for optimal results                                  |
| **Call Graph**          | Shows who calls what and what calls who                                         |
| **Cross-file Context**  | Resolves imports and path aliases automatically                                 |
| **Incremental Updates** | SHA-256 hash detection for fast updates                                         |
| **Semantic Navigation** | Local LSP/SCIP when available, with explicit Tree-sitter fallback               |
| **Project Context**     | Onboarding, repo map, artifacts, memory, Git and task context                   |
| **Local Hardening**     | Strict contracts, snapshots, redaction, injection signals and audit metadata    |
| **55 Language Modes**   | 18 Tree-sitter languages plus 37 configured fallback modes across 99 extensions |

### Use Cases

| Scenario           | Example Query                                      |
| ------------------ | -------------------------------------------------- |
| **Code Review**    | "Show me all error handling in the payment module" |
| **Debugging**      | "Find where user sessions are created"             |
| **Documentation**  | "Explain the authentication flow"                  |
| **Refactoring**    | "List all deprecated API usages"                   |
| **Onboarding**     | "How does the routing system work?"                |
| **Security Audit** | "Find all database query locations"                |

---

## Quick Start

### 1. Choose an embedding provider

The default provider is local [Ollama](https://ollama.com):

```bash
# Install from https://ollama.com, then:
ollama pull nomic-embed-text
```

For a zero-service setup, use the deterministic lexical provider instead:

```bash
EMBEDDING_PROVIDER=lexical src-mcp serve
```

The lexical provider is a useful BM25/identifier baseline; Ollama remains the
recommended provider for semantic vector quality.

### 2. Install SRC

**Global installation:**

```bash
npm install -g src-mcp
```

**Or use npx:**

```bash
npx -y src-mcp serve
```

### 3. Use as MCP Server (with AI Assistants)

Add to your MCP client configuration (e.g., Claude Desktop):

**With global installation:**

```json
{
  "mcpServers": {
    "src-mcp": {
      "command": "src-mcp",
      "args": ["serve"]
    }
  }
}
```

**With npx:**

```json
{
  "mcpServers": {
    "src-mcp": {
      "command": "npx",
      "args": ["-y", "src-mcp", "serve"]
    }
  }
}
```

The server indexes the current directory when requested and can watch for file
changes. `EMBEDDING_PROVIDER=lexical` removes the requirement for a running
Ollama service.

Then in your AI assistant:

```
"Search for authentication logic"
"Find error handling code with limit 20"
"Search for UserService in fts mode"
```

### 4. Use as CLI (Standalone)

```bash
# Start server (auto-indexes if needed and watches by default)
src-mcp serve

# Search for code
src-mcp search_code --query "authentication"
src-mcp search_code --query "error handling" --limit 20
src-mcp search_code --query "UserService" --mode fts

# Check index status
src-mcp get_index_status
```

### Key Arguments

| Tool             | Argument        | Default | Description                 |
| ---------------- | --------------- | ------- | --------------------------- |
| `search_code`    | `--limit`       | 10      | Max results                 |
| `search_code`    | `--mode`        | hybrid  | `hybrid` / `vector` / `fts` |
| `index_codebase` | `--concurrency` | 4       | Parallel workers            |
| `index_codebase` | `--force`       | false   | Re-index if exists          |

---

## Installation

### Global Installation

```bash
npm install -g src-mcp
```

Then use directly:

```bash
src-mcp serve
src-mcp search_code --query "authentication"
src-mcp --help
```

### npx (No Installation)

```bash
npx -y src-mcp serve
npx -y src-mcp search_code --query "authentication"
```

### Local Development

```bash
git clone https://github.com/kvnpetit/structured-repo-context-mcp.git
cd structured-repo-context-mcp
bun install --frozen-lockfile
bun run dev
```

---

## MCP Tools Reference

SRC exposes 35 MCP tools, 7 reusable MCP prompts, 2 static MCP resources, and
1 project resource template. The same tool registry is also available through
the CLI.
All tools return structured content, bounded results, read-only/destructive
annotations, and safe error messages. Indexing and updates report progress when
the client supplies a progress token and honor request cancellation.

Source returned by analysis tools is untrusted project data. It is marked with
`source_is_untrusted`; `search_code` and `assemble_task_context` redact common
inline secrets by default. Exact source extraction keeps offsets stable and can
opt into redaction with `redact_secrets: true`.

Responses also carry provenance, index freshness, confidence, coverage and
truncation metadata. Potential prompt-injection patterns found in returned
source are exposed as bounded `instruction_signals` without echoing matched
source text. When `SRC_AUDIT_LOG` is enabled, only non-sensitive tool timing and
project identifiers are written to the local audit log.

Every MCP tool response also has a stable top-level `schema_version` (currently
`1`) alongside `success`, optional `data`, `message`, and `error` fields. Clients
should branch on this envelope before consuming a tool-specific `data` payload.

### Tasks extension

Modern MCP clients that declare `io.modelcontextprotocol/tasks` in their
per-request client capabilities can receive a durable task handle for the
long-running `index_codebase` and `update_index` tools. Poll a handle with
`tasks/get`; `tasks/update` and `tasks/cancel` are also implemented according
to the current extension contract. Task state is stored atomically outside the
project by default, expires after 24 hours, and is bounded to eight active
tasks per server process. A shared store has a hard ceiling of 1,024 records
and 16 MiB; reaching either refuses new writes without evicting existing IDs.
Set `MCP_TASKS=off` to disable it, or configure `MCP_TASK_TOOLS`,
`MCP_TASK_STORE_DIR`, `MCP_TASK_TTL_MS`, `MCP_TASK_POLL_INTERVAL_MS`,
`MCP_TASK_MAX_ACTIVE`, and `MCP_TASK_MAX_RESULT_BYTES`.

The extension is opt-in per request: clients without the current capability
continue to receive the normal synchronous tool result. Processes sharing a
store coordinate read/modify/write operations with local filesystem locks.
In-progress tasks owned by a living process are preserved; an abandoned task
whose owner has exited is reported as failed because
arbitrary source analysis cannot be resumed without its original runtime
state. There is intentionally no `tasks/list` endpoint in the current
extension; task IDs are unguessable and retrieval is explicit.

Use a local disk for this store. A persistence failure stops affected runners
and rejects new asynchronous work until the server restarts; synchronous tools
remain available. Failed states are retained in memory and retried against the
store when it becomes writable again. Cross-process cancellation is polled at
500 ms. Owner detection is conservative if the OS reuses a process ID.

### Tool profiles and allow-listing

The complete surface is enabled by default. Set `SRC_TOOL_PROFILE=readonly` to
hide the seven local state/index-mutating tools, or `SRC_TOOL_PROFILE=minimal` to expose only
server information, index status, search, diagnostics, project discovery,
project context, project artifacts, semantic navigation, and compact
context-orientation tools.
`SRC_TOOL_ALLOWLIST` takes precedence when it contains explicit names; unknown
entries are ignored by the registry. An explicitly
non-empty but unusable `SRC_ALLOWED_ROOTS` value fails closed rather than
falling back to the current directory.

### index_codebase

Index a directory with semantic chunking, AST enrichment, and embeddings.

| Parameter     | Type     | Required | Default | Description                         |
| ------------- | -------- | -------- | ------- | ----------------------------------- |
| `directory`   | string   | No       | `.`     | Path to directory to index          |
| `force`       | boolean  | No       | `false` | Force re-indexing if index exists   |
| `exclude`     | string[] | No       | `[]`    | Additional glob patterns to exclude |
| `concurrency` | number   | No       | `4`     | Parallel file processing workers    |

**Example:**

```
"Index the project at /home/user/myapp with concurrency 8"
```

**Returns:**

```json
{
  "filesIndexed": 150,
  "chunksCreated": 892,
  "languages": { "typescript": 500, "javascript": 200, "json": 192 }
}
```

---

### search_code

Hybrid search with vector similarity, BM25 keyword matching, and RRF fusion.

| Parameter            | Type    | Required | Default   | Description                                             |
| -------------------- | ------- | -------- | --------- | ------------------------------------------------------- |
| `query`              | string  | **Yes**  | —         | Natural language search query                           |
| `directory`          | string  | No       | `.`       | Path to indexed directory                               |
| `limit`              | number  | No       | `10`      | Maximum results to return                               |
| `cursor`             | string  | No       | —         | Opaque cursor returned by a previous page               |
| `max_content_bytes`  | number  | No       | `20000`   | UTF-8 byte cap per returned source result               |
| `min_confidence`     | number  | No       | `0`       | Optional confidence floor; may cause abstention         |
| `threshold`          | number  | No       | —         | Distance threshold (0-2, vector mode only)              |
| `mode`               | enum    | No       | `hybrid`  | Search mode: `hybrid`, `vector`, or `fts`               |
| `vectorWeight`       | number  | No       | `0.5`     | Hybrid semantic weight from 0 (keywords) to 1 (vectors) |
| `includeCallContext` | boolean | No       | `true`    | Include caller/callee information                       |
| `rerank`             | enum    | No       | `lexical` | `none`, `lexical`, or code-aware `code` ranking         |
| `language`           | string  | No       | —         | Filter by detected language                             |
| `path_prefix`        | string  | No       | —         | Filter by project-relative path prefix                  |
| `symbol_type`        | string  | No       | —         | Filter by symbol kind such as function or class         |
| `include_tests`      | boolean | No       | `true`    | Include test/spec paths                                 |
| `redact_secrets`     | boolean | No       | `true`    | Redact common inline secrets in returned source         |
| `neighbor_window`    | number  | No       | `0`       | Add up to 3 same-file chunks on each side of each hit   |

**Search Modes:**

| Mode     | Description                | Best For                  |
| -------- | -------------------------- | ------------------------- |
| `hybrid` | Vector + BM25 + RRF fusion | General queries (default) |
| `vector` | Semantic similarity only   | Conceptual searches       |
| `fts`    | Full-text keyword only     | Exact identifiers         |

**Example:**

```
"Search for 'user authentication' with limit 20"
```

**Returns:**

```json
{
  "results": [
    {
      "content": "export async function authenticateUser(credentials)...",
      "filePath": "src/auth/login.ts",
      "startLine": 45,
      "endLine": 78,
      "symbolName": "authenticateUser",
      "symbolType": "function",
      "score": 0.0164,
      "confidence": 0.86,
      "parts": {
        "signature": "export async function authenticateUser(credentials)",
        "body": "export async function authenticateUser(credentials)..."
      },
      "callContext": {
        "callers": ["handleLogin"],
        "callees": ["validatePassword"]
      }
    }
  ]
}
```

Filtered searches retrieve a larger bounded candidate pool before applying the
filters. The response reports `truncated`, the active filters, index metadata,
and the source fingerprint represented by the index when available. Retrieval
metadata classifies the query as `identifier`, `concept`, or `mixed`, reports
duplicate removal and confidence, and explains abstention when no result reaches
`min_confidence`. Each result separates `parts.signature`,
`parts.documentation`, and `parts.body`. Use `next_cursor` with the same query
and filters to request a following page.

`score` is mode-dependent: vector mode returns a distance where lower is
better, while FTS and hybrid modes return ranking scores where higher is
better. Use the normalized `confidence` field (0–1) for a mode-independent
quality signal.

`max_content_bytes` bounds each returned source snippet without splitting a
multi-byte UTF-8 character. When a snippet is shortened, the result contains
`content_truncated: true` and the response reports
`content_truncated_count`.

Set `neighbor_window` to `1`, `2`, or `3` when the matching chunk needs local
surrounding context. Neighbor results are marked with `is_neighbor`,
`neighbor_of`, and `neighbor_distance`; they inherit the active filters, are
score-decayed and confidence-adjusted, and are capped by a bounded seed and
result budget. Retrieval metadata reports `neighbors_added`,
`neighbor_candidates_considered`, and `neighbors_truncated`. The default `0`
keeps the historical result set unchanged.

### MCP prompts

The prompt catalog contains `src-overview`, `code-search-workflow`,
`search-tips`, `project-onboarding`, `architecture-review`, `security-review`,
and `refactor-impact`. The specialized prompts describe local, read-only tool
sequences and explicitly require callers to inspect provenance, freshness,
coverage, confidence, truncation, and untrusted-content signals.

### MCP resources

SRC publishes JSON resources for discovery and bounded project orientation:

| Resource                         | Purpose                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `src://server/info`              | Server identity, version, and description                                                  |
| `src://server/capabilities`      | Active tool profile, enabled tool catalog, annotations, and deterministic catalog revision |
| `src://project/{project}/{view}` | Local project template with `context`, `map`, `status`, `catalog`, or `memory` views       |

Project identifiers are derived from the secure local root. The template lists
configured `SRC_ALLOWED_ROOTS`, or the current directory when no allow-list is
configured. Resource payloads remain local JSON and use the same bounded,
redacted feature implementations as the corresponding tools.

---

### update_index

Incrementally update the index by detecting changed files via SHA-256 hash comparison.

| Parameter     | Type    | Required | Default | Description                      |
| ------------- | ------- | -------- | ------- | -------------------------------- |
| `directory`   | string  | No       | `.`     | Path to indexed directory        |
| `dryRun`      | boolean | No       | `false` | Preview changes without updating |
| `force`       | boolean | No       | `false` | Force re-index all files         |
| `concurrency` | number  | No       | `4`     | Parallel file processing workers |

**Example:**

```
"Update the index with dry run to see what changed"
```

**Returns:**

```json
{
  "added": ["src/new-file.ts"],
  "modified": ["src/auth/login.ts"],
  "removed": ["src/old-file.ts"],
  "unchanged": 148
}
```

---

### get_index_status

Get status of the embedding index for a directory.

| Parameter   | Type   | Required | Default | Description       |
| ----------- | ------ | -------- | ------- | ----------------- |
| `directory` | string | No       | `.`     | Path to directory |

**Example:**

```
"Get the index status for current directory"
```

**Returns:**

```json
{
  "exists": true,
  "indexPath": "/home/user/myapp/.src-index",
  "totalFiles": 150,
  "totalChunks": 892,
  "languages": { "typescript": 500, "javascript": 200 }
}
```

The status also reports provider compatibility, source/index freshness, storage
size, hash-cache and write-lock presence, and corruption indicators when those
signals are available.

---

### get_server_info

Get the server identity, version, and description.

| Parameter | Type | Required | Default | Description                     |
| --------- | ---- | -------- | ------- | ------------------------------- |
| `format`  | enum | No       | `text`  | Output format: `text` or `json` |

**Returns:**

```json
{
  "name": "src-mcp",
  "fullName": "SRC (Structured Repo Context)",
  "version": "2.0.0",
  "description": "MCP server for codebase analysis with Treesitter (SCM queries), AST parsing, and embedding-based indexing"
}
```

---

### parse_ast

Parse Tree-sitter-supported source and return its AST. Provide `file_path` or `content`; when using `content`, also provide `language`. Optional `max_depth` limits the returned tree (default `5`, maximum `50`), `max_text_bytes` bounds inline node text, `max_nodes` bounds the returned tree (default `10000`), and `redact_secrets` masks common credentials by default.

### query_code

Run a raw Tree-sitter SCM `query` or one of the presets `functions`, `classes`, `imports`, `exports`, `comments`, `strings`, `variables`, or `types`. Provide `file_path` or `content`; `language` is optional, `max_matches` defaults to `500` (maximum `1000`), and `redact_secrets` defaults to `true`.

### list_symbols

Extract symbols from `file_path` or direct `content`. Optional `language` selects the parser, `types` filters functions, classes, variables, constants, interfaces, types, enums, methods, or properties, and `max_symbols` defaults to `1000` (maximum `5000`).

### analyze_file

Analyze a local `file_path` through Tree-sitter or configured text fallback. `include_ast`, `include_symbols`, `include_imports`, `include_exports`, `ast_max_depth`, `ast_max_nodes`, `include_chunks`, and `redact_secrets` control response detail and bounds.

### get_call_graph

Analyze calls under `directory` (default `.`), or query a `functionName` with optional `filePath`. `maxDepth` defaults to `2`, `maxNodes` to `200`, and `maxFiles` to `500`; `exclude` accepts additional ignore patterns. Results are static syntactic relationships and may not resolve every dynamic call.

### find_symbols

Find definitions, references, imports, or exports across a project. Results
include project-relative paths, symbol names, bounded source snippets, and
UTF-8 byte offsets for precise follow-up retrieval. `max_files`,
`limit`, opaque `cursor`, optional `file_path`, and `redact_secrets` keep the
response bounded and safe for agent context. `mode` accepts `definitions`,
`references`, `imports`, `exports`, or `all`; defaults are `definitions`,
`limit: 50`, and `max_files: 200`.

### get_dependency_graph

Build a project-relative import/dependency graph with resolved and unresolved
edges, cycles, and high-degree hotspots. Relative imports and TypeScript path
aliases are resolved when the target stays inside the secure project root. The
response also includes a bounded syntax-level type hierarchy with inheritance
and implementation edges. `max_files`, `max_edges`, `max_type_nodes`, and
`max_type_edges` independently cap graph expansion (defaults: `200`, `2000`,
`5000`, and `10000`). `include_external` defaults to `false`.

### get_code_snippet

Read a bounded source range by exact UTF-8 byte offsets. The response includes
the project-relative path, start/end offsets, line/column positions, and a
truncation flag. `start_offset` defaults to `0`, `end_offset` is optional,
`max_bytes` defaults to `12000`, and `redact_secrets` defaults to `false` so
returned offsets continue to describe the original file. It never executes
source code.

### analyze_impact

Compute direct and transitive dependents for changed project-relative files from
the dependency graph. `changed_files` is required (1–50 paths) and `max_files`
defaults to `200`. Unknown files are reported separately.

### get_diagnostics

Inspect provider health, index metadata compatibility, path allow-list status,
and resource limits for `directory` (default `.`) without changing the project.

### list_projects

List all safe project roots configured through `SRC_ALLOWED_ROOTS`, or the
current directory when no roots are configured. Each project is indexed
independently; the result includes its index status and invalid configured roots
so a bad configuration cannot silently widen filesystem access.
`includeCurrent` defaults to `true`.

### get_project_context

Build a bounded local onboarding profile without executing project commands.
The result identifies the project name and kind, detected languages and
frameworks, package manifests and managers, scripts, workspace patterns,
likely entrypoints, test roots/files, configuration and documentation files,
TypeScript path aliases, and a fingerprint of the scanned file metadata.
Scripts are returned as data only and common inline secrets are redacted by
default.

| Parameter         | Type    | Required | Default | Description                              |
| ----------------- | ------- | -------- | ------- | ---------------------------------------- |
| `directory`       | string  | No       | `.`     | Project directory                        |
| `max_files`       | number  | No       | `1000`  | Maximum source files to inspect          |
| `max_manifests`   | number  | No       | `100`   | Maximum metadata files to inspect        |
| `include_scripts` | boolean | No       | `true`  | Include package scripts without running  |
| `redact_secrets`  | boolean | No       | `true`  | Redact common secrets in script commands |

The output is read-only, bounded, marked `source_is_untrusted`, and includes
`truncated`, `errors`, and `profile_fingerprint` fields.

### semantic_navigation

Navigate a local source position with an allow-listed local language server
when one is installed, or use the explicit Tree-sitter fallback. Supported
operations are `definition`, `references`, `implementation`, `hover`,
`type_hierarchy`, and `diagnostics`.
The fallback never pretends to resolve compiler identity: its response marks
`coverage: "approximate"`, exposes `confidence`, and explains the limitation
in `warnings`.

| Parameter          | Type    | Required | Default | Description                                                                               |
| ------------------ | ------- | -------- | ------- | ----------------------------------------------------------------------------------------- |
| `directory`        | string  | No       | `.`     | Project directory                                                                         |
| `file_path`        | string  | **Yes**  | —       | Source file path relative to the project                                                  |
| `line`             | number  | **Yes**  | —       | 1-based source line                                                                       |
| `column`           | number  | **Yes**  | —       | 0-based character column                                                                  |
| `operation`        | enum    | **Yes**  | —       | `definition`, `references`, `implementation`, `hover`, `type_hierarchy`, or `diagnostics` |
| `backend`          | enum    | No       | `auto`  | `auto`, `lsp`, `scip`, or `treesitter`                                                    |
| `max_results`      | number  | No       | `50`    | Maximum returned locations                                                                |
| `max_files`        | number  | No       | `500`   | Tree-sitter fallback file bound                                                           |
| `include_source`   | boolean | No       | `true`  | Include bounded location snippets                                                         |
| `max_source_bytes` | number  | No       | `8000`  | Maximum source bytes included per result                                                  |
| `timeout_ms`       | number  | No       | `5000`  | Local LSP request timeout                                                                 |
| `redact_secrets`   | boolean | No       | `true`  | Redact common secrets in returned text                                                    |

Set `SRC_LSP_ENABLED=false` to force the safe Tree-sitter fallback. No remote
language server is used; external LSP locations are discarded when they fall
outside the configured project root.

`import_scip_index` can import a project-relative SCIP JSON export (or invoke a
local `scip print --json` executable) into `.src-index/scip-catalog.json`.
Explicit `lsp`/`scip` requests report unavailable backends as errors; `auto`
degrades with an explicit backend and coverage description.

### get_symbol_graph

Build a bounded, local symbol-level architecture graph. It combines modules,
definitions, imports, references, calls, inheritance, test discovery, and
static route/event/dependency-injection signals. `trace_from`/`trace_to` expose
bounded paths; `focus` exposes reverse direct and transitive blast radius.
Every inferred relationship carries a confidence score and the response
explicitly reports its approximate, syntax/name-based coverage.

| Parameter         | Type     | Required | Default   | Description                               |
| ----------------- | -------- | -------- | --------- | ----------------------------------------- |
| `directory`       | string   | No       | `.`       | Project directory                         |
| `focus`           | string[] | No       | `[]`      | Symbols, paths, or node IDs to prioritize |
| `edge_kinds`      | enum[]   | No       | all       | Relationship kinds to include             |
| `trace_from`      | string   | No       | —         | Start symbol/path/node for a trace        |
| `trace_to`        | string   | No       | —         | End symbol/path/node for a trace          |
| `trace_direction` | enum     | No       | `forward` | `forward`, `reverse`, or `both`           |
| `max_path_length` | number   | No       | `8`       | Maximum edges per trace/blast-radius walk |
| `max_files`       | number   | No       | `500`     | Maximum source files                      |
| `max_nodes`       | number   | No       | `1000`    | Maximum returned nodes                    |
| `max_edges`       | number   | No       | `5000`    | Maximum returned edges                    |
| `include_tests`   | boolean  | No       | `true`    | Include test edges and discovery          |
| `include_signals` | boolean  | No       | `true`    | Detect static routes/events/DI            |
| `redact_secrets`  | boolean  | No       | `true`    | Redact evidence snippets                  |

The graph is read-only and never executes project code. Dynamic dispatch,
reflection, generated code, and runtime wiring remain explicit limitations.

### get_repository_map

Build a compact architecture map before reading many files. Files are ranked
with import-graph centrality and optional path/symbol focus, then bounded by a
token budget.

| Parameter        | Type     | Required | Default | Description                    |
| ---------------- | -------- | -------- | ------- | ------------------------------ |
| `directory`      | string   | No       | `.`     | Project directory              |
| `focus`          | string[] | No       | `[]`    | Paths or symbols to prioritize |
| `max_tokens`     | number   | No       | `2000`  | Approximate textual map budget |
| `max_files`      | number   | No       | `500`   | Maximum files to inspect       |
| `redact_secrets` | boolean  | No       | `true`  | Redact evidence snippets       |

The result includes ranked files, included symbol counts, errors, and an
explicit `truncated` flag.

### get_symbol_at_position

Resolve the smallest Tree-sitter symbol containing an editor position. Lines
are 1-based, columns are 0-based characters, and returned offsets are UTF-8
byte offsets suitable for `get_code_snippet`.

| Parameter          | Type    | Required | Default | Description                         |
| ------------------ | ------- | -------- | ------- | ----------------------------------- |
| `directory`        | string  | No       | `.`     | Project directory                   |
| `file_path`        | string  | **Yes**  | —       | File path relative to the directory |
| `line`             | number  | **Yes**  | —       | 1-based line                        |
| `column`           | number  | **Yes**  | —       | 0-based character column            |
| `include_source`   | boolean | No       | `true`  | Include bounded symbol source       |
| `max_source_bytes` | number  | No       | `20000` | Maximum returned source bytes       |
| `redact_secrets`   | boolean | No       | `true`  | Redact common secrets in source     |

### assemble_task_context

Assemble a bounded, task-focused agent dossier. In one local call it can combine
the project profile, revision-aware memory, relevant documentation, current Git
state, a PageRank-style repository map, and code-aware hybrid search. Layers run
concurrently and receive a fair share of the token budget, so a large map or
search result cannot starve every other source. The response reports per-layer
availability, allocation, truncation, warnings, and suggested next actions.

| Parameter                 | Type    | Required | Default    | Description                                      |
| ------------------------- | ------- | -------- | ---------- | ------------------------------------------------ |
| `directory`               | string  | No       | `.`        | Project directory                                |
| `task`                    | string  | **Yes**  | —          | Task or question to orient around                |
| `depth`                   | enum    | No       | `standard` | `minimal`, `standard`, or `deep` evidence        |
| `max_tokens`              | number  | No       | `4000`     | Approximate total context budget                 |
| `search_limit`            | number  | No       | `8`        | Maximum primary semantic results                 |
| `include_search`          | boolean | No       | `true`     | Include indexed search results                   |
| `include_project_context` | boolean | No       | by depth   | Include manifest/framework/entrypoint evidence   |
| `include_memory`          | boolean | No       | by depth   | Include scoped durable memory                    |
| `include_artifacts`       | boolean | No       | by depth   | Include relevant local documentation             |
| `include_git`             | boolean | No       | by depth   | Include branch, dirty files, and changed symbols |
| `memory_scope`            | string  | No       | `project`  | Project-local memory namespace                   |
| `memory_min_confidence`   | number  | No       | `0.4`      | Ignore low-confidence memory                     |

`minimal` keeps only map and search, `standard` enables the complete dossier,
and `deep` increases local evidence and neighboring-code depth. Every mode
degrades explicitly when an optional index, Git repository, or context source
is unavailable. `max_tokens` bounds the rendered `context` field; the
machine-readable `repository_map` and `search` compatibility fields remain
separately bounded by their feature limits and the global MCP response cap.

### find_dead_code

Return conservative dead-code candidates using syntax-aware symbol extraction
and bounded identifier reference counts. This is a review aid, not a compiler
proof: dynamic dispatch, reflection, generated code, entry points, and external
consumers can produce false positives.

| Parameter       | Type    | Required | Default | Description                        |
| --------------- | ------- | -------- | ------- | ---------------------------------- |
| `directory`     | string  | No       | `.`     | Project directory                  |
| `limit`         | number  | No       | `100`   | Maximum candidates returned        |
| `max_files`     | number  | No       | `500`   | Maximum source files inspected     |
| `include_tests` | boolean | No       | `false` | Include candidates from test files |

### get_changed_symbols

Read the Git working tree relative to `HEAD` and map changed hunks to current
symbols. It includes untracked files, has no shell execution or user-supplied
revision argument, and returns explicit bounds/errors.

| Parameter     | Type   | Required | Default | Description                       |
| ------------- | ------ | -------- | ------- | --------------------------------- |
| `directory`   | string | No       | `.`     | Git repository root               |
| `max_files`   | number | No       | `300`   | Maximum changed files to inspect  |
| `max_symbols` | number | No       | `1000`  | Maximum changed symbols to return |

### get_project_artifacts

Discover and search project documentation without executing or persisting it.
Artifacts are classified as `readme`, `architecture`, `adr`, `specification`,
`plan`, `runbook`, `security`, `changelog`, `contributing`, or generic
`documentation`.

| Parameter           | Type    | Required | Default | Description                             |
| ------------------- | ------- | -------- | ------- | --------------------------------------- |
| `directory`         | string  | No       | `.`     | Project directory                       |
| `query`             | string  | No       | `""`    | Terms to search in paths/titles/content |
| `limit`             | number  | No       | `50`    | Maximum artifacts returned              |
| `max_files`         | number  | No       | `1000`  | Maximum documentation files inspected   |
| `include_content`   | boolean | No       | `false` | Include bounded document content        |
| `max_content_bytes` | number  | No       | `4000`  | Maximum content bytes per artifact      |
| `redact_secrets`    | boolean | No       | `true`  | Redact common inline secrets            |

The output contains document links, relevance, explicit truncation, and the
`source_is_untrusted` marker. It is a read-only catalog for current files, not
a cross-project memory channel.

### get_project_memory

Read the opt-in, project-scoped memory stored in `.src-index/project-memory.json`.
Records are typed (`decision`, `constraint`, `fact`, `todo`, or `note`),
versioned, confidence-scored, expiry-aware, redacted by default, and returned
through deterministic opaque cursors. When a record is written in a Git
repository, `set_project_memory` captures the local `HEAD` by default. Reads
compare that provenance with the current local revision and label each record
`current`, `stale`, or `unknown`, with an aggregate `revision_summary`.
`scope` selects a bounded local namespace inside the same project and never
merges memory across project roots.
`search_mode` can use weighted field/phrase matching (`hybrid`) or simple token
matching (`lexical`). `set_project_memory` is the corresponding explicit
upsert/delete operation with optimistic concurrency via
`expected_updated_at`; it never executes or interprets stored text.

| Parameter          | Type            | Required | Default   | Description                            |
| ------------------ | --------------- | -------- | --------- | -------------------------------------- |
| `directory`        | string          | No       | `.`       | Project directory                      |
| `scope`            | string          | No       | `project` | Local namespace inside this project    |
| `query`            | string          | No       | `""`      | Search titles, bodies, tags and links  |
| `search_mode`      | enum            | No       | `hybrid`  | Weighted phrase/field or lexical match |
| `kind`             | enum            | No       | —         | Filter memory kind                     |
| `tags`             | string[]        | No       | `[]`      | Require all tags                       |
| `include_expired`  | boolean         | No       | `false`   | Include expired records                |
| `min_confidence`   | number          | No       | `0`       | Exclude lower-confidence records       |
| `limit` / `cursor` | number / string | No       | `50` / —  | Page bounded records                   |
| `redact_secrets`   | boolean         | No       | `true`    | Redact common inline secrets           |

For upserts, `capture_source_revision` defaults to `true` when no explicit
`source_revision` is supplied. Set it to `false` only for intentionally
revision-independent knowledge. Invalid `expires_at` values are rejected at
the input and persisted-state boundaries instead of becoming silently immortal
records. The 500-record store ceiling applies globally across scopes, and a
cross-process lock protects optimistic read/check/write updates.

#### set_project_memory

| Parameter                 | Type      | Required    | Default      | Description                                       |
| ------------------------- | --------- | ----------- | ------------ | ------------------------------------------------- |
| `directory`               | string    | No          | `.`          | Project directory                                 |
| `scope`                   | string    | No          | `project`    | Isolated local namespace                          |
| `operation`               | enum      | **Yes**     | —            | `upsert` or `delete`                              |
| `id`                      | string    | **Yes**     | —            | Stable record identifier                          |
| `kind`                    | enum      | Upsert      | —            | `decision`, `constraint`, `fact`, `todo`, `note`  |
| `title` / `body`          | string    | Upsert      | —            | Memory title and bounded body                     |
| `tags` / `links`          | arrays    | No          | `[]`         | Normalized tags and typed relationships           |
| `source_revision`         | string    | No          | current HEAD | Explicit local Git revision                       |
| `capture_source_revision` | boolean   | No          | `true`       | Capture local `HEAD` when no revision is supplied |
| `expires_at`              | date-time | No          | —            | Optional expiry                                   |
| `confidence`              | number    | No          | `0.7`        | Confidence from 0 to 1                            |
| `expected_updated_at`     | string    | No          | —            | Optimistic concurrency guard                      |
| `redact_secrets`          | boolean   | No (upsert) | `true`       | Redact before persistence                         |

### get_project_catalog / refresh_project_catalog

`refresh_project_catalog` persistently indexes metadata-only documentation
artifacts and their typed links. `get_project_catalog` queries that local
catalog with pagination and can opt into bounded, redacted document content.
The catalog is isolated per project and carries a deterministic source revision.
Both operations accept a bounded local `scope` (default `project`); custom
scopes use separate `.src-index/artifacts-catalog-<scope>.json` files and never
cross project roots. Catalog search accepts `search_mode: "hybrid"` for a
weighted phrase/field score or `"lexical"` for the stable token score.

`get_project_catalog` accepts `directory`, `scope`, `query`, `search_mode`, an
optional artifact `kind`, `limit` (default `50`), opaque `cursor`,
`include_content` (default `false`), `max_content_bytes` (default `4000`), and
`redact_secrets` (default `true`). `refresh_project_catalog` accepts
`directory`, `scope`, and `max_files` (default and maximum `1000`).

### get_git_context

Read-only local Git context: status, bounded diff, optional history/blame,
CODEOWNERS and changed-symbol mapping. With `include_hotspots: true`, it also
aggregates bounded historical file churn (commits, additions, deletions and
binary changes). Supplying both `compare_from` and `compare_to` returns a
bounded comparison of two local commits or refs, resolved to immutable commit
IDs. Paths are project-relative and Git is invoked without a shell; no remote
refs, lazy fetches, hooks, builds or project commands are run. Revision ranges
and reflog expressions are rejected.

Core controls are `files` (default `[]`), `include_status`/`include_diff`
(default `true`), `include_history`/`include_blame` (default `false`),
`include_codeowners`/`include_changed_symbols` (default `true`),
`max_diff_bytes` (`50000`), `max_history` (`20`), `max_blame_lines` (`200`),
and `redact_secrets` (`true`). Hotspot/comparison controls are:

| Parameter                     | Type    | Required | Default | Description                                       |
| ----------------------------- | ------- | -------- | ------- | ------------------------------------------------- |
| `include_hotspots`            | boolean | No       | `false` | Aggregate local file churn across recent commits  |
| `max_hotspots`                | number  | No       | `25`    | Maximum ranked hotspot files                      |
| `compare_from` / `compare_to` | string  | Together | —       | Local revisions to compare; no ranges/remotes     |
| `max_compare_files`           | number  | No       | `100`   | Maximum files returned by the revision comparison |

### manage_index_snapshots

Create, list, restore and clean local `.src-index-snapshots` snapshots. Listing
reports validity, and restore verifies every hash before replacement. The
required `operation` is `snapshot`, `list`, `restore`, or `cleanup`.
`max_snapshot_bytes` defaults to 500 MiB and `list_limit` to `50`; restore also
requires `snapshot_id` and uses `backup_current: true`; cleanup uses
`max_snapshots: 10` and `max_total_bytes: 500 MiB`. Quotas and file counts are
enforced, snapshot IDs are validated, and no project code is executed.

### maintain_index

Inspect, compact, or migrate the local LanceDB index. `inspect` reports table
versions, fragments, indices, storage bytes, manifest format, and metadata
compatibility without creating an index. `compact` runs the local LanceDB
optimizer with an explicit version-retention window and optional removal of
unverified fragments. `migrate` performs the installed LanceDB runtime's
idempotent local manifest-path migration when supported. Take a verified
`manage_index_snapshots` snapshot before maintenance that may prune versions;
the tool never executes project code.

| Parameter                 | Type    | Required | Default   | Description                                     |
| ------------------------- | ------- | -------- | --------- | ----------------------------------------------- |
| `directory`               | string  | No       | `.`       | Project directory                               |
| `operation`               | enum    | No       | `inspect` | `inspect`, `compact`, or `migrate`              |
| `cleanup_older_than_days` | number  | No       | `7`       | Version retention window for `compact` (0–3650) |
| `delete_unverified`       | boolean | No       | `false`   | Remove unverified fragments during compaction   |

### run_static_analysis

Optionally adapt locally installed `ast-grep`, Semgrep or CodeQL in read-only
mode. Set `SRC_STATIC_ANALYSIS_ENABLED=true` to opt in. Pattern queries remain
available, and `rule_file` accepts an existing project-relative ast-grep or
Semgrep rule file, including Semgrep taint rules and ast-grep relational rules.
CodeQL uses the existing local `database` + `query_file` path and can therefore
run local path/data-flow queries when the installed database and query support
them. Rule files, databases and queries are never downloaded or executed as
project scripts; all subprocess arguments are fixed and non-shell. Missing
tools produce a safe availability result rather than an installation or network
action.

All variants accept `directory`, optional project-relative `paths`,
`max_results` (`100`), `timeout_ms` (`15000`), and `redact_secrets` (`true`).
Pattern mode requires `backend: "ast-grep" | "semgrep"`, `pattern`, and
`language`; rules-file mode replaces the latter two with `rule_file`; CodeQL
mode requires `backend: "codeql"`, `database`, and `query_file`.

### import_scip_index

Import a local `index.scip`/JSON export or use a locally installed `scip` CLI to
build a bounded navigation catalog. The catalog is content-hashed and stored
inside the project index; it is never uploaded. `index_file` defaults to
`index.scip`, `format` accepts `auto`, `json`, or `cli` (default `auto`), and
`timeout_ms` defaults to `15000` with a maximum of `60000`.

### get_observability

Read bounded, process-local observability without exporting telemetry. The
structured JSON form contains tool call counters, recent latency percentiles,
runtime memory counters, and the optional secret-free local audit status. Use
`format: "prometheus"` to receive a deterministic Prometheus text exposition
in the `data.prometheus` field; no source text, arguments, tokens, or remote
addresses are recorded.

| Parameter   | Type                  | Required | Default | Description                              |
| ----------- | --------------------- | -------- | ------- | ---------------------------------------- |
| `directory` | string                | No       | `.`     | Project whose local audit status is read |
| `format`    | `json` / `prometheus` | No       | `json`  | Output representation                    |

---

## CLI Reference

**Every MCP tool is also a CLI command.** You can use SRC from your terminal without any AI assistant.

### General Usage

```bash
src-mcp <command> [options]
src-mcp --help                  # Show all commands
src-mcp <command> --help        # Show command options
```

CLI values are validated by the same Zod schema as MCP calls. Numeric options
are converted to numbers, enum choices are checked before execution, and array
options accept either JSON (recommended when values contain commas) or a
comma-separated list:

```bash
src-mcp index_codebase --concurrency 8 --exclude '["dist/**","vendor/**"]'
src-mcp set_project_memory --operation upsert --id auth-note --tags auth,bug
```

Object and tuple options, when exposed by a feature, must be valid JSON. CLI
commands use the same execution, audit, output-schema validation, safe-error,
and output-size limits as MCP calls. Feature commands write the complete stable
result envelope (`schema_version`, `success`, `meta`, and optional `data`,
`message`, or `error`) as plain JSON: successes go to stdout, failures to
stderr with a non-zero exit code. This keeps output machine-readable and avoids
discarding `data` when a feature also returns a human-readable `message`.

Or with npx:

```bash
npx -y src-mcp <command> [options]
```

### Commands

```bash
# Start MCP server (auto-indexes if needed, watches for changes)
src-mcp serve
src-mcp serve --no-watch        # Disable file watcher

# Optional local Streamable HTTP transport
src-mcp serve --transport http --port 3000
# For a remote bind behind a trusted TLS proxy, also set
# MCP_HTTP_BEARER_TOKEN, MCP_HTTP_ALLOWED_HOSTS, SRC_ALLOWED_ROOTS, and
# MCP_HTTP_ALLOW_INSECURE_REMOTE=true.

# Index a codebase manually
src-mcp index_codebase
src-mcp index_codebase --concurrency 8
src-mcp index_codebase --force   # Re-index even if index exists

# Search indexed code
src-mcp search_code --query "authentication"
src-mcp search_code --query "error handling" --limit 20 --mode hybrid
src-mcp search_code --query "UserService" --mode fts  # Exact keyword search

# Update index incrementally
src-mcp update_index
src-mcp update_index --dryRun   # Preview changes only

# Inspect or maintain the local LanceDB index
src-mcp maintain_index --operation inspect
src-mcp maintain_index --operation compact --cleanup_older_than_days 7
src-mcp maintain_index --operation migrate

# Check index status
src-mcp get_index_status

# Server information
src-mcp get_server_info --format json

# Orient and inspect a task
src-mcp get_repository_map --max_tokens 2000
src-mcp assemble_task_context --task "trace authentication failures"
src-mcp get_changed_symbols
src-mcp get_project_artifacts --query "architecture"
```

---

## Configuration

### Environment Variables

All settings can be configured via environment variables:

| Variable                            | Description                                              | Default                          |
| ----------------------------------- | -------------------------------------------------------- | -------------------------------- |
| `OLLAMA_BASE_URL`                   | Loopback-only Ollama API endpoint                        | `http://localhost:11434`         |
| `EMBEDDING_PROVIDER`                | `ollama` or `lexical`                                    | `ollama`                         |
| `EMBEDDING_MODEL`                   | Model for embeddings                                     | `nomic-embed-text`               |
| `EMBEDDING_DIMENSIONS`              | Vector dimensions (1–16384)                              | `768`                            |
| `CHUNK_SIZE`                        | Characters per chunk (1–100000)                          | `1000`                           |
| `CHUNK_OVERLAP`                     | Overlap, clamped below chunk size                        | `200`                            |
| `EMBEDDING_BATCH_SIZE`              | Batch size for embedding (1–256)                         | `10`                             |
| `ENRICHMENT_CROSS_FILE`             | Include resolved cross-file context in embeddings        | enabled                          |
| `ENRICHMENT_MAX_IMPORTS`            | Maximum imports resolved per enriched file (1–100)       | `10`                             |
| `ENRICHMENT_MAX_SYMBOLS_PER_IMPORT` | Maximum symbols included per resolved import (1–100)     | `5`                              |
| `SRC_ALLOWED_ROOTS`                 | Allowed project roots separated by `;` or `,`            | unset (required for remote HTTP) |
| `SRC_MAX_FILE_BYTES`                | Maximum source file size read/indexed (hard max 128 MiB) | `10485760`                       |
| `SRC_MAX_RESULT_BYTES`              | Maximum serialized MCP tool result                       | `2097152`                        |
| `SRC_TOOL_ALLOWLIST`                | MCP tool names separated by `,` or `;`                   | unset (all tools)                |
| `SRC_TOOL_PROFILE`                  | `full`, `readonly`, or `minimal`                         | `full`                           |
| `SRC_LSP_ENABLED`                   | Enable allow-listed local language-server navigation     | enabled                          |
| `SRC_LSP_SESSION_CACHE`             | Reuse local LSP sessions between navigation calls        | enabled                          |
| `SRC_LSP_IDLE_MS`                   | Idle TTL for cached LSP sessions (1s–10min)              | `15000`                          |
| `SRC_STATIC_ANALYSIS_ENABLED`       | Enable local ast-grep/Semgrep/CodeQL adapters            | disabled                         |
| `SRC_AUDIT_LOG`                     | Persist bounded, secret-free local audit events          | disabled                         |
| `MCP_TASKS`                         | Enable the current Tasks extension                       | enabled                          |
| `MCP_TASK_TOOLS`                    | Task-enabled tools separated by `,` or `;`               | index/update                     |
| `MCP_TASK_STORE_DIR`                | Directory for atomic task state                          | OS temp directory                |
| `MCP_TASK_TTL_MS`                   | Task TTL in milliseconds, or `none`                      | `86400000`                       |
| `MCP_TASK_POLL_INTERVAL_MS`         | Suggested task polling interval                          | `1000`                           |
| `MCP_TASK_MAX_ACTIVE`               | Maximum active asynchronous tasks                        | `8`                              |
| `MCP_TASK_MAX_RESULT_BYTES`         | Maximum persisted task result size                       | `1048576`                        |
| `LOG_LEVEL`                         | Log verbosity                                            | `info`                           |
| `NODE_ENV`                          | Exported development/production runtime flags            | unset                            |

### HTTP transport variables

HTTP is opt-in; stdio remains the default and the safest local integration.

| Variable                  | Description                                                         | Default     |
| ------------------------- | ------------------------------------------------------------------- | ----------- |
| `MCP_HTTP_HOST`           | Bind host                                                           | `127.0.0.1` |
| `MCP_HTTP_PORT`           | Bind port                                                           | `3000`      |
| `MCP_HTTP_BEARER_TOKEN`   | Static bearer token; required for non-loopback                      | unset       |
| `MCP_HTTP_ALLOWED_HOSTS`  | Hostnames allowed for remote Host/Origin checks                     | bind host   |
| `MCP_HTTP_ALLOW_INSECURE_REMOTE` | Explicit opt-in for a non-loopback HTTP listener behind a trusted TLS proxy | `false` |
| `MCP_HTTP_MAX_BODY_BYTES` | Maximum HTTP request body, including chunked data (hard max 16 MiB) | `2097152`   |
| `MCP_HTTP_MAX_CONCURRENT` | Maximum concurrent HTTP requests (hard max 256)                     | `16`        |
| `MCP_HTTP_LEGACY`         | `stateless` compatibility or `reject` modern-only                   | `stateless` |
| `MCP_HTTP_RESPONSE_MODE`  | `auto`, `json`, or `sse`                                            | `auto`      |

Example authenticated local client URL:

```text
http://127.0.0.1:3000/mcp
Authorization: Bearer <MCP_HTTP_BEARER_TOKEN>
```

The server validates localhost Host/Origin headers, refuses unauthenticated
remote binds, requires `SRC_ALLOWED_ROOTS` and explicit TLS termination for any
non-loopback bind, caps
request size/concurrency, and never logs the bearer token.
Every serialized tool response is also bounded by `SRC_MAX_RESULT_BYTES`
(default 2 MiB, hard maximum 16 MiB); oversized or unserializable results fail
closed with a safe error instead of returning an unbounded payload.
HTTP body limits are capped at 16 MiB and concurrent requests at 256 even when
environment variables are misconfigured.

Ollama is used only through its local endpoint by default. The lexical provider
is fully in-process and does not require the optional local Ollama service. SRC does not
install, fetch, or invoke a remote service as part of indexing or analysis.

**Example:**

```bash
EMBEDDING_PROVIDER=lexical SRC_AUDIT_LOG=1 src-mcp serve
```

### Package API

The package exports a side-effect-free programmatic API. Importing `src-mcp`
does not start stdio or HTTP; use the executable or call an explicit start
function instead:

```typescript
import { createServer, startHttpServer } from "src-mcp";

const server = createServer();
const http = await startHttpServer({ host: "127.0.0.1", port: 3000 });
```

The `src-mcp` executable and `src-mcp serve` remain the supported CLI entry
points for Claude Desktop and other MCP clients.

### MCP Client Configuration

**Claude Desktop** (`claude_desktop_config.json`):

**With global installation:**

```json
{
  "mcpServers": {
    "src-mcp": {
      "command": "src-mcp",
      "args": ["serve"]
    }
  }
}
```

**With npx:**

```json
{
  "mcpServers": {
    "src-mcp": {
      "command": "npx",
      "args": ["-y", "src-mcp", "serve"]
    }
  }
}
```

**With the service-free local lexical provider:**

```json
{
  "mcpServers": {
    "src-mcp": {
      "command": "src-mcp",
      "args": ["serve"],
      "env": { "EMBEDDING_PROVIDER": "lexical" }
    }
  }
}
```

### Index Storage

Indexes are stored in `.src-index/` directory within each indexed project:

```
my-project/
├── src/
├── .src-index/              # Created by SRC
│   ├── code_chunks.lance/   # LanceDB table data and manifests
│   ├── call-graph.json      # Call graph cache
│   ├── metadata.json        # Provider/model/dimension/source fingerprint
│   ├── .src-index-hashes.json  # File hash cache
│   ├── project-memory.json   # Optional explicit project memory
│   ├── artifacts-catalog.json # Optional documentation catalog
│   └── scip-catalog.json     # Optional imported local SCIP catalog
├── .src-index-snapshots/     # Local verified index backups
└── ...
```

Add `.src-index/` to your `.gitignore`:

```gitignore
.src-index/
```

---

## Supported Languages

### Full AST Support (18 languages)

These parser modes use Tree-sitter WASM for AST extraction, symbol-aware chunking, imports, exports, and best-effort static call-graph analysis.

| Category       | Language   | Extensions                                            |
| -------------- | ---------- | ----------------------------------------------------- |
| **Web**        | JavaScript | `.js` `.jsx` `.mjs` `.cjs`                            |
|                | TypeScript | `.ts` `.mts` `.cts`                                   |
|                | TSX        | `.tsx`                                                |
|                | HTML       | `.html` `.htm` `.xhtml`                               |
|                | Svelte     | `.svelte`                                             |
| **Systems**    | C          | `.c` `.h`                                             |
|                | C++        | `.cpp` `.hpp` `.cc` `.hh` `.cxx` `.hxx` `.c++` `.h++` |
|                | Rust       | `.rs`                                                 |
|                | Go         | `.go`                                                 |
| **Enterprise** | Java       | `.java`                                               |
|                | C#         | `.cs` `.csx`                                          |
|                | Kotlin     | `.kt` `.kts`                                          |
|                | Scala      | `.scala` `.sc`                                        |
| **Scripting**  | Python     | `.py` `.pyi` `.pyw`                                   |
|                | Ruby       | `.rb` `.rake` `.gemspec`                              |
|                | PHP        | `.php` `.phtml` `.php3` `.php4` `.php5` `.phps`       |
| **Functional** | OCaml      | `.ml` `.mli`                                          |
|                | Swift      | `.swift`                                              |

### Language-aware text fallback (5 modes)

These configured modes use LangChain language-specific separators:

| Language         | Extensions        |
| ---------------- | ----------------- |
| Markdown         | `.md` `.markdown` |
| LaTeX            | `.tex` `.ltx`     |
| reStructuredText | `.rst`            |
| Solidity         | `.sol`            |
| Protocol Buffers | `.proto`          |

### Generic text fallback (32 modes)

The remaining configured text modes use the generic recursive splitter:

| Category           | Extensions                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Config/data**    | `.json` `.yaml` `.yml` `.toml` `.ini` `.cfg` `.conf` `.env` `.xml` `.csv` `.txt` `.log`                                      |
| **Shell**          | `.sh` `.bash` `.zsh` `.fish` `.bat` `.cmd`                                                                                   |
| **Styles**         | `.css` `.scss` `.sass` `.less`                                                                                               |
| **Queries/DevOps** | `.sql` `.graphql` `.gql` `.tf` `.hcl` `Dockerfile*` `Makefile` `CMakeLists.txt`                                              |
| **Languages**      | `.zig` `.nim` `.lua` `.r` `.dart` `.ex` `.exs` `.erl` `.hrl` `.hs` `.lhs` `.clj` `.cljs` `.cljc` `.lisp` `.el` `.vim` `.vue` |

The canonical list is `assets/languages.json`: currently 99 case-insensitive extensions and 18 exact special filenames. Unknown extensions are not collected for indexing.

### Auto-excluded Files

Binary files and generated directories are automatically excluded:

- **Binaries:** `.exe` `.dll` `.so` `.png` `.jpg` `.mp3` `.zip` `.wasm`
- **Build outputs:** `.pyc` `.class` `.o` `dist/` `node_modules/`

---

## How It Works

### Indexing Pipeline

```
Source Files → Secure Scan → Semantic Chunking → AST Enrichment → Cross-file Context → Embeddings → LanceDB
                    ↓                    ↓                  ↓                 ↓
              Split at symbol      Extract symbols    Resolve imports    nomic-embed-text
              boundaries           and metadata       and aliases        768 dimensions
```

**Steps:**

1. **Secure scan** — Find supported, non-sensitive files under the project root (respects `.gitignore`, symlink containment, and file-size caps)
2. **Chunk** — Split code at function/class boundaries (1000 chars, 200 overlap)
3. **Enrich** — Add AST metadata (symbols, imports, exports)
4. **Resolve** — Resolve cross-file imports and TypeScript path aliases
5. **Embed** — Generate vectors via Ollama or the local lexical provider
6. **Store** — Save to LanceDB with vector, full-text, and versioned metadata
7. **Cache** — Atomically store file hashes for incremental updates

### Search Pipeline

```
Query → Embed Query → Vector Search ─┐
                                     ├→ RRF Fusion → Add Call Context → Results
Query → Tokenize ───→ BM25 Search ───┘
```

**Steps:**

1. **Embed** — Convert query to vector using same model
2. **Vector Search** — Find semantically similar chunks (cosine similarity)
3. **BM25 Search** — Find keyword matches (term frequency)
4. **RRF Fusion** — Combine rankings with Reciprocal Rank Fusion (k=60)
5. **Lexical rerank** — Boost exact identifiers, symbols, and path matches
6. **Call Context** — Add caller/callee information from call graph
7. **Filter and redact** — Apply language/path/symbol/test filters and redact
   common inline secrets when requested
8. **Return** — Ranked, bounded results with index metadata

### Technical Specifications

| Component              | Specification                                  |
| ---------------------- | ---------------------------------------------- |
| **Embedding Provider** | Ollama or deterministic lexical fallback       |
| **Embedding Model**    | nomic-embed-text (137M params, Ollama default) |
| **Vector Dimensions**  | 768                                            |
| **Chunk Size**         | 1000 characters                                |
| **Chunk Overlap**      | 200 characters                                 |
| **Batch Size**         | 10 embeddings per request                      |
| **RRF Constant**       | k=60                                           |
| **Vector Database**    | LanceDB (embedded)                             |

### Reproducible benchmark

Measure the actual `index_codebase` and `search_code` implementation, including
native LanceDB, FTS, hybrid/vector retrieval, reranking and output formatting:

```bash
bun run benchmark:retrieval -- --iterations=3 --k=5 \
  --min-recall-at-k=1 --min-mrr=0.95 --min-ndcg-at-k=0.95
```

The default is the in-process lexical provider. With an already installed,
running local Ollama model, add `--provider=ollama --model=nomic-embed-text`.
Nothing is downloaded. The runner copies the selected corpus to a disposable
directory, builds a fresh index and evaluates 24 labelled queries across 12
files (`benchmarks/retrieval-engine.json`). Each mode reports ranking metrics,
warm p50/p95, index time, sampled peak RSS and returned-context cost. Latency
excludes MCP transport and call-graph enrichment. Duplicated file chunks consume
ranking positions but do not earn repeated relevance credit. A truncated corpus
is reported explicitly and labels must refer to files actually included.

This small fixture is a regression gate, not a general quality or large-repository
performance claim. Use `--directory` and `--dataset` for a representative corpus.
CI runs the native engine gate with the lexical provider; Ollama is optional.

Run a bounded, local benchmark for semantic chunking and the deterministic
lexical baseline (separate from the native retrieval engine):

```bash
bun run benchmark -- --directory=src --iterations=3 --max-files=100
```

The JSON report contains p50/p95 latency, processed bytes/files/chunks, vector
dimensions, resident memory, and a conservative estimated token cost. To
compute deterministic file-level `precision@k`, `recall@k`, MRR, nDCG, and
returned-context cost against a labelled corpus, use:

```bash
bun run benchmark -- --directory=src --iterations=3 --max-files=100 \
  --dataset=benchmarks/retrieval.json --k=5
```

The sample corpus is versioned in `benchmarks/retrieval.json`; replace it with
queries and relative file IDs from your own repositories for meaningful quality
tracking. Token counts are estimates (`UTF-8 bytes / 4`), not claims about a
specific tokenizer. A 12-query golden corpus across 12 language/file families
is versioned in `benchmarks/golden-multilang` with its labels in
`benchmarks/golden-multilang.json`. CI runs it with strict
precision/recall/MRR/nDCG gates. You can apply the same gates to a local corpus
with `--min-precision-at-k`, `--min-recall-at-k`, `--min-mrr`, and
`--min-ndcg-at-k`; a failed gate returns a non-zero exit code while preserving
the JSON report.

### Release validation

Before publishing, validate the built package from a clean temporary install:

```bash
bun run pack:verify
bun run conformance:local
```

Maintain the `CHANGELOG.md` `Unreleased` section while developing. Before
merging the release commit, rename it to the package version with its
`YYYY-MM-DD` date and add a fresh `Unreleased` section. The notes follow the six
Keep a Changelog categories (`Added`, `Changed`, `Deprecated`, `Removed`,
`Fixed`, and `Security`), are maintained manually with AI assistance, and are
reviewed as project documentation. `bun run changelog:check` and the release
workflow validate the structure; neither generates or commits release notes.

`conformance:local` checks the exact tool/resource/prompt surface and the
stdio/HTTP × legacy/modern lifecycle matrix without contacting a remote MCP
service or downloading a test runner.

The runtime CI matrix targets Node 22/24 on Windows, macOS and Linux with native
storage tests, local MCP conformance, build and clean package installation.
Release automation publishes npm before creating its GitHub release and checks
each destination independently, so reruns can complete a partial publication.

The dependency-free mutation smoke runs a small, versioned set of pagination
security mutants against temporary repository copies:

```bash
bun run mutation:smoke
```

The CI job also runs a bounded official MCP compatibility smoke suite on Linux;
the current upstream runner is skipped on Windows because it exits with a
libuv teardown assertion after successful checks. Modern 2026-07-28 lifecycle
coverage is exercised by the local integration tests. The smoke runner pins
the currently validated npm package by default; override
`MCP_CONFORMANCE_VERSION` and `MCP_CONFORMANCE_SPEC_VERSION` together when a
new official runner supports a newer protocol revision.

### Test and coverage gates

Run the full local quality gate with:

```bash
bun run check
bun run contract:verify
bun run test
bun run test:coverage
bun run build
bun run pack:verify
bun run conformance:local
```

`contract:verify` fingerprints the reviewed feature schemas and annotations,
MCP tools, CLI commands, prompts, resources, public exports, and default
configuration. This makes clean-code refactors fail fast if they accidentally
remove or alter a capability. Biome applies the repository formatter and lint
rules consistently across source and tooling.

The coverage gate requires at least 80% for lines, statements and functions,
and 70% for branches. LSP and ast-grep/Semgrep/CodeQL adapters are optional
local subprocess integrations; their executable and protocol failure matrix is
kept in integration/safe-degradation tests and excluded from this aggregate
unit threshold. This is an explicit measurement boundary, not an assertion
that those adapters have exhaustive branch coverage.

### Dependency audit

`bun.lock` is the dependency lockfile of record. CI runs `bun audit
--production` against the installed production dependency graph before build
and publication. Keep that check green when updating dependencies; `npm audit`
would require a separate `package-lock.json` for this Bun-managed workspace.

---

## Comparison

### SRC vs Basic Code Search MCPs

| Feature                    | SRC                                                                                                  | Basic MCPs                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------- |
| **Search Method**          | Hybrid (Vector + BM25 + RRF)                                                                         | Keyword only or basic embedding |
| **Call Graph**             | Static caller/callee context                                                                         | None                            |
| **Symbol Navigation**      | LSP/SCIP definitions, references, implementations, hover, hierarchy, diagnostics, plus safe fallback | Usually absent                  |
| **Dependency Analysis**    | Cycles, hotspots, blast radius                                                                       | Usually absent                  |
| **Repository Orientation** | PageRank-style repo map plus fair-budget, multi-layer agent dossier                                  | Usually absent                  |
| **Change Analysis**        | Changed files/symbols and conservative dead code                                                     | Usually absent                  |
| **Cross-file Context**     | Resolves imports & path aliases                                                                      | None                            |
| **Incremental Updates**    | SHA-256 hash detection                                                                               | Full re-index required          |
| **Local Memory**           | Scoped atomic memory with confidence, expiry, links, Git provenance, and stale-state detection       | Usually absent or plain notes   |
| **Local Security**         | Root containment, secret exclusion, type-aware redaction, limits, injection signals, audit metadata  | Varies                          |
| **AST Languages**          | 18 with Tree-sitter WASM                                                                             | Few or none                     |
| **Configured Modes**       | 55 (99 extensions)                                                                                   | Limited                         |

### Key Advantages

1. **Hybrid Search** — Combines semantic understanding with keyword precision
2. **Call Graph** — Understand code relationships, not just content
3. **Cross-file Resolution** — Follows resolvable local imports and TypeScript path aliases
4. **Incremental Updates** — Only re-index what changed
5. **Semantic Chunking** — Splits at symbol boundaries, not arbitrary lines
6. **Production MCP contract** — SDK v2, strict structured outputs, pagination,
   annotations, progress/cancellation, cache hints, resources/prompts, and
   local stdio by default

---

## Explicit boundaries

SRC is production-hardened, but no static code-intelligence server can promise
mathematical perfection. The current boundaries are deliberate:

- Long operations expose progress and cancellation, and the current MCP Tasks
  extension provides polling for the configured indexing tools. The TypeScript
  SDK v2 does not provide the old 2025 `TaskStore` runtime, so SRC owns a
  narrowly scoped current-extension store rather than importing removed APIs.
- Type hierarchy and call/dependency resolution are syntax-aware approximations;
  dynamic dispatch, generated code, reflection, and compiler-only symbol facts
  can remain unresolved.
- Each index is scoped to one secure project root. `SRC_ALLOWED_ROOTS` supports
  multiple independently indexed roots; `list_projects` discovers them, but it
  is not a single merged cross-project index.
- An explicit project root further restricts `SRC_ALLOWED_ROOTS`; a broad allowed
  parent never authorizes access to a sibling project within a scoped operation.
- Watcher startup reconciles files changed, added or removed while offline.
  Shutdown drains queued work and performs a final scan. Search pagination uses
  a fixed pool of 500 retrieval candidates and invalidates cursors when the
  LanceDB snapshot or index metadata changes. A reached candidate or neighbor bound sets `truncated` even
  when no further cursor is available. Refine the query to explore beyond it.
- FTS indexes are reused across connections. Its lexical fallback streams the
  complete corpus and retains only its top-k candidates; scan time still grows
  with corpus size.
- Byte snippets reject a start offset inside a UTF-8 character and round the end
  down to a complete character, with exact returned offsets and truncation.
- On Windows, allow-listed npm TypeScript/Pyright language servers are launched
  through Node using their verified package entry point; native `.exe` binaries
  remain supported. No shell is invoked.
- The benchmark reports reproducible latency and memory. Retrieval
  precision/recall/MRR/nDCG is only meaningful when the labelled corpus matches
  the repository and ranking configuration under test; token cost is an
  estimate, not a tokenizer billing figure.
- LSP, SCIP, ast-grep, Semgrep, CodeQL and Ollama are optional local integrations;
  SRC never downloads them, executes project code, or silently falls back to a
  remote provider. The in-process lexical provider is the zero-service mode.

These limits are returned or surfaced through diagnostics instead of being
silently presented as stronger guarantees.

---

## Troubleshooting

### Ollama Connection Failed

```
Error: Ollama is not available
```

**Solution:**

1. Ensure Ollama is running: `ollama serve`
2. Check the URL: `curl http://localhost:11434/api/tags`
3. If Ollama uses another local port, set `OLLAMA_BASE_URL` to a loopback URL
4. Or use the no-service fallback: `EMBEDDING_PROVIDER=lexical`

### Model Not Found

```
Error: model 'nomic-embed-text' not found
```

**Solution:**

```bash
ollama pull nomic-embed-text
```

### Index Already Exists

```
Error: Index already exists. Use force=true to re-index.
```

**Solution:**

- Use `force: true` parameter to re-index
- Or use `update_index` for incremental updates

### No Results Found

**Possible causes:**

1. Query too specific — try broader terms
2. Wrong directory — check `directory` parameter
3. Files excluded — check `.gitignore` patterns

### Slow Indexing

**Solutions:**

1. Increase concurrency: `--concurrency 8`
2. Exclude large directories: `--exclude node_modules --exclude dist`
3. Use faster storage (SSD)

---

## Links

### Project

- [GitHub Repository](https://github.com/kvnpetit/structured-repo-context-mcp)
- [npm Package](https://www.npmjs.com/package/src-mcp)
- [Report Issues](https://github.com/kvnpetit/structured-repo-context-mcp/issues)
- [Changelog](./CHANGELOG.md)
- [Architecture Guide](./ARCHITECTURE.md)
- [Contributing Guide](./CONTRIBUTING.md)

### External

- [MCP Specification](https://modelcontextprotocol.io/specification)
- [MCP 2026-07-28 update](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [TypeScript MCP SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [GitHub MCP Server](https://github.com/github/github-mcp-server)
- [Serena](https://github.com/oraios/serena)
- [code-cortex-mcp](https://github.com/tigercosmos/code-cortex-mcp)
- [codesight-mcp](https://github.com/cmillstead/codesight-mcp)
- [semantic-code-mcp](https://github.com/smallthinkingmachines/semantic-code-mcp)
- [Ollama](https://ollama.com)
- [LanceDB](https://lancedb.com)
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)

---

## License

[MIT](./LICENSE) © 2026 kvnpetit

---

<div align="center">

**Ready to supercharge your AI coding experience?**

```bash
npm install -g src-mcp && src-mcp serve
# or
npx -y src-mcp serve
```

[Report Bug](https://github.com/kvnpetit/structured-repo-context-mcp/issues) · [Request Feature](https://github.com/kvnpetit/structured-repo-context-mcp/issues)

</div>
