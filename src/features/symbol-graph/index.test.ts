import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { execute } from "@features/symbol-graph";

describe("get_symbol_graph", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "symbol-graph-test-"));
    fs.mkdirSync(path.join(directory, "tests"));
    fs.writeFileSync(
      path.join(directory, "base.ts"),
      "export class Base {}\nexport function helper() { return 1; }\n",
    );
    fs.writeFileSync(
      path.join(directory, "service.ts"),
      'import { helper, Base } from "./base";\nexport class Service extends Base { run() { return helper(); } }\nexport function route() { return helper(); }\n',
    );
    fs.writeFileSync(
      path.join(directory, "app.ts"),
      'import { Service } from "./service";\nconst service = new Service();\nrouter.get("/health", () => service.run());\nemitter.emit("ready");\ncontainer.register("service", Service);\n',
    );
    fs.writeFileSync(
      path.join(directory, "tests", "service.test.ts"),
      'import { Service } from "../service";\ntest("service", () => new Service().run());\n',
    );
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("combines symbol relationships and static architecture signals", async () => {
    const result = await execute({
      directory,
      max_files: 20,
      max_nodes: 200,
      max_edges: 500,
      trace_from: "app.ts",
      trace_to: "helper",
      focus: ["helper"],
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const data = result.data as {
      nodes: { kind: string; name: string }[];
      edges: { kind: string }[];
      signals: { routes: number; events: number; dependencies: number };
      blast_radius: { focus: string[]; direct: string[] };
      trace_paths: { found: boolean }[];
      source_revision: string;
      coverage: string;
    };
    expect(
      data.nodes.some(
        (node) => node.kind === "symbol" && node.name === "Service",
      ),
    ).toBe(true);
    expect(data.edges.some((edge) => edge.kind === "imports")).toBe(true);
    expect(data.edges.some((edge) => edge.kind === "calls")).toBe(true);
    expect(data.edges.some((edge) => edge.kind === "inherits")).toBe(true);
    expect(data.edges.some((edge) => edge.kind === "tests")).toBe(true);
    expect(data.signals.routes).toBeGreaterThan(0);
    expect(data.signals.events).toBeGreaterThan(0);
    expect(data.signals.dependencies).toBeGreaterThan(0);
    expect(data.blast_radius.focus.length).toBeGreaterThan(0);
    expect(data.trace_paths[0]?.found).toBe(true);
    expect(data.source_revision).toMatch(/^[a-f0-9]{64}$/u);
    expect(data.coverage).toBe("approximate");
  });

  test("is bounded and reports truncation", async () => {
    const result = await execute({
      directory,
      max_files: 2,
      max_nodes: 2,
      max_edges: 1,
      include_signals: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    const data = result.data as {
      nodes: unknown[];
      edges: unknown[];
      files_truncated: boolean;
      truncated: boolean;
    };
    expect(data.nodes.length).toBeLessThanOrEqual(2);
    expect(data.edges.length).toBeLessThanOrEqual(1);
    expect(data.files_truncated).toBe(true);
    expect(data.truncated).toBe(true);
  });

  test("rejects an invalid directory without executing project code", async () => {
    const result = await execute({
      directory: path.join(directory, "missing"),
    });
    expect(result.success).toBe(false);
  });
});
