// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {afterEach,expect,it} from "vitest";
import {createClock,createHasher,createIdFactory,sourceLanguageTrainingStreamId,stampSourceLanguageCompilation,toJsonValue,type JsonValue} from "@scce/kernel";
import {createPostgresStorageAdapter,type PostgresStorageAdapter} from "../postgres.js";
const hasher=createHasher(),label={tenantId:"artifact.reader",principals:[],compartments:[],exportClass:"public" as const,mergePolicy:"same_owner" as const};
const adapters:PostgresStorageAdapter[]=[];
afterEach(async()=>{await Promise.all(adapters.splice(0).map(adapter=>adapter.close()));});
function fixture(){
  const ids=createIdFactory({clock:createClock({fixedTime:1}),hasher}),text="An attested source.",owner={sourceId:ids.sourceId("test","fixture://artifact-only-reader"),sourceVersionId:ids.sourceVersionId(text),contentHash:ids.contentHash(text)},profileId="profile.artifact",sourceSystem="fixture";
  const streamId=sourceLanguageTrainingStreamId({...owner,sourceSystem,hasher});
  const options={maxOrder:1,maxCountersPerOrder:64,vocabularyLimit:64,languageOnly:true,retainNgramObservations:false};
  const build=(artifactsOnly:boolean)=>stampSourceLanguageCompilation({owner,profileId,sourceSystem,streamId,text,hasher,updatedAt:1,
    chunks:artifactsOnly?[]:[text],models:artifactsOnly?[]:[{id:"model.ordinary",streamId,languageHint:"und",maxOrder:1,discount:0.5,updatedAt:1,
      modelJson:{profileId,sourceVersionId:owner.sourceVersionId,sourceSystem,model:{order:1,totalUnigramCount:3}}}],
    options:{...options,...(artifactsOnly?{artifactScope:"artifacts_only" as const}:{})},inheritedMetadata:{license:{uri:"fixture://owned"}},
    artifacts:{units:[],semanticFrames:[],patterns:[{id:artifactsOnly?"pattern.artifact":"pattern.ordinary",profileId,patternKind:"semantic_role",support:1,entropy:0,evidenceIds:[],updatedAt:1,patternJson:{schema:"fixture.authored",profileId,sourceVersionId:owner.sourceVersionId,sourceSystem}}]}});
  const artifact=build(true),ordinary=build(false);
  const header=(compiled:ReturnType<typeof build>,artifactsOnly:boolean)=>{
    const receipt=compiled.patterns.find(row=>row.patternKind==="source_compilation")!,compilation=(receipt.patternJson as {compilation:Record<string,JsonValue>}).compilation;
    const {modelInventory:_inventory,...modelHeader}=compilation;
    return {id:artifactsOnly?receipt.id:compiled.models[0]!.id,stream_id:streamId,profile_id:profileId,source_system:sourceSystem,
      source_id:String(owner.sourceId),source_version_id:String(owner.sourceVersionId),content_hash:String(owner.contentHash),
      model_metadata:artifactsOnly?{profileId,sourceVersionId:owner.sourceVersionId,sourceCompilation:modelHeader}:compiled.models[0]!.modelJson,
      compilation_receipt:compilation as JsonValue,artifact_only:artifactsOnly};
  };
  let headers=[header(artifact,true)],accessible=true;
  const calls:Array<{sql:string;params:unknown[]}>=[],adapter=createPostgresStorageAdapter({url:"postgres://fixture-only@127.0.0.1/not-connected",schema:"artifact_reader",
    informationAccess:{tenantId:label.tenantId,principalId:"reader",compartments:[],maximumExportClass:"public",explicitMergeAuthority:false}});adapters.push(adapter);
  adapter.query=async<T>(sql:string,params:unknown[]=[]):Promise<T[]>=>{
    calls.push({sql,params});
    if(sql.startsWith("SELECT DISTINCT pattern.profile_id"))return [{profile_id:profileId,source_system:sourceSystem}] as T[];
    if(sql.includes("AS model_metadata"))return structuredClone(accessible?headers:[]) as T[];
    if(sql.includes("pattern_headers AS MATERIALIZED")){
      const serialized=params.find(value=>typeof value==="string"&&value.startsWith('[{"compilationId"')) as string|undefined;
      const allowed=serialized?JSON.parse(serialized) as Array<{compilationId:string;profileId:string;sourceVersionId:string;sourceSystem:string}>:[];
      return [...artifact.patterns,...ordinary.patterns].filter(row=>row.patternKind!=="source_compilation"&&allowed.some(scope=>scope.compilationId===(row.patternJson as {sourceCompilationId:string}).sourceCompilationId&&scope.profileId===profileId&&scope.sourceVersionId===owner.sourceVersionId&&scope.sourceSystem===sourceSystem))
        .map(row=>({id:row.id,profile_id:profileId,pattern_kind:row.patternKind,support:String(row.support),entropy:"0",pattern_json:row.patternJson,evidence_ids:[],updated_at:new Date(1),information_label:label})) as T[];
    }
    throw Error("unexpected artifact reader query");
  };
  const read=()=>adapter.languageMemory.listLanguagePatterns({profileId,sourceSystem,limit:8,maxTotalJsonBytes:65536,requireComplete:true});
  return {read,calls,headers:()=>headers,setHeaders:(next:typeof headers)=>{headers=next;},hide:()=>{accessible=false;},artifactHeader:header(artifact,true),ordinaryHeader:header(ordinary,false)};
}
it("cold-admits explicit artifacts-only compilation independently of retained complete ngram compilation",async()=>{
  const f=fixture();expect((await f.read()).map(row=>row.id)).toEqual(["pattern.artifact"]);
  f.setHeaders([f.artifactHeader,f.ordinaryHeader]);expect((await f.read()).map(row=>row.id)).toEqual(["pattern.artifact","pattern.ordinary"]);
  const query=f.calls.find(call=>call.sql.includes("AS model_metadata"))!.sql;
  expect(query).toContain("UNION ALL");expect(query).toContain("->>'artifactScope'='artifacts_only'");
  expect(query).toContain("receipt.updated_at DESC,receipt.id DESC");
  for(const alias of ["receipt","profile","version"])expect(query).toContain(`${alias}.information_label`);
  expect(query).toContain("profile.source_version_id");expect(query).toContain("profile.profile_json ? 'pooledSourceBinding'");
  f.hide();expect(await f.read()).toEqual([]);
});
it("never admits an ordinary missing-model receipt or corrupt artifact-only owner/inventory",async()=>{
  const f=fixture();
  const bad=[{...f.ordinaryHeader,artifact_only:true},{...f.artifactHeader,id:"foreign.receipt"},{...f.artifactHeader,source_version_id:"foreign.version"},
    {...f.artifactHeader,compilation_receipt:toJsonValue({...f.artifactHeader.compilation_receipt as object,modelInventory:[{id:"unpersisted.model"}]})}];
  for(const candidate of bad){f.setHeaders([candidate]);expect(await f.read()).toEqual([]);}
  f.setHeaders([f.artifactHeader,f.artifactHeader]);expect(await f.read()).toEqual([]);
  f.setHeaders([]);expect(await f.read()).toEqual([]);
});
