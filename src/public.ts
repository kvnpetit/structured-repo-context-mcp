/**
 * Side-effect-free public package API.
 *
 * `src/index.ts` is the executable entry point used by the MCP stdio command;
 * it intentionally starts a server when run. Package consumers importing
 * `src-mcp` must instead land here so an import never unexpectedly opens a
 * transport or keeps a process alive.
 */
export { createServer, startServer } from "@/server";
export { closeLspSessions } from "@core/navigation";
export {
  startHttpServer,
  type HttpServerOptions,
  type RunningHttpServer,
} from "@/http";
export {
  config,
  ENV,
  EMBEDDING_CONFIG,
  getEmbeddingConfig,
  getEnrichmentConfig,
  getMaxResultBytes,
} from "@config";
export { features, getFeature } from "@features";
export {
  semanticNavigationFeature,
  semanticNavigationSchema,
} from "@features/semantic-navigation";
export { symbolGraphFeature, symbolGraphSchema } from "@features/symbol-graph";
export {
  searchCodeFeature,
  searchCodeSchema,
  searchCodeOutputSchema,
} from "@features/search-code";
export {
  getProjectMemoryFeature,
  getProjectMemorySchema,
  getProjectMemoryOutputSchema,
  setProjectMemoryFeature,
  setProjectMemorySchema,
  setProjectMemoryOutputSchema,
} from "@features/project-memory";
export {
  getProjectCatalogFeature,
  getProjectCatalogSchema,
  getProjectCatalogOutputSchema,
  refreshProjectCatalogFeature,
  refreshProjectCatalogSchema,
  refreshProjectCatalogOutputSchema,
} from "@features/project-catalog";
export {
  gitContextFeature,
  gitContextSchema,
  gitContextOutputSchema,
} from "@features/git-context";
export {
  indexSnapshotsFeature,
  indexSnapshotsSchema,
  indexSnapshotsOutputSchema,
} from "@features/index-snapshots";
export {
  observabilityFeature,
  observabilitySchema,
  observabilityOutputSchema,
} from "@features/observability";
export {
  staticAnalysisFeature,
  staticAnalysisSchema,
  staticAnalysisOutputSchema,
} from "@features/static-analysis";
export {
  scipImportFeature,
  scipImportSchema,
  scipImportOutputSchema,
} from "@features/scip-import";
export {
  indexMaintenanceFeature,
  indexMaintenanceSchema,
  indexMaintenanceOutputSchema,
} from "@features/index-maintenance";
export type {
  Feature,
  FeatureAnnotations,
  FeatureExecutionContext,
  FeatureResult,
  FeatureResultMetadata,
} from "@features/types";
