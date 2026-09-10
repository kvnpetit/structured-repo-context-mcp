import * as fs from "node:fs";
import * as path from "node:path";

import { isPathWithin } from "@core/security";

interface Command {
  command: string;
  args: string[];
}

const NPM_SERVERS: Readonly<Record<string, string>> = {
  "typescript-language-server": "typescript-language-server",
  "pyright-langserver": "pyright",
};

function packageEntry(
  directory: string,
  packageName: string,
  binName: string,
): string | undefined {
  try {
    const manifest = path.join(directory, "package.json");
    if (fs.statSync(manifest).size > 64 * 1024) {
      return undefined;
    }
    const value: unknown = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (
      value === null ||
      typeof value !== "object" ||
      !("name" in value) ||
      value.name !== packageName ||
      !("bin" in value)
    ) {
      return undefined;
    }
    const bins = value.bin;
    const entry =
      typeof bins === "string"
        ? bins
        : bins !== null && typeof bins === "object" && binName in bins
          ? (bins as Record<string, unknown>)[binName]
          : undefined;
    if (typeof entry !== "string" || !/\.(?:c?js|mjs)$/iu.test(entry)) {
      return undefined;
    }
    const packageRoot = fs.realpathSync(directory);
    const resolved = fs.realpathSync(path.resolve(directory, entry));
    return isPathWithin(packageRoot, resolved) && fs.statSync(resolved).isFile()
      ? resolved
      : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve allow-listed npm servers to their JS entry point, never execute a cmd shim. */
export function resolveLspCommand(
  descriptor: Command,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Command {
  if (platform !== "win32") {
    return descriptor;
  }
  const binName = path.basename(descriptor.command).replace(/\.cmd$/iu, "");
  const packageName = NPM_SERVERS[binName];
  if (packageName === undefined) {
    return descriptor;
  }
  const pathValue =
    Object.entries(environment).find(
      ([key]) => key.toUpperCase() === "PATH",
    )?.[1] ?? "";
  const directories = path.isAbsolute(descriptor.command)
    ? [path.dirname(descriptor.command)]
    : pathValue
        .split(path.delimiter)
        .filter((directory) => path.isAbsolute(directory));
  for (const directory of directories) {
    const native = path.join(directory, `${binName}.exe`);
    try {
      if (fs.statSync(native).isFile()) {
        return { command: native, args: descriptor.args };
      }
    } catch {
      // Continue with npm's JS entry, or the next directory on PATH.
    }
    // Global npm installs put node_modules beside the shim; local installs
    // place shims in node_modules/.bin. Read only the allow-listed package.
    const candidates = [path.join(directory, "node_modules", packageName)];
    if (path.basename(directory) === ".bin") {
      candidates.push(path.join(directory, "..", packageName));
    }
    for (const candidate of candidates) {
      const entry = packageEntry(candidate, packageName, binName);
      if (entry !== undefined) {
        return { command: process.execPath, args: [entry, ...descriptor.args] };
      }
    }
  }
  throw new Error("Allow-listed npm language server is not installed on PATH");
}
