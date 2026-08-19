import test from "node:test";import assert from "node:assert/strict";import { mkdtemp, mkdir } from "node:fs/promises";import os from "node:os";import path from "node:path";import { fileURLToPath } from "node:url";
import { writeJson, writeJsonl, readJsonl } from "../lib/util.mjs";import { runSystems } from "../lib/run-systems.mjs";

const STUB=fileURLToPath(new URL("./fixtures/stub-session-adapter.mjs",import.meta.url));

async function runStub({questionCount,perQuestionMs,answerCount,timeoutMs}){
const dir=await mkdtemp(path.join(os.tmpdir(),"runsys-"));await mkdir(path.join(dir,"out"),{recursive:true});
const questions=Array.from({length:questionCount},(_,i)=>({questionId:`q-${i}`,prompt:`p-${i}`,category:"cloze"}));
await writeJsonl(path.join(dir,"questions.jsonl"),questions);
await writeJson(path.join(dir,"corpus.json"),{schemaVersion:"1.0",corpusId:"c",documents:[]});
await writeJson(path.join(dir,"systems.json"),{schemaVersion:"1.0",systems:[{systemId:"stub",conditionId:"full",mode:"jsonl-stdio",command:[process.execPath,STUB],cwd:dir,env:{STUB_PER_QUESTION_MS:String(perQuestionMs),STUB_ANSWER_COUNT:String(answerCount)},timeoutMs}]});
await writeJson(path.join(dir,"plan.json"),{runId:"r",seed:"s",clock:"fixed",questionsPath:path.join(dir,"questions.jsonl"),systemManifest:path.join(dir,"systems.json"),corpusManifest:path.join(dir,"corpus.json"),outputDirectory:path.join(dir,"out")});
await runSystems(path.join(dir,"plan.json"));
return readJsonl(path.join(dir,"out","raw-answers.jsonl"));}

// The defect that voided the 168-question run of 2026-08-18: the session timer
// covered every question at once, so a system answering steadily but slower
// than that one total was SIGKILLed and all 168 rows written as "timeout".
test("steady progress slower than the whole-session total is not killed",async()=>{
// 6 questions x 150ms = 900ms of work under a 500ms budget. A whole-session
// timer kills this; a per-question progress budget must not.
const rows=await runStub({questionCount:6,perQuestionMs:150,answerCount:6,timeoutMs:500});
assert.equal(rows.length,6);
assert.equal(rows.filter(r=>r.status==="ok").length,6,`expected every steadily-answered question ok, got ${rows.map(r=>r.status).join(",")}`);
for(let i=0;i<6;i++)assert.equal(rows[i].answer,`answer-for-q-${i}`);
});

// Marking every question "timeout" because the process was killed after the
// last one discards real completed measurements and reports a hang as
// universal failure.
test("answers already emitted survive a watchdog kill",async()=>{
const rows=await runStub({questionCount:5,perQuestionMs:50,answerCount:3,timeoutMs:700});
assert.equal(rows.length,5);
assert.deepEqual(rows.slice(0,3).map(r=>r.status),["ok","ok","ok"]);
assert.deepEqual(rows.slice(3).map(r=>r.status),["timeout","timeout"]);
assert.equal(rows[0].answer,"answer-for-q-0");
assert.equal(rows[3].error.error,"no-output-before-idle-timeout");
});

test("elapsedMs is measured per answered question",async()=>{
const rows=await runStub({questionCount:3,perQuestionMs:80,answerCount:3,timeoutMs:5000});
for(const row of rows)assert.ok(typeof row.elapsedMs==="number"&&row.elapsedMs>=0,`elapsedMs should be measured, got ${row.elapsedMs}`);
});
