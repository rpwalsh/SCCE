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
import { createWorkerExecutionLifecycle, validateWorkerExecutionResources, type ExecutionWorker, type WorkerExecutionRecord } from "./worker-execution-lifecycle.js";

export function validatePopulationWorkerExecution(value:CorpusSegmentationWorkerExecution):CorpusSegmentationWorkerExecution{
  const keys=["backend","workers","workerHeapMb","maxNodeRssBytes","totalPgConnections","abortGraceMs"];
  if(!value||value.backend!=="node_workers.v1"||Object.keys(value).some(key=>!keys.includes(key))
    ||!Number.isSafeInteger(value.totalPgConnections)||value.totalPgConnections<1)throw Error("Invalid population candidate execution declaration");
  return validateWorkerExecutionResources(value);
}
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
  validateWorkerExecutionResources(declaration,coordinatorHeapLimitBytes);
  let receipt:CorpusSegmentationExecutionReceipt|undefined;
  return {receipt:()=>receipt,provider:{async fitCandidates(prepared,jobs){
    input.signal?.throwIfAborted();
    const bundleDigest=await(dependencies.bundleDigest??populationWorkerBundleDigest)(),directory=await mkdtemp(path.join(tmpdir(),"scce-population-job-"));
    let identity:Awaited<ReturnType<typeof lstat>>;
    try{identity=await lstat(directory);await chmod(directory,0o700);}
    catch(error){try{await rmdir(directory);}catch(cleanup){throw new AggregateError([error,cleanup],"Population job directory preparation and cleanup failed");}throw error;}
    const records:Array<WorkerExecutionRecord&{job?:PagedPopulationCandidateJob}>=[];
    let finished=0,next=0;
    let resolve!:()=>void,reject!:(error:unknown)=>void;const barrier=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
    void barrier.catch(()=>{});
    const results:Array<PagedPopulationCandidate|undefined>=new Array(jobs.length);
    const lifecycle=createWorkerExecutionLifecycle({declaration,signal:input.signal,coordinatorHeapLimitBytes,rss:dependencies.rss,onFailure:reject});
    const fail=(error:unknown)=>lifecycle.fail(error),sample=()=>lifecycle.sample();
    const dispatch=(record:typeof records[number])=>{
      if(lifecycle.failed)return;
      const job=jobs[next++];if(!job){record.worker.postMessage({type:"shutdown"});return;}
      record.job=job;record.worker.postMessage({type:"job",job});
    };
    try{
      dependencies.onDirectory?.(directory);lifecycle.start();if(lifecycle.failed)throw lifecycle.error;
      for(let index=0;index<Math.min(declaration.workers,jobs.length)&&!lifecycle.failed;index++){
        const initialization={schema:"scce.population_candidate_worker.v1",storage:{url:input.storage.url,schema:input.storage.schema,
          ssl:input.storage.pool.options.ssl,informationAccess:input.storage.requireInformationAccess()},runId:input.runId,bounds:input.bounds,prepared,bundleDigest,directory};
        const worker=dependencies.worker?dependencies.worker(initialization,declaration.workerHeapMb):new Worker(new URL("./population-candidate-worker.js",import.meta.url),{
          workerData:initialization,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:declaration.workerHeapMb,stackSizeMb:8}});
        const record=Object.assign(lifecycle.track(worker),{job:undefined as PagedPopulationCandidateJob|undefined});records.push(record);
        worker.on("message",(message:{type?:string;bundleDigest?:string;populationCount?:number;candidate?:PagedPopulationCandidate;error?:string})=>{
          if(lifecycle.failed)return;
          if(message.type==="ready"&&message.bundleDigest===bundleDigest&&!record.job){dispatch(record);return;}
          if(message.type!=="result"||!record.job||message.populationCount!==record.job.populationCount||!message.candidate){fail(Error(message.type==="error"?message.error??"Population worker failed":"Invalid population worker response"));return;}
          const slot=record.job.populationCount-1;if(results[slot]){fail(Error("Duplicate population worker candidate"));return;}
          results[slot]=message.candidate;record.job=undefined;finished++;sample();
          if(finished===jobs.length)resolve();dispatch(record);
        });
        worker.on("exit",(code:number)=>{if(!lifecycle.failed&&(code!==0||record.job||finished<jobs.length&&next<jobs.length))fail(Error(`Population worker exited before completion (${code})`));});
      }
      if(!jobs.length)resolve();
      await barrier;
      await lifecycle.drain();sample();if(lifecycle.failed)throw lifecycle.error;
      receipt={schema:"scce.population_candidate_execution.v1",declaration,peakNodeRssBytes:lifecycle.peakRss,coordinatorPgConnections,
        workerPgConnections:records.length,bundleDigest,completedCandidates:finished,rssSamplingIntervalMs:100};
      return results as PagedPopulationCandidate[];
    }catch(error){fail(error);await lifecycle.drain();throw lifecycle.error;}
    finally{
      lifecycle.dispose();
      const cleanup:unknown[]=[];
      try{
        const current=await lstat(directory);if(!current.isDirectory()||current.isSymbolicLink()||current.ino!==identity.ino||current.dev!==identity.dev)throw Error("Population job directory identity changed");
        for(const name of await readdir(directory)){
          if(!/^scce-boundary-fit-[a-f0-9-]+\.bin$/u.test(name))throw Error("Population job directory contains an unowned file");
          const file=path.join(directory,name),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error("Population job temporary file is not owned regular storage");await unlink(file);
        }await rmdir(directory);
      }catch(error){cleanup.push(error);}
      if(cleanup.length){if(lifecycle.failed)throw new AggregateError([lifecycle.error,...cleanup],"Population worker execution and temporary storage cleanup failed");throw cleanup[0];}
    }
  }}};
}
