import * as fs from "node:fs";
import * as path from "node:path";

export type SecurePathKind = "file" | "directory";

export interface SecurePathOptions {
  kind?: SecurePathKind;
  root?: string;
  allowMissing?: boolean;
}

export type SecurePathResult = { ok: true; path: string } | { ok: false; error: string };

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const HARD_MAX_FILE_BYTES = 128 * 1024 * 1024;

function comparisonPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Return true when target is root itself or a descendant of root. */
export function isPathWithin(root: string, target: string): boolean {
  const relative = path.relative(
    comparisonPath(path.resolve(root)),
    comparisonPath(path.resolve(target)),
  );
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function realPath(target: string): string {
  return fs.realpathSync.native(target);
}

function configuredRoots(): string[] {
  const raw = process.env.SRC_ALLOWED_ROOTS;
  if (raw === undefined || raw.trim().length === 0) {
    return [];
  }

  return raw
    .split(/[;,]/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map((value) => {
      try {
        const resolved = path.resolve(value);
        return fs.existsSync(resolved) ? realPath(resolved) : resolved;
      } catch {
        return path.resolve(value);
      }
    });
}

/** Return true when the deployment explicitly supplied an allow-list. */
export function hasConfiguredAllowedRoots(): boolean {
  const raw = process.env.SRC_ALLOWED_ROOTS;
  return raw !== undefined && raw.trim().length > 0;
}

export interface ConfiguredRoot {
  path: string;
  exists: boolean;
}

/** Return every configured root, including invalid entries for diagnostics. */
export function getConfiguredAllowedRoots(): ConfiguredRoot[] {
  return configuredRoots().map((root) => ({
    path: root,
    exists: fs.existsSync(root),
  }));
}

function resolveExistingPath(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return target;
    }
    current = parent;
  }

  const existingRealPath = realPath(current);
  return path.join(existingRealPath, path.relative(current, target));
}

function checkContainment(target: string, root: string): boolean {
  if (!fs.existsSync(root)) {
    return false;
  }

  try {
    return isPathWithin(realPath(root), realPath(target));
  } catch {
    return isPathWithin(realPath(root), resolveExistingPath(target));
  }
}

/**
 * Validate a project-local state directory before a native store or cache
 * opens it. State directories are created by the application, so an existing
 * link or junction is always rejected instead of being followed.
 */
export function isSecureStateDirectory(root: string, stateDirectory: string): boolean {
  const rootPath = path.resolve(root);
  const statePath = path.resolve(stateDirectory);
  if (!isPathWithin(rootPath, statePath)) {
    return false;
  }

  let rootRealPath: string;
  try {
    rootRealPath = realPath(rootPath);
  } catch {
    rootRealPath = rootPath;
  }

  try {
    if (!fs.existsSync(statePath)) {
      return isPathWithin(rootRealPath, resolveExistingPath(statePath));
    }
    const stats = fs.lstatSync(statePath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return false;
    }
    return isPathWithin(rootRealPath, realPath(statePath));
  } catch {
    return false;
  }
}

/** Throw a stable error when project-local state is not safely usable. */
export function assertSecureStateDirectory(root: string, stateDirectory: string): void {
  if (!isSecureStateDirectory(root, stateDirectory)) {
    throw new Error("Project state directory is not a regular in-project directory");
  }
}

/**
 * Resolve and validate a path before any filesystem access.
 *
 * `SRC_ALLOWED_ROOTS` is an optional semicolon/comma-separated allow-list for
 * remote or shared deployments. A caller-provided `root` additionally scopes
 * the path to one project directory and catches symlink escapes.
 */
