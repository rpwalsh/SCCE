#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {createLanguageMemoryRuntime,requestCommunicativeActModelFromPatterns,classifyRequestCommunicativeAct} from '../../packages/kernel/dist/index.js';

export async function languageComponentDiagnostic(client,schema,controlsBytes){
 if(!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(schema))throw new Error('Invalid schema');
 const q='"'+schema+'"',controls=JSON.parse(controlsBytes);
 const result={schema:'scce.language_component_diagnostic.v1',startedAt:new Date().toISOString(),
  sourceCodeCommit:'1ac82eac41b5f33b7f58fb1dc485c7a9fa83e2e7',readOnlyApplicationData:true,
  controlsSha256:createHash('sha256').update(controlsBytes).digest('hex'),cohorts:[]};
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
 const modelInventory=(await client.query(`SELECT model_json->>'sourceSystem' AS source_system,count(*)::int AS rows,sum(pg_column_size(model_json))::text AS stored_bytes FROM ${q}.ngram_models GROUP BY 1 ORDER BY 1`)).rows;result.modelInventory=modelInventory;
 for(const source of ['wikipedia','dialogue']){
  const rows=(await client.query(`SELECT id,stream_id,language_hint,max_order,discount,model_json,updated_at,information_label FROM ${q}.ngram_models WHERE model_json->>'sourceSystem'=$1 ORDER BY id`,[source])).rows;
  const records=rows.map(r=>({id:r.id,streamId:r.stream_id,languageHint:r.language_hint,maxOrder:r.max_order,discount:r.discount,modelJson:r.model_json,updatedAt:new Date(r.updated_at).getTime(),informationLabel:r.information_label}));
  const runtime=createLanguageMemoryRuntime(),state=runtime.hydrate({models:records}),pairs=[];
  for(const pair of controls.pairs){
   const english=runtime.score({state,text:pair.english}),permuted=runtime.score({state,text:pair.permuted});
   pairs.push({...pair,englishInformation:english.information,permutedInformation:permuted.information,
    englishPreferred:english.information<permuted.information,tie:english.information===permuted.information});
  }
  result.cohorts.push({sourceSystem:source,persistedStructures:records.length,selectedStructures:state.models.length,
   selectedModelIds:state.modelPopulations?.map(x=>x.modelId),pairs,englishPreferred:pairs.filter(x=>x.englishPreferred).length,totalPairs:pairs.length});
 }
 result.requestPatterns=(await client.query(`SELECT source_system,pattern_json->>'schema' AS schema,pattern_json->>'componentRecipe' AS recipe,pattern_json->'classCounts' AS class_counts,count(*)::int AS rows FROM ${q}.language_patterns WHERE pattern_json->>'schema'='scce.request_communicative_act_pattern.v1' GROUP BY 1,2,3,4 ORDER BY 1`)).rows;
 // Load the same request rows as the runtime, retaining every field.
 const rows=(await client.query(`SELECT id,profile_id,pattern_kind,support,entropy,pattern_json,evidence_ids,updated_at FROM ${q}.language_patterns WHERE source_system='request_communicative_act' AND pattern_json->>'schema'='scce.request_communicative_act_pattern.v1' ORDER BY support DESC,id LIMIT 2048`)).rows;
 const patterns=rows.map(r=>({id:r.id,profileId:r.profile_id,patternKind:r.pattern_kind,support:r.support,entropy:r.entropy,patternJson:r.pattern_json,evidenceIds:r.evidence_ids,updatedAt:new Date(r.updated_at).getTime()}));
 const act=requestCommunicativeActModelFromPatterns(patterns);
 result.requestClassifier={loadedRows:patterns.length,compatibleModelBuilt:!!act,classification:classifyRequestCommunicativeAct('Please rewrite this sentence.',act)};

 result.completed=true;
 return result;
 }finally{await client.query('ROLLBACK');result.finishedAt=new Date().toISOString();}
}
async function main(){
 const {values}=parseArgs({options:{config:{type:'string'},out:{type:'string'},controls:{type:'string',default:'tools/language-behavior-evaluation/sequence-controls.json'}}});
 if(!values.config||!values.out)throw new Error('Usage: node tools/language-behavior-evaluation/components.mjs --config=<local-config> --out=<new-json>');
 const {readScceRuntimeConfig,createPostgresStorageAdapter}=await import('../../packages/adapters-node/dist/index.js');
 const config=await readScceRuntimeConfig(values.config),storage=createPostgresStorageAdapter({...config.database,informationAccess:config.security.informationAccess});
 let client;
 try{client=await storage.pool.connect();const result=await languageComponentDiagnostic(client,config.database.schema,await readFile(values.controls));
  await mkdir(dirname(resolve(values.out)),{recursive:true});await writeFile(values.out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
 }finally{client?.release();await storage.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main();
