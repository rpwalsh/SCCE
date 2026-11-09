// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { Worker } from "node:worker_threads";
import { mkdtemp, lstat, readdir, unlink, rmdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getHeapStatistics } from "node:v8";
import type { CorpusSegmentationWorkerExecution, CorpusSegmentationExecutionReceipt, PagedPopulationCandidateExecution,
  PagedPopulationCandidate, PagedPopulationCandidateJob, SegmentationPageBounds } from "@scce/kernel";
import type { PostgresStorageAdapter } from "./postgres.js";
import { populationWorkerBundleDigest } from "./population-candidate-worker-contract.js";

export function validatePopulationWorkerExecution(value:CorpusSegmentationWorkerExecution):CorpusSegmentationWorkerExecution{
  const keys=["backend","workers","workerHeapMb","maxNodeRssBytes","totalPgConnections","abortGraceMs"];
  if(!value||value.backend!=="node_workers.v1"||Object.keys(value).some(key=>!keys.includes(key))
    ||keys.slice(1).some(key=>!Number.isSafeInteger(value[key as keyof typeof value])||Number(value[key as keyof typeof value])<1))throw Error("Invalid population candidate execution declaration");
  return Object.freeze({...value});
}
type ExecutionWorker=Pick<Worker,"on"|"postMessage"|"terminate">;
interface Dependencies {
  coordinatorHeapLimitBytes?:()=>number;
  worker?:(initialization:unknown,heapMb:number)=>ExecutionWorker;
  bundleDigest?:()=>Promise<string>;rss?:()=>number;onDirectory?:(directory:string)=>void;
}
/** The coordinator alone retains the run lease; workers receive only prepared immutable inputs and unique candidate labels. */
export function createPopulationCandidateExecution(input:{storage:PostgresStorageAdapter;runId:string;bounds:SegmentationPageBounds;
  declaration:CorpusSegmentationWorkerExecution;signal?:AbortSignal},dependencies:Dependencies={}):{provider:PagedPopulationCandidateExecution;receipt:()=>CorpusSegmentationExecutionReceipt|undefined}{
  const declaration=validatePopulationWorkerExecution(input.declaration),coordinatorPgConnections=input.storage.pool.options.max??10;
  if(!Number.isSafeInteger(coordinatorPgConnections)||coordinatorPgConnections<1||declaration.totalPgConnections<coordinatorPgConnections+declaration.workers)throw Error("Population worker PG connection reservation exceeds declaration");
  const coordinatorHeapLimitBytes=(dependencies.coordinatorHeapLimitBytes??(()=>getHeapStatistics().heap_size_limit))();
  if(!Number.isSafeInteger(coordinatorHeapLimitBytes)||coordinatorHeapLimitBytes<1
    ||declaration.maxNodeRssBytes<coordinatorHeapLimitBytes+declaration.workers*(declaration.workerHeapMb*1024*1024+64*1024*1024))throw Error("Population worker Node memory declaration cannot reserve coordinator heap, worker heaps and page budgets");
  let receipt:CorpusSegmentationExecutionReceipt|undefined;
  return {receipt:()=>receipt,provider:{async fitCandidates(prepared,jobs){
    input.signal?.throwIfAborted();
    const bundleDigest=await(dependencies.bundleDigest??populationWorkerBundleDigest)(),directory=await mkdtemp(path.join(tmpdir(),"scce-population-job-"));
    let identity:Awaited<ReturnType<typeof lstat>>;
    try{identity=await lstat(directory);await chmod(directory,0o700);}
    catch(error){try{await rmdir(directory);}catch(cleanup){throw new AggregateError([error,cleanup],"Population job directory preparation and cleanup failed");}throw error;}
    const records:Array<{worker:ExecutionWorker;exited:Promise<void>;done:boolean;job?:PagedPopulationCandidateJob}>=[];
    let failed=false,primary:unknown,finished=0,next=0,peak=0,forced:ReturnType<typeof setTimeout>|undefined,monitor:ReturnType<typeof setInterval>|undefined;
    let resolve!:()=>void,reject!:(error:unknown)=>void;const barrier=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
    void barrier.catch(()=>{});
    const results:Array<PagedPopulationCandidate|undefined>=new Array(jobs.length);
    const fail=(error:unknown)=>{
      if(failed)return;failed=true;primary=error;
      for(const record of records)if(!record.done)record.worker.postMessage({type:"abort"});
      forced=setTimeout(()=>{for(const record of records)if(!record.done)void record.worker.terminate();},declaration.abortGraceMs);
      reject(error);
    };
    const sample=()=>{const rss=(dependencies.rss??(()=>Math.max(process.memoryUsage().rss,process.resourceUsage().maxRSS*1024)))();if(!Number.isSafeInteger(rss)||rss<1){fail(Error("Population worker RSS measurement unavailable"));return;}
      peak=Math.max(peak,rss);if(rss>declaration.maxNodeRssBytes)fail(Error("Population candidate aggregate Node RSS budget exceeded"));};
    const aborted=()=>fail(input.signal?.reason??Error("Population candidate execution cancelled"));
    const dispatch=(record:typeof records[number])=>{
      if(failed)return;
      const job=jobs[next++];if(!job){record.worker.postMessage({type:"shutdown"});return;}
      record.job=job;record.worker.postMessage({type:"job",job});
    };
    try{
      dependencies.onDirectory?.(directory);sample();if(failed)throw primary;
      input.signal?.addEventListener("abort",aborted,{once:true});monitor=setInterval(sample,100);
      for(let index=0;index<Math.min(declaration.workers,jobs.length);index++){
        const initialization={schema:"scce.population_candidate_worker.v1",storage:{url:input.storage.url,schema:input.storage.schema,
          ssl:input.storage.pool.options.ssl,informationAccess:input.storage.requireInformationAccess()},runId:input.runId,bounds:input.bounds,prepared,bundleDigest,directory};
        const worker=dependencies.worker?dependencies.worker(initialization,declaration.workerHeapMb):new Worker(new URL("./population-candidate-worker.js",import.meta.url),{
          workerData:initialization,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:declaration.workerHeapMb,stackSizeMb:8}});
        let exited!:()=>void;const record={worker,exited:new Promise<void>(yes=>{exited=yes;}),done:false,job:undefined as PagedPopulationCandidateJob|undefined};records.push(record);
        worker.on("message",(message:{type?:string;bundleDigest?:string;populationCount?:number;candidate?:PagedPopulationCandidate;error?:string})=>{
          if(failed)return;
          if(message.type==="ready"&&message.bundleDigest===bundleDigest&&!record.job){dispatch(record);return;}
          if(message.type!=="result"||!record.job||message.populationCount!==record.job.populationCount||!message.candidate){fail(Error(message.type==="error"?message.error??"Population worker failed":"Invalid population worker response"));return;}
          const slot=record.job.populationCount-1;if(results[slot]){fail(Error("Duplicate population worker candidate"));return;}
          results[slot]=message.candidate;record.job=undefined;finished++;sample();
          if(finished===jobs.length)resolve();dispatch(record);
        });
        worker.on("error",fail);
        worker.on("exit",(code:number)=>{record.done=true;exited();if(!failed&&(code!==0||record.job||finished<jobs.length&&next<jobs.length))fail(Error(`Population worker exited before completion (${code})`));});
      }
      if(!jobs.length)resolve();
      await barrier;
      await Promise.all(records.map(record=>record.exited));sample();if(failed)throw primary;
      receipt={schema:"scce.population_candidate_execution.v1",declaration,peakNodeRssBytes:peak,coordinatorPgConnections,
        workerPgConnections:records.length,bundleDigest,completedCandidates:finished,rssSamplingIntervalMs:100};
      return results as PagedPopulationCandidate[];
    }catch(error){fail(error);await Promise.all(records.map(record=>record.exited));throw primary;}
    finally{
      if(monitor)clearInterval(monitor);if(forced)clearTimeout(forced);input.signal?.removeEventListener("abort",aborted);
      const cleanup:unknown[]=[];
      try{
        const current=await lstat(directory);if(!current.isDirectory()||current.isSymbolicLink()||current.ino!==identity.ino||current.dev!==identity.dev)throw Error("Population job directory identity changed");
        for(const name of await readdir(directory)){
          if(!/^scce-boundary-fit-[a-f0-9-]+\.bin$/u.test(name))throw Error("Population job directory contains an unowned file");
          const file=path.join(directory,name),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error("Population job temporary file is not owned regular storage");await unlink(file);
        }await rmdir(directory);
      }catch(error){cleanup.push(error);}
      if(cleanup.length){if(failed)throw new AggregateError([primary,...cleanup],"Population worker execution and temporary storage cleanup failed");throw cleanup[0];}
    }
  }}};
}
