/**
 * Symbol extraction from parsed code
 */
import type { Language, Tree } from "web-tree-sitter";

import type {
  Export,
  Import,
  QueryMatch,
  Symbol,
  SymbolType,
} from "@core/ast/types";
import {
  executeQuery,
  executePresetQuery,
  extractSymbolsFromTags,
  findCapture,
  findCaptureByNames,
  getClassName,
  getFunctionName,
  getQueryPattern,
  hasOfficialTags,
} from "@core/queries";
import { extractExports, extractImports } from "./imports";

export * from "./hierarchy";
export * from "./imports";

/**
 * Symbol filter options
 */
export interface SymbolFilter {
  /** Include only specific types */
  types?: SymbolType[];
  /** Exclude specific types */
  excludeTypes?: SymbolType[];
  /** Include only exported symbols */
  exportedOnly?: boolean;
}

/**
 * Symbol extraction result
 */
export interface SymbolsResult {
  /** Extracted symbols */
  symbols: Symbol[];
  /** Summary counts */
  summary: {
    functions: number;
    classes: number;
    variables: number;
    constants: number;
    interfaces: number;
    types: number;
    enums: number;
    methods: number;
    properties: number;
    total: number;
  };
}

/**
 * Extract symbols from parsed code
 */
export function extractSymbols(
  tree: Tree,
  languageInstance: Language,
  language: string,
  filter: SymbolFilter = {},
): SymbolsResult {
  const symbols: Symbol[] = [];
  const { types, excludeTypes } = filter;

  const shouldInclude = (type: SymbolType): boolean => {
    if (types && !types.includes(type)) {
      return false;
    }
    if (excludeTypes?.includes(type)) {
      return false;
    }
    return true;
  };

  const officialDefinitions =
    (shouldInclude("function") ||
      shouldInclude("method") ||
      shouldInclude("class") ||
      shouldInclude("interface")) &&
    hasOfficialTags(language)
      ? extractSymbolsFromTags(tree, languageInstance, language).definitions
      : undefined;

  const matchesFor = (
    preset: "functions" | "classes",
    kinds: readonly string[],
  ): QueryMatch[] => {
    if (officialDefinitions === undefined) {
      return executePresetQuery(tree, languageInstance, language, preset)
        .matches;
    }
    const matching = officialDefinitions.filter((definition) =>
      kinds.includes(definition.kind),
    );
    if (matching.length > 0) {
      const singular = preset === "functions" ? "function" : "class";
      return matching.map((definition) => ({
        pattern: 0,
        captures: [
          { name: `${singular}.definition`, node: definition.node },
          { name: `${singular}.name`, node: definition.nameNode },
        ],
      }));
    }
    const fallback = getQueryPattern(language, preset);
    return fallback === undefined
      ? []
      : executeQuery(tree, languageInstance, fallback, language).matches;
  };

  // Extract functions and classes using official tags.scm when available
  if (
    shouldInclude("function") ||
    shouldInclude("method") ||
    shouldInclude("class") ||
    shouldInclude("interface")
  ) {
    const matches = matchesFor("functions", ["function", "method"]);

    // Process function definitions
    if (shouldInclude("function") || shouldInclude("method")) {
      for (const match of matches) {
        const defCapture = findCapture(match.captures, "function.definition");
        const nameCapture = findCapture(match.captures, "function.name");

        if (defCapture) {
          const name =
            nameCapture?.node.text ?? getFunctionName(defCapture.node);
          if (name) {
            const isMethod =
              defCapture.node.type.includes("method") ||
              defCapture.node.type === "method_definition";
            const type: SymbolType = isMethod ? "method" : "function";
            if (shouldInclude(type)) {
              symbols.push({
                name,
                type,
                start: defCapture.node.start,
                end: defCapture.node.end,
                signature: extractFunctionSignature(defCapture.node),
                modifiers: extractModifiers(defCapture.node),
              });
            }
          }
        }
      }
    }
  }

  // Extract classes
  if (shouldInclude("class") || shouldInclude("interface")) {
    const matches = matchesFor("classes", ["class", "interface", "module"]);

    for (const match of matches) {
      const defCapture = findCapture(match.captures, "class.definition");
      const nameCapture = findCapture(match.captures, "class.name");

      if (defCapture) {
        const name = nameCapture?.node.text ?? getClassName(defCapture.node);
        if (name) {
          // Determine type based on AST node type
          const nodeType = defCapture.node.type;
          let symbolType: SymbolType = "class";
          if (
            nodeType.includes("interface") ||
            nodeType === "interface_declaration"
          ) {
            symbolType = "interface";
          } else if (nodeType.includes("struct")) {
            symbolType = "interface";
          }

          if (shouldInclude(symbolType)) {
            symbols.push({
              name,
              type: symbolType,
              start: defCapture.node.start,
              end: defCapture.node.end,
              modifiers: extractModifiers(defCapture.node),
            });
          }
        }
      }
    }
  }

  // Extract variables and constants
  if (shouldInclude("variable") || shouldInclude("constant")) {
    try {
      const varResult = executePresetQuery(
        tree,
        languageInstance,
        language,
        "variables",
      );

      for (const match of varResult.matches) {
        const nameCapture = findCaptureByNames(match.captures, [
          "variable.name",
          "constant.name",
          "field.name",
        ]);
        const declCapture = findCaptureByNames(match.captures, [
          "variable.declaration",
          "constant.declaration",
          "field.declaration",
        ]);

        if (nameCapture && declCapture) {
          const isConstant =
            declCapture.node.text.startsWith("const ") ||
            findCapture(match.captures, "constant.name") !== undefined;

          const type: SymbolType = isConstant ? "constant" : "variable";
          if (shouldInclude(type)) {
            symbols.push({
              name: nameCapture.node.text,
              type,
              start: declCapture.node.start,
              end: declCapture.node.end,
              modifiers: extractModifiers(declCapture.node),
            });
          }
        }
      }
    } catch {
      // Query not available for this language
    }
  }

  // Extract types (interfaces, type aliases, enums)
  if (
    shouldInclude("interface") ||
    shouldInclude("type") ||
    shouldInclude("enum")
  ) {
    try {
      const typeResult = executePresetQuery(
        tree,
        languageInstance,
        language,
        "types",
      );

      for (const match of typeResult.matches) {
        const nameCapture = findCaptureByNames(match.captures, [
          "type.name",
          "interface.name",
          "enum.name",
          "type.alias",
        ]);
        const defCapture = findCaptureByNames(match.captures, [
          "type.definition",
          "interface.definition",
          "enum.definition",
        ]);

        if (nameCapture && defCapture) {
          let type: SymbolType = "type";
          if (nameCapture.name === "interface.name") {
            type = "interface";
          } else if (nameCapture.name === "enum.name") {
            type = "enum";
          }

          if (shouldInclude(type)) {
            symbols.push({
              name: nameCapture.node.text,
              type,
              start: defCapture.node.start,
              end: defCapture.node.end,
              modifiers: extractModifiers(defCapture.node),
            });
          }
        }
      }
    } catch {
      // Query not available for this language
    }
  }

  // Calculate summary
  const summary = {
    functions: symbols.filter((s) => s.type === "function").length,
    classes: symbols.filter((s) => s.type === "class").length,
    variables: symbols.filter((s) => s.type === "variable").length,
    constants: symbols.filter((s) => s.type === "constant").length,
    interfaces: symbols.filter((s) => s.type === "interface").length,
    types: symbols.filter((s) => s.type === "type").length,
    enums: symbols.filter((s) => s.type === "enum").length,
    methods: symbols.filter((s) => s.type === "method").length,
    properties: symbols.filter((s) => s.type === "property").length,
    total: symbols.length,
  };

  return { symbols, summary };
}

