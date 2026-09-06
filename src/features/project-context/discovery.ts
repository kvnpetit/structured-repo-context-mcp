import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createIgnoreFilter } from "@core/files";
import { resolveSecureFile } from "@core/security";

import type { DiscoveredFile, FrameworkInfo, ManifestInfo } from "./types";

const HARD_MAX_DISCOVERED_ENTRIES = 20_000;
export const MAX_RETURNED_PATHS = 100;

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".src-index",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "target",
  "vendor",
  "out",
  "obj",
]);

const ALLOWED_HIDDEN_DIRECTORIES = new Set([
  ".devcontainer",
  ".github",
  ".vscode",
  ".husky",
]);

export const MANIFEST_KINDS = new Map<string, string>([
  ["package.json", "javascript-package"],
  ["pnpm-workspace.yaml", "pnpm-workspace"],
  ["lerna.json", "lerna-workspace"],
  ["nx.json", "nx-workspace"],
  ["turbo.json", "turborepo-workspace"],
  ["tsconfig.json", "typescript-config"],
  ["jsconfig.json", "javascript-config"],
  ["pyproject.toml", "python-package"],
  ["requirements.txt", "python-dependencies"],
  ["requirements-dev.txt", "python-dependencies"],
  ["setup.py", "python-package"],
  ["setup.cfg", "python-config"],
  ["poetry.lock", "python-lockfile"],
  ["uv.lock", "python-lockfile"],
  ["cargo.toml", "rust-package"],
  ["cargo.lock", "rust-lockfile"],
  ["go.mod", "go-module"],
  ["go.work", "go-workspace"],
  ["go.sum", "go-lockfile"],
  ["pom.xml", "maven-project"],
  ["build.gradle", "gradle-project"],
  ["build.gradle.kts", "gradle-project"],
  ["settings.gradle", "gradle-config"],
  ["settings.gradle.kts", "gradle-config"],
  ["composer.json", "php-package"],
  ["composer.lock", "php-lockfile"],
  ["gemfile", "ruby-package"],
  ["gemfile.lock", "ruby-lockfile"],
  ["mix.exs", "elixir-package"],
  ["mix.lock", "elixir-lockfile"],
  ["pubspec.yaml", "dart-package"],
  ["pubspec.lock", "dart-lockfile"],
  ["makefile", "make-project"],
  ["dockerfile", "container-config"],
  ["docker-compose.yml", "container-config"],
  ["docker-compose.yaml", "container-config"],
  ["compose.yml", "container-config"],
  ["compose.yaml", "container-config"],
  ["angular.json", "angular-config"],
  ["vite.config.js", "vite-config"],
  ["vite.config.ts", "vite-config"],
  ["next.config.js", "next-config"],
  ["next.config.mjs", "next-config"],
  ["next.config.ts", "next-config"],
  ["nuxt.config.ts", "nuxt-config"],
]);

export const CONFIG_FILE_PATTERN =
  /^(?:\.?[^/]+\.(?:config|conf|ini|toml|yaml|yml|json|xml)|Dockerfile(?:\..*)?|Makefile)$/iu;

export const DOCUMENTATION_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".rst",
  ".txt",
]);

const FRAMEWORK_SIGNALS: Record<string, { name: string; category: string }> = {
  react: { name: "React", category: "ui" },
  "react-native": { name: "React Native", category: "mobile" },
  next: { name: "Next.js", category: "web" },
  vue: { name: "Vue", category: "ui" },
  nuxt: { name: "Nuxt", category: "web" },
  svelte: { name: "Svelte", category: "ui" },
  "@sveltejs/kit": { name: "SvelteKit", category: "web" },
  "@angular/core": { name: "Angular", category: "web" },
  express: { name: "Express", category: "server" },
  fastify: { name: "Fastify", category: "server" },
  "@nestjs/core": { name: "NestJS", category: "server" },
  hono: { name: "Hono", category: "server" },
  astro: { name: "Astro", category: "web" },
  vite: { name: "Vite", category: "build" },
  webpack: { name: "Webpack", category: "build" },
  vitest: { name: "Vitest", category: "testing" },
  jest: { name: "Jest", category: "testing" },
  playwright: { name: "Playwright", category: "testing" },
  cypress: { name: "Cypress", category: "testing" },
  prisma: { name: "Prisma", category: "data" },
  drizzle: { name: "Drizzle", category: "data" },
  django: { name: "Django", category: "web" },
  fastapi: { name: "FastAPI", category: "web" },
  flask: { name: "Flask", category: "web" },
  pytest: { name: "pytest", category: "testing" },
  sqlalchemy: { name: "SQLAlchemy", category: "data" },
  pydantic: { name: "Pydantic", category: "data" },
  tokio: { name: "Tokio", category: "runtime" },
  axum: { name: "Axum", category: "server" },
  actix: { name: "Actix", category: "server" },
  serde: { name: "Serde", category: "serialization" },
  tauri: { name: "Tauri", category: "desktop" },
  gin: { name: "Gin", category: "server" },
  echo: { name: "Echo", category: "server" },
  fiber: { name: "Fiber", category: "server" },
};

