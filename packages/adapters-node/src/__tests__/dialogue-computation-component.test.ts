// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {it,expect,vi} from "vitest";
import {persistDialogueComputationComponent} from "../dialogue-computation-component.js";
import {corpusSourceVersionIdFor} from "../language-corpus-trainer.js";
import {createHasher,createLanguageAcquisitionEngine,createClock,createIdFactory,canonicalStringify,SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA as SCHEMA,SOURCE_COMPUTATION_CONSTRUCTION_RECIPE as RECIPE,sourceComputationForRequest,type EvidenceSpan,type LanguagePatternRecord,type LanguagePatternProjection,type ScceStorage,type TranscriptTurn} from "@scce/kernel";
const hasher=createHasher();
const label={tenantId:"public-math-fixture",principals:["owner"],compartments:[],exportClass:"confidential" as const,mergePolicy:"same_owner" as const};
function source(a:number,b:number,index:number){const question=`mav ${a} tor ${b}?`,equation=`${a}+${b}=${a+b}`,text=`${question}\n${equation}`,sourceUri=`fixture://accepted-public-source/${index}`;
 const transcriptTurns:TranscriptTurn[]=[{index:0,speakerId:"owner",surface:question,startCodePoint:0,endCodePoint:[...question].length},{index:1,speakerId:"respondent",surface:equation,startCodePoint:[...question].length+1,endCodePoint:[...text].length,replyToTurnIndex:0,commitmentScope:"conversation"}];return {sourceUri,text,transcriptTurns};}
