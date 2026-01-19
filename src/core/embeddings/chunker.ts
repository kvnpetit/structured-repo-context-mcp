/**
 * Code chunker for splitting source files into embeddable chunks
 */

import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import * as crypto from "node:crypto";
import type { CodeChunk, EmbeddingConfig } from "@core/embeddings/types";

/**
 * Language-specific separators for better chunk boundaries
 */
const LANGUAGE_SEPARATORS: Record<string, string[]> = {
  typescript: [
    "\nexport ",
    "\nfunction ",
    "\nclass ",
    "\ninterface ",
    "\ntype ",
    "\nconst ",
    "\nlet ",
    "\n\n",
    "\n",
  ],
  javascript: [
    "\nexport ",
    "\nfunction ",
    "\nclass ",
    "\nconst ",
    "\nlet ",
    "\n\n",
    "\n",
  ],
  python: ["\nclass ", "\ndef ", "\nasync def ", "\n\n", "\n"],
  rust: [
    "\nfn ",
    "\npub fn ",
    "\nimpl ",
    "\nstruct ",
    "\nenum ",
    "\ntrait ",
    "\nmod ",
    "\n\n",
    "\n",
  ],
  go: ["\nfunc ", "\ntype ", "\nvar ", "\nconst ", "\n\n", "\n"],
  java: [
    "\npublic ",
    "\nprivate ",
    "\nprotected ",
    "\nclass ",
    "\ninterface ",
    "\n\n",
    "\n",
  ],
  default: ["\n\n", "\n", " "],
};

/**
 * Generate a unique ID for a chunk
 */
function generateChunkId(
  filePath: string,
  content: string,
  startLine: number,
): string {
  const hash = crypto
    .createHash("md5")
    .update(`${filePath}:${String(startLine)}:${content}`)
    .digest("hex")
    .slice(0, 12);
  return `chunk_${hash}`;
}

/**
 * Detect language from file extension
 */
export function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";

  const extensionMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    rb: "ruby",
    php: "php",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    scala: "scala",
    vue: "vue",
    svelte: "svelte",
    md: "markdown",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    html: "html",
    css: "css",
    scss: "scss",
    less: "less",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
  };

  return extensionMap[ext] ?? "unknown";
}

/**
 * Get separators for a language
 */
function getSeparators(language: string): string[] {
  return LANGUAGE_SEPARATORS[language] ?? LANGUAGE_SEPARATORS.default ?? [];
}

/**
 * Calculate line number from character offset
 */
function getLineNumber(content: string, offset: number): number {
  const before = content.slice(0, offset);
  return (before.match(/\n/g) ?? []).length + 1;
}

/**
 * Chunk a source file into smaller pieces
 */
export async function chunkFile(
  filePath: string,
  content: string,
  config: Pick<EmbeddingConfig, "defaultChunkSize" | "defaultChunkOverlap">,
): Promise<CodeChunk[]> {
  const language = detectLanguage(filePath);
  const separators = getSeparators(language);

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: config.defaultChunkSize,
    chunkOverlap: config.defaultChunkOverlap,
    separators,
  });

  const docs = await splitter.createDocuments([content]);

  const chunks: CodeChunk[] = [];
  let currentOffset = 0;

  for (const doc of docs) {
    const chunkContent = doc.pageContent;
    const chunkIndex = content.indexOf(chunkContent, currentOffset);

    if (chunkIndex !== -1) {
      currentOffset = chunkIndex;
    }

    const startLine = getLineNumber(content, currentOffset);
    const endLine = getLineNumber(content, currentOffset + chunkContent.length);

    chunks.push({
      id: generateChunkId(filePath, chunkContent, startLine),
      content: chunkContent,
      filePath,
      language,
      startLine,
      endLine,
    });

    currentOffset += chunkContent.length;
  }

  return chunks;
}

/**
 * Chunk multiple files
 */
export async function chunkFiles(
  files: { path: string; content: string }[],
  config: Pick<EmbeddingConfig, "defaultChunkSize" | "defaultChunkOverlap">,
): Promise<CodeChunk[]> {
  const allChunks: CodeChunk[] = [];

  for (const file of files) {
    const chunks = await chunkFile(file.path, file.content, config);
    allChunks.push(...chunks);
  }

  return allChunks;
}

/**
 * Supported file extensions for indexing
 */
export const SUPPORTED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".scala",
  ".vue",
  ".svelte",
  ".md",
];

/**
 * Check if a file should be indexed
 */
export function shouldIndexFile(filePath: string): boolean {
  const ext = "." + (filePath.split(".").pop()?.toLowerCase() ?? "");
  return SUPPORTED_EXTENSIONS.includes(ext);
}
