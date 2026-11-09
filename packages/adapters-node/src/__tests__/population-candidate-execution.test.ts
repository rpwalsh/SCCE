// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { EventEmitter } from "node:events";
import { stat,unlink,rmdir } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { expect,it } from "vitest";
import type { Worker } from "node:worker_threads";
import type { CorpusSegmentationWorkerExecution,PagedPopulationCandidate,PreparedPagedPopulationWorkspace } from "@scce/kernel";
import type { PostgresStorageAdapter } from "../postgres.js";
import { createPopulationCandidateExecution,validatePopulationWorkerExecution } from "../population-candidate-execution.js";
const declaration:CorpusSegmentationWorkerExecution={backend:"node_workers.v1",workers:2,workerHeapMb:32,maxNodeRssBytes:8*1024**3,totalPgConnections:4,abortGraceMs:5};
const prepared:PreparedPagedPopulationWorkspace={rootPopulationId:"source",namespace:"fit",normalizationContractId:"normalization",sourceInventory:{id:"inventory",count:16},collections:[]};
const jobs=[1,2,3].map(populationCount=>({populationCount,label:`candidate.${populationCount}`,fit:"fit.partition.fit",holdout:"fit.partition.modelSelection"}));
const candidate=(populationCount:number):PagedPopulationCandidate=>({populationCount,assignments:`fit.candidate.${populationCount}.assignment.1`,estimators:[],priors:[],heldoutDataNats:0,modelNats:0,descriptionNats:0,collapsed:true,mergeBlocked:false,mergeDescriptionDeltaNats:null,heldoutRegressionPopulationIds:[]});
const storage={pool:{options:{max:2}},url:"postgresql://not-connected",schema:"fixture",requireInformationAccess:()=>({tenantId:"owner",principals:["owner"],compartments:[]})} as unknown as PostgresStorageAdapter;
class FakeWorker extends EventEmitter {
  exited=false;aborts=0;terminated=0;
  constructor(readonly initialization:unknown,readonly handler:(worker:FakeWorker,message:{type:string;job?:typeof jobs[number]})=>void){super();queueMicrotask(()=>this.emit("message",{type:"ready",bundleDigest:"bundle"}));}
  postMessage(message:{type:string;job?:typeof jobs[number]}){if(message.type==="abort")this.aborts++;this.handler(this,message);}
  exit(code=0){if(!this.exited){this.exited=true;this.emit("exit",code);}}
  async terminate(){this.terminated++;this.exit(1);return 1;}
}
const cast=(worker:FakeWorker)=>worker as unknown as Pick<Worker,"on"|"postMessage"|"terminate">;
it("bounds workers and PG reservations, orders completion slots and records aggregate process RSS",async()=>{
  const workers:FakeWorker[]=[],completed:number[]=[];let directory="";
  const execution=createPopulationCandidateExecution({storage,runId:"run",bounds:{pageRows:2,maxPageBytes:2048},declaration},{bundleDigest:async()=>"bundle",rss:()=>123456,onDirectory:value=>{directory=value;},
    worker:initialization=>{const worker=new FakeWorker(initialization,(worker,message)=>{
      if(message.type==="job"){const job=message.job!;setTimeout(()=>{completed.push(job.populationCount);worker.emit("message",{type:"result",populationCount:job.populationCount,candidate:candidate(job.populationCount)});},job.populationCount===1?10:0);}
      else if(message.type==="shutdown")worker.exit();
    });workers.push(worker);return cast(worker);}});
  expect((await execution.provider.fitCandidates(prepared,jobs)).map(row=>row.populationCount)).toEqual([1,2,3]);
  expect(completed[0]).toBe(2);expect(workers).toHaveLength(2);expect(workers.every(worker=>worker.exited)).toBe(true);
  expect(execution.receipt()).toMatchObject({peakNodeRssBytes:123456,coordinatorPgConnections:2,workerPgConnections:2,completedCandidates:3,bundleDigest:"bundle"});
  await expect(stat(directory)).rejects.toMatchObject({code:"ENOENT"});
});
it.each([false,true])("awaits all workers before cleaning a failed job directory (forced=%s)",async forced=>{
  const workers:FakeWorker[]=[];let directory="";
  const execution=createPopulationCandidateExecution({storage,runId:"run",bounds:{pageRows:2,maxPageBytes:2048},declaration},{bundleDigest:async()=>"bundle",rss:()=>123456,onDirectory:value=>{directory=value;},
    worker:initialization=>{const worker=new FakeWorker(initialization,(worker,message)=>{
      if(message.type==="job"){writeFileSync(`${directory}/scce-boundary-fit-abcdef.bin`,"private numeric spool");queueMicrotask(()=>worker.emit("message",{type:"error",error:"candidate source failed"}));}
      else if(message.type==="abort"&&!forced)setTimeout(()=>worker.exit(),1);
    });workers.push(worker);return cast(worker);}});
  await expect(execution.provider.fitCandidates(prepared,jobs)).rejects.toThrow("candidate source failed");
  expect(workers.every(worker=>worker.exited)).toBe(true);expect(workers.every(worker=>forced?worker.terminated===1:worker.aborts===1)).toBe(true);
  expect(execution.receipt()).toBeUndefined();await expect(stat(directory)).rejects.toMatchObject({code:"ENOENT"});
});
it("rejects unknown/exhausted resources and invalid declarations before starting workers",async()=>{
  expect(()=>validatePopulationWorkerExecution({...declaration,workers:0})).toThrow("declaration");
  expect(()=>createPopulationCandidateExecution({storage,runId:"run",bounds:{pageRows:2,maxPageBytes:2048},declaration:{...declaration,totalPgConnections:3}})).toThrow("PG connection");
  for(const rss of [0,declaration.maxNodeRssBytes+1]){
    let directory="",started=false;
    const execution=createPopulationCandidateExecution({storage,runId:"run",bounds:{pageRows:2,maxPageBytes:2048},declaration},{bundleDigest:async()=>"bundle",rss:()=>rss,onDirectory:value=>{directory=value;},worker:()=>{started=true;throw Error("must not start");}});
    await expect(execution.provider.fitCandidates(prepared,jobs)).rejects.toThrow(/RSS/);expect(started).toBe(false);await expect(stat(directory)).rejects.toMatchObject({code:"ENOENT"});
  }
});
it("cooperatively cancels active workers and rejects a changed executable handshake",async()=>{
  for(const mismatch of [false,true]){
    const controller=new AbortController(),workers:FakeWorker[]=[];
    const execution=createPopulationCandidateExecution({storage,runId:"run",bounds:{pageRows:2,maxPageBytes:2048},declaration,signal:controller.signal},{bundleDigest:async()=>mismatch?"expected":"bundle",rss:()=>123456,
      worker:initialization=>{const worker=new FakeWorker(initialization,(worker,message)=>{if(message.type==="abort")worker.exit();});workers.push(worker);
        if(!mismatch)queueMicrotask(()=>controller.abort(Error("owner cancelled")));return cast(worker);}});
    await expect(execution.provider.fitCandidates(prepared,jobs)).rejects.toThrow(mismatch?/response/:/cancelled/);expect(workers.every(worker=>worker.exited)).toBe(true);
  }
});
it("retains primary worker failure when owned-directory cleanup refuses an unknown file",async()=>{
  let directory="";const workers:FakeWorker[]=[];
  const execution=createPopulationCandidateExecution({storage,runId:"run",bounds:{pageRows:2,maxPageBytes:2048},declaration},{bundleDigest:async()=>"bundle",rss:()=>123456,
    onDirectory:value=>{directory=value;writeFileSync(`${value}/unknown-owned-by-test.txt`,"must not delete");},
    worker:initialization=>{const worker=new FakeWorker(initialization,(worker,message)=>{if(message.type==="job")worker.exit(1);if(message.type==="abort")worker.exit();});workers.push(worker);return cast(worker);}});
  try{
    let failure:unknown;try{await execution.provider.fitCandidates(prepared,jobs);}catch(error){failure=error;}
    expect(failure).toBeInstanceOf(AggregateError);expect((failure as AggregateError).errors.map(error=>String(error))).toEqual([expect.stringContaining("exited before completion"),expect.stringContaining("unowned file")]);
    expect(workers.every(worker=>worker.exited)).toBe(true);expect((await stat(`${directory}/unknown-owned-by-test.txt`)).isFile()).toBe(true);
  }finally{await unlink(`${directory}/unknown-owned-by-test.txt`);await rmdir(directory);}
});
