import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { createInterface } from "node:readline";
import path from "node:path";
import { ensureDir, readJson, readJsonl, sha256File, shuffled, writeJson, writeJsonl } from "./util.mjs";
import { startConditionMeasurement } from "./power-measurement.mjs";
import { assertHostPreconditions, captureHostConfiguration } from "./host-configuration.mjs";

// Gold and protected metadata belong to the scorer. Only declared public
// question fields may cross the adapter boundary, even in a local rehearsal.
export function publicQuestion(question) {
  return Object.fromEntries(["schemaVersion", "questionId", "category", "prompt", "conversationId", "turnIndex", "language", "resourceClass", "timeLimitMs"]
    .filter(key => question[key] !== undefined).map(key => [key, question[key]]));
}

export async function runSystems(planPath) {
  const plan = await readJson(planPath);
  const questions0 = await readJsonl(plan.questionsPath);
  const systemManifest = await readJson(plan.systemManifest);
  let systems = systemManifest.systems;
  let questions = questions0.map(publicQuestion);
  if (plan.questionOrder === "seeded-random") questions = shuffled(questions, `${plan.seed}:questions`);
  if (plan.conditionOrder === "seeded-random") systems = shuffled(systems, `${plan.seed}:systems`);
  const inputHashes = {
    questions: await sha256File(plan.questionsPath),
    corpusManifest: await sha256File(plan.corpusManifest),
    systemManifest: await sha256File(plan.systemManifest),
    plan: await sha256File(planPath)
  };
  const outDir = path.resolve(plan.outputDirectory);
  await ensureDir(path.join(outDir, "stderr"));
  await ensureDir(path.join(outDir, "power"));
  if (plan.captureHostConfiguration === true) {
    const hostPath = path.join(outDir, "host-configuration.json");
    const hostConfiguration = await captureHostConfiguration(systems);
    await writeJson(hostPath, hostConfiguration);
    inputHashes.hostConfiguration = await sha256File(hostPath);
    assertHostPreconditions(plan.hostPreconditions, hostConfiguration);
  }
  const all = [], measurements = [];
  for (const system of systems) {
    const meter = await startConditionMeasurement(plan.powerMeasurement);
    let rows;
    try {
      rows = system.mode === "per-question"
        ? await runPerQuestion(system, questions, plan, outDir)
        : await runSession(system, questions, plan, outDir);
    } finally {
      const { samples, ...measurement } = await meter.stop();
      const samplePath = path.join(outDir, "power", `${safe(system.systemId)}__${safe(system.conditionId)}.jsonl`);
      await writeJsonl(samplePath, samples);
      measurements.push({
        schemaVersion: "1.0", runId: plan.runId, systemId: system.systemId, conditionId: system.conditionId,
        mode: system.mode, expectedQuestionCount: questions.length,
        accountingWindow: "adapter-spawn-through-exit-including-startup-and-failures",
        inputHashes, powerSamplesPath: path.relative(outDir, samplePath), powerSamplesSha256: await sha256File(samplePath),
        ...measurement
      });
      await writeJsonl(path.join(outDir, "run-measurements.jsonl"), measurements);
    }
    all.push(...rows);
    await writeJsonl(path.join(outDir, "raw-answers.jsonl"), all);
  }
  return all;
}

