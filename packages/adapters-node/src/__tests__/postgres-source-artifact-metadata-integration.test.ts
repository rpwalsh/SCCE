// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {afterEach,expect,it} from "vitest";
import {createClock,createHasher,createIdFactory,sourceLanguageTrainingStreamId,stampSourceLanguageCompilation,toJsonValue,
  type InformationLabel} from "@scce/kernel";
import {validateSourceCompilationReceipt} from "../../../kernel/src/source-language-compilation.js";
import {canonicalNgramModelId} from "../../../kernel/src/source-language-training-identity.js";
import {createPostgresStorageAdapter,clearResidentNgramModelJson,type PostgresStorageAdapter} from "../postgres.js";
import {SOURCE_ARTIFACT_METADATA_KEY} from "../source-artifact-metadata.js";
import {DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY} from "../durable-join-program-storage.js";
const hasher=createHasher(),label:InformationLabel={tenantId:"metadata.owner",principals:["operator"],compartments:[],exportClass:"restricted",mergePolicy:"isolated"};
const adapters:PostgresStorageAdapter[]=[];
afterEach(async()=>{clearResidentNgramModelJson();await Promise.all(adapters.splice(0).map(adapter=>adapter.close()));});
const object=(value:unknown)=>value as Record<string,unknown>;
const cold=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
function producer(variant="a"){
  const text="A source records \u732b and e\u0301.",ids=createIdFactory({hasher,clock:createClock({fixedTime:1}),deterministicReplay:true,namespace:"storage.metadata"});
  const owner={sourceId:ids.sourceId("fixture","fixture://metadata"),sourceVersionId:ids.sourceVersionId(text),contentHash:ids.contentHash(text)},profileId="profile.metadata";
  const metadata={sourceMetadata:{variant,provenance:Array.from({length:60},(_,index)=>({index,owner:"human",text:"\u732b.e\u0301.".repeat(60)}))}};
  const streamId=sourceLanguageTrainingStreamId({...owner,sourceSystem:"fixture",hasher}),options={maxOrder:1,maxCountersPerOrder:64,vocabularyLimit:64,languageOnly:false,retainNgramObservations:false};
  const input={owner,profileId,sourceSystem:"fixture",streamId,text,chunks:[text],options,hasher,inheritedMetadata:toJsonValue(metadata),
    models:[{id:canonicalNgramModelId({streamId,profileId,sourceVersionId:owner.sourceVersionId,sourceSystem:"fixture",languageHint:"und",order:1,hasher}),streamId,languageHint:"und",maxOrder:1,discount:0.5,updatedAt:1000,
      modelJson:toJsonValue({...metadata,profileId,sourceVersionId:owner.sourceVersionId,sourceSystem:"fixture",model:{order:1,totalUnigramCount:10}})}],
    artifacts:{units:[{id:"unit.metadata",profileId,sourceVersionId:owner.sourceVersionId,script:"Latin",unitKind:"symbol" as const,text:"\u732b",features:[],competenceVector:[1],alpha:1,evidenceIds:[],metadata:toJsonValue({...metadata,sourceSystem:"fixture"})}],
      patterns:[{id:"pattern.metadata",profileId,patternKind:"semantic_role" as const,support:1,entropy:0,updatedAt:1000,evidenceIds:[],patternJson:toJsonValue({...metadata,profileId,sourceVersionId:owner.sourceVersionId,sourceSystem:"fixture",schema:"scce.request_requirement_pattern.v1",surface:"opaque",requirementCoefficients:{factual:1},stats:{examples:1}})}],
      semanticFrames:[{id:"frame.metadata",frameJson:toJsonValue({...metadata,profileId,sourceVersionId:owner.sourceVersionId,sourceSystem:"fixture",surface:"opaque"}),embedding:new Array<number>(64).fill(0),evidenceIds:[],alpha:1,createdAt:1000}]}};
  const result=stampSourceLanguageCompilation(input);
  return {...result,owner,profileId,metadata,receipt:result.patterns.find(pattern=>pattern.patternKind==="source_compilation")!};
}
function fixture(){
  type Row=Record<string,unknown>;
  const tables=new Map<string,Map<string,Row>>(),calls:Array<{sql:string;params:unknown[]}>=[];let visible=true;
  const table=(name:string)=>{let rows=tables.get(name);if(!rows){rows=new Map();tables.set(name,rows);}return rows;};
  const adapter=createPostgresStorageAdapter({url:"postgres://fixture-only@127.0.0.1/not-connected",schema:"metadata_fixture",informationAccess:{tenantId:label.tenantId,principalId:"operator",compartments:[],maximumExportClass:"restricted",explicitMergeAuthority:false}});adapters.push(adapter);
  adapter.transaction=async work=>work();
  adapter.mutateLanguageMemory=async(sql,params=[])=>{
    calls.push({sql,params});const name=/INSERT INTO "metadata_fixture"\."([^"]+)"/u.exec(sql)?.[1];if(!name)throw Error("unexpected mutation");
    for(const row of JSON.parse(String(params[0])) as Row[]){const prior=table(name).get(String(row.id)),next=cold(row);
      const column=name==="ngram_models"?"model_json":name==="language_units"?"metadata_json":undefined;
      if(prior&&column){const before=object(prior[column]),after=object(next[column]);
        next[column]=Object.hasOwn(before,SOURCE_ARTIFACT_METADATA_KEY)&&sql.includes("THEN EXCLUDED.")?after:{...before,...after};}
      table(name).set(String(row.id),next);
    }return true;
  };
  const mapped=(name:string):Row[]=>[...table(name).values()].map(row=>({...cold(row),updated_at:new Date(Number(row.updated_at_ms??1000)),created_at:new Date(Number(row.created_at_ms??1000)),
    evidence_ids:row.evidence_ids_json??[],features:row.features_json??[],competence_vector:row.competence_vector_json??[],embedding:row.embedding??"[]",information_label:label}));
  const bytes=(value:unknown)=>Number(object(object(value)[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]??{}).decodedJsonbBytes??Buffer.byteLength(JSON.stringify(value)));
  adapter.query=async<T>(sql:string,params:unknown[]=[]):Promise<T[]>=>{
    calls.push({sql,params});
    if(sql.includes("pg_advisory_xact_lock"))return [];
    if(sql.includes("receipt.id=ANY"))return (visible?mapped("language_patterns").filter(row=>(params[0] as string[]).includes(String(row.id))):[]) as T[];
    if(sql.includes(" AS value,information_label")&&sql.includes("FOR UPDATE")){
      const name=sql.includes('"language_units"')?"language_units":"ngram_models",column=name==="language_units"?"metadata_json":"model_json";
      return mapped(name).filter(row=>(params[0] as string[]).includes(String(row.id))&&(!sql.includes(`? '${SOURCE_ARTIFACT_METADATA_KEY}'`)||Object.hasOwn(object(row[column]),SOURCE_ARTIFACT_METADATA_KEY)))
        .map(row=>({id:row.id,value:row[column],information_label:label})) as T[];
    }
    if(sql.includes("AS lu(id text,source_version_id text")){
      const before=JSON.parse(String(params[0])) as Array<{id:string;metadata_json:Record<string,unknown>}>,after=JSON.parse(String(params[1])) as Array<{id:string;metadata_json:Record<string,unknown>}>;
      return before.map(row=>({id:row.id,value:{...row.metadata_json,...after.find(item=>item.id===row.id)!.metadata_json}})) as T[];
    }
    if(sql.includes("AS model_metadata")||sql.startsWith("SELECT DISTINCT pattern.profile_id,pattern.source_system"))return [];
    if(sql.startsWith("SELECT id, information_label"))return [];
    if(sql.includes("AS stored_bytes")&&sql.includes('"ngram_models"'))return mapped("ngram_models").map(row=>({...row,stored_bytes:String(Buffer.byteLength(JSON.stringify(row.model_json)))})) as T[];
    if(sql.includes(" AS json_bytes")&&sql.includes('"ngram_models"'))return mapped("ngram_models").filter(row=>(params[0] as string[]).includes(String(row.id)))
      .map(row=>({...row,json_bytes:String(sql.includes("decodedJsonbBytes")?bytes(row.model_json):Buffer.byteLength(JSON.stringify(row.model_json)))})) as T[];
    if(sql.includes('FROM "metadata_fixture"."ngram_models" model'))return mapped("ngram_models") as T[];
    if(sql.includes("pattern_headers AS MATERIALIZED")){
      let rows=mapped("language_patterns").filter(row=>row.pattern_kind!=="source_compilation");
      if(sql.includes("complete_read AS MATERIALIZED")){const budget=Number(params.at(-1)),logical=!sql.includes("NULL::numeric AS decoded_jsonb_bytes");
        if(rows.reduce((sum,row)=>sum+(logical?bytes(row.pattern_json):Buffer.byteLength(JSON.stringify(row.pattern_json))),0)>budget)rows=[];}
      return rows as T[];
    }
    if(sql.includes('FROM "metadata_fixture"."language_units" unit'))return mapped("language_units") as T[];
    if(sql.includes('FROM "metadata_fixture"."semantic_frames" frame'))return mapped("semantic_frames") as T[];
    throw Error(`unhandled metadata integration SQL: ${sql.slice(0,110)}`);
  };
  const write=async(value:ReturnType<typeof producer>)=>{
    await adapter.languageMemory.putLanguagePatterns!([{...value.receipt,informationLabel:label}]);
    await adapter.languageMemory.putNgramModels!(value.models.map(row=>({...row,informationLabel:label})));
    await adapter.languageMemory.putLanguageUnits!(value.units.map(row=>({...row,informationLabel:label})));
    await adapter.languageMemory.putLanguagePatterns!(value.patterns.filter(row=>row.patternKind!=="source_compilation").map(row=>({...row,informationLabel:label})));
    await adapter.languageMemory.putSemanticFrames!(value.semanticFrames.map(row=>({...row,informationLabel:label})));
  };
  return {adapter,tables,table,calls,write,hideHolder:()=>{visible=false;}};
}
it("four canonical writers persist references and cold readers restore complete producer-stamped data",async()=>{
  const f=fixture(),value=producer();await f.write(value);
  for(const [name,column] of [["ngram_models","model_json"],["language_units","metadata_json"],["language_patterns","pattern_json"],["semantic_frames","frame_json"]]){
    const row=[...f.table(name!).values()].find(row=>row.pattern_kind!=="source_compilation")!;
    expect(object(row[column!])[SOURCE_ARTIFACT_METADATA_KEY]).toBeDefined();expect(object(row[column!]).sourceMetadata).toBeUndefined();
    expect(JSON.stringify(row[column!]).length).toBeLessThan(JSON.stringify(value.metadata).length/2);
  }
  const models=await f.adapter.languageMemory.listNgramModels({limit:10});expect(models[0]!.modelJson).toEqual(value.models[0]!.modelJson);
  expect(()=>validateSourceCompilationReceipt(object(value.receipt.patternJson).compilation as Parameters<typeof validateSourceCompilationReceipt>[0],models,hasher)).not.toThrow();
  expect((await f.adapter.languageMemory.listLanguageUnits({limit:10}))[0]!.metadata).toEqual(value.units[0]!.metadata);
  expect((await f.adapter.languageMemory.listLanguagePatterns({patternIds:[value.patterns[0]!.id],limit:10}))[0]!.patternJson).toEqual(value.patterns[0]!.patternJson);
  expect((await f.adapter.languageMemory.listSemanticFrames({limit:10}))[0]!.frameJson).toEqual(value.semanticFrames[0]!.frameJson);
});
it("full request-requirement seeds charge original metadata bytes before complete bounded hydration",async()=>{
  const f=fixture(),value=producer();await f.write(value);
  const read=(budget:number)=>f.adapter.languageMemory.listLanguagePatterns({view:"request_seed",patternIds:[value.patterns[0]!.id],limit:10,requireComplete:true,maxTotalJsonBytes:budget});
  expect(await read(3000)).toEqual([]);
  const complete=await read(100000);expect(complete[0]!.patternJson).toEqual(value.patterns[0]!.patternJson);
  const sql=f.calls.find(call=>call.sql.includes("pattern_headers AS MATERIALIZED"))!.sql;
  expect(sql).not.toContain("NULL::numeric AS decoded_jsonb_bytes");
});
it("warm ngram bodies cannot outlive the canonical metadata holder admission",async()=>{
  const f=fixture(),value=producer();await f.write(value);
  const query={limit:10,maxTotalJsonBytes:100000};const retained=await f.adapter.languageMemory.listNgramModels(query);expect(retained[0]!.modelJson).toEqual(value.models[0]!.modelJson);
  f.hideHolder();await expect(f.adapter.languageMemory.listNgramModels(query)).rejects.toThrow(/metadata.*missing|metadata.*inaccessible/);
});
it("identical IDs/timestamps from separate databases never reuse another adapter's metadata body",async()=>{
  const a=fixture(),b=fixture(),left=producer("a"),right=producer("b");await a.write(left);await b.write(right);
  const first=await a.adapter.languageMemory.listNgramModels({limit:10,maxTotalJsonBytes:100000}),second=await b.adapter.languageMemory.listNgramModels({limit:10,maxTotalJsonBytes:100000});
  expect(first[0]!.id).toBe(second[0]!.id);expect(first[0]!.updatedAt).toBe(second[0]!.updatedAt);
  expect(second[0]!.modelJson).toEqual(right.models[0]!.modelJson);expect(second[0]!.modelJson).not.toEqual(first[0]!.modelJson);
});
it.each([false,true])("logical unit/model merges retain unknown keys and regenerate references (previous reference=%s)",async previousReference=>{
  const f=fixture(),value=producer();
  if(previousReference)await f.write(value);
  else{
    await f.adapter.languageMemory.putNgramModels!([{...value.models[0]!,modelJson:toJsonValue({unknown:{keep:"\u732b"}}),informationLabel:label}]);
    await f.adapter.languageMemory.putLanguageUnits!([{...value.units[0]!,metadata:toJsonValue({unknown:{keep:"\u732b"}}),informationLabel:label}]);
  }
  if(previousReference){const model=await f.adapter.languageMemory.listNgramModels({limit:10});await f.adapter.languageMemory.putNgramModels!([{...model[0]!,modelJson:toJsonValue({...object(model[0]!.modelJson),unknown:{keep:"\u732b"}})}]);
    const units=await f.adapter.languageMemory.listLanguageUnits({limit:10});await f.adapter.languageMemory.putLanguageUnits!([{...units[0]!,metadata:toJsonValue({...object(units[0]!.metadata),unknown:{keep:"\u732b"}})}]);}
  await f.write(value);
  const model=(await f.adapter.languageMemory.listNgramModels({limit:10}))[0]!,unit=(await f.adapter.languageMemory.listLanguageUnits({limit:10}))[0]!;
  expect(object(model.modelJson).unknown).toEqual({keep:"\u732b"});expect(object(unit.metadata).unknown).toEqual({keep:"\u732b"});
  expect(object(model.modelJson).sourceMetadata).toEqual(value.metadata.sourceMetadata);expect(object(unit.metadata).sourceMetadata).toEqual(value.metadata.sourceMetadata);
});
