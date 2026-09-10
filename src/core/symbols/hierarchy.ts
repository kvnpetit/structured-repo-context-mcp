export interface TypeHierarchyRelation {
  name: string;
  kind: "class" | "interface" | "struct" | "trait" | "impl";
  parents: string[];
  line: number;
}

function splitTypeList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const character of value) {
    if (character === "<" || character === "(" || character === "[") {
      depth++;
    } else if (character === ">" || character === ")" || character === "]") {
      depth = Math.max(0, depth - 1);
    }
    if (character === "," && depth === 0) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function cleanParentType(value: string): string | undefined {
  const withoutModifiers = value
    .replace(
      /\b(public|private|protected|internal|virtual|abstract|final|sealed|readonly|class|struct)\b/gu,
      "",
    )
    .trim();
  const match = /[A-Za-z_$][\w$]*(?:\s*<[^<>]*>)?(?:\s*\.\s*[A-Za-z_$][\w$]*)?/u.exec(
    withoutModifiers,
  );
  return match?.[0]?.replace(/\s+/gu, "").replace(/<.*>/u, "");
}

function declarationParents(header: string): string[] {
  const parents: string[] = [];
  const extendsMatch = /\bextends\s+(.+?)(?=\bimplements\b|$)/u.exec(header);
  const implementsMatch = /\bimplements\s+(.+)$/u.exec(header);
  const colonMatch = /:\s*(.+)$/u.exec(header);
  for (const section of [extendsMatch?.[1], implementsMatch?.[1], colonMatch?.[1]]) {
    if (!section) {
      continue;
    }
    for (const candidate of splitTypeList(section.replace(/\bwith\b/gu, ","))) {
      const parent = cleanParentType(candidate);
      if (parent && !parents.includes(parent)) {
        parents.push(parent);
      }
    }
  }
  return parents;
}

export function extractTypeHierarchy(content: string, language: string): TypeHierarchyRelation[] {
  const relations: TypeHierarchyRelation[] = [];
  const add = (
    name: string,
    kind: TypeHierarchyRelation["kind"],
    parents: string[],
    index: number,
  ): void => {
    const line = content.slice(0, index).split("\n").length;
    relations.push({ name, kind, parents, line });
  };

  const declarationPattern =
    /\b(class|interface|struct|trait)\s+([A-Za-z_$][\w$]*)([^{}\n]*)(?=\{|:)/gu;
  for (const match of content.matchAll(declarationPattern)) {
    const kind = match[1] as TypeHierarchyRelation["kind"];
    const name = match[2] ?? "";
    if (name.length > 0) {
      add(name, kind, declarationParents(match[3] ?? ""), match.index);
    }
  }

  if (language.toLowerCase() === "python") {
    const pythonPattern = /\bclass\s+([A-Za-z_$][\w$]*)\s*(?:\(([^)]*)\))?\s*:/gu;
    for (const match of content.matchAll(pythonPattern)) {
      const name = match[1] ?? "";
      const parents = splitTypeList(match[2] ?? "")
        .map(cleanParentType)
        .filter((parent): parent is string => parent !== undefined);
      if (name.length > 0) {
        add(name, "class", parents, match.index);
      }
    }
  }

  if (language.toLowerCase() === "rust") {
    const implPattern =
      /\bimpl\s+(?:<[^>]+>\s*)?([A-Za-z_$][\w$]*(?:\s*<[^>]*>)?)\s+for\s+([A-Za-z_$][\w$]*)/gu;
    for (const match of content.matchAll(implPattern)) {
      const parent = match[1] ? cleanParentType(match[1]) : undefined;
      const name = match[2] ?? "";
      if (parent && name.length > 0) {
        add(name, "impl", [parent], match.index);
      }
    }
  }

  const deduplicated = new Map<string, TypeHierarchyRelation>();
  for (const relation of relations) {
    const key = `${relation.kind}:${relation.name}:${String(relation.line)}`;
    const existing = deduplicated.get(key);
    if (!existing || relation.parents.length > existing.parents.length) {
      deduplicated.set(key, relation);
    }
  }
  return [...deduplicated.values()];
}
