// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {afterEach,describe,expect,it} from "vitest";
import {LEXICAL_SENSE_SCHEMA,LEXICAL_GRAMMAR_SCHEMA,SOURCE_QUESTION_FRAME_SCHEMA,type JsonValue} from "@scce/kernel";
import {PostgresStorageAdapter} from "../postgres.js";
const adapters:PostgresStorageAdapter[]=[];
afterEach(async()=>{await Promise.all(adapters.splice(0).map(adapter=>adapter.close()));});
const label={tenantId:"owner",principals:[],compartments:[],exportClass:"public" as const,mergePolicy:"same_owner" as const};
function fixture(options:{count?:number;publicationChange?:boolean;fieldChange?:boolean;headerChange?:boolean;bytes?:number}={}){
 const adapter=new PostgresStorageAdapter({url:"postgres://offline.invalid/none",schema:"fixture",informationAccess:{tenantId:label.tenantId,principalId:"reader",compartments:[],maximumExportClass:"public"}});adapters.push(adapter);
 const calls:Array<{sql:string;params:unknown[]}>=[];let offset=0,revision="0",changed=false;
 const body={schema:LEXICAL_SENSE_SCHEMA,entries:[{lemma:"cat",forms:["cats"]}]},binding=["a","profile","promoted-witness","owner"];
 const full={id:"a",profile_id:"profile",pattern_kind:"semantic_role",support:1,entropy:0,pattern_json:body as JsonValue,evidence_ids:["evidence"],updated_at:new Date(1),information_label:label};
 const physical=Array.from({length:options.count??0},(_,index)=>({id:`false-${index}`,profile_id:"profile",pattern_schema:LEXICAL_SENSE_SCHEMA,pattern_json:{schema:LEXICAL_SENSE_SCHEMA,entries:[{lemma:`name of item ${index}`,forms:[]}]},information_label:label,selector_binding:[index],evidence_json_bytes:3}));
 const selected={id:"a",profile_id:"profile",pattern_schema:LEXICAL_SENSE_SCHEMA,pattern_json:body,information_label:label,selector_binding:binding,evidence_json_bytes:3};
 adapter.transaction=async operation=>operation();adapter.languageMemory.readRevision=async()=>revision;
 adapter.query=async<T>(sql:string,params:unknown[]=[]):Promise<T[]>=>{
  calls.push({sql,params});
  if(sql.startsWith("SELECT DISTINCT pattern.profile_id,pattern.source_system"))return[{profile_id:"profile",source_system:"workspace"}] as T[];
  if(sql.startsWith("DECLARE")){offset=0;return[];}
  if(sql.startsWith("FETCH")){const page=[...physical,selected].slice(offset,offset+128);offset+=128;return page as T[];}
  if(sql.startsWith("WITH requested AS MATERIALIZED")){
   if(options.publicationChange&&!changed){revision="1";changed=true;}
   return[{...full,pattern_json:options.fieldChange?{...body,entries:[{lemma:"changed",forms:[]}]}:body,selector_binding:options.headerChange?["changed"]:binding,complete_pattern_count:1,decoded_complete_bytes:options.bytes??100}] as T[];
  }
  if(sql.includes("candidate_pool AS MATERIALIZED"))return[{...full,expected_pattern_count:1,complete_pattern_count:1,decoded_complete_bytes:100}] as T[];
  return[];
 };
 const query={patternSchemas:[LEXICAL_SENSE_SCHEMA,LEXICAL_GRAMMAR_SCHEMA,SOURCE_QUESTION_FRAME_SCHEMA],languageId:"language",lexicalUnits:["cat","name"],lexicalSurfaces:["cat"],requireComplete:true,limit:1,maxTotalJsonBytes:1000};
 return{adapter,calls,query};
}
describe("PostgreSQL opt-in complete lexical surfaces",()=>{
 it("proves canonical admission once and applies budgets after 3000 component-only selectors",async()=>{
  const f=fixture({count:3000}),result=await f.adapter.languageMemory.listLanguagePatterns(f.query);expect(result.map(value=>value.id)).toEqual(["a"]);
  const declarations=f.calls.filter(call=>call.sql.startsWith("DECLARE"));expect(declarations).toHaveLength(1);
  const sql=declarations[0]!.sql;
  for(const fragment of["candidate_pool AS MATERIALIZED","current_compilation", "dependency_version.content_hash IS DISTINCT FROM","selected_evidence.status='promoted'","FULL JOIN active_projection_ids_0_dependencies allowed","FROM candidate_pool admitted","pattern.id=admitted.id OFFSET 0","pattern.information_label","ORDER BY admitted.support DESC,admitted.updated_at DESC,admitted.id ASC"])expect(sql).toContain(fragment);
  expect(sql.indexOf("FROM candidate_pool admitted")).toBeGreaterThan(sql.indexOf("candidate_pool AS MATERIALIZED"));
  expect(sql.slice(sql.lastIndexOf("SELECT pattern.id,pattern.profile_id,pattern.pattern_schema"))).not.toContain("LIMIT");
  expect(f.calls.filter(call=>call.sql.startsWith("FETCH"))).toHaveLength(25);expect(f.calls.filter(call=>call.sql.startsWith("WITH requested AS MATERIALIZED"))).toHaveLength(1);
  expect(f.calls.some(call=>/INSERT|UPDATE|DELETE/u.test(call.sql))).toBe(false);
 });
 it("leaves the ordinary complete lexical query on its existing full-record path",async()=>{const f=fixture();const{lexicalSurfaces:_,...query}=f.query;expect((await f.adapter.languageMemory.listLanguagePatterns(query)).map(value=>value.id)).toEqual(["a"]);expect(f.calls.some(call=>call.sql.startsWith("DECLARE"))).toBe(false);const sql=f.calls.find(call=>call.sql.includes("candidate_pool AS MATERIALIZED"))!.sql;expect(sql).toContain("complete_stats AS");expect(sql).toContain("COALESCE(pattern.decoded_artifact_jsonb_bytes,octet_length(pattern.pattern_json::text))");});
 it("restarts the same ordinary admitted read on a durable publication revision change",async()=>{const f=fixture({publicationChange:true});expect((await f.adapter.languageMemory.listLanguagePatterns(f.query)).map(value=>value.id)).toEqual(["a"]);expect(f.calls.filter(call=>call.sql.startsWith("DECLARE"))).toHaveLength(2);expect(f.calls.filter(call=>call.sql.startsWith("CLOSE"))).toHaveLength(2);});
 it.each(["fields","headers"])("rejects changed selected %s before returning records",async damage=>{const f=fixture({fieldChange:damage==="fields",headerChange:damage==="headers"});await expect(f.adapter.languageMemory.listLanguagePatterns(f.query)).rejects.toThrow(/changed before full-record verification/u);expect(f.calls.filter(call=>call.sql.startsWith("CLOSE"))).toHaveLength(1);});
 it("rejects the selected full decoded-byte overflow",async()=>{const f=fixture({bytes:1001});await expect(f.adapter.languageMemory.listLanguagePatterns(f.query)).rejects.toThrow("decoded byte budget");});
 it("requires complete lexical scope and rejects malformed supplied keys",async()=>{const f=fixture();await expect(f.adapter.languageMemory.listLanguagePatterns({...f.query,lexicalUnits:undefined})).rejects.toThrow("lexical surfaces require");await expect(f.adapter.languageMemory.listLanguagePatterns({...f.query,lexicalSurfaces:[""]})).rejects.toThrow("lexical surfaces require");expect(f.calls).toHaveLength(0);});
});
