import { spawn } from "node:child_process";

import { startHttpServer } from "../src/http.ts";

const scenarios = [
  "server-initialize",
  "ping",
  "tools-list",
  "resources-list",
  "prompts-list",
  "dns-rebinding-protection",
] as const;
const conformanceVersion = process.env.MCP_CONFORMANCE_VERSION ?? "0.1.16";
const conformanceSpecVersion =
  process.env.MCP_CONFORMANCE_SPEC_VERSION ?? "2025-11-25";

if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(conformanceVersion)) {
  throw new Error("MCP_CONFORMANCE_VERSION contains unsupported characters");
}
if (!/^\d{4}-\d{2}-\d{2}$/u.test(conformanceSpecVersion)) {
  throw new Error(
    "MCP_CONFORMANCE_SPEC_VERSION must be a YYYY-MM-DD protocol revision",
  );
}

if (process.platform === "win32") {
  console.warn(
    "MCP conformance smoke is skipped on Windows: the current upstream runner exits with a libuv teardown assertion after successful checks. Modern protocol tests remain enabled on Windows.",
  );
  process.exit(0);
}

async function runScenario(url: string, scenario: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    const commandValues = [
      "--yes",
      `@modelcontextprotocol/conformance@${conformanceVersion}`,
      "server",
      "--url",
      url,
      "--suite",
      "active",
      "--spec-version",
      conformanceSpecVersion,
      "--scenario",
      scenario,
    ];
    const child = spawn("npx", commandValues, {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      resolve(code ?? 1);
    });
  });
}

const running = await startHttpServer({ host: "127.0.0.1", port: 0 });
try {
  let failures = 0;
  for (const scenario of scenarios) {
    const code = await runScenario(running.url, scenario);
    if (code !== 0) {
      failures += 1;
    }
  }
  if (failures > 0) {
    throw new Error(
      `${String(failures)} MCP conformance smoke scenario(s) failed`,
    );
  }
  console.log(
    `MCP conformance smoke passed: ${String(scenarios.length)} scenarios for ${conformanceSpecVersion} using @modelcontextprotocol/conformance@${conformanceVersion}.`,
  );
} finally {
  await running.close();
}
