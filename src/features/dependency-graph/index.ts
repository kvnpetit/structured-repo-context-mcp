import * as path from "node:path";

import { collectFiles, createIgnoreFilter } from "@core/files";
import { parseCode } from "@core/parser";
import {
  extractCodeInfo,
  extractTypeHierarchy,
  type TypeHierarchyRelation,
} from "@core/symbols";
import {
  readSecureTextFile,
  resolveSecureDirectory,
  resolveSecureFile,
} from "@core/security";
import { readPathAliasesCached } from "@core/utils";
import type { Feature, FeatureResult } from "@features/types";
import {
  dependencyGraphOutputSchema,
  dependencyGraphSchema,
  type DependencyGraphInput,
  type DependencyGraphOutput,
  type GraphEdge,
  type TypeNode,
} from "./schema";

export {
  dependencyGraphOutputSchema,
  dependencyGraphSchema,
  type DependencyGraphInput,
} from "./schema";

interface SimpleImport {
  source: string;
  names: string[];
}

const extensions = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
];

function relativePath(root: string, value: string): string {
  return path.relative(root, value).replace(/\\/g, "/");
}

function extractTextImports(content: string): SimpleImport[] {
  const imports: SimpleImport[] = [];
  const pattern = /\bimport\s+([^;\n]*?)(?:\s+from\s+)?["']([^"']+)["']/gu;
  for (const match of content.matchAll(pattern)) {
    const clause = match[1] ?? "";
    imports.push({
      source: match[2] ?? "",
      names: clause
        .replace(/^type\s+/u, "")
        .replace(/[{}]/g, "")
        .split(",")
        .map((value) => value.trim().split(/\s+as\s+/u)[0] ?? "")
        .filter(Boolean),
    });
  }
  return imports;
}

function resolveImport(
  source: string,
  currentFile: string,
  root: string,
  aliases: Record<string, string>,
): string | null {
  let base: string | undefined;
  for (const [alias, target] of Object.entries(aliases)) {
    if (source === alias || source.startsWith(`${alias}/`)) {
      base = path.resolve(
        root,
        target,
        source.slice(alias.length).replace(/^[/\\]/u, ""),
      );
      break;
    }
  }
  if (!base && source.startsWith(".")) {
    base = path.resolve(path.dirname(currentFile), source);
  }
  if (!base) {
    return null;
  }

  const candidates = [
    base,
    ...extensions.map((extension) => `${base}${extension}`),
    ...extensions.map((extension) => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    const secure = resolveSecureFile(candidate, root);
    if (secure.ok) {
      return secure.path;
    }
  }
  return null;
}

function findCycles(nodes: string[], edges: GraphEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node, []);
  }
  for (const edge of edges) {
    if (!edge.resolved) {
      continue;
    }
    const targets = adjacency.get(edge.from);
    if (targets && !targets.includes(edge.to)) {
      targets.push(edge.to);
    }
  }

  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (node: string, stack: string[]): void => {
    const position = stack.indexOf(node);
    if (position >= 0) {
      const cycle = stack.slice(position);
      const key = [...cycle].sort().join("|");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle);
      }
      return;
    }
    if (stack.length >= 50) {
      return;
    }
    for (const target of adjacency.get(node) ?? []) {
      visit(target, [...stack, node]);
    }
  };
  for (const node of nodes) {
    visit(node, []);
  }
  return cycles.slice(0, 50);
}