export const ENTRYPOINT_BASENAMES = new Set([
  "main.ts",
  "main.tsx",
  "main.js",
  "main.jsx",
  "main.py",
  "main.go",
  "main.rs",
  "index.ts",
  "index.tsx",
  "index.js",
  "index.jsx",
  "index.py",
  "index.go",
  "index.rs",
  "server.ts",
  "server.js",
  "server.py",
  "app.ts",
  "app.js",
  "app.py",
  "manage.py",
  "__main__.py",
]);

export const TEST_PATH_PATTERN =
  /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)|(?:\.test|\.spec)\.[^/]+$|(?:^|\/)(?:test_[^/]+|[^/]+_test)\.(?:py|go|rs)$/iu;

export function relativePath(root: string, value: string): string {
  return path.relative(root, value).replace(/\\/gu, "/");
}

function readDirectoryEntries(directory: string): fs.Dirent[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function shouldTraverseDirectory(name: string): boolean {
  if (SKIPPED_DIRECTORIES.has(name.toLowerCase())) {
    return false;
  }
  return !name.startsWith(".") || ALLOWED_HIDDEN_DIRECTORIES.has(name);
}

export function isManifestFile(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  if (MANIFEST_KINDS.has(basename)) {
    return true;
  }
  return /\.(?:csproj|fsproj|vbproj|sln)$/iu.test(basename);
}

function isMetadataFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  return (
    isManifestFile(filePath) ||
    CONFIG_FILE_PATTERN.test(basename) ||
    DOCUMENTATION_EXTENSIONS.has(path.extname(basename).toLowerCase())
  );
}

