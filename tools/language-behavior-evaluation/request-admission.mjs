#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {readScceRuntimeConfig,createNodeRuntime} from '../../packages/adapters-node/dist/index.js';
import {requestCommunicativeActModelFromPatterns,REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM,REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA,REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE} from '../../packages/kernel/dist/index.js';
import {writeFile} from 'node:fs/promises';
const [configPath,out]=process.argv.slice(2);if(!configPath||!out)throw new Error('Usage: node tools/language-behavior-evaluation/request-admission.mjs <config> <new-json>');
const config=await readScceRuntimeConfig(configPath),runtime=createNodeRuntime(config);
try{
 await runtime.relationPotential.hydrated;
 const result=await runtime.storage.transaction(async()=>{
  await runtime.storage.query('SET TRANSACTION READ ONLY');
  const table=runtime.storage.table('language_patterns');
  const [inventory]=await runtime.storage.query(`SELECT count(*)::int AS stored_rows,
   count(*) FILTER (WHERE component_recipe=$3)::int AS current_recipe_rows,
   count(*) FILTER (WHERE COALESCE(cardinality(evidence_ids),0)>0)::int AS evidence_linked_rows
   FROM ${table} WHERE source_system=$1 AND pattern_schema=$2`,[REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM,REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA,REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE]);
  const rows=await runtime.storage.languageMemory.listLanguagePatterns({sourceSystem:REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM,patternSchemas:[REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA],limit:2048});
  return {schema:'scce.request_artifact_admission_diagnostic.v1',readOnlyApplicationData:true,
   inventory,runtimeAdmittedRows:rows.length,compatibleRuntimeClassifier:!!requestCommunicativeActModelFromPatterns(rows),
   requiredRecipe:REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE,
   qualification:'Calls the actual PostgreSQL adapter and the same reader options as production request-classifier hydration; does not bypass ownership, source projection or information-label guards.'};
 });
 await writeFile(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(result));
}finally{await runtime.close();}
