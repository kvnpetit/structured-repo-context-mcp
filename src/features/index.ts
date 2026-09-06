export type * from "@features/types";
export { infoFeature, getServerInfo } from "@features/info";
export { indexCodebaseFeature } from "@features/index-codebase";
export { searchCodeFeature } from "@features/search-code";
export { getIndexStatusFeature } from "@features/get-index-status";
export { updateIndexFeature } from "@features/update-index";
export { parseAstFeature } from "@features/parse-ast";
export { queryCodeFeature } from "@features/query-code";
export { listSymbolsFeature } from "@features/list-symbols";
export { analyzeFileFeature } from "@features/analyze-file";
export { getCallGraphFeature } from "@features/get-call-graph";
export { findSymbolsFeature } from "@features/find-symbols";
export { dependencyGraphFeature } from "@features/dependency-graph";
export { codeSnippetFeature } from "@features/code-snippet";
export { analyzeImpactFeature } from "@features/analyze-impact";
export { diagnosticsFeature } from "@features/diagnostics";
export {
  observabilityFeature,
  observabilitySchema,
  observabilityOutputSchema,
} from "@features/observability";
export { listProjectsFeature } from "@features/list-projects";
export { repositoryMapFeature } from "@features/repository-map";
export { symbolAtPositionFeature } from "@features/symbol-at-position";
export { assembleTaskContextFeature } from "@features/assemble-task-context";
export { findDeadCodeFeature } from "@features/find-dead-code";
export { changedSymbolsFeature } from "@features/changed-symbols";
export { projectArtifactsFeature } from "@features/project-artifacts";
export { projectContextFeature } from "@features/project-context";
export {
  semanticNavigationFeature,
  semanticNavigationSchema,
} from "@features/semantic-navigation";
export { symbolGraphFeature, symbolGraphSchema } from "@features/symbol-graph";
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

import type { Feature } from "@features/types";
import { getIndexStatusFeature } from "@features/get-index-status";
import { indexCodebaseFeature } from "@features/index-codebase";
import { infoFeature } from "@features/info";
import { searchCodeFeature } from "@features/search-code";
import { updateIndexFeature } from "@features/update-index";
import { parseAstFeature } from "@features/parse-ast";
import { queryCodeFeature } from "@features/query-code";
import { listSymbolsFeature } from "@features/list-symbols";
import { analyzeFileFeature } from "@features/analyze-file";
import { getCallGraphFeature } from "@features/get-call-graph";
import { findSymbolsFeature } from "@features/find-symbols";
import { dependencyGraphFeature } from "@features/dependency-graph";
import { codeSnippetFeature } from "@features/code-snippet";
import { analyzeImpactFeature } from "@features/analyze-impact";
import { diagnosticsFeature } from "@features/diagnostics";
import { observabilityFeature } from "@features/observability";
import { listProjectsFeature } from "@features/list-projects";
import { repositoryMapFeature } from "@features/repository-map";
import { symbolAtPositionFeature } from "@features/symbol-at-position";
import { assembleTaskContextFeature } from "@features/assemble-task-context";
import { findDeadCodeFeature } from "@features/find-dead-code";
import { changedSymbolsFeature } from "@features/changed-symbols";
import { projectArtifactsFeature } from "@features/project-artifacts";
import { projectContextFeature } from "@features/project-context";
import { semanticNavigationFeature } from "@features/semantic-navigation";
import { symbolGraphFeature } from "@features/symbol-graph";
import {
  getProjectMemoryFeature,
  setProjectMemoryFeature,
} from "@features/project-memory";
import {
  getProjectCatalogFeature,
  refreshProjectCatalogFeature,
} from "@features/project-catalog";
import { gitContextFeature } from "@features/git-context";
import { indexSnapshotsFeature } from "@features/index-snapshots";
import { staticAnalysisFeature } from "@features/static-analysis";
import { scipImportFeature } from "@features/scip-import";
import { indexMaintenanceFeature } from "@features/index-maintenance";

// Registry of features exposed via CLI and MCP
export const features: Feature[] = [
  infoFeature,
  indexCodebaseFeature,
  searchCodeFeature,
  getIndexStatusFeature,
  updateIndexFeature,
  parseAstFeature,
  queryCodeFeature,
  listSymbolsFeature,
  analyzeFileFeature,
  getCallGraphFeature,
  findSymbolsFeature,
  dependencyGraphFeature,
  codeSnippetFeature,
  analyzeImpactFeature,
  diagnosticsFeature,
  observabilityFeature,
  listProjectsFeature,
  repositoryMapFeature,
  symbolAtPositionFeature,
  assembleTaskContextFeature,
  findDeadCodeFeature,
  changedSymbolsFeature,
  projectArtifactsFeature,
  projectContextFeature,
  semanticNavigationFeature,
  symbolGraphFeature,
  getProjectMemoryFeature,
  setProjectMemoryFeature,
  getProjectCatalogFeature,
  refreshProjectCatalogFeature,
  gitContextFeature,
  indexSnapshotsFeature,
  staticAnalysisFeature,
  scipImportFeature,
  indexMaintenanceFeature,
];

export function getFeature(name: string): Feature | undefined {
  return features.find((f) => f.name === name);
}
