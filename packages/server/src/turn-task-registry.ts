import {
  createClock,
  createEventFactory,
  createHasher,
  createIdFactory,
  toJsonValue,
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
  persistence?: "pending" | "durable";
  /** Present only on the "answer.ready" progress frame -- see production-turn-runtime.ts. */
  answer?: string;
  assistantForce?: string;
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

  create(input: { requestId: string; observedAt?: number }): TurnTaskSnapshot {
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
      durableSequence: 0
    };
    this.#tasks.set(taskId, task);
    this.append(taskId, {
      type: "accepted",
      requestId: input.requestId,
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

  append(
    taskId: string,
    frame: Omit<TurnTaskFrame, "schema" | "taskId" | "sequence" | "observedAt">
  ): TurnTaskFrame {
    const task = this.#tasks.get(taskId);
    if (!task) throw new Error(`unknown turn task ${taskId}`);
    if (terminal(task.status)) return task.frames.at(-1)!;
    const next: TurnTaskFrame = {
      schema: "scce.turn_task_frame.v1",
      taskId,
      sequence: task.frames.length + 1,
      observedAt: Date.now(),
      ...frame
    };
    task.frames.push(next);
    task.updatedAt = next.observedAt;
    if (next.type === "result") task.status = "succeeded";
    else if (next.type === "error") task.status = "failed";
    else if (next.type === "cancelled") task.status = "cancelled";
    else if (task.status === "accepted" && next.type === "progress") task.status = "running";
    for (const subscriber of task.subscribers) subscriber(next);
    this.#persist(task, next);
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
    const last = frames.at(-1)!;
    const status: TurnTaskStatus = last.type === "result"
      ? "succeeded"
      : last.type === "error"
        ? "failed"
        : last.type === "cancelled"
          ? "cancelled"
          : "interrupted";
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

  #persist(task: LiveTurnTask, frame: TurnTaskFrame): void {
    task.persistenceTail = task.persistenceTail
      .then(async () => {
        const event = this.#eventFactory.create({
          episodeId: task.episodeId,
          typeId: eventType(frame.type),
          payload: {
            schema: "scce.turn_task_event.v1",
            frame: toJsonValue(frame)
          },
          parents: task.lastEvent ? [task.lastEvent] : []
        });
        await this.#storage.events.append(event);
        task.lastEvent = event;
        task.durableSequence = Math.max(task.durableSequence, frame.sequence);
      })
      .catch(() => {
        // The live stream remains available and honestly reports pending
        // persistence. Later events continue from the last durable parent.
      });
  }

  #evictCompleted(): void {
    const completed = [...this.#tasks.values()]
      .filter(task => terminal(task.status) && task.subscribers.size === 0)
      .sort((left, right) => left.updatedAt - right.updatedAt);
    while (this.#tasks.size > 256 && completed.length) {
      const task = completed.shift()!;
      this.#tasks.delete(task.taskId);
    }
  }
}

function snapshot(task: LiveTurnTask): TurnTaskSnapshot {
  return {
    schema: "scce.turn_task.v1",
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    latestSequence: task.frames.at(-1)?.sequence ?? 0,
    persistence: task.durableSequence >= (task.frames.at(-1)?.sequence ?? 0)
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
  if (record.schema !== "scce.turn_task_event.v1") return undefined;
  const frame = record.frame;
  if (!frame || typeof frame !== "object" || Array.isArray(frame)) return undefined;
  const candidate = frame as unknown as TurnTaskFrame;
  return candidate.schema === "scce.turn_task_frame.v1" ? candidate : undefined;
}
