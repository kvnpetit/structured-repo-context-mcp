import * as crypto from "node:crypto";

import { collectFiles, createIgnoreFilter } from "@core/files";
import { parseCode } from "@core/parser";
import { readSecureTextFile } from "@core/security";
import { extractCodeInfo } from "@core/symbols";
import {
  extractTextImports,
  fallbackSymbols,
  isTestPath,
  mergeSymbols,
  relativePath,
} from "./helpers";
import type { ParsedFile } from "./types";

export interface LoadedGraphFiles {
  parsedFiles: ParsedFile[];
  filesTruncated: boolean;
  errors: string[];
  sourceRevision: string;
}

export async function loadGraphFiles(
  root: string,
  maxFiles: number,
): Promise<LoadedGraphFiles> {
  const ignore = createIgnoreFilter(root);
  const allFiles = collectFiles(root, ignore, root).sort((left, right) =>
    relativePath(root, left).localeCompare(relativePath(root, right)),
  );
  const files = allFiles.slice(0, maxFiles);
  const errors: string[] = [];
  const parsedFiles: ParsedFile[] = [];
  const sourceHash = crypto.createHash("sha256");

  for (const absolutePath of files) {
    const relative = relativePath(root, absolutePath);
    const readResult = readSecureTextFile(absolutePath, root);
    if (!readResult.ok || readResult.content === undefined) {
      errors.push(`Cannot read ${relative}`);
      continue;
    }
    sourceHash.update(relative, "utf8");
    sourceHash.update("\0", "utf8");
    sourceHash.update(readResult.content, "utf8");
    try {
      const parsed = await parseCode(readResult.content, {
        filePath: absolutePath,
      });
      const info = extractCodeInfo(
        parsed.tree,
        parsed.languageInstance,
        parsed.language,
      );
      parsedFiles.push({
        absolutePath,
        relativePath: relative,
        language: parsed.language,
        content: readResult.content,
        symbols: mergeSymbols(
          info.symbols.symbols,
          fallbackSymbols(readResult.content),
        ),
        imports:
          info.imports.length > 0 &&
          info.imports.some((item) => item.source.length > 0)
            ? info.imports
            : extractTextImports(readResult.content),
        isTest: isTestPath(relative),
      });
    } catch {
      errors.push(`Cannot parse ${relative}`);
    }
  }

  return {
    parsedFiles,
    filesTruncated: files.length < allFiles.length,
    errors,
    sourceRevision: sourceHash.digest("hex"),
  };
}
