import { redactSourceText } from "@core/security";
import {
  containingSymbol,
  moduleId,
  positionAt,
  signalId,
  symbolId,
} from "./helpers";
import type { EdgeKind, GraphNode } from "./schema";
import { findSignals } from "./signals";
import type { ParsedFile } from "./types";

export type AddGraphNode = (node: GraphNode) => void;
export type AddGraphEdge = (
  from: string,
  to: string,
  kind: EdgeKind,
  confidence: number,
  file: ParsedFile,
  index?: number,
  evidence?: string,
) => void;

export function addDefinitionNodes(
  files: readonly ParsedFile[],
  addNode: AddGraphNode,
  addEdge: AddGraphEdge,
): void {
  for (const file of files) {
    const module = moduleId(file.relativePath);
    addNode({
      id: module,
      kind: "module",
      name: file.relativePath,
      path: file.relativePath,
      language: file.language,
      is_test: file.isTest,
    });
    for (const symbol of file.symbols) {
      const id = symbolId(file.relativePath, symbol);
      addNode({
        id,
        kind: "symbol",
        name: symbol.name,
        path: file.relativePath,
        language: file.language,
        symbol_type: symbol.type,
        line: symbol.start.line,
        end_line: symbol.end.line,
        signature: symbol.signature,
        is_test: file.isTest,
      });
      addEdge(module, id, "contains", 1, file, symbol.start.offset);
    }
  }
}

export function addSignalNodes(
  files: readonly ParsedFile[],
  redactSecrets: boolean,
  addNode: AddGraphNode,
  addEdge: AddGraphEdge,
): {
  counts: { routes: number; events: number; dependencies: number };
  secretsRedacted: boolean;
} {
  const counts = { routes: 0, events: 0, dependencies: 0 };
  let secretsRedacted = false;
  for (const file of files) {
    for (const signal of findSignals(file.content)) {
      const id = signalId(signal, file.relativePath);
      const safeEvidence = redactSecrets
        ? redactSourceText(signal.evidence)
        : { text: signal.evidence, redacted: false };
      secretsRedacted ||= safeEvidence.redacted;
      addNode({
        id,
        kind: signal.kind,
        name:
          signal.operation === undefined
            ? signal.name
            : `${signal.operation} ${signal.name}`,
        path: file.relativePath,
        language: file.language,
        line: positionAt(file.content, signal.index).line,
        evidence: safeEvidence.text,
      });
      const owner = containingSymbol(
        file,
        positionAt(file.content, signal.index).offset,
      );
      const from = owner
        ? symbolId(file.relativePath, owner)
        : moduleId(file.relativePath);
      const kind: EdgeKind =
        signal.kind === "route"
          ? "routes"
          : signal.kind === "event"
            ? "emits"
            : "injects";
      addEdge(from, id, kind, 0.64, file, signal.index, signal.evidence);
      counts[
        signal.kind === "route"
          ? "routes"
          : signal.kind === "event"
            ? "events"
            : "dependencies"
      ]++;
    }
  }
  return { counts, secretsRedacted };
}
