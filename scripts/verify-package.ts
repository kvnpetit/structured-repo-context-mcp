import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

interface PackageJson {
  filename?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function quoteWindowsArg(value: string): string {
  return /[\s&|<>^]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

async function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const windowsCommand =
      process.platform === "win32" && command.toLowerCase().endsWith(".cmd");
    const executable = windowsCommand
      ? (process.env.ComSpec ?? "cmd.exe")
      : command;
    const executableArgs = windowsCommand
      ? [
          "/d",
          "/s",
          "/c",
          [command, ...args]
            .map((value, index) =>
              index === 0 ? value : quoteWindowsArg(value),
            )
            .join(" "),
        ]
      : args;
    const child = spawn(executable, executableArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          `${command} exited with ${signal ?? String(code)}\n${stderr || stdout}`,
        ),
      );
    });
  });
}

function packageFilename(value: unknown): string {
  const first = Array.isArray(value)
    ? (value[0] as PackageJson | undefined)
    : value !== null && typeof value === "object"
      ? (Object.values(value)[0] as PackageJson | undefined)
      : undefined;
  if (!first || typeof first.filename !== "string") {
    throw new Error("npm pack did not return a package tarball filename");
  }
  return first.filename;
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packageJson = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
) as { name?: string; version?: string };
const packageName = packageJson.name ?? "src-mcp";
const packageVersion = packageJson.version ?? "unknown";
const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "src-mcp-package-"));

try {
  const packed = await run(
    npmCommand,
    ["pack", "--json", "--pack-destination", tempDirectory],
    projectRoot,
  );
  const tarball = path.join(
    tempDirectory,
    packageFilename(JSON.parse(packed.stdout)),
  );
  const installDirectory = path.join(tempDirectory, "install");
  await mkdir(installDirectory, { recursive: true });

  await run(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      installDirectory,
      tarball,
    ],
    projectRoot,
  );

  const installedPackage = path.join(
    installDirectory,
    "node_modules",
    packageName,
  );
  await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const pkg = await import(${JSON.stringify(packageName)}); if (typeof pkg.createServer !== "function") process.exit(2); const parseAst = pkg.features?.find((feature) => feature.name === "parse_ast"); if (parseAst === undefined) process.exit(3); const result = await parseAst.execute({ content: "export const packaged = true;", language: "typescript", max_depth: 1 }); if (result?.success !== true) process.exit(4);`,
    ],
    installDirectory,
  );
  const version = await run(
    process.execPath,
    [path.join(installedPackage, "dist", "bin.mjs"), "version"],
    installDirectory,
  );
  if (!version.stdout.includes(`${packageName} v${packageVersion}`)) {
    throw new Error(
      `Installed CLI did not report ${packageName} v${packageVersion}: ${version.stdout}`,
    );
  }
  console.log(
    `Package verification passed for ${packageName}@${packageVersion}: ${path.basename(tarball)}; side-effect-free import, bundled assets, and CLI version validated.`,
  );
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
