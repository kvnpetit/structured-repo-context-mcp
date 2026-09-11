import type { Language, Tree } from "web-tree-sitter";

import type { ASTNode, QueryMatch } from "@core/ast/types";

import { executeQuery, executeTagsQuery, type QueryOptions, type QueryResult } from "./engine";
import {
  deduplicateNodes,
  extractNodes,
  findCapture,
  findCaptureByPrefix,
  getCaptureKind,
} from "./helpers";
import { hasOfficialTags } from "./loader";
import { getQueryPattern, type QueryPreset } from "./patterns";

const MAX_TAG_MATCHES = 10_000;

export type TagKind =
  | "function"
  | "method"
  | "class"
  | "module"
  | "interface"
  | "constant"
  | "type"
  | "call";

export interface TagDefinition {
  name: string;
  kind: TagKind;
  node: ASTNode;
  nameNode: ASTNode;
  documentation?: string;
}

export interface TagReference {
  name: string;
  kind: TagKind;
  node: ASTNode;
  nameNode: ASTNode;
}

export function executePresetQuery(
  tree: Tree,
  languageInstance: Language,
  language: string,
  preset: QueryPreset,
  options: QueryOptions = {},
): QueryResult {
  const fallbackPattern = getQueryPattern(language, preset);
  if (preset === "functions" || preset === "classes") {
    if (hasOfficialTags(language)) {
      const { definitions } = extractSymbolsFromTags(tree, languageInstance, language);
      let filteredDefinitions =
        preset === "functions"
          ? definitions.filter(
              (definition) => definition.kind === "function" || definition.kind === "method",
            )
          : definitions.filter(
              (definition) =>
                definition.kind === "class" ||
                definition.kind === "interface" ||
                definition.kind === "module",
            );
      if (filteredDefinitions.length > 0) {
        if (options.maxMatches !== undefined && filteredDefinitions.length > options.maxMatches) {
          filteredDefinitions = filteredDefinitions.slice(0, options.maxMatches);
        }
        const matches: QueryMatch[] = filteredDefinitions.map((definition) => ({
          pattern: 0,
          captures: [
            {
              name: preset === "functions" ? "function.definition" : "class.definition",
              node: definition.node,
            },
            {
              name: `${preset.slice(0, -1)}.name`,
              node: definition.nameNode,
            },
          ],
        }));
        return {
          matches,
          count: matches.length,
          query: `[tags.scm ${preset}]`,
          language,
          source: "official",
        };
      }
      if (fallbackPattern) {
        return executeQuery(tree, languageInstance, fallbackPattern, language, {
          ...options,
          cache: true,
        });
      }
      return {
        matches: [],
        count: 0,
        query: `[tags.scm ${preset}]`,
        language,
        source: "official",
      };
    }
    if (fallbackPattern) {
      return executeQuery(tree, languageInstance, fallbackPattern, language, {
        ...options,
        cache: true,
      });
    }
  }
  if (!fallbackPattern) {
    throw new Error(`No '${preset}' query pattern available for ${language}`);
  }
  return executeQuery(tree, languageInstance, fallbackPattern, language, {
    ...options,
    cache: true,
  });
}

export function extractSymbolsFromTags(
  tree: Tree,
  languageInstance: Language,
  language: string,
): { definitions: TagDefinition[]; references: TagReference[] } {
  const result = executeTagsQuery(tree, languageInstance, language, {
    maxMatches: MAX_TAG_MATCHES,
  });
  if (!result) {
    return { definitions: [], references: [] };
  }
  const definitions: TagDefinition[] = [];
  const references: TagReference[] = [];
  for (const match of result.matches) {
    const nameCapture = findCapture(match.captures, "name");
    if (!nameCapture) {
      continue;
    }
    const definitionCapture = findCaptureByPrefix(match.captures, "definition.");
    const referenceCapture = findCaptureByPrefix(match.captures, "reference.");
    const documentationCapture = findCapture(match.captures, "doc");
    if (definitionCapture) {
      definitions.push({
        name: nameCapture.node.text,
        kind: getCaptureKind(definitionCapture.name, "definition.") as TagKind,
        node: definitionCapture.node,
        nameNode: nameCapture.node,
        documentation: documentationCapture?.node.text,
      });
    } else if (referenceCapture) {
      references.push({
        name: nameCapture.node.text,
        kind: getCaptureKind(referenceCapture.name, "reference.") as TagKind,
        node: referenceCapture.node,
        nameNode: nameCapture.node,
      });
    }
  }
  return { definitions, references };
}

