import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createHasher, createSourceRepositoryFacts, normalizePath, redactSecrets, sourceCodeFileFactsFromJson, toJsonValue, type ContentHash, type FileIngestPort, type IngestedSourceFile, type IngestionCheckpoint, type JsonValue, type SourceCodeFileFacts } from "@scce/kernel";
import type { ScceRuntimeConfig } from "./config.js";
import { diagnoseExtractionTools, extractDocument } from "./document.js";
import { resolveWikipediaCorpusTarget, streamWikipediaMultistream } from "./wikipedia.js";

interface RepositoryFileAccumulator {
  path: string;
  mediaType: string;
  byteLength: number;
  contentHash?: string;
  facts?: SourceCodeFileFacts;
}

export class NodeFileIngestAdapter implements FileIngestPort {
  constructor(private readonly config: ScceRuntimeConfig) {}

  async *streamPath(pathOrUri: string, options: { metadata?: JsonValue } = {}): AsyncIterable<
    | { type: "checkpoint"; checkpoint: IngestionCheckpoint }
    | { type: "file"; file: IngestedSourceFile; checkpoint: IngestionCheckpoint }
    | { type: "skipped"; skipped: { path: string; reason: string }; checkpoint: IngestionCheckpoint }
  > {
    const target = path.resolve(this.config.runtime.workspaceRoot, pathOrUri);
    assertAllowed(target, this.config.runtime.allowedRoots);
    const wikipedia = resolveWikipediaCorpusTarget(this.config, target);
    if (wikipedia) {
      yield* streamWikipediaMultistream(wikipedia);
      return;
    }
    const rootUri = normalizePath(path.relative(this.config.runtime.workspaceRoot, target)) || ".";
    const targetIsDirectory = (await safeStat(target)).isDirectory;
    const paths = targetIsDirectory ? walkStream(target, this.config.runtime.excludedPaths) : singleFile(target);
    const repositoryFiles: RepositoryFileAccumulator[] = [];
    for await (const filePath of paths) {
      const discovered = checkpoint(rootUri, filePath, "discovered", "pending", { workspaceRoot: this.config.runtime.workspaceRoot });
      yield { type: "checkpoint", checkpoint: discovered };
      try {
        const info = await stat(filePath);
        if (info.size > this.config.runtime.maxFileBytes) {
          yield { type: "skipped", skipped: { path: filePath, reason: "max-file-bytes" }, checkpoint: checkpoint(rootUri, filePath, "skipped", "complete", { size: info.size }, "max-file-bytes", undefined, info.size) };
          continue;
        }
        yield { type: "checkpoint", checkpoint: checkpoint(rootUri, filePath, "extracting", "running", { size: info.size }) };
        const extraction = await extractDocument(filePath, this.config);
        if (!extraction.text.trim()) {
          const reason = extraction.diagnostics.missingPreconditions.length ? `missing:${extraction.diagnostics.missingPreconditions.join(",")}` : "empty-text";
          yield { type: "skipped", skipped: { path: filePath, reason }, checkpoint: checkpoint(rootUri, filePath, "skipped", "complete", extraction.metadata, reason, `sha256_${extraction.sha256}` as ContentHash, extraction.bytes.byteLength) };
          continue;
        }
        const metadata = withCodebaseContext(mergeMetadata(extraction.metadata, options.metadata), {
          rootUri,
          itemUri: extraction.uri,
          rootIsDirectory: targetIsDirectory,
          parserFactsPresent: sourceCodeFactsPresent(extraction.metadata)
        });
        repositoryFiles.push({
          path: extraction.uri,
          mediaType: extraction.mediaType,
          byteLength: extraction.bytes.byteLength,
          contentHash: `sha256_${extraction.sha256}`,
          facts: sourceCodeFileFactsFromJson(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, JsonValue>).sourceCode : undefined)
        });
        const file = {
          uri: extraction.uri,
          namespace: extraction.namespace,
          mediaType: extraction.mediaType,
          bytes: extraction.bytes,
          text: redactSecrets(extraction.text),
          metadata
        };
        yield { type: "file", file, checkpoint: checkpoint(rootUri, filePath, "extracted", "complete", metadata, undefined, `sha256_${extraction.sha256}` as ContentHash, extraction.bytes.byteLength) };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        yield { type: "skipped", skipped: { path: filePath, reason }, checkpoint: checkpoint(rootUri, filePath, "failed", "failed", {}, reason) };
      }
    }
    if (targetIsDirectory && repositoryFiles.length) {
      const repository = repositoryFactsFile(rootUri, target, repositoryFiles);
      yield { type: "checkpoint", checkpoint: repository.checkpoint };
      yield { type: "file", file: repository.file, checkpoint: repository.checkpoint };
    }
  }
}

