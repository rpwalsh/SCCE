// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {afterEach,expect,it} from 'vitest';
import {canonicalStringify,createClock,createHasher,createIdFactory,createProgramGraphBuilder,createProgramPlanner,codeRequestSignal,programIntentForTurn,
  projectSourceOwnedProgramBehavior,sourceOwnedProgramBehaviorFromDocumentation,replanOwnerBehaviorProgramIntent,COGNITIVE_OPERATOR_IDS,
  type EvidenceSpan,type SourceVersion,type IngestionCheckpoint,type SemanticEntailmentResult} from '@scce/kernel';
import {prepareProgramSourcePlanningContext,programImplementationCandidates,sourceProgramCandidateArity} from '../../../kernel/src/source-program-provider.js';
import {searchProgramTransformations} from '../../../kernel/src/program-transformation-search.js';
import {storageFixtureForEvaluation} from '../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js';
import {trainOssCorpus} from '../oss-corpus.js';
import {NodeBuildTestAdapter} from '../process.js';
import type {ScceRuntimeConfig} from '../config.js';

const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});

async function ownedSource(sourceText='export function originalSum(a: number, b: number): number { return a+b; }\n',
  testText="import {test,expect} from 'vitest';import {originalSum as observed} from '../src/value.js';test('sum',()=>{expect(observed(10,5)).toBe(15);expect(observed(10,-5)).toBe(5);});\n"){
  const root=await mkdtemp(path.join(tmpdir(),'scce-contract-selection-'));roots.push(root);
  const entries={
    'package.json':JSON.stringify({name:'source-contract-selection',type:'module'}),
    'tsconfig.json':JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true},include:['src/**/*.ts','spec/**/*.ts']}),
    'src/value.ts':sourceText,
    'src/other.ts':'export function unrelated(a: number, b: number): number { return a-b+10; }\n',
    'spec/value.spec.ts':testText
  };
  for(const [name,text] of Object.entries(entries)){const file=path.join(root,name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,text);}
  const evidence:EvidenceSpan[]=[],versions=new Map<string,SourceVersion>(),checkpoints=new Map<string,IngestionCheckpoint>(),blobs=new Map<string,Uint8Array>();
  const clock=createClock({fixedTime:100,stepMs:1}),fixture=storageFixtureForEvaluation({evidence,clockNow:()=>clock.now()}),storage=fixture.storage;
  storage.evidence.putSourceVersion=async row=>{versions.set(String(row.sourceVersionId),row);};
  storage.evidence.sourceVersionById=async id=>versions.get(String(id))??null;
  storage.evidence.putEvidenceSpan=async row=>{const old=evidence.findIndex(span=>span.id===row.id);if(old<0)evidence.push(row);else evidence[old]=row;};
  storage.evidence.sourceVersionsForEvidence=async ids=>[...new Set(evidence.filter(span=>ids.includes(span.id)).map(span=>String(span.sourceVersionId)))].map(id=>versions.get(id)!);
  storage.evidence.searchEvidence=async query=>evidence.filter(span=>(!query.sourceVersionId||span.sourceVersionId===query.sourceVersionId)&&(!query.status||span.status===query.status)).slice(0,query.limit).map(span=>({span,score:1,reason:'owned fixture'}));
  storage.blobs.put=async bytes=>{const hash=`sha256_${createHash('sha256').update(bytes).digest('hex')}`;blobs.set(hash,new Uint8Array(bytes));return hash as never;};
  storage.blobs.get=async hash=>{const bytes=blobs.get(hash);if(!bytes)throw new Error('canonical blob absent');return bytes;};
  storage.ingestion={get:async id=>checkpoints.get(id)??null,put:async row=>{checkpoints.set(row.id,row);},list:async()=>[...checkpoints.values()]};
  const report=await trainOssCorpus({storage,rootPath:root,includeDocs:false,maxFilesPerRun:100,ngramMaxOrder:2,ngramMaxCountersPerOrder:16,ngramVocabularyLimit:128});
  expect(report.filesSkipped).toEqual([]);expect(report.sourceContractClosure?.complete).toBe(true);
  const patterns=await storage.languageMemory.listLanguagePatterns({patternKind:'source_code_function'});
  const contracts=await storage.languageMemory.listLanguagePatterns({patternKind:'source_code_assertion_contract'});
  expect(patterns.length).toBeGreaterThanOrEqual(2);expect(contracts).toHaveLength(1);
  return {root,evidence,patterns,contracts};
}

