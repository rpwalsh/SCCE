// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher } from "./primitives.js";
import type { Hasher, SourceVersion } from "./types.js";

export interface LearnSourceCommand {
  operationId: string;
  namespace: string;
  canonicalUri: string;
  mediaType: string;
  sourceBytes: Uint8Array;
  title?: string;
  observedAt?: number;
}

export interface LearnSourceResult {
  source: SourceVersion;
  evidenceId: string;
  languageProfileId: string;
}

export interface SourceLearningAdapter {
  learnSource(command: LearnSourceCommand): Promise<LearnSourceResult>;
}

/** One validated/idempotent application command shared by native and browser transports. */
export class SourceLearningApplication {
  readonly #adapter: SourceLearningAdapter;
  readonly #operations = new Map<string, { digest: string; result: Promise<LearnSourceResult> }>();
  readonly #hasher = createHasher();

  constructor(adapter: SourceLearningAdapter) { this.#adapter = adapter; }

  learn(input: LearnSourceCommand): Promise<LearnSourceResult> {
    const command = validateLearnSourceCommand(input);
    const digest = sourceLearningCommandDigest(command, this.#hasher);
    const prior = this.#operations.get(command.operationId);
    if (prior) {
      if (prior.digest !== digest) throw new Error("source learning operationId is already bound to different input");
      return prior.result;
    }
    if (this.#operations.size >= 1024) throw new Error("source learning idempotency registry is full");
    const result = this.#adapter.learnSource(command);
    this.#operations.set(command.operationId, { digest, result });
    void result.catch(() => { if (this.#operations.get(command.operationId)?.result === result) this.#operations.delete(command.operationId); });
    return result;
  }
}

export function sourceLearningCommandDigest(command: LearnSourceCommand, hasher: Hasher = createHasher()): string {
  return hasher.digestHex(canonicalStringify({
    namespace: command.namespace,
    canonicalUri: command.canonicalUri,
    mediaType: command.mediaType,
    sourceHash: hasher.digestHex(command.sourceBytes),
    title: command.title ?? null,
    observedAt: command.observedAt ?? null
  }));
}

function validateLearnSourceCommand(input: LearnSourceCommand): LearnSourceCommand {
  if (!/^[A-Za-z0-9_-]{12,128}$/u.test(input.operationId)) throw new Error("source learning operationId is invalid");
  const namespace = bounded(input.namespace, "source namespace", 256);
  const canonicalUri = bounded(input.canonicalUri, "canonical source URI", 4096);
  const mediaType = bounded(input.mediaType, "source media type", 256);
  const title = input.title === undefined ? undefined : bounded(input.title, "source title", 512);
  if (!(input.sourceBytes instanceof Uint8Array) || input.sourceBytes.byteLength < 1 || input.sourceBytes.byteLength > 8 * 1024 * 1024) {
    throw new Error("source bytes must contain between 1 byte and 8 MiB");
  }
  // The first browser slice learns text. Fatal decoding prevents replacement
  // characters from severing evidence text from the exact source bytes.
  new TextDecoder("utf-8", { fatal: true }).decode(input.sourceBytes);
  if (input.observedAt !== undefined && (!Number.isSafeInteger(input.observedAt) || input.observedAt < 0)) {
    throw new Error("source observedAt must be a non-negative integer");
  }
  return {
    operationId: input.operationId,
    namespace,
    canonicalUri,
    mediaType,
    sourceBytes: input.sourceBytes.slice(),
    ...(title ? { title } : {}),
    ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt })
  };
}

function bounded(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text || text.length > max) throw new Error(`${label} must contain between 1 and ${max} characters`);
  return text;
}