export function resolveSecurePath(
  inputPath: string,
  options: SecurePathOptions = {},
): SecurePathResult {
  if (inputPath.trim().length === 0) {
    return { ok: false, error: "Path must not be empty" };
  }
  if (inputPath.includes("\0")) {
    return { ok: false, error: "Path contains a null byte" };
  }

  const absolutePath = path.resolve(inputPath);
  const exists = fs.existsSync(absolutePath);
  if (!exists && !options.allowMissing) {
    return { ok: false, error: "Path not found" };
  }

  if (exists) {
    try {
      const stats = fs.statSync(absolutePath);
      if (options.kind === "file" && !stats.isFile()) {
        return { ok: false, error: "Path is not a regular file" };
      }
      if (options.kind === "directory" && !stats.isDirectory()) {
        return { ok: false, error: "Path is not a directory" };
      }
    } catch {
      return { ok: false, error: "Path cannot be inspected" };
    }
  }

  const roots = configuredRoots();
  // Deployment roots are alternatives; a project root is an additional
  // restriction, never another way to bypass the deployment allow-list.
  const outsideDeployment =
    hasConfiguredAllowedRoots() && !roots.some((root) => checkContainment(absolutePath, root));
  const outsideProject =
    options.root !== undefined && !checkContainment(absolutePath, path.resolve(options.root));
  if (outsideDeployment || outsideProject) {
    return { ok: false, error: "Path is outside the allowed workspace" };
  }

  // With no configured root, preserve local CLI compatibility. Callers that
  // operate on a project pass `root`, which enables realpath containment.
  return { ok: true, path: absolutePath };
}

export function resolveSecureFile(inputPath: string, root?: string): SecurePathResult {
  return resolveSecurePath(inputPath, { kind: "file", root });
}

export function resolveSecureDirectory(inputPath: string, root?: string): SecurePathResult {
  return resolveSecurePath(inputPath, { kind: "directory", root });
}

export function getMaxFileBytes(): number {
  const configured = Number(process.env.SRC_MAX_FILE_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= HARD_MAX_FILE_BYTES
    ? configured
    : DEFAULT_MAX_FILE_BYTES;
}

/**
 * Keep useful provider/parser messages while preventing absolute local paths
 * from crossing the MCP boundary in an error string.
 */
export function safeErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const containsAbsolutePath = /(?:[A-Za-z]:[\\/]|(?:^|[\s("'`])\/[^\s"'`)]*)/u.test(message);
  if (containsAbsolutePath) {
    return fallback;
  }
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

export function readSecureTextFile(
  inputPath: string,
  root?: string,
): SecurePathResult & { content?: string } {
  const resolved = resolveSecureFile(inputPath, root);
  if (!resolved.ok) {
    return resolved;
  }

  let descriptor: number | undefined;
  try {
    // Open once and inspect/read through the descriptor. This closes the
    // common check-then-read race where a file is replaced after containment
    // validation; the descriptor continues to reference the opened file.
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    descriptor = fs.openSync(resolved.path, fs.constants.O_RDONLY | noFollow);
    // O_NOFOLLOW is unavailable on some Windows runtimes. Re-check the
    // pathname after opening so a raced replacement by a link is discarded.
    const openedPath = fs.lstatSync(resolved.path);
    if (openedPath.isSymbolicLink() || !openedPath.isFile()) {
      return { ok: false, error: "Path is not a regular file" };
    }
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile()) {
      return { ok: false, error: "Path is not a regular file" };
    }
    const size = stats.size;
    if (size > getMaxFileBytes()) {
      return {
        ok: false,
        error: `File exceeds the ${String(getMaxFileBytes())}-byte safety limit`,
      };
    }
    return {
      ok: true,
      path: resolved.path,
      content: fs.readFileSync(descriptor, "utf8"),
    };
  } catch (error) {
    // Do not return native filesystem messages: they often contain absolute
    // paths and sensitive usernames. Preserve non-Error test/provider codes
    // without exposing native Error.message text.
    const message = error instanceof Error ? "File cannot be read" : String(error);
    return { ok: false, error: message || "File cannot be read" };
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor may already have been closed by the platform.
      }
    }
  }
}
