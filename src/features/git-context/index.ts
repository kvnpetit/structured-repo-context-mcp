import { isSafeGitRelativePath, runLocalGit, safeGitError } from "@core/git";
import { changedSymbolsFeature } from "@features/changed-symbols";
import { redactSourceText, resolveSecureDirectory } from "@core/security";
import { truncateUtf8WithStatus } from "@core/utils/utf8";
import type { Feature, FeatureResult } from "@features/types";
import {
  parseBlame,
  parseHistory,
  parseHotspots,
  parseRevisionChanges,
  parseStatus,
  readCodeowners,
  redactText,
  requestedFiles,
  resolveLocalRevision,
} from "./helpers";
import {
  gitContextOutputSchema,
  gitContextSchema,
  MAX_FILES,
  type GitContextInput,
} from "./schema";
import type {
  BlameEntry,
  ChangeSymbolLocation,
  GitContextOutput,
  HistoryEntry,
  HotspotAnalysis,
  RevisionComparison,
} from "./types";

export {
  gitContextOutputSchema,
  gitContextSchema,
  type GitContextInput,
} from "./schema";

export async function execute(rawInput: GitContextInput): Promise<FeatureResult> {
  const input = gitContextSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  const filesResult = requestedFiles(input.files);
  if (typeof filesResult === "string") {
    return { success: false, error: filesResult };
  }
  const pathArgs = filesResult.length > 0 ? ["--", ...filesResult] : ["--"];
  let repositoryRoot: string;
  try {
    repositoryRoot = (await runLocalGit(root, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if (repositoryRoot.length === 0) {
      return { success: false, error: "Directory is not a Git repository" };
    }
  } catch (error) {
    return {
      success: false,
      error: `Git context unavailable: ${safeGitError(error, "directory is not a readable Git repository")}`,
    };
  }

  const errors: string[] = [];
  const statusPromise = input.include_status
    ? runLocalGit(root, ["status", "--porcelain=v1", "--untracked-files=all", "-z", ...pathArgs])
        .then((result) => parseStatus(result.stdout))
        .catch((error: unknown) => {
          errors.push(`Cannot read Git status: ${safeGitError(error, "status unavailable")}`);
          return { entries: [], truncated: false };
        })
    : { entries: [], truncated: false };
  const headPromise = runLocalGit(root, ["rev-parse", "--verify", "HEAD"]).catch(() => undefined);
  const branchPromise = runLocalGit(root, ["branch", "--show-current"]).catch(() => undefined);
  const changedSymbolsPromise = input.include_changed_symbols
    ? changedSymbolsFeature.execute({
        directory: root,
        max_files: Math.min(MAX_FILES, Math.max(1, input.files.length || MAX_FILES)),
        max_symbols: 1_000,
      })
    : undefined;
  const [statusResult, headResult, branchResult] = await Promise.all([
    statusPromise,
    headPromise,
    branchPromise,
  ]);
  const status = statusResult.entries;
  const headValue = headResult?.stdout.trim();
  const head = headValue === undefined || headValue.length === 0 ? undefined : headValue;
  const branchValue = branchResult?.stdout.trim();
  const branch = branchValue === undefined || branchValue.length === 0 ? undefined : branchValue;

  let secretRedacted = false;
  let diff = { text: "", bytes: 0, truncated: false };
  if (input.include_diff) {
    const diffArgs = [
      "--no-pager",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--unified=3",
      ...(head === undefined ? [] : [head]),
      ...pathArgs,
    ];
    try {
      const result = await runLocalGit(root, diffArgs);
      const redacted = redactText(result.stdout, input.redact_secrets);
      secretRedacted ||= redacted.redacted;
      const bounded = truncateUtf8WithStatus(redacted.text, input.max_diff_bytes);
      diff = {
        text: bounded.text,
        bytes: Buffer.byteLength(bounded.text, "utf8"),
        truncated: bounded.truncated,
      };
    } catch (error) {
      errors.push(`Cannot read Git diff: ${safeGitError(error, "diff unavailable")}`);
    }
  }

  let history: HistoryEntry[] = [];
  if (input.include_history && head !== undefined) {
    try {
      const result = await runLocalGit(root, [
        "log",
        "--no-decorate",
        "--no-color",
        `--format=%H%x00%an%x00%aI%x00%s%x00`,
        "-n",
        String(input.max_history),
        ...pathArgs,
      ]);
      history = parseHistory(result.stdout).map((entry) => {
        const subject = redactText(entry.subject, input.redact_secrets);
        secretRedacted ||= subject.redacted;
        return { ...entry, subject: subject.text };
      });
    } catch (error) {
      errors.push(`Cannot read Git history: ${safeGitError(error, "history unavailable")}`);
    }
  }

  const hotspotsPromise = (async (): Promise<HotspotAnalysis | undefined> => {
    if (!input.include_hotspots || head === undefined) {
      return undefined;
    }
    try {
      const result = await runLocalGit(root, [
        "log",
        "--no-decorate",
        "--no-color",
        "--no-merges",
        "--no-renames",
        "--numstat",
        `--format=%H%x00%aI%x00`,
        "-n",
        String(input.max_history + 1),
        ...pathArgs,
      ]);
      return parseHotspots(result.stdout, input.max_history, input.max_hotspots);
    } catch (error) {
      errors.push(
        `Cannot read Git hotspots: ${safeGitError(error, "historical hotspots unavailable")}`,
      );
      return undefined;
    }
  })();

  const revisionComparePromise = (async (): Promise<RevisionComparison | undefined> => {
    if (input.compare_from === undefined || input.compare_to === undefined) {
      return undefined;
    }
    try {
      const [fromCommit, toCommit] = await Promise.all([
        resolveLocalRevision(root, input.compare_from),
        resolveLocalRevision(root, input.compare_to),
      ]);
      const result = await runLocalGit(root, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--name-status",
        "-z",
        fromCommit,
        toCommit,
        ...pathArgs,
      ]);
      const parsed = parseRevisionChanges(result.stdout, input.max_compare_files);
      return {
        from: input.compare_from,
        to: input.compare_to,
        from_commit: fromCommit,
        to_commit: toCommit,
        files_changed: parsed.filesChanged,
        files: parsed.files,
        truncated: parsed.truncated,
      };
    } catch (error) {
      errors.push(
        `Cannot compare Git revisions: ${safeGitError(error, "local revision comparison unavailable")}`,
      );
      return undefined;
    }
  })();
  const [hotspots, revisionCompare] = await Promise.all([hotspotsPromise, revisionComparePromise]);

  const blame: Record<string, BlameEntry[]> = {};
  if (input.include_blame) {
    const blameFiles = filesResult.length > 0 ? filesResult : status.map((entry) => entry.path);
    for (const file of [...new Set(blameFiles)].slice(0, MAX_FILES)) {
      if (!isSafeGitRelativePath(file)) {
        continue;
      }
      try {
        const result = await runLocalGit(root, ["blame", "--line-porcelain", "--", file]);
        const entries = parseBlame(result.stdout, input.max_blame_lines).map((entry) => {
          const summary =
            entry.summary === undefined
              ? entry.summary
              : redactText(entry.summary, input.redact_secrets);
          if (summary !== undefined && typeof summary !== "string") {
            secretRedacted ||= summary.redacted;
          }
          return {
            ...entry,
            ...(summary === undefined
              ? {}
              : {
                  summary: typeof summary === "string" ? summary : summary.text,
                }),
          };
        });
        blame[file] = entries;
      } catch (error) {
        errors.push(`Cannot read blame for ${file}: ${safeGitError(error, "blame unavailable")}`);
      }
    }
  }

  const codeowners = input.include_codeowners ? readCodeowners(root) : { lines: [] };
  if (input.redact_secrets && codeowners.lines.length > 0) {
    codeowners.lines = codeowners.lines.map((line) => {
      const redacted = redactSourceText(line);
      secretRedacted ||= redacted.redacted;
      return redacted.text;
    });
  }

  let changeAnalysis: GitContextOutput["change_analysis"] = {
    files_changed: status.length,
    files_analyzed: 0,
    symbols_detected: 0,
    files_truncated: false,
    symbols_truncated: false,
    symbol_locations: [],
    errors: [],
  };
  if (changedSymbolsPromise !== undefined) {
    const symbolsResult = await changedSymbolsPromise;
    if (symbolsResult.success && symbolsResult.data !== undefined) {
      const symbols = symbolsResult.data as {
        files_changed?: number;
        files_analyzed?: number;
        files_truncated?: boolean;
        symbols_truncated?: boolean;
        symbols?: ChangeSymbolLocation[];
        errors?: string[];
      };
      changeAnalysis = {
        files_changed: symbols.files_changed ?? status.length,
        files_analyzed: symbols.files_analyzed ?? 0,
        symbols_detected: symbols.symbols?.length ?? 0,
        files_truncated: symbols.files_truncated ?? false,
        symbols_truncated: symbols.symbols_truncated ?? false,
        symbol_locations: symbols.symbols ?? [],
        errors: symbols.errors ?? [],
      };
    } else if (symbolsResult.error !== undefined) {
      changeAnalysis.errors.push(symbolsResult.error);
    }
  }

  const output: GitContextOutput = {
    directory: root,
    repository_root: repositoryRoot,
    git_available: true,
    ...(head === undefined ? {} : { head }),
    ...(branch === undefined ? {} : { branch }),
    ...(input.include_status ? { clean: status.length === 0 } : {}),
    files: status,
    diff,
    history,
    ...(hotspots === undefined ? {} : { hotspots }),
    ...(revisionCompare === undefined ? {} : { revision_compare: revisionCompare }),
    blame,
    codeowners,
    change_analysis: changeAnalysis,
    truncated:
      diff.truncated ||
      statusResult.truncated ||
      history.length >= input.max_history ||
      (hotspots?.truncated ?? false) ||
      (revisionCompare?.truncated ?? false) ||
      changeAnalysis.files_truncated ||
      changeAnalysis.symbols_truncated,
    source_is_untrusted: true,
    secrets_redacted: secretRedacted,
    errors,
  };
  return {
    success: true,
    message: `Git context: ${String(output.files.length)} changed file${output.files.length === 1 ? "" : "s"}, ${String(output.change_analysis.symbols_detected)} touched symbol${output.change_analysis.symbols_detected === 1 ? "" : "s"}${output.truncated ? " (truncated)" : ""}`,
    data: output,
  };
}

export const gitContextFeature: Feature<typeof gitContextSchema> = {
  name: "get_git_context",
  title: "Get local Git context",
  description:
    "Inspect bounded local Git status, diff, history, optional churn hotspots, local revision comparisons, blame, CODEOWNERS, and changed-symbol analysis. It uses only fixed non-remote Git commands, rejects arbitrary command arguments, and never executes project scripts.",
  schema: gitContextSchema,
  outputSchema: gitContextOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute,
};
