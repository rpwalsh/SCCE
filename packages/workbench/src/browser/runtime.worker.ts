/// <reference lib="webworker" />
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import { canonicalStringify, createHasher } from "@scce/kernel/dist/primitives.js";
import type { ExecutionResult } from "graphql";
import type { GraphQLResponse } from "relay-runtime";
import { BrowserGraphqlApplication, browserGraphqlProtocolVersion } from "./graphql-application.js";
import {
  assertWorkerRequest,
  browserWorkerLimits,
  browserWorkerProtocolVersion,
  encodedBytes,
  type BrowserWorkerRequest,
  type BrowserWorkerResponse
} from "./protocol.js";
import { openBrowserStateRepository, type BrowserStateRepository } from "./sqlite-opfs.js";

const worker = self as unknown as DedicatedWorkerGlobalScope;
const hasher = createHasher();
const active = new Map<string, AbortController>();
const flowWindows = new Map<string, FlowWindow>();
let repository: BrowserStateRepository | undefined;
let application: BrowserGraphqlApplication | undefined;

const ready = openBrowserStateRepository().then(value => {
  repository = value;
  application = new BrowserGraphqlApplication(value);
  return value;
});

worker.addEventListener("message", event => {
  void dispatch(event.data).catch(error => {
    const requestId = requestIdFrom(event.data);
    void postError(requestId, "INTERNAL", message(error));
  });
});

worker.addEventListener("close", () => { void repository?.close(); });

async function dispatch(value: unknown): Promise<void> {
  let request: BrowserWorkerRequest;
  try {
    assertWorkerRequest(value);
    request = value;
  } catch (error) {
    await postError(requestIdFrom(value), "BAD_REQUEST", message(error));
    return;
  }
  let state: BrowserStateRepository;
  try {
    state = await ready;
  } catch (error) {
    await postError(request.requestId, "STORAGE_UNAVAILABLE", message(error), "browser-opfs:unavailable");
    return;
  }
  if (request.epoch !== undefined && request.epoch !== state.epoch) {
    await postError(request.requestId, "STALE_EPOCH", "Browser runtime changed. Reconnect before continuing.", state.epoch);
    return;
  }
  if (request.kind === "ack") {
    flowWindows.get(request.targetRequestId)?.acknowledge(request.sequence);
    return;
  }
  if (request.kind === "cancel") {
    active.get(request.targetRequestId)?.abort(new DOMException("Cancelled", "AbortError"));
    flowWindows.get(request.targetRequestId)?.close();
    await post({ requestId: request.requestId, sequence: 1, kind: "complete", durable: true }, state.epoch);
    return;
  }
  if (active.size >= browserWorkerLimits.activeRequests) {
    await postError(request.requestId, "BACKPRESSURE", "Browser worker request queue is full.", state.epoch);
    return;
  }
  if (active.has(request.requestId)) {
    await postError(request.requestId, "DUPLICATE_ACTIVE_REQUEST", "A request with this id is already active.", state.epoch);
    return;
  }
  const app = application!;
  if (!app.isRegistered(request.operationName)) {
    await postError(request.requestId, "UNREGISTERED_OPERATION", `Unregistered GraphQL operation: ${request.operationName}`, state.epoch);
    return;
  }
  const controller = new AbortController();
  active.set(request.requestId, controller);
  try {
    if (request.kind === "execute") await executeRequest(request, controller.signal, state, app);
    else await subscribeRequest(request, controller.signal, state, app);
  } catch (error) {
    if (controller.signal.aborted) await postError(request.requestId, "CANCELLED", "Browser request was cancelled.", state.epoch);
    else await postError(request.requestId, "EXECUTION_FAILED", message(error), state.epoch);
  } finally {
    active.delete(request.requestId);
    flowWindows.get(request.requestId)?.close();
    flowWindows.delete(request.requestId);
  }
}