export async function diagnoseDocumentTools(config: ScceRuntimeConfig): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
  return (await diagnoseExtractionTools(config)).map(tool => ({ name: tool.name, ok: tool.ok, detail: `${tool.detail} (${tool.requiredFor.join(",")})` }));
}

async function* walkStream(root: string, excluded: string[]): AsyncIterable<string> {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    if (excluded.some(ex => isWithin(current, ex)) || shouldSkipRepoPath(current)) continue;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).reverse()) {
      const next = path.join(current, entry.name);
      if (excluded.some(ex => isWithin(next, ex)) || shouldSkipRepoPath(next)) continue;
      if (entry.isDirectory()) stack.push(next);
      else if (entry.isFile()) yield next;
    }
  }
}

async function* singleFile(filePath: string): AsyncIterable<string> {
  yield filePath;
}

function checkpoint(rootUri: string, filePath: string, phase: IngestionCheckpoint["phase"], status: IngestionCheckpoint["status"], metadata: JsonValue, reason?: string, contentHash?: ContentHash, byteLength?: number): IngestionCheckpoint {
  const itemUri = path.resolve(filePath);
  return {
    id: `ingest_${createHash("sha256").update(`${rootUri}\u001f${itemUri}`).digest("hex").slice(0, 32)}`,
    rootUri,
    itemUri,
    phase,
    status,
    offsetBytes: byteLength ?? 0,
    contentHash,
    byteLength,
    reason,
    updatedAt: Date.now(),
    metadata
  };
}

async function safeStat(filePath: string): Promise<{ isDirectory: boolean }> {
  const s = await stat(filePath);
  return { isDirectory: s.isDirectory() };
}

function assertAllowed(target: string, roots: string[]): void {
  if (!roots.some(root => isWithin(target, root))) throw new Error(`path outside configured allowedRoots: ${target}`);
}

function isWithin(candidate: string, root: string): boolean {
  const c = path.resolve(candidate).toLowerCase();
  const r = path.resolve(root).toLowerCase();
  return c === r || c.startsWith(`${r}${path.sep}`);
}

function shouldSkipRepoPath(candidate: string): boolean {
  const parts = path.resolve(candidate).split(path.sep).map(part => part.toLocaleLowerCase());
  return parts.some(part => [
    "node_modules",
    ".git",
    ".scce",
    ".tmp",
    "dist",
    "build",
    ".cache",
    ".next",
    ".turbo",
    "coverage",
    ".pnpm-store"
  ].includes(part));
}

function withCodebaseContext(metadata: JsonValue, context: { rootUri: string; itemUri: string; rootIsDirectory: boolean; parserFactsPresent: boolean }): JsonValue {
  const base = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, JsonValue> : {};
  return {
    ...base,
    sourceKind: context.parserFactsPresent ? "developer_intelligence" : base.sourceKind ?? "local_corpus",
    codebase: {
      rootUri: context.rootUri,
      itemUri: context.itemUri,
      rootIsDirectory: context.rootIsDirectory,
      parserFactsPresent: context.parserFactsPresent
    }
  };
}

function sourceCodeFactsPresent(metadata: JsonValue): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return Boolean((metadata as Record<string, JsonValue>).sourceCode);
}

function mergeMetadata(left: JsonValue, right: JsonValue | undefined): JsonValue {
  const a = left && typeof left === "object" && !Array.isArray(left) ? left as Record<string, JsonValue> : {};
  const b = right && typeof right === "object" && !Array.isArray(right) ? right as Record<string, JsonValue> : {};
  return { ...a, ...b };
}

function repositoryFactsFile(rootUri: string, target: string, files: RepositoryFileAccumulator[]): { file: IngestedSourceFile; checkpoint: IngestionCheckpoint } {
  const hasher = createHasher();
  const facts = createSourceRepositoryFacts({ rootUri, files, hasher });
  const text = JSON.stringify(facts, null, 2);
  const bytes = Buffer.from(text, "utf8");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const uri = virtualRepositoryFactsUri(rootUri);
  const metadata = withCodebaseContext(toJsonValue({
    sourceKind: "developer_intelligence",
    ingestionLane: "codebase",
    repositoryFacts: facts
  }), {
    rootUri,
    itemUri: uri,
    rootIsDirectory: true,
    parserFactsPresent: true
  });
  return {
    file: {
      uri,
      namespace: "codebase",
      mediaType: "application/vnd.scce.source-repository-facts+json",
      bytes,
      text,
      metadata
    },
    checkpoint: checkpoint(rootUri, path.join(target, ".scce-repository-facts.virtual.json"), "extracted", "complete", metadata, undefined, `sha256_${sha}` as ContentHash, bytes.byteLength)
  };
}

function virtualRepositoryFactsUri(rootUri: string): string {
  const normalized = normalizePath(rootUri) || ".";
  return `scce-codebase/${normalized}/repository-facts`;
}
