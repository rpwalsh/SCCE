// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export const CORPUS_SEGMENTATION_MIN_POOL_CONNECTIONS=2 as const;
export interface CorpusSegmentationLeaseClient {
  query(sql:string,params:unknown[]):Promise<{rows:Array<Record<string,unknown>>}>;
  release(destroy?:boolean):void;
}
export interface CorpusSegmentationLeasePool {
  options:{max?:number};connect():Promise<CorpusSegmentationLeaseClient>;
}
export class CorpusSegmentationRunBusyError extends Error {
  readonly reasonId="corpus_segmentation.run_busy";
  constructor(){super("Corpus segmentation run already has an active coordinator");}
}
export class CorpusSegmentationLeaseUnavailableError extends Error {
  readonly reasonId="corpus_segmentation.lease_unavailable";
}
/** A dedicated session owns the lock; ordinary job statements keep their normal short transactions. */
export async function acquireCorpusSegmentationLease(pool:CorpusSegmentationLeasePool,schema:string,runId:string):Promise<{release():Promise<void>}>{
  if(!schema.trim()||!runId.trim())throw new CorpusSegmentationLeaseUnavailableError("Corpus segmentation lease requires schema and run identity");
  const client=await pool.connect(),key=`scce.corpus_segmentation:${schema}:${runId}`;
  let result:{rows:Array<Record<string,unknown>>};
  try{result=await client.query("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",[key]);}
  catch(error){client.release(true);throw error;}
  const acquired=result.rows[0]?.acquired;
  if(acquired!==true){client.release(acquired===false?undefined:true);
    if(acquired===false)throw new CorpusSegmentationRunBusyError();
    throw new CorpusSegmentationLeaseUnavailableError("Corpus segmentation lease acquisition has no valid result");}
  let released=false;
  return {release:async()=>{
    if(released)return;released=true;
    try{const unlocked=await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0)) AS released",[key]);
      if(unlocked.rows[0]?.released!==true)throw new CorpusSegmentationLeaseUnavailableError("Corpus segmentation advisory lease was not released");}
    catch(error){client.release(true);throw error;}
    client.release();
  }};
}
const leaseReservations=new WeakMap<CorpusSegmentationLeasePool,number>();
export async function withCorpusSegmentationLease<T>(pool:CorpusSegmentationLeasePool,schema:string,runId:string,operation:()=>Promise<T>):Promise<T>{
  const max=pool.options.max;
  if(typeof max!=="number"||!Number.isSafeInteger(max)||max<CORPUS_SEGMENTATION_MIN_POOL_CONNECTIONS)throw new CorpusSegmentationLeaseUnavailableError("Corpus segmentation requires configured PostgreSQL pool max >=2 (one lease session plus ordinary job queries)");
  const reserved=leaseReservations.get(pool)??0;
  if(reserved>=max-1)throw new CorpusSegmentationLeaseUnavailableError("Corpus segmentation pool lease capacity is busy; at least one ordinary query slot must remain available");
  leaseReservations.set(pool,reserved+1);
  try{
    const lease=await acquireCorpusSegmentationLease(pool,schema,runId);let failed=false,primary:unknown;
    try{return await operation();}catch(error){failed=true;primary=error;throw error;}
    finally{try{await lease.release();}catch(error){if(failed)throw new AggregateError([primary,error],"Corpus segmentation job and advisory lease release both failed");throw error;}}
  }finally{const remaining=(leaseReservations.get(pool)??1)-1;if(remaining)leaseReservations.set(pool,remaining);else leaseReservations.delete(pool);}
}
