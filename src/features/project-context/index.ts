import * as fs from "node:fs";
import * as path from "node:path";

import { collectFiles, createIgnoreFilter } from "@core/files";
import { getConfiguredLanguageFromPath } from "@core/parser/languages";
import {
  redactSourceText,
  readSecureTextFile,
  resolveSecureDirectory,
} from "@core/security";
import { readPathAliasesCached } from "@core/utils";
import type { Feature, FeatureResult } from "@features/types";
import {
  CONFIG_FILE_PATTERN,
  DOCUMENTATION_EXTENSIONS,
  ENTRYPOINT_BASENAMES,
  MANIFEST_KINDS,
  MAX_RETURNED_PATHS,
  TEST_PATH_PATTERN,
  addExistingPath,
  addFrameworkSignal,
  collectWorkspacePatterns,
  detectPackageManager,
  detectTextFrameworks,
  discoverMetadataFiles,
  extractTomlName,
  getProjectName,
  hashProfileInputs,
  isManifestFile,
  packageDependencies,
  parseJsonObject,
  relativePath,
  stringValue,
} from "./discovery";
import {
  projectContextOutputSchema,
  projectContextSchema,
  type ProjectContextInput,
} from "./schema";
import type {
  DiscoveredFile,
  FrameworkInfo,
  ManifestInfo,
  ProjectContextOutput,
} from "./types";

export {
  projectContextOutputSchema,
  projectContextSchema,
  type ProjectContextInput,
} from "./schema";

