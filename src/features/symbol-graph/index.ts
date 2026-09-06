import type { Import, Symbol } from "@core/ast/types";
import { extractTypeHierarchy } from "@core/symbols";
import { redactSourceText, resolveSecureDirectory } from "@core/security";
import { readPathAliasesCached } from "@core/utils";
import type { Feature, FeatureResult } from "@features/types";
import {
  HARD_RAW_EDGES,
  HARD_RAW_NODES,
  edgeId,
  escapeRegExp,
  findSymbol,
  importBindings,
  moduleId,
  positionAt,
  resolveImport,
  sliceSymbolBody,
  stringIndexAtByteOffset,
  symbolId,
} from "./helpers";
import { loadGraphFiles } from "./loader";
import { createGraphOutput } from "./output";
import { addDefinitionNodes, addSignalNodes } from "./phases";
import { analyzeGraph } from "./analysis";
import {
  symbolGraphOutputSchema,
  symbolGraphSchema,
  type EdgeKind,
  type GraphEdge,
  type GraphNode,
  type SymbolGraphInput,
  type UnresolvedRelation,
} from "./schema";
import type { ParsedFile } from "./types";

export {
  symbolGraphOutputSchema,
  symbolGraphSchema,
  type SymbolGraphInput,
} from "./schema";

