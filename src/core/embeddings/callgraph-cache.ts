import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
  CallGraph,
  CallGraphNode,
  SerializedCallGraph,
} from "@core/embeddings/callgraph-types";
import { logger } from "@utils";

export function computeCallGraphHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function getCachePath(directory: string): string {
  return path.join(directory, ".src-index", "call-graph.json");
}

export function saveCallGraphCache(
  directory: string,
  graph: CallGraph,
  fileHashes: Record<string, string>,
): void {
  try {
    const cachePath = getCachePath(directory);
    const cacheDir = path.dirname(cachePath);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    const serialized: SerializedCallGraph = {
      nodes: Object.fromEntries(graph.nodes),
      files: graph.files,
      edgeCount: graph.edgeCount,
      fileHashes,
      timestamp: Date.now(),
    };

    fs.writeFileSync(cachePath, JSON.stringify(serialized), "utf-8");
    logger.debug(`Call graph cache saved: ${String(graph.nodes.size)} nodes`);
  } catch {
    logger.debug("Call graph cache save skipped: directory not writable");
  }
}

export function loadCallGraphCache(
  directory: string,
  currentHashes: Record<string, string>,
): CallGraph | null {
  const cachePath = getCachePath(directory);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, "utf-8")) as SerializedCallGraph;
    if (Object.keys(cached.fileHashes).length !== Object.keys(currentHashes).length) {
      logger.debug("Call graph cache invalid: file count changed");
      return null;
    }
    for (const [filePath, hash] of Object.entries(currentHashes)) {
      if (cached.fileHashes[filePath] !== hash) {
        logger.debug(`Call graph cache invalid: ${filePath} changed`);
        return null;
      }
    }

    const nodes = new Map<string, CallGraphNode>(Object.entries(cached.nodes));
    logger.debug(`Call graph cache loaded: ${String(nodes.size)} nodes`);
    return { nodes, files: cached.files, edgeCount: cached.edgeCount };
  } catch (error) {
    logger.debug(
      `Failed to load call graph cache: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
