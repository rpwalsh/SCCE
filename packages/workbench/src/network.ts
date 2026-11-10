// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { Environment, Network, Observable, RecordSource, Store,
  type GraphQLResponse, type RequestParameters, type Variables } from "relay-runtime";

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
