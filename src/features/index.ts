export type * from "@features/types";
export { infoFeature, getServerInfo } from "@features/info";
export { parseAstFeature } from "@features/parse-ast";
export { queryCodeFeature } from "@features/query-code";
export { listSymbolsFeature } from "@features/list-symbols";
export { analyzeFileFeature } from "@features/analyze-file";

import type { Feature } from "@features/types";
import { analyzeFileFeature } from "@features/analyze-file";
import { infoFeature } from "@features/info";
import { listSymbolsFeature } from "@features/list-symbols";
import { parseAstFeature } from "@features/parse-ast";
import { queryCodeFeature } from "@features/query-code";

// Registry of all features
export const features: Feature[] = [
  infoFeature,
  parseAstFeature,
  queryCodeFeature,
  listSymbolsFeature,
  analyzeFileFeature,
];

export function getFeature(name: string): Feature | undefined {
  return features.find((f) => f.name === name);
}
