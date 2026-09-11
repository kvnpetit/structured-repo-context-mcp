import { describe, expect, test } from "vitest";
import { subCommands } from "@cli/commands";
import { features } from "@features";

describe("CLI Commands Index", () => {
  test("subCommands contains serve command", () => {
    expect(subCommands.serve).toBeDefined();
  });

  test("subCommands contains version command", () => {
    expect(subCommands.version).toBeDefined();
  });

  test("contains every registered feature exactly once", () => {
    const expected = ["serve", "version", ...features.map((feature) => feature.name)].sort();

    expect(Object.keys(subCommands).sort()).toEqual(expected);
  });

  test("all subCommands have meta property", () => {
    for (const [name, command] of Object.entries(subCommands)) {
      expect(command, `Command ${name} should have meta`).toHaveProperty("meta");
    }
  });
});
