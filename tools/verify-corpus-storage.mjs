// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { readScceRuntimeConfig } from '../packages/adapters-node/dist/config.js';
import { createPostgresStorageAdapter } from '../packages/adapters-node/dist/postgres.js';
import { createCorpusSegmentationRun, corpusSegmentationScopeId } from '../packages/adapters-node/dist/corpus-segmentation-store.js';
import { corpusSegmentationInputRecipe } from '../packages/adapters-node/dist/corpus-segmentation-producer.js';
import { writeCorpusMembershipPages, prepareCorpusMembershipCounts, readCorpusMembershipCounts } from '../packages/adapters-node/dist/corpus-segmentation-membership.js';
import { writeCorpusStatisticsPages, readCorpusStatisticsPages } from '../packages/adapters-node/dist/corpus-segmentation-statistics-pages.js';
import { withPackedBoundaryMerges } from '../packages/adapters-node/dist/corpus-segmentation-merge-scratch.js';
import { canonicalNormalizationContract, canonicalStringify, collectBoundaryTrainingObservations, compileBoundaryStatistics, createHasher, measureSurfaceBoundaries, mergePagedBoundaryStatistics } from '../packages/kernel/dist/index.js';
import { fitPagedBoundaryEstimator } from '../packages/kernel/dist/paged-boundary-estimator.js';

