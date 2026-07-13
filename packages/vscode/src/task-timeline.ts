import { randomUUID } from "node:crypto";
import { TASK_TIMELINE_SCHEMA, type ExtensionTaskState, type YoppEndpoint } from "./protocol.js";

export const TASK_STORAGE_KEY = "yopp.taskTimeline.v1";
const MAX_TASKS = 100;

export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface ExtensionTaskRecord {
  id: string;
  endpoint: YoppEndpoint;
  label: string;
  state: ExtensionTaskState;
  mutates: boolean;
  startedAt: number;
  updatedAt: number;
  recoveredAt?: number;
  detail?: string;
}

export interface PersistedTaskTimeline {
  schema: typeof TASK_TIMELINE_SCHEMA;
  tasks: ExtensionTaskRecord[];
}

export class TaskTimeline {
  private tasks: ExtensionTaskRecord[];

  constructor(private readonly storage: MementoLike, private readonly now: () => number = Date.now) {
    this.tasks = parseTaskTimeline(storage.get<unknown>(TASK_STORAGE_KEY)).tasks;
  }

  list(): readonly ExtensionTaskRecord[] {
    return [...this.tasks].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  async recoverInterrupted(): Promise<number> {
    let recovered = 0;
    const observedAt = this.now();
    this.tasks = this.tasks.map(task => {
      if (task.state !== "running" && task.state !== "pending_approval") return task;
      recovered++;
      return { ...task, state: "interrupted", updatedAt: observedAt, recoveredAt: observedAt, detail: "Extension host stopped before completion; request was not replayed." };
    });
    if (recovered) await this.persist();
    return recovered;
  }

  async start(endpoint: YoppEndpoint, label: string, mutates: boolean): Promise<ExtensionTaskRecord> {
    const observedAt = this.now();
    const task: ExtensionTaskRecord = {
      id: randomUUID(),
      endpoint,
      label,
      state: mutates ? "pending_approval" : "running",
      mutates,
      startedAt: observedAt,
      updatedAt: observedAt
    };
    this.tasks = [task, ...this.tasks].slice(0, MAX_TASKS);
    await this.persist();
    return task;
  }

  async transition(id: string, state: ExtensionTaskState, detail?: string): Promise<ExtensionTaskRecord> {
    const index = this.tasks.findIndex(task => task.id === id);
    if (index < 0) throw new Error(`unknown Yopp task: ${id}`);
    const current = this.tasks[index]!;
    if (!allowedTransition(current.state, state)) throw new Error(`invalid Yopp task transition: ${current.state} -> ${state}`);
    const updated = { ...current, state, updatedAt: this.now(), detail };
    this.tasks = this.tasks.map(task => task.id === id ? updated : task);
    await this.persist();
    return updated;
  }

  async clear(): Promise<void> {
    this.tasks = [];
    await this.persist();
  }

  private persist(): PromiseLike<void> {
    return this.storage.update(TASK_STORAGE_KEY, { schema: TASK_TIMELINE_SCHEMA, tasks: this.tasks } satisfies PersistedTaskTimeline);
  }
}

export function parseTaskTimeline(value: unknown): PersistedTaskTimeline {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { schema: TASK_TIMELINE_SCHEMA, tasks: [] };
  const input = value as Record<string, unknown>;
  if (input.schema !== TASK_TIMELINE_SCHEMA || !Array.isArray(input.tasks)) return { schema: TASK_TIMELINE_SCHEMA, tasks: [] };
  return { schema: TASK_TIMELINE_SCHEMA, tasks: input.tasks.flatMap(parseTask).slice(0, MAX_TASKS) };
}

function parseTask(value: unknown): ExtensionTaskRecord[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const input = value as Record<string, unknown>;
  if (typeof input.id !== "string" || typeof input.label !== "string" || typeof input.startedAt !== "number" || typeof input.updatedAt !== "number") return [];
  if (!isEndpoint(input.endpoint) || !isState(input.state) || typeof input.mutates !== "boolean") return [];
  return [{
    id: input.id,
    endpoint: input.endpoint,
    label: input.label,
    state: input.state,
    mutates: input.mutates,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    recoveredAt: typeof input.recoveredAt === "number" ? input.recoveredAt : undefined,
    detail: typeof input.detail === "string" ? input.detail : undefined
  }];
}

function isEndpoint(value: unknown): value is YoppEndpoint {
  return value === "ready" || value === "workspace.initialize" || value === "workspace.ingest" || value === "workspace.ask" || value === "project.summary" || value === "workspace.status";
}

function isState(value: unknown): value is ExtensionTaskState {
  return value === "pending_approval" || value === "running" || value === "succeeded" || value === "failed" || value === "interrupted" || value === "cancelled";
}

function allowedTransition(from: ExtensionTaskState, to: ExtensionTaskState): boolean {
  if (from === to) return true;
  if (from === "pending_approval") return to === "running" || to === "cancelled" || to === "interrupted";
  if (from === "running") return to === "succeeded" || to === "failed" || to === "interrupted";
  return false;
}
