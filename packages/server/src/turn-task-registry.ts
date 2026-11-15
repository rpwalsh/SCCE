// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  createClock,
  createEventFactory,
  createHasher,
  createIdFactory,
  type EpisodeId,
  type JsonValue,
  type ScceEvent,
  type ScceStorage
} from "@scce/kernel";

export type TurnTaskStatus =
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface TurnTaskFrame {
  schema: "scce.turn_task_frame.v1";
  taskId: string;
  sequence: number;
  type: "accepted" | "progress" | "result" | "error" | "cancelled";
  observedAt: number;
  requestId?: string;
  phase?: string;
  status?: number;
  elapsedMs?: number;
  value?: JsonValue;
  error?: string;
  /** Typed runtime data behind a non-2xx frame -- a withheld-surface record, never an assistant surface. */
  detail?: JsonValue;
  persistence?: "pending" | "durable";
  /** Present only on the "answer.ready" progress frame -- see production-turn-runtime.ts. */
  answer?: string;
  assistantForce?: string;
  cognition?: JsonValue;
}

export interface TurnTaskSnapshot {
  schema: "scce.turn_task.v1";
  taskId: string;
  status: TurnTaskStatus;
  createdAt: number;
  updatedAt: number;
  latestSequence: number;
  persistence: "pending" | "durable";
  frames: readonly TurnTaskFrame[];
}

interface LiveTurnTask {
  taskId: string;
  episodeId: EpisodeId;
  status: TurnTaskStatus;
  createdAt: number;
  updatedAt: number;
  frames: TurnTaskFrame[];
  controller: AbortController;
  subscribers: Set<(frame: TurnTaskFrame) => void>;
  persistenceTail: Promise<void>;
  durableSequence: number;
  persistenceFailed: boolean;
  lastEvent?: ScceEvent;
}

const registries = new WeakMap<object, TurnTaskRegistry>();

export function turnTaskRegistryFor(storage: ScceStorage): TurnTaskRegistry {
  const cached = registries.get(storage);
  if (cached) return cached;
  const registry = new TurnTaskRegistry(storage);
  registries.set(storage, registry);
  return registry;
}

export class TurnTaskRegistry {
  readonly #storage: ScceStorage;
  readonly #tasks = new Map<string, LiveTurnTask>();
  readonly #eventFactory: ReturnType<typeof createEventFactory>;
  readonly #idFactory: ReturnType<typeof createIdFactory>;

