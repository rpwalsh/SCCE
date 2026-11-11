// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { fetchQuery } from "relay-runtime";
import runtimeQuery from "./__generated__/WorkbenchRuntimeQuery.graphql";
import type { WorkbenchRuntimeQuery } from "./__generated__/WorkbenchRuntimeQuery.graphql";
import { createBrowserEnvironment } from "./network";
import { browserWorkerProtocolVersion, type BrowserWorkerRequest, type BrowserWorkerResponse } from "./browser/protocol";

class FakeWorker {
  readonly sent: BrowserWorkerRequest[] = [];
  readonly #listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  terminated = false;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener as (event: MessageEvent) => void);
    this.#listeners.set(type, listeners);
  }
  postMessage(request: BrowserWorkerRequest): void {
    this.sent.push(request);
    if (request.kind !== "execute") return;
    queueMicrotask(() => this.emit({
      protocolVersion: browserWorkerProtocolVersion,
      epoch: "browser-opfs:7",
      requestId: request.requestId,
      sequence: 1,
      kind: "result",
      durable: true,
      payload: {
        data: { runtime: { protocolVersion: "scce.graphql.v1", generation: "browser-opfs:7", phase: "browser-opfs-ready", ready: true } },
        extensions: { protocolVersion: "scce.graphql.v1", generation: "browser-opfs:7" }
      }
    }));
  }
  terminate(): void { this.terminated = true; }
  emit(response: BrowserWorkerResponse): void {
    for (const listener of this.#listeners.get("message") ?? []) listener(new MessageEvent("message", { data: response }));
  }
}

describe("browser Relay network", () => {
  it("sends only registered operation identity and variables to the worker and carries the learned epoch", async () => {
    const worker = new FakeWorker();
    const local = createBrowserEnvironment({ worker: worker as unknown as Worker });
    const first = await fetchQuery<WorkbenchRuntimeQuery>(local.environment, runtimeQuery, {}, { fetchPolicy: "network-only" }).toPromise();
    expect(first?.runtime.phase).toBe("browser-opfs-ready");
    const request = worker.sent[0]!;
    expect(request).toMatchObject({ kind: "execute", operationName: "WorkbenchRuntimeQuery", variables: {} });
    expect(JSON.stringify(request)).not.toContain("query WorkbenchRuntimeQuery");
    await fetchQuery<WorkbenchRuntimeQuery>(local.environment, runtimeQuery, {}, { fetchPolicy: "network-only" }).toPromise();
    expect(worker.sent.filter(row => row.kind === "execute").at(-1)).toMatchObject({ epoch: "browser-opfs:7" });
    local.close();
    expect(worker.terminated).toBe(true);
  });

  it("cancels a disposed request without an HTTP fallback", () => {
    const worker = new FakeWorker();
    const local = createBrowserEnvironment({ worker: worker as unknown as Worker });
    const subscription = fetchQuery<WorkbenchRuntimeQuery>(local.environment, runtimeQuery, {}, { fetchPolicy: "network-only" }).subscribe({});
    subscription.unsubscribe();
    expect(worker.sent.map(row => row.kind)).toEqual(["execute", "cancel"]);
    local.close();
  });
});