it('repairs the native probe with the unique current typed source provider when one fit case also permits an invented constant',async()=>{
  const owned=await ownedSource(),context=prepareProgramSourcePlanningContext({languageId:'typescript',patterns:owned.patterns,evidence:owned.evidence});
  expect(context.sourceIds).toHaveLength(2);
  const request='TypeScript function combined(a: number,b: number): number.',signal=codeRequestSignal(request);
  const body=owned.contracts[0]!.patternJson as {repositoryFamily:string;sourcePath:string;sourceHash:string};
  const codeIntent={languageId:'typescript',symbols:[],references:[{sourceFamily:body.repositoryFamily,relativePath:body.sourcePath,sourceHash:body.sourceHash,score:1}],audit:null};
  const behavior=sourceOwnedProgramBehaviorFromDocumentation({requestText:request,intent:codeIntent,patterns:owned.contracts,ownerCallableIds:['combined']});
  expect(behavior.behaviorRequirements.map(row=>[row.arguments,row.expectedResult,row.verificationRole])).toEqual([[[10,5],15,'fit'],[[10,-5],5,'held_out']]);
  expect(behavior.behaviorRequirements.every(row=>row.callableId==='combined'&&row.sourceContract?.projectClosure)).toBe(true);
  const intent=programIntentForTurn({requestedAuthority:'program',activeOperatorIds:[COGNITIVE_OPERATOR_IDS.programPlanning],
    codeSignal:projectSourceOwnedProgramBehavior({codeSignal:signal,intent:codeIntent,sourceBehavior:behavior}),evidence:owned.evidence})!;
  const requirements=intent.behaviorRequirements!,generic=searchProgramTransformations(requirements);
  expect(generic.candidates.some(candidate=>candidate.producedIr.kind==='literal'&&candidate.producedIr.value===15&&candidate.fitMeanSquaredError===0)).toBe(true);
  const reserved=requirements.find(row=>row.verificationRole==='held_out')!;
  const privateRequirements=requirements.map(row=>row===reserved?{...row,get expectedResult():never{throw new Error('reserved outcome read during selection');}}:row);
  const pool=programImplementationCandidates(privateRequirements,context);
  expect(pool.candidates.filter(candidate=>'sourceProvider' in candidate)).toHaveLength(1);
  const withoutOwnership=requirements.map(({sourceContract:_owner,...row})=>row);
  expect(programImplementationCandidates(withoutOwnership,context).candidates.some(candidate=>candidate.producedIr.kind==='literal'&&candidate.producedIr.value===15)).toBe(true);
  const hasher=createHasher(),clock=createClock({fixedTime:200,stepMs:1}),ids=createIdFactory({clock,hasher,deterministicReplay:true}),builder=createProgramGraphBuilder({idFactory:ids,hasher});
  const build=(programIntent:typeof intent)=>builder.build({episodeId:ids.episodeId(),text:request,entailment:entailment(ids),evidence:owned.evidence,createdAt:clock.now(),programIntent,sourcePlanningContext:context});
  const native=new NodeBuildTestAdapter({runtime:{tempRoot:owned.root}} as unknown as ScceRuntimeConfig),probe=build(intent);
  const failed=await native.executeProgram({episodeId:probe.episodeId,construct:probe});
  expect(failed.build.code).toBe(0);expect(failed.passed).toBe(false);expect(failed.test.code).not.toBe(0);
  const failure={observationId:'actual-native-probe',programId:probe.program!.id,planHash:hasher.digestHex(canonicalStringify(probe.program!.hydration)),
    validatorId:'native-independent',checkId:'tests' as const,status:'failed' as const,ownerRequirementIds:requirements.map(row=>row.id),command:probe.program!.test};
  const selected=replanOwnerBehaviorProgramIntent({intent,program:probe.program!,sourcePlanningContext:context,hasher,failure});
  const privateSelection=replanOwnerBehaviorProgramIntent({intent:{...intent,behaviorRequirements:privateRequirements},program:probe.program!,sourcePlanningContext:context,hasher,failure});
  expect(privateSelection.selection).toEqual(selected.selection);
  const selectedCandidate=selected.intent.behaviorTransformationCandidates!.find(candidate=>selected.selection.selectedTransformationIds.includes(candidate.id))!;
  expect(selectedCandidate).toHaveProperty('sourceProvider.sourceHash',body.sourceHash);
  expect(selectedCandidate.producedIr).toEqual({kind:'binary',operator:'add',left:{kind:'argument',index:0},right:{kind:'argument',index:1}});
  const construct=build(selected.intent),passed=await native.executeProgram({episodeId:construct.episodeId,construct});
  expect(passed.passed,passed.build.stderr+'\n'+passed.test.stderr).toBe(true);
  const output=path.join(owned.root,'independent-artifact');
  for(const artifact of passed.artifacts){const file=path.join(output,artifact.path);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,artifact.content);}
  const check=path.join(owned.root,'independent.mjs');
  await writeFile(check,"import assert from 'node:assert/strict';const {combined}=await import(process.argv[2]);assert.equal(combined(21,7),28);assert.equal(combined(-4,9),5);console.log('unseen native calls passed');");
  const result=await promisify(execFile)(process.execPath,[check,pathToFileURL(path.join(output,construct.program!.entrypoint)).href],{timeout:30000});
  expect(result.stdout).toContain('unseen native calls passed');
  expect(JSON.stringify(requirements)).not.toContain('[21,7]');
  const revoked=prepareProgramSourcePlanningContext({languageId:'typescript',patterns:owned.patterns,evidence:owned.evidence.map(span=>({...span,status:'quarantined' as const}))});
  expect(()=>builder.build({episodeId:ids.episodeId(),text:request,entailment:entailment(ids),evidence:owned.evidence,createdAt:clock.now(),programIntent:selected.intent,sourcePlanningContext:revoked})).toThrow(/do not match/);
});

