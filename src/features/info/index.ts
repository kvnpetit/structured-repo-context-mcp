import { z } from "zod";
import type { Feature, FeatureResult } from "@features/types";
import { config } from "@config";
import { createFeatureResultSchema } from "@features/utils";

export const infoSchema = z.object({
  format: z
    .enum(["json", "text"])
    .optional()
    .default("text")
    .describe("Output format"),
});

export type InfoInput = z.infer<typeof infoSchema>;

export interface ServerInfo {
  name: string;
  fullName: string;
  version: string;
  description: string | undefined;
}

const serverInfoDataSchema = z
  .object({
    name: z.string(),
    fullName: z.string(),
    version: z.string(),
    description: z.string().optional(),
  })
  .strict();

export const infoOutputSchema = createFeatureResultSchema(serverInfoDataSchema);

export function getServerInfo(): ServerInfo {
  return {
    name: config.name,
    fullName: config.fullName,
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
  const text =
    `${info.fullName} (${info.name}) v${info.version}\n${description}`.trim();

  return {
    success: true,
    data: info,
    message: text,
  };
}

export const infoFeature: Feature<typeof infoSchema> = {
  name: "get_server_info",
  description:
    "Get SRC server identity, version, and description. Use to verify the MCP server is running correctly.",
  schema: infoSchema,
  outputSchema: infoOutputSchema,
  execute,
};
