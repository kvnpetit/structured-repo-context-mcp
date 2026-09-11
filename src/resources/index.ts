import * as crypto from "node:crypto";
import * as path from "node:path";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { config } from "@config";
import { features } from "@features";
import {
  getIndexStatusFeature,
  getProjectCatalogFeature,
  projectContextFeature,
  getProjectMemoryFeature,
  repositoryMapFeature,
  getServerInfo,
} from "@features";
import {
  getConfiguredAllowedRoots,
  hasConfiguredAllowedRoots,
  resolveSecureDirectory,
} from "@core/security";
import { getToolConfiguration } from "@tools";

export const PROJECT_VIEWS = ["context", "map", "status", "catalog", "memory"] as const;
type ProjectView = (typeof PROJECT_VIEWS)[number];

export const RESOURCE_SURFACE = {
  static: [
    {
      name: "server_info",
      uri: "src://server/info",
      mimeType: "application/json",
      description: "MCP server metadata",
    },
    {
      name: "server_capabilities",
      uri: "src://server/capabilities",
      mimeType: "application/json",
      description: "Discoverable SRC tool catalog and runtime profile",
    },
  ],
  template: {
    name: "project_views",
    uri: "src://project/{project}/{view}",
    mimeType: "application/json",
    description: "Bounded local project context, map, status, catalog, and memory views",
  },
  views: PROJECT_VIEWS,
} as const;

interface ResourceProject {
  id: string;
  path: string;
}

function projectId(projectPath: string): string {
  return `project-${crypto
    .createHash("sha256")
    .update(projectPath, "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

function resourceProjects(): ResourceProject[] {
  const configured = getConfiguredAllowedRoots().filter((root) => root.exists);
  const candidates =
    configured.length > 0
      ? configured
      : !hasConfiguredAllowedRoots()
        ? [{ path: path.resolve("."), exists: true }]
        : [];
  const projects: ResourceProject[] = [];
  for (const candidate of candidates.slice(0, 64)) {
    const secure = resolveSecureDirectory(candidate.path);
    if (!secure.ok) {
      continue;
    }
    if (projects.some((project) => project.path === secure.path)) {
      continue;
    }
    projects.push({ id: projectId(secure.path), path: secure.path });
  }
  return projects;
}

function projectForId(id: string): ResourceProject | undefined {
  return resourceProjects().find((project) => project.id === id);
}

function isProjectView(value: string | undefined): value is ProjectView {
  return value !== undefined && PROJECT_VIEWS.includes(value as ProjectView);
}

function projectResourceUri(project: ResourceProject, view: ProjectView): string {
  return `src://project/${project.id}/${view}`;
}

function resourceText(
  uri: URL,
  value: unknown,
): {
  contents: [{ uri: string; mimeType: string; text: string }];
} {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

async function readProjectView(
  uri: URL,
  project: ResourceProject,
  view: ProjectView,
): Promise<ReturnType<typeof resourceText>> {
  const result =
    view === "context"
      ? await projectContextFeature.execute({
          directory: project.path,
          max_files: 1_000,
          max_manifests: 100,
          include_scripts: true,
          redact_secrets: true,
        })
      : view === "map"
        ? await repositoryMapFeature.execute({
            directory: project.path,
            focus: [],
            max_tokens: 2_000,
            max_files: 500,
            redact_secrets: true,
          })
        : view === "status"
          ? await getIndexStatusFeature.execute({ directory: project.path })
          : view === "catalog"
            ? await getProjectCatalogFeature.execute({
                directory: project.path,
                scope: "project",
                query: "",
                search_mode: "hybrid",
                limit: 50,
                include_content: false,
                max_content_bytes: 4_000,
                redact_secrets: true,
              })
            : await getProjectMemoryFeature.execute({
                directory: project.path,
                scope: "project",
                query: "",
                search_mode: "hybrid",
                tags: [],
                include_expired: false,
                min_confidence: 0,
                limit: 50,
                redact_secrets: true,
              });
  return resourceText(uri, {
    schema_version: 1,
    local_only: true,
    project_id: project.id,
    project_path: project.path,
    view,
    result,
  });
}

function toolCatalogRevision(enabledTools: readonly string[]): string {
  const descriptors = features
    .filter((feature) => enabledTools.includes(feature.name))
    .map((feature) => ({
      name: feature.name,
      title: feature.title ?? feature.name,
      description: feature.description,
      annotations: feature.annotations ?? {},
      has_output_schema: feature.outputSchema !== undefined,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return crypto.createHash("sha256").update(JSON.stringify(descriptors), "utf8").digest("hex");
}

export function registerResources(server: McpServer): void {
  server.registerResource(
    RESOURCE_SURFACE.static[0].name,
    RESOURCE_SURFACE.static[0].uri,
    {
      mimeType: RESOURCE_SURFACE.static[0].mimeType,
      description: RESOURCE_SURFACE.static[0].description,
    },
    (uri) => {
      const info = getServerInfo();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    RESOURCE_SURFACE.static[1].name,
    RESOURCE_SURFACE.static[1].uri,
    {
      mimeType: RESOURCE_SURFACE.static[1].mimeType,
      description: RESOURCE_SURFACE.static[1].description,
    },
    (uri) => {
      const toolConfiguration = getToolConfiguration();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                schema_version: 1,
                local_only: true,
                name: config.name,
                version: config.version,
                profile: toolConfiguration.profile,
                allowListConfigured: toolConfiguration.allowListConfigured,
                tool_catalog_revision: toolCatalogRevision(toolConfiguration.enabledTools),
                tools: features
                  .filter((feature) => toolConfiguration.enabledTools.includes(feature.name))
                  .map((feature) => ({
                    name: feature.name,
                    title: feature.title ?? feature.name,
                    description: feature.description,
                    annotations: feature.annotations ?? {},
                  })),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  const projectTemplate = new ResourceTemplate(RESOURCE_SURFACE.template.uri, {
    list: () => ({
      resources: resourceProjects().flatMap((project) =>
        PROJECT_VIEWS.map((view) => ({
          uri: projectResourceUri(project, view),
          name: `${path.basename(project.path)} ${view}`,
          description: `Bounded local ${view} view for project ${project.id}`,
          mimeType: "application/json",
        })),
      ),
    }),
  });

  server.registerResource(
    RESOURCE_SURFACE.template.name,
    projectTemplate,
    {
      mimeType: RESOURCE_SURFACE.template.mimeType,
      description: RESOURCE_SURFACE.template.description,
    },
    async (uri, variables) => {
      const projectVariable = typeof variables.project === "string" ? variables.project : undefined;
      const viewVariable = typeof variables.view === "string" ? variables.view : undefined;
      if (projectVariable === undefined || !isProjectView(viewVariable)) {
        throw new Error("Unknown local project resource");
      }
      const project = projectForId(projectVariable);
      if (project === undefined) {
        throw new Error("Unknown local project resource");
      }
      return readProjectView(uri, project, viewVariable);
    },
  );
}
