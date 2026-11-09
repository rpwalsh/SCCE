// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {createHash,randomUUID} from "node:crypto";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {createScceMeasurementClient} from "../head-to-head/scce-client.mjs";
import {processSnapshot,createProcessTracker,validateProcessPolicy} from "../blind-comparison/process-resources.mjs";
const hash=value=>createHash("sha256").update(value).digest("hex");
const positive=value=>Number.isSafeInteger(value)&&value>0;
const measured=value=>typeof value==="number"&&Number.isFinite(value)&&value>=0;
const DEFAULT_QUESTIONS=["Who was Ada Lovelace?","When did Apollo 11 land on the Moon?","What is the capital of Albania?","When was Ada Lovelace born?"];

export function parseCpuProbeArguments(args){
  const result={warm:2,repeat:1,requestTimeoutMs:120000,pids:[],questions:[]};
  const strings={config:"config",server:"serverUrl",packet:"packetPath",out:"outputPath"},numbers={warm:"warm",repeat:"repeat","request-timeout-ms":"requestTimeoutMs"};
  const seen=new Set();
  for(let index=0;index<args.length;index++){
    const arg=args[index];if(!arg.startsWith("--")){result.questions.push(arg);continue;}
    const equals=arg.indexOf("="),name=arg.slice(2,equals<0?undefined:equals),value=equals<0?args[++index]:arg.slice(equals+1);
    if(seen.has(name)||typeof value!=="string"||!value||value.startsWith("--"))throw Error("Invalid CPU probe argument");seen.add(name);
    if(strings[name])result[strings[name]]=value;
    else if(numbers[name]){const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed<(name==="warm"?0:1))throw Error("Invalid CPU probe numeric bound");result[numbers[name]]=parsed;}
    else if(name==="pids"){result.pids=value.split(",").map(Number);if(result.pids.some(pid=>!positive(pid))||new Set(result.pids).size!==result.pids.length)throw Error("Declare unique positive process IDs");}
    else throw Error(`Unsupported CPU probe option --${name}`);
  }
  if(result.packetPath&&result.questions.length)throw Error("Choose a question packet or positional questions");
  if(result.questions.some(text=>!text.trim()))throw Error("Questions must be nonempty");
  return result;
}
export async function cpuQuestionPacket(options,read=readFile){
  let packet,fileSha256=null;
  if(options.packetPath){const bytes=await read(options.packetPath);fileSha256=hash(bytes);packet=JSON.parse(bytes.toString("utf8"));
    if(!packet||packet.schema!=="scce.cpu_question_packet.v1"||Object.keys(packet).some(key=>key!=="schema"&&key!=="questions"))throw Error("Unsupported CPU question packet");
  }else packet={schema:"scce.cpu_question_packet.v1",questions:options.questions.length?options.questions:[...DEFAULT_QUESTIONS]};
  if(!Array.isArray(packet.questions)||!packet.questions.length||packet.questions.some(text=>typeof text!=="string"||!text.trim()))throw Error("Question packet requires actual nonempty text");
  return {packet:structuredClone(packet),sha256:hash(JSON.stringify(packet)),fileSha256};
}
function scopeProblem(snapshot,roots){
  if(!snapshot.rows)return snapshot.reason??"process-probe-unavailable";
  const all=new Set();
  for(const root of roots){
    const found=snapshot.rows.find(row=>row.pid===root.pid);if(!found)return "declared-process-missing";
    if(!found.birth||found.birth!==root.birth)return "declared-process-identity-changed";
    const ids=new Set([root.pid]);
    for(;;){const size=ids.size;for(const row of snapshot.rows)if(ids.has(row.parentPid))ids.add(row.pid);if(size===ids.size)break;}
    for(const row of snapshot.rows)if(ids.has(row.pid)){
      if(all.has(row.pid))return "overlapping-process-trees";all.add(row.pid);
      if(!row.birth||!measured(row.cpuSeconds))return "process-cpu-unavailable";
    }
  }
  return null;
}
function cpuResult(policy,before,after){
  if(!policy)return {seconds:null,reason:"process-scope-not-declared",scopes:[]};
  const roots=policy.systems.scce.sharedDaemons,problem=scopeProblem(before,roots)??scopeProblem(after,roots);
  if(problem)return {seconds:null,reason:problem,scopes:[]};
  const tracker=createProcessTracker(policy,"scce");tracker.baseline(before);tracker.sample(after);
  const result=tracker.result(),scopes=result.scopes.filter(scope=>scope.scope==="shared-daemon-tree");
  const incomplete=scopes.some(scope=>!scope.baselineKnown||!scope.samples||scope.missingRootSamples||scope.pidReuseSamples||scope.unknownCounterSamples||!measured(scope.observedCpuSeconds));
  const exited=scopes.some(scope=>scope.exitedObservedProcesses>0);
  return {seconds:incomplete||exited?null:scopes.reduce((sum,scope)=>sum+scope.observedCpuSeconds,0),reason:exited?"process-exited-between-samples":incomplete?"incomplete-process-cpu":null,
    scopes:scopes.map(scope=>({id:scope.id,pid:scope.pid,birth:scope.birth,cpuSeconds:scope.observedCpuSeconds,observedProcesses:scope.observedProcesses})),
    coverage:result.cpuCoverage};
}
export async function runCpuProbe(options,dependencies={}){
  const measurementId=randomUUID(),startedAt=new Date().toISOString();
  const readConfig=dependencies.loadConfig??(await import("../../packages/adapters-node/dist/config.js")).readScceRuntimeConfig;
  const configPath=options.config??process.env.SCCE_CONFIG??fileURLToPath(new URL("../../scce.config.json",import.meta.url)),config=await readConfig(configPath);
  const environment=dependencies.environment??process.env,serverUrl=options.serverUrl??environment.SCCE_SERVER_URL??config.server.url;
  const client=await createScceMeasurementClient({serverUrl,requestTimeoutMs:options.requestTimeoutMs,configPath,environment,loadConfig:async()=>config});
  const readiness=await client.ready(),questionPacket=await cpuQuestionPacket(options,dependencies.readFile??readFile);
  const snapshot=dependencies.snapshot??processSnapshot,initial=options.pids.length?await snapshot():null;
  let policy=null,policyReason=null;
  if(options.pids.length){
    const roots=options.pids.map(pid=>{const row=initial.rows?.find(row=>row.pid===pid);return {id:`declared.${pid}`,pid,birth:row?.birth??null};});
    if(roots.some(root=>!root.birth))policyReason=initial.reason??"declared-process-unavailable";
    else policy=validateProcessPolicy({schema:"scce.blind-process-policy.v1",provider:"trusted-host-native-process-table.v1",sampleIntervalMs:1,
      probeTimeoutMs:3000,maxProbeOutputBytes:8*1024*1024,rssBudgetBytes:null,systems:{scce:{sharedDaemons:roots}}});
  }
  const ask=async(text)=>{
    const started=performance.now(),result=await client.ask(text),wallMs=performance.now()-started;
    if(result.transportError||result.httpStatus===null)throw Error(`SCCE CPU probe request failed (HTTP ${result.httpStatus??"unavailable"})`);
    return {httpStatus:result.httpStatus,runtimeDeclined:result.runtimeDeclined,answered:result.answer.length>0,answerCharacters:[...result.answer].length,
      answerSha256:hash(result.answer),wallMs,questionSha256:hash(text),requestBodySha256:hash(JSON.stringify({text}))};
  };
  for(let index=0;index<options.warm;index++)await ask(questionPacket.packet.questions[index%questionPacket.packet.questions.length]);
  const rows=[],measureBefore=async()=>policy?await snapshot(policy):{rows:null,reason:policyReason??"process-scope-not-declared"};
  const before=options.mode==="batch"?await measureBefore():null;
  const started=performance.now();
  for(let pass=0;pass<options.repeat;pass++)for(let index=0;index<questionPacket.packet.questions.length;index++){
    const baseline=options.mode==="per-turn"?await measureBefore():null;
    const row={pass,index,...await ask(questionPacket.packet.questions[index])};
    if(options.mode==="per-turn"){const after=await measureBefore();row.cpu=policy?cpuResult(policy,baseline,after):{seconds:null,reason:policyReason??"process-scope-not-declared",scopes:[]};}
    rows.push(row);
  }
  const wallMs=rows.reduce((sum,row)=>sum+row.wallMs,0),batchElapsedMs=performance.now()-started;
  const batchCpu=options.mode==="batch"?(policy?cpuResult(policy,before,await measureBefore()):{seconds:null,reason:policyReason??"process-scope-not-declared",scopes:[]}):null;
  const cpuMeasuredTurns=options.mode==="batch"?(batchCpu.seconds===null?0:rows.length):rows.filter(row=>measured(row.cpu.seconds)).length;
  const cpuSeconds=cpuMeasuredTurns===rows.length?(batchCpu?.seconds??rows.reduce((sum,row)=>sum+row.cpu.seconds,0)):null;
  return {schema:"scce.public_cpu_probe.v1",measurementId,startedAt,finishedAt:new Date().toISOString(),measurementOnly:true,qualityEvaluation:false,referenceComparison:null,mode:options.mode,
    packet:questionPacket,requestPlanSha256:hash(JSON.stringify({packet:questionPacket.sha256,warm:options.warm,repeat:options.repeat})),
    candidate:{serverUrl:new URL(serverUrl).origin,readinessSha256:hash(JSON.stringify(readiness)),buildBinding:"not_attested",processPolicy:policy},
    warmupTurns:options.warm,rows,batchCpu,summary:{turns:rows.length,wallMs,meanWallMs:wallMs/rows.length,batchElapsedMs,cpuMeasuredTurns,cpuSeconds,
      meanCpuSeconds:cpuSeconds===null?null:cpuSeconds/rows.length,cpuReason:cpuSeconds===null?(batchCpu?.reason??"incomplete-cpu-coverage"):null},
    coverage:"Before/after counters for explicit PID/birth trees. Shared daemon CPU may include unrelated work; exited-process tails and between-sample processes are not recovered. No total-product RAM or answer-quality measurement."};
}
export async function cpuProbeMain(args,mode){
  const options={...parseCpuProbeArguments(args),mode},result=await runCpuProbe(options);
  if(options.outputPath||mode==="batch")await writeFile(options.outputPath??"cpu-now.json",JSON.stringify(result,null,2)+"\n");
  process.stdout.write(JSON.stringify(result,null,2)+"\n");
}
