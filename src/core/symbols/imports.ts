import type { Language, Tree } from "web-tree-sitter";

import type { Export, Import, ImportedName, Symbol, SymbolType } from "@core/ast/types";
import {
  createOffsetTracker,
  executePresetQuery,
  findCapture,
  findCaptureByNames,
} from "@core/queries";

export function extractImports(tree: Tree, languageInstance: Language, language: string): Import[] {
  const imports: Import[] = [];
  try {
    const result = executePresetQuery(tree, languageInstance, language, "imports");
    const tracker = createOffsetTracker();
    for (const match of result.matches) {
      const statementCapture = findCaptureByNames(match.captures, [
        "import.statement",
        "include.statement",
      ]);
      if (!statementCapture || tracker.has(statementCapture.node)) {
        continue;
      }
      tracker.add(statementCapture.node);
      const sourceCapture = findCaptureByNames(match.captures, [
        "import.source",
        "import.path",
        "include.path",
      ]);
      const defaultCapture = findCapture(match.captures, "import.default");
      const nameCaptures = match.captures.filter((capture) => capture.name === "import.name");
      const source = sourceCapture ? sourceCapture.node.text.replace(/['"]/g, "") : "";
      const names: ImportedName[] = [];
      if (defaultCapture) {
        names.push({ name: defaultCapture.node.text });
      }
      for (const nameCapture of nameCaptures) {
        names.push({ name: nameCapture.node.text });
      }
      imports.push({
        source,
        names,
        isDefault: Boolean(defaultCapture) && nameCaptures.length === 0,
        start: statementCapture.node.start,
        end: statementCapture.node.end,
      });
    }
  } catch {
    // Query not available for this language.
  }
  return imports;
}

export function extractExports(tree: Tree, languageInstance: Language, language: string): Export[] {
  const exports: Export[] = [];
  try {
    const result = executePresetQuery(tree, languageInstance, language, "exports");
    const tracker = createOffsetTracker();
    for (const match of result.matches) {
      const statementCapture = findCaptureByNames(match.captures, [
        "export.statement",
        "export.function",
        "export.class",
        "export.type",
      ]);
      if (!statementCapture || tracker.has(statementCapture.node)) {
        continue;
      }
      tracker.add(statementCapture.node);
      const nameCapture = findCapture(match.captures, "export.name");
      const text = statementCapture.node.text;
      const isDefault = text.includes("export default");
      let name = nameCapture?.node.text;
      if (!name) {
        const nameMatch =
          /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/.exec(
            text,
          );
        name = nameMatch?.[1];
      }
      exports.push({
        name: name ?? "default",
        isDefault,
        start: statementCapture.node.start,
        end: statementCapture.node.end,
      });
    }
  } catch {
    // Query not available for this language.
  }
  return exports;
}

export function getSymbolsByType(symbols: Symbol[], type: SymbolType): Symbol[] {
  return symbols.filter((symbol) => symbol.type === type);
}

export function findSymbolByName(symbols: Symbol[], name: string): Symbol | undefined {
  return symbols.find((symbol) => symbol.name === name);
}

export function getSymbolAtPosition(
  symbols: Symbol[],
  line: number,
  column: number,
): Symbol | undefined {
  return symbols.find((symbol) => {
    const afterStart =
      line > symbol.start.line || (line === symbol.start.line && column >= symbol.start.column);
    const beforeEnd =
      line < symbol.end.line || (line === symbol.end.line && column <= symbol.end.column);
    return afterStart && beforeEnd;
  });
}