  constructor(storage: ScceStorage) {
    this.#storage = storage;
    const clock = createClock();
    const hasher = createHasher();
    this.#idFactory = createIdFactory({
      clock,
      hasher,
      namespace: "scce.turn-task"
    });
    this.#eventFactory = createEventFactory({
      clock,
      hasher,
      idFactory: this.#idFactory
    });
  }

  create(input: { requestId: string; observedAt?: number; cognition?: JsonValue }): TurnTaskSnapshot {
    const episodeId = this.#idFactory.episodeId();
    const taskId = String(episodeId);
    const observedAt = input.observedAt ?? Date.now();
    const task: LiveTurnTask = {
      taskId,
      episodeId,
      status: "accepted",
      createdAt: observedAt,
      updatedAt: observedAt,
      frames: [],
      controller: new AbortController(),
      subscribers: new Set(),
      persistenceTail: Promise.resolve(),
      durableSequence: 0,
      persistenceFailed: false
    };
    this.#tasks.set(taskId, task);
    this.append(taskId, {
      type: "accepted",
      requestId: input.requestId,
      ...(input.cognition === undefined ? {} : { cognition: input.cognition }),
      persistence: "pending"
    });
    this.#evictCompleted();
    return snapshot(task);
  }

  controller(taskId: string): AbortController | undefined {
    return this.#tasks.get(taskId)?.controller;
  }

  markRunning(taskId: string): void {
    const task = this.#tasks.get(taskId);
    if (!task || terminal(task.status)) return;
    task.status = "running";
    task.updatedAt = Date.now();
  }

  /** Atomic within this local coordinator; only an unclaimed accepted task may start. */
  claim(taskId: string, inputDigest: string): boolean {
    const task = this.#tasks.get(taskId);
    if (!task || task.status !== "accepted") return false;
    this.append(taskId, { type: "progress", phase: "application.turn.claimed", cognition: { inputDigest } });
    return true;
  }

  /** A completed wait is the only replay-safe continuation boundary. This claim is local to the registry. */
  resume(taskId: string, inputDigest: string, approvalFrameSequence: number): boolean {
    const task = this.#tasks.get(taskId);
    const frame = task?.frames.at(-1);
    const original = task?.frames.find(row => row.phase === "application.turn.claimed")?.cognition;
    if (!task || task.persistenceFailed || task.durableSequence !== task.frames.length
      || frame?.sequence !== approvalFrameSequence || !isTurnTaskApprovalWait(frame)
      || !original || typeof original !== "object" || Array.isArray(original) || original.inputDigest !== inputDigest) return false;
    this.append(taskId, { type: "progress", phase: "application.turn.resumed", cognition: { inputDigest, approvalFrameSequence } });
    return true;
  }

  append(
    taskId: string,
    frame: Omit<TurnTaskFrame, "schema" | "taskId" | "sequence" | "observedAt">
  ): TurnTaskFrame {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error(`unknown turn task ${taskId}`);
    if (terminal(task.status)) return task.frames.at(-1)!;
    const frameJsonText = JSON.stringify({
      schema: "scce.turn_task_frame.v1",
      taskId,
      sequence: task.frames.length + 1,
      observedAt: Date.now(),
      ...frame
    } satisfies TurnTaskFrame);
    // Snapshot the JSON contract synchronously so caller-owned nested values
    // cannot change while this frame waits behind earlier ledger writes.
    const next = JSON.parse(frameJsonText) as TurnTaskFrame;
    task.frames.push(next);
    task.updatedAt = next.observedAt;
    if (isTurnTaskApprovalWait(next)) task.status = "running";
    else if (next.type === "result") task.status = "succeeded";
    else if (next.type === "error") task.status = "failed";
    else if (next.type === "cancelled") task.status = "cancelled";
    else if (task.status === "accepted" && next.type === "progress") task.status = "running";
    this.#persist(task, next, frameJsonText);
    return next;
  }

  subscribe(taskId: string, subscriber: (frame: TurnTaskFrame) => void): (() => void) | undefined {
    const task = this.#tasks.get(taskId);
    if (!task) return undefined;
    task.subscribers.add(subscriber);
    return () => task.subscribers.delete(subscriber);
  }

  async get(taskId: string): Promise<TurnTaskSnapshot | undefined> {
    const live = this.#tasks.get(taskId);
    if (live) return snapshot(live);
    const events = await this.#storage.events.readEpisode(taskId as EpisodeId);
    const frames = events
      .map(event => frameFromEvent(event))
      .filter((frame): frame is TurnTaskFrame => Boolean(frame))
      .sort((left, right) => left.sequence - right.sequence);
    if (!frames.length) return undefined;
    if (frames.some((frame, index) => frame.taskId !== taskId || frame.sequence !== index + 1)) {
      throw new Error("invalid persisted turn task frame sequence");
    }
    const last = frames.at(-1)!;
    const waiting = isTurnTaskApprovalWait(last);
    const status: TurnTaskStatus = waiting ? "running" : last.type === "result"
      ? "succeeded"
      : last.type === "error"
        ? "failed"
        : last.type === "cancelled"
          ? "cancelled"
          : "interrupted";
    if (waiting) {
      // A process may resume an explicitly completed approval wait, never an in-flight execution intent.
      // Recheck after the asynchronous read so simultaneous cold lookups cannot replace a claimed live task.
      const concurrent = this.#tasks.get(taskId);
      if (concurrent) return snapshot(concurrent);
      const lastEvent = events.find(event => frameFromEvent(event)?.sequence === last.sequence);
      this.#tasks.set(taskId, {
        taskId, episodeId: taskId as EpisodeId, status, createdAt: frames[0]!.observedAt, updatedAt: last.observedAt,
        frames, controller: new AbortController(), subscribers: new Set(), persistenceTail: Promise.resolve(),
        durableSequence: last.sequence, persistenceFailed: false, lastEvent
      });
    }
    return {
      schema: "scce.turn_task.v1",
      taskId,
      status,
      createdAt: frames[0]!.observedAt,
      updatedAt: last.observedAt,
      latestSequence: last.sequence,
      persistence: "durable",
      frames
    };
  }

  cancel(taskId: string, reason = "cancelled by user"): TurnTaskSnapshot | undefined {
    const task = this.#tasks.get(taskId);
    if (!task) return undefined;
    if (!terminal(task.status)) {
      task.controller.abort(new Error(reason));
      this.append(taskId, { type: "cancelled", error: reason });
    }
    return snapshot(task);
  }

  async drain(taskId: string): Promise<void> {
    await this.#tasks.get(taskId)?.persistenceTail;
  }

  #persist(task: LiveTurnTask, frame: TurnTaskFrame, frameJsonText: string): void {
    task.persistenceTail = task.persistenceTail
      .then(async () => {
        // A failed sequence fences every later frame. Committing a later
        // sequence would create a ledger gap that neither replay nor a
        // reconnecting subscriber could honestly interpret as durable.
        if (task.persistenceFailed) return;
        // JSON text escapes NUL and lone surrogate code units before the
        // event canonicalizer/PostgreSQL JSONB boundary sees the payload.
        const event = this.#eventFactory.create({
          episodeId: task.episodeId,
          typeId: eventType(frame.type),
          payload: {
            schema: "scce.turn_task_event.v2",
            frameJsonText,
            frameJsonSha256: createHasher().digestHex(frameJsonText)
          },
          parents: task.lastEvent ? [task.lastEvent] : []
        });
        await this.#storage.events.append(event);
        task.lastEvent = event;
        task.durableSequence = Math.max(task.durableSequence, frame.sequence);
        // Publication follows the durable append. Subscriber failures cannot
        // roll back a committed event or poison persistence for later frames.
        for (const subscriber of [...task.subscribers]) {
          try {
            subscriber(frame);
          } catch {
            // A disconnected or faulty observer is isolated from the ledger.
          }
        }
      })
      .catch(() => {
        task.persistenceFailed = true;
        // Pending frames remain inspectable as pending in the live registry,
        // but neither this frame nor any later frame is published as durable.
      });
  }

  #evictCompleted(): void {
    const completed = [...this.#tasks.values()]
      .filter(task => terminal(task.status) && task.subscribers.size === 0 && !task.persistenceFailed && task.durableSequence === task.frames.length)
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (this.#tasks.size > 256 && completed.length) {
      const task = completed.shift()!;
      this.#tasks.delete(task.taskId);
    }
  }
}