it("ordinary source auxiliary publication is atomic, survives cold JSON, skips unchanged replay, restores a missing projection and suppresses superseded/inaccessible source dependencies",async()=>{
 const sources=[source(7,3,0),source(11,5,1),source(19,13,2),source(23,17,3)],clock=createClock({fixedTime:1}),ids=createIdFactory({clock,hasher,deterministicReplay:true}),language=createLanguageAcquisitionEngine({idFactory:ids});
 const evidence=sources.map(file=>{const sourceVersionId=corpusSourceVersionIdFor(file),contentHash=ids.contentHash(file.text);return {id:ids.evidenceId({sourceVersionId,byteStart:0,byteEnd:Buffer.byteLength(file.text),spanHash:contentHash}),sourceId:ids.sourceId("dialogue",file.sourceUri),sourceVersionId,contentHash,charStart:0,charEnd:[...file.text].length,text:file.text,status:"promoted",alpha:1,informationLabel:label} as unknown as EvidenceSpan;});
 const profiles=sources.map(file=>language.acquire({sourceVersionId:corpusSourceVersionIdFor(file),text:file.text,createdAt:1})),patterns=new Map<string,LanguagePatternRecord>(),projections=new Map<string,LanguagePatternProjection>(),checkpoints=new Map<string,any>();
 const currentVersions=new Set(evidence.map(span=>String(span.sourceVersionId))),accessible=new Set(evidence.map(span=>String(span.id)));let writes=0;
 const key=(projection:LanguagePatternProjection)=>canonicalStringify([projection.profileId,projection.sourceId,projection.sourceSystem,projection.patternSchema,projection.componentRecipe]);
 const valid=(projection:LanguagePatternProjection)=>projection.sourceDependencies?.every(dependency=>currentVersions.has(String(dependency.sourceVersionId))&&dependency.evidenceIds.every(id=>accessible.has(String(id))))??false;
 const storage={transaction:async<T>(operation:()=>Promise<T>)=>operation(),ingestion:{get:async(id:string)=>checkpoints.get(id)??null,put:async(row:any)=>{checkpoints.set(row.id,JSON.parse(JSON.stringify(row)));}},
  model:{listLanguageProfiles:async(query:any)=>profiles.filter(profile=>query.sourceVersionIds.includes(profile.sourceVersionId))},
  evidence:{searchEvidence:async(query:any)=>evidence.filter(span=>span.sourceVersionId===query.sourceVersionId&&span.status==="promoted"&&accessible.has(String(span.id))).map(span=>({span,score:1})),getEvidenceBatch:async(ids:readonly string[])=>evidence.filter(span=>ids.includes(String(span.id))&&accessible.has(String(span.id)))},
  languageMemory:{getLanguagePatternProjection:async(query:LanguagePatternProjection)=>{const projection=projections.get(key(query));return projection&&valid(projection)?JSON.parse(JSON.stringify(projection)):undefined;},
   replaceLanguagePatternProjection:async(input:{patterns:LanguagePatternRecord[];projection:LanguagePatternProjection})=>{expect(valid(input.projection)).toBe(true);expect(input.projection.patternSchema).toBe(SCHEMA);expect(input.projection.componentRecipe).toBe(RECIPE);for(const row of input.patterns)patterns.set(row.id,JSON.parse(JSON.stringify(row)));projections.set(key(input.projection),JSON.parse(JSON.stringify(input.projection)));writes++;},
   listLanguagePatterns:async(query:any)=>[...patterns.values()].filter(pattern=>(!query.patternIds||query.patternIds.includes(pattern.id))&&(!query.patternSchemas||query.patternSchemas.includes((pattern.patternJson as any).schema))&&[...projections.values()].some(projection=>valid(projection)&&projection.patternIds.includes(pattern.id)))}} as unknown as ScceStorage;
 const input={storage,rootUri:"fixture://public-math-root",informationLabel:label,authorship:"human_authored",sources};
 const first=await persistDialogueComputationComponent(input);expect(first).toMatchObject({pairs:4,patternsPersisted:1,unchanged:false});expect(writes).toBe(1);
 const originalProfileIds=profiles.map(profile=>profile.id),originalVersions=evidence.map(span=>span.sourceVersionId);
 const getEvidence=vi.spyOn(storage.evidence,"searchEvidence");getEvidence.mockClear();
 expect(await persistDialogueComputationComponent(input)).toMatchObject({unchanged:true});expect(getEvidence).not.toHaveBeenCalled();expect(writes).toBe(1);expect(profiles.map(profile=>profile.id)).toEqual(originalProfileIds);expect(evidence.map(span=>span.sourceVersionId)).toEqual(originalVersions);
 const coldRead=vi.spyOn(storage.evidence,"getEvidenceBatch");
 expect((await sourceComputationForRequest({storage,requestText:"mav 101 tor 37?",hasher,generation:0}))?.evaluation.resultText).toBe("138");
 const reads=coldRead.mock.calls.length;expect((await sourceComputationForRequest({storage,requestText:"mav 103 tor 41?",hasher,generation:0}))?.evaluation.resultText).toBe("144");expect(coldRead.mock.calls).toHaveLength(reads);
 expect(await sourceComputationForRequest({storage,requestText:"mav 101 tor 37?",hasher,generation:0,sourceVersionAllowlist:[]})).toBeUndefined();
 projections.clear();expect(await sourceComputationForRequest({storage,requestText:"mav 101 tor 37?",hasher,generation:0})).toBeUndefined();
 expect(await persistDialogueComputationComponent(input)).toMatchObject({patternsPersisted:1,unchanged:false});expect(writes).toBe(2);
 const withheld=evidence[0]!;accessible.delete(String(withheld.id));expect(await sourceComputationForRequest({storage,requestText:"mav 101 tor 37?",hasher})).toBeUndefined();accessible.add(String(withheld.id));
 currentVersions.delete(String(withheld.sourceVersionId));expect(await sourceComputationForRequest({storage,requestText:"mav 101 tor 37?",hasher})).toBeUndefined();
 currentVersions.add(String(withheld.sourceVersionId));
 const oldReceipt=[...checkpoints.values()][0]!;oldReceipt.metadata.compilerFingerprint="kernel.dialogue_computation_construction.v1";oldReceipt.metadata.projections=[];
 const beforeUpgrade=writes;getEvidence.mockClear();
 expect(await persistDialogueComputationComponent(input)).toMatchObject({patternsPersisted:1,unchanged:false});expect(writes).toBe(beforeUpgrade+1);expect(getEvidence).toHaveBeenCalledTimes(sources.length);
 getEvidence.mockClear();expect(await persistDialogueComputationComponent(input)).toMatchObject({unchanged:true});expect(writes).toBe(beforeUpgrade+1);expect(getEvidence).not.toHaveBeenCalled();
 expect(profiles.map(profile=>profile.id)).toEqual(originalProfileIds);expect(evidence.map(span=>span.sourceVersionId)).toEqual(originalVersions);

});
