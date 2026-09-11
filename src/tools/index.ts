import type { McpServer } from "@modelcontextprotocol/server";
import { features } from "@features";
import { registerFeatureAsTool } from "@tools/adapter";
import { isMutatingFeatureName } from "@tools/contracts";

export type ToolProfile = "full" | "readonly" | "minimal";

const MINIMAL_TOOL_NAMES = new Set([
  "get_server_info",
  "get_index_status",
  "search_code",
  "get_diagnostics",
  "get_observability",
  "list_projects",
  "get_repository_map",
  "get_symbol_at_position",
  "assemble_task_context",
  "get_project_artifacts",
  "get_project_context",
  "semantic_navigation",
  "get_symbol_graph",
  "get_project_memory",
  "get_project_catalog",
  "get_git_context",
]);

export interface ToolConfiguration {
  profile: ToolProfile;
  allowListConfigured: boolean;
  allowList: string[];
  unknownAllowListEntries: string[];
  enabledTools: string[];
}

function parseAllowList(value: string | undefined): string[] {
  return (
    value
      ?.split(/[;,]/u)
      .map((name) => name.trim())
      .filter(Boolean) ?? []
  );
}

function normalizeProfile(value: string | undefined): ToolProfile {
  return value === "readonly" || value === "minimal" ? value : "full";
}

function resolveToolNames(
  allNames: readonly string[],
  allowList: string[],
  profile: ToolProfile,
): string[] {
  const hasExplicitAllowList = allowList.length > 0 && !allowList.includes("*");
  if (hasExplicitAllowList) {
    const allowed = new Set(allowList);
    return allNames.filter((name) => allowed.has(name));
  }
  if (profile === "readonly") {
    return allNames.filter((name) => !isMutatingFeatureName(name));
  }
  if (profile === "minimal") {
    return allNames.filter((name) => MINIMAL_TOOL_NAMES.has(name));
  }
  return [...allNames];
}

/**
 * Resolve the optional MCP-only tool allow-list.
 *
 * An empty value (or `*`) keeps the backwards-compatible full surface. Unknown
 * names are ignored so a stale deployment variable cannot prevent the server
 * from starting.
 */
export function getEnabledFeatures(
  allowList = process.env.SRC_TOOL_ALLOWLIST,
  profile = process.env.SRC_TOOL_PROFILE,
): typeof features {
  const configured = parseAllowList(allowList);
  const selectedNames = new Set(
    resolveToolNames(
      features.map((feature) => feature.name),
      configured,
      normalizeProfile(profile),
    ),
  );
  return features.filter((feature) => selectedNames.has(feature.name));
}

export function getToolConfiguration(
  allowList = process.env.SRC_TOOL_ALLOWLIST,
  profile = process.env.SRC_TOOL_PROFILE,
): ToolConfiguration {
  const configured = parseAllowList(allowList);
  const normalizedProfile = normalizeProfile(profile);
  const allNames = features.map((feature) => feature.name);
  const known = new Set(allNames);
  return {
    profile: normalizedProfile,
    allowListConfigured: configured.length > 0,
    allowList: [...configured],
    unknownAllowListEntries: configured.filter((name) => name !== "*" && !known.has(name)),
    enabledTools: resolveToolNames(allNames, configured, normalizedProfile),
  };
}

export function registerTools(server: McpServer, enabledFeatures = getEnabledFeatures()): void {
  for (const feature of enabledFeatures) {
    registerFeatureAsTool(server, feature);
  }
}

export { features as tools };