it('retains fit-only hypotheses when current source ownership is absent or ambiguous',async()=>{
  const owned=await ownedSource('export function originalSum(a: number, b: number): number { return a+b; }\nexport function sameFit(a: number, b: number): number { return 15; }\n');
  const context=prepareProgramSourcePlanningContext({languageId:'typescript',patterns:owned.patterns,evidence:owned.evidence});
  const body=owned.contracts[0]!.patternJson as {repositoryFamily:string;sourcePath:string;sourceHash:string};
  const requirements=sourceOwnedProgramBehaviorFromDocumentation({requestText:'TypeScript originalSum',ownerCallableIds:['originalSum'],patterns:owned.contracts,
    intent:{languageId:'typescript',symbols:[],references:[{sourceFamily:body.repositoryFamily,relativePath:body.sourcePath,sourceHash:body.sourceHash,score:1}],audit:null}}).behaviorRequirements;
  expect(requirements).toHaveLength(2);
  const ambiguous=programImplementationCandidates(requirements,context);
  expect(ambiguous.candidates.filter(candidate=>'sourceProvider' in candidate)).toHaveLength(2);
  expect(ambiguous.candidates.some(candidate=>candidate.producedIr.kind==='literal'&&candidate.producedIr.value===15)).toBe(true);
  expect(programImplementationCandidates(requirements).candidates).toEqual(searchProgramTransformations(requirements).candidates);
  const mismatched=requirements.map(row=>({...row,sourceContract:{...row.sourceContract!,sourceVersionId:'another-source-version'}}));
  expect(programImplementationCandidates(mismatched,context).candidates).toEqual(searchProgramTransformations(mismatched).candidates);
});

