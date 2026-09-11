import assert from "node:assert/strict";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { subCommands } from "@cli/commands";
import { config, getEmbeddingConfig, getEnrichmentConfig } from "@config";
import { features } from "@features";
import { registerPrompts } from "@prompts";
import { RESOURCE_SURFACE } from "@resources";
import { createFeatureToolConfig } from "@tools/contracts";
import * as publicApi from "@/public";
import { EXPECTED_CONTRACT_SURFACE } from "./contract-baseline";

export interface ContractSurfaceSnapshot {
  featureContracts: Record<string, string>;
  mcpTools: { names: string[]; digest: string };
  cliCommands: { names: string[]; digest: string };
  prompts: { names: string[]; digest: string };
  resources: { count: number; digest: string };
  publicExports: { names: string[]; digest: string };
  defaults: { digest: string };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined && typeof child !== "function")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function jsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { unrepresentable: "any" });
}

function collectPromptContracts(): unknown[] {
  const prompts: unknown[] = [];
  const server = {
    registerPrompt(name: string, promptConfig: unknown, callback: () => unknown): void {
      prompts.push({ name, config: promptConfig, result: callback() });
    },
  };
  registerPrompts(server as never);
  return prompts;
}

export function buildContractSurfaceSnapshot(): ContractSurfaceSnapshot {
  const featureDescriptors = features.map((feature) => ({
    name: feature.name,
    title: feature.title ?? feature.name,
    description: feature.description,
    inputSchema: jsonSchema(feature.schema),
    outputSchema: feature.outputSchema === undefined ? undefined : jsonSchema(feature.outputSchema),
    annotations: feature.annotations ?? {},
  }));
  const featureContracts = Object.fromEntries(
    featureDescriptors.map((descriptor) => [descriptor.name, digest(descriptor)]),
  );
  const toolDescriptors = features.map((feature) => {
    const tool = createFeatureToolConfig(feature);
    return {
      name: feature.name,
      title: tool.title,
      description: tool.description,
      inputSchema: jsonSchema(tool.inputSchema),
      outputSchema: jsonSchema(tool.outputSchema),
      annotations: tool.annotations,
    };
  });
  const cliDescriptors = Object.entries(subCommands).map(([name, command]) => ({
    name,
    meta: command.meta,
    args: command.args,
  }));
  const promptDescriptors = collectPromptContracts();
  const publicExports = Object.keys(publicApi).sort();

  return {
    featureContracts,
    mcpTools: {
      names: features.map((feature) => feature.name),
      digest: digest(toolDescriptors),
    },
    cliCommands: {
      names: Object.keys(subCommands),
      digest: digest(cliDescriptors),
    },
    prompts: {
      names: promptDescriptors.map((descriptor) => String((descriptor as { name: unknown }).name)),
      digest: digest(promptDescriptors),
    },
    resources: {
      count: RESOURCE_SURFACE.static.length + 1,
      digest: digest(RESOURCE_SURFACE),
    },
    publicExports: {
      names: publicExports,
      digest: digest(publicExports),
    },
    defaults: {
      digest: digest({
        server: config,
        embeddings: getEmbeddingConfig({}),
        enrichment: getEnrichmentConfig({}),
      }),
    },
  };
}

export function verifyContractSurface(): void {
  const current = buildContractSurfaceSnapshot();
  assert.notEqual(
    EXPECTED_CONTRACT_SURFACE,
    null,
    "Contract baseline is missing; run with --print and review it",
  );
  assert.deepEqual(
    current,
    EXPECTED_CONTRACT_SURFACE,
    "Public MCP/CLI contract changed. Restore parity or deliberately review the baseline.",
  );
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  if (process.argv.includes("--print")) {
    console.log(JSON.stringify(buildContractSurfaceSnapshot(), null, 2));
  } else {
    verifyContractSurface();
    console.log("MCP/CLI contract surface matches the reviewed baseline.");
  }
}
