import * as path from "node:path";

import type { Import, Position, Symbol } from "@core/ast/types";
import { resolveSecureFile } from "@core/security";

import type { EdgeKind, GraphEdge, GraphNode } from "./schema";
import type { ImportBinding, ParsedFile, SignalMatch } from "./types";

const sourceExtensions = [
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
  ".kt",
  ".cs",
  ".rb",
  ".php",
];
export const HARD_RAW_NODES = 50_000;
export const HARD_RAW_EDGES = 100_000;

export function relativePath(root: string, value: string): string {
  return path.relative(root, value).replace(/\\/gu, "/");
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

export function isTestPath(value: string): boolean {
  const normalized = normalizePath(value).toLowerCase();
  return (
    /(?:^|\/)(?:test|tests|__tests__|spec|specs)(?:\/|$)/u.test(normalized) ||
    /(?:\.test|\.spec|_test|_spec)(?:\.[^/]+)+$/u.test(normalized)
  );
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function stringIndexAtByteOffset(content: string, byteOffset: number): number {
  if (byteOffset <= 0) {
    return 0;
  }
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(content.slice(0, middle), "utf8") <= byteOffset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

export function positionAt(content: string, index: number): Position {
  const safeIndex = Math.max(0, Math.min(index, content.length));
  const prefix = content.slice(0, safeIndex);
  const newline = prefix.lastIndexOf("\n");
  return {
    line: (prefix.match(/\n/gu) ?? []).length + 1,
    column: safeIndex - newline - 1,
    offset: Buffer.byteLength(prefix, "utf8"),
  };
}

export function sliceSymbolBody(content: string, symbol: Symbol): string {
  const start = stringIndexAtByteOffset(content, symbol.start.offset);
  const end = stringIndexAtByteOffset(content, symbol.end.offset);
  return content.slice(start, Math.max(start, end));
}

function declarationEnd(content: string, start: number): number {
  const openingBrace = content.indexOf("{", start);
  if (openingBrace < 0) {
    const lineEnd = content.indexOf("\n", start);
    return lineEnd < 0 ? content.length : lineEnd;
  }
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = openingBrace; index < content.length; index++) {
    const character = content[index];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
    } else if (character === "{") {
      depth++;
    } else if (character === "}") {
      depth--;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return content.length;
}

export function fallbackSymbols(content: string): Symbol[] {
  const patterns: { type: Symbol["type"]; pattern: RegExp }[] = [
    {
      type: "class",
      pattern: /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gu,
    },
    {
      type: "interface",
      pattern: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/gu,
    },
    {
      type: "type",
      pattern: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/gu,
    },
    {
      type: "enum",
      pattern: /\b(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/gu,
    },
    {
      type: "function",
      pattern: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gu,
    },
    {
      type: "function",
      pattern: /\bdef\s+([A-Za-z_$][\w$]*)\s*\(/gu,
    },
    {
      type: "function",
      pattern: /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/gu,
    },
    {
      type: "function",
      pattern: /\b(?:pub\s+)?fn\s+([A-Za-z_$][\w$]*)\s*\(/gu,
    },
  ];
  const symbols: Symbol[] = [];
  const seen = new Set<string>();
  for (const entry of patterns) {
    for (const match of content.matchAll(entry.pattern)) {
      const name = match[1];
      if (!name) {
        continue;
      }
      const key = `${entry.type}:${name}:${String(match.index)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const start = positionAt(content, match.index);
      const end = positionAt(content, declarationEnd(content, match.index));
      const declaration = content.slice(match.index, declarationEnd(content, match.index));
      symbols.push({
        name,
        type: entry.type,
        start,
        end,
        ...(entry.type === "function" ? { signature: declaration.split("{")[0]?.trim() } : {}),
        ...(entry.type === "class" && /\bexport\b/u.test(declaration)
          ? { modifiers: ["export"] }
          : {}),
      });
    }
  }
  return symbols.sort(
    (left, right) => left.start.offset - right.start.offset || left.name.localeCompare(right.name),
  );
}

export function mergeSymbols(primary: Symbol[], fallback: Symbol[]): Symbol[] {
  const merged = [...primary];
  const seen = new Set(
    primary.map((symbol) => `${symbol.type}:${symbol.name}:${String(symbol.start.line)}`),
  );
  for (const symbol of fallback) {
    const key = `${symbol.type}:${symbol.name}:${String(symbol.start.line)}`;
    if (!seen.has(key)) {
      merged.push(symbol);
      seen.add(key);
    }
  }
  return merged
    .sort(
      (left, right) =>
        left.start.offset - right.start.offset || left.name.localeCompare(right.name),
    )
    .slice(0, 2_000);
}

export function moduleId(filePath: string): string {
  return `module:${normalizePath(filePath)}`;
}

export function symbolId(filePath: string, symbol: Symbol): string {
  return `symbol:${normalizePath(filePath)}:${String(symbol.start.offset)}:${symbol.name}`;
}

export function signalId(signal: SignalMatch, filePath: string): string {
  return `signal:${signal.kind}:${normalizePath(filePath)}:${String(signal.index)}:${signal.name}`;
}

export function extractTextImports(content: string): Import[] {
  const imports: Import[] = [];
  const pattern = /\bimport\s+([^;\n]*?)(?:\s+from\s+)?["']([^"']+)["']/gu;
  for (const match of content.matchAll(pattern)) {
    const statement = match[0];
    const clause = match[1] ?? "";
    const index = match.index;
    imports.push({
      source: match[2] ?? "",
      names: clause
        .replace(/^type\s+/u, "")
        .replace(/[{}]/gu, "")
        .split(",")
        .map((value) => value.trim().split(/\s+as\s+/u)[0] ?? "")
        .filter(Boolean)
        .map((name) => ({ name })),
      start: positionAt(content, index),
      end: positionAt(content, index + statement.length),
    });
  }
  return imports;
}

export function resolveImport(
  source: string,
  currentFile: string,
  root: string,
  aliases: Record<string, string>,
  knownFiles: Set<string>,
): string | undefined {
  let base: string | undefined;
  for (const [alias, target] of Object.entries(aliases)) {
    if (source === alias || source.startsWith(`${alias}/`)) {
      base = path.resolve(root, target, source.slice(alias.length).replace(/^[/\\]/u, ""));
      break;
    }
  }
  if (base === undefined && source.startsWith(".")) {
    base = path.resolve(path.dirname(currentFile), source);
  }
  if (base === undefined) {
    return undefined;
  }
  const candidates = [
    base,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    const secure = resolveSecureFile(candidate, root);
    if (secure.ok && knownFiles.has(secure.path)) {
      return secure.path;
    }
  }
  return undefined;
}

export function importBindings(
  imports: readonly { item: Import; target?: ParsedFile }[],
): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const { item, target } of imports) {
    if (target === undefined) {
      continue;
    }
    for (const imported of item.names) {
      bindings.set(imported.alias ?? imported.name, {
        file: target,
        imported: imported.name,
      });
    }
    if (item.isDefault && item.names[0]) {
      bindings.set(item.names[0].alias ?? item.names[0].name, {
        file: target,
        imported: "default",
      });
    }
  }
  return bindings;
}

export function findSymbol(
  file: ParsedFile,
  name: string,
  preferredOffset?: number,
): Symbol | undefined {
  const candidates = file.symbols.filter((symbol) => symbol.name === name);
  if (candidates.length === 0) {
    return undefined;
  }
  return candidates
    .slice()
    .sort(
      (left, right) =>
        Math.abs(left.start.offset - (preferredOffset ?? 0)) -
          Math.abs(right.start.offset - (preferredOffset ?? 0)) ||
        left.start.offset - right.start.offset,
    )[0];
}

export function containingSymbol(file: ParsedFile, byteOffset: number): Symbol | undefined {
  return file.symbols
    .filter((symbol) => byteOffset >= symbol.start.offset && byteOffset <= symbol.end.offset)
    .sort(
      (left, right) =>
        left.end.offset - left.start.offset - (right.end.offset - right.start.offset) ||
        left.start.offset - right.start.offset,
    )[0];
}

function nodeMatchesQuery(node: GraphNode, query: string): boolean {
  const normalizedQuery = normalizePath(query).toLowerCase();
  return [node.id, node.name, node.path].some((value) => {
    const normalized = normalizePath(value).toLowerCase();
    return normalized === normalizedQuery || normalized.endsWith(normalizedQuery);
  });
}

export function findMatchingNodeIds(nodes: readonly GraphNode[], query: string): string[] {
  const exact = nodes.filter((node) => nodeMatchesQuery(node, query));
  if (exact.length > 0) {
    return exact.map((node) => node.id);
  }
  const normalized = normalizePath(query).toLowerCase();
  return nodes
    .filter((node) =>
      [node.id, node.name, node.path].some((value) =>
        normalizePath(value).toLowerCase().includes(normalized),
      ),
    )
    .slice(0, 20)
    .map((node) => node.id);
}

export function edgeId(from: string, to: string, kind: EdgeKind): string {
  return `${kind}:${from}->${to}`;
}

export function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function walkPath(
  from: string,
  to: string,
  adjacency: Map<string, GraphEdge[]>,
  reverse: Map<string, GraphEdge[]>,
  direction: "forward" | "reverse" | "both",
  maxLength: number,
): { nodes: string[]; edges: string[]; found: boolean; truncated: boolean } {
  interface State {
    node: string;
    nodes: string[];
    edges: string[];
  }
  const queue: State[] = [{ node: from, nodes: [from], edges: [] }];
  const visited = new Set<string>([from]);
  let truncated = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    if (current.node === to) {
      return {
        nodes: current.nodes,
        edges: current.edges,
        found: true,
        truncated,
      };
    }
    if (current.edges.length >= maxLength) {
      truncated = true;
      continue;
    }
    const outgoing =
      direction === "forward"
        ? (adjacency.get(current.node) ?? [])
        : direction === "reverse"
          ? (reverse.get(current.node) ?? [])
          : [...(adjacency.get(current.node) ?? []), ...(reverse.get(current.node) ?? [])];
    for (const edge of outgoing) {
      const next =
        direction === "reverse" || (direction === "both" && edge.to === current.node)
          ? edge.from
          : edge.to;
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      queue.push({
        node: next,
        nodes: [...current.nodes, next],
        edges: [...current.edges, edge.id],
      });
    }
  }
  return { nodes: [], edges: [], found: false, truncated };
}

export function relationshipEdges(
  edges: readonly GraphEdge[],
  includedKinds: readonly EdgeKind[],
): GraphEdge[] {
  const kinds = new Set(includedKinds);
  return edges.filter((edge) => kinds.has(edge.kind));
}
