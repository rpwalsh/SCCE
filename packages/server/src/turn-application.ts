// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash, randomUUID } from "node:crypto";
import type { JsonValue, RequestedAuthority } from "@scce/kernel";
import { TurnTaskRegistry, type TurnTaskSnapshot } from "./turn-task-registry.js";

export interface ApplicationTurnInput {
  text: string;
  operationId?: string;
  sessionId?: string;
  conversationId?: string;
  requestedAuthority?: RequestedAuthority;
}

export interface TurnApplicationPorts {
  registry: TurnTaskRegistry;
  scope: string;
  execute(input: ApplicationTurnInput, control: { signal: AbortSignal; onProgress: (progress: {
    phase: string; observedAtMonotonicMs: number; answer?: string; assistantForce?: string; cognition?: JsonValue;
  }) => void }): Promise<{ status: number; value: JsonValue }>;
}

export class ApplicationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** One coordinator per local runtime. The existing event ledger remains authoritative. */
export class TurnApplication {
  readonly #ports: TurnApplicationPorts;
  readonly #reservations = new Set<string>();
  #active = 0;
  constructor(ports: TurnApplicationPorts) { this.#ports = ports; }

  async reserve(): Promise<TurnTaskSnapshot> {
    if (this.#active >= 4) throw new ApplicationError("RESOURCE_LIMIT", "four turns are already active");
    if (this.#reservations.size >= 128) throw new ApplicationError("RESOURCE_LIMIT", "cancel or start an existing reserved turn first");
    const task = this.#ports.registry.create({ requestId: randomUUID(), cognition: {
      schema: "scce.local_operation.v1", scope: this.#ports.scope
    } });
    this.#reservations.add(task.taskId);
    return this.#durable(task.taskId);
  }

