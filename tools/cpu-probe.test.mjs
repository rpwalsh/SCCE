// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {createHash} from "node:crypto";
import {readFile,mkdtemp,realpath,rm} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import path from "node:path";
import os from "node:os";
import {test} from "node:test";
import {parseCpuProbeArguments,cpuQuestionPacket,runCpuProbe} from "./lib/cpu-probe.mjs";
import {processSnapshot} from "./blind-comparison/process-resources.mjs";
const hash=value=>createHash("sha256").update(value).digest("hex");
const processRow=(pid,cpuSeconds,birth=`birth.${pid}`,parentPid=0)=>({pid,parentPid,cpuSeconds,birth,rssBytes:1024});
const snapshot=rows=>({rows,reason:null,elapsedMs:0});
async function httpFixture(t,status=200){
  const requests=[];
  const server=createServer(async(request,response)=>{
    requests.push({url:request.url,authorization:request.headers.authorization});
    if(request.headers.authorization!=="Bearer test-private-token"){response.writeHead(401).end('{}');return;}
    response.setHeader("content-type","application/json");
    if(request.url==="/api/ready"){response.end(JSON.stringify({ok:true,build:"fixture-build"}));return;}
    let body="";for await(const chunk of request)body+=chunk;requests.at(-1).body=JSON.parse(body);
    response.writeHead(status).end(JSON.stringify(status===200?{answer:"\u732b.e\u0301"}:{error:"not allowed"}));
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const config={server:{url:`http://127.0.0.1:${server.address().port}`},security:{apiBearerToken:"test-private-token"}};
  return {requests,config,dependencies:{loadConfig:async()=>config,environment:{}}};
}
const options=(mode="per-turn")=>({...parseCpuProbeArguments(["\u0416\u0443\u043a?","\u732b e\u0301?","--warm=0","--pids=10,20"]),mode});
test("both public wrappers use one helper without invented fixed comparisons or process-name guessing",async()=>{
  for(const file of ["cpu-now.mjs","cpu-per-turn.mjs"]){const source=await readFile(new URL(file,import.meta.url),"utf8");
    assert.match(source,/cpuProbeMain/u);assert.doesNotMatch(source,/23\.22|0\.40|Get-Process|commandLineIncludes|fetch\(/u);}
  assert.throws(()=>parseCpuProbeArguments(["--pids=1,1"]));assert.throws(()=>parseCpuProbeArguments(["--warm=NaN"]));assert.throws(()=>parseCpuProbeArguments(["--reference=fake-baseline"]));
});
test("packet hashes bind exact Unicode questions and reject hidden extra fields",async()=>{
  const bytes=Buffer.from(JSON.stringify({schema:"scce.cpu_question_packet.v1",questions:["\u732b e\u0301?"]}));
  const packet=await cpuQuestionPacket({...options(),packetPath:"public.json"},async()=>bytes);
  assert.equal(packet.fileSha256,hash(bytes));assert.equal(packet.sha256,hash(JSON.stringify(packet.packet)));
  await assert.rejects(cpuQuestionPacket({...options(),packetPath:"public.json"},async()=>Buffer.from('{"schema":"scce.cpu_question_packet.v1","questions":["q"],"gold":"forbidden"}')),/Unsupported/);
});
test("authenticated actual HTTP turns retain packet/body binding and explicit PID/birth CPU attribution",async t=>{
  const fixture=await httpFixture(t),samples=[snapshot([processRow(10,1),processRow(20,10)]),snapshot([processRow(10,1),processRow(20,10)]),
    snapshot([processRow(10,2),processRow(20,12)]),snapshot([processRow(10,2),processRow(20,12)]),snapshot([processRow(10,4),processRow(20,13)])];
  const result=await runCpuProbe(options(),{...fixture.dependencies,snapshot:async()=>samples.shift()});
  assert.equal(result.summary.cpuSeconds,6);assert.equal(result.summary.meanCpuSeconds,3);assert.equal(result.summary.cpuMeasuredTurns,2);
  assert.deepEqual(result.rows.map(row=>row.cpu.seconds),[3,3]);assert.deepEqual(fixture.requests.slice(1).map(row=>row.body),options().questions.map(text=>({text})));
  assert.ok(fixture.requests.every(row=>row.authorization==="Bearer test-private-token"));assert.equal(result.rows[0].requestBodySha256,hash(JSON.stringify(fixture.requests[1].body)));
  assert.equal(result.referenceComparison,null);assert.equal(result.qualityEvaluation,false);assert.equal(result.candidate.buildBinding,"not_attested");
  assert.equal(JSON.stringify(result).includes("test-private-token"),false);
});
test("batch mode brackets the whole actual packet with one CPU window",async t=>{
  const fixture=await httpFixture(t),samples=[1,1,4].map(cpu=>snapshot([processRow(10,cpu),processRow(20,cpu*2)]));
  const result=await runCpuProbe(options("batch"),{...fixture.dependencies,snapshot:async()=>samples.shift()});
  assert.equal(result.batchCpu.seconds,9);assert.equal(result.summary.meanCpuSeconds,4.5);assert.equal(result.rows[0].cpu,undefined);assert.equal(samples.length,0);
});
test("missing, nonfinite, reused or exited process counters remain unknown rather than zero",async t=>{
  const fixture=await httpFixture(t);
  const cases=[{rows:null,reason:"probe-unavailable"},snapshot([processRow(10,null),processRow(20,2)]),snapshot([processRow(10,2,"reused"),processRow(20,2)]),snapshot([processRow(20,2)])];
  for(const after of cases){const baseline=snapshot([processRow(10,1),processRow(20,1)]),samples=[baseline,baseline,after];
    const input={...options("batch"),questions:["q"]};const result=await runCpuProbe(input,{...fixture.dependencies,snapshot:async()=>samples.shift()});
    assert.equal(result.summary.cpuSeconds,null);assert.equal(result.summary.meanCpuSeconds,null);assert.ok(result.summary.cpuReason);}
  const initial=snapshot([processRow(10,1),processRow(20,1),processRow(11,1,"birth.11",10)]),after=snapshot([processRow(10,2),processRow(20,2)]),samples=[initial,initial,after];
  const result=await runCpuProbe({...options("batch"),questions:["q"]},{...fixture.dependencies,snapshot:async()=>samples.shift()});
  assert.equal(result.batchCpu.seconds,null);assert.equal(result.batchCpu.reason,"process-exited-between-samples");
});
test("the existing native process parser rejects actual NaN CPU output",async()=>{
  const result=await processSnapshot({}, {platform:"win32",exec:async()=>({stdout:JSON.stringify([{pid:10,parentPid:0,birth:"known",rssBytes:1,cpuTicks:"NaN"}])})});
  assert.equal(result.rows,null);assert.ok(result.reason);
});
test("auth and request failures cannot become cheap successful measurements",async t=>{
  const fixture=await httpFixture(t,403);
  await assert.rejects(runCpuProbe({...options(),pids:[]},fixture.dependencies),/HTTP 403/);
  const wrong={...fixture.dependencies,loadConfig:async()=>({...fixture.config,security:{apiBearerToken:"wrong"}})};
  await assert.rejects(runCpuProbe({...options(),pids:[]},wrong),/HTTP 401/);
});
test("actual public CLIs authenticate HTTP and preserve unavailable process CPU without literal baseline claims",async t=>{
  const fixture=await httpFixture(t),tempRoot=await realpath(os.tmpdir()),directory=await realpath(await mkdtemp(path.join(tempRoot,"scce-cpu-probe-test-")));
  try{
    const configSource=`export async function readScceRuntimeConfig(){return ${JSON.stringify(fixture.config)};}`;
    const processSource=`export function spawnSync(){return {status:0,stdout:'NaN NaN\\n',stderr:''};}export function execFile(_file,_args,_options,done){done(null,{stdout:'[]',stderr:''});}`;
    const preload=`import{registerHooks}from'node:module';registerHooks({resolve(specifier,context,next){if(specifier.endsWith('/dist/config.js'))return{url:'fixture:config',shortCircuit:true};if(specifier==='node:child_process')return{url:'fixture:process',shortCircuit:true};return next(specifier,context);},load(url,context,next){if(url==='fixture:config')return{format:'module',source:${JSON.stringify(configSource)},shortCircuit:true};if(url==='fixture:process')return{format:'module',source:${JSON.stringify(processSource)},shortCircuit:true};return next(url,context);}});`;
    const hook=`data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`;
    for(const file of ["cpu-now.mjs","cpu-per-turn.mjs"]){
      const {stdout}=await promisify(execFile)(process.execPath,["--import",hook,fileURLToPath(new URL(file,import.meta.url)),"opaque \u732b?","--warm=0","--pids=10,20","--config=fixture.config.json","--out=measured.json"],{
        cwd:directory,timeout:10000,encoding:"utf8",env:{...process.env,SCCE_SERVER_URL:fixture.config.server.url,SCCE_API_BEARER_TOKEN:"test-private-token"}});
      assert.doesNotMatch(stdout,/23\.22|0\.40|frozen baseline/u);const result=JSON.parse(stdout);
      assert.equal(result.summary.cpuSeconds,null);assert.ok(result.summary.cpuReason);assert.equal(result.rows[0].httpStatus,200);assert.equal(result.referenceComparison,null);
    }
    assert.ok(fixture.requests.every(request=>request.authorization==="Bearer test-private-token"));
  }finally{
    assert.equal(path.dirname(directory),tempRoot);assert.ok(path.basename(directory).startsWith("scce-cpu-probe-test-"));await rm(directory,{recursive:true,force:true});
  }
});
test("a measured zero remains zero, but counter reset is unavailable",async t=>{
  const fixture=await httpFixture(t),baseline=snapshot([processRow(10,2),processRow(20,2)]);
  for(const after of [baseline,snapshot([processRow(10,1),processRow(20,3)])]){
    const samples=[baseline,baseline,after];const result=await runCpuProbe({...options("batch"),questions:["q"]},{...fixture.dependencies,snapshot:async()=>samples.shift()});
    assert.equal(result.summary.cpuSeconds,after===baseline?0:null);
  }
});
