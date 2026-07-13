import { describe, expect, it } from "vitest";
import { TASK_TIMELINE_SCHEMA } from "../protocol.js";
import { TASK_STORAGE_KEY, TaskTimeline, type MementoLike } from "../task-timeline.js";

class MemoryMemento implements MementoLike {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

describe("persisted extension task metadata", () => {
  it("persists versioned tasks and enforces state transitions", async () => {
    const storage = new MemoryMemento();
    const timeline = new TaskTimeline(storage, () => 10);
    const task = await timeline.start("workspace.ingest", "Ingest", true);
    expect(task.state).toBe("pending_approval");
    await timeline.transition(task.id, "running");
    await timeline.transition(task.id, "succeeded", "done");
    await expect(timeline.transition(task.id, "running")).rejects.toThrow(/invalid/);
    expect(storage.values.get(TASK_STORAGE_KEY)).toMatchObject({ schema: TASK_TIMELINE_SCHEMA });
  });

  it("restores task history and marks in-flight metadata interrupted without replay", async () => {
    const storage = new MemoryMemento();
    const first = new TaskTimeline(storage, () => 10);
    await first.start("workspace.ask", "Question", true);

    const restored = new TaskTimeline(storage, () => 20);
    expect(await restored.recoverInterrupted()).toBe(1);
    expect(restored.list()[0]).toMatchObject({ state: "interrupted", recoveredAt: 20 });
  });

  it("drops malformed or wrong-version persisted metadata", () => {
    const storage = new MemoryMemento();
    storage.values.set(TASK_STORAGE_KEY, { schema: "yopp.vscode.task_timeline.v2", tasks: [{ id: "bad" }] });
    expect(new TaskTimeline(storage).list()).toEqual([]);
  });
});