async function executeRequest(
  request: Extract<BrowserWorkerRequest, { kind: "execute" }>,
  signal: AbortSignal,
  state: BrowserStateRepository,
  app: BrowserGraphqlApplication
): Promise<void> {
  const payloadDigest = hasher.digestHex(canonicalStringify({
    kind: request.kind,
    operationName: request.operationName,
    variables: request.variables
  }));
  const prior = state.getReceipt(request.requestId);
  if (prior) {
    if (prior.payloadDigest !== payloadDigest) throw new Error("requestId was already used with a different operation payload");
    await postGraphql(request.requestId, "result", refreshGeneration(prior.response as ExecutionResult, request.operationName, state.epoch), 1, state.epoch);
    return;
  }
  const result = await app.execute(request.operationName, request.variables, signal);
  signal.throwIfAborted();
  state.putReceipt({ requestId: request.requestId, payloadDigest, response: result });
  await postGraphql(request.requestId, "result", result, 1, state.epoch);
}

async function subscribeRequest(
  request: Extract<BrowserWorkerRequest, { kind: "subscribe" }>,
  signal: AbortSignal,
  state: BrowserStateRepository,
  app: BrowserGraphqlApplication
): Promise<void> {
  const result = await app.subscribe(request.operationName, request.variables, signal);
  if (!isAsyncIterable(result)) {
    await postGraphql(request.requestId, "result", result, 1, state.epoch);
    return;
  }
  const window = new FlowWindow(browserWorkerLimits.unacknowledgedSubscriptionFrames);
  flowWindows.set(request.requestId, window);
  let sequence = 0;
  for await (const event of result) {
    signal.throwIfAborted();
    sequence += 1;
    await window.beforeSend(sequence, signal);
    await postGraphql(request.requestId, "event", event, sequence, state.epoch);
  }
  await post({ requestId: request.requestId, sequence: sequence + 1, kind: "complete", durable: true }, state.epoch);
}

async function postGraphql(requestId: string, kind: "result" | "event", result: ExecutionResult, sequence: number, epoch: string): Promise<void> {
  const payload = {
    ...result,
    extensions: {
      ...result.extensions,
      protocolVersion: browserGraphqlProtocolVersion,
      generation: epoch
    }
  };
  await post({ requestId, sequence, kind, payload: payload as unknown as GraphQLResponse, durable: true }, epoch);
}

async function post(response: Omit<BrowserWorkerResponse, "protocolVersion" | "epoch">, epoch: string): Promise<void> {
  const envelope: BrowserWorkerResponse = { protocolVersion: browserWorkerProtocolVersion, epoch, ...response };
  if (encodedBytes(envelope) > browserWorkerLimits.frameBytes) throw new Error("Browser worker response exceeds its byte budget");
  worker.postMessage(envelope);
}

async function postError(requestId: string, code: string, errorMessage: string, epoch = repository?.epoch ?? "browser-opfs:initializing"): Promise<void> {
  await post({ requestId, sequence: 1, kind: "error", error: { code, message: errorMessage }, durable: true }, epoch);
}

function refreshGeneration(result: ExecutionResult, operationName: string, epoch: string): ExecutionResult {
  if (operationName !== "WorkbenchRuntimeQuery" || !result.data?.runtime || typeof result.data.runtime !== "object") return result;
  return { ...result, data: { ...result.data, runtime: { ...result.data.runtime, generation: epoch } } };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<ExecutionResult> {
  return Boolean(value && typeof value === "object" && Symbol.asyncIterator in value);
}

function requestIdFrom(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { requestId?: unknown }).requestId === "string") {
    return (value as { requestId: string }).requestId.slice(0, 128);
  }
  return "invalid-request";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class FlowWindow {
  readonly #limit: number;
  readonly #outstanding = new Set<number>();
  readonly #waiters = new Set<() => void>();
  #closed = false;

  constructor(limit: number) { this.#limit = limit; }

  async beforeSend(sequence: number, signal: AbortSignal): Promise<void> {
    while (!this.#closed && this.#outstanding.size >= this.#limit) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
        const cleanup = () => { this.#waiters.delete(wake); signal.removeEventListener("abort", abort); };
        this.#waiters.add(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (this.#closed) throw new DOMException("Closed", "AbortError");
    this.#outstanding.add(sequence);
  }

  acknowledge(sequence: number): void {
    for (const outstanding of [...this.#outstanding]) if (outstanding <= sequence) this.#outstanding.delete(outstanding);
    for (const wake of [...this.#waiters]) wake();
  }

  close(): void {
    this.#closed = true;
    this.#outstanding.clear();
    for (const wake of [...this.#waiters]) wake();
  }
}
