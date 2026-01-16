import type { CLICommand, CLIOption } from "@/types";
import type { Feature } from "@/features/types";
import { z } from "zod";

function zodToCLIOptions(schema: z.ZodType): CLIOption[] {
  const options: CLIOption[] = [];

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;

    for (const [key, value] of Object.entries(shape)) {
      const isOptional =
        value instanceof z.ZodOptional || value instanceof z.ZodDefault;
      let description = "";

      if ("description" in value && typeof value.description === "string") {
        description = value.description;
      } else if (
        value instanceof z.ZodOptional ||
        value instanceof z.ZodDefault
      ) {
        const inner = value.def.innerType as z.ZodType;
        if ("description" in inner && typeof inner.description === "string") {
          description = inner.description;
        }
      }

      options.push({
        flag: `--${key}`,
        description: description !== "" ? description : `Option ${key}`,
        required: !isOptional,
      });
    }
  }

  return options;
}

function parseOptionsForFeature(
  options: Record<string, string | boolean>,
  schema: z.ZodType
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>;

    for (const key of Object.keys(shape)) {
      if (key in options) {
        result[key] = options[key];
      }
    }
  }

  return result;
}

export function featureToCLICommand(feature: Feature): CLICommand {
  return {
    name: feature.name,
    description: feature.description,
    options: zodToCLIOptions(feature.schema),

    action(_args, options): void {
      const input = parseOptionsForFeature(options, feature.schema);
      const result = feature.execute(input);

      const handleResult = (
        res: Awaited<ReturnType<typeof feature.execute>>
      ): void => {
        if (res.success) {
          console.log(res.message ?? JSON.stringify(res.data, null, 2));
        } else {
          console.error(`Erreur: ${res.error ?? "Erreur inconnue"}`);
          process.exit(1);
        }
      };

      if (result instanceof Promise) {
        void result.then(handleResult);
      } else {
        handleResult(result);
      }
    },
  };
}
