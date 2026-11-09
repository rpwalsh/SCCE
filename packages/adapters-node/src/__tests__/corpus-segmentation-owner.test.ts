// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect,it } from "vitest";
import { fixtureSegmentationScratch } from "../../../kernel/src/__tests__/fixtures/corpus-segmentation-scratch.js";
import { resolveCorpusSegmentationOwner,currentCorpusSegmentationDerivations } from "../corpus-segmentation-owner.js";
import type { PostgresCorpusSegmentationRun } from "../corpus-segmentation-store.js";
import type { PostgresStorageAdapter } from "../postgres.js";
const label={tenantId:"owner",principals:["owner"],compartments:[],exportClass:"internal" as const,mergePolicy:"same_owner" as const};
function fixture(records:Record<string,{sourceId:string;parentSourceVersionId:string|null}>,bindings:Array<{sourceId:string;familyId:string}>=[]){
  const scratch=fixtureSegmentationScratch(2),run={scratch,bounds:{pageRows:2,maxPageBytes:8192},run:{runId:"run",scope:{informationLabel:label,ownerFamilyBindings:bindings}},
    putInput:(collection:string,rows:any[])=>scratch.putMany(`input/${collection}`,rows),
    pages:(collection:string,query:any={})=>scratch.pages({collection,pageRows:2,maxPageBytes:8192,...query})} as unknown as PostgresCorpusSegmentationRun;
  const storage={informationAccessPredicate:()=>({sql:"TRUE",params:[]}),table:(name:string)=>name,
    query:async<T>(_sql:string,params:unknown[]):Promise<T[]> => (params[0] as string[]).filter(id=>records[id]).map(id=>({fits:true,value:{sourceVersionId:id,...records[id]!,sourceRole:records[id]!.parentSourceVersionId?"evidence-derivative":"original",informationLabel:label}})) as T[]} as unknown as PostgresStorageAdapter;
  return {run,storage,scratch};
}
it("groups versions and known derivations by the raw canonical owner without reusing corpus trust families",async()=>{
  const f=fixture({raw:{sourceId:"canonical-owner",parentSourceVersionId:null},a:{sourceId:"derived-a",parentSourceVersionId:"raw"},b:{sourceId:"derived-b",parentSourceVersionId:"raw"}});
  expect(await resolveCorpusSegmentationOwner(f.storage,f.run,"a","derived-a")).toBe("canonical-owner");
  expect(await resolveCorpusSegmentationOwner(f.storage,f.run,"b","derived-b")).toBe("canonical-owner");
  expect((await currentCorpusSegmentationDerivations(f.storage,f.run)).count).toBe(3);
});
it.each(["cycle","missing"])("refuses a %s parent chain instead of inventing independence",async defect=>{
  const f=fixture({a:{sourceId:"owner-a",parentSourceVersionId:"b"},...(defect==="cycle"?{b:{sourceId:"owner-b",parentSourceVersionId:"a"}}:{})});
  await expect(resolveCorpusSegmentationOwner(f.storage,f.run,"a","owner-a")).rejects.toThrow(defect==="cycle"?/cycle/:/missing or inaccessible/);
});
it("rechecks exact parent bindings and rejects conflicting explicit family declarations",async()=>{
  const records={raw:{sourceId:"canonical-owner",parentSourceVersionId:null as string|null},a:{sourceId:"derived",parentSourceVersionId:"raw" as string|null}};
  const f=fixture(records);await resolveCorpusSegmentationOwner(f.storage,f.run,"a","derived");records.raw.sourceId="replacement";
  await expect(currentCorpusSegmentationDerivations(f.storage,f.run)).rejects.toThrow(/dependencies changed/);
  const conflict=fixture(records,[{sourceId:"derived",familyId:"one"},{sourceId:"replacement",familyId:"two"}]);
  await expect(resolveCorpusSegmentationOwner(conflict.storage,conflict.run,"a","derived")).rejects.toThrow(/Conflicting/);
});
