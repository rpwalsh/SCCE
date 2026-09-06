#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Head to head on the behaviours SCCE exists for, against a local language model, on one machine.
//
// The sealed cloze set measures span extraction and refusal over a fixed corpus. It cannot measure what this product
// claims: that state persists, that contradictions survive rather than collapsing, that something learned at one turn
// is available at a later one, and that a false premise is denied rather than explained. Those are the tasks here.
//
// Every entity in the task set is invented -- Xylor-7, Halvern Dynamics, Mount Verrick, the Brennels protocol. That is
// deliberate and it is the only way this comparison is honest: the sealed corpus is Wikipedia and the model was
// trained on Wikipedia, so a shared-corpus benchmark cannot separate reading from recall. Nothing here is in anyone's
// training data, so both systems must use what they are given in this session or decline.
//
// Both systems receive the same turns in the same order. A "teach" turn is an ordinary assertion turn for SCCE, which
// admits it as session evidence, and an appended context line for the model. Neither is given a hint that a later
// question is coming.
//
// Scoring is mechanical and three-way, never a binary. Answering an unanswerable question and refusing an answerable
// one are different failures and are counted separately, because collapsing them is how a system that never refuses
// scores well.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const args = new Map(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
  const at = a.indexOf("=");
  return at < 0 ? [a.slice(2), "true"] : [a.slice(2, at), a.slice(at + 1)];
}));
const tasksPath = args.get("tasks") ?? "tools/cognitive-state-benchmark/tasks.jsonl";
const scceUrl = args.get("scce") ?? "http://127.0.0.1:3873";
const ollamaUrl = args.get("ollama") ?? "http://127.0.0.1:11434";
const model = args.get("model") ?? "qwen2.5:3b";
const only = args.get("only");
const systems = (args.get("systems") ?? "scce,llm").split(",").map(s => s.trim()).filter(Boolean);
const outPath = args.get("out") ?? "tools/cognitive-state-benchmark/results.json";

const LLM_INSTRUCTIONS = [
  "You are answering from the notes given to you in this conversation and from nothing else.",
  "You may combine, count, or compute from the notes; a conclusion the notes support by reasoning is an answer, not a gap.",
  "Reply exactly: I don't know. only when the notes do not support an answer even by combining them.",
  "If a question assumes something false, say plainly that it is false and why.",
  "If the notes disagree with each other, say so and give both values rather than choosing one.",
  "Answer briefly."
].join(" ");

const tasks = (await readFile(tasksPath, "utf8"))
  .split(/\r?\n/)
  .filter(line => line.trim())
  .map(line => JSON.parse(line))
  .filter(task => !only || task.taskId === only);

const records = [];
for (const task of tasks) {
  for (const system of systems) {
    const sessionId = `csb-${system}-${task.taskId}-${Date.now()}`;
    const context = [];
    for (const [index, turn] of task.turns.entries()) {
      const started = Date.now();
      const response = system === "scce"
        ? await askScce(turn.text, sessionId)
        : await askLlm(turn.text, context, turn.kind);
      const elapsedMs = Date.now() - started;
      if (turn.kind === "teach") {
        context.push(turn.text);
        continue;
      }
      // A distractor exists to put turns between teaching and recall. It is not a question either system is being
      // judged on, and scoring it punished exactly the behaviour this benchmark values: an evidence-bound system
      // declining a general-knowledge question absent from its notes is correct, not a failed answer.
      if (turn.score?.distractor) continue;
      records.push({
        taskId: task.taskId,
        track: task.track,
        turnIndex: index,
        system: system === "scce" ? "scce" : `llm:${model}`,
        question: turn.text,
        answer: response.answer,
        refused: response.refused,
        elapsedMs,
        cost: response.cost,
        ...(response.error ? { error: response.error } : {}),
        ...classify(turn.score ?? {}, response)
      });
    }
  }
}

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify({ schema: "scce.cognitive_state_benchmark.v1", model, generatedAt: new Date().toISOString(), records }, null, 1)}\n`, "utf8");
report(records);

/** SCCE through its own HTTP surface, one session per task so state is genuinely carried rather than re-supplied. */
async function askScce(text, sessionId) {
  try {
    const response = await fetch(`${scceUrl}/api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, sessionId, conversationId: sessionId })
    });
    if (!response.ok) {
      // A declined turn is a refusal, not an error: the runtime saying it has no admissible answer is the behaviour
      // under test, and scoring it as a crash would hide exactly the property this benchmark exists to measure.
      const body = await response.text();
      const declined = response.status === 422 || /no admissible answer/i.test(body);
      return { answer: "", refused: declined, cost: {}, error: declined ? undefined : `${response.status} ${body.slice(0, 160)}` };
    }
    const body = await response.json();
    const answer = String(body.answer ?? "");
    return {
      answer,
      refused: !answer.trim() || body.assistantForce === "insufficient_support",
      cost: {
        wallClockMs: body.timing?.resourceUsage?.wallClockMs ?? body.timing?.totalMs ?? null,
        cpuUserMs: body.timing?.resourceUsage?.cpuUserMs ?? null,
        peakResidentBytes: body.timing?.resourceUsage?.peakResidentSetBytes ?? null,
        inferenceCalls: 0
      }
    };
  } catch (error) {
    return { answer: "", refused: false, cost: {}, error: String(error?.message ?? error).slice(0, 160) };
  }
}