export async function execute(
  rawInput: DependencyGraphInput,
): Promise<FeatureResult> {
  const input = dependencyGraphSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  const ignore = createIgnoreFilter(root);
  const allFiles = collectFiles(root, ignore, root).sort((left, right) =>
    left.localeCompare(right),
  );
  const files = allFiles.slice(0, input.max_files);
  const aliases = readPathAliasesCached(root);
  const output: DependencyGraphOutput = {
    directory: root,
    nodes: [],
    edges: [],
    total_edges: 0,
    truncated: false,
    files_truncated: files.length < allFiles.length,
    cycles: [],
    hotspots: [],
    unresolvedImports: 0,
    filesAnalyzed: 0,
    errors: [],
    typeHierarchy: {
      nodes: [],
      edges: [],
      unresolved: [],
      truncated: false,
    },
  };
  const absoluteToRelative = new Map<string, string>();
  const importsByFile = new Map<
    string,
    { source: string; names: string[] }[]
  >();
  const typeRelations: { path: string; relations: TypeHierarchyRelation[] }[] =
    [];

  for (const file of files) {
    const readResult = readSecureTextFile(file, root);
    if (!readResult.ok || readResult.content === undefined) {
      output.errors.push(`Cannot read ${relativePath(root, file)}`);
      continue;
    }
    try {
      const parsed = await parseCode(readResult.content, { filePath: file });
      const info = extractCodeInfo(
        parsed.tree,
        parsed.languageInstance,
        parsed.language,
      );
      const fileRelative = relativePath(root, file);
      absoluteToRelative.set(file, fileRelative);
      importsByFile.set(
        file,
        info.imports.length > 0 &&
          info.imports.some((item) => item.source.length > 0)
          ? info.imports.map((item) => ({
              source: item.source,
              names: item.names.map((name) => name.alias ?? name.name),
            }))
          : extractTextImports(readResult.content),
      );
      output.nodes.push({
        path: fileRelative,
        language: parsed.language,
        imports: info.imports.length,
        exports: info.exports.length,
      });
      typeRelations.push({
        path: fileRelative,
        relations: extractTypeHierarchy(readResult.content, parsed.language),
      });
      output.filesAnalyzed++;
    } catch {
      output.errors.push(`Cannot parse ${relativePath(root, file)}`);
    }
  }

  for (const [file, imports] of importsByFile) {
    const from = absoluteToRelative.get(file);
    if (!from) {
      continue;
    }
    for (const item of imports) {
      const target = resolveImport(item.source, file, root, aliases);
      const to = target ? absoluteToRelative.get(target) : undefined;
      if (
        !to &&
        !input.include_external &&
        item.source &&
        !item.source.startsWith(".")
      ) {
        continue;
      }
      if (!to) {
        output.unresolvedImports++;
      }
      output.total_edges++;
      if (output.edges.length < input.max_edges) {
        output.edges.push({
          from,
          to: to ?? item.source,
          source: item.source,
          names: item.names,
          resolved: to !== undefined,
        });
      }
    }
  }
  output.truncated = output.total_edges > output.edges.length;

  const typeNameMap = new Map<string, TypeNode[]>();
  const includedTypeIds = new Set<string>();
  for (const group of typeRelations) {
    for (const relation of group.relations) {
      if (output.typeHierarchy.nodes.length >= input.max_type_nodes) {
        output.typeHierarchy.truncated = true;
        break;
      }
      const node: TypeNode = {
        id: `${group.path}:${relation.name}`,
        name: relation.name,
        kind: relation.kind,
        path: group.path,
        line: relation.line,
      };
      output.typeHierarchy.nodes.push(node);
      includedTypeIds.add(node.id);
      const keys = [
        relation.name,
        relation.name.split(".").at(-1) ?? relation.name,
      ];
      for (const key of keys) {
        const entries = typeNameMap.get(key) ?? [];
        entries.push(node);
        typeNameMap.set(key, entries);
      }
    }
  }

  for (const group of typeRelations) {
    for (const relation of group.relations) {
      const from = `${group.path}:${relation.name}`;
      if (!includedTypeIds.has(from)) {
        continue;
      }
      for (const parent of relation.parents) {
        if (output.typeHierarchy.edges.length >= input.max_type_edges) {
          output.typeHierarchy.truncated = true;
          break;
        }
        const candidates =
          typeNameMap.get(parent) ??
          typeNameMap.get(parent.split(".").at(-1) ?? parent) ??
          [];
        const target =
          candidates.find((candidate) => candidate.path === group.path) ??
          candidates[0];
        if (!target) {
          output.typeHierarchy.unresolved.push(parent);
        }
        output.typeHierarchy.edges.push({
          from,
          to: target?.id ?? parent,
          parent,
          resolved: target !== undefined,
        });
      }
      if (output.typeHierarchy.edges.length >= input.max_type_edges) {
        break;
      }
    }
    if (output.typeHierarchy.edges.length >= input.max_type_edges) {
      break;
    }
  }
  output.typeHierarchy.unresolved = [
    ...new Set(output.typeHierarchy.unresolved),
  ].slice(0, 200);

  const degrees = new Map<string, { inbound: number; outbound: number }>();
  for (const node of output.nodes) {
    degrees.set(node.path, { inbound: 0, outbound: 0 });
  }
  for (const edge of output.edges) {
    const from = degrees.get(edge.from);
    if (from) {
      from.outbound++;
    }
    const to = degrees.get(edge.to);
    if (to) {
      to.inbound++;
    }
  }
  output.hotspots = [...degrees.entries()]
    .map(([file, degree]) => ({
      ...degree,
      path: file,
      score: degree.inbound * 2 + degree.outbound,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  output.cycles = findCycles(
    output.nodes.map((node) => node.path),
    output.edges,
  );

  return {
    success: true,
    message: `Dependency graph: ${String(output.nodes.length)} files, ${String(output.edges.length)} edges, ${String(output.cycles.length)} cycles`,
    data: output,
  };
}

export const dependencyGraphFeature: Feature<typeof dependencyGraphSchema> = {
  name: "get_dependency_graph",
  title: "Get dependency graph",
  description:
    "Read-only project architecture analysis: resolve imports/exports, expose a dependency graph, detect cycles, and rank inbound/outbound hotspots.",
  schema: dependencyGraphSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  outputSchema: dependencyGraphOutputSchema,
  execute,
};