/**
 * Extract function signature from AST node
 */
function extractFunctionSignature(node: {
  text: string;
  children?: { type: string; text: string }[];
}): string | undefined {
  // Try to extract just the signature (function name + params)
  const text = node.text;

  // For JavaScript/TypeScript-like syntax
  const jsMatch =
    /^(async\s+)?function\s*\*?\s*(\w*)\s*(<[^>]*>)?\s*\([^)]*\)(\s*:\s*[^{]+)?/.exec(
      text,
    );
  if (jsMatch) {
    return jsMatch[0].trim();
  }

  // For arrow functions
  const arrowMatch = /^\([^)]*\)\s*(:\s*[^=]+)?\s*=>/.exec(text);
  if (arrowMatch) {
    return arrowMatch[0].trim();
  }

  // For Python
  const pyMatch = /^def\s+(\w+)\s*\([^)]*\)(\s*->\s*[^:]+)?:/.exec(text);
  if (pyMatch) {
    return pyMatch[0].replace(/:$/, "").trim();
  }

  // For Go
  const goMatch = /^func\s*(\([^)]*\)\s*)?(\w+)\s*\([^)]*\)/.exec(text);
  if (goMatch) {
    return goMatch[0].trim();
  }

  // Fallback: return first line up to opening brace
  const firstLine = text.split(/[{:]/)[0];
  return firstLine ? firstLine.trim() : undefined;
}

/**
 * Extract modifiers from AST node
 */
function extractModifiers(node: { text: string }): string[] | undefined {
  const modifiers: string[] = [];
  const text = node.text;

  // Common modifiers
  const modifierPatterns = [
    "export",
    "default",
    "async",
    "static",
    "public",
    "private",
    "protected",
    "readonly",
    "abstract",
    "const",
    "let",
    "var",
    "final",
    "override",
    "pub",
    "mut",
  ];

  for (const mod of modifierPatterns) {
    const pattern = new RegExp(`\\b${mod}\\b`);
    if (pattern.test(text.slice(0, 100))) {
      // Only check start of node
      modifiers.push(mod);
    }
  }

  return modifiers.length > 0 ? modifiers : undefined;
}

/**
 * Extract all code information
 */
export interface CodeInfo {
  symbols: SymbolsResult;
  imports: Import[];
  exports: Export[];
}

export function extractCodeInfo(
  tree: Tree,
  languageInstance: Language,
  language: string,
  filter: SymbolFilter = {},
): CodeInfo {
  return {
    symbols: extractSymbols(tree, languageInstance, language, filter),
    imports: extractImports(tree, languageInstance, language),
    exports: extractExports(tree, languageInstance, language),
  };
}
