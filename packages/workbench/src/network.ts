// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { Environment, Network, Observable, RecordSource, Store,
  type GraphQLResponse, type RequestParameters, type Variables } from "relay-runtime";
import {
  browserWorkerLimits,
  browserWorkerProtocolVersion,
  encodedBytes,
  type BrowserWorkerRequest,
  type BrowserWorkerResponse
} from "./browser/protocol";

const protocolVersion = "scce.graphql.v1";
export interface LocalConnection { endpoint: string; token?: string; fetch?: typeof fetch }
export function createLocalEnvironment(connection: LocalConnection) {
  const endpoint = new URL(connection.endpoint);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.pathname !== "/api/graphql" || endpoint.search || endpoint.hash) {
    throw new Error("Connect to the local SCCE host at http://127.0.0.1:3873/api/graphql");
  }
  const fetcher = connection.fetch ?? fetch;
  let generation: string | undefined;
  let active = 0;
  const controllers = new Set<AbortController>();
  const headers = { "content-type": "application/json", ...(connection.token ? { authorization: `Bearer ${connection.token}` } : {}) };
  function body(operation: RequestParameters, variables: Variables) {
    return JSON.stringify({ protocolVersion, operationName: operation.name, variables, ...(generation ? { generation } : {}) });
  }
  function decode(value: unknown, expectedGeneration: string | undefined): GraphQLResponse {
    const result = value as { extensions?: { protocolVersion?: string; generation?: string }; errors?: unknown[]; data?: unknown };
    if (!result || typeof result !== "object" || result.extensions?.protocolVersion !== protocolVersion
      || typeof result.extensions.generation !== "string"
      || (expectedGeneration !== undefined && result.extensions.generation !== expectedGeneration)) {
      throw new Error("Local runtime changed. Reconnect before continuing.");
    }
    generation = result.extensions.generation;
    return result as GraphQLResponse;
  }
  function request(operation: RequestParameters, variables: Variables): Observable<GraphQLResponse> {
    return Observable.create(sink => {
      if (active >= 8) { sink.error(new Error("Local request queue is full")); return; }
      active++;
      const controller = new AbortController();
      controllers.add(controller);
      const expected = generation;
      const timer = setTimeout(() => controller.abort(new Error("Local request timed out")), 20_000);
      void (async () => {
        const response = await fetcher(endpoint, { method: "POST", headers,
          body: body(operation, variables), signal: controller.signal, credentials: "omit", redirect: "error" });
        const text = await boundedText(response, 1024 * 1024);
        if (!text) throw new Error(`Local host returned HTTP ${response.status}`);
        const value = decode(JSON.parse(text), expected);
        sink.next(value);
        sink.complete();
      })().catch(error => { if (!controller.signal.aborted) sink.error(error instanceof Error ? error : new Error(String(error))); else if (!sink.closed) sink.error(new Error("Local request interrupted")); })
        .finally(() => { clearTimeout(timer); controllers.delete(controller); active--; });
      return () => { clearTimeout(timer); controller.abort(); };
    });
  }
  function subscription(operation: RequestParameters, variables: Variables): Observable<GraphQLResponse> {
    return Observable.create(sink => {
      if (active >= 8) { sink.error(new Error("Local request queue is full")); return; }
      active++;
      const controller = new AbortController();
      controllers.add(controller);
      const expected = generation;
      void (async () => {
        const response = await fetcher(endpoint, { method: "POST", headers: { ...headers, accept: "text/event-stream" },
          body: body(operation, variables), signal: controller.signal, credentials: "omit", redirect: "error" });
        if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
          throw new Error(`Local subscription returned HTTP ${response.status}`);
        }
        for await (const event of readEvents(response)) {
          if (event.event === "complete") { sink.complete(); return; }
          if (event.event !== "next") throw new Error("Unknown local subscription event");
          sink.next(decode(JSON.parse(event.data), expected));
        }
        sink.complete();
      })().catch(error => { if (!controller.signal.aborted) sink.error(error instanceof Error ? error : new Error(String(error))); })
        .finally(() => { controllers.delete(controller); active--; });
      return () => controller.abort();
    });
  }
  return {
    environment: new Environment({ network: Network.create(request, subscription),
      store: new Store(new RecordSource(), { gcReleaseBufferSize: 4 }) }),
    close() { for (const controller of controllers) controller.abort(); }
  };
}

export interface BrowserConnection { worker?: Worker }

