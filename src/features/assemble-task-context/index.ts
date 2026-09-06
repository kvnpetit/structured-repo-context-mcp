import { repositoryMapFeature } from "@features/repository-map";
import { searchCodeFeature } from "@features/search-code";
import { execute as getProjectContext } from "@features/project-context";
import { execute as getProjectArtifacts } from "@features/project-artifacts";
import { executeGetProjectMemory } from "@features/project-memory";
import { execute as getGitContext } from "@features/git-context";
import {
  mergeInstructionSignals,
  scanInstructionSignals,
} from "@core/security";
import type { Feature, FeatureResult } from "@features/types";
import {
  featureError,
  focusTerms,
  packSections,
  renderArtifacts,
  renderGit,
  renderMemory,
  renderProject,
  renderSearchResults,
  safeLayerCall,
} from "./render";
import {
  assembleTaskContextOutputSchema,
  assembleTaskContextSchema,
  type AssembleTaskContextInput,
} from "./schema";
import type {
  ArtifactData,
  ContextSection,
  GitData,
  LayerKey,
  MemoryData,
  ProjectData,
  SearchData,
  TaskContextOutput,
} from "./types";

export {
  assembleTaskContextOutputSchema,
  assembleTaskContextSchema,
  type AssembleTaskContextInput,
} from "./schema";

