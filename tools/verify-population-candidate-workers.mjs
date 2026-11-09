// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Serialized native verification only: creates two NEW consolidation runs and changes this isolated database's active snapshot.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {readScceRuntimeConfig} from '../packages/adapters-node/dist/config.js';
import {createPostgresStorageAdapter} from '../packages/adapters-node/dist/postgres.js';
import {consolidateCorpusSegmentation} from '../packages/adapters-node/dist/corpus-segmentation-producer.js';
import {createPopulationCandidateExecution} from '../packages/adapters-node/dist/population-candidate-execution.js';
import {parseCorpusSegmentationPlan} from '../packages/cli/dist/corpus-segmentation-command.js';
import {canonicalStringify,createHasher} from '../packages/kernel/dist/index.js';
const args=process.argv.slice(2),allowed=new Set(['--config','--plan','--execution','--output']);
if(!args.includes('--allow-new-runs'))throw Error('Requires --allow-new-runs and an isolated local verification database; no outer transaction can expose worker inputs');
const pairs=args.filter(value=>value!=='--allow-new-runs');
if(pairs.length%2||pairs.some((value,index)=>index%2===0&&!allowed.has(value)))throw Error('Usage: node tools/verify-population-candidate-workers.mjs --config LOCAL --plan SMALL_ADMITTED_COHORT_PLAN --execution WORKER_DECLARATION --output RECEIPT --allow-new-runs');
const flags=new Map();for(let index=0;index<pairs.length;index+=2){if(flags.has(pairs[index]))throw Error('Duplicate verification option');flags.set(pairs[index],pairs[index+1]);}
for(const flag of allowed)if(!flags.get(flag))throw Error(`Missing ${flag}`);
const config=await readScceRuntimeConfig(flags.get('--config'));
if(!['localhost','127.0.0.1','[::1]','::1'].includes(new URL(config.database.url).hostname))throw Error('Candidate worker verification requires local PostgreSQL');
const plan=JSON.parse(await readFile(flags.get('--plan'),'utf8')),execution=JSON.parse(await readFile(flags.get('--execution'),'utf8'));
const storage=createPostgresStorageAdapter({...config.database,informationAccess:config.security.informationAccess});storage.pool.options.max=2;
const report={schema:'scce.population_candidate_native_verification.v1',capabilityEvaluation:false,
  mutations:'two_new_consolidation_runs_and_active_snapshot_only; no source ingestion or deletion',runs:[],checks:[]};
async function rowDigest(runId){
  const hash=createHash('sha256');let count=0,collection='',key='';
  for(;;){const rows=await storage.query(`SELECT collection,order_key,row_json FROM ${storage.table('segmentation_consolidation_rows')}
    WHERE run_id=$1 AND (collection COLLATE "C",order_key COLLATE "C")>($2::text COLLATE "C",$3::text COLLATE "C")
    ORDER BY collection COLLATE "C",order_key COLLATE "C" LIMIT 1`,[runId,collection,key]);
    if(!rows.length)break;for(const row of rows){hash.update(canonicalStringify(row)+'\n');count++;collection=row.collection;key=row.order_key;}
  }return {sha256:hash.digest('hex'),rows:count};
}
try{
  assert.equal((await storage.verify()).ok,true,'Canonical schema must be verified before native workers');
  const preflight=parseCorpusSegmentationPlan({...plan,execution},Date.now());
  createPopulationCandidateExecution({storage,runId:preflight.runId,bounds:preflight.bounds,declaration:preflight.execution});
  for(const parallel of [false,true]){
    const runId=`native-population-${randomUUID()}`,input=parseCorpusSegmentationPlan({...plan,runId,...(parallel?{execution}:{execution:undefined})},Date.now());
    const cpu=process.cpuUsage(),start=performance.now();
    const result=await consolidateCorpusSegmentation({...input,storage});
    const elapsedMs=performance.now()-start,used=process.cpuUsage(cpu);
    report.runs.push({backend:parallel?'node_workers.v1':'inline',runId,modelId:result.model.id,candidateCount:result.model.selection.candidates.length,modelSha256:createHasher().digestHex(canonicalStringify(result.model)),
      sourceInventory:result.model.sourceInventory,retainedRows:await rowDigest(runId),elapsedMs,nodeCpuMicros:used.user+used.system,
      executionReceipt:result.executionReceipt??null});
  }
  assert.deepEqual(report.runs[1].sourceInventory,report.runs[0].sourceInventory,'Source snapshot changed during paired verification');
  assert.equal(report.runs[1].modelSha256,report.runs[0].modelSha256,'Full canonical model changed');
  assert.deepEqual(report.runs[1].retainedRows,report.runs[0].retainedRows,'Retained logical and physical rows changed');
  assert.equal(report.runs[1].executionReceipt.completedCandidates,report.runs[0].candidateCount);
  report.checks.push('same_owned_source_snapshot','full_canonical_model_equal','all_retained_rows_equal','worker_execution_receipt');
  report.passed=true;
  await writeFile(flags.get('--output'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report));
}finally{await storage.pool.end();}
