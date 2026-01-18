import { describe, expect, test, vi } from "vitest";
import { createSpinner, withSpinner } from "@utils/spinner";

describe("Spinner Utilities", () => {
  test("createSpinner returns spinner object", () => {
    const spinner = createSpinner("Loading...");

    expect(spinner).toBeDefined();
    expect(typeof spinner.start).toBe("function");
    expect(typeof spinner.stop).toBe("function");
    expect(typeof spinner.succeed).toBe("function");
    expect(typeof spinner.fail).toBe("function");
  });

  test("withSpinner executes function and returns result", async () => {
    const testFn = vi.fn().mockResolvedValue("test result");

    const result = await withSpinner("Processing...", testFn);

    expect(testFn).toHaveBeenCalled();
    expect(result).toBe("test result");
  });

  test("withSpinner handles async functions returning values", async () => {
    const testFn = vi.fn().mockResolvedValue("async result");

    const result = await withSpinner("Processing...", testFn);

    expect(testFn).toHaveBeenCalled();
    expect(result).toBe("async result");
  });

  test("withSpinner with success message", async () => {
    const testFn = vi.fn().mockResolvedValue("done");

    const result = await withSpinner("Processing...", testFn, "Success!");

    expect(result).toBe("done");
  });

  test("withSpinner handles errors", async () => {
    const testFn = vi.fn().mockRejectedValue(new Error("Test error"));

    await expect(withSpinner("Processing...", testFn)).rejects.toThrow(
      "Test error",
    );
  });
});
