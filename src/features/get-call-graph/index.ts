/**
 * Get Call Graph Feature
 *
 * Analyzes function call relationships in a codebase.
 * Can either:
 * 1. Build a full call graph for a directory
 * 2. Query callers/callees for a specific function
 */

import { z } from "zod";
import * as path from "node:path";
import type { Feature, FeatureResult } from "@features/types";
import {
  buildCallGraph,
  getCallContext,
  formatCallContext,
  type CallGraphNode,
} from "@core/embeddings";
import { collectFiles, createIgnoreFilter } from "@core/files";
import { logger } from "@utils";
import {
  readSecureTextFile,
  resolveSecureDirectory,
  resolveSecurePath,
  safeErrorMessage,
} from "@core/security";
import { createFeatureResultSchema, positionSchema } from "@features/utils";

export const getCallGraphSchema = z.object({
  directory: z
    .string()
    .optional()
    .default(".")
    .describe("Path to the directory to analyze"),
  functionName: z
    .string()
    .optional()
    .describe("Optional: specific function name to query callers/callees for"),
  filePath: z
    .string()
    .optional()
    .describe(
      "Optional: file path to narrow down function search (used with functionName)",
    ),
  maxDepth: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .default(2)
    .describe("Maximum depth for call chain traversal (default: 2)"),
  maxNodes: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .default(200)
    .describe("Maximum number of relationship nodes returned (default: 200)"),
  maxFiles: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .default(500)
    .describe("Maximum number of files to analyze (default: 500)"),
  exclude: z
    .array(z.string())
    .optional()
    .default([])
    .describe("Glob patterns to exclude from analysis"),
});

export type GetCallGraphInput = z.input<typeof getCallGraphSchema>;

interface CallGraphResult {
  directory: string;
  mode: "full" | "query";
  totalFunctions: number;
  totalCalls: number;
  filesAnalyzed: number;
  filesTruncated: boolean;
  truncated: boolean;
  maxNodes: number;
  query?: {
    functionName: string;
    filePath?: string;
    callers: CallGraphNode[];
    callees: CallGraphNode[];
    truncated: boolean;
    formattedContext: string;
  };
  graph?: {
    nodes: Record<string, CallGraphNode>;
    topCallers: { name: string; callCount: number }[];
    topCallees: { name: string; calledByCount: number }[];
  };
}

const callGraphNodeSchema = z
  .object({
    name: z.string(),
    qualifiedName: z.string(),
    filePath: z.string(),
    type: z.string(),
    start: positionSchema,
    end: positionSchema,
    calls: z.string().array(),
    calledBy: z.string().array(),
  })
  .strict();