export function discoverMetadataFiles(
  root: string,
  maxEntries: number,
): { files: DiscoveredFile[]; truncated: boolean } {
  const ignore = createIgnoreFilter(root);
  const files: DiscoveredFile[] = [];
  const stack = [{ directory: root, depth: 0 }];
  let visitedEntries = 0;

  while (stack.length > 0 && visitedEntries < HARD_MAX_DISCOVERED_ENTRIES) {
    const current = stack.pop();
    if (current === undefined) {
      break;
    }
    for (const entry of readDirectoryEntries(current.directory)) {
      visitedEntries += 1;
      if (visitedEntries >= HARD_MAX_DISCOVERED_ENTRIES) {
        break;
      }
      if (entry.isDirectory()) {
        if (
          current.depth < 8 &&
          shouldTraverseDirectory(entry.name) &&
          !ignore.ignores(
            relativePath(root, path.join(current.directory, entry.name)),
          )
        ) {
          stack.push({
            directory: path.join(current.directory, entry.name),
            depth: current.depth + 1,
          });
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const absolutePath = path.join(current.directory, entry.name);
      const relative = relativePath(root, absolutePath);
      if (
        !isMetadataFile(absolutePath) ||
        ignore.ignores(relative) ||
        files.length >= maxEntries
      ) {
        continue;
      }
      try {
        const stats = fs.statSync(absolutePath);
        files.push({
          absolutePath,
          relativePath: relative,
          sizeBytes: stats.size,
        });
      } catch {
        // The file may disappear during a watcher update; keep the profile usable.
      }
    }
  }

  return {
    files: files.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    truncated:
      files.length >= maxEntries ||
      visitedEntries >= HARD_MAX_DISCOVERED_ENTRIES,
  };
}

export function parseJsonObject(
  content: string,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function packageDependencies(
  manifest: Record<string, unknown>,
): string[] {
  const names = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const dependencies = manifest[field];
    if (typeof dependencies !== "object" || dependencies === null) {
      continue;
    }
    for (const name of Object.keys(dependencies)) {
      names.add(name.toLowerCase());
    }
  }
  return [...names];
}

export function extractTomlName(
  content: string,
  section: "project" | "package",
): string | undefined {
  const sectionPattern = new RegExp(
    `(?:^|\\n)\\s*\\[${section}\\]([\\s\\S]*?)(?=\\n\\s*\\[|$)`,
    "iu",
  );
  const sectionContent = sectionPattern.exec(content)?.[1] ?? content;
  return /(?:^|\n)\s*name\s*=\s*["']([^"']+)["']/iu.exec(sectionContent)?.[1];
}

export function detectPackageManager(
  manifest: Record<string, unknown>,
  relativePathValue: string,
  knownFiles: ReadonlySet<string>,
): string | undefined {
  const configured = stringValue(manifest.packageManager);
  if (configured !== undefined) {
    return configured.split("@")[0];
  }
  const directory = path.posix.dirname(relativePathValue);
  const lockfiles = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ] as const;
  for (const [filename, manager] of lockfiles) {
    const candidate = path.posix.join(directory, filename);
    if (knownFiles.has(candidate)) {
      return manager;
    }
  }
  return "npm";
}

export function addFrameworkSignal(
  signals: Map<string, FrameworkInfo>,
  dependency: string,
  evidence: string,
): void {
  const signal = FRAMEWORK_SIGNALS[dependency.toLowerCase()];
  if (signal === undefined) {
    return;
  }
  const existing = signals.get(signal.name);
  if (existing === undefined) {
    signals.set(signal.name, {
      name: signal.name,
      category: signal.category,
      evidence: [evidence],
    });
    return;
  }
  if (!existing.evidence.includes(evidence) && existing.evidence.length < 5) {
    existing.evidence.push(evidence);
  }
}

export function detectTextFrameworks(
  signals: Map<string, FrameworkInfo>,
  content: string,
  relativePathValue: string,
): void {
  const lower = content.toLowerCase();
  for (const dependency of Object.keys(FRAMEWORK_SIGNALS)) {
    if (
      new RegExp(
        `(?:^|[\\s"'/:])${escapeRegExp(dependency)}(?:$|[\\s"'/:])`,
        "u",
      ).test(lower)
    ) {
      addFrameworkSignal(signals, dependency, relativePathValue);
    }
  }
}

export function collectWorkspacePatterns(
  manifest: Record<string, unknown>,
): string[] {
  const workspaces = manifest.workspaces;
  if (Array.isArray(workspaces)) {
    return stringArray(workspaces).slice(0, MAX_RETURNED_PATHS);
  }
  if (typeof workspaces === "object" && workspaces !== null) {
    return stringArray((workspaces as Record<string, unknown>).packages).slice(
      0,
      MAX_RETURNED_PATHS,
    );
  }
  return [];
}

export function addExistingPath(
  result: Set<string>,
  root: string,
  candidate: string | undefined,
  knownPaths: ReadonlySet<string>,
): void {
  if (candidate === undefined || candidate.trim().length === 0) {
    return;
  }
  const normalized = candidate.replace(/\\/gu, "/").replace(/^\.\//u, "");
  if (knownPaths.has(normalized)) {
    result.add(normalized);
    return;
  }
  const absolute = path.resolve(root, candidate);
  const secure = resolveSecureFile(absolute, root);
  if (secure.ok) {
    result.add(relativePath(root, secure.path));
  }
}

export function getProjectName(
  root: string,
  manifests: readonly ManifestInfo[],
  manifestContents: ReadonlyMap<string, string>,
): string | undefined {
  for (const manifest of manifests) {
    if (
      manifest.project_name !== undefined &&
      path.dirname(manifest.path) === "."
    ) {
      return manifest.project_name;
    }
  }
  const goModule = manifestContents.get("go.mod");
  const goName =
    goModule === undefined
      ? undefined
      : /^\s*module\s+(\S+)/mu.exec(goModule)?.[1];
  return goName ?? path.basename(root);
}

export function hashProfileInputs(
  root: string,
  sourceFiles: readonly DiscoveredFile[],
  metadataFiles: readonly DiscoveredFile[],
): string {
  const hash = crypto.createHash("sha256");
  hash.update(root);
  for (const file of [...sourceFiles, ...metadataFiles].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  )) {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file.absolutePath).mtimeMs;
    } catch {
      // A best-effort fingerprint is still useful when a file vanishes.
    }
    hash.update(
      `${file.relativePath}\0${String(file.sizeBytes)}\0${String(mtimeMs)}\n`,
    );
  }
  return hash.digest("hex");
}
