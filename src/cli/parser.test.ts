import { normalizeCliArgs, zodToCittyArgs } from "@cli/parser";
import { describe, expect, test } from "vitest";
import { z } from "zod";

describe("Zod to Citty Parser", () => {
  test("converts ZodString to citty arg", () => {
    const schema = z.object({
      name: z.string().describe("User name"),
    });

    const args = zodToCittyArgs(schema);

    expect(args.name).toBeDefined();
    expect(args.name?.type).toBe("string");
    expect(args.name?.description).toBe("User name");
    expect(args.name?.required).toBe(true);
  });

  test("converts optional ZodString to citty arg", () => {
    const schema = z.object({
      email: z.string().optional().describe("User email"),
    });

    const args = zodToCittyArgs(schema);
    expect(args.email).toBeDefined();
    expect(args.email?.type).toBe("string");
    expect(args.email?.required).toBe(false);
  });

  test("converts ZodBoolean to citty arg", () => {
    const schema = z.object({
      verbose: z.boolean().describe("Verbose output"),
    });

    const args = zodToCittyArgs(schema);

    expect(args.verbose).toBeDefined();
    expect(args.verbose?.type).toBe("boolean");
  });

  test("converts ZodBoolean with default to citty arg", () => {
    const schema = z.object({
      debug: z.boolean().default(false).describe("Debug mode"),
    });

    const args = zodToCittyArgs(schema);

    expect(args.debug).toBeDefined();
    expect(args.debug?.type).toBe("boolean");
    expect(args.debug?.default).toBe(false);
    expect(args.debug?.required).toBe(false);
  });

  test("converts ZodDefault to citty arg with default value", () => {
    const schema = z.object({
      format: z.string().default("text").describe("Output format"),
    });

    const args = zodToCittyArgs(schema);

    expect(args.format).toBeDefined();
    expect(args.format?.default).toBe("text");
    expect(args.format?.required).toBe(false);
  });

  test("converts ZodEnum to a constrained enum argument", () => {
    const schema = z.object({
      level: z.enum(["info", "warn", "error"]).describe("Log level"),
    });

    const args = zodToCittyArgs(schema);

    const level = args.level;
    expect(level).toBeDefined();
    expect(level?.type).toBe("enum");
    if (level?.type === "enum") {
      expect(level.options).toEqual(["info", "warn", "error"]);
    }
  });

  test("returns empty object for non-object schema", () => {
    const schema = z.string();

    const args = zodToCittyArgs(schema);

    expect(args).toEqual({});
  });

  test("handles optional with description on inner type", () => {
    const schema = z.object({
      port: z.number().describe("Port number").optional(),
    });

    const args = zodToCittyArgs(schema);

    expect(args.port).toBeDefined();
    expect(args.port?.description).toBe("Port number");
    expect(args.port?.required).toBe(false);
  });

  test("handles default with description on inner type", () => {
    const schema = z.object({
      host: z.string().describe("Hostname").default("localhost"),
    });

    const args = zodToCittyArgs(schema);

    expect(args.host).toBeDefined();
    expect(args.host?.description).toBe("Hostname");
    expect(args.host?.default).toBe("localhost");
  });

  test("handles ZodNumber as string type", () => {
    const schema = z.object({
      count: z.number().describe("Count value"),
    });

    const args = zodToCittyArgs(schema);

    expect(args.count).toBeDefined();
    expect(args.count?.type).toBe("string");
    expect(args.count?.description).toBe("Count value");
  });

  test("handles field without description", () => {
    const schema = z.object({
      value: z.string(),
    });

    const args = zodToCittyArgs(schema);

    expect(args.value).toBeDefined();
    expect(args.value?.type).toBe("string");
    expect(args.value?.description).toBeUndefined();
  });

  test("handles nested optional default patterns", () => {
    const schema = z.object({
      timeout: z.number().optional().default(30),
    });

    const args = zodToCittyArgs(schema);

    expect(args.timeout).toBeDefined();
    expect(args.timeout?.required).toBe(false);
  });

  test("rejects schema-like objects that are not actual Zod objects", () => {
    const fakeSchema = {
      shape: {
        field: {}, // No _def, no description
      },
    };

    const args = zodToCittyArgs(fakeSchema as unknown as z.ZodType);

    expect(args).toEqual({});
  });

  test("handles boolean without description", () => {
    const schema = z.object({
      flag: z.boolean(),
    });

    const args = zodToCittyArgs(schema);

    expect(args.flag).toBeDefined();
    expect(args.flag?.type).toBe("boolean");
    expect(args.flag?.description).toBeUndefined();
  });

  test("uses string-safe defaults and restores numeric values", () => {
    const schema = z.object({
      count: z.number().int().default(30),
    });

    const args = zodToCittyArgs(schema);
    expect(args.count?.default).toBe("30");
    expect(normalizeCliArgs(schema, { count: "42", _: [] })).toEqual({
      count: 42,
    });
  });

  test("parses array arguments from JSON or comma-separated values", () => {
    const schema = z.object({
      paths: z.array(z.string()).default([]),
      limits: z.array(z.number()).default([]),
    });

    expect(
      normalizeCliArgs(schema, {
        paths: '["src/a.ts","src/b.ts"]',
        limits: "10,20",
      }),
    ).toEqual({ paths: ["src/a.ts", "src/b.ts"], limits: [10, 20] });
  });

  test("flattens object unions while preserving conditional requirements", () => {
    const schema = z.union([
      z.object({ operation: z.literal("get"), id: z.string() }),
      z.object({ operation: z.literal("list"), limit: z.number().default(10) }),
    ]);

    const args = zodToCittyArgs(schema);
    expect(Object.keys(args).sort()).toEqual(["id", "limit", "operation"]);
    expect(args.operation?.required).toBe(true);
    expect(args.id?.required).toBe(false);
    expect(args.limit?.default).toBe("10");
    expect(normalizeCliArgs(schema, { operation: "list", limit: "5" })).toEqual(
      { operation: "list", limit: 5 },
    );
  });
});
