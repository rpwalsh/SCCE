// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {canonicalStringify,normalizedLexicalSurface,LEXICAL_SENSE_SCHEMA,type InformationLabel} from "@scce/kernel";
import {createSourceArtifactMetadataCodec} from "./source-artifact-metadata.js";
import type {CreativeEventStorageHost} from "./canonical-creative-event-store.js";
export interface LexicalSelectorRow {id:string;profile_id:string;pattern_schema:string;pattern_json:unknown;information_label:InformationLabel;selector_binding:unknown;evidence_json_bytes:string|number}
export const lexicalSelectorFields=["schema","entries","profileId","sourceVersionId","sourceCompilationId","sourceCompilation","_scceSourceArtifactMetadata"] as const;
/** Every column consulted by canonical candidate/projection admission, plus the original ranking identity. */
export function lexicalAdmissionBindingSql(alias:string):string {
 const columns=["id","profile_id","pattern_kind","support","entropy","evidence_ids","updated_at","information_label","source_system","pattern_schema","component_recipe","source_compilation_id","owned_source_version_id","pattern_language","has_source_compilation","has_source_version"].map(field=>`${alias}.${field}`);
 const roots=["lexicalUnits","schema","componentRecipe","formalLanguage","parameterCount","bindingId","sourceEditRequestFeatures","contextualQaRequestFeatures","anchor","surface"].map(field=>`${alias}.pattern_json->'${field}'`);
 return `jsonb_build_array(${[...columns,...roots].join(",")})`;
}
let cursorSequence=0;
/** One admitted SQL proof is streamed; only matching records proceed to the unchanged full-record decoder. */
export async function readWholeFormLexicalRows<Row extends {id:string;selector_binding?:unknown}>(input:{
 host:CreativeEventStorageHost;sql:string;params:unknown[];surfaces:ReadonlySet<string>;limit:number;maxBytes:number;
 readFullRows:(selected:readonly {id:string;ordinal:number}[])=>Promise<Row[]>;
}):Promise<{rows:Row[];entries:Map<string,string>}> {
 return input.host.transaction(async()=>{
  const cursor=`scce_lexical_selector_${++cursorSequence}`,selected:Array<{id:string;ordinal:number}>=[],bindings=new Map<string,string>(),entries=new Map<string,string>();
  let failed=false,evidenceBytes=0;
  await input.host.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${input.sql}`,input.params);
  try {
   for(;;){
    const page=await input.host.query<LexicalSelectorRow>(`FETCH FORWARD 128 FROM ${cursor}`);
    if(!page.length)break;
    const lexical=page.filter(row=>row.pattern_schema===LEXICAL_SENSE_SCHEMA),logical=await createSourceArtifactMetadataCodec(input.host).decodeLexicalSelectors(lexical.map(row=>({value:row.pattern_json,profileId:row.profile_id,informationLabel:row.information_label}))),matches=new Map<string,string>();
    lexical.forEach((row,index)=>{
     const root=logical[index] as Record<string,unknown>;
     if(root?.schema!==LEXICAL_SENSE_SCHEMA||!Array.isArray(root.entries)||!root.entries.length)throw Error("canonical lexical selector entries are missing or malformed");
     let matched=false;
     for(const value of root.entries){
      const entry=value as Record<string,unknown>;
      if(!entry||typeof entry.lemma!=="string"||!normalizedLexicalSurface(entry.lemma)||!Array.isArray(entry.forms)||entry.forms.some(form=>typeof form!=="string"||!normalizedLexicalSurface(form)))throw Error("canonical lexical selector forms are missing or malformed");
      if([entry.lemma,...entry.forms as string[]].some(form=>input.surfaces.has(normalizedLexicalSurface(form))))matched=true;
     }
     if(matched)matches.set(row.id,canonicalStringify(root.entries));
    });
    for(const row of page){
     if(row.pattern_schema===LEXICAL_SENSE_SCHEMA&&!matches.has(row.id))continue;
     if(bindings.has(row.id))throw Error("canonical lexical selector returned duplicate admitted identities");
     selected.push({id:row.id,ordinal:selected.length});bindings.set(row.id,canonicalStringify(row.selector_binding));
     if(matches.has(row.id))entries.set(row.id,matches.get(row.id)!);
     evidenceBytes+=Number(row.evidence_json_bytes);
     if(!Number.isSafeInteger(evidenceBytes)||evidenceBytes<0||selected.length>input.limit||evidenceBytes>input.maxBytes)throw Error("lexical pattern request exceeds the configured complete row or decoded byte budget");
    }
   }
  }catch(error){failed=true;throw error;}
  finally{
   try{await input.host.query(`CLOSE ${cursor}`);}catch(error){if(!failed)throw error;/* The owning transaction rolls back; preserve its original read/codec failure. */}
  }
  if(!selected.length)return{rows:[],entries};
  const rows=await input.readFullRows(selected);
  if(rows.length!==selected.length||rows.some((row,index)=>row.id!==selected[index]!.id||bindings.get(row.id)!==canonicalStringify(row.selector_binding)))throw Error("canonical lexical admission headers changed before full-record verification");
  return{rows,entries};
 });
}
/** Exact selected-key hydration, after the one canonical admission cursor has completed. */
export async function fetchSelectedLexicalRows<Row>(host:CreativeEventStorageHost,identities:readonly {id:string;ordinal:number}[],maxBytes:number):Promise<Row[]> {
 const params:unknown[]=[canonicalStringify(identities),maxBytes],access=host.informationAccessPredicate("pattern",3);params.push(...access.params);
 const rows=await host.query<Row & {complete_pattern_count:number|string;decoded_complete_bytes:number|string}>(`WITH requested AS MATERIALIZED (
   SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(id text,ordinal bigint)
 ), headers AS MATERIALIZED (
   SELECT requested.ordinal,pattern.id,${lexicalAdmissionBindingSql("pattern")} AS selector_binding,
     COALESCE(pattern.decoded_artifact_jsonb_bytes,octet_length(pattern.pattern_json::text))
       + octet_length(array_to_json(pattern.evidence_ids)::text) AS decoded_jsonb_bytes
   FROM requested CROSS JOIN LATERAL (
     SELECT pattern.* FROM ${host.table("language_patterns")} pattern
     WHERE pattern.id=requested.id AND ${access.sql} OFFSET 0
   ) pattern
 ), stats AS (
   SELECT COUNT(*) AS complete_pattern_count,COALESCE(SUM(decoded_jsonb_bytes),0) AS decoded_complete_bytes FROM headers
 )
 SELECT selected.*,stats.* FROM stats LEFT JOIN LATERAL (
   SELECT pattern.id,pattern.profile_id,pattern.pattern_kind,pattern.support,pattern.entropy,
     pattern.pattern_json,pattern.evidence_ids,pattern.updated_at,pattern.information_label,
     headers.selector_binding,headers.ordinal
   FROM headers CROSS JOIN LATERAL (
     SELECT pattern.* FROM ${host.table("language_patterns")} pattern WHERE pattern.id=headers.id OFFSET 0
   ) pattern
   WHERE stats.complete_pattern_count=(SELECT COUNT(*) FROM requested) AND stats.decoded_complete_bytes <= $2
 ) selected ON TRUE ORDER BY selected.ordinal`,params);
 if(Number(rows[0]?.complete_pattern_count)!==identities.length)throw Error("canonical lexical admission headers changed before full-record verification");
 if(Number(rows[0]?.decoded_complete_bytes)>maxBytes)throw Error("lexical pattern request exceeds the configured complete row or decoded byte budget");
 return rows;
}