// timeoutMs is a per-question progress budget in both modes, not a cap on the
// whole session. In session mode one process answers every question, so a
// single whole-session timer conflates "this system is hung" with "this system
// is slower than one operator's guess at a total" -- and a system that answers
// every question correctly at 36s each fails a 25-minute total purely on
// question count. The watchdog here fires only after a full budget elapses with
// no new answer line, so steady progress is never killed for being slow.
//
// Answers that already arrived are kept when the watchdog does fire. Marking
// every question "timeout" because the process was killed after the last one
// discards real, completed measurements and reports a hang as universal
// failure; only questions with no output line are attributed to the timeout.
async function runSession(system,questions,plan,outDir){const started=Date.now();const child=spawn(system.command[0],system.command.slice(1),{cwd:system.cwd??process.cwd(),env:{...process.env,...system.env,SCCE_EVAL_RUN_ID:plan.runId,SCCE_EVAL_SEED:plan.seed,SCCE_EVAL_CLOCK:plan.clock,SCCE_EVAL_CORPUS_MANIFEST:path.resolve(plan.corpusManifest)},stdio:["pipe","pipe","pipe"]});const errPath=path.join(outDir,"stderr",`${safe(system.systemId)}__${safe(system.conditionId)}.log`);child.stderr.pipe(createWriteStream(errPath));const rl=createInterface({input:child.stdout,crlfDelay:Infinity});const outputs=[],arrivals=[];let lastProgress=Date.now();rl.on("line",line=>{outputs.push(line);arrivals.push(Date.now());lastProgress=Date.now();});for(const q of questions)child.stdin.write(`${JSON.stringify(q)}\n`);child.stdin.end();const budget=system.timeoutMs??120000;let timedOut=false;const tick=Math.max(250,Math.min(budget,5000));const timer=setInterval(()=>{if(Date.now()-lastProgress>=budget){timedOut=true;clearInterval(timer);child.kill("SIGKILL");}},tick);const [code,signal]=await once(child,"exit");clearInterval(timer);const parsed=[];let previous=started;for(let i=0;i<questions.length;i++){const q=questions[i],line=outputs[i];if(line===undefined){parsed.push(base(plan,system,q,timedOut?"timeout":"crash","",{code,signal,error:timedOut?"no-output-before-idle-timeout":"missing-output"}));continue;}const measured=arrivals[i]-previous;previous=arrivals[i];try{const result=JSON.parse(line);const row={...base(plan,system,q,result.status??"ok",String(result.answer??result.text??""),null),...result,schemaVersion:"1.0",runId:plan.runId,systemId:system.systemId,conditionId:system.conditionId,questionId:q.questionId,attempt:1};row.observedElapsedMs=measured;row.elapsedMs??=measured;parsed.push(row);}catch(error){parsed.push(base(plan,system,q,"malformed",line,{error:error.message}));}}
if(outputs.length>questions.length)parsed.push(base(plan,system,{questionId:"__EXTRA_OUTPUT__"},"malformed",outputs.slice(questions.length).join("\n"),{error:"extra-output-lines"}));return parsed;}
async function runPerQuestion(system,questions,plan,outDir){const rows=[];for(const q of questions){const questionStarted=performance.now();const child=spawn(system.command[0],system.command.slice(1),{cwd:system.cwd??process.cwd(),env:{...process.env,...system.env,SCCE_EVAL_RUN_ID:plan.runId,SCCE_EVAL_SEED:plan.seed,SCCE_EVAL_CLOCK:plan.clock,SCCE_EVAL_QUESTION_JSON:JSON.stringify(q),SCCE_EVAL_CORPUS_MANIFEST:path.resolve(plan.corpusManifest)},stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";child.stdout.on("data",d=>stdout+=d);child.stderr.on("data",d=>stderr+=d);let timedOut=false;const timer=setTimeout(()=>{timedOut=true;child.kill("SIGKILL");},system.timeoutMs??120000);const [code,signal]=await once(child,"exit");clearTimeout(timer);const observedElapsedMs=performance.now()-questionStarted;await ensureDir(path.join(outDir,"stderr"));createWriteStream(path.join(outDir,"stderr",`${safe(system.systemId)}__${safe(system.conditionId)}__${safe(q.questionId)}.log`)).end(stderr);if(timedOut)rows.push(base(plan,system,q,"timeout","",{code,signal}));else try{const result=JSON.parse(stdout.trim());rows.push({...base(plan,system,q,result.status??"ok",String(result.answer??result.text??""),null),...result,schemaVersion:"1.0",runId:plan.runId,systemId:system.systemId,conditionId:system.conditionId,questionId:q.questionId,attempt:1});}catch(e){rows.push(base(plan,system,q,code===0?"malformed":"crash",stdout,{code,signal,error:e.message}));}rows[rows.length-1].observedElapsedMs=observedElapsedMs;rows[rows.length-1].elapsedMs??=observedElapsedMs;}return rows;}
function base(plan,system,q,status,answer,error){return{schemaVersion:"1.0",runId:plan.runId,systemId:system.systemId,conditionId:system.conditionId,questionId:q.questionId,attempt:1,status,answer,citations:[],elapsedMs:null,error};}function safe(v){return String(v).replace(/[^a-z0-9_.-]+/giu,"_");}
