import { ENV } from "@/config";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function isValidLogLevel(level: string): level is LogLevel {
  return level in LOG_LEVELS;
}

function shouldLog(level: LogLevel): boolean {
  const configLevel = ENV.logLevel;
  const currentLevel = isValidLogLevel(configLevel)
    ? LOG_LEVELS[configLevel]
    : LOG_LEVELS.info;
  return LOG_LEVELS[level] >= currentLevel;
}

function formatMessage(level: LogLevel, message: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (shouldLog("debug")) {
      console.error(formatMessage("debug", message), ...args);
    }
  },

  info(message: string, ...args: unknown[]): void {
    if (shouldLog("info")) {
      console.error(formatMessage("info", message), ...args);
    }
  },

  warn(message: string, ...args: unknown[]): void {
    if (shouldLog("warn")) {
      console.error(formatMessage("warn", message), ...args);
    }
  },

  error(message: string, ...args: unknown[]): void {
    if (shouldLog("error")) {
      console.error(formatMessage("error", message), ...args);
    }
  },
};