  async get(taskId: string): Promise<TurnTaskSnapshot | undefined> {
    await this.#ports.registry.drain(taskId);
    const task = await this.#ports.registry.get(taskId);
    if (!task) return undefined;
    const identity = task.frames[0]?.cognition as Record<string, JsonValue> | undefined;
    if (identity?.schema !== "scce.local_operation.v1" || identity.scope !== this.#ports.scope) return undefined;
    if (task.persistence !== "durable") throw new ApplicationError("PERSISTENCE_FAILED", "task event was not committed");
    return task;
  }

  async start(taskId: string, input: ApplicationTurnInput): Promise<TurnTaskSnapshot> {
    validateInput(input);
    input = Object.freeze({ text: input.text, operationId: taskId,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
      ...(input.requestedAuthority === undefined ? {} : { requestedAuthority: input.requestedAuthority }) });
    const task = await this.get(taskId);
    if (!task) throw new ApplicationError("NOT_FOUND", "unknown local turn operation");
    const digest = createHash("sha256").update(JSON.stringify([
      input.text, input.sessionId ?? null, input.conversationId ?? null, input.requestedAuthority ?? null
    ])).digest("hex");
    const persisted = task.frames.find(frame => frame.phase === "application.turn.claimed")?.cognition as Record<string, JsonValue> | undefined;
    const previous = persisted?.inputDigest;
    if (previous !== undefined) {
      if (previous !== digest) throw new ApplicationError("CONFLICT", "operation was already bound to another request");
      return this.#durable(taskId);
    }
    if (task.status !== "accepted") throw new ApplicationError("CONFLICT", `operation is ${task.status}`);
    if (this.#active >= 4) throw new ApplicationError("RESOURCE_LIMIT", "four turns are already active");
    // No await between checking and claiming: concurrent retries share this single coordinator.
    if (!this.#ports.registry.claim(taskId, digest)) return this.start(taskId, input);
    this.#reservations.delete(taskId);
    this.#active++;
    try {
      const claimed = await this.#durable(taskId);
      // Durable intent precedes execution. A crash after intent requires reconciliation, never replay.
      if (claimed.status === "cancelled") { this.#active--; return claimed; }
      void this.#run(taskId, input);
      return claimed;
    } catch (error) { this.#active--; throw error; }
  }

  async cancel(taskId: string): Promise<TurnTaskSnapshot> {
    // Cancellation must still reach the running computation if persistence
    // failed. Only publishing its durable receipt depends on a successful write.
    const task = await this.#ports.registry.get(taskId);
    const identity = task?.frames[0]?.cognition as Record<string, JsonValue> | undefined;
    if (identity?.schema !== "scce.local_operation.v1" || identity.scope !== this.#ports.scope) {
      throw new ApplicationError("NOT_FOUND", "unknown local turn operation");
    }
    this.#ports.registry.cancel(taskId);
    this.#reservations.delete(taskId);
    return this.#durable(taskId);
  }

  /** Durable replay, then live updates. Closing an iterator never cancels its task. */
  async *updates(taskId: string, afterSequence: number, signal: AbortSignal): AsyncGenerator<TurnTaskSnapshot> {
    let sequence = afterSequence;
    while (!signal.aborted) {
      const task = await this.#durable(taskId);
      if (sequence > task.latestSequence) throw new ApplicationError("INVALID_CURSOR", "sequence is ahead of this task");
      if (task.latestSequence > sequence || terminal(task.status)) {
        yield { ...task, frames: task.frames.filter(frame => frame.sequence > sequence).slice(0, 50) };
        sequence = Math.min(task.latestSequence, sequence + 50);
      }
      if (terminal(task.status) && sequence >= task.latestSequence) return;
      if (sequence < task.latestSequence) continue;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 250);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
  }

  async #durable(taskId: string): Promise<TurnTaskSnapshot> {
    await this.#ports.registry.drain(taskId);
    const task = await this.get(taskId);
    if (!task) throw new ApplicationError("NOT_FOUND", "unknown local turn operation");
    if (task.persistence !== "durable") throw new ApplicationError("PERSISTENCE_FAILED", "task event was not committed");
    return task;
  }

  async #run(taskId: string, input: ApplicationTurnInput): Promise<void> {
    const registry = this.#ports.registry;
    const controller = registry.controller(taskId)!;
    let progressCount = 0;
    try {
      const result = await this.#ports.execute(input, {
        signal: controller.signal,
        onProgress(progress) {
          if (++progressCount > 1024) {
            controller.abort(new ApplicationError("RESOURCE_LIMIT", "turn progress budget exceeded"));
            throw new ApplicationError("RESOURCE_LIMIT", "turn progress budget exceeded");
          }
          registry.append(taskId, { type: "progress", phase: progress.phase,
            ...(progress.answer === undefined ? {} : { answer: progress.answer, assistantForce: progress.assistantForce }),
            ...(progress.cognition === undefined ? {} : { cognition: progress.cognition }) });
        }
      });
      registry.append(taskId, { type: result.status >= 200 && result.status < 300 ? "result" : "error",
        status: result.status, value: result.value });
    } catch (error) {
      const typed = error && typeof error === "object" ? error as { status?: number; detail?: JsonValue } : {};
      registry.append(taskId, { type: "error", status: typed.status ?? 500,
        error: error instanceof Error ? error.message : String(error),
        ...(typed.detail === undefined ? {} : { detail: typed.detail }) });
    } finally {
      await registry.drain(taskId);
      this.#active--;
    }
  }
}

function terminal(status: TurnTaskSnapshot["status"]): boolean {
  return ["succeeded", "failed", "cancelled", "interrupted"].includes(status);
}

function validateInput(input: ApplicationTurnInput): void {
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 20_000) {
    throw new ApplicationError("BAD_INPUT", "turn text must contain between 1 and 20000 characters");
  }
  for (const value of [input.sessionId, input.conversationId]) {
    if (value !== undefined && (typeof value !== "string" || !value.trim() || value.length > 256)) {
      throw new ApplicationError("BAD_INPUT", "conversation identifiers must contain between 1 and 256 characters");
    }
  }
  if (input.requestedAuthority !== undefined && !["factual", "reasoned", "creative", "translation", "program", "action"].includes(input.requestedAuthority)) {
    throw new ApplicationError("BAD_INPUT", "invalid requested authority");
  }
}
