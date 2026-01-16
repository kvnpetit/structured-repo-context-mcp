export * from "./types";
export { echoFeature } from "./echo";
export { infoFeature, getServerInfo } from "./info";

import type { Feature } from "./types";
import { echoFeature } from "./echo";
import { infoFeature } from "./info";

// Registre de toutes les features
export const features: Feature[] = [
  echoFeature,
  infoFeature,
  // Ajoute tes features ici
];

export function getFeature(name: string): Feature | undefined {
  return features.find((f) => f.name === name);
}