it('admits and natively emits a current four-argument typed source with source-local bindings',async()=>{
  const owned=await ownedSource('export function originalSum(a: number, b: number, c: number, d: number): number { const subtotal=a*b-c; return subtotal+d; }\n',
    "import {test,expect} from 'vitest';import {originalSum as observed} from '../src/value.js';test('four inputs',()=>{expect(observed(2,3,4,5)).toBe(7);expect(observed(-2,3,4,5)).toBe(-5);});\n");
  const body=owned.contracts[0]!.patternJson as {repositoryFamily:string;sourcePath:string;sourceHash:string};
  const sourcePattern=owned.patterns.find(pattern=>(pattern.patternJson as {sourceHash:string}).sourceHash===body.sourceHash)!;
  const compiled=(sourcePattern.patternJson as unknown as {codeFunctionConstructions:Array<{parameters:unknown[];numericAbi:{parameters:unknown[]};bindings:unknown[]}>}).codeFunctionConstructions[0]!;
  expect(compiled.parameters).toHaveLength(4);expect(compiled.numericAbi.parameters).toHaveLength(4);expect(compiled.bindings).toHaveLength(1);
  const context=prepareProgramSourcePlanningContext({languageId:'typescript',patterns:owned.patterns,evidence:owned.evidence});
  expect(context.sourceIds).toHaveLength(2);
  const request='TypeScript function combined(a: number,b: number,c: number,d: number): number.';
  const codeIntent={languageId:'typescript',symbols:[],references:[{sourceFamily:body.repositoryFamily,relativePath:body.sourcePath,sourceHash:body.sourceHash,score:1}],audit:null};
  const behavior=sourceOwnedProgramBehaviorFromDocumentation({requestText:request,intent:codeIntent,patterns:owned.contracts,ownerCallableIds:['combined']});
  expect(behavior.behaviorRequirements.map(row=>[row.arguments,row.expectedResult,row.verificationRole])).toEqual([[[2,3,4,5],7,'fit'],[[-2,3,4,5],-5,'held_out']]);
  expect(behavior.behaviorRequirements.every(row=>row.sourceContract?.projectClosure)).toBe(true);
  const intent=programIntentForTurn({requestedAuthority:'program',activeOperatorIds:[COGNITIVE_OPERATOR_IDS.programPlanning],
    codeSignal:projectSourceOwnedProgramBehavior({codeSignal:codeRequestSignal(request),intent:codeIntent,sourceBehavior:behavior}),evidence:owned.evidence})!;
  const requirements=intent.behaviorRequirements!;
  expect(searchProgramTransformations(requirements).candidates).toEqual([]);
  const privateRequirements=requirements.map(row=>row.verificationRole==='held_out'?{...row,get expectedResult():never{throw new Error('reserved outcome read during four-argument selection');}}:row);
  const pool=programImplementationCandidates(privateRequirements,context);
  expect(pool.candidates).toHaveLength(1);expect(pool.candidates[0]).toHaveProperty('sourceProvider.sourceHash',body.sourceHash);
  expect(pool.candidates[0]!.preconditions).toContainEqual({kind:'argument_count',count:4});
  expect(sourceProgramCandidateArity(pool.candidates[0]!)).toBe(4);
  expect(sourceProgramCandidateArity(JSON.parse(JSON.stringify(pool.candidates[0])))).toBeUndefined();
  const hasher=createHasher(),clock=createClock({fixedTime:300,stepMs:1}),ids=createIdFactory({clock,hasher,deterministicReplay:true}),builder=createProgramGraphBuilder({idFactory:ids,hasher});
  const build=(programIntent:typeof intent)=>builder.build({episodeId:ids.episodeId(),text:request,entailment:entailment(ids),evidence:owned.evidence,createdAt:clock.now(),programIntent,sourcePlanningContext:context});
  const native=new NodeBuildTestAdapter({runtime:{tempRoot:owned.root}} as unknown as ScceRuntimeConfig),probe=build(intent);
  const failed=await native.executeProgram({episodeId:probe.episodeId,construct:probe});
  expect(failed.build.code).toBe(0);expect(failed.passed).toBe(false);expect(failed.test.code).not.toBe(0);
  const failure={observationId:'actual-four-argument-native-probe',programId:probe.program!.id,planHash:hasher.digestHex(canonicalStringify(probe.program!.hydration)),
    validatorId:'native-independent',checkId:'tests' as const,status:'failed' as const,ownerRequirementIds:requirements.map(row=>row.id),command:probe.program!.test};
  const selected=replanOwnerBehaviorProgramIntent({intent:{...intent,behaviorRequirements:privateRequirements},program:probe.program!,sourcePlanningContext:context,hasher,failure});
  const serialized=JSON.parse(JSON.stringify({...selected.intent,behaviorRequirements:requirements})) as typeof intent;
  expect(()=>builder.build({episodeId:ids.episodeId(),text:request,entailment:entailment(ids),evidence:owned.evidence,createdAt:clock.now(),programIntent:serialized})).toThrow(/do not match/);
  const forged=structuredClone(serialized);forged.behaviorTransformationCandidates![0]={...forged.behaviorTransformationCandidates![0]!,producedIr:{kind:'literal',value:7}};
  expect(()=>build(forged)).toThrow(/do not match/);
  const planner=createProgramPlanner({idFactory:ids,hasher}),planningInput={episodeId:ids.episodeId(),requestText:request,entailment:entailment(ids),evidence:owned.evidence,programIntent:serialized,sourcePlanningContext:context};
  const detachedPlan=JSON.parse(JSON.stringify(planner.plan(planningInput))) as ReturnType<typeof planner.plan>;
  expect(()=>planner.emitPlanned(detachedPlan,planningInput)).toThrow(/invalid arity/);
  const revoked=prepareProgramSourcePlanningContext({languageId:'typescript',patterns:owned.patterns,evidence:owned.evidence.map(span=>({...span,status:'quarantined' as const}))});
  expect(()=>builder.build({episodeId:ids.episodeId(),text:request,entailment:entailment(ids),evidence:owned.evidence,createdAt:clock.now(),programIntent:serialized,sourcePlanningContext:revoked})).toThrow(/do not match/);
  const construct=build(serialized),passed=await native.executeProgram({episodeId:construct.episodeId,construct});
  expect(passed.passed,passed.build.stderr+'\n'+passed.test.stderr).toBe(true);
  const output=path.join(owned.root,'independent-four-argument-artifact');
  for(const artifact of passed.artifacts){const file=path.join(output,artifact.path);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,artifact.content);}
  const check=path.join(owned.root,'independent-four-arguments.mjs');
  await writeFile(check,"import assert from 'node:assert/strict';const {combined}=await import(process.argv[2]);assert.equal(combined.length,4);assert.equal(combined(7,11,13,17),81);assert.equal(combined(0.5,-4,3,9),4);assert.throws(()=>combined(2,3,4),TypeError);assert.throws(()=>combined(2,3,4,5,6),TypeError);assert.throws(()=>combined(2,3,4,Infinity),TypeError);assert.throws(()=>combined(2,3,4,'5'),TypeError);console.log('unseen four-argument native calls passed');");
  const result=await promisify(execFile)(process.execPath,[check,pathToFileURL(path.join(output,construct.program!.entrypoint)).href],{timeout:30000});
  expect(result.stdout).toContain('unseen four-argument native calls passed');
  expect(JSON.stringify(requirements)).not.toContain('[7,11,13,17]');
});

