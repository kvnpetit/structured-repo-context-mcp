import { defineCommand, type CommandDef } from "citty";

import { normalizeCliArgs, zodToCittyArgs } from "@cli/parser";
import {
  executeFeature,
  finalizeFeatureResult,
  formatFeatureResult,
} from "@features/runtime";
import type { Feature } from "@features/types";
import { colors } from "@utils";

function validationMessage(
  issues: readonly { path: PropertyKey[]; message: string }[],
): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `--${issue.path.join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

/** Convert a Feature to an awaited, schema-validating Citty command. */
export function featureToCittyCommand(feature: Feature): CommandDef {
  return defineCommand({
    meta: {
      name: feature.name,
      description: feature.description,
    },
    args: zodToCittyArgs(feature.schema),
    async run({ args }) {
      try {
        const input = normalizeCliArgs(feature.schema, args);
        const parsed = feature.schema.safeParse(input);
        if (!parsed.success) {
          console.error(
            colors.formatError(
              `Invalid arguments: ${validationMessage(parsed.error.issues)}`,
            ),
          );
          process.exitCode = 1;
          return;
        }

        const result = await executeFeature(feature, parsed.data);
        const formatted = finalizeFeatureResult(feature, result);
        const output = JSON.stringify(formatted.structuredContent, null, 2);
        if (!formatted.isError) {
          console.log(output);
          return;
        }
        console.error(output);
        process.exitCode = 1;
      } catch {
        const failure = formatFeatureResult({
          success: false,
          error: "Tool execution failed",
        });
        console.error(JSON.stringify(failure.structuredContent, null, 2));
        process.exitCode = 1;
      }
    },
  });
}
