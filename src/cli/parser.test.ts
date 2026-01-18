import { zodToCittyArgs } from "@cli/parser";
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

  test("converts ZodDefault to citty arg with default value", () => {
    const schema = z.object({
      format: z.string().default("text").describe("Output format"),
    });

    const args = zodToCittyArgs(schema);

    expect(args.format).toBeDefined();
    expect(args.format?.default).toBe("text");
    expect(args.format?.required).toBe(false);
  });

  test("handles ZodEnum as string", () => {
    const schema = z.object({
      level: z.enum(["info", "warn", "error"]).describe("Log level"),
    });

    const args = zodToCittyArgs(schema);

    expect(args.level).toBeDefined();
    expect(args.level?.type).toBe("string");
  });

  test("returns empty object for non-object schema", () => {
    const schema = z.string();

    const args = zodToCittyArgs(schema);

    expect(args).toEqual({});
  });
});