function entailment(ids:ReturnType<typeof createIdFactory>):SemanticEntailmentResult {
  const claimId=ids.claimId('owned-source'),proofId=ids.proofId({claimId,evidenceIds:[],transforms:[],validatorVersion:'fixture'});
  return {claim:{id:claimId,text:'',normalized:'',features:[],polarity:1},verdict:'underdetermined',semanticVerdict:'underdetermined',force:'unknown',support:0,contradiction:0,faithfulnessLcb:0,
    confidence:{verdict:'underdetermined',support:0,contradiction:0,faithfulnessLcb:0,supportingEvidence:0,sourceVersions:[],structuralCoverage:0,roleCoverage:0,relationCompatibility:0,transformationSupport:0,causalMass:0,stability:1,satisfiedObligations:0,requiredObligations:0},
    scores:{structuralCoverage:0,roleCoverage:0,relationCompatibility:0,transformationSupport:0,causalMass:0,faithfulnessLCB:0,contradiction:0,stability:1},obligations:[],mappings:[],transforms:[],counterexamples:[],missing:[],evidenceIds:[],boundaries:[],proof:{id:proofId,claimId,verdict:'unknown',confidence:{},proofGraph:{nodes:[],edges:[]},evidenceIds:[],transformIds:[],scores:{},validatorVersion:'fixture',createdAt:200}};
}