export async function execute(
  rawInput: AssembleTaskContextInput,
): Promise<FeatureResult> {
  const input = assembleTaskContextSchema.parse(rawInput);
  const terms = focusTerms(input.task);
  const richByDefault = input.depth !== "minimal";
  const enabled = {
    project: input.include_project_context ?? richByDefault,
    memory: input.include_memory ?? richByDefault,
    artifacts: input.include_artifacts ?? richByDefault,
    git: input.include_git ?? richByDefault,
    repository_map: true,
    search: input.include_search,
  };
  const deep = input.depth === "deep";
  const searchContentBytes = Math.max(
    800,
    Math.min(
      6_000,
      Math.floor((input.max_tokens * 4 * 0.35) / input.search_limit),
    ),
  );

  const [
    mapResult,
    searchResult,
    projectResult,
    memoryResult,
    artifactResult,
    gitResult,
  ] = await Promise.all([
    safeLayerCall("Repository map", async () =>
      repositoryMapFeature.execute({
        directory: input.directory,
        focus: terms,
        max_tokens: input.max_tokens,
        max_files: deep ? 1_000 : 500,
        redact_secrets: true,
      }),
    ),
    safeLayerCall("Semantic search", async () =>
      enabled.search
        ? searchCodeFeature.execute({
            query: input.task,
            directory: input.directory,
            limit: input.search_limit,
            min_confidence: 0,
            mode: "hybrid",
            vectorWeight: 0.5,
            includeCallContext: false,
            rerank: "code",
            include_tests: true,
            redact_secrets: true,
            max_content_bytes: searchContentBytes,
            neighbor_window: deep ? 2 : 1,
          })
        : { success: true, data: { results: [] } },
    ),
    safeLayerCall("Project profile", async () =>
      enabled.project
        ? Promise.resolve(
            getProjectContext({
              directory: input.directory,
              max_files: deep ? 2_000 : 750,
              max_manifests: deep ? 100 : 50,
              include_scripts: true,
              redact_secrets: true,
            }),
          )
        : { success: true, data: undefined },
    ),
    safeLayerCall("Project memory", async () =>
      enabled.memory
        ? executeGetProjectMemory({
            directory: input.directory,
            scope: input.memory_scope,
            query: input.task,
            search_mode: "hybrid",
            include_expired: false,
            min_confidence: input.memory_min_confidence,
            limit: deep ? 15 : 8,
            redact_secrets: true,
          })
        : { success: true, data: undefined },
    ),
    safeLayerCall("Project artifacts", async () =>
      enabled.artifacts
        ? Promise.resolve(
            getProjectArtifacts({
              directory: input.directory,
              query: input.task,
              limit: deep ? 10 : 6,
              max_files: deep ? 1_000 : 500,
              include_content: deep,
              max_content_bytes: deep ? 1_500 : 400,
              redact_secrets: true,
            }),
          )
        : { success: true, data: undefined },
    ),
    safeLayerCall("Git context", async () =>
      enabled.git
        ? getGitContext({
            directory: input.directory,
            files: [],
            include_status: true,
            include_diff: false,
            include_history: false,
            include_blame: false,
            include_codeowners: false,
            include_changed_symbols: true,
            max_diff_bytes: 1_000,
            max_history: 1,
            include_hotspots: false,
            max_hotspots: 1,
            max_compare_files: 100,
            max_blame_lines: 1,
            redact_secrets: true,
          })
        : { success: true, data: undefined },
    ),
  ]);

  const warnings: string[] = [];
  const instructionScans: ReturnType<typeof scanInstructionSignals>[] = [];
  const mapData = mapResult.success
    ? (mapResult.data as {
        directory?: string;
        map?: string;
        truncated?: boolean;
      })
    : undefined;
  const repositoryMap = mapData?.map ?? "Repository map unavailable.";
  const rawSearch = searchResult.success
    ? (searchResult.data as SearchData)
    : undefined;
  const search: TaskContextOutput["search"] = searchResult.success
    ? { available: enabled.search, results: rawSearch?.results ?? [] }
    : {
        available: false,
        results: [],
        error: featureError(searchResult, "Search index is unavailable"),
      };
  const projectData = projectResult.success
    ? (projectResult.data as ProjectData | undefined)
    : undefined;
  const memoryData = memoryResult.success
    ? (memoryResult.data as MemoryData | undefined)
    : undefined;
  const artifactData = artifactResult.success
    ? (artifactResult.data as ArtifactData | undefined)
    : undefined;
  const gitData = gitResult.success
    ? (gitResult.data as GitData | undefined)
    : undefined;

  if (rawSearch?.instruction_signals) {
    instructionScans.push(rawSearch.instruction_signals);
  }
  if (artifactData?.instruction_signals) {
    instructionScans.push(artifactData.instruction_signals);
  }
  const layerResults: [LayerKey, FeatureResult, boolean][] = [
    ["search", searchResult, enabled.search],
    ["project", projectResult, enabled.project],
    ["memory", memoryResult, enabled.memory],
    ["artifacts", artifactResult, enabled.artifacts],
    ["git", gitResult, enabled.git],
    ["repository_map", mapResult, true],
  ];
  for (const [key, result, isEnabled] of layerResults) {
    if (isEnabled && !result.success) {
      warnings.push(
        key === "search"
          ? `Semantic search unavailable: ${featureError(result, "layer unavailable")}`
          : `${key}: ${featureError(result, "layer unavailable")}`,
      );
    }
  }
  const staleMemories = memoryData?.revision_summary?.stale ?? 0;
  if (staleMemories > 0) {
    warnings.push(
      `${String(staleMemories)} project memory record(s) were created at another Git revision`,
    );
  }

  const sections: ContextSection[] = [
    {
      key: "project",
      title: "Project profile",
      content: renderProject(projectData),
      weight: 1,
      enabled: enabled.project,
      available: projectResult.success,
      items: projectData?.manifests?.length ?? 0,
      sourceTruncated: projectData?.truncated ?? false,
      ...(projectResult.success
        ? {}
        : {
            error: featureError(projectResult, "Project profile unavailable"),
          }),
    },
    {
      key: "memory",
      title: "Relevant project memory",
      content: renderMemory(memoryData),
      weight: 1.2,
      enabled: enabled.memory,
      available: memoryResult.success,
      items: memoryData?.records?.length ?? 0,
      sourceTruncated: memoryData?.truncated ?? false,
      ...(memoryResult.success
        ? {}
        : { error: featureError(memoryResult, "Memory unavailable") }),
    },
    {
      key: "artifacts",
      title: "Relevant project artifacts",
      content: renderArtifacts(artifactData),
      weight: 0.9,
      enabled: enabled.artifacts,
      available: artifactResult.success,
      items: artifactData?.artifacts?.length ?? 0,
      sourceTruncated: artifactData?.truncated ?? false,
      ...(artifactResult.success
        ? {}
        : { error: featureError(artifactResult, "Artifacts unavailable") }),
    },
    {
      key: "git",
      title: "Current Git state",
      content: renderGit(gitData),
      weight: 1,
      enabled: enabled.git,
      available: gitResult.success,
      items: gitData?.files?.length ?? 0,
      sourceTruncated: gitData?.truncated ?? false,
      ...(gitResult.success
        ? {}
        : { error: featureError(gitResult, "Git context unavailable") }),
    },
    {
      key: "repository_map",
      title: "Repository map",
      content: repositoryMap,
      weight: 2,
      enabled: true,
      available: mapResult.success,
      items: 1,
      sourceTruncated: mapData?.truncated ?? false,
      ...(mapResult.success
        ? {}
        : { error: featureError(mapResult, "Repository map unavailable") }),
    },
    {
      key: "search",
      title: "Relevant indexed code",
      content: renderSearchResults(search.results),
      weight: 2.5,
      enabled: enabled.search,
      available: search.available,
      items: search.results.length,
      sourceTruncated: false,
      ...(search.error === undefined ? {} : { error: search.error }),
    },
  ];
  instructionScans.push(
    ...sections
      .filter((section) => section.enabled)
      .map((section) =>
        scanInstructionSignals(section.content, { source: section.key }),
      ),
  );
  const packed = packSections(input.task, sections, input.max_tokens);
  if (packed.truncated) {
    warnings.push(
      "One or more context layers were truncated to preserve the total token budget",
    );
  }

  const nextActions: string[] = [];
  if (enabled.search && !search.available) {
    nextActions.push(
      "Run index_codebase, then repeat assemble_task_context for indexed retrieval.",
    );
  }
  const anchor = search.results.find(
    (result) => !result.is_neighbor && result.symbolName,
  );
  if (anchor?.filePath && anchor.symbolName) {
    nextActions.push(
      `Inspect ${anchor.symbolName} in ${anchor.filePath} with semantic_navigation or get_symbol_graph before reading whole files.`,
    );
  }
  if ((gitData?.files?.length ?? 0) > 0) {
    nextActions.push(
      "Use get_git_context on the changed paths before editing so the current worktree is preserved.",
    );
  }
  if (staleMemories > 0) {
    nextActions.push(
      "Validate stale project memories against current code before relying on them; update or delete invalid records.",
    );
  }
  if ((artifactData?.artifacts?.length ?? 0) > 0) {
    nextActions.push(
      "Open only the highest-relevance artifact needed for constraints or prior decisions.",
    );
  }

  const output: TaskContextOutput = {
    directory: mapData?.directory ?? input.directory,
    task: input.task,
    depth: input.depth,
    focus_terms: terms,
    estimated_tokens: Math.ceil(Buffer.byteLength(packed.text, "utf8") / 4),
    token_budget: input.max_tokens,
    truncated: packed.truncated,
    repository_map: repositoryMap,
    search,
    layers: packed.statuses,
    next_actions: nextActions.slice(0, 6),
    context: packed.text,
    warnings,
    source_is_untrusted: true,
    instruction_signals: mergeInstructionSignals(instructionScans),
  };
  return {
    success: true,
    message: `Assembled ${input.depth} agent context with repository map from ${String(
      Object.values(packed.statuses).filter(
        (status) => status.enabled && status.available,
      ).length,
    )} available layer(s)${packed.truncated ? " (budget-bounded)" : ""}`,
    data: output,
  };
}

export const assembleTaskContextFeature: Feature<
  typeof assembleTaskContextSchema
> = {
  name: "assemble_task_context",
  title: "Assemble task context",
  description:
    "Prepare a bounded one-call agent dossier combining project profile, revision-aware memory, relevant artifacts, local Git changes, a PageRank-style repository map, and indexed code search. Each layer degrades independently and receives a fair share of the token budget.",
  schema: assembleTaskContextSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: assembleTaskContextOutputSchema,
  execute,
};
