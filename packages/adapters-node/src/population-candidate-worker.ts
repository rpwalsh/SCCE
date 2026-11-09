// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { parentPort, workerData } from "node:worker_threads";
import { PagedPopulationWorkspace, type CorpusSegmentationScratch, type CorpusSegmentationDocumentCursor, type PagedPopulationCandidateJob } from "@scce/kernel";
import { PostgresStorageAdapter } from "./postgres.js";
import { openCorpusSegmentationRun } from "./corpus-segmentation-store.js";
import { restoreCorpusSegmentationInput } from "./corpus-segmentation-producer.js";
import { createBoundaryFitNumericFile } from "./boundary-fit-numeric-file.js";
import { populationWorkerBundleDigest, type PopulationWorkerInitialization } from "./population-candidate-worker-contract.js";

const port=parentPort;if(!port)throw Error("Population candidate worker requires its coordinator");
const input=workerData as PopulationWorkerInitialization,controller=new AbortController();
let storage:PostgresStorageAdapter|undefined,active=false,closed=false;
const check=()=>controller.signal.throwIfAborted();
async function close(){if(closed)return;closed=true;try{await storage?.pool.end();}finally{port!.close();}}
function checkedScratch(scratch:CorpusSegmentationScratch):CorpusSegmentationScratch{return {...scratch,
  pages:async function*(query){for await(const page of scratch.pages(query)){check();yield page;}},
  putMany:async(collection,rows)=>{check();await scratch.putMany(collection,rows);},
  ...(scratch.boundaryMergeScratch?{boundaryMergeScratch:()=>{check();const lease=scratch.boundaryMergeScratch!();return {...lease,scratch:checkedScratch(lease.scratch)};}}:{})};}
async function main(){
  if(input.schema!=="scce.population_candidate_worker.v1"||await populationWorkerBundleDigest()!==input.bundleDigest)throw Error("Population worker executable bundle differs");
  storage=new PostgresStorageAdapter(input.storage);storage.pool.options.max=1;
  const run=await openCorpusSegmentationRun(storage,input.runId,input.bounds);if(await run.state()!=="fitting")throw Error("Population worker requires a fitting run");
  const source=await restoreCorpusSegmentationInput(storage,run);
  const guarded:CorpusSegmentationDocumentCursor={...source,
    statistics:document=>{const statistics=source.statistics(document);return {...statistics,rows:async function*(){for await(const page of statistics.rows()){check();yield page;}}};},
    scratch:{...checkedScratch(source.scratch),
      boundaryFitNumericReplay:async()=>{check();const replay=await createBoundaryFitNumericFile(input.bounds,{directory:input.directory});return {...replay,
        append:async(...args)=>{check();await replay.append(...args);},seal:async(...args)=>{check();await replay.seal(...args);},
        pages:async function*(...args){for await(const page of replay.pages(...args)){check();yield page;}}};},
      }};
  const work=new PagedPopulationWorkspace(guarded,input.prepared.rootPopulationId,input.prepared.namespace);await work.verifyPrepared(input.prepared);check();
  port!.on("message",(message:{type?:string;job?:PagedPopulationCandidateJob})=>{
    if(message.type==="abort"){controller.abort(Error("Population candidate execution cancelled"));if(!active)void close();return;}
    if(message.type==="shutdown"){if(active){controller.abort(Error("Population worker shutdown during job"));return;}void close();return;}
    if(message.type!=="job"||active||closed){port!.postMessage({type:"error",error:"Invalid population worker lifecycle"});controller.abort();if(!active)void close();return;}
    const job=message.job;
    if(!job||!Number.isSafeInteger(job.populationCount)||job.populationCount<1||job.label!==`candidate.${job.populationCount}`||job.fit!==work.partitions.fit||job.holdout!==work.partitions.modelSelection){port!.postMessage({type:"error",error:"Population job scope differs"});void close();return;}
    const ranking=input.prepared.fitRanking;
    if(!ranking||!job.ranking||ranking.collection!==job.ranking.collection||ranking.fit!==job.ranking.fit||ranking.documentCount!==job.ranking.documentCount){port!.postMessage({type:"error",error:"Population job ranking differs"});void close();return;}
    active=true;
    void(async()=>{try{const candidate=await work.fitCandidate(job.fit,job.holdout,job.populationCount,job.label,job.ranking);check();port!.postMessage({type:"result",populationCount:job.populationCount,candidate});}
      catch(error){port!.postMessage({type:"error",error:error instanceof Error?error.message:"Population candidate failed"});controller.abort();}
      finally{active=false;if(controller.signal.aborted)await close();}})();
  });
  port!.postMessage({type:"ready",bundleDigest:input.bundleDigest});
}
void main().catch(async error=>{port.postMessage({type:"error",error:error instanceof Error?error.message:"Population worker initialization failed"});await close();});
