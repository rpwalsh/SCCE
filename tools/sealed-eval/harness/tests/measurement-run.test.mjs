import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicQuestion, runSystems } from "../lib/run-systems.mjs";
import { assertHostPreconditions } from "../lib/host-configuration.mjs";
import { readJsonl, sha256File, writeJson, writeJsonl } from "../lib/util.mjs";

test("adapter transport excludes answer keys and protected metadata", () => {
  const question = { schemaVersion: "1.0", questionId: "q", prompt: "p", category: "task", gold: { acceptedAnswers: ["secret"] }, protectedMetadata: { source: "secret" }, undeclared: "secret" };
  assert.deepEqual(publicQuestion(question), { schemaVersion: "1.0", questionId: "q", category: "task", prompt: "p" });
});

test("a cold comparison refuses unverifiable or preloaded Ollama residency", () => {
  const requirements = { ollamaModelsUnloaded: true };
  assert.doesNotThrow(() => assertHostPreconditions(requirements, { ollama: { runningModelsBeforeConditions: [] } }));
  assert.throws(() => assertHostPreconditions(requirements, { ollama: { status: "unavailable" } }), /could not verify/);
  assert.throws(() => assertHostPreconditions(requirements, { ollama: { runningModelsBeforeConditions: [{ name: "model" }] } }), /preloaded/);
});

test("the existing persistent session records gross measured energy and raw samples", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scce-measurement-"));
  const stub = fileURLToPath(new URL("./fixtures/stub-session-adapter.mjs", import.meta.url));
  const questionsPath = path.join(dir, "questions.jsonl");
  const corpusManifest = path.join(dir, "corpus.json");
  const systemManifest = path.join(dir, "systems.json");
  const outputDirectory = path.join(dir, "out");
  const planPath = path.join(dir, "plan.json");
  await writeJsonl(questionsPath, [0, 1, 2].map(i => ({ questionId: `q-${i}`, prompt: "prompt", category: "task" })));
  await writeJson(corpusManifest, { documents: [] });
  await writeJson(systemManifest, { systems: [{ systemId: "stub", conditionId: "cpu", mode: "jsonl-stdio", command: [process.execPath, stub], env: { STUB_PER_QUESTION_MS: "60", STUB_ANSWER_COUNT: "3" }, timeoutMs: 5000 }] });
  const sensorCode = `const send=()=>console.log(JSON.stringify({timestampMs:Date.now(),watts:10,source:"synthetic-test-only",scope:"whole-system",sensorId:"test",valid:true}));send();setInterval(send,20);`;
  await writeJson(planPath, { runId: "r", questionsPath, corpusManifest, systemManifest, outputDirectory, powerMeasurement: { command: [process.execPath, "-e", sensorCode], startupTimeoutMs: 2000, maxSampleGapMs: 2000 } });
  const answers = await runSystems(planPath);
  assert.equal(answers.length, 3);
  assert.ok(answers.every(row => row.observedElapsedMs >= 0));
  const [measurement] = await readJsonl(path.join(outputDirectory, "run-measurements.jsonl"));
  assert.equal(measurement.energy.status, "measured");
  assert.equal(measurement.energy.source, "synthetic-test-only");
  assert.ok(Math.abs(measurement.energy.joules - (measurement.endedAtMs - measurement.startedAtMs) * 0.01) < 1e-6);
  assert.equal(measurement.inputHashes.questions, await sha256File(questionsPath));
  assert.equal(measurement.powerSamplesSha256, await sha256File(path.join(outputDirectory, measurement.powerSamplesPath)));
});
