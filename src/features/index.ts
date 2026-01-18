export type * from "@features/types";
export { infoFeature, getServerInfo } from "@features/info";

import type { Feature } from "@features/types";
import { infoFeature } from "@features/info";

// Registry of all features
export const features: Feature[] = [
  infoFeature,
  // Add your features here
];

export function getFeature(name: string): Feature | undefined {
  return features.find((f) => f.name === name);
}
