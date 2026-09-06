import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import {
  getConfiguredAllowedRoots,
  hasConfiguredAllowedRoots,
  resolveSecureDirectory,
} from "@core/security";
import { getIndexStatusFeature } from "@features/get-index-status";
import { indexStatusDataSchema } from "@features/get-index-status";
import type { Feature, FeatureResult } from "@features/types";
import { createFeatureResultSchema } from "@features/utils";

const MAX_PROJECTS = 64;

export const listProjectsSchema = z.object({
  includeCurrent: z
    .boolean()
    .optional()
    .default(true)
    .describe("Include the current directory when no roots are configured"),
});

export type ListProjectsInput = z.infer<typeof listProjectsSchema>;

interface ProjectSummary {
  path: string;
  source: "SRC_ALLOWED_ROOTS" | "current_working_directory";
  exists: boolean;
  index: unknown;
  error?: string;
}

const projectIndexSchema = z.union([
  indexStatusDataSchema,
  z
    .object({ available: z.literal(false), error: z.string().optional() })
    .strict(),
]);

const listProjectsDataSchema = z
  .object({
    configuredRoots: z.number().int().nonnegative(),
    allowListConfigured: z.boolean(),
    truncated: z.boolean(),
    projects: z
      .object({
        path: z.string(),
        source: z.enum(["SRC_ALLOWED_ROOTS", "current_working_directory"]),
        exists: z.boolean(),
        index: projectIndexSchema,
        error: z.string().optional(),
      })
      .strict()
      .array(),
  })
  .strict();

export const listProjectsOutputSchema = createFeatureResultSchema(
  listProjectsDataSchema,
);

export async function execute(
  input: ListProjectsInput,
): Promise<FeatureResult> {
  const configured = getConfiguredAllowedRoots();
  const roots =
    configured.length > 0
      ? configured.slice(0, MAX_PROJECTS).map((root) => ({
          path: root.path,
          source: "SRC_ALLOWED_ROOTS" as const,
          exists: root.exists,
        }))
      : !hasConfiguredAllowedRoots() && input.includeCurrent
        ? [
            {
              path: path.resolve("."),
              source: "current_working_directory" as const,
              exists: fs.existsSync(path.resolve(".")),
            },
          ]
        : [];

  const projects: ProjectSummary[] = [];
  for (const root of roots) {
    if (!root.exists) {
      projects.push({
        path: root.path,
        source: root.source,
        exists: false,
        index: { available: false },
        error: "Path not found",
      });
      continue;
    }

    const secure = resolveSecureDirectory(root.path);
    if (!secure.ok) {
      projects.push({
        path: root.path,
        source: root.source,
        exists: false,
        index: { available: false },
        error: secure.error,
      });
      continue;
    }

    const indexResult = await getIndexStatusFeature.execute({
      directory: secure.path,
    });
    projects.push({
      path: secure.path,
      source: root.source,
      exists: true,
      index: indexResult.success
        ? indexResult.data
        : { available: false, error: indexResult.error },
    });
  }

  return {
    success: true,
    message: `Found ${String(projects.length)} configured project${projects.length === 1 ? "" : "s"}`,
    data: {
      configuredRoots: configured.length,
      allowListConfigured: hasConfiguredAllowedRoots(),
      truncated: configured.length > MAX_PROJECTS,
      projects,
    },
  };
}

export const listProjectsFeature: Feature<typeof listProjectsSchema> = {
  name: "list_projects",
  title: "List configured projects",
  description:
    "List the safe project roots available to SRC and each index status. Use this before querying multiple configured repositories; projects remain independently indexed and queried.",
  schema: listProjectsSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: listProjectsOutputSchema,
  execute,
};
