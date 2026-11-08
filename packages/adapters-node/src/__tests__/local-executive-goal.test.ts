// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createDurableExecutiveEpisode, createExecutiveEpisodeMachine, createHasher, DEFAULT_POLICY, type ConstructGraph, type ExecutiveEvent, type ExecutiveEventJournal } from "@scce/kernel";
import { NodeBuildTestAdapter } from "../process.js";
import { runLocalExecutiveGoal, type LocalExecutiveGoalRequest } from "../local-executive-goal.js";
import type { ScceRuntimeConfig } from "../config.js";

describe("production local executive goal runner", () => {
  it.each([false, true])("executes real dependent programs through approval and disk-journal restart (stage two fails=%s)", async fails => {
    const root = await mkdtemp(join(tmpdir(), "scce-local-goal-"));
    const journalPath = join(root, "journal.json");
    const effectsPath = join(root, "effects.log");
    let interruptOutcome = false;
    const journal = (): ExecutiveEventJournal => ({
      read: async episodeId => {
        const events = await readFile(journalPath, "utf8").then(text => JSON.parse(text) as ExecutiveEvent[]).catch(error => { if (error.code === "ENOENT") return []; throw error; });
        return { episodeId, events, revision: events.length };
      },
      append: async input => {
        const prior = await journal().read(input.episodeId);
        if (prior.events.some(event => event.commandId === input.commandId)) return { status: "duplicate", revision: prior.revision };
        if (prior.revision !== input.expectedRevision) return { status: "conflict", revision: prior.revision };
        if (interruptOutcome && input.events.some(event => event.type === "outcome_recorded" && prior.events.some(candidate => candidate.type === "attempt_prepared" && candidate.attempt.taskId === "stage.1" && candidate.attempt.id === event.outcome.attemptId))) {
          interruptOutcome = false;
          throw new Error("stage two outcome acknowledgement interrupted");
        }
        const events = [...prior.events, ...input.events];
        await writeFile(journalPath, JSON.stringify(events));
        return { status: "appended", revision: events.length };
      }
    });
    const request: LocalExecutiveGoalRequest = { schema: "scce.local_executive_goal.v1", episodeId: "episode.local", goalId: "goal.local", tasks: [0, 1, 2].map(index => {
      const content = `import {appendFileSync,readFileSync,existsSync} from 'node:fs';\nconst p=${JSON.stringify(effectsPath)};\nconst previous=existsSync(p)?readFileSync(p,'utf8'):'';\nif(previous!==${JSON.stringify(Array.from({ length: index }, (_, i) => `${i}\n`).join(""))})process.exit(8);\nappendFileSync(p,${JSON.stringify(`${index}\n`)});\n${fails && index === 1 ? "process.exit(9);" : ""}\n`;
      const artifact = { artifactId: `artifact.${index}`, path: "main.mjs", mediaType: "text/javascript", content, contentHash: `sha256_${createHasher().digestHex(content)}`, role: "source" };
      const construct = { id: `construct.${index}`, artifacts: [artifact], program: { id: `program.${index}`, language: "javascript", files: [artifact], nodes: [], edges: [], entrypoint: "main.mjs", packageManager: "node",
        build: { command: process.execPath, args: ["--check", "main.mjs"], cwd: "." }, test: { command: process.execPath, args: ["main.mjs"], cwd: "." } } } as unknown as ConstructGraph;
      return { id: `stage.${index}`, dependencyTaskIds: index ? [`stage.${index - 1}`] : [], construct };
    }) };
    const restart = () => ({ request, executive: createDurableExecutiveEpisode({ machine: createExecutiveEpisodeMachine(createHasher()), journal: journal(), maxConflictRetries: 1 }),
      buildTest: new NodeBuildTestAdapter({ runtime: { tempRoot: join(root, "runs") } } as ScceRuntimeConfig), ownerId: "owner.local", policy: { ...DEFAULT_POLICY, maxToolCalls: fails ? 3 : 1 }, approved: true });
    try {
      expect((await runLocalExecutiveGoal({ ...restart(), approved: false })).disposition).toBe("not_ready");
      await expect(readFile(effectsPath)).rejects.toMatchObject({ code: "ENOENT" });
      interruptOutcome = true;
      if (!fails) {
        expect((await runLocalExecutiveGoal(restart())).disposition).toBe("budget_exhausted");
        expect(await readFile(effectsPath, "utf8")).toBe("0\n");
      }
      await expect(runLocalExecutiveGoal(restart())).rejects.toThrow("stage two outcome acknowledgement interrupted");
      expect(await readFile(effectsPath, "utf8")).toBe("0\n1\n");
      let resumed = await runLocalExecutiveGoal({ ...restart(), approved: false });
      if (!fails) {
        expect(resumed.disposition).toBe("budget_exhausted");
        resumed = await runLocalExecutiveGoal({ ...restart(), approved: false });
      }
      expect(resumed.disposition).toBe(fails ? "failed" : "succeeded");
      expect(Object.values(resumed.state.receipts)).toHaveLength(fails ? 2 : 3);
      expect(Object.values(resumed.state.outcomes)).toHaveLength(fails ? 2 : 3);
      expect(await readFile(effectsPath, "utf8")).toBe(fails ? "0\n1\n" : "0\n1\n2\n");
      expect((await runLocalExecutiveGoal(restart())).disposition).toBe(fails ? "failed" : "succeeded");
      expect(await readFile(effectsPath, "utf8")).toBe(fails ? "0\n1\n" : "0\n1\n2\n");
      expect(resumed.state.goals["goal.local"]!.status).toBe(fails ? "active" : "satisfied");
    } finally {
      if (!resolve(root).startsWith(resolve(tmpdir()) + "/") && !resolve(root).startsWith(resolve(tmpdir()) + "\\")) throw new Error("test cleanup escaped its temporary root");
      await rm(root, { recursive: true, force: true });
    }
  });
});
