/**
 * Content reading utilities for features
 *
 * Provides consistent file/content handling across features
 */
import { getMaxFileBytes, readSecureTextFile } from "@core/security";

/**
 * Result of reading content
 */
export type ContentResult =
  | { success: true; content: string; filePath?: string }
  | { success: false; error: string };

/**
 * Read content from either a file path or direct content string
 *
 * This is a common pattern used by multiple features that accept
 * either a file_path or content parameter.
 *
 * @param filePath - Optional path to file to read
 * @param content - Optional content string
 * @returns ContentResult with either the content or an error message
 */
export function readContent(
  filePath?: string,
  content?: string,
  root?: string,
): ContentResult {
  // If content is provided directly, use it
  if (content !== undefined) {
    const size = Buffer.byteLength(content, "utf8");
    if (size > getMaxFileBytes()) {
      return {
        success: false,
        error: `Content exceeds the ${String(getMaxFileBytes())}-byte safety limit`,
      };
    }
    return { success: true, content };
  }

  // If file path is provided, read it
  if (filePath !== undefined) {
    const fileResult = readSecureTextFile(filePath, root);
    if (!fileResult.ok) {
      return {
        success: false,
        error: `Failed to read file: ${fileResult.error}`,
      };
    }
    if (fileResult.content === undefined) {
      return { success: false, error: "Failed to read file: empty result" };
    }
    return {
      success: true,
      content: fileResult.content,
      filePath: fileResult.path,
    };
  }

  // Neither provided
  return {
    success: false,
    error: "Either file_path or content must be provided",
  };
}

/**
 * Require that either filePath or content is provided
 *
 * @param filePath - Optional path to file
 * @param content - Optional content string
 * @returns True if at least one is provided
 */
export function hasContentSource(filePath?: string, content?: string): boolean {
  return filePath !== undefined || content !== undefined;
}
