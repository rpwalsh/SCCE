// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect,it } from "vitest";
import { acquireCorpusSegmentationLease,withCorpusSegmentationLease,CorpusSegmentationRunBusyError,CorpusSegmentationLeaseUnavailableError } from "../corpus-segmentation-lease.js";
function database(){const owners=new Map<string,number>(),releases:Array<{id:number;destroy:boolean|undefined}>=[];let next=0,failUnlock=false;
  const pool=()=>({options:{max:2},connect:async()=>{const id=++next;return {query:async(sql:string,params:unknown[])=>{const key=String(params[0]);
    if(sql.includes("pg_try_advisory_lock")){const acquired=!owners.has(key);if(acquired)owners.set(key,id);return {rows:[{acquired}]};}
    if(failUnlock)throw new Error("unlock failed");const released=owners.get(key)===id;if(released)owners.delete(key);return {rows:[{released}]};},
    release:(destroy?:boolean)=>{releases.push({id,destroy});if(destroy)for(const [key,owner]of owners)if(owner===id)owners.delete(key);}};}});
  return {pool,owners,releases,setUnlockFailure:(value:boolean)=>{failUnlock=value;}};
}
it("rejects a second independent same-run coordinator and releases the actual session before reuse",async()=>{
  const db=database(),first=db.pool(),second=db.pool(),lease=await acquireCorpusSegmentationLease(first,"schema","run");
  await expect(acquireCorpusSegmentationLease(second,"schema","run")).rejects.toBeInstanceOf(CorpusSegmentationRunBusyError);
  const other=await acquireCorpusSegmentationLease(second,"schema","other-run");await other.release();await lease.release();await lease.release();
  expect(db.owners.size).toBe(0);const retry=await acquireCorpusSegmentationLease(second,"schema","run");await retry.release();expect(db.owners.size).toBe(0);
  expect(db.releases.every(value=>value.destroy!==true)).toBe(true);
});
it("releases after cancellation and activation exceptions without retaining a pooled advisory lock",async()=>{
  const db=database(),pool=db.pool();
  for(const reason of [new DOMException("owner stopped","AbortError"),new Error("activation CAS failed")]){
    await expect(withCorpusSegmentationLease(pool,"schema","run",async()=>{throw reason;})).rejects.toBe(reason);expect(db.owners.size).toBe(0);
  }
  expect(await withCorpusSegmentationLease(pool,"schema","run",async()=>42)).toBe(42);
});
it("destroys an uncertain session after unlock failure and preserves both job and cleanup errors",async()=>{
  const db=database(),pool=db.pool();db.setUnlockFailure(true);
  await expect(withCorpusSegmentationLease(pool,"schema","run",async()=>{throw new Error("job failed");})).rejects.toBeInstanceOf(AggregateError);
  expect(db.owners.size).toBe(0);expect(db.releases.at(-1)?.destroy).toBe(true);
  db.setUnlockFailure(false);const lease=await acquireCorpusSegmentationLease(pool,"schema","run");await lease.release();expect(db.owners.size).toBe(0);
});
it("preserves configured pool capacity and keeps a slot for ordinary job queries",async()=>{
  const db=database(),pool=db.pool();pool.options.max=1;
  await expect(withCorpusSegmentationLease(pool,"schema","run",async()=>42)).rejects.toBeInstanceOf(CorpusSegmentationLeaseUnavailableError);expect(db.releases).toHaveLength(0);
  pool.options.max=2;let finish!:()=>void;const blocked=new Promise<void>(resolve=>{finish=resolve;});
  const running=withCorpusSegmentationLease(pool,"schema","run",async()=>{await blocked;return 1;});
  await expect(withCorpusSegmentationLease(pool,"schema","another",async()=>2)).rejects.toThrow(/capacity is busy/);
  finish();expect(await running).toBe(1);expect(db.owners.size).toBe(0);
});

it("destroys a session whose acquisition result is uncertain before allowing any job mutation",async()=>{
  const released:boolean[]=[];let ran=false;
  const pool={options:{max:2},connect:async()=>({query:async()=>{throw new Error("lost acquisition acknowledgement");},release:(destroy?:boolean)=>{released.push(destroy===true);}})};
  await expect(withCorpusSegmentationLease(pool,"schema","run",async()=>{ran=true;})).rejects.toThrow(/lost acquisition/);
  expect(ran).toBe(false);expect(released).toEqual([true]);
});
