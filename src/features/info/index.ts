import { z } from "zod";
import type { Feature, FeatureResult } from "@/features/types";
import { config } from "@/config";

export const infoSchema = z.object({
  format: z
    .enum(["json", "text"])
    .optional()
    .default("text")
    .describe("Format de sortie"),
});

export type InfoInput = z.infer<typeof infoSchema>;

export interface ServerInfo {
  name: string;
  version: string;
  description: string | undefined;
}

export function getServerInfo(): ServerInfo {
  return {
    name: config.name,
    version: config.version,
    description: config.description,
  };
}

export function execute(input: InfoInput): FeatureResult {
  const info = getServerInfo();

  if (input.format === "json") {
    return {
      success: true,
      data: info,
      message: JSON.stringify(info, null, 2),
    };
  }

  const description = info.description ?? "";
  const text = `${info.name} v${info.version}\n${description}`.trim();

  return {
    success: true,
    data: info,
    message: text,
  };
}

export const infoFeature: Feature<typeof infoSchema> = {
  name: "info",
  description: "Affiche les informations du serveur",
  schema: infoSchema,
  execute,
};
