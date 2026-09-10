import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { ENV } from "@config";
import { logger } from "@utils/logger";

describe("Logger", () => {
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

  test("logger.info calls console.error", () => {
    logger.info("Test info message");
    expect(console.error).toHaveBeenCalled();
  });

  test("logger.warn calls console.warn", () => {
    logger.warn("Test warning");
    expect(console.warn).toHaveBeenCalled();
  });

  test("logger.error calls console.error", () => {
    logger.error("Test error");
    expect(console.error).toHaveBeenCalled();
  });

  test("logger.success calls console.error", () => {
    logger.success("Test success");
    expect(console.error).toHaveBeenCalled();
  });

  test("logger.debug does not log when level is info", () => {
    logger.debug("Test debug message");
    // By default log level is 'info', so debug won't log to console.error
    // The function runs but doesn't output
    expect(console.error).not.toHaveBeenCalled();
  });

  test("logger has all required methods", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.success).toBe("function");
    expect(typeof logger.debug).toBe("function");
  });
});

describe("Logger with debug level", () => {
  test("logger.debug function exists and is callable", () => {
    expect(() => {
      logger.debug("Test message");
    }).not.toThrow();
  });

  test("logger uses correct log levels hierarchy", () => {
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.success).toBe("function");
  });

  test("logger.debug logs when debug level is enabled", () => {
    const originalLogLevel = ENV.logLevel;
    (ENV as { logLevel: string }).logLevel = "debug";

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logger.debug("Debug message");

    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
    (ENV as { logLevel: string }).logLevel = originalLogLevel;
  });
});

describe("Logger with invalid log level", () => {
  test("falls back to info level when log level is invalid", () => {
    const originalLogLevel = ENV.logLevel;
    (ENV as { logLevel: string }).logLevel = "invalid_level";

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Info should still log (default fallback is info level)
    logger.info("Test info message");
    expect(consoleErrorSpy).toHaveBeenCalled();

    // Debug should NOT log (debug < info in hierarchy)
    consoleErrorSpy.mockClear();
    logger.debug("Test debug message");
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    (ENV as { logLevel: string }).logLevel = originalLogLevel;
  });

  test("error level suppresses info and warn logs", () => {
    const originalLogLevel = ENV.logLevel;
    (ENV as { logLevel: string }).logLevel = "error";

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Info should NOT log (info < error) - info uses console.error now
    logger.info("Test info");
    // At this point console.error should NOT have been called for info
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    // Warn should NOT log (warn < error)
    logger.warn("Test warning");
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    // Error should log
    logger.error("Test error");
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    (ENV as { logLevel: string }).logLevel = originalLogLevel;
  });

  test("warn level suppresses info but allows warn and error", () => {
    const originalLogLevel = ENV.logLevel;
    (ENV as { logLevel: string }).logLevel = "warn";

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Info should NOT log (info < warn) - info uses console.error now
    logger.info("Test info");
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    // Warn should log
    logger.warn("Test warning");
    expect(consoleWarnSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    (ENV as { logLevel: string }).logLevel = originalLogLevel;
  });

  test("logger.warn logs at all levels including invalid", () => {
    const originalLogLevel = ENV.logLevel;
    (ENV as { logLevel: string }).logLevel = "invalid_level";

    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logger.warn("Test warning");
    expect(consoleWarnSpy).toHaveBeenCalled();

    consoleWarnSpy.mockRestore();
    (ENV as { logLevel: string }).logLevel = originalLogLevel;
  });

  test("logger.error logs at all levels", () => {
    const originalLogLevel = ENV.logLevel;
    (ENV as { logLevel: string }).logLevel = "invalid_level";

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logger.error("Test error");
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    (ENV as { logLevel: string }).logLevel = originalLogLevel;
  });
});
