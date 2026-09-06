import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execute } from "@features/dependency-graph";

describe("get_dependency_graph", () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "dependency-graph-test-"),
    );
    fs.writeFileSync(
      path.join(directory, "a.ts"),
      'import { b } from "./b"; export const a = b;\n',
    );
    fs.writeFileSync(
      path.join(directory, "b.ts"),
      'import { a } from "./a"; export const b = a;\n',
    );
    fs.writeFileSync(path.join(directory, "base.ts"), "export class Base {}\n");
    fs.writeFileSync(
      path.join(directory, "child.ts"),
      'import { Base } from "./base"; export class Child extends Base {}\n',
    );
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("resolves imports and reports cycles and hotspots", async () => {
    const result = await execute({
      directory,
      max_files: 10,
      include_external: false,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      nodes: unknown[];
      edges: { resolved: boolean }[];
      cycles: unknown[][];
      hotspots: unknown[];
      typeHierarchy: {
        nodes: { name: string }[];
        edges: { parent: string; resolved: boolean }[];
      };
    };
    expect(data.nodes).toHaveLength(4);
    expect(data.edges.filter((edge) => edge.resolved)).toHaveLength(3);
    expect(data.cycles.length).toBeGreaterThan(0);
    expect(data.hotspots.length).toBeGreaterThan(0);
    expect(data.typeHierarchy.nodes.map((node) => node.name)).toContain(
      "Child",
    );
    expect(
      data.typeHierarchy.edges.some(
        (edge) => edge.parent === "Base" && edge.resolved,
      ),
    ).toBe(true);
  });

  test("bounds returned edges and reports truncation", async () => {
    const result = await execute({
      directory,
      max_files: 10,
      max_edges: 1,
      include_external: false,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      truncated: true,
      total_edges: 3,
    });
    expect((result.data as { edges: unknown[] }).edges).toHaveLength(1);
  });

  test("bounds the type hierarchy independently", async () => {
    const result = await execute({
      directory,
      max_files: 10,
      max_type_nodes: 1,
      max_type_edges: 1,
      include_external: false,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      typeHierarchy: {
        truncated: true,
      },
    });
    expect(
      (result.data as { typeHierarchy: { nodes: unknown[] } }).typeHierarchy
        .nodes,
    ).toHaveLength(1);
  });
});
