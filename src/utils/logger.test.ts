import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { logger } from "@utils/logger";

describe("Logger", () => {
  /* eslint-disable no-console */
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  beforeEach(() => {
    console.log = vi.fn();
    console.warn = vi.fn();
    console.error = vi.fn();
  });

  afterEach(() => {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  });

  test("logger.info calls console.log", () => {
    logger.info("Test info message");
    expect(console.log).toHaveBeenCalled();
  });

  test("logger.warn calls console.warn", () => {
    logger.warn("Test warning");
    expect(console.warn).toHaveBeenCalled();
  });

  test("logger.error calls console.error", () => {
    logger.error("Test error");
    expect(console.error).toHaveBeenCalled();
  });

  test("logger.success calls console.log", () => {
    logger.success("Test success");
    expect(console.log).toHaveBeenCalled();
  });
  /* eslint-enable no-console */

  test("logger has all required methods", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.success).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });
});
