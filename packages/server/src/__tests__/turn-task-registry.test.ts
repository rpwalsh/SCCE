// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {createHasher,decodeProgramArtifactWire,encodeProgramArtifactWire,hashEvent, type EpisodeId, type ScceEvent, type ScceStorage } from "@scce/kernel";
import { TurnTaskRegistry } from "../turn-task-registry.js";

function storageFixture(options: {
  append?: (event: ScceEvent, commit: () => void) => Promise<void>;
} = {}): ScceStorage {
  const events: ScceEvent[] = [];
  return {
    events: {
      append: async (event: ScceEvent) => {
        const commit = () => events.push(JSON.parse(JSON.stringify(event)) as ScceEvent);
        if (options.append) await options.append(event, commit);
        else commit();
      },
      appendBatch: async (batch: ScceEvent[]) => {
        events.push(...batch.map(event=>JSON.parse(JSON.stringify(event)) as ScceEvent));
      },
      readEpisode: async (episodeId: EpisodeId) => events.filter(event => event.episodeId === episodeId),
      readRange: async () => [...events],
      latestLedgerHash: async () => events.at(-1)?.hash ?? ""
    }
  } as unknown as ScceStorage;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

describe("turn task registry", () => {
  it("persists replayable long-running frames and recovers a terminal receipt", async () => {
    const storage = storageFixture();
    const live = new TurnTaskRegistry(storage);
    const created = live.create({ requestId: "request.fixture", observedAt: 10 });
    live.markRunning(created.taskId);
    live.append(created.taskId, { type: "progress", phase: "graph.resolve" });
    live.append(created.taskId, { type: "result", status: 200, value: { answer: "complete" } });
    await live.drain(created.taskId);

    const liveSnapshot = await live.get(created.taskId);
    expect(liveSnapshot).toMatchObject({
      status: "succeeded",
      persistence: "durable",
      latestSequence: 3
    });

    const recovered = await new TurnTaskRegistry(storage).get(created.taskId);
    expect(recovered).toMatchObject({
      schema: "scce.turn_task.v1",
      status: "succeeded",
      persistence: "durable",
      latestSequence: 3
    });
    expect(recovered?.frames.map(frame => frame.type)).toEqual([
      "accepted",
      "progress",
      "result"
    ]);
  });

  it("keeps disconnect separate from explicit cancellation", () => {
    const registry = new TurnTaskRegistry(storageFixture());
    const task = registry.create({ requestId: "request.cancel" });
    const signal = registry.controller(task.taskId)?.signal;
    expect(signal?.aborted).toBe(false);

    const cancelled = registry.cancel(task.taskId, "user stopped the task");
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toMatchObject({ status: "cancelled" });
    expect(cancelled?.frames.at(-1)).toMatchObject({
      type: "cancelled",
      error: "user stopped the task"
    });
  });

  it("publishes a frame only after its ledger append commits", async () => {
    const gate = deferred();
    const storage = storageFixture({ append: async (_event, commit) => {
      await gate.promise;
      commit();
    } });
    const registry = new TurnTaskRegistry(storage);
    const task = registry.create({ requestId: "request.commit-before-publish" });
    const published: number[] = [];
    registry.subscribe(task.taskId, frame => published.push(frame.sequence));

    await Promise.resolve();
    expect(published).toEqual([]);
    expect(await storage.events.readEpisode(task.taskId as EpisodeId)).toEqual([]);
    expect(await registry.get(task.taskId)).toMatchObject({ persistence: "pending", latestSequence: 1 });

    gate.resolve();
    await registry.drain(task.taskId);
    expect(await storage.events.readEpisode(task.taskId as EpisodeId)).toHaveLength(1);
    expect(published).toEqual([1]);
    expect(await registry.get(task.taskId)).toMatchObject({ persistence: "durable", latestSequence: 1 });
  });

  it("keeps a failed frame and every later frame pending without publishing a durable gap", async () => {
    let appendAttempts = 0;
    const storage = storageFixture({ append: async () => {
      appendAttempts++;
      throw new Error("ledger unavailable");
    } });
    const registry = new TurnTaskRegistry(storage);
    const task = registry.create({ requestId: "request.persistence-failure" });
    const published: number[] = [];
    registry.subscribe(task.taskId, frame => published.push(frame.sequence));
    registry.append(task.taskId, { type: "progress", phase: "graph.resolve" });
    registry.append(task.taskId, { type: "result", status: 200, value: { answer: "not durable" } });

    await registry.drain(task.taskId);
    expect(appendAttempts).toBe(1);
    expect(published).toEqual([]);
    expect(await storage.events.readEpisode(task.taskId as EpisodeId)).toEqual([]);
    expect(await registry.get(task.taskId)).toMatchObject({
      status: "succeeded",
      persistence: "pending",
      latestSequence: 3
    });
    expect(await new TurnTaskRegistry(storage).get(task.taskId)).toBeUndefined();
  });

  it("serializes concurrent appends, publishes in sequence, and replays the exact committed payloads after restart", async () => {
    const firstCommit = deferred();
    const started: number[] = [];
    let active = 0;
    let maxActive = 0;
    const storage = storageFixture({ append: async (event, commit) => {
      const record = event.payload as Record<string, unknown>;
      const frame = JSON.parse(String(record.frameJsonText)) as { sequence: number };
      started.push(frame.sequence);
      active++;
      maxActive = Math.max(maxActive, active);
      if (frame.sequence === 1) await firstCommit.promise;
      commit();
      active--;
    } });
    const registry = new TurnTaskRegistry(storage);
    const task = registry.create({ requestId: "request.concurrent" });
    const published: number[] = [];
    registry.subscribe(task.taskId, frame => published.push(frame.sequence));
    const progressValue = { exact: "A\u030a" };
    const resultValue = { answer: "done\u0000exactly" };
    const progress = registry.append(task.taskId, { type: "progress", phase: "graph.resolve", value: progressValue });
    const result = registry.append(task.taskId, { type: "result", status: 200, value: resultValue });
    progressValue.exact = "mutated after append";
    resultValue.answer = "mutated after append";

    await Promise.resolve();
    expect(started).toEqual([1]);
    expect(published).toEqual([]);
    firstCommit.resolve();
    await registry.drain(task.taskId);

    expect(maxActive).toBe(1);
    expect(started).toEqual([1, 2, 3]);
    expect(published).toEqual([1, 2, 3]);
    const recovered = await new TurnTaskRegistry(storage).get(task.taskId);
    expect(recovered).toMatchObject({ status: "succeeded", persistence: "durable", latestSequence: 3 });
    expect(recovered?.frames).toEqual([task.frames[0], progress, result]);
    expect(recovered?.frames[1]?.value).toEqual({ exact: "A\u030a" });
    expect(recovered?.frames[2]?.value).toEqual({ answer: "done\u0000exactly" });
  });

  it("aborts cancellation immediately but publishes its frame only after commit", async () => {
    const cancelCommit = deferred();
    let appendCount = 0;
    const storage = storageFixture({ append: async (_event, commit) => {
      appendCount++;
      if (appendCount === 2) await cancelCommit.promise;
      commit();
    } });
    const registry = new TurnTaskRegistry(storage);
    const task = registry.create({ requestId: "request.cancel-after-commit" });
    await registry.drain(task.taskId);
    const published: number[] = [];
    registry.subscribe(task.taskId, frame => published.push(frame.sequence));

    const cancelled = registry.cancel(task.taskId, "operator cancelled");
    expect(registry.controller(task.taskId)?.signal.aborted).toBe(true);
    expect(cancelled).toMatchObject({ status: "cancelled", persistence: "pending", latestSequence: 2 });
    expect(published).toEqual([]);
    expect(await storage.events.readEpisode(task.taskId as EpisodeId)).toHaveLength(1);

    cancelCommit.resolve();
    await registry.drain(task.taskId);
    expect(published).toEqual([2]);
    expect(await registry.get(task.taskId)).toMatchObject({ status: "cancelled", persistence: "durable" });
  });
});

it("recovers exact NUL/astral/combining/literal-escape artifact bytes from PG-safe task events",async()=>{
 const storage=storageFixture(),live=new TurnTaskRegistry(storage),task=live.create({requestId:"request.exact-text"});
 const content="prefix\u0000\ud83e\uddedA\u030a literal\\u0000 suffix",hasher=createHasher();
 const artifact={artifactId:"artifact:exact-nul",path:"source.mjs",mediaType:"text/javascript",role:"source",content,contentHash:`sha256_${hasher.digestHex(content)}`};
 const value=encodeProgramArtifactWire({programArtifacts:[artifact],buildTest:{artifacts:[artifact]},events:[{hash:"original-producer-hash",payload:{artifacts:[artifact]}}]});
 live.append(task.taskId,{type:"result",status:200,value:value as never});await live.drain(task.taskId);
 const stored=await storage.events.readEpisode(task.taskId as EpisodeId);
 const hasNul=(value:unknown):boolean=>typeof value==="string"?value.includes("\u0000"):Array.isArray(value)?value.some(hasNul):value!==null&&typeof value==="object"?Object.values(value).some(hasNul):false;
 expect(stored.some(event=>hasNul(event.payload))).toBe(false);
 const replay=await new TurnTaskRegistry(storage).get(task.taskId),restored=replay!.frames.at(-1)!.value as Record<string,unknown>;
 expect(restored).toEqual(value);expect(decodeProgramArtifactWire(restored)).toEqual({programArtifacts:[artifact],buildTest:{artifacts:[artifact]},events:[{hash:"original-producer-hash",payload:{artifacts:[artifact]}}]});
expect(stored.at(-1)!.payload).toMatchObject({schema:"scce.turn_task_event.v2",frameJsonText:expect.any(String),frameJsonSha256:expect.any(String)});
 const record=stored.at(-1)!.payload as Record<string,unknown>;
 expect(record.frameJsonText).toContain("\\u0000");expect(record.frameJsonText).not.toContain("\u0000");
 expect(JSON.stringify(record)).toContain("\\\\u0000");
 const parentHashes:string[]=[];for(const event of stored){const {hash,...withoutHash}=event;expect(hashEvent(withoutHash,parentHashes.slice(-1),hasher)).toBe(hash);parentHashes.push(hash);}
});
it.each(["digest","json","identity","type","unknown-frame-field"])("rejects corrupt v2 task %s before delivery",async kind=>{
 const storage=storageFixture(),live=new TurnTaskRegistry(storage),task=live.create({requestId:"request.corrupt"});live.append(task.taskId,{type:"result",status:200,value:{answer:"exact"}});await live.drain(task.taskId);
 const events=await storage.events.readEpisode(task.taskId as EpisodeId),event=events.at(-1)!,record=event.payload as Record<string,unknown>;
 if(kind==="digest")record.frameJsonSha256="0".repeat(64);
 else {const frame=JSON.parse(String(record.frameJsonText)) as Record<string,unknown>;if(kind==="identity")frame.taskId="different-task";if(kind==="type")frame.sequence="2";if(kind==="unknown-frame-field")frame.undeclared=true;
  record.frameJsonText=kind==="json"?"{invalid":JSON.stringify(frame);record.frameJsonSha256=createHasher().digestHex(String(record.frameJsonText));}
 await expect(new TurnTaskRegistry(storage).get(task.taskId)).rejects.toThrow("turn task");
});
it("still reads original version-one task events without rewriting their payloads or hashes",async()=>{
 const storage=storageFixture(),frame={schema:"scce.turn_task_frame.v1",taskId:"legacy-task",sequence:1,observedAt:10,type:"result",status:200,value:{answer:"legacy"}};
 await storage.events.append({id:"legacy-event",episodeId:"legacy-task",typeId:"TurnTaskCompleted",t:10,parents:[],hash:"untouched-original",payload:{schema:"scce.turn_task_event.v1",frame}} as never);
 const recovered=await new TurnTaskRegistry(storage).get("legacy-task");expect(recovered?.frames).toEqual([frame]);expect((await storage.events.readEpisode("legacy-task" as EpisodeId))[0]!.hash).toBe("untouched-original");
});