export function findFunctions(
  tree: Tree,
  languageInstance: Language,
  language: string,
  options: QueryOptions = {},
): ASTNode[] {
  if (options.preferOfficial !== false && hasOfficialTags(language)) {
    return extractSymbolsFromTags(tree, languageInstance, language)
      .definitions.filter(
        (definition) => definition.kind === "function" || definition.kind === "method",
      )
      .map((definition) => definition.node);
  }
  try {
    const result = executePresetQuery(tree, languageInstance, language, "functions", options);
    return extractNodes(result.matches, [
      "function.definition",
      "method.definition",
      "function.declaration",
    ]);
  } catch {
    return [];
  }
}

export function findClasses(
  tree: Tree,
  languageInstance: Language,
  language: string,
  options: QueryOptions = {},
): ASTNode[] {
  if (options.preferOfficial !== false && hasOfficialTags(language)) {
    return extractSymbolsFromTags(tree, languageInstance, language)
      .definitions.filter(
        (definition) =>
          definition.kind === "class" ||
          definition.kind === "interface" ||
          definition.kind === "module",
      )
      .map((definition) => definition.node);
  }
  try {
    const result = executePresetQuery(tree, languageInstance, language, "classes", options);
    return extractNodes(result.matches, [
      "class.definition",
      "struct.definition",
      "impl.definition",
    ]);
  } catch {
    return [];
  }
}

function findPresetNodes(
  tree: Tree,
  languageInstance: Language,
  language: string,
  preset: QueryPreset,
  captures: string[],
  options: QueryOptions,
  deduplicate = false,
): ASTNode[] {
  try {
    const matches = executePresetQuery(tree, languageInstance, language, preset, options).matches;
    return deduplicate ? deduplicateNodes(matches, captures) : extractNodes(matches, captures);
  } catch {
    return [];
  }
}

export function findImports(
  tree: Tree,
  languageInstance: Language,
  language: string,
  options: QueryOptions = {},
): ASTNode[] {
  return findPresetNodes(
    tree,
    languageInstance,
    language,
    "imports",
    ["import.statement", "include.statement"],
    options,
    true,
  );
}

export function findExports(
  tree: Tree,
  languageInstance: Language,
  language: string,
  options: QueryOptions = {},
): ASTNode[] {
  return findPresetNodes(
    tree,
    languageInstance,
    language,
    "exports",
    ["export.statement", "export.function", "export.class", "export.type"],
    options,
    true,
  );
}

export function findComments(
  tree: Tree,
  languageInstance: Language,
  language: string,
  options: QueryOptions = {},
): ASTNode[] {
  return findPresetNodes(
    tree,
    languageInstance,
    language,
    "comments",
    ["comment", "comment.block"],
    options,
  );
}

export function findStrings(
  tree: Tree,
  languageInstance: Language,
  language: string,
  options: QueryOptions = {},
): ASTNode[] {
  return findPresetNodes(
    tree,
    languageInstance,
    language,
    "strings",
    ["string", "string.template", "string.raw"],
    options,
  );
}

function namedField(node: ASTNode): string | undefined {
  const name = node.fields?.name;
  return name !== undefined && !Array.isArray(name) ? name.text : undefined;
}

export function getFunctionName(funcNode: ASTNode): string | undefined {
  const fieldName = namedField(funcNode);
  if (fieldName !== undefined) {
    return fieldName;
  }
  for (const child of funcNode.children ?? []) {
    if (
      child.type === "identifier" ||
      child.type === "property_identifier" ||
      child.type === "field_identifier"
    ) {
      return child.text;
    }
    if (child.type === "function_declarator") {
      return getFunctionName(child);
    }
  }
  return undefined;
}

export function getClassName(classNode: ASTNode): string | undefined {
  const fieldName = namedField(classNode);
  if (fieldName !== undefined) {
    return fieldName;
  }
  return classNode.children?.find(
    (child) => child.type === "identifier" || child.type === "type_identifier",
  )?.text;
}
