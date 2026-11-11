// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import type { GraphQLResponse, Variables } from "relay-runtime";

export const browserWorkerProtocolVersion = "scce.browser-worker.v1" as const;
export const browserWorkerLimits = Object.freeze({
  activeRequests: 8,
  variablesBytes: 64 * 1024,
  frameBytes: 1024 * 1024,
  unacknowledgedSubscriptionFrames: 8,
  requestTimeoutMs: 20_000
});

export type BrowserWorkerRequest =
  | {
    protocolVersion: typeof browserWorkerProtocolVersion;
    requestId: string;
    kind: "execute";
    epoch?: string;
    operationName: string;
    variables: Variables;
  }
  | {
    protocolVersion: typeof browserWorkerProtocolVersion;
    requestId: string;
    kind: "subscribe";
    epoch?: string;
    operationName: string;
    variables: Variables;
  }
  | {
    protocolVersion: typeof browserWorkerProtocolVersion;
    requestId: string;
    kind: "cancel";
    epoch?: string;
    targetRequestId: string;
  }
  | {
    protocolVersion: typeof browserWorkerProtocolVersion;
    requestId: string;
    kind: "ack";
    epoch: string;
    targetRequestId: string;
    sequence: number;
  };

export type BrowserWorkerResponse = {
  protocolVersion: typeof browserWorkerProtocolVersion;
  epoch: string;
  requestId: string;
  sequence: number;
  kind: "result" | "event" | "complete" | "error";
  payload?: GraphQLResponse;
  error?: { code: string; message: string };
  durable: true;
};

export function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function assertWorkerRequest(value: unknown): asserts value is BrowserWorkerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Worker request must be an object");
  const request = value as Partial<BrowserWorkerRequest> & Record<string, unknown>;
  if (request.protocolVersion !== browserWorkerProtocolVersion) throw new Error("Unsupported browser worker protocol version");
  if (typeof request.requestId !== "string" || !/^[A-Za-z0-9_-]{12,128}$/u.test(request.requestId)) throw new Error("Invalid browser worker request id");
  if (request.epoch !== undefined && (typeof request.epoch !== "string" || request.epoch.length > 128)) throw new Error("Invalid browser worker epoch");
  if (request.kind === "execute" || request.kind === "subscribe") {
    if (typeof request.operationName !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(request.operationName)) throw new Error("Invalid registered GraphQL operation name");
    if (!request.variables || typeof request.variables !== "object" || Array.isArray(request.variables)) throw new Error("GraphQL variables must be an object");
    if (encodedBytes(request.variables) > browserWorkerLimits.variablesBytes) throw new Error("GraphQL variables exceed the browser worker byte budget");
    return;
  }
  if (request.kind === "cancel") {
    if (typeof request.targetRequestId !== "string" || !/^[A-Za-z0-9_-]{12,128}$/u.test(request.targetRequestId)) throw new Error("Invalid cancellation target");
    return;
  }
  if (request.kind === "ack") {
    if (typeof request.targetRequestId !== "string" || !/^[A-Za-z0-9_-]{12,128}$/u.test(request.targetRequestId)) throw new Error("Invalid acknowledgement target");
    if (typeof request.sequence !== "number" || !Number.isSafeInteger(request.sequence) || request.sequence < 1) throw new Error("Invalid acknowledged sequence");
    return;
  }
  throw new Error("Unknown browser worker request kind");
}
