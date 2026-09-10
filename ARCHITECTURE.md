# Architecture Guide

> Technical reference for SRC (Structured Repo Context) internals.

This document covers the internal architecture, project structure, and development patterns. For user documentation, see [README.md](./README.md).

---

## Table of Contents

1. [Project Structure](#project-structure)
2. [Architecture Overview](#architecture-overview)
3. [Core Components](#core-components)
4. [Feature System](#feature-system)
5. [Data Flow](#data-flow)
6. [Supported Languages](#supported-languages)
7. [Testing](#testing)
8. [Development Workflow](#development-workflow)
9. [Release Process](#release-process)
10. [Naming Conventions](#naming-conventions)

---

## Project Structure

```
src/
├── index.ts              # MCP stdio entry point
├── bin.ts                # CLI entry point
├── public.ts             # Side-effect-free package API entry point
├── server.ts             # MCP v2 server configuration + stdio
├── http.ts               # Optional Streamable HTTP adapter/auth/limits
│
├── features/             # Business logic (exposed as MCP tools + CLI)
│   ├── index.ts          # Feature registry
│   ├── types.ts          # Feature and FeatureResult interfaces
│   ├── runtime.ts        # Shared execution, validation, audit, and envelopes
│   ├── utils/            # Shared feature utilities
│   │
│   ├── info/             # get_server_info
│   ├── index-codebase/   # index_codebase
│   ├── search-code/      # search_code
│   ├── update-index/     # update_index
│   ├── get-index-status/ # get_index_status
│   ├── get-call-graph/   # get_call_graph
│   ├── find-symbols/     # find_symbols
│   ├── dependency-graph/ # get_dependency_graph
│   ├── code-snippet/     # get_code_snippet
│   ├── analyze-impact/   # analyze_impact
│   ├── diagnostics/      # get_diagnostics
│   ├── observability/    # get_observability
│   ├── list-projects/     # list_projects
│   ├── repository-map/    # get_repository_map
│   ├── symbol-at-position/# get_symbol_at_position
│   ├── assemble-task-context/ # assemble_task_context
│   ├── find-dead-code/    # find_dead_code
│   ├── changed-symbols/   # get_changed_symbols
│   ├── project-artifacts/ # get_project_artifacts
│   ├── project-context/   # get_project_context
│   ├── project-memory/    # get/set_project_memory
│   ├── project-catalog/   # get/refresh_project_catalog
│   ├── git-context/       # get_git_context
│   ├── symbol-graph/      # get_symbol_graph (loader/signals/analysis split)
│   ├── semantic-navigation/ # semantic_navigation
│   ├── index-snapshots/   # manage_index_snapshots (schema/summaries split)
│   ├── static-analysis/   # run_static_analysis
│   ├── scip-import/       # import_scip_index
│   │
│   ├── analyze-file/     # analyze_file
│   ├── parse-ast/        # parse_ast
│   ├── query-code/       # query_code
│   └── list-symbols/     # list_symbols
│
├── core/                 # Parsing and embedding engines
│   ├── embeddings/       # Embedding pipeline
│   │   ├── index.ts      # Public API exports
│   │   ├── client.ts     # Ollama + lexical embedding providers
│   │   ├── store.ts      # LanceDB facade and mutations
│   │   ├── store-search.ts   # Vector, FTS, lexical, and RRF search
│   │   ├── store-status.ts   # Status and maintenance inspection
│   │   ├── store-metadata.ts # Index compatibility metadata
│   │   ├── store-types.ts    # Store-specific contracts
│   │   ├── store-utils.ts    # Paths, records, fingerprints, locks
│   │   ├── hash-cache.ts # Incremental SHA-256 cache
│   │   ├── chunker.ts    # Semantic chunking
│   │   ├── enricher.ts   # AST enrichment
│   │   ├── crossfile.ts  # Bounded import context resolution
│   │   ├── callgraph.ts  # Call graph analysis
│   │   ├── callgraph-cache.ts   # Persistent graph cache
│   │   ├── callgraph-context.ts # Caller/callee presentation
│   │   ├── callgraph-types.ts   # Graph contracts
│   │   ├── watcher.ts    # Incremental filesystem watcher
│   │   ├── watcher-cache.ts    # Persistent watcher fingerprints
│   │   ├── watcher-indexing.ts # Shared indexing pipeline
│   │   └── types.ts      # Type definitions
│   │
│   ├── parser/           # Tree-sitter WASM parser
│   ├── symbols/          # Symbol extraction, imports, and hierarchy
│   ├── queries/          # Cached SCM engine and symbol queries
│   ├── unified/          # Unified parser and isolated language registry
│   ├── fallback/         # LangChain text splitter
│   ├── ast/              # AST type definitions
│   ├── security/         # Root containment, secret filtering, file limits
│   ├── navigation/       # Local LSP/SCIP protocol clients and catalogs
│   ├── git/              # Fixed-argument local Git adapter
│   ├── local-state/      # Versioned atomic project state and locks
│   ├── tasks/             # Current MCP Tasks extension + durable store
│   ├── evaluation/        # Labelled retrieval metrics and token estimates
│   ├── observability/     # Bounded metrics, local export, and secret-free audit
│   ├── utils/            # Asset loading, caching
│   └── constants.ts      # Configuration constants
│
├── tools/                # MCP tools adapter
│   ├── adapter.ts        # Feature → MCP Tool conversion
│   ├── contracts.ts      # Shared MCP schema and annotation mapping
│   └── index.ts          # Tool registration
│
├── resources/            # MCP resources
├── prompts/              # MCP prompts
│
├── cli/                  # CLI adapter
│   ├── adapter.ts        # Feature → CLI command conversion
│   ├── parser.ts         # Zod → citty args conversion
│   └── index.ts          # CLI setup
│
├── config/               # Configuration
│   └── index.ts          # EMBEDDING_CONFIG, ENRICHMENT_CONFIG
│
├── types/                # Shared TypeScript types
└── utils/                # Utilities (logger, colors, spinner)

assets/                   # Runtime assets
├── wasm/                 # Tree-sitter WASM parsers (18 files)
├── queries/              # SCM query files per language
└── languages.json        # Language configuration

bunfig.toml               # Bun install policy and isolated linker
biome.json                # Formatter and linter configuration
tsconfig.json              # Strict TypeScript project configuration
tsdown.config.ts          # Node 22 ESM bundle and declaration configuration

.src-index/               # Generated per project (gitignored)
├── code_chunks.lance/    # LanceDB table data and manifests
├── call-graph.json       # Call graph cache
├── metadata.json         # Schema/provider/model/dimension metadata
├── .src-index-hashes.json # File hash cache
├── project-memory.json   # Optional explicit agent memory
├── artifacts-catalog.json # Optional default-scope document catalog
└── scip-catalog.json     # Optional imported local SCIP catalog
```

---

## Architecture Overview

### Design Principles

1. **Feature-first** — Business logic lives in `features/`, adapters expose it
2. **Single source of truth** — Define once, use everywhere (MCP + CLI)
3. **Colocated tests** — `index.test.ts` next to `index.ts`
4. **Modular structure** — Feature folders colocate implementation and tests;
   shared internals may be nested when that keeps responsibilities isolated

### High-Level Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Entry Points                              │
├─────────────────────────────────────────────────────────────────┤
│  index.ts (MCP Server)              bin.ts (CLI)                │
│       │                                  │                       │
│       ▼                                  ▼                       │
│  tools/adapter.ts                   cli/adapter.ts              │
│  (Zod → MCP Schema)                 (Zod → citty args)          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
                  features/runtime.ts
          (execution, audit, validation, result envelope)
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    features/index.ts                             │
│                    (Feature Registry)                            │
├─────────────────────────────────────────────────────────────────┤
│  index_codebase  │  search_code  │  update_index  │  ...        │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      core/embeddings/                            │
├─────────────────────────────────────────────────────────────────┤
│  client.ts     │ store.ts       │ chunker.ts   │ enricher.ts   │
│  (Embeddings)  │ (LanceDB)      │ (Splitting)  │ (AST metadata)│
├─────────────────────────────────────────────────────────────────┤
│  callgraph.ts  │ watcher.ts     │ crossfile.ts │               │
│  (Call graph)  │ (Updates)      │ (Imports)    │               │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                       core/parser/                               │
├─────────────────────────────────────────────────────────────────┤
│  parser/       │ symbols/       │ queries/     │ unified/      │
│  (Tree-sitter) │ (Extraction)   │ (SCM)        │ (Fallback)    │
└─────────────────────────────────────────────────────────────────┘
```

The production retrieval path additionally classifies the query as
`identifier`, `concept`, or `mixed`, applies deterministic lexical reranking,
deduplicates overlapping chunks, separates signature/documentation/body parts,
and can abstain below a caller-provided confidence floor. Responses include
pagination, index freshness, coverage, provenance and bounded
`instruction_signals` metadata.

### Local navigation and persistent context

`semantic_navigation` selects a local SCIP catalog, an allow-listed local LSP,
or a bounded Tree-sitter/name fallback. LSP requests use JSON-RPC framing,
UTF-16 positions on input, UTF-8 byte offsets on output, root containment,
timeouts, cancellation, bounded 16 KiB headers/8 MiB messages, and no shell.
Oversized or malformed framing fails closed and terminates the local session.
`import_scip_index` stores only a bounded
hashed catalog under the project’s `.src-index` directory. Tree-sitter results
include the local grammar asset digest so syntax evidence can be reproduced
after a bundled grammar update.

Project context, artifact catalogs, memory, Git evidence, snapshots, and static
analysis are separate feature boundaries. They share the same path security,
redaction, output contracts, and local-only rule. Memory/catalog writes are
atomic and versioned; index snapshots verify hashes before replacing the index;
static analyzers are opt-in and invoked with fixed non-shell arguments. Git
history hotspots and revision comparisons resolve only local commits and never
enable a lazy fetch or accept a revision range.

`assemble_task_context` is the orchestration boundary for agent orientation. It
runs project discovery, memory retrieval, artifact retrieval, Git inspection,
repository mapping, and indexed search concurrently. A two-stage allocator
reserves an equal minimum share for every available layer, then distributes the
remaining budget by task value. This prevents one verbose layer from starving
the rest. Its `minimal`, `standard`, and `deep` profiles control breadth without
changing the strict total token ceiling. The result exposes per-layer evidence,
truncation, failures, and deterministic follow-up actions.

Project memory captures the current local Git `HEAD` on upsert unless disabled
or explicitly supplied. Reads classify provenance as `current`, `stale`, or
`unknown`; non-Git directories remain usable and report `unknown`. Confidence
floors and expiry filtering happen before pagination so cursors describe the
exact visible result set.

### Reliability and security boundaries

- `.src-index-write.lock` serializes index mutations across processes and
  recovers stale lock files; atomic writers prevent partial JSON state.
- Snapshot manifests pin file size and SHA-256; restores verify every file,
  enforce quotas, and create a recovery snapshot by default.
- Source text is always untrusted data. Secret redaction is bounded and
  configurable; instruction signals report detector metadata without returning
  matched excerpts. Optional audit records contain only timing, outcome, and a
  project-safe identifier.
- Secure file reads use a descriptor and `fstat`/size checks to reduce TOCTOU
  races. No feature executes project code, scripts, builds, tests, hooks, or
  remote commands.

### Request Flow

```
MCP Client (Claude)          CLI (Terminal)
       │                           │
       │ stdio JSON-RPC            │ citty command
       │ Streamable HTTP (optional)
       ▼                           ▼
   server.ts                    bin.ts
       │                           │
       │ server.registerTool()     │ defineCommand()
       ▼                           ▼
   tools/adapter.ts            cli/adapter.ts
       │                           │
       │ registerFeatureAsTool()   │ featureToCittyCommand()
       ▼                           ▼
       └───────────┬───────────────┘
                   │
                   ▼
            features/runtime.ts
            executeFeature() + finalizeFeatureResult()
                   │
                   ▼
            feature.execute(input, optional context)
                   │
                   ▼
            stable bounded result envelope
                   │
       ┌───────────┴───────────┐
       ▼                       ▼
   MCP Response            CLI Output
   (protocol content +      (plain JSON on
    structuredContent)      stdout/stderr)
```

---

## Core Components

### Embedding Providers (`core/embeddings/client.ts`)

The default Ollama provider gives semantic embeddings. The lexical provider is
deterministic, local, and dependency-free; it hashes identifiers/tokens into a
normalized vector so indexing remains useful without a model service.

```typescript
interface OllamaClient {
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

interface EmbeddingClient {
  healthCheck(): Promise<{ ok: boolean; error?: string }>;
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}
```

**Configuration:**

- `OLLAMA_BASE_URL`: API endpoint (default: `http://localhost:11434`)
- `EMBEDDING_PROVIDER`: `ollama` (default) or in-process `lexical`
- `EMBEDDING_MODEL`: Model name (default: `nomic-embed-text`)
- `EMBEDDING_DIMENSIONS`: Expected vector size (default: `768`)

The Ollama endpoint is restricted to HTTP(S) loopback addresses. Embedding
batches are validated for count, finite values, and configured dimensions
before any index mutation.

### Vector Store (`core/embeddings/store.ts`)

LanceDB wrapper for vector and full-text search.

Search uses vector similarity, LanceDB BM25/FTS when available, reciprocal-rank
fusion, and a bounded deterministic lexical rerank that boosts exact symbols,
identifiers, and paths without making another model call.

```typescript
interface VectorStore {
  connect(): Promise<void>;
  close(): void;
  exists(): boolean;
  clear(): Promise<void>;
  addChunks(chunks: EmbeddedChunk[]): Promise<void>;
  replaceFileChunks(filePath: string, chunks: EmbeddedChunk[]): Promise<void>;
  replaceFilesChunks(
    replacements: ReadonlyMap<string, EmbeddedChunk[]>,
  ): Promise<void>;
  search(vector: number[], limit: number): Promise<SearchResult[]>;
  searchFts(query: string, limit: number): Promise<SearchResult[]>;
  searchHybrid(
    vector: number[],
    query: string,
    limit: number,
  ): Promise<SearchResult[]>;
}
```

The store also persists `metadata.json` and detects incompatible provider,
model, dimension, or schema combinations before search/update operations.

**Storage:**

- Location: `.src-index/code_chunks.lance/` within each project
- Schema: `id`, `content`, `filePath`, `language`, `startLine`, `endLine`, `symbolName`, `symbolType`, `vector`

### Semantic Chunker (`core/embeddings/chunker.ts`)

Splits code into meaningful chunks preserving context.

```typescript
interface Chunk {
  id: string; // Unique identifier
  content: string; // Code content
  filePath: string; // Source file path
  language: string; // Detected language
  startLine: number; // Start line number
  endLine: number; // End line number
  symbolName?: string; // Function/class name
  symbolType?: string; // "function" | "class" | "method" | etc.
}
```

**Strategy:**

1. Parse AST to find symbol boundaries (functions, classes)
2. Split at boundaries with configurable size (default: 1000 chars)
3. Add overlap for context (default: 200 chars)
4. Fall back to a language-aware or generic recursive text splitter for configured non-Tree-sitter formats

### AST Enricher (`core/embeddings/enricher.ts`)

Adds semantic metadata from AST analysis.

```typescript
interface EnrichedChunk extends Chunk {
  enrichedContent: string; // Content with metadata header
  containedSymbols: ChunkSymbol[]; // Symbols defined in chunk
  wasEnriched: boolean; // Enrichment success flag
}
```

Imports, exports, and bounded cross-file definitions are rendered into
`enrichedContent` for embedding but are not duplicated as stored chunk fields.
LanceDB stores the original chunk content and its vector.

**Features:**

- Symbol extraction (functions, classes, variables, interfaces, types)
- Import resolution (relative, absolute, path aliases)
- Export detection
- Cross-file context inclusion

### Hybrid Search

Combines multiple search strategies:

```
                    ┌─────────────────┐
                    │      Query      │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              │              ▼
    ┌─────────────────┐      │    ┌─────────────────┐
    │  Embed Query    │      │    │ Tokenize Query  │
    │ (nomic-embed)   │      │    │    (BM25)       │
    └────────┬────────┘      │    └────────┬────────┘
             │               │             │
             ▼               │             ▼
    ┌─────────────────┐      │    ┌─────────────────┐
    │  Vector Search  │      │    │   BM25 Search   │
    │ (cosine sim)    │      │    │ (term freq)     │
    └────────┬────────┘      │    └────────┬────────┘
             │               │             │
             └───────────────┼─────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │   RRF Fusion    │
                    │ score = Σ 1/(k+r) │
                    │    k = 60       │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  Add Call Graph │
                    │ (callers/callees)│
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │    Results      │
                    └─────────────────┘
```

### Call Graph (`core/embeddings/callgraph.ts`)

Extracts function call relationships.

```typescript
// search_code returns compact symbol names:
interface SearchCallContext {
  callers: string[];
  callees: string[];
}

// get_call_graph returns full CallGraphNode objects with file/line metadata.
```

**Process:**

1. Parse AST for all files
2. Extract function definitions and call sites
3. Resolve cross-file references
4. Cache to `.src-index/call-graph.json`

---

## Feature System

### Feature Interface

```typescript
// src/features/types.ts

interface Feature<TInput extends z.ZodType = z.ZodType> {
  name: string; // Tool name (snake_case)
  title?: string; // Human-readable title
  description: string; // LLM-friendly description
  schema: TInput; // Zod validation schema
  outputSchema?: z.ZodType; // Strict protocol output contract
  annotations?: FeatureAnnotations; // MCP behavior hints
  execute: (
    input: z.infer<TInput>,
    context?: {
      signal?: AbortSignal;
      reportProgress?: (
        progress: number,
        total?: number,
        message?: string,
      ) => Promise<void>;
    },
  ) => FeatureResult | Promise<FeatureResult>;
}

interface FeatureResult {
  success: boolean;
  data?: unknown;
  message?: string;
  error?: string;
  meta?: Partial<FeatureResultMetadata>;
}
```

### Creating a New Feature

1. **Create folder:** `src/features/my-feature/`

2. **Create `index.ts`:**

```typescript
import { z } from "zod";
import type { Feature, FeatureResult } from "@features/types";
import { createFeatureResultSchema } from "@features/utils";

// 1. Define schema with descriptions for LLMs
export const myFeatureSchema = z.object({
  param: z.string().describe("Description for LLM understanding"),
  optional: z.boolean().optional().default(false).describe("Optional flag"),
});

export type MyFeatureInput = z.infer<typeof myFeatureSchema>;

const myFeatureDataSchema = z.object({ result: z.string() }).strict();
export const myFeatureOutputSchema =
  createFeatureResultSchema(myFeatureDataSchema);

// 2. Implement execute function
export async function execute(input: MyFeatureInput): Promise<FeatureResult> {
  try {
    // Business logic here
    return {
      success: true,
      message: "Operation completed",
      data: { result: "..." },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// 3. Export feature definition
export const myFeature: Feature<typeof myFeatureSchema> = {
  name: "my_feature", // snake_case
  title: "My feature",
  description: "Clear description for LLMs",
  schema: myFeatureSchema,
  outputSchema: myFeatureOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute,
};
```

3. **Create `index.test.ts`:**

```typescript
import { describe, expect, test, vi } from "vitest";
import { execute, myFeatureSchema } from "@features/my-feature";

describe("myFeatureSchema", () => {
  test("validates valid input", () => {
    const result = myFeatureSchema.safeParse({ param: "test" });
    expect(result.success).toBe(true);
  });

  test("applies defaults", () => {
    const result = myFeatureSchema.safeParse({ param: "test" });
    if (result.success) {
      expect(result.data.optional).toBe(false);
    }
  });
});

describe("execute", () => {
  test("returns success for valid input", async () => {
    const result = await execute({ param: "test", optional: false });
    expect(result.success).toBe(true);
  });
});
```

4. **Register in `src/features/index.ts`:**

```typescript
export { myFeature } from "@features/my-feature";

export const features: Feature[] = [
  // ... existing features
  myFeature,
];
```

### Adapter System

**MCP Tools Adapter** (`src/tools/adapter.ts`):

- Converts `Feature.schema` (Zod) → MCP input schema
- Registers with `server.registerTool(name, config, handler)`
- Wraps `execute()` result in MCP response format
- Applies `SRC_TOOL_ALLOWLIST` to expose only an explicitly selected tool set
- Supports `SRC_TOOL_PROFILE=full|readonly|minimal`; an explicit allow-list
  takes precedence over the profile
- Adds the stable `schema_version: 1` envelope, bounded metadata, provenance,
  freshness, confidence, coverage, truncation and injection-signal markers
- Validates every registered feature with a strict output schema when one is
  available and fails closed on oversized or unserializable responses

Common execution and result handling live in `src/features/runtime.ts`. Both
adapters use it for metrics, optional audit events, safe exception handling,
stable metadata, feature-specific output validation, and
`SRC_MAX_RESULT_BYTES` enforcement.

**CLI Adapter** (`src/cli/adapter.ts`):

- Converts `Feature.schema` (Zod) → citty args via `zodToCittyArgs()`
- Flattens object unions without losing branch-specific validation
- Converts string-oriented CLI values into schema-native numbers, arrays,
  objects, tuples, booleans, and enums
- Validates with the exact feature schema before execution and awaits both
  synchronous and asynchronous features
- Creates `defineCommand()` with generated options
- Emits the same complete, bounded result envelope as plain JSON, preserving
  both `message` and `data`; successes use stdout and failures use stderr with a
  non-zero exit code

### MCP discovery surfaces

`src/server.ts` registers the enabled tool profile, seven reusable prompts,
two static resources, and one dynamic project resource template:

- `src://server/info` exposes server identity;
- `src://server/capabilities` exposes the active profile, enabled tools,
  annotations, and a deterministic catalog revision;
- `src://project/{project}/{view}` exposes `context`, `map`, `status`,
  `catalog`, and `memory` views for secure local roots.

Resource listing uses `SRC_ALLOWED_ROOTS`, or the current directory only when
no explicit allow-list is configured. Project IDs are path-derived hashes;
reads delegate to the same bounded feature implementations as tools. MCP list
responses advertise five-minute public cache hints, while project contents are
computed from current local state.

### Schema and native dependency choices

Zod remains the canonical schema layer because the MCP TypeScript SDK consumes
it directly and can derive JSON Schema without an adapter. Valibot is attractive
for browser bundle size, but this local Node server would need an additional
conversion package while retaining custom union/introspection code. Its dominant
costs are parsing, Git processes, embeddings, and vector storage rather than
schema validation. Zod 4.5 also reduces retained schema memory and supports
compiled validation if profiling later shows schema parsing to be material.

LanceDB is kept on the newest tested line that remains compatible with the
pinned Apache Arrow peer range and does not install unused legacy
Transformers/ONNX embedding integrations. Tree-sitter is likewise advanced only
after the multilingual golden benchmark confirms that a patch does not regress
warm parsing. These native/WASM dependencies are benchmark-gated rather than
blindly upgraded.

---

## Data Flow

### Indexing Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                    index_codebase                                │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. Collect Files                                                 │
│    - Read .gitignore                                            │
│    - Apply exclusions                                           │
│    - Filter by supported extensions                             │
│    - Skip hidden files/folders, secrets, and oversized files     │
│    - Enforce root/symlink containment                            │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Parallel Processing (configurable concurrency)               │
│    For each file:                                               │
│    ├─ chunkFile() → Chunk[]                                     │
│    └─ enrichChunksFromFile() → EnrichedChunk[]                  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Generate Embeddings                                          │
│    - Batch chunks (10 per request)                              │
│    - Call Ollama or lexical embedBatch()                        │
│    - Create EmbeddedChunk[]                                     │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Store in LanceDB                                             │
│    - vectorStore.addChunks()                                    │
│    - Persist vectors in the code_chunks table                   │
│    - Create FTS lazily and persist versioned metadata           │
└─────────────────────────────────────────────────────────────────┘
```

### Search Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                      search_code                                 │
│                   query: "authentication"                        │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 1. Embed Query                                                   │
│    embeddingClient.embed(query) → vector[configured dimensions] │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Parallel Search (hybrid mode)                                │
│    ├─ LanceDB vectorSearch(vector)                              │
│    └─ LanceDB nearestToText(query), lexical fallback            │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. RRF Fusion                                                    │
│    score = Σ 1/(k + rank), k = 60                               │
│    Merge and sort by combined score                             │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Filter, deduplicate, expand neighbors, and rerank            │
│    - Apply language/path/symbol/test filters                    │
│    - Optional lexical or code-aware deterministic reranking     │
└─────────────────────────────┬───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Add optional call context, confidence, and pagination        │
│    - Redact/bound source and expose abstention/freshness         │
└─────────────────────────────────────────────────────────────────┘
```

### Agent Context Pipeline

```
task + depth + token budget
             │
             ▼
 project ─┬─ memory ─┬─ artifacts ─┬─ Git ─┬─ repo map ─┬─ search
          └──────────┴─────────────┴───────┴────────────┘
                              │ concurrent, local-only
                              ▼
            equal minimum allocation + weighted remainder
                              │
                              ▼
 bounded dossier + layer ledger + warnings + next actions
```

Memory provenance is intentionally advisory, not an automatic deletion rule:
stale records remain visible so the agent can verify or supersede them against
current code.

Embedding providers are also local-only. `OLLAMA_BASE_URL` accepts HTTP(S)
loopback endpoints (`localhost`, `127.0.0.0/8`, or `::1`); invalid or non-local
values fail closed to the default loopback endpoint. The lexical provider needs
no service.

---

## Supported Languages

### Tree-sitter WASM (18 languages)

Tree-sitter AST parsing with symbol extraction and best-effort static call-graph analysis.

| Language   | WASM File                     | Query Folder          |
| ---------- | ----------------------------- | --------------------- |
| JavaScript | `tree-sitter-javascript.wasm` | `queries/javascript/` |
| TypeScript | `tree-sitter-typescript.wasm` | `queries/typescript/` |
| TSX        | `tree-sitter-tsx.wasm`        | `queries/tsx/`        |
| Python     | `tree-sitter-python.wasm`     | `queries/python/`     |
| Rust       | `tree-sitter-rust.wasm`       | `queries/rust/`       |
| Go         | `tree-sitter-go.wasm`         | `queries/go/`         |
| Java       | `tree-sitter-java.wasm`       | `queries/java/`       |
| C          | `tree-sitter-c.wasm`          | `queries/c/`          |
| C++        | `tree-sitter-cpp.wasm`        | `queries/cpp/`        |
| C#         | `tree-sitter-c_sharp.wasm`    | `queries/c_sharp/`    |
| Ruby       | `tree-sitter-ruby.wasm`       | `queries/ruby/`       |
| PHP        | `tree-sitter-php.wasm`        | `queries/php/`        |
| Kotlin     | `tree-sitter-kotlin.wasm`     | `queries/kotlin/`     |
| Scala      | `tree-sitter-scala.wasm`      | `queries/scala/`      |
| Swift      | `tree-sitter-swift.wasm`      | `queries/swift/`      |
| HTML       | `tree-sitter-html.wasm`       | `queries/html/`       |
| Svelte     | `tree-sitter-svelte.wasm`     | `queries/svelte/`     |
| OCaml      | `tree-sitter-ocaml.wasm`      | `queries/ocaml/`      |

### Configured text fallback (37 modes)

Five modes use language-specific LangChain separators:

`markdown`, `latex`, `rst`, `solidity`, `proto`

The remaining 32 configured modes use generic recursive text splitting. Across Tree-sitter and fallback tiers, the canonical catalog currently includes 99 extensions plus 18 special filenames. Binary extensions are rejected before parsing.

### Language Configuration

Located in `assets/languages.json`:

```json
{
  "treesitter": {
    "javascript": {
      "wasm": "tree-sitter-javascript.wasm",
      "queries": "javascript",
      "extensions": [".js", ".mjs", ".cjs", ".jsx"]
    }
  },
  "langchain": {
    "supported": ["markdown", "latex", ...]
  },
  "fallbackExtensions": {
    ".json": "json",
    ".md": "markdown"
  },
  "specialFilenames": {
    "dockerfile": "dockerfile",
    "makefile": "makefile"
  },
  "binaryExtensions": [".exe", ".dll", ".png", ...]
}
```

---

## Testing

### Framework

- **Runner:** Vitest
- **Command:** `bun run test` (uses Vitest)
- **Location:** Colocated with source (`index.test.ts`)

### Running Tests

```bash
bun run test              # Run all tests
bun run test:watch        # Watch mode
bun run test:coverage     # With coverage
bun run test:ui           # Vitest UI
```

### Test Structure

```typescript
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

describe("FeatureName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("schema", () => {
    test("validates valid input", () => { ... });
    test("applies defaults", () => { ... });
    test("rejects invalid input", () => { ... });
  });

  describe("execute", () => {
    test("success case", async () => { ... });
    test("error case", async () => { ... });
  });
});
```

### Mocking

```typescript
// Mock modules
vi.mock("@core/embeddings");

// Mock implementations
vi.mocked(embeddings.createOllamaClient).mockReturnValue({
  healthCheck: vi.fn().mockResolvedValue({ ok: true }),
  embedBatch: vi.fn().mockResolvedValue([[0.1, 0.2, ...]]),
});
```

---

## Development Workflow

### Commands

```bash
# Development
bun run dev              # Watch mode with auto-reload
bun run cli help         # Test CLI

# Quality checks
bun run check            # Typecheck + lint + format + contract baseline
bun run contract:verify  # MCP/CLI/prompts/resources/exports/config parity
bun run typecheck        # TypeScript only
bun run lint             # Biome lint only
bun run lint:fix         # Auto-fix lint issues
bun run format           # Biome format
bun run format:check     # Check formatting

# Build
bun run build            # Build ESM bundle and declarations with tsdown
bun run pack:verify      # Pack, install, import, and exercise the CLI
bun run conformance:local # Local stdio/HTTP × legacy/modern matrix (no download)
bun run mutation:smoke    # Kill curated pagination mutants in temp copies
bun run conformance:smoke # Official MCP compatibility smoke scenarios
```

Biome applies the repository formatter and lint rules. Public refactors must
keep `contract:verify` green: its
reviewed baseline fingerprints feature schemas and annotations, the MCP and CLI
surfaces, prompts, resources, package exports, and default configuration.

### Import Aliases

Use path aliases across top-level module boundaries. Relative imports are fine
within a module or feature folder:

| Alias         | Path             |
| ------------- | ---------------- |
| `@features/*` | `src/features/*` |
| `@tools/*`    | `src/tools/*`    |
| `@cli/*`      | `src/cli/*`      |
| `@config`     | `src/config`     |
| `@utils/*`    | `src/utils/*`    |
| `@core/*`     | `src/core/*`     |
| `@/*`         | `src/*`          |

```typescript
// Correct
import { logger } from "@utils";
import type { Feature } from "@features/types";

// Incorrect
import { logger } from "../utils";
```

---

## Release Process

### Automatic Release

Releases run only after the `CI` workflow succeeds on `main` and the tested
commit message contains `[release]` or `chore(release)`.

```bash
# 1. Update version
npm version minor  # or patch, major

# 2. Push to dev
git push origin dev

# 3. Merge to main with [release]
git checkout main
git merge dev -m "chore(release): v1.2.0 [release]"
git push origin main
```

### What Happens

1. The successful `CI` workflow triggers the release workflow
2. The workflow checks for `[release]` or `chore(release)` in the tested commit
3. Generates CHANGELOG.md from conventional commits
4. Commits changelog to main when it changed
5. Creates the GitHub Release and publishes to npm with provenance

The `bun run changelog` script uses the Conventional Commits preset directly
from the project so generation also works with Bun's isolated dependency linker.

### Conventional Commits

| Prefix    | Changelog Section |
| --------- | ----------------- |
| `feat:`   | Features          |
| `fix:`    | Bug Fixes         |
| `perf:`   | Performance       |
| `revert:` | Reverts           |

Other prefixes (`docs:`, `chore:`, `test:`, etc.) are not included in changelog.

---

## Naming Conventions

| Element              | Convention        | Example                          |
| -------------------- | ----------------- | -------------------------------- |
| **Feature names**    | snake_case + verb | `get_server_info`, `search_code` |
| **File names**       | kebab-case        | `adapter.ts`, `vector-store.ts`  |
| **Test files**       | `*.test.ts`       | `index.test.ts`                  |
| **Functions**        | camelCase         | `createVectorStore()`            |
| **Types/Interfaces** | PascalCase        | `Feature`, `SearchResult`        |
| **Constants**        | SCREAMING_SNAKE   | `EMBEDDING_CONFIG`               |

### Verb Prefixes for Features

| Prefix    | Usage                   |
| --------- | ----------------------- |
| `get_`    | Retrieve single item    |
| `list_`   | Retrieve multiple items |
| `search_` | Query with results      |
| `index_`  | Create/build index      |
| `update_` | Modify existing         |
| `delete_` | Remove item             |

---

## Configuration

### Environment Variables

| Variable                            | Default                  | Description                                                 |
| ----------------------------------- | ------------------------ | ----------------------------------------------------------- |
| `OLLAMA_BASE_URL`                   | `http://localhost:11434` | Ollama API                                                  |
| `EMBEDDING_PROVIDER`                | `ollama`                 | `ollama` or `lexical`                                       |
| `EMBEDDING_MODEL`                   | `nomic-embed-text`       | Embedding model                                             |
| `EMBEDDING_DIMENSIONS`              | `768`                    | Vector size (1–16384)                                       |
| `CHUNK_SIZE`                        | `1000`                   | Chars per chunk (1–100000)                                  |
| `CHUNK_OVERLAP`                     | `200`                    | Clamped below chunk size                                    |
| `EMBEDDING_BATCH_SIZE`              | `10`                     | Batch size (1–256)                                          |
| `ENRICHMENT_CROSS_FILE`             | enabled                  | Include bounded resolved-import context                     |
| `ENRICHMENT_MAX_IMPORTS`            | `10`                     | Maximum imports resolved per enriched file                  |
| `ENRICHMENT_MAX_SYMBOLS_PER_IMPORT` | `5`                      | Maximum symbols included per resolved import                |
| `LOG_LEVEL`                         | `info`                   | Log verbosity                                               |
| `SRC_ALLOWED_ROOTS`                 | unset                    | Allowed roots (`;`/`,` separated); required for remote HTTP |
| `SRC_MAX_FILE_BYTES`                | `10485760`               | Maximum source file size (hard max 128 MiB)                 |
| `SRC_MAX_RESULT_BYTES`              | `2097152`                | Maximum serialized MCP result                               |
| `SRC_TOOL_ALLOWLIST`                | unset                    | MCP tool names (`;`/`,` separated)                          |
| `SRC_TOOL_PROFILE`                  | `full`                   | `full`, `readonly`, or `minimal`                            |
| `SRC_LSP_ENABLED`                   | enabled                  | Allow-listed local LSP navigation                           |
| `SRC_LSP_SESSION_CACHE`             | enabled                  | Reuse bounded local LSP sessions                            |
| `SRC_LSP_IDLE_MS`                   | `15000`                  | Cached LSP idle TTL (1s–10min)                              |
| `SRC_STATIC_ANALYSIS_ENABLED`       | disabled                 | Enable local ast-grep/Semgrep/CodeQL adapters               |
| `SRC_AUDIT_LOG`                     | disabled                 | Persist bounded secret-free local audit events              |
| `MCP_TASKS`                         | enabled                  | Current Tasks extension                                     |
| `MCP_TASK_TOOLS`                    | index/update             | Task-enabled tool names                                     |
| `MCP_TASK_STORE_DIR`                | OS temp directory        | Durable task state directory                                |
| `MCP_TASK_TTL_MS`                   | `86400000`               | Task TTL in milliseconds/`none`                             |
| `MCP_TASK_POLL_INTERVAL_MS`         | `1000`                   | Suggested task polling interval                             |
| `MCP_TASK_MAX_ACTIVE`               | `8`                      | Active task quota                                           |
| `MCP_TASK_MAX_RESULT_BYTES`         | `1048576`                | Maximum persisted task result size                          |
| `NODE_ENV`                          | unset                    | Exported dev/prod flags; `production` also minifies builds  |

HTTP-only variables are documented in README; the transport is opt-in and
defaults to loopback with Host/Origin validation, request limits, and bearer
authentication for non-loopback binds.

The current `io.modelcontextprotocol/tasks` extension is implemented as a
small atomic task store around the SDK v2 server. It handles modern
`tools/call` task creation and `tasks/get`, `tasks/update`, and `tasks/cancel`
before the SDK's legacy task-method registry gate. Only clients that declare
the extension in the current per-request envelope receive a task handle.
Read/modify/write operations are serialized across local processes using
bounded filesystem ticket locks and atomic, fsynced snapshots. Each unfinished
record identifies its owning process and manager instance: another live owner
is preserved, and abandoned work is failed explicitly. Arbitrary source analysis
is not replayed automatically. The shared store is bounded to 1,024 records and
16 MiB; the active-work quota is per manager. Persistence failure cancels local
runners, retains failed state in memory for retry, and disables new asynchronous
work until restart. These locks require local disk, not a network filesystem.
`list_projects` exposes multiple configured
roots without merging their indexes, and diagnostics expose bounded tool
latency/call counters without recording arguments or source text.
`get_observability` can expose the same bounded counters as structured JSON or
Prometheus text, entirely in-process and without telemetry or source payloads.
The tool adapter also bounds every serialized MCP result with
`SRC_MAX_RESULT_BYTES` and fails closed on oversized or unserializable output.
The package entry point is exposed through `src/public.ts`, so importing the
library never starts a transport as a side effect.

### Internal Configuration

Located in `src/config/index.ts`:

```typescript
export const EMBEDDING_CONFIG: EmbeddingConfig = getEmbeddingConfig();

export const ENRICHMENT_CONFIG = getEnrichmentConfig();
```

---

## Links

- [README](./README.md) — User documentation
- [Contributing Guide](./CONTRIBUTING.md) — Development and pull request workflow
- [Changelog](./CHANGELOG.md) — Version history
- [Report Issues](https://github.com/kvnpetit/structured-repo-context-mcp/issues)
- [MCP Specification](https://modelcontextprotocol.io/specification)
- [Ollama](https://ollama.com)
- [LanceDB](https://lancedb.com)
- [Tree-sitter](https://tree-sitter.github.io/tree-sitter/)