const args=process.argv.slice(2),value=flag=>args[args.indexOf(flag)+1];
if(!args.includes('--config')||!value('--config'))throw Error('Usage: node tools/verify-corpus-storage.mjs --config <local-config.json> [--output <receipt.json>]');
const config=await readScceRuntimeConfig(value('--config'));
if(!['localhost','127.0.0.1','[::1]','::1'].includes(new URL(config.database.url).hostname))throw Error('This storage fixture requires local PostgreSQL');
const storage=createPostgresStorageAdapter({...config.database,informationAccess:config.security.informationAccess});
const runId='native.storage.fixture.'+randomUUID(),rollback=Error('rollback storage fixture'),report={schema:'scce.native_corpus_storage_verification.v1',at:new Date().toISOString(),checks:[],fixtureRolledBack:false,capabilityEvaluation:false};
const check=(name,operation)=>{operation();report.checks.push({name,passed:true});};
let failure;
try{
 const verified=await storage.verify();assert.equal(verified.ok,true,verified.errors.join('; '));
 try{await storage.transaction(async()=>{
  const scope={informationLabel:config.security.defaultSourceInformationLabel,sourceVersionIds:['fixture.version.a','fixture.version.b']};
  const run=await createCorpusSegmentationRun(storage,{runId,scopeId:corpusSegmentationScopeId(scope),scope,createdAt:1,
   recipeId:corpusSegmentationInputRecipe(128),normalizationContractId:canonicalNormalizationContract(createHasher()).id},{pageRows:4,maxPageBytes:2048});
  await run.putInput('inventory',[{orderKey:'1',value:{evidenceId:'fixture.a',sourceVersionId:'fixture.version.a'}},{orderKey:'2',value:{evidenceId:'fixture.b',sourceVersionId:'fixture.version.b'}}]);
  const keys=Array.from({length:40},(_,index)=>'class.語.λ.'+index);
  for(const [index,documentId]of['fixture.a','fixture.b'].entries()){
   await writeCorpusMembershipPages(run,{kind:'class',windowKey:String(index),documentId,sourceVersionId:'fixture.version.'+(index?'b':'a'),entries:[...keys,keys[0]]});
   await writeCorpusMembershipPages(run,{kind:'context',windowKey:String(index),documentId,sourceVersionId:'fixture.version.'+(index?'b':'a'),entries:keys.map(key=>['context.ગુજરાતી',key])});
  }
  const receipt=await prepareCorpusMembershipCounts(storage,run,{id:'sha256:native-fixture-only',count:2});
  const classes=await readCorpusMembershipCounts(storage,run,'class',[...keys,'absent.한글']);
  check('native-class-distinct-counts',()=>{for(const key of keys)assert.equal(classes[key],2);assert.equal(classes['absent.한글'],0);});
  const contexts=await readCorpusMembershipCounts(storage,run,'context',['context.ગુજરાતી','absent.한글']);
  check('native-context-distinct-counts',()=>{assert.equal(contexts['context.ગુજરાતી'],40);assert.equal(contexts['absent.한글'],0);});
  check('logical-count-receipts',()=>{assert.equal(receipt.classDigest.count,40);assert.equal(receipt.contextDigest.count,1);});
  const replay=await prepareCorpusMembershipCounts(storage,run,{id:'sha256:native-fixture-only',count:2});check('count-replay-is-identical',()=>assert.deepEqual(replay,receipt));
  const logical=Array.from({length:20},(_,index)=>({key:'stat.'+index,featuresFixed:[0,index,1],anchoredPositiveMass:1,anchoredNegativeMass:0,latentPositiveMass:0,latentNegativeMass:0,positiveMass:1,negativeMass:0,extension:{surface:'e\u0301 한글',index}}));
  async function* source(){yield logical.slice(0,7);yield logical.slice(7);}
  const packed=await writeCorpusStatisticsPages(run,'native',source(),logical.length),restored=[];
  for await(const page of readCorpusStatisticsPages(run,'native',logical.length))restored.push(...page);
  check('native-statistics-roundtrip',()=>assert.deepEqual(restored,logical));
  check('statistics-use-fewer-physical-rows',()=>assert.ok(packed.physicalRows<packed.logicalRows));
  const [tupleBefore]=await storage.query(`SELECT ctid::text AS physical,row_json FROM ${storage.table('segmentation_consolidation_rows')} WHERE run_id=$1 AND collection='input/inventory' AND order_key='1'`,[runId]);
  await run.putInput('inventory',[{orderKey:'1',value:tupleBefore.row_json}]);
  const [tupleAfter]=await storage.query(`SELECT ctid::text AS physical FROM ${storage.table('segmentation_consolidation_rows')} WHERE run_id=$1 AND collection='input/inventory' AND order_key='1'`,[runId]);
  check('immutable-replay-does-not-rewrite-tuples',()=>assert.equal(tupleAfter.physical,tupleBefore.physical));
  const localized=await createCorpusSegmentationRun(storage,{runId:runId+'.localized',scopeId:corpusSegmentationScopeId(scope),scope,createdAt:1,
   recipeId:corpusSegmentationInputRecipe(128),normalizationContractId:canonicalNormalizationContract(createHasher()).id},{pageRows:4096,maxPageBytes:1048576});
  await localized.putInput('inventory',[{orderKey:'1',value:{evidenceId:'fixture.a',sourceVersionId:'fixture.version.a'}},{orderKey:'2',value:{evidenceId:'fixture.b',sourceVersionId:'fixture.version.b'}}]);
  const localizedKeys=Array.from({length:2048},(_,index)=>'localized.\u8a9e.\u03bb.'+index);
  for(const [index,documentId]of['fixture.a','fixture.b'].entries()){
   await writeCorpusMembershipPages(localized,{kind:'class',windowKey:String(index),documentId,sourceVersionId:'fixture.version.'+(index?'b':'a'),entries:localizedKeys});
   await writeCorpusMembershipPages(localized,{kind:'context',windowKey:String(index),documentId,sourceVersionId:'fixture.version.'+(index?'b':'a'),entries:localizedKeys.map(key=>['localized.context',key])});
  }
  await prepareCorpusMembershipCounts(storage,localized,{id:'sha256:native-localization-fixture-only',count:2});
  const [leaves]=await storage.query(`SELECT count(*)::int AS count,MAX(octet_length(convert_to(json_build_object('orderKey',order_key,'value',row_json)::text,'UTF8'))) AS max_decoded_bytes,current_setting('block_size')::int AS block_bytes FROM ${storage.table('segmentation_consolidation_rows')} WHERE run_id=$1 AND collection='input/class-counts'`,[localized.run.runId]);
  check('normal-count-leaves-fit-native-block',()=>{assert.ok(leaves.count>1);assert.ok(leaves.max_decoded_bytes<=leaves.block_bytes);});
  const lookupStarted=performance.now(),localizedCounts=await readCorpusMembershipCounts(storage,localized,'class',localizedKeys);
  report.localizedLookup={keys:localizedKeys.length,elapsedMs:performance.now()-lookupStarted,leaves:leaves.count,maxDecodedBytes:leaves.max_decoded_bytes,blockBytes:leaves.block_bytes};
  check('localized-multilingual-point-lookups',()=>{assert.equal(Object.keys(localizedCounts).length,localizedKeys.length);for(const key of localizedKeys)assert.equal(localizedCounts[key],2);});
  const hasher=createHasher(),statistics=['oma vela. oma neri.','\u96ea\u306e\u9053\u3002\u8a9e\u306e\u5f62\u3002'].map((text,index)=>compileBoundaryStatistics({populationId:'native.source',hasher,
   observations:collectBoundaryTrainingObservations({lattices:[measureSurfaceBoundaries({documentId:'native.document.'+index,text,maxUnits:Number.MAX_SAFE_INTEGER})]})}));
  const sources=async function*(){for(const source of statistics){const {rows,sourceDocumentIds,...header}=source;yield{header:{...header,rowCount:rows.length,sourceInventory:{id:hasher.digestHex(JSON.stringify(sourceDocumentIds)),count:sourceDocumentIds.length}},
   rows:async function*(){for(const row of rows)yield[row];},sourceDocuments:async function*(){yield sourceDocumentIds;}};}};
  const baseline=await mergePagedBoundaryStatistics({sources,scratch:localized.scratch,populationId:'native.merged',collectionPrefix:'native-unpacked',hasher});
  const packedMerge=await mergePagedBoundaryStatistics({sources,scratch:withPackedBoundaryMerges(localized.scratch),populationId:'native.merged',collectionPrefix:'native-packed',hasher});
  async function materialize(cursor){const rows=[],documents=[];for await(const page of cursor.rows())rows.push(...page);for await(const page of cursor.sourceDocuments())documents.push(...page);return{header:cursor.header,rows,documents};}
  const expectedMerge=await materialize(baseline),actualMerge=await materialize(packedMerge);
  check('native-packed-merge-retains-all-logical-statistics',()=>assert.equal(canonicalStringify(actualMerge),canonicalStringify(expectedMerge)));
  const beforeRows=await localized.scratch.count('native-unpacked.rows'),afterRows=await localized.scratch.count('native-packed.rows');
  report.mergeScratch={logicalRows:actualMerge.rows.length,unpackedPhysicalRows:beforeRows,packedPhysicalRows:afterRows};
  check('native-packed-merge-reduces-temporary-tuples',()=>{assert.ok(beforeRows>afterRows);assert.equal(beforeRows,actualMerge.rows.length);});
  let canonicalReads=0,numericReads=0;
  const baselineFit=await fitPagedBoundaryEstimator({statistics:{...baseline,rows(){canonicalReads++;return baseline.rows();}},hasher});
  const numericFit=await fitPagedBoundaryEstimator({statistics:{...packedMerge,rows(){numericReads++;return packedMerge.rows();}},hasher,
   numericReplay:withPackedBoundaryMerges(localized.scratch).boundaryFitNumericReplay});
  check('native-numeric-replay-retains-complete-estimator',()=>assert.equal(canonicalStringify(numericFit),canonicalStringify(baselineFit)));
  check('native-numeric-fit-reads-canonical-rows-twice',()=>{assert.equal(canonicalReads,97);assert.equal(numericReads,2);});
  report.numericReplay={iterations:numericFit.iterations,canonicalReads,numericReads};
  await packedMerge.dispose();await baseline.dispose();
  const [scratchRemaining]=await storage.query(`SELECT count(*)::int AS count FROM ${storage.table('segmentation_consolidation_rows')} WHERE run_id=$1 AND (starts_with(collection,'scratch/native-packed.') OR starts_with(collection,'scratch/native-unpacked.'))`,[localized.run.runId]);
  check('native-merge-disposal-cleans-temporary-pages',()=>assert.equal(scratchRemaining.count,0));
  throw rollback;
 });}catch(error){if(error!==rollback)failure=error;report.fixtureRolledBack=true;}
 const [remaining]=await storage.query(`SELECT count(*)::int AS count FROM ${storage.table('segmentation_consolidation_runs')} WHERE run_id=ANY($1::text[])`,[[runId,runId+'.localized']]);check('fixture-records-rolled-back',()=>assert.equal(remaining.count,0));
 if(failure)throw failure;
 report.passed=true;
}catch(error){report.passed=false;report.error=error instanceof Error?error.message:String(error);process.exitCode=1;}
finally{await storage.close();if(args.includes('--output'))await writeFile(value('--output'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
