import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { withProcessFileLock, writeJsonAtomically } from "@core/utils";

const AUDIT_DIRECTORY = ".src-index";
const AUDIT_FILE = "audit-log.json";
const AUDIT_LOCK = ".src-index-audit.lock";
const MAX_AUDIT_BYTES = 1 * 1024 * 1024;
const MAX_AUDIT_EVENTS = 2_000;

export interface AuditEventInput {
  tool: string;
  success: boolean;
  duration_ms: number;
  directory?: string;
}

export interface AuditEvent {
  at: string;
  tool: string;
  success: boolean;
  duration_ms: number;
  project_id: string;
}

export interface AuditStatus {
  enabled: boolean;
  file: string;
  events: number;
  last_event_at?: string;
}

function auditPath(root: string): string {
  return path.join(root, AUDIT_DIRECTORY, AUDIT_FILE);
}

function auditEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  const value = environment.SRC_AUDIT_LOG?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

function projectId(root: string): string {
  return crypto
    .createHash("sha256")
    .update(path.resolve(root).toLowerCase(), "utf8")
    .digest("hex")
    .slice(0, 16);
}

function isRegularFile(filePath: string): boolean {
  try {
    const stats = fs.lstatSync(filePath);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function readEvents(filePath: string): AuditEvent[] {
  try {
    if (
      !isRegularFile(filePath) ||
      fs.statSync(filePath).size > MAX_AUDIT_BYTES
    ) {
      return [];
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((value): value is AuditEvent => {
        if (typeof value !== "object" || value === null) {
          return false;
        }
        const record = value as Record<string, unknown>;
        return (
          typeof record.at === "string" &&
          typeof record.tool === "string" &&
          record.tool.length <= 100 &&
          typeof record.success === "boolean" &&
          typeof record.duration_ms === "number" &&
          Number.isFinite(record.duration_ms) &&
          typeof record.project_id === "string"
        );
      })
      .slice(-MAX_AUDIT_EVENTS);
  } catch {
    return [];
  }
}

/** Record only non-sensitive execution metadata when explicitly enabled. */
export async function recordAuditEvent(event: AuditEventInput): Promise<void> {
  if (!auditEnabled() || event.directory === undefined) {
    return;
  }
  const root = path.resolve(event.directory);
  try {
    const rootStats = fs.lstatSync(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      return;
    }
    const directory = path.join(root, AUDIT_DIRECTORY);
    if (fs.existsSync(directory)) {
      const directoryStats = fs.lstatSync(directory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
        return;
      }
    } else {
      fs.mkdirSync(directory, { recursive: true });
    }
    const filePath = auditPath(root);
    const nextEvent: AuditEvent = {
      at: new Date().toISOString(),
      tool: event.tool.slice(0, 100),
      success: event.success,
      duration_ms: Number.isFinite(event.duration_ms)
        ? Math.max(0, Math.round(event.duration_ms * 100) / 100)
        : 0,
      project_id: projectId(root),
    };
    await withProcessFileLock(path.join(root, AUDIT_LOCK), () => {
      const events = readEvents(filePath);
      events.push(nextEvent);
      writeJsonAtomically(filePath, events.slice(-MAX_AUDIT_EVENTS));
    });
  } catch {
    // Auditing is best effort and must never change tool semantics.
  }
}

export function getAuditStatus(root: string): AuditStatus {
  const filePath = auditPath(path.resolve(root));
  const events = readEvents(filePath);
  return {
    enabled: auditEnabled(),
    file: `${AUDIT_DIRECTORY}/${AUDIT_FILE}`,
    events: events.length,
    ...(events.at(-1)?.at === undefined
      ? {}
      : { last_event_at: events.at(-1)?.at }),
  };
}
