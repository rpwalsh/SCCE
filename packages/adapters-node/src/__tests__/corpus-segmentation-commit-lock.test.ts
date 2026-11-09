// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {afterEach,expect,it,vi} from "vitest";
import type {PoolClient} from "pg";
import {PostgresStorageAdapter} from "../postgres.js";
const adapters:PostgresStorageAdapter[]=[];
afterEach(async()=>{for(const adapter of adapters.splice(0))await adapter.close();});
const scope={informationLabel:{tenantId:'owner',principals:['owner'],compartments:[],exportClass:'internal' as const,mergePolicy:'same_owner' as const}};
const required={recipeId:'declared-recipe',normalizationContractId:'declared-normalization'},bounds={pageRows:2,maxPageBytes:12000};
function fixture(){
 const adapter=new PostgresStorageAdapter({url:'postgres://offline.invalid/none',schema:'snapshot_guard',informationAccess:{tenantId:'owner',principalId:'owner',compartments:[],maximumExportClass:'restricted'}});adapters.push(adapter);
 const calls:string[]=[];let selected!:()=>void;
 const selection=new Promise<void>(resolve=>{selected=resolve;});
 const query=async(sql:string)=>{calls.push(sql);if(sql.includes('segmentation_consolidation_active'))selected();return {rows:[]};};
 const release=vi.fn(),client={query,release} as unknown as PoolClient;
 vi.spyOn(adapter.pool,'connect').mockImplementation((async()=>client) as unknown as typeof adapter.pool.connect);
 vi.spyOn(adapter.pool,'query').mockImplementation(query as unknown as typeof adapter.pool.query);
 return {adapter,calls,selection,release};
}
it('refuses commit-lock reads outside the actual current transaction before issuing SQL',async()=>{
 const f=fixture();await expect(f.adapter.corpusSegmentation.readActive(scope,required,bounds,{lockForCommit:true})).rejects.toThrow(/active transaction/);
 expect(f.calls).toEqual([]);expect(f.release).not.toHaveBeenCalled();
});
it('holds canonical dependency and exact active-pointer locks until the caller commits',async()=>{
 const f=fixture();let finish!:()=>void;const gate=new Promise<void>(resolve=>{finish=resolve;});
 const job=f.adapter.transaction(async()=>{expect(await f.adapter.corpusSegmentation.readActive(scope,required,bounds,{lockForCommit:true})).toBeNull();await gate;});
 await f.selection;
 try {
 expect(f.calls[0]).toBe('BEGIN');
 expect(f.calls[1]).toBe('LOCK TABLE "snapshot_guard"."evidence_spans","snapshot_guard"."source_versions" IN SHARE MODE');
 expect(f.calls[2]).toContain('FOR SHARE OF a');expect(f.calls[2]).not.toContain('FOR SHARE OF r');
 expect(f.calls).not.toContain('COMMIT');expect(f.release).not.toHaveBeenCalled();
 await expect(f.adapter.corpusSegmentation.readActive(scope,required,bounds,{lockForCommit:true})).rejects.toThrow(/active transaction/);
 } finally {finish();await job;}
 expect(f.calls.at(-1)).toBe('COMMIT');expect(f.release).toHaveBeenCalledTimes(1);
});
it('releases commit-read locks through the existing rollback path and leaves ordinary reads unlocked',async()=>{
 const f=fixture();await expect(f.adapter.transaction(async()=>{await f.adapter.corpusSegmentation.readActive(scope,required,bounds,{lockForCommit:true});throw new Error('learned write failed');})).rejects.toThrow('learned write failed');
 expect(f.calls.at(-1)).toBe('ROLLBACK');expect(f.release).toHaveBeenCalledTimes(1);
 f.calls.length=0;expect(await f.adapter.corpusSegmentation.readActive(scope,required,bounds)).toBeNull();
 expect(f.calls).toHaveLength(1);expect(f.calls[0]).not.toMatch(/LOCK TABLE|FOR SHARE/u);
});