async function askLlm(text, context, kind) {
  if (kind === "teach") return { answer: "", refused: false, cost: {} };
  const notes = context.length ? `Notes:\n${context.map((line, index) => `${index + 1}. ${line}`).join("\n")}\n\n` : "";
  try {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: `${LLM_INSTRUCTIONS}\n\n${notes}Question: ${text}\nAnswer:`,
        stream: false,
        options: { temperature: 0, top_p: 1, seed: 20260906, num_predict: 200 }
      })
    });
    if (!response.ok) return { answer: "", refused: false, cost: {}, error: `ollama ${response.status}` };
    const body = await response.json();
    const answer = String(body.response ?? "").trim();
    return {
      answer,
      refused: isDeclination(answer),
      cost: {
        wallClockMs: body.total_duration ? Math.round(body.total_duration / 1e6) : null,
        cpuUserMs: null,
        peakResidentBytes: null,
        inferenceCalls: 1,
        promptTokens: body.prompt_eval_count ?? null,
        generatedTokens: body.eval_count ?? null
      }
    };
  } catch (error) {
    return { answer: "", refused: false, cost: {}, error: String(error?.message ?? error).slice(0, 160) };
  }
}

function isDeclination(answer) {
  const normalized = answer.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (!normalized) return true;
  return ["i don t know", "i dont know", "i do not know", "unknown", "the notes do not", "not in the notes", "no information"]
    .some(form => normalized === form || normalized.startsWith(`${form} `));
}

/**
 * Five outcomes, not two. A system that answers everything scores the same as a careful one under a binary, which is
 * the flaw that makes a refusal claim unmeasurable.
 */
function classify(score, response) {
  const answerable = score.answerable !== false;
  const text = response.answer ?? "";
  const lower = text.toLowerCase();
  const has = value => lower.includes(String(value).toLowerCase());
  const containsAll = (score.mustContainAll ?? []).every(has);
  const containsAny = !score.mustContainAny || score.mustContainAny.some(has);
  const avoidsForbidden = (score.mustNotContain ?? []).every(value => !has(value));

  if (!answerable) {
    // A false premise is answered correctly by denying it, and an absent fact by declining; both count as a correct
    // refusal, because both are the system declining to assert what it cannot support.
    const denied = response.refused || deniesPremise(lower);
    return {
      outcome: denied ? "correct_refusal" : "fabrication",
      correct: denied,
      contradictionSurfaced: null
    };
  }
  if (response.refused) return { outcome: "incorrect_refusal", correct: false, contradictionSurfaced: null };
  const correct = containsAll && containsAny && avoidsForbidden;
  return {
    outcome: correct ? "correct_answer" : "wrong_answer",
    correct,
    contradictionSurfaced: score.contradictionExpected ? containsAll : null
  };
}

/** A denial of the premise, recognised by shape rather than sentiment. */
function deniesPremise(lower) {
  return ["did not", "didn't", "never ", "is not ", "isn't ", "was not ", "wasn't ", "no evidence", "false", "incorrect", "not true", "not the"]
    .some(form => lower.includes(form));
}

function report(rows) {
  const systems = [...new Set(rows.map(row => row.system))];
  const tracks = [...new Set(rows.map(row => row.track))];
  process.stdout.write(`\nCognitive state benchmark -- ${rows.length / Math.max(1, systems.length)} questions, all entities invented\n\n`);
  process.stdout.write(`${"track".padEnd(22)}${systems.map(s => s.padEnd(24)).join("")}\n`);
  for (const track of tracks) {
    const cells = systems.map(system => {
      const mine = rows.filter(row => row.track === track && row.system === system);
      const correct = mine.filter(row => row.correct).length;
      return `${correct}/${mine.length}`.padEnd(24);
    });
    process.stdout.write(`${track.padEnd(22)}${cells.join("")}\n`);
  }
  process.stdout.write("\n");
  for (const system of systems) {
    const mine = rows.filter(row => row.system === system);
    const count = outcome => mine.filter(row => row.outcome === outcome).length;
    const totalMs = mine.reduce((sum, row) => sum + (row.cost?.wallClockMs ?? row.elapsedMs ?? 0), 0);
    process.stdout.write(`${system}\n`);
    process.stdout.write(`  correct ${mine.filter(r => r.correct).length}/${mine.length}`
      + `  | correct answer ${count("correct_answer")}`
      + `  correct refusal ${count("correct_refusal")}`
      + `  wrong ${count("wrong_answer")}`
      + `  fabricated ${count("fabrication")}`
      + `  refused an answerable ${count("incorrect_refusal")}\n`);
    process.stdout.write(`  wall clock ${Math.round(totalMs)}ms total, ${Math.round(totalMs / Math.max(1, mine.length))}ms per question\n`);
  }
  process.stdout.write("\n");
}
