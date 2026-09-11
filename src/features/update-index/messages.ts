export interface UpdateSummary {
  added: string[];
  modified: string[];
  removed: string[];
  unchanged: number;
  errors: string[];
}

function appendFiles(
  lines: string[],
  heading: string,
  marker: string,
  files: readonly string[],
): void {
  if (files.length === 0) {
    return;
  }
  lines.push(`\n${heading} (${String(files.length)}):`);
  for (const file of files.slice(0, 10)) {
    lines.push(`  ${marker} ${file}`);
  }
  if (files.length > 10) {
    lines.push(`  ... and ${String(files.length - 10)} more`);
  }
}

export function buildDryRunMessage(result: UpdateSummary): string {
  if (result.added.length === 0 && result.modified.length === 0 && result.removed.length === 0) {
    return "Index is up to date - no changes detected.";
  }
  const lines: string[] = ["Dry run - changes detected:"];
  appendFiles(lines, "Files to add", "+", result.added);
  appendFiles(lines, "Files to update", "~", result.modified);
  appendFiles(lines, "Files to remove", "-", result.removed);
  lines.push(`\nUnchanged: ${String(result.unchanged)} files`);
  lines.push("\nRun without --dryRun to apply changes.");
  return lines.join("\n");
}

export function buildResultMessage(result: UpdateSummary): string {
  const changes = result.added.length + result.modified.length + result.removed.length;
  if (changes === 0) {
    return "Index is up to date - no changes needed.";
  }
  const lines: string[] = ["Index updated successfully:"];
  for (const [label, files] of [
    ["Added", result.added],
    ["Modified", result.modified],
    ["Removed", result.removed],
  ] as const) {
    if (files.length > 0) {
      lines.push(`  ${label}: ${String(files.length)} files`);
    }
  }
  lines.push(`  Unchanged: ${String(result.unchanged)} files`);
  if (result.errors.length > 0) {
    lines.push(`\nErrors (${String(result.errors.length)}):`);
    for (const error of result.errors.slice(0, 5)) {
      lines.push(`  - ${error}`);
    }
  }
  return lines.join("\n");
}
