// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import { buildSchema, execute, GraphQLError, parse, subscribe, type DocumentNode, type ExecutionResult } from "graphql";
import { createPortableCognitiveRuntime } from "@scce/kernel/dist/browser-cognitive-runtime.js";
import { SourceLearningApplication, sourceLearningCommandDigest } from "@scce/kernel/dist/source-learning-application.js";
import canonicalSchemaText from "../../../server/schema.graphql?raw";
import runtimeQuery from "../__generated__/WorkbenchRuntimeQuery.graphql";
import reserveMutation from "../__generated__/WorkbenchReserveMutation.graphql";
import startMutation from "../__generated__/WorkbenchStartMutation.graphql";
import cancelMutation from "../__generated__/WorkbenchCancelMutation.graphql";
import taskQuery from "../__generated__/WorkbenchTaskQuery.graphql";
import taskPaginationQuery from "../__generated__/WorkbenchTaskPaginationQuery.graphql";
import taskSubscription from "../__generated__/WorkbenchTaskSubscription.graphql";
import sourcesQuery from "../__generated__/WorkbenchSourcesQuery.graphql";
import sourcesPaginationQuery from "../__generated__/WorkbenchSourcesPaginationQuery.graphql";
import learningQuery from "../__generated__/WorkbenchLearningQuery.graphql";
import reviewHeldSourceMutation from "../__generated__/WorkbenchReviewHeldSourceMutation.graphql";
import dataQuery from "../__generated__/WorkbenchDataQuery.graphql";
import capabilitiesQuery from "../__generated__/WorkbenchCapabilitiesQuery.graphql";
import learnSourceMutation from "../__generated__/WorkbenchLearnSourceMutation.graphql";
import type { ConcreteRequest, Variables } from "relay-runtime";
import type { BrowserStateRepository, BrowserTaskFrame, BrowserTaskRecord } from "./sqlite-opfs.js";

export const browserGraphqlProtocolVersion = "scce.graphql.v1";

const schema = buildSchema(canonicalSchemaText);
const TERMINAL = new Set<BrowserTaskRecord["status"]>(["succeeded", "failed", "cancelled", "interrupted"]);

const documents = new Map<string, DocumentNode>([
  register(runtimeQuery),
  register(reserveMutation),
  register(startMutation),
  register(cancelMutation),
  register(taskQuery),
  register(taskPaginationQuery),
  register(taskSubscription),
  register(sourcesQuery),
  register(sourcesPaginationQuery),
  register(learningQuery),
  register(reviewHeldSourceMutation),
  register(dataQuery),
  register(capabilitiesQuery),
  register(learnSourceMutation)
]);

interface GraphqlContext {
  signal: AbortSignal;
}

interface TaskWaiter {
  afterSequence: number;
  resolve(task: BrowserTaskRecord): void;
}

export class BrowserGraphqlApplication {
  readonly #repository: BrowserStateRepository;
  readonly #cognitive = createPortableCognitiveRuntime();
  readonly #sourceLearning: SourceLearningApplication;
  readonly #waiters = new Map<string, Set<TaskWaiter>>();