/** Relay network backed only by SCCE's dedicated browser worker. It has no HTTP fallback. */
export function createBrowserEnvironment(connection: BrowserConnection = {}) {
  const worker = connection.worker ?? new Worker(new URL("./browser/runtime.worker.ts", import.meta.url), {
    type: "module",
    name: "scce-browser-runtime"
  });
  let epoch: string | undefined;
  let closed = false;
  const pending = new Map<string, {
    sink: { next(value: GraphQLResponse): void; error(error: Error): void; complete(): void; readonly closed: boolean };
    kind: "execute" | "subscribe";
    lastSequence: number;
    timer?: ReturnType<typeof setTimeout>;
  }>();

  worker.addEventListener("message", event => {
    const response = event.data as Partial<BrowserWorkerResponse>;
    if (!response || response.protocolVersion !== browserWorkerProtocolVersion
      || typeof response.requestId !== "string" || typeof response.epoch !== "string"
      || !Number.isSafeInteger(response.sequence) || response.sequence! < 1) return;
    const request = pending.get(response.requestId);
    if (!request) return;
    if (epoch !== undefined && response.epoch !== epoch) {
      finish(response.requestId, new Error("Browser runtime changed. Reconnect before continuing."));
      return;
    }
    epoch = response.epoch;
    if (response.sequence! <= request.lastSequence) {
      finish(response.requestId, new Error("Browser worker returned a duplicate or out-of-order frame."));
      return;
    }
    request.lastSequence = response.sequence!;
    if (response.kind === "error") {
      finish(response.requestId, new Error(response.error?.message ?? "Browser worker request failed"));
      return;
    }
    if (response.kind === "complete") {
      finish(response.requestId);
      return;
    }
    if ((response.kind !== "result" && response.kind !== "event") || !response.payload) {
      finish(response.requestId, new Error("Invalid browser worker response envelope."));
      return;
    }
    if (encodedBytes(response) > browserWorkerLimits.frameBytes) {
      finish(response.requestId, new Error("Browser worker response exceeds its byte budget."));
      return;
    }
    const payload = response.payload as GraphQLResponse & { extensions?: { protocolVersion?: string; generation?: string } };
    if (payload.extensions?.protocolVersion !== protocolVersion || payload.extensions.generation !== response.epoch) {
      finish(response.requestId, new Error("Browser worker GraphQL protocol mismatch."));
      return;
    }
    request.sink.next(payload);
    if (response.kind === "event") {
      post({
        protocolVersion: browserWorkerProtocolVersion,
        requestId: newRequestId("ack"),
        kind: "ack",
        epoch: response.epoch,
        targetRequestId: response.requestId,
        sequence: response.sequence!
      });
    } else {
      finish(response.requestId);
    }
  });
  worker.addEventListener("error", event => {
    const error = new Error(event.message || "SCCE browser worker failed");
    for (const id of [...pending.keys()]) finish(id, error);
  });

  function post(request: BrowserWorkerRequest): void {
    if (closed) throw new Error("Browser runtime is closed");
    worker.postMessage(request);
  }

  function finish(requestId: string, error?: Error): void {
    const request = pending.get(requestId);
    if (!request) return;
    pending.delete(requestId);
    if (request.timer) clearTimeout(request.timer);
    if (error) request.sink.error(error);
    else request.sink.complete();
  }

  function network(kind: "execute" | "subscribe", operation: RequestParameters, variables: Variables): Observable<GraphQLResponse> {
    return Observable.create(sink => {
      if (closed) { sink.error(new Error("Browser runtime is closed")); return; }
      if (pending.size >= browserWorkerLimits.activeRequests) { sink.error(new Error("Browser request queue is full")); return; }
      if (encodedBytes(variables) > browserWorkerLimits.variablesBytes) { sink.error(new Error("GraphQL variables exceed the browser worker byte budget")); return; }
      const requestId = newRequestId(kind);
      const entry = { sink, kind, lastSequence: 0, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      if (kind === "execute") entry.timer = setTimeout(() => {
        try { post({ protocolVersion: browserWorkerProtocolVersion, requestId: newRequestId("cancel"), kind: "cancel", epoch, targetRequestId: requestId }); } catch { /* closed */ }
        finish(requestId, new Error("Browser request timed out"));
      }, browserWorkerLimits.requestTimeoutMs);
      pending.set(requestId, entry);
      post({
        protocolVersion: browserWorkerProtocolVersion,
        requestId,
        kind,
        ...(epoch ? { epoch } : {}),
        operationName: operation.name,
        variables
      });
      return () => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        if (entry.timer) clearTimeout(entry.timer);
        try { post({ protocolVersion: browserWorkerProtocolVersion, requestId: newRequestId("cancel"), kind: "cancel", epoch, targetRequestId: requestId }); } catch { /* closed */ }
      };
    });
  }

  return {
    environment: new Environment({
      network: Network.create(
        (operation, variables) => network("execute", operation, variables),
        (operation, variables) => network("subscribe", operation, variables)
      ),
      store: new Store(new RecordSource(), { gcReleaseBufferSize: 4 })
    }),
    close() {
      if (closed) return;
      closed = true;
      for (const id of [...pending.keys()]) finish(id, new Error("Browser runtime closed"));
      worker.terminate();
    }
  };
}

function newRequestId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) throw new Error("Local response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "", bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("Local response exceeds its byte budget");
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function* readEvents(response: Response): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) throw new Error("Local stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // One fixed byte buffer per subscription: parsing cannot grow a string or
  // repeatedly rescan a prefix when the network delivers one byte at a time.
  const frame = new Uint8Array(1024 * 1024);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { if (length) throw new Error("Truncated local stream frame"); return; }
      for (const byte of value) {
        if (length === frame.length) throw new Error("Local stream frame exceeds its byte budget");
        frame[length++] = byte;
        if (length < 2 || byte !== 10 || frame[length - 2] !== 10) continue;
        const record = decoder.decode(frame.subarray(0, length - 2));
        length = 0;
        const event = record.split("\n").find(line => line.startsWith("event: "))?.slice(7);
        const data = record.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
        if (!event || !data) throw new Error("Invalid local stream envelope");
        yield { event, data };
      }
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
