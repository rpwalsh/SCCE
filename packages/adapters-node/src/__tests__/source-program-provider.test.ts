// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {afterEach,expect,it} from 'vitest';
import {createClock,createHasher,createIdFactory,createProgramGraphBuilder,learningEpisodesFromVerifiedProgram,learningEpisodesFromEvents,codeRequestSignal,programIntentForTurn,replanOwnerBehaviorProgramIntent,COGNITIVE_OPERATOR_IDS,type EvidenceSpan,type SourceVersion,type IngestionCheckpoint,type SemanticEntailmentResult} from '@scce/kernel';
import {prepareProgramSourcePlanningContext,programImplementationCandidates} from '../../../kernel/src/source-program-provider.js';
import {storageFixtureForEvaluation} from '../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js';
import {trainOssCorpus} from '../oss-corpus.js';
import {sourceCodeFunctionConstructionId} from '../../../kernel/src/source-code-function-construction.js';
import {NodeBuildTestAdapter} from '../process.js';
import type {ScceRuntimeConfig} from '../config.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function ownedSource(){
 const root=await mkdtemp(path.join(tmpdir(),'scce-source-provider-public-'));roots.push(root);
 const text='// ? ??\nexport function originalOpaque(value: number): number { const a=value*value; const b=a*a; const c=b*b; return c+value; }\n';
 await writeFile(path.join(root,'source.ts'),text);
 const evidence:EvidenceSpan[]=[],versions=new Map<string,SourceVersion>(),checkpoints=new Map<string,IngestionCheckpoint>();
 const clock=createClock({fixedTime:100,stepMs:1}),fixture=storageFixtureForEvaluation({evidence,clockNow:()=>clock.now()});
 fixture.storage.evidence.putSourceVersion=async row=>{versions.set(String(row.sourceVersionId),row);};
 fixture.storage.evidence.putEvidenceSpan=async row=>{const old=evidence.findIndex(span=>span.id===row.id);if(old<0)evidence.push(row);else evidence[old]=row;};
 fixture.storage.evidence.sourceVersionsForEvidence=async ids=>[...new Set(evidence.filter(span=>ids.includes(span.id)).map(span=>String(span.sourceVersionId)))].map(id=>versions.get(id)!);
 fixture.storage.ingestion={get:async id=>checkpoints.get(id)??null,put:async row=>{checkpoints.set(row.id,row);}} as typeof fixture.storage.ingestion;
 const report=await trainOssCorpus({storage:fixture.storage,rootPath:root,includeDocs:false,maxFilesPerRun:1,ngramMaxOrder:2,ngramMaxCountersPerOrder:16,ngramVocabularyLimit:128});
 expect(report.filesSkipped).toEqual([]);expect(report.codeTrained,JSON.stringify(report)).toBe(1);
 const patterns=await fixture.storage.languageMemory.listLanguagePatterns({patternKind:'source_code_function'});
 expect(patterns).toHaveLength(1);expect((patterns[0]!.patternJson as {codeFunctionConstructions:Array<{numericAbi?:unknown}>}).codeFunctionConstructions[0]!.numericAbi).toBeDefined();
 return {evidence,patterns};
}
it('makes a genuinely ingested typed source implementation available to the same native composed-program retry pool',async()=>{
 const owned=await ownedSource(),context=prepareProgramSourcePlanningContext({languageId:'typescript',...owned});
 expect(context.sourceIds).toHaveLength(1);
 const request='TypeScript composed.ts\nopaque(-2)=254; opaque(-1)=0; opaque(0)=0; opaque(1)=2; opaque(2)=258; opaque(3)=6564; opaqueAux(-2)=254; opaqueAux(-1)=0; opaqueAux(0)=0; opaqueAux(1)=2; opaqueAux(2)=258; opaqueAux(3)=6564';
 const signal=codeRequestSignal(request),hasher=createHasher(),clock=createClock({fixedTime:200,stepMs:1}),ids=createIdFactory({clock,hasher,deterministicReplay:true});
 const intent=programIntentForTurn({requestedAuthority:'program',activeOperatorIds:[COGNITIVE_OPERATOR_IDS.programPlanning],codeSignal:signal,evidence:owned.evidence})!;
 const pool=programImplementationCandidates(intent.behaviorRequirements!,context);
 expect(pool.candidates.some(candidate=>'sourceProvider' in candidate)).toBe(true);
 const builder=createProgramGraphBuilder({idFactory:ids,hasher});
 const build=(programIntent:typeof intent)=>builder.build({episodeId:ids.episodeId(),text:request,entailment:entailment(ids),evidence:owned.evidence,createdAt:clock.now(),programIntent,sourcePlanningContext:context});
 const root=await mkdtemp(path.join(tmpdir(),'scce-source-provider-private-'));roots.push(root);
 const native=new NodeBuildTestAdapter({runtime:{tempRoot:root}} as unknown as ScceRuntimeConfig),probe=build(intent);
 const failed=await native.executeProgram({episodeId:probe.episodeId,construct:probe});expect(failed.passed).toBe(false);expect(failed.test.code).not.toBe(0);
 const selected=replanOwnerBehaviorProgramIntent({intent,program:probe.program!,sourcePlanningContext:context,hasher,failure:{observationId:'actual-native-probe',programId:probe.program!.id,planHash:hasher.digestHex(JSON.stringify(probe.program!.hydration)),validatorId:'native-independent',checkId:'tests',status:'failed',ownerRequirementIds:intent.behaviorRequirements!.map(row=>row.id),command:probe.program!.test}});
 expect(selected.selection.selectedTransformationIds.some(id=>id.startsWith('program.source.candidate.'))).toBe(true);
 const construct=build(selected.intent),passed=await native.executeProgram({episodeId:construct.episodeId,construct});
 expect(passed.passed,passed.build.stderr+'\n'+passed.test.stderr).toBe(true);
 const episodes=learningEpisodesFromVerifiedProgram({episodeId:construct.episodeId,program:construct.program!,intent:selected.intent,buildTest:passed,now:clock.now(),hasher,sourcePlanningContext:context});
 expect(episodes).toHaveLength(2);
 expect(learningEpisodesFromEvents(episodes.map(episode=>({typeId:'ProgramTransformationLearned',payload:JSON.parse(JSON.stringify(episode))})))).toEqual(episodes);
 const revoked=prepareProgramSourcePlanningContext({languageId:'typescript',patterns:owned.patterns,evidence:owned.evidence.map(span=>({...span,status:'quarantined' as const}))});
 expect(()=>builder.build({episodeId:ids.episodeId(),text:request,entailment:entailment(ids),evidence:owned.evidence,createdAt:clock.now(),programIntent:selected.intent,sourcePlanningContext:revoked})).toThrow(/do not match/);
 expect(construct.program!.nodes.filter(node=>node.kind==='program.module')).toHaveLength(3);
 expect(construct.program!.files.find(file=>file.path===construct.program!.entrypoint)!.content).toMatch(/^export \* from/u);
 expect(construct.program!.files.filter(file=>file.role==='source').every(file=>!file.content.includes('originalOpaque'))).toBe(true);
 const output=path.join(root,'independent-artifact');
 for(const artifact of passed.artifacts){const file=path.join(output,artifact.path);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,artifact.content);}
 const privateCheck=path.join(root,'private-check.mjs');
 await writeFile(privateCheck,"import assert from 'node:assert/strict'; const {opaque,opaqueAux}=await import(process.argv[2]); assert.equal(opaque.length,1); for(const x of [4,5,-3,0.5]){assert.equal(opaque(x),x**8+x);assert.equal(opaqueAux(x),x**8+x);} console.log('independent native behavior passed');");
 const entry=pathToFileURL(path.join(output,construct.program!.entrypoint)).href;
 const result=await promisify(execFile)(process.execPath,[privateCheck,entry],{timeout:30000});expect(result.stdout).toContain('independent native behavior passed');
 expect(JSON.stringify(owned.patterns)).not.toContain('independent native behavior');
});
function entailment(ids:ReturnType<typeof createIdFactory>):SemanticEntailmentResult {
 const claimId=ids.claimId('owned-source'),proofId=ids.proofId({claimId,evidenceIds:[],transforms:[],validatorVersion:'fixture'});
 return {claim:{id:claimId,text:'',normalized:'',features:[],polarity:1},verdict:'underdetermined',semanticVerdict:'underdetermined',force:'unknown',support:0,contradiction:0,faithfulnessLcb:0,
 confidence:{verdict:'underdetermined',support:0,contradiction:0,faithfulnessLcb:0,supportingEvidence:0,sourceVersions:[],structuralCoverage:0,roleCoverage:0,relationCompatibility:0,transformationSupport:0,causalMass:0,stability:1,satisfiedObligations:0,requiredObligations:0},
 scores:{structuralCoverage:0,roleCoverage:0,relationCompatibility:0,transformationSupport:0,causalMass:0,faithfulnessLCB:0,contradiction:0,stability:1},obligations:[],mappings:[],transforms:[],counterexamples:[],missing:[],evidenceIds:[],boundaries:[],proof:{id:proofId,claimId,verdict:'unknown',confidence:{},proofGraph:{nodes:[],edges:[]},evidenceIds:[],transformIds:[],scores:{},validatorVersion:'fixture',createdAt:200}};
}

