import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

interface MutationCase {
  name: string;
  file: string;
  search: string;
  replacement: string;
  testFile: string;
}

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const mutations: readonly MutationCase[] = [
  {
    name: "accepts an offset of zero",
    file: "src/core/pagination.ts",
    search: "offset < 0",
    replacement: "offset <= 0",
    testFile: "src/core/pagination.test.ts",
  },
  {
    name: "accepts a cursor from another query scope",
    file: "src/core/pagination.ts",
    search: "record.scope !== expectedScope",
    replacement: "record.scope === expectedScope",
    testFile: "src/core/pagination.test.ts",
  },
  {
    name: "rejects valid cursor prefixes",
    file: "src/core/pagination.ts",
    search: "!cursor.startsWith(CURSOR_PREFIX)",
    replacement: "cursor.startsWith(CURSOR_PREFIX)",
    testFile: "src/core/pagination.test.ts",
  },
  {
    name: "loses stable object-key ordering",
    file: "src/core/pagination.ts",
    search: "Object.keys(record).sort()",
    replacement: "Object.keys(record)",
    testFile: "src/core/pagination.test.ts",
  },
];

function copyRepository(destination: string): void {
  const excluded = new Set([
    ".git",
    "node_modules",
    "dist",
    "coverage",
    ".src-index",
  ]);
  fs.cpSync(repositoryRoot, destination, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(repositoryRoot, source);
      const firstSegment = relative.split(path.sep)[0];
      return relative.length === 0 || !excluded.has(firstSegment ?? "");
    },
  });

  const sourceDependencies = path.join(repositoryRoot, "node_modules");
  if (!fs.existsSync(sourceDependencies)) {
    throw new Error("node_modules is required for the local mutation smoke");
  }
  const linkedDependencies = path.join(destination, "node_modules");
  fs.symlinkSync(
    sourceDependencies,
    linkedDependencies,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function applyMutation(destination: string, mutation: MutationCase): void {
  const target = path.join(destination, mutation.file);
  const source = fs.readFileSync(target, "utf8");
  const occurrences = source.split(mutation.search).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${mutation.name}: expected one mutation site, found ${String(occurrences)}`,
    );
  }
  fs.writeFileSync(
    target,
    source.replace(mutation.search, mutation.replacement),
  );
}

interface TestRunResult {
  output: string;
  signal: NodeJS.Signals | null;
  status: number | null;
}

function runTests(destination: string, testFile: string): TestRunResult {
  const result = spawnSync(
    process.platform === "win32" ? "bun.exe" : "bun",
    ["run", "vitest", "run", testFile],
    {
      cwd: destination,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  return {
    output: `${result.stdout}${result.stderr}`.slice(-2_000),
    signal: result.signal,
    status: result.status,
  };
}

const baselineDestination = fs.mkdtempSync(
  path.join(os.tmpdir(), "src-mcp-mutation-baseline-"),
);
try {
  copyRepository(baselineDestination);
  const baseline = runTests(baselineDestination, "src/core/pagination.test.ts");
  if (baseline.status !== 0 || baseline.signal !== null) {
    throw new Error(
      `Baseline pagination tests must pass before mutation testing:\n${baseline.output}`,
    );
  }
} finally {
  fs.rmSync(baselineDestination, { recursive: true, force: true });
}

const killed: string[] = [];
const survived: string[] = [];
for (const mutation of mutations) {
  const destination = fs.mkdtempSync(
    path.join(os.tmpdir(), "src-mcp-mutation-"),
  );
  try {
    copyRepository(destination);
    applyMutation(destination, mutation);
    const result = runTests(destination, mutation.testFile);
    if (result.signal !== null || result.status === null) {
      throw new Error(
        `${mutation.name}: mutation test process did not finish normally`,
      );
    }
    if (result.status === 0) {
      survived.push(mutation.name);
    } else {
      killed.push(mutation.name);
    }
  } finally {
    fs.rmSync(destination, { recursive: true, force: true });
  }
}

console.log(
  `Mutation smoke: killed ${String(killed.length)}/${String(mutations.length)}`,
);
for (const name of killed) {
  console.log(`  killed: ${name}`);
}
if (survived.length > 0) {
  for (const name of survived) {
    console.error(`  survived: ${name}`);
  }
  process.exitCode = 1;
}
