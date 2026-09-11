interface RankedArtifact {
  file_path: string;
  title?: string;
  links: { target: string }[];
}

export function queryTerms(query: string): string[] {
  return (
    query
      .toLowerCase()
      .match(/[a-z0-9_$.-]+/gu)
      ?.filter((term, index, all) => all.indexOf(term) === index)
      .slice(0, 30) ?? []
  );
}

export function artifactScore(
  artifact: RankedArtifact,
  terms: readonly string[],
  query: string,
  mode: "hybrid" | "lexical",
): number {
  if (terms.length === 0) {
    return 0;
  }
  const pathText = artifact.file_path.toLowerCase();
  const title = artifact.title?.toLowerCase() ?? "";
  const links = artifact.links
    .map((link) => link.target)
    .join(" ")
    .toLowerCase();
  const lexicalScore = terms.reduce(
    (score, term) =>
      score +
      (pathText.includes(term) ? 4 : 0) +
      (title.includes(term) ? 5 : 0) +
      (links.includes(term) ? 2 : 0),
    0,
  );
  if (mode === "lexical" || query.trim().length === 0) {
    return lexicalScore;
  }
  const normalizedQuery = query.trim().toLowerCase();
  const searchable = `${pathText}\n${title}\n${links}`;
  return lexicalScore + (searchable.includes(normalizedQuery) ? 8 : 0);
}
