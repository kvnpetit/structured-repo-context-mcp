import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import type { Feature, FeatureExecutionContext } from "@features/types";
import { executeFeature, finalizeFeatureResult, formatFeatureResult } from "@features/runtime";
import { createFeatureToolConfig, usesFlatMcpInput } from "@tools/contracts";

export function registerFeatureAsTool(server: McpServer, feature: Feature): void {
  server.registerTool(
    feature.name,
    createFeatureToolConfig(feature),
    async (params, context?: ServerContext) => {
      try {
        const featureInput = usesFlatMcpInput(feature.schema)
          ? params
          : (params as { input: unknown }).input;
        const featureContext: FeatureExecutionContext = {
          signal: context?.mcpReq.signal,
          reportProgress: async (progress, total, message) => {
            if (!context) {
              return;
            }
            const progressToken = context.mcpReq._meta?.progressToken;
            if (progressToken === undefined) {
              return;
            }
            await context.mcpReq.notify({
              method: "notifications/progress",
              params: {
                progressToken,
                progress,
                ...(total === undefined ? {} : { total }),
                ...(message === undefined ? {} : { message }),
              },
            });
          },
        };
        const featureResult = await executeFeature(feature, featureInput, featureContext);
        return finalizeFeatureResult(feature, featureResult);
      } catch {
        return formatFeatureResult({
          success: false,
          error: "Tool execution failed",
        });
      }
    },
  );
}

export {
  executeFeature,
  formatFeatureResult,
  FEATURE_RESULT_SCHEMA_VERSION,
} from "@features/runtime";