export function execute(rawInput: ProjectContextInput): FeatureResult {
  const input = projectContextSchema.parse(rawInput);
  const secureDirectory = resolveSecureDirectory(input.directory);
  if (!secureDirectory.ok) {
    return { success: false, error: secureDirectory.error };
  }

  const root = secureDirectory.path;
  const ignore = createIgnoreFilter(root);
  const allSourceFiles = collectFiles(root, ignore, root).sort((left, right) =>
    left.localeCompare(right),
  );
  const sourceFiles = allSourceFiles
    .slice(0, input.max_files)
    .map((absolutePath) => {
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(absolutePath).size;
      } catch {
        // The read phase below will report a missing file if necessary.
      }
      return {
        absolutePath,
        relativePath: relativePath(root, absolutePath),
        sizeBytes,
      } satisfies DiscoveredFile;
    });
  const metadata = discoverMetadataFiles(root, input.max_manifests);
  const knownMetadataPaths = new Set(
    metadata.files.map((file) => file.relativePath),
  );
  const errors: string[] = [];
  const manifestContents = new Map<string, string>();
  const manifests: ManifestInfo[] = [];
  const scripts: ProjectContextOutput["scripts"] = [];
  const workspaces = new Set<string>();
  const frameworks = new Map<string, FrameworkInfo>();
  let secretsRedacted = false;

  for (const file of metadata.files) {
    if (!isManifestFile(file.absolutePath)) {
      continue;
    }
    const readResult = readSecureTextFile(file.absolutePath, root);
    if (!readResult.ok || readResult.content === undefined) {
      errors.push(`Cannot read ${file.relativePath}`);
      continue;
    }
    manifestContents.set(file.relativePath, readResult.content);
    const basename = path.basename(file.relativePath).toLowerCase();
    const manifest: ManifestInfo = {
      path: file.relativePath,
      kind: MANIFEST_KINDS.get(basename) ?? "project-manifest",
      size_bytes: file.sizeBytes,
    };
    if (basename === "package.json") {
      const parsed = parseJsonObject(readResult.content);
      if (parsed === undefined) {
        errors.push(`Cannot parse ${file.relativePath}`);
      } else {
        manifest.project_name = stringValue(parsed.name);
        manifest.package_manager = detectPackageManager(
          parsed,
          file.relativePath,
          knownMetadataPaths,
        );
        const packageWorkspaces = collectWorkspacePatterns(parsed);
        manifest.workspaces = packageWorkspaces;
        packageWorkspaces.forEach((workspace) => workspaces.add(workspace));
        if (
          input.include_scripts &&
          typeof parsed.scripts === "object" &&
          parsed.scripts !== null
        ) {
          for (const [name, value] of Object.entries(parsed.scripts)) {
            const command = stringValue(value);
            if (command === undefined || scripts.length >= MAX_RETURNED_PATHS) {
              continue;
            }
            const safeCommand = input.redact_secrets
              ? redactSourceText(command)
              : { text: command, redacted: false };
            secretsRedacted ||= safeCommand.redacted;
            scripts.push({
              name,
              command: safeCommand.text,
              source: file.relativePath,
            });
          }
        }
        for (const dependency of packageDependencies(parsed)) {
          addFrameworkSignal(frameworks, dependency, file.relativePath);
        }
      }
    } else if (basename === "pyproject.toml") {
      manifest.project_name = extractTomlName(readResult.content, "project");
      detectTextFrameworks(frameworks, readResult.content, file.relativePath);
    } else if (basename === "cargo.toml") {
      manifest.project_name = extractTomlName(readResult.content, "package");
      detectTextFrameworks(frameworks, readResult.content, file.relativePath);
    } else if (basename === "go.mod") {
      manifest.project_name = /^\s*module\s+(\S+)/mu.exec(
        readResult.content,
      )?.[1];
      detectTextFrameworks(frameworks, readResult.content, file.relativePath);
    } else {
      detectTextFrameworks(frameworks, readResult.content, file.relativePath);
    }
    manifests.push(manifest);
  }

  const languageCounts = new Map<string, { files: number; bytes: number }>();
  for (const file of sourceFiles) {
    const language =
      getConfiguredLanguageFromPath(file.absolutePath) ?? "unknown";
    const current = languageCounts.get(language) ?? { files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += file.sizeBytes;
    languageCounts.set(language, current);
  }

  const knownSourcePaths = new Set(
    sourceFiles.map((file) => file.relativePath),
  );
  const entrypoints = new Set<string>();
  const testRoots = new Set<string>();
  const testFiles = new Set<string>();
  for (const file of sourceFiles) {
    const normalized = file.relativePath.toLowerCase();
    const basename = path.posix.basename(normalized);
    if (ENTRYPOINT_BASENAMES.has(basename) || basename === "main.go") {
      entrypoints.add(file.relativePath);
    }
    if (TEST_PATH_PATTERN.test(normalized)) {
      testFiles.add(file.relativePath);
      const segments = file.relativePath.split("/");
      const testSegmentIndex = segments.findIndex((segment) =>
        /^(?:test|tests|__tests__|spec)$/iu.test(segment),
      );
      testRoots.add(
        testSegmentIndex >= 0
          ? segments.slice(0, testSegmentIndex + 1).join("/")
          : path.posix.dirname(file.relativePath),
      );
    }
    if (path.posix.basename(file.relativePath).toLowerCase() === "main.go") {
      entrypoints.add(file.relativePath);
    }
  }
  for (const manifest of manifests) {
    const content = manifestContents.get(manifest.path);
    if (
      content === undefined ||
      path.basename(manifest.path).toLowerCase() !== "package.json"
    ) {
      continue;
    }
    const parsed = parseJsonObject(content);
    if (parsed === undefined) {
      continue;
    }
    for (const candidate of [
      stringValue(parsed.main),
      stringValue(parsed.module),
    ]) {
      addExistingPath(entrypoints, root, candidate, knownSourcePaths);
    }
    const bin = parsed.bin;
    if (typeof bin === "string") {
      addExistingPath(entrypoints, root, bin, knownSourcePaths);
    } else if (typeof bin === "object" && bin !== null) {
      Object.values(bin).forEach((value) => {
        addExistingPath(
          entrypoints,
          root,
          stringValue(value),
          knownSourcePaths,
        );
      });
    }
  }

  const configurationFiles = metadata.files
    .filter(
      (file) =>
        CONFIG_FILE_PATTERN.test(path.basename(file.relativePath)) ||
        isManifestFile(file.absolutePath),
    )
    .map((file) => file.relativePath)
    .slice(0, MAX_RETURNED_PATHS);
  const documentationFiles = metadata.files
    .filter((file) =>
      DOCUMENTATION_EXTENSIONS.has(
        path.extname(file.relativePath).toLowerCase(),
      ),
    )
    .map((file) => file.relativePath)
    .slice(0, MAX_RETURNED_PATHS);
  const projectName = getProjectName(root, manifests, manifestContents);
  const hasWorkspaceSignals =
    workspaces.size > 0 ||
    manifests.some((manifest) => manifest.kind.includes("workspace"));
  const hasApplicationSignals =
    entrypoints.size > 0 ||
    frameworks.has("Next.js") ||
    frameworks.has("React Native") ||
    frameworks.has("Django") ||
    frameworks.has("FastAPI");
  const projectKind: ProjectContextOutput["project_kind"] = hasWorkspaceSignals
    ? "workspace"
    : hasApplicationSignals
      ? "application"
      : manifests.length > 0
        ? "library"
        : "unknown";
  const output: ProjectContextOutput = {
    directory: root,
    ...(projectName === undefined ? {} : { project_name: projectName }),
    project_kind: projectKind,
    languages: [...languageCounts.entries()]
      .map(([language, counts]) => ({ language, ...counts }))
      .sort(
        (left, right) =>
          right.files - left.files ||
          left.language.localeCompare(right.language),
      ),
    frameworks: [...frameworks.values()].sort(
      (left, right) =>
        left.category.localeCompare(right.category) ||
        left.name.localeCompare(right.name),
    ),
    manifests: manifests.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
    scripts: scripts.sort((left, right) => left.name.localeCompare(right.name)),
    workspaces: [...workspaces].sort().slice(0, MAX_RETURNED_PATHS),
    entrypoints: [...entrypoints].sort().slice(0, MAX_RETURNED_PATHS),
    test_roots: [...testRoots].sort().slice(0, MAX_RETURNED_PATHS),
    test_files: [...testFiles].sort().slice(0, MAX_RETURNED_PATHS),
    configuration_files: configurationFiles,
    documentation_files: documentationFiles,
    path_aliases: readPathAliasesCached(root),
    files_analyzed: sourceFiles.length,
    manifests_analyzed: manifests.length,
    truncated:
      allSourceFiles.length > sourceFiles.length ||
      metadata.truncated ||
      testFiles.size > MAX_RETURNED_PATHS,
    profile_fingerprint: hashProfileInputs(root, sourceFiles, metadata.files),
    source_is_untrusted: true,
    secrets_redacted: secretsRedacted,
    errors,
  };

  return {
    success: true,
    message: `Project context: ${projectName ?? path.basename(root)} (${projectKind})`,
    data: output,
  };
}

export const projectContextFeature: Feature<typeof projectContextSchema> = {
  name: "get_project_context",
  title: "Get project context",
  description:
    "Build a bounded local onboarding profile: project type, languages, frameworks, manifests, scripts, workspaces, entrypoints, tests, configuration, documentation, and path aliases. It never executes project commands.",
  schema: projectContextSchema,
  outputSchema: projectContextOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute,
};