it('refuses absent, revoked, foreign, changed-byte and forged-IR source providers on fresh selection',async()=>{
 const owned=await ownedSource();
 const context=(patterns=owned.patterns,evidence=owned.evidence)=>prepareProgramSourcePlanningContext({languageId:'typescript',patterns,evidence});
 expect(context().sourceIds).toHaveLength(1);
 expect(context(owned.patterns,[]).sourceIds).toEqual([]);
 expect(context(owned.patterns,owned.evidence.map(span=>({...span,status:'quarantined' as const}))).sourceIds).toEqual([]);
 expect(context(owned.patterns,owned.evidence.map(span=>({...span,text:span.text+' '}))).sourceIds).toEqual([]);
 const foreign=structuredClone(owned.patterns);foreign[0]!.informationLabel={...foreign[0]!.informationLabel!,tenantId:'foreign'};
 expect(context(foreign).sourceIds).toEqual([]);
 const forged=structuredClone(owned.patterns),row=forged[0]!.patternJson as unknown as {codeFunctionConstructions:Array<import('@scce/kernel').SourceCodeFunctionConstruction>};
 const construction=row.codeFunctionConstructions[0]!;construction.expression={kind:'literal',value:42};
 const {id:_old,...material}=construction;construction.id=sourceCodeFunctionConstructionId(material);
 expect(context(forged).sourceIds).toEqual([]);
});
it('never reads reserved outcomes while constructing or validating the unified implementation pool',async()=>{
 const owned=await ownedSource(),context=prepareProgramSourcePlanningContext({languageId:'typescript',...owned});
 const requirements=codeRequestSignal('TypeScript opaque(-2)=254; opaque(1)=2; opaque(2)=258; opaque(3)=6564').behaviorRequirements;
 const reserved={...requirements[0]!,id:'reserved-external',verificationRole:'held_out' as const,get expectedResult():never{throw new Error('reserved outcome read');}};
 const before=programImplementationCandidates(requirements,context).candidates.filter(candidate=>'sourceProvider' in candidate);
 const after=programImplementationCandidates([...requirements,reserved],context).candidates.filter(candidate=>'sourceProvider' in candidate);
 expect(after.map(candidate=>candidate.id)).toEqual(before.map(candidate=>candidate.id));
 expect(after.map(candidate=>candidate.heldOutObligationIds)).toEqual([[...requirements.filter(row=>row.verificationRole==='held_out').map(row=>row.id),'reserved-external'].sort()]);
});