const callGraphDataSchema = z
  .object({
    directory: z.string(),
    mode: z.enum(["full", "query"]),
    totalFunctions: z.number().int().nonnegative(),
    totalCalls: z.number().int().nonnegative(),
    filesAnalyzed: z.number().int().nonnegative(),
    filesTruncated: z.boolean(),
    truncated: z.boolean(),
    maxNodes: z.number().int().positive(),
    query: z
      .object({
        functionName: z.string(),
        filePath: z.string().optional(),
        callers: callGraphNodeSchema.array(),
        callees: callGraphNodeSchema.array(),
        truncated: z.boolean(),
        formattedContext: z.string(),
      })
      .strict()
      .optional(),
    graph: z
      .object({
        nodes: z.record(z.string(), callGraphNodeSchema),
        topCallers: z
          .object({
            name: z.string(),
            callCount: z.number().int().nonnegative(),
          })
          .strict()
          .array(),
        topCallees: z
          .object({
            name: z.string(),
            calledByCount: z.number().int().nonnegative(),
          })
          .strict()
          .array(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const getCallGraphOutputSchema =
  createFeatureResultSchema(callGraphDataSchema);

function publicFilePath(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

function publicQualifiedName(root: string, qualifiedName: string): string {
  const separator = qualifiedName.lastIndexOf(":");
  if (separator <= 0) {
    return qualifiedName;
  }
  const filePath = qualifiedName.slice(0, separator);
  const suffix = qualifiedName.slice(separator + 1);
  if (!path.isAbsolute(filePath)) {
    return qualifiedName;
  }
  return `${publicFilePath(root, filePath)}:${suffix}`;
}

function publicNode(root: string, node: CallGraphNode): CallGraphNode {
  return {
    ...node,
    qualifiedName: publicQualifiedName(root, node.qualifiedName),
    filePath: publicFilePath(root, node.filePath),
    calls: node.calls.map((name) => publicQualifiedName(root, name)),
    calledBy: node.calledBy.map((name) => publicQualifiedName(root, name)),
  };
}

function boundQueryRelations(
  callers: CallGraphNode[],
  callees: CallGraphNode[],
  maxNodes: number,
): {
  callers: CallGraphNode[];
  callees: CallGraphNode[];
  truncated: boolean;
} {
  if (callers.length + callees.length <= maxNodes) {
    return { callers, callees, truncated: false };
  }

  const callerLimit = Math.min(
    callers.length,
    callers.length > 0 ? Math.max(1, Math.floor(maxNodes / 2)) : 0,
  );
  const calleeLimit = Math.min(callees.length, maxNodes - callerLimit);
  const remaining = maxNodes - callerLimit - calleeLimit;

  return {
    callers: callers.slice(0, callerLimit + remaining),
    callees: callees.slice(0, calleeLimit),
    truncated: true,
  };
}

/**
 * Execute the get_call_graph feature
 */
export async function execute(
  rawInput: GetCallGraphInput,
): Promise<FeatureResult> {
  const input = getCallGraphSchema.parse(rawInput);
  const {
    directory,
    functionName,
    filePath,
    maxDepth,
    maxNodes,
    maxFiles,
    exclude,
  } = input;

  const secureDirectory = resolveSecureDirectory(directory);
  if (!secureDirectory.ok) {
    return {
      success: false,
      error:
        secureDirectory.error === "Path not found"
          ? "Directory not found"
          : secureDirectory.error,
    };
  }

  const absoluteDir = secureDirectory.path;

  try {
    // Create ignore filter
    const ig = createIgnoreFilter(absoluteDir, exclude);

    // Collect files
    const allFiles = collectFiles(absoluteDir, ig, absoluteDir).sort(
      (left, right) => left.localeCompare(right),
    );
    const files = allFiles.slice(0, maxFiles);
    const filesTruncated = files.length < allFiles.length;

    if (files.length === 0) {
      return {
        success: true,
        message: "No analyzable files found in directory",
        data: {
          directory: absoluteDir,
          mode: "full",
          totalFunctions: 0,
          totalCalls: 0,
          filesAnalyzed: 0,
          filesTruncated,
          truncated: filesTruncated,
          maxNodes,
        } satisfies CallGraphResult,
      };
    }

    logger.debug(`Analyzing call graph for ${String(files.length)} files`);

    // Read file contents and build call graph
    const fileContents = files.flatMap((f) => {
      const readResult = readSecureTextFile(f, absoluteDir);
      return readResult.ok && readResult.content !== undefined
        ? [{ path: f, content: readResult.content }]
        : [];
    });

    const graph = await buildCallGraph(fileContents);

    const result: CallGraphResult = {
      directory: absoluteDir,
      mode: functionName ? "query" : "full",
      totalFunctions: graph.nodes.size,
      totalCalls: Array.from(graph.nodes.values()).reduce(
        (sum, node) => sum + node.calls.length,
        0,
      ),
      filesAnalyzed: files.length,
      filesTruncated,
      truncated: filesTruncated,
      maxNodes,
    };

    // If querying for a specific function
    if (functionName) {
      const targetFilePath = filePath
        ? resolveSecurePath(path.resolve(absoluteDir, filePath), {
            kind: "file",
            root: absoluteDir,
            allowMissing: true,
          })
        : undefined;

      if (filePath && targetFilePath?.ok === false) {
        return {
          success: false,
          error: targetFilePath.error,
        };
      }

      const targetPath =
        targetFilePath?.ok === true ? targetFilePath.path : undefined;

      const callContext = getCallContext(graph, targetPath ?? "", functionName);

      if (!callContext) {
        // Try to find function in any file
        let foundContext: {
          callers: CallGraphNode[];
          callees: CallGraphNode[];
        } | null = null;
        let foundFilePath = "";

        for (const node of graph.nodes.values()) {
          if (node.name === functionName) {
            foundFilePath = node.filePath;
            foundContext = getCallContext(graph, node.filePath, functionName);
            if (foundContext) {
              break;
            }
          }
        }

        if (foundContext) {
          const bounded = boundQueryRelations(
            foundContext.callers,
            foundContext.callees,
            maxNodes,
          );
          result.truncated = result.truncated || bounded.truncated;
          result.query = {
            functionName,
            filePath: publicFilePath(absoluteDir, foundFilePath),
            callers: bounded.callers.map((node) =>
              publicNode(absoluteDir, node),
            ),
            callees: bounded.callees.map((node) =>
              publicNode(absoluteDir, node),
            ),
            truncated: bounded.truncated,
            formattedContext: formatCallContext(
              bounded.callers,
              bounded.callees,
              maxDepth,
            ),
          };
        } else {
          return {
            success: false,
            error: `Function '${functionName}' not found in the codebase`,
          };
        }
      } else {
        const bounded = boundQueryRelations(
          callContext.callers,
          callContext.callees,
          maxNodes,
        );
        result.truncated = result.truncated || bounded.truncated;
        result.query = {
          functionName,
          filePath: targetPath
            ? publicFilePath(absoluteDir, targetPath)
            : undefined,
          callers: bounded.callers.map((node) => publicNode(absoluteDir, node)),
          callees: bounded.callees.map((node) => publicNode(absoluteDir, node)),
          truncated: bounded.truncated,
          formattedContext: formatCallContext(
            bounded.callers,
            bounded.callees,
            maxDepth,
          ),
        };
      }

      const message = `Call graph for '${functionName}':\n\n${result.query.formattedContext}`;

      return {
        success: true,
        message,
        data: result,
      };
    }

    // Full graph mode - compute top callers and callees
    const callerCounts = new Map<string, number>();
    const calleeCounts = new Map<string, number>();

    for (const node of graph.nodes.values()) {
      callerCounts.set(node.name, node.calls.length);
      calleeCounts.set(node.name, node.calledBy.length);
    }

    const topCallers = Array.from(callerCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, callCount]) => ({ name, callCount }));

    const topCallees = Array.from(calleeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, calledByCount]) => ({ name, calledByCount }));

    const rankedNodes = Array.from(graph.nodes.entries()).sort(
      ([, left], [, right]) => {
        const leftDegree = left.calls.length + left.calledBy.length;
        const rightDegree = right.calls.length + right.calledBy.length;
        return (
          rightDegree - leftDegree ||
          left.qualifiedName.localeCompare(right.qualifiedName)
        );
      },
    );
    const selectedEntries = rankedNodes.slice(0, maxNodes);
    const selectedKeys = new Set(selectedEntries.map(([name]) => name));
    result.truncated =
      result.truncated || selectedEntries.length < rankedNodes.length;

    result.graph = {
      nodes: Object.fromEntries(
        selectedEntries.map(([name, node]) => [
          publicQualifiedName(absoluteDir, name),
          publicNode(absoluteDir, {
            ...node,
            calls: node.calls.filter((callee) => selectedKeys.has(callee)),
            calledBy: node.calledBy.filter((caller) =>
              selectedKeys.has(caller),
            ),
          }),
        ]),
      ),
      topCallers,
      topCallees,
    };

    // Build summary message
    const topCallersStr = topCallers
      .map((c) => `  - ${c.name}: ${String(c.callCount)} calls`)
      .join("\n");
    const topCalleesStr = topCallees
      .map(
        (c) => `  - ${c.name}: called by ${String(c.calledByCount)} functions`,
      )
      .join("\n");

    const message = `Call graph analysis complete:
- Files analyzed: ${String(files.length)}
- Functions found: ${String(result.totalFunctions)}
- Total calls: ${String(result.totalCalls)}

Top callers (functions that call the most):
${topCallersStr}

Most called (functions called by the most):
${topCalleesStr}

Use functionName parameter to query specific function relationships.`;

    return {
      success: true,
      message,
      data: result,
    };
  } catch (err) {
    const errorMsg = safeErrorMessage(err, "Call graph operation failed");
    return {
      success: false,
      error: `Call graph analysis failed: ${errorMsg}`,
    };
  }
}

export const getCallGraphFeature: Feature<typeof getCallGraphSchema> = {
  name: "get_call_graph",
  description:
    "Analyze function call relationships in a codebase. Query callers/callees for a specific function or get full call graph statistics.",
  schema: getCallGraphSchema,
  outputSchema: getCallGraphOutputSchema,
  execute,
};
