import { runLocalGit } from "@core/git";
import type { MemoryRecord, RevisionState } from "./schema";

export async function canonicalGitRevision(
  root: string,
  revision: string,
): Promise<string | undefined> {
  try {
    const result = await runLocalGit(root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${revision}^{commit}`,
    ]);
    const canonical = result.stdout.trim();
    return /^[a-f0-9]{40,64}$/iu.test(canonical) ? canonical.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export async function currentGitRevision(root: string): Promise<string | undefined> {
  return canonicalGitRevision(root, "HEAD");
}

export function revisionState(
  record: MemoryRecord,
  currentRevision: string | undefined,
): RevisionState {
  if (record.source_revision === undefined || currentRevision === undefined) {
    return "unknown";
  }
  return record.source_revision.toLowerCase() === currentRevision ? "current" : "stale";
}