  constructor(repository: BrowserStateRepository) {
    this.#repository = repository;
    this.#sourceLearning = new SourceLearningApplication({
      learnSource: async command => {
        const receiptKey = `source-learning:${command.operationId}`;
        const payloadDigest = sourceLearningCommandDigest(command);
        const prior = this.#repository.getReceipt(receiptKey);
        if (prior) {
          if (prior.payloadDigest !== payloadDigest) throw new Error("source learning operationId is already bound to different input");
          const response = prior.response as { sourceVersionId?: string; evidenceId?: string; languageProfileId?: string };
          const source = this.#repository.loadSources().find(row => String(row.source.sourceVersionId) === response.sourceVersionId);
          if (!source || !response.evidenceId || !response.languageProfileId) throw new Error("durable source learning receipt is incomplete");
          return { source: source.source, evidenceId: response.evidenceId, languageProfileId: response.languageProfileId };
        }
        const learned = this.#cognitive.learnSource({
          namespace: command.namespace,
          canonicalUri: command.canonicalUri,
          mediaType: command.mediaType,
          sourceBytes: command.sourceBytes,
          observedAt: command.observedAt ?? 0,
          ...(command.title ? { title: command.title } : {})
        });
        this.#repository.putSource(learned);
        const result = {
          source: learned.source,
          evidenceId: String(learned.evidence.id),
          languageProfileId: learned.languageProfile.id
        };
        this.#repository.putReceipt({
          requestId: receiptKey,
          payloadDigest,
          response: { sourceVersionId: String(learned.source.sourceVersionId), evidenceId: result.evidenceId, languageProfileId: result.languageProfileId }
        });
        return result;
      }
    });
  }

  isRegistered(operationName: string): boolean {
    return documents.has(operationName);
  }

  async execute(operationName: string, variables: Variables, signal: AbortSignal): Promise<ExecutionResult> {
    const document = documents.get(operationName);
    if (!document) return { errors: [new GraphQLError(`Unregistered GraphQL operation: ${operationName}`)] };
    signal.throwIfAborted();
    const result = await execute({
      schema,
      document,
      rootValue: this.#rootValue(),
      contextValue: { signal } satisfies GraphqlContext,
      variableValues: variables,
      operationName
    });
    signal.throwIfAborted();
    return result;
  }

  async subscribe(operationName: string, variables: Variables, signal: AbortSignal): Promise<AsyncIterable<ExecutionResult> | ExecutionResult> {
    const document = documents.get(operationName);
    if (!document) return { errors: [new GraphQLError(`Unregistered GraphQL operation: ${operationName}`)] };
    signal.throwIfAborted();
    return subscribe({
      schema,
      document,
      rootValue: this.#rootValue(),
      contextValue: { signal } satisfies GraphqlContext,
      variableValues: variables,
      operationName
    });
  }

  #rootValue(): Record<string, unknown> {
    return {
      runtime: () => ({
        protocolVersion: browserGraphqlProtocolVersion,
        generation: this.#repository.epoch,
        phase: "browser-opfs-ready",
        ready: true
      }),
      node: ({ id }: { id: string }) => this.#taskView(this.#repository.getTask(id)),
      nodes: ({ ids }: { ids: string[] }) => ids.map(id => this.#taskView(this.#repository.getTask(id))),
      turnTask: ({ id }: { id: string }) => this.#taskView(this.#repository.getTask(id)),
      sources: ({ first, after }: { first: number; after?: string }) => this.#sourcePage(first, after),
      vscodeLearningCurriculum: () => unavailable("learning curriculum"),
      vscodeHeldSources: () => unavailable("held-source review"),
      vscodeWorkspaceStatus: () => unavailable("workspace ledger"),
      vscodeSettings: () => unavailable("runtime settings"),
      vscodeModels: () => unavailable("local visual models"),
      vscodeCodeValidationPolicies: () => unavailable("code validation"),
      vscodeReviewHeldSource: () => { throw new Error("Held-source review is unavailable in the portable browser slice"); },
      learnSource: async ({ input }: { input: {
        operationId: string; namespace: string; canonicalUri: string; mediaType: string; bytesBase64: string;
        title?: string; observedAt?: number; clientMutationId?: string;
      } }, context: GraphqlContext) => {
        context.signal.throwIfAborted();
        const learned = await this.#sourceLearning.learn({
          operationId: input.operationId,
          namespace: input.namespace,
          canonicalUri: input.canonicalUri,
          mediaType: input.mediaType,
          sourceBytes: strictBase64(input.bytesBase64),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.observedAt === undefined ? {} : { observedAt: input.observedAt })
        });
        context.signal.throwIfAborted();
        return {
          source: {
            __typename: "SourceVersion",
            ...learned.source,
            id: learned.source.sourceVersionId,
            maxAlpha: 1,
            promotedSpanCount: 1
          },
          evidenceId: learned.evidenceId,
          languageProfileId: learned.languageProfileId,
          clientMutationId: input.clientMutationId ?? null
        };
      },
      reserveTurn: ({ input }: { input: { clientMutationId?: string } }, context: GraphqlContext) => {
        context.signal.throwIfAborted();
        const now = Date.now();
        const task: BrowserTaskRecord = {
          id: taskId(), status: "reserved", createdAt: now, updatedAt: now, latestSequence: 0
        };
        this.#repository.putTask(task);
        return { task: this.#taskView(task), clientMutationId: input.clientMutationId ?? null };
      },
      startTurn: async ({ input }: { input: { operationId: string; text: string; clientMutationId?: string } }, context: GraphqlContext) => {
        validateTaskId(input.operationId);
        if (!input.text.trim() || input.text.length > 20_000) throw new Error("Turn text must contain between 1 and 20000 characters");
        context.signal.throwIfAborted();
        const existing = this.#repository.getTask(input.operationId);
        if (existing?.requestText !== undefined && existing.requestText !== input.text) {
          throw new Error("operationId was already used with a different turn payload");
        }
        if (existing && TERMINAL.has(existing.status)) {
          return { task: this.#taskView(existing), clientMutationId: input.clientMutationId ?? null };
        }
        const now = Date.now();
        const started: BrowserTaskRecord = {
          ...(existing ?? { id: input.operationId, createdAt: now }),
          status: "running",
          updatedAt: now,
          latestSequence: Math.max(existing?.latestSequence ?? 0, 0) + 1,
          requestText: input.text
        };
        this.#repository.putTask(started);
        this.#repository.putFrame({
          id: `${started.id}:${started.latestSequence}`,
          taskId: started.id,
          sequence: started.latestSequence,
          kind: "progress",
          phase: "evidence-retrieval",
          observedAt: now
        });
        this.#notify(started);
        await Promise.resolve();
        context.signal.throwIfAborted();
        const answer = this.#cognitive.answer({ requestText: input.text, sources: this.#repository.loadSources() });
        context.signal.throwIfAborted();
        const completedAt = Date.now();
        const success = answer.status === "resolved";
        const error = success ? undefined : "No exact promoted source evidence supports this request in browser state.";
        const result = {
          id: `${started.id}:result`,
          answer: success ? answer.answer : null,
          error: error ?? null,
          httpStatus: success ? 200 : 422,
          episodeId: null,
          value: { portableKernelSlice: true, languageProfiles: this.#repository.loadSources().map(source => source.languageProfile.id) },
          proofCarryingAnswer: answer.proof,
          evidence: answer.proofExcerpts.map(excerpt => ({
            id: excerpt.evidenceId,
            sourceId: this.#repository.loadSources().find(source => String(source.evidence.id) === excerpt.evidenceId)?.source.sourceId ?? null,
            textPreview: excerpt.text,
            provenance: { exact: true }
          })),
          guardFlags: { sourceBacked: success }
        };
        const completed: BrowserTaskRecord = {
          ...started,
          status: success ? "succeeded" : "failed",
          updatedAt: completedAt,
          latestSequence: started.latestSequence + 1,
          result,
          ...(error ? { error } : {})
        };
        this.#repository.putTask(completed);
        this.#repository.putFrame({
          id: `${completed.id}:${completed.latestSequence}`,
          taskId: completed.id,
          sequence: completed.latestSequence,
          kind: success ? "result" : "error",
          phase: "complete",
          ...(success ? { answer: answer.answer } : { error }),
          observedAt: completedAt
        });
        this.#notify(completed);
        return { task: this.#taskView(completed), clientMutationId: input.clientMutationId ?? null };
      },
      cancelTurn: ({ input }: { input: { taskId: string; clientMutationId?: string } }, context: GraphqlContext) => {
        context.signal.throwIfAborted();
        const existing = this.#repository.getTask(input.taskId);
        if (!existing) throw new Error("Turn task does not exist");
        if (TERMINAL.has(existing.status)) return { task: this.#taskView(existing), clientMutationId: input.clientMutationId ?? null };
        const now = Date.now();
        const cancelled: BrowserTaskRecord = {
          ...existing, status: "cancelled", updatedAt: now, latestSequence: existing.latestSequence + 1
        };
        this.#repository.putTask(cancelled);
        this.#repository.putFrame({
          id: `${cancelled.id}:${cancelled.latestSequence}`,
          taskId: cancelled.id,
          sequence: cancelled.latestSequence,
          kind: "cancelled",
          phase: "cancelled",
          observedAt: now
        });
        this.#notify(cancelled);
        return { task: this.#taskView(cancelled), clientMutationId: input.clientMutationId ?? null };
      },
      turnTaskUpdated: ({ id, afterSequence }: { id: string; afterSequence: number }, context: GraphqlContext) =>
        this.#taskEvents(id, afterSequence, context.signal)
    };
  }

  #taskView(task: BrowserTaskRecord | undefined): Record<string, unknown> | null {
    if (!task) return null;
    const frames = this.#repository.listFrames(task.id, 0, 100);
    const latestFrame = frames.at(-1);
    return {
      __typename: "TurnTask",
      id: task.id,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      latestSequence: task.latestSequence,
      persistence: "durable",
      latestFrame: latestFrame ? this.#frameView(latestFrame) : null,
      frames: ({ first, after }: { first: number; after?: string }) => {
        const afterSequence = decodeFrameCursor(after);
        const selected = this.#repository.listFrames(task.id, afterSequence, first + 1);
        const visible = selected.slice(0, first);
        return {
          edges: visible.map(frame => ({ cursor: encodeFrameCursor(frame.sequence), node: this.#frameView(frame) })),
          pageInfo: pageInfo(visible.map(frame => encodeFrameCursor(frame.sequence)), selected.length > first)
        };
      },
      result: task.result ?? null
    };
  }

  #frameView(frame: BrowserTaskFrame): Record<string, unknown> {
    return { __typename: "TurnFrame", ...frame };
  }

  #sourcePage(first: number, after?: string): Record<string, unknown> {
    if (!Number.isInteger(first) || first < 1 || first > 50) throw new Error("Source page size must be between 1 and 50");
    const sources = this.#repository.loadSources();
    const start = after ? sources.findIndex(source => String(source.source.sourceVersionId) === after) + 1 : 0;
    const selected = sources.slice(Math.max(0, start), Math.max(0, start) + first + 1);
    const visible = selected.slice(0, first);
    const cursors = visible.map(source => String(source.source.sourceVersionId));
    return {
      edges: visible.map(source => ({
        cursor: String(source.source.sourceVersionId),
        node: {
          __typename: "SourceVersion",
          ...source.source,
          id: source.source.sourceVersionId,
          maxAlpha: source.evidence.alpha,
          promotedSpanCount: source.evidence.status === "promoted" ? 1 : 0
        }
      })),
      pageInfo: pageInfo(cursors, selected.length > first)
    };
  }

  async *#taskEvents(id: string, afterSequence: number, signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    let cursor = afterSequence;
    for (;;) {
      signal.throwIfAborted();
      const current = this.#repository.getTask(id);
      if (!current) throw new Error("Turn task does not exist");
      if (current.latestSequence > cursor) {
        cursor = current.latestSequence;
        yield { turnTaskUpdated: this.#taskView(current) };
      }
      if (TERMINAL.has(current.status)) return;
      const next = await this.#waitForTask(id, cursor, signal);
      cursor = Math.max(cursor, next.latestSequence - 1);
    }
  }

  #waitForTask(id: string, afterSequence: number, signal: AbortSignal): Promise<BrowserTaskRecord> {
    return new Promise((resolve, reject) => {
      const waiters = this.#waiters.get(id) ?? new Set<TaskWaiter>();
      const waiter: TaskWaiter = {
        afterSequence,
        resolve(task) { cleanup(); resolve(task); }
      };
      const onAbort = () => { cleanup(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        waiters.delete(waiter);
        if (!waiters.size) this.#waiters.delete(id);
      };
      waiters.add(waiter);
      this.#waiters.set(id, waiters);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  #notify(task: BrowserTaskRecord): void {
    const waiters = this.#waiters.get(task.id);
    if (!waiters) return;
    for (const waiter of [...waiters]) if (task.latestSequence > waiter.afterSequence) waiter.resolve(task);
  }
}

function register(request: ConcreteRequest): [string, DocumentNode] {
  const name = request.params.name;
  const text = request.params.text;
  if (!text) throw new Error(`Registered Relay operation ${name} has no persisted document text`);
  return [name, parse(text)];
}

function taskId(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return `task_${[...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

function validateTaskId(value: string): void {
  if (!/^[A-Za-z0-9_-]{20,2048}$/u.test(value)) throw new Error("Invalid turn operationId");
}

function encodeFrameCursor(sequence: number): string {
  return `frame:${sequence}`;
}

function decodeFrameCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = /^frame:(\d+)$/u.exec(cursor);
  if (!match) throw new Error("Invalid frame cursor");
  return Number(match[1]);
}

function pageInfo(cursors: string[], hasNextPage: boolean): Record<string, unknown> {
  return {
    hasNextPage,
    hasPreviousPage: false,
    startCursor: cursors[0] ?? null,
    endCursor: cursors.at(-1) ?? null
  };
}

function unavailable(capability: string): { value: Record<string, unknown> } {
  return { value: { status: "unavailable", capability, runtime: "browser-opfs", reason: "not in the qualified portable kernel slice" } };
}

function strictBase64(value: string): Uint8Array {
  if (typeof value !== "string" || value.length < 4 || value.length > 12 * 1024 * 1024
    || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("source bytesBase64 is not canonical base64");
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  let canonical = "";
  for (const byte of bytes) canonical += String.fromCharCode(byte);
  if (btoa(canonical) !== value) throw new Error("source bytesBase64 is not canonical base64");
  return bytes;
}
