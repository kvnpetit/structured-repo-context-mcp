import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { getAuditStatus, recordAuditEvent } from "@core/observability";

describe("local audit log", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("records bounded non-sensitive execution metadata when enabled", async () => {
    vi.stubEnv("SRC_AUDIT_LOG", "true");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-audit-"));
    try {
      await recordAuditEvent({
        tool: "search_code",
        success: true,
        duration_ms: 12.345,
        directory,
      });

      const status = getAuditStatus(directory);
      expect(status.enabled).toBe(true);
      expect(status.events).toBe(1);
      const raw = fs.readFileSync(path.join(directory, ".src-index", "audit-log.json"), "utf8");
      expect(raw).toContain("search_code");
      expect(raw).not.toContain(directory);
      expect(raw).not.toContain("api_key");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test("is a no-op by default", async () => {
    vi.stubEnv("SRC_AUDIT_LOG", "off");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "src-audit-"));
    try {
      await recordAuditEvent({
        tool: "get_index_status",
        success: true,
        duration_ms: 1,
        directory,
      });
      expect(getAuditStatus(directory).events).toBe(0);
      expect(fs.existsSync(path.join(directory, ".src-index"))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
