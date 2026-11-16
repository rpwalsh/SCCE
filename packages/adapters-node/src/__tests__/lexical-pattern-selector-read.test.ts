// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {describe,expect,it} from "vitest";
import {LEXICAL_SENSE_SCHEMA,normalizedLexicalSurface,type InformationLabel} from "@scce/kernel";
import type {CreativeEventStorageHost} from "../canonical-creative-event-store.js";
import {readWholeFormLexicalRows,fetchSelectedLexicalRows,type LexicalSelectorRow} from "../lexical-pattern-selector-read.js";
const label:InformationLabel={tenantId:"fixture",principals:[],compartments:[],exportClass:"public",mergePolicy:"same_owner"};
function row(id:string,lemma:string,forms:string[]=[]):LexicalSelectorRow{return{id,profile_id:"profile",pattern_schema:LEXICAL_SENSE_SCHEMA,pattern_json:{schema:LEXICAL_SENSE_SCHEMA,entries:[{lemma,forms}]},information_label:label,selector_binding:[id,"evidence","source"],evidence_json_bytes:3};}
function fixture(admitted:LexicalSelectorRow[],options:{fetchError?:boolean;closeError?:boolean;changed?:boolean}={}){
 const calls:string[]=[];let offset=0,transactions=0;
 const host:CreativeEventStorageHost={table:name=>`"fixture"."${name}"`,requireWritableInformationLabel:value=>value??label,
  informationAccessPredicate:()=>({sql:"TRUE",params:[]}),transaction:async work=>{transactions++;return work();},
  query:async<T>(sql:string):Promise<T[]>=>{calls.push(sql);if(sql.startsWith("FETCH")){if(options.fetchError)throw Error("original-fetch-error");const page=admitted.slice(offset,offset+128);offset+=128;return page as T[];}
   if(sql.startsWith("CLOSE")&&options.closeError)throw Error("close-error");return[];}};
 const run=(surfaces:string[],limit=2048,maxBytes=1e7)=>readWholeFormLexicalRows({host,sql:"WITH canonical_admission AS MATERIALIZED (...) SELECT * FROM canonical_admission",params:[],surfaces:new Set(surfaces.map(normalizedLexicalSurface)),limit,maxBytes,
  readFullRows:async selected=>selected.map(item=>({id:item.id,selector_binding:options.changed?["changed"]:admitted.find(value=>value.id===item.id)!.selector_binding}))});
 return{host,calls,run,get transactions(){return transactions;}};
}
describe("canonical whole-form lexical cursor",()=>{
 it("streams 3000 component false positives and one exact match without spending the selected budget",async()=>{
  const rows=Array.from({length:3000},(_,index)=>row(`component-${index}`,`name of animal ${index}`));rows.splice(1500,0,row("exact","cat",["cats"]));
  const f=fixture(rows),result=await f.run(["cat","name"],1);
  expect(result.rows.map(value=>value.id)).toEqual(["exact"]);expect(f.transactions).toBe(1);
  expect(f.calls.filter(sql=>sql.startsWith("DECLARE"))).toHaveLength(1);expect(f.calls.filter(sql=>sql.startsWith("FETCH"))).toHaveLength(25);expect(f.calls.at(-1)).toMatch(/^CLOSE /u);
 });
 it("uses supplied complete multiword and Unicode keys, retaining all matching alternate entries",async()=>{
  const f=fixture([row("phrase","New York"),row("accent","caf\u00e9"),row("astral","\ud801\udc00"),row("case","\u0130"),row("other","new"),row("alternate","other",["NEW YORK"])]);
  expect((await f.run(["new york","cafe\u0301","\ud801\udc00","\u0130"])).rows.map(value=>value.id)).toEqual(["phrase","accent","astral","case","alternate"]);
 });
 it("preserves non-WordNet admitted rows",async()=>{const other={...row("grammar","unmatched"),pattern_schema:"scce.lexical_grammar.v1",pattern_json:{}};expect((await fixture([other,row("sense","phrase words")]).run(["phrase"])).rows.map(value=>value.id)).toEqual(["grammar"]);});
 it("never decodes an obsolete unadmitted broken metadata reference",async()=>{
  const obsolete={...row("obsolete","cat"),pattern_json:{_scceSourceArtifactMetadata:{schema:"broken"}}};
  const physical=[obsolete,row("current","cat")],admitted=physical.filter(value=>value.id!=="obsolete");expect((await fixture(admitted).run(["cat"])).rows.map(value=>value.id)).toEqual(["current"]);
 });
 it.each(["rows","bytes"])("denies exceeded selected %s budget and closes its cursor",async kind=>{const f=fixture([row("a","cat"),row("b","cat")]);await expect(f.run(["cat"],kind==="rows"?1:2,kind==="bytes"?4:100)).rejects.toThrow("complete row or decoded byte budget");expect(f.calls.at(-1)).toMatch(/^CLOSE /u);});
 it("closes on malformed admitted selectors",async()=>{const f=fixture([{...row("a","cat"),pattern_json:{schema:LEXICAL_SENSE_SCHEMA,entries:[]}}]);await expect(f.run(["cat"])).rejects.toThrow("malformed");expect(f.calls.at(-1)).toMatch(/^CLOSE /u);});
 it("preserves the original failure if close also fails",async()=>{const f=fixture([],{fetchError:true,closeError:true});await expect(f.run(["cat"])).rejects.toThrow("original-fetch-error");expect(f.calls.at(-1)).toMatch(/^CLOSE /u);});
 it("does not hide a successful-read close failure",async()=>{await expect(fixture([],{closeError:true}).run(["cat"])).rejects.toThrow("close-error");});
 it("rejects changed selected admission headers before full decoding",async()=>{await expect(fixture([row("a","cat")],{changed:true}).run(["cat"])).rejects.toThrow("admission headers changed");});
 it("does not hydrate any full rows when nothing matches",async()=>{expect((await fixture([row("a","many words")]).run(["words"])).rows).toEqual([]);});
 it("measures selected full logical bytes before returning bodies and keeps SQL ordinal ordering",async()=>{
  const f=fixture([]);let sql="";f.host.query=async<T>(value:string)=>{sql=value;return[{id:"a",complete_pattern_count:1,decoded_complete_bytes:101}] as T[];};
  await expect(fetchSelectedLexicalRows(f.host,[{id:"a",ordinal:0}],100)).rejects.toThrow("decoded byte budget");
  expect(sql).toContain("pattern.id=requested.id");expect(sql).toContain("stats.decoded_complete_bytes <= $2");expect(sql).toContain("ORDER BY selected.ordinal");
 });
});