/** A 202 alone is not an approval checkpoint. The application must have returned a structured approval receipt. */
export function isTurnTaskApprovalWait(frame: Pick<TurnTaskFrame, "type" | "phase" | "status" | "value"> | undefined): boolean {
  if (!frame || frame.status !== 202 || !(frame.type === "result" || frame.type === "progress" && frame.phase === "application.turn.awaiting_approval")
    || !frame.value || typeof frame.value !== "object" || Array.isArray(frame.value)) return false;
  const pending = frame.value.pendingApproval;
  return Boolean(pending && typeof pending === "object" && !Array.isArray(pending)
    && [pending.planId, pending.capabilityId, pending.fingerprint].every(value => typeof value === "string" && value.length > 0));
}

function snapshot(task: LiveTurnTask): TurnTaskSnapshot {
  return {
    schema: "scce.turn_task.v1",
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    latestSequence: task.frames.at(-1)?.sequence ?? 0,
    persistence: !task.persistenceFailed && task.durableSequence >= (task.frames.at(-1)?.sequence ?? 0)
      ? "durable"
      : "pending",
    frames: [...task.frames]
  };
}

function terminal(status: TurnTaskStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function eventType(type: TurnTaskFrame["type"]): string {
  if (type === "accepted") return "TurnTaskAccepted";
  if (type === "progress") return "TurnTaskProgressed";
  if (type === "result") return "TurnTaskCompleted";
  if (type === "cancelled") return "TurnTaskCancelled";
  return "TurnTaskFailed";
}

function frameFromEvent(event: ScceEvent): TurnTaskFrame | undefined {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
  const record = event.payload as Record<string, JsonValue>;
  if (record.schema === "scce.turn_task_event.v1") {
    // Existing ledger entries retain their original representation and hash.
    const frame = record.frame;
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
    return frame.schema === "scce.turn_task_frame.v1" ? frame as unknown as TurnTaskFrame : undefined;
  }
  if (record.schema !== "scce.turn_task_event.v2") return undefined;
  if (Object.keys(record).some(key => !["schema", "frameJsonText", "frameJsonSha256"].includes(key))
    || typeof record.frameJsonText !== "string" || typeof record.frameJsonSha256 !== "string"
    || record.frameJsonSha256 !== createHasher().digestHex(record.frameJsonText)) {
    throw new Error("invalid persisted turn task frame checksum/envelope");
  }
  let frame: unknown;
  try { frame = JSON.parse(record.frameJsonText); }
  catch { throw new Error("invalid persisted turn task frame JSON"); }
  if (!validStoredFrame(frame, event)) throw new Error("invalid persisted turn task frame identity/types");
  return frame;
}

function validStoredFrame(value: unknown, event: ScceEvent): value is TurnTaskFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  const keys = ["schema", "taskId", "sequence", "observedAt", "type", "requestId", "phase", "status", "elapsedMs", "value", "error", "detail", "persistence", "answer", "assistantForce", "cognition"];
  if (Object.keys(frame).some(key => !keys.includes(key)) || frame.schema !== "scce.turn_task_frame.v1"
    || typeof frame.taskId !== "string" || frame.taskId !== String(event.episodeId)
    || typeof frame.sequence !== "number" || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1
    || typeof frame.observedAt !== "number" || !Number.isSafeInteger(frame.observedAt) || frame.observedAt < 0
    || typeof frame.type !== "string" || !["accepted", "progress", "result", "error", "cancelled"].includes(frame.type)) return false;
  if (eventType(frame.type as TurnTaskFrame["type"]) !== String(event.typeId)) return false;
  for (const key of ["requestId", "phase", "error", "answer", "assistantForce"]) {
    if (frame[key] !== undefined && typeof frame[key] !== "string") return false;
  }
  if (frame.status !== undefined && (typeof frame.status !== "number" || !Number.isSafeInteger(frame.status))) return false;
  if (frame.elapsedMs !== undefined && (typeof frame.elapsedMs !== "number" || !Number.isFinite(frame.elapsedMs) || frame.elapsedMs < 0)) return false;
  if (frame.persistence !== undefined && frame.persistence !== "pending" && frame.persistence !== "durable") return false;
  return ["value", "detail", "cognition"].every(key => frame[key] === undefined || validJsonValue(frame[key]));
}

function validJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(validJsonValue);
  return value !== null && typeof value === "object" && Object.values(value).every(validJsonValue);
}
