import type { SignalMatch } from "./types";

function boundedEvidence(content: string, index: number): string {
  const start = Math.max(0, index - 90);
  const end = Math.min(content.length, index + 180);
  return content.slice(start, end).trim();
}

export function findSignals(content: string): SignalMatch[] {
  const signals: SignalMatch[] = [];
  const patterns: {
    kind: SignalMatch["kind"];
    pattern: RegExp;
    nameGroup: number;
  }[] = [
    {
      kind: "route",
      pattern:
        /\b(?:app|router|server|api)\.(get|post|put|patch|delete|options|head|use|route)\s*\(\s*["'`]([^"'`]+)["'`]/giu,
      nameGroup: 2,
    },
    {
      kind: "route",
      pattern: /@(?:Get|Post|Put|Patch|Delete|Options|Head|All)\s*\(\s*["'`]([^"'`]+)["'`]/gu,
      nameGroup: 1,
    },
    {
      kind: "event",
      pattern:
        /\.(on|once|emit|dispatch|addEventListener|removeEventListener)\s*\(\s*["'`]([^"'`]+)["'`]/gu,
      nameGroup: 2,
    },
    {
      kind: "dependency",
      pattern:
        /(?:\b(?:container\.(?:register|bind|resolve)|inject|provide)|@Inject)\s*\(\s*["'`]?([A-Za-z_$][\w$./:@-]*)/gu,
      nameGroup: 1,
    },
  ];
  for (const entry of patterns) {
    for (const match of content.matchAll(entry.pattern)) {
      const name = match[entry.nameGroup];
      if (!name) {
        continue;
      }
      signals.push({
        kind: entry.kind,
        name,
        operation: match[1],
        index: match.index,
        evidence: boundedEvidence(content, match.index),
      });
    }
  }
  return signals.sort(
    (left, right) =>
      left.index - right.index ||
      left.kind.localeCompare(right.kind) ||
      left.name.localeCompare(right.name),
  );
}
