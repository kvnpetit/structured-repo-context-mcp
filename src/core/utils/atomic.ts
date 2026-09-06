import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Replace a small local state file through a temporary sibling.
 *
 * POSIX systems get an atomic rename. Windows does not allow renameSync to
 * replace an existing file, so the fallback uses copyFileSync and removes the
 * temporary sibling only after the destination has been written.
 */
export function writeTextAtomically(filePath: string, content: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, content, "utf8");

  try {
    try {
      fs.renameSync(temporaryPath, filePath);
    } catch {
      fs.copyFileSync(temporaryPath, filePath);
      fs.unlinkSync(temporaryPath);
    }
  } finally {
    try {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
    } catch {
      // Best-effort cleanup; the destination remains valid.
    }
  }
}

export function writeJsonAtomically(filePath: string, value: unknown): void {
  writeTextAtomically(filePath, JSON.stringify(value, null, 2));
}
