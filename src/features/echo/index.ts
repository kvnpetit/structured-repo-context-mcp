import { z } from "zod";
import type { Feature, FeatureResult } from "@/features/types";

export const echoSchema = z.object({
  message: z.string().describe("Le message à renvoyer"),
});

export type EchoInput = z.infer<typeof echoSchema>;

export function execute(input: EchoInput): FeatureResult {
  return {
    success: true,
    message: `Echo: ${input.message}`,
    data: { original: input.message },
  };
}

export const echoFeature: Feature<typeof echoSchema> = {
  name: "echo",
  description: "Renvoie le message passé en paramètre",
  schema: echoSchema,
  execute,
};