export async function execute(
  rawInput: SymbolGraphInput,
): Promise<FeatureResult> {
  const input = symbolGraphSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  const { parsedFiles, filesTruncated, errors, sourceRevision } =
    await loadGraphFiles(root, input.max_files);

  const knownFiles = new Set(parsedFiles.map((file) => file.absolutePath));
  const fileByAbsolute = new Map(
    parsedFiles.map((file) => [file.absolutePath, file]),
  );
  const aliases = readPathAliasesCached(root);
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const unresolved: UnresolvedRelation[] = [];
  let rawNodesSkipped = 0;
  let rawEdgesSkipped = 0;
  let secretsRedacted = false;

  const addNode = (node: GraphNode): void => {
    if (nodes.has(node.id)) {
      return;
    }
    if (nodes.size >= HARD_RAW_NODES) {
      rawNodesSkipped += 1;
      return;
    }
    nodes.set(node.id, node);
  };
  const addEdge = (
    from: string,
    to: string,
    kind: EdgeKind,
    confidence: number,
    file: ParsedFile,
    index?: number,
    evidence?: string,
  ): void => {
    const key = `${kind}:${from}:${to}`;
    if (edgeKeys.has(key)) {
      return;
    }
    edgeKeys.add(key);
    if (edges.length >= HARD_RAW_EDGES) {
      rawEdgesSkipped += 1;
      return;
    }
    const safeEvidence =
      evidence === undefined
        ? undefined
        : input.redact_secrets
          ? redactSourceText(evidence)
          : { text: evidence, redacted: false };
    if (safeEvidence?.redacted) {
      secretsRedacted = true;
    }
    edges.push({
      id: edgeId(from, to, kind),
      from,
      to,
      kind,
      confidence,
      path: file.relativePath,
      ...(index === undefined
        ? {}
        : { line: positionAt(file.content, index).line }),
      ...(safeEvidence === undefined ? {} : { evidence: safeEvidence.text }),
    });
  };

  addDefinitionNodes(parsedFiles, addNode, addEdge);

  const importsByFile = new Map<
    string,
    { item: Import; target?: ParsedFile }[]
  >();
  for (const file of parsedFiles) {
    const imports = file.imports.map((item) => ({
      item,
      target: resolveImport(
        item.source,
        file.absolutePath,
        root,
        aliases,
        knownFiles,
      ),
    }));
    const resolvedImports = imports.map(({ item, target }) => ({
      item,
      target: target === undefined ? undefined : fileByAbsolute.get(target),
    }));
    importsByFile.set(file.absolutePath, resolvedImports);
    for (const { item, target } of resolvedImports) {
      if (target === undefined) {
        if (item.source.startsWith(".") || item.source in aliases) {
          unresolved.push({
            kind: "import",
            from: moduleId(file.relativePath),
            target: item.source,
            path: file.relativePath,
            line: item.start.line,
          });
        }
        continue;
      }
      addEdge(
        moduleId(file.relativePath),
        moduleId(target.relativePath),
        "imports",
        0.96,
        file,
        item.start.offset,
        item.source,
      );
      for (const imported of item.names) {
        const targetSymbol = findSymbol(target, imported.name);
        if (targetSymbol) {
          addEdge(
            moduleId(file.relativePath),
            symbolId(target.relativePath, targetSymbol),
            "imports",
            0.9,
            file,
            item.start.offset,
            imported.alias
              ? `${imported.name} as ${imported.alias}`
              : imported.name,
          );
        }
      }
    }
  }

  const symbolsByName = new Map<
    string,
    { file: ParsedFile; symbol: Symbol }[]
  >();
  for (const file of parsedFiles) {
    for (const symbol of file.symbols) {
      const entries = symbolsByName.get(symbol.name) ?? [];
      entries.push({ file, symbol });
      symbolsByName.set(symbol.name, entries);
    }
  }

  for (const file of parsedFiles) {
    const bindings = importBindings(importsByFile.get(file.absolutePath) ?? []);
    for (const sourceSymbol of file.symbols) {
      const body = sliceSymbolBody(file.content, sourceSymbol);
      const identifiers = new Set<string>();
      for (const match of body.matchAll(/\b[A-Za-z_$][\w$]*\b/gu)) {
        if (match[0]) {
          identifiers.add(match[0]);
        }
        if (identifiers.size >= 250) {
          break;
        }
      }
      for (const name of identifiers) {
        const candidates = symbolsByName.get(name) ?? [];
        if (candidates.length === 0) {
          continue;
        }
        const binding = bindings.get(name);
        const target = binding
          ? findSymbol(binding.file, binding.imported)
          : findSymbol(file, name, sourceSymbol.start.offset);
        const fallback =
          target === undefined && candidates.length === 1
            ? candidates[0]
            : undefined;
        const resolved =
          target === undefined
            ? fallback
            : { file: binding?.file ?? file, symbol: target };
        if (resolved === undefined) {
          continue;
        }
        const targetId = symbolId(resolved.file.relativePath, resolved.symbol);
        const sourceId = symbolId(file.relativePath, sourceSymbol);
        if (sourceId === targetId) {
          continue;
        }
        const callPattern = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`, "u");
        const match = callPattern.exec(body);
        const bodyStart = stringIndexAtByteOffset(
          file.content,
          sourceSymbol.start.offset,
        );
        addEdge(
          sourceId,
          targetId,
          match ? "calls" : "references",
          binding || candidates.length === 1 ? 0.78 : 0.58,
          file,
          match ? bodyStart + match.index : undefined,
          name,
        );
      }
    }
  }

  for (const file of parsedFiles) {
    const typeRelations = extractTypeHierarchy(file.content, file.language);
    for (const relation of typeRelations) {
      const source = findSymbol(file, relation.name);
      if (source === undefined) {
        continue;
      }
      for (const parent of relation.parents) {
        const local = findSymbol(file, parent);
        const candidates = symbolsByName.get(parent) ?? [];
        const target =
          local ??
          (candidates.length === 1 ? candidates[0]?.symbol : undefined);
        const targetFile = local
          ? file
          : candidates.length === 1
            ? candidates[0]?.file
            : undefined;
        if (target === undefined || targetFile === undefined) {
          unresolved.push({
            kind: relation.kind === "impl" ? "implements" : "inherits",
            from: symbolId(file.relativePath, source),
            target: parent,
            path: file.relativePath,
            line: relation.line,
          });
          continue;
        }
        addEdge(
          symbolId(file.relativePath, source),
          symbolId(targetFile.relativePath, target),
          relation.kind === "impl" ? "implements" : "inherits",
          0.68,
          file,
          stringIndexAtByteOffset(file.content, source.start.offset),
          parent,
        );
      }
    }
  }

  if (input.include_tests) {
    for (const file of parsedFiles.filter((candidate) => candidate.isTest)) {
      const sourceSymbols =
        file.symbols.length > 0
          ? file.symbols
          : [
              {
                name: file.relativePath,
                type: "property",
                start: positionAt(file.content, 0),
                end: positionAt(file.content, file.content.length),
              } satisfies Symbol,
            ];
      if (file.symbols.length === 0) {
        const synthetic = sourceSymbols[0];
        if (synthetic) {
          addNode({
            id: symbolId(file.relativePath, synthetic),
            kind: "symbol",
            name: synthetic.name,
            path: file.relativePath,
            language: file.language,
            symbol_type: "test-file",
            line: synthetic.start.line,
            end_line: synthetic.end.line,
            is_test: true,
          });
        }
      }
      for (const testSymbol of sourceSymbols) {
        const body = sliceSymbolBody(file.content, testSymbol);
        const identifiers = new Set<string>();
        for (const match of body.matchAll(/\b[A-Za-z_$][\w$]*\b/gu)) {
          if (match[0]) {
            identifiers.add(match[0]);
          }
          if (identifiers.size >= 200) {
            break;
          }
        }
        for (const name of identifiers) {
          const candidates = (symbolsByName.get(name) ?? []).filter(
            (candidate) => !candidate.file.isTest,
          );
          if (candidates.length !== 1) {
            continue;
          }
          const target = candidates[0];
          if (!target) {
            continue;
          }
          addEdge(
            symbolId(file.relativePath, testSymbol),
            symbolId(target.file.relativePath, target.symbol),
            "tests",
            0.62,
            file,
            0,
            name,
          );
        }
      }
    }
  }

  let signalCounts = { routes: 0, events: 0, dependencies: 0 };
  if (input.include_signals) {
    const signalResult = addSignalNodes(
      parsedFiles,
      input.redact_secrets,
      addNode,
      addEdge,
    );
    signalCounts = signalResult.counts;
    secretsRedacted ||= signalResult.secretsRedacted;
  }

  const analysis = analyzeGraph({
    nodes,
    edges,
    input,
    filesTruncated,
    rawNodesSkipped,
    rawEdgesSkipped,
  });

  const output = createGraphOutput({
    root,
    filesAnalyzed: parsedFiles.length,
    filesTruncated,
    sourceRevision,
    analysis,
    signalCounts,
    unresolved,
    secretsRedacted,
    errors,
  });

  return {
    success: true,
    message: `Symbol graph: ${String(output.nodes.length)} nodes, ${String(output.edges.length)} edges${output.truncated ? " (bounded/truncated)" : ""}`,
    data: output,
  };
}

export const symbolGraphFeature: Feature<typeof symbolGraphSchema> = {
  name: "get_symbol_graph",
  title: "Get unified symbol graph",
  description:
    "Build a bounded local symbol-level graph combining modules, definitions, imports, references, calls, inheritance, tests, routes, events, and dependency-injection signals, with trace paths and blast-radius analysis.",
  schema: symbolGraphSchema,
  outputSchema: symbolGraphOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute,
};
