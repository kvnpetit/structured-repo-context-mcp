import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isSafeGitRelativePath } from "@core/git";
import { redactSourceText, resolveSecureDirectory } from "@core/security";
import type { Feature, FeatureExecutionContext, FeatureResult } from "@features/types";
import {
  parseAstGrep,
  parseCodeql,
  parseJson,
  parseSemgrep,
  redactFindings,
  safeCodeqlPath,
} from "./parsers";
import { findExecutable, runProcess } from "./process";
import {
  ruleFileOf,
  staticAnalysisOutputSchema,
  staticAnalysisSchema,
  type StaticAnalysisInput,
} from "./schema";
import type { ProcessResult, StaticAnalysisOutput } from "./types";

export {
  staticAnalysisOutputSchema,
  staticAnalysisSchema,
  type StaticAnalysisInput,
} from "./schema";

export async function execute(
  rawInput: StaticAnalysisInput,
  context?: FeatureExecutionContext,
): Promise<FeatureResult> {
  const input = staticAnalysisSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }
  const root = secureDirectory.path;
  const requestedRuleFile = ruleFileOf(input);
  const queryKind =
    input.backend === "codeql"
      ? "codeql-query"
      : requestedRuleFile !== undefined
        ? "rules-file"
        : "pattern";
  const baseOutput = (): StaticAnalysisOutput => ({
    directory: root,
    backend: input.backend,
    enabled: process.env.SRC_STATIC_ANALYSIS_ENABLED === "true",
    available: false,
    query_kind: queryKind,
    ...(requestedRuleFile === undefined ? {} : { rule_file: requestedRuleFile }),
    findings: [],
    findings_count: 0,
    truncated: false,
    timed_out: false,
    output_truncated: false,
    source_is_untrusted: true,
    secrets_redacted: false,
    errors: [],
  });
  const output = baseOutput();
  if (!output.enabled) {
    output.errors.push(
      "Static analyzers are disabled; set SRC_STATIC_ANALYSIS_ENABLED=true to opt in",
    );
    return {
      success: true,
      message: "Static analysis is disabled",
      data: output,
    };
  }
  const requestedPaths = new Set<string>();
  for (const value of input.paths) {
    if (!isSafeGitRelativePath(value)) {
      return {
        success: false,
        error: "paths must be safe project-relative paths",
      };
    }
    requestedPaths.add(value.replace(/\\/gu, "/").replace(/^\.\//u, ""));
  }
  const paths = [...requestedPaths].sort();
  const executable = await findExecutable(
    input.backend,
    root,
    Math.min(input.timeout_ms, 5_000),
    context?.signal,
  );
  if (executable.command === undefined) {
    output.errors.push("Local static analyzer executable was not found");
    return {
      success: true,
      message: "Static analyzer is not installed",
      data: output,
    };
  }
  output.available = true;
  output.executable = executable.command;

  let args: string[];
  let temporaryDirectory: string | undefined;
  if (input.backend === "codeql") {
    const database = safeCodeqlPath(root, input.database, "directory");
    const queryFile = safeCodeqlPath(root, input.query_file, "file");
    if (database === undefined || queryFile === undefined) {
      return {
        success: false,
        error: "CodeQL database and query_file must be existing project-relative paths",
      };
    }
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "src-mcp-codeql-"));
    args = [
      "database",
      "analyze",
      database,
      queryFile,
      "--format=sarif-latest",
      `--output=${path.join(temporaryDirectory, "results.sarif")}`,
      "--threads=1",
      "--ram=1024",
    ];
  } else if (requestedRuleFile !== undefined) {
    const ruleFile = safeCodeqlPath(root, requestedRuleFile, "file");
    if (ruleFile === undefined) {
      return {
        success: false,
        error: "rule_file must be an existing project-relative regular file",
      };
    }
    const targets = paths.length > 0 ? paths : ["."];
    args =
      input.backend === "ast-grep"
        ? ["scan", "--rule", ruleFile, "--json", "--include-metadata", "--", ...targets]
        : [
            "--json",
            "--metrics=off",
            "--disable-version-check",
            "--no-git-ignore",
            "--config",
            ruleFile,
            "--",
            ...targets,
          ];
  } else {
    if (!("pattern" in input) || !("language" in input)) {
      return {
        success: false,
        error: "pattern and language are required when rule_file is absent",
      };
    }
    const targets = paths.length > 0 ? paths : ["."];
    args =
      input.backend === "ast-grep"
        ? ["run", "--pattern", input.pattern, "--lang", input.language, "--json", "--", ...targets]
        : [
            "--json",
            "--metrics=off",
            "--disable-version-check",
            "--no-git-ignore",
            "--pattern",
            input.pattern,
            "--lang",
            input.language,
            "--",
            ...targets,
          ];
  }

  let processResult: ProcessResult;
  try {
    processResult = await runProcess(
      executable.command,
      args,
      root,
      input.timeout_ms,
      context?.signal,
    );
    let payload = parseJson(processResult.stdout);
    if (input.backend === "codeql" && temporaryDirectory !== undefined) {
      const outputPath = path.join(temporaryDirectory, "results.sarif");
      if (fs.existsSync(outputPath)) {
        payload = parseJson(fs.readFileSync(outputPath, "utf8"));
      }
    }
    if (payload === undefined) {
      output.errors.push("Static analyzer did not return valid JSON/SARIF output");
    } else {
      const findings =
        input.backend === "ast-grep"
          ? parseAstGrep(root, payload, input.max_results)
          : input.backend === "semgrep"
            ? parseSemgrep(root, payload, input.max_results)
            : parseCodeql(root, payload, input.max_results);
      const redacted = redactFindings(findings, input.redact_secrets);
      output.findings = redacted.findings;
      output.findings_count = output.findings.length;
      output.secrets_redacted = redacted.redacted;
    }
    output.timed_out = processResult.timedOut;
    output.output_truncated = processResult.outputTruncated;
    output.truncated = output.output_truncated || output.findings_count >= input.max_results;
    if (processResult.stderr.length > 0) {
      const stderr = input.redact_secrets
        ? redactSourceText(processResult.stderr)
        : { text: processResult.stderr, redacted: false };
      output.stderr = stderr.text.slice(0, 4_000);
      output.secrets_redacted ||= stderr.redacted;
    }
    if (processResult.spawnError !== undefined) {
      output.errors.push(processResult.spawnError);
    } else if (processResult.timedOut) {
      output.errors.push("Static analyzer timed out");
    } else if (processResult.exitCode !== 0 && output.findings.length === 0) {
      output.errors.push(
        `Static analyzer exited with code ${String(processResult.exitCode ?? "unknown")}`,
      );
    }
  } finally {
    if (temporaryDirectory !== undefined && fs.existsSync(temporaryDirectory)) {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }

  return {
    success: true,
    message: `Static analysis (${input.backend}): ${String(output.findings_count)} finding${output.findings_count === 1 ? "" : "s"}${output.truncated ? " (truncated)" : ""}`,
    data: output,
  };
}

export const staticAnalysisFeature: Feature<typeof staticAnalysisSchema> = {
  name: "run_static_analysis",
  title: "Run local static analysis",
  description:
    "Optionally run an installed local ast-grep, Semgrep, or CodeQL analyzer with fixed non-shell arguments, strict path bounds, timeouts, output caps, and redaction. Disabled by default; no project scripts or remote rules are executed.",
  schema: staticAnalysisSchema,
  outputSchema: staticAnalysisOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute,
};
