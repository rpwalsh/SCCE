// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {describe,it,expect} from "vitest";
import {acquireSourceComputationConstructions,verifySourceComputationConstruction,evaluateSourceComputationRequest,sourceComputationResultVerified,sourceComputationBindingIdForRequest} from "../source-computation-acquisition.js";
import {createHasher,canonicalStringify,createClock,createIdFactory,createScceKernel,createInMemoryDialogueMemoryStore,type EvidenceSpan,type LanguagePatternRecord,type TranscriptTurn} from "../index.js";
import {sourceComputationForRequest} from "../source-computation-runtime.js";
import {storageFixtureForEvaluation} from "./evidence-promotion-evaluation-fixture.js";
import {exactProgramForExpression,exactComputationForExpression} from "../exact-computation.js";
const hasher=createHasher();
const locales=[
 {id:"en",question:(a:number,b:number)=>`What is the sum of ${a} and ${b}?`,expression:(a:number,b:number)=>`${a}+${b}`,values:[[7,3],[11,5],[19,13],[23,17]]},
 {id:"ru",question:(a:number,b:number)=>`\u0427\u0435\u043c\u0443 \u0440\u0430\u0432\u043d\u043e \u043f\u0440\u043e\u0438\u0437\u0432\u0435\u0434\u0435\u043d\u0438\u0435 ${a} \u0438 ${b}?`,expression:(a:number,b:number)=>`${a}*${b}`,values:[[7,3],[11,5],[19,13],[23,17]]},
 {id:"es",question:(a:number,b:number)=>`Resta ${a} de ${b}.`,expression:(a:number,b:number)=>`${b}-${a}`,values:[[7,3],[11,5],[19,13],[23,17]]},
 {id:"ca",question:(a:number,b:number)=>`Quin \u00e9s el quocient de ${a} entre ${b}?`,expression:(a:number,b:number)=>`${a}/${b}`,values:[[12,3],[30,5],[56,7],[90,9]]}
] as const;
function document(question:string,equation:string,index:string){
 const text=`${question}\n${equation}`,hash=hasher.digestHex(text),sourceVersionId=`source.version.${hash}`,sourceId=`source.public.${index}`,profileId=`profile.${hash}`;
 const span={id:`evidence.${hash}`,sourceId,sourceVersionId,contentHash:`sha256_${hash}`,charStart:0,charEnd:[...text].length,text,status:"promoted",alpha:1} as unknown as EvidenceSpan;
 const turns:TranscriptTurn[]=[{index:0,speakerId:"source.request",surface:question,startCodePoint:0,endCodePoint:[...question].length},{index:1,speakerId:"source.reply",surface:equation,startCodePoint:[...question].length+1,endCodePoint:[...text].length,replyToTurnIndex:0,commitmentScope:"conversation"}];
 return {sourceVersionId,profileId,spans:[span],transcriptTurns:turns};
}
function corpus(locale:typeof locales[number]){return locale.values.map(([a,b],i)=>{const expression=locale.expression(a,b),value=locale.id==="en"?a+b:locale.id==="ru"?a*b:locale.id==="es"?b-a:a/b;return document(locale.question(a,b),`${expression}=${value}`,`${locale.id}.${i}`);});}
function acquired(locale:typeof locales[number]){const documents=corpus(locale),evidence=documents.flatMap(doc=>doc.spans),compiled=acquireSourceComputationConstructions({documents,hasher,updatedAt:1});return {documents,evidence,compiled};}
describe("source-owned arithmetic construction acquisition",()=>{
 it("shares the exact formal parser without rounding unsafe IR literals or treating units as scalar operators",()=>{
  expect(exactProgramForExpression("(7+3)*2")).toEqual({kind:"binary",operator:"multiply",left:{kind:"binary",operator:"add",left:{kind:"literal",value:7},right:{kind:"literal",value:3}},right:{kind:"literal",value:2}});
  expect(exactProgramForExpression("9007199254740993+1")).toBeUndefined();
  expect(exactComputationForExpression("9007199254740993+1")?.resultText).toBe("9007199254740994");
  expect(exactProgramForExpression("7kg+3kg")).toBeUndefined();
  expect(exactComputationForExpression("7\u22123")?.resultText).toBe("4");
 });
 it.each(locales)("learns $id operator/order from independent source equations, binds unseen values through the ordinary frame interpreter and cold-verifies provenance",locale=>{
  const data=acquired(locale);expect(data.compiled.families,data.compiled.rejected.map(row=>row.reason).join(",")).toHaveLength(1);
  const pattern=JSON.parse(JSON.stringify(data.compiled.families[0]!.pattern)) as LanguagePatternRecord;
  const verified=verifySourceComputationConstruction({pattern,evidence:JSON.parse(JSON.stringify(data.evidence)),hasher});expect(verified).toBeDefined();
  const requestText=locale.question(101,37),result=evaluateSourceComputationRequest({requestText,constructions:[verified!],hasher});
  const expected=locale.id==="en"?"138":locale.id==="ru"?"3737":locale.id==="es"?"-64":"101/37";
  expect(result?.evaluation.resultText).toBe(expected);expect(sourceComputationResultVerified(result,requestText,hasher)).toBe(true);
  expect(result!.roleBindings.map(role=>[...requestText].slice(role.startCodePoint,role.endCodePoint).join(""))).toEqual(["101","37"]);
  expect(sourceComputationResultVerified({...result!},requestText,hasher)).toBe(false);
  expect(evaluateSourceComputationRequest({requestText:`prefix ${requestText}`,constructions:[verified!],hasher})).toBeUndefined();
 });
 it("earns and composes a three-role source program without inferring operator order from word position",()=>{
  const values=[[7,3,2],[11,5,3],[19,13,4],[23,17,5]],documents=values.map(([a,b,c],index)=>document(`mav ${a} tor ${b} vel ${c}?`,`(${a}+${b})*${c}=${(a!+b!)*c!}`,`public.multistep.${index}`));
  const compiled=acquireSourceComputationConstructions({documents,hasher,updatedAt:1});expect(compiled.families).toHaveLength(1);
  const verified=verifySourceComputationConstruction({pattern:compiled.families[0]!.pattern,evidence:documents.flatMap(doc=>doc.spans),hasher});
  expect(evaluateSourceComputationRequest({requestText:"mav 101 tor 37 vel 2?",constructions:[verified!],hasher})?.evaluation.resultText).toBe("276");
 });
 it("uses an independent source-held-out equation only to reject, never to choose the operator",()=>{
  const documents=corpus(locales[0]),last=documents[3]!;documents[3]=document(last.transcriptTurns[0]!.surface,"23*17=391","en.3");
  expect(acquireSourceComputationConstructions({documents,hasher,updatedAt:1}).families).toEqual([]);
 });
 it("does not turn numeric world-fact correlations or unsupported question forms into executable arithmetic",()=>{
  const documents=corpus(locales[0]).map(doc=>{const question=doc.transcriptTurns[0]!.surface,equation=doc.transcriptTurns[1]!.surface;return document(question,equation.split("=")[1]!,doc.spans[0]!.sourceId);});
  expect(acquireSourceComputationConstructions({documents,hasher,updatedAt:1}).families).toEqual([]);
 });
 it("rejects non-independent, contradictory/incorrect, inaccessible and tampered source witnesses",()=>{
  const data=acquired(locales[0]),pattern=data.compiled.families[0]!.pattern;
  expect(verifySourceComputationConstruction({pattern,evidence:data.evidence.slice(1),hasher})).toBeUndefined();
  expect(verifySourceComputationConstruction({pattern,evidence:data.evidence.map((span,i)=>i?span:{...span,status:"quarantined"}),hasher})).toBeUndefined();
  const changed=JSON.parse(JSON.stringify(pattern)) as LanguagePatternRecord;(changed.patternJson as any).expression={kind:"binary",operator:"multiply",left:{kind:"argument",index:0},right:{kind:"argument",index:1}};
  expect(verifySourceComputationConstruction({pattern:changed,evidence:data.evidence,hasher})).toBeUndefined();
  expect(verifySourceComputationConstruction({pattern:{...pattern,patternJson:{...(pattern.patternJson as any),witnesses:[null]}},evidence:data.evidence,hasher})).toBeUndefined();
  const copied=data.documents.map(doc=>({...doc,spans:doc.spans.map(span=>({...span,sourceId:data.evidence[0]!.sourceId}))}));
  expect(acquireSourceComputationConstructions({documents:copied,hasher,updatedAt:1}).families).toEqual([]);
  const wrong=corpus(locales[0]).map((doc,i)=>i?doc:document(doc.transcriptTurns[0]!.surface,"7+3=999","en.0"));
  expect(acquireSourceComputationConstructions({documents:wrong.slice(0,3),hasher,updatedAt:1}).families).toEqual([]);
  const contradictory=corpus(locales[0]).map((doc,i)=>i?doc:document(doc.transcriptTurns[0]!.surface,"7*3=21","en.0"));
  expect(acquireSourceComputationConstructions({documents:contradictory,hasher,updatedAt:1}).families).toEqual([]);
 });
 it("rejects unresolved subtraction order despite matching numeric observations",()=>{
  const documents=[7,11,19,23].map((value,i)=>document(`opaque ${value} between ${value}?`,`${value}-${value}=0`,`ambiguous.${i}`));
  expect(acquireSourceComputationConstructions({documents,hasher,updatedAt:1}).families).toEqual([]);
 });
 it("preserves Unicode source point ownership and refuses a mathematically unrelated range request",()=>{
  const locale={...locales[0],question:(a:number,b:number)=>`\u{1fab6} \u03b6 ${a} \u03c8 ${b}\uFF1F`},data=acquired(locale),verified=verifySourceComputationConstruction({pattern:data.compiled.families[0]!.pattern,evidence:data.evidence,hasher});
  const requestText=locale.question(103,41),result=evaluateSourceComputationRequest({requestText,constructions:[verified!],hasher});expect(result?.evaluation.resultText).toBe("144");
  expect(evaluateSourceComputationRequest({requestText:"Escriu 7-10 frases.",constructions:[verified!],hasher})).toBeUndefined();
 });
 it("uses one exact owned-question query when the measured language identity differs from the source owner",async()=>{
  const data=acquired(locales[0]),fixture=storageFixtureForEvaluation({evidence:data.evidence,clockNow:()=>1});
  const ownerLanguageId="language.fixture.owner",statisticalLanguageId="language.fixture.question",queries:unknown[]=[];
  fixture.storage.languageMemory.listLanguagePatterns=async query=>{
   queries.push(query);
   // Mirrors canonical PG's lp.language_id=$n OR NULL predicate rather than ignoring language scope.
   if(query?.languageId&&query.languageId!==ownerLanguageId)return [];
   return query?.sourceComputationBindingId===sourceComputationBindingIdForRequest(locales[0].question(101,37),hasher)?data.compiled.families.map(row=>row.pattern):[];
  };
  expect(await fixture.storage.languageMemory.listLanguagePatterns({languageId:statisticalLanguageId,sourceComputationBindingId:sourceComputationBindingIdForRequest(locales[0].question(101,37),hasher)})).toEqual([]);
  queries.length=0;
  const requestContext={storage:fixture.storage,hasher,requestText:locales[0].question(101,37),languageId:statisticalLanguageId};
  const result=await sourceComputationForRequest(requestContext);
  expect(result?.evaluation.resultText).toBe("138");expect(queries).toHaveLength(1);
  expect(queries[0]).toEqual({patternSchemas:["scce.source_owned_computation_construction.v1"],sourceSystem:"dialogue",sourceComputationBindingId:sourceComputationBindingIdForRequest(locales[0].question(101,37),hasher)});
 });
 it.each(locales)("answers an ordinary unseen $id question through real kernel/Mouth computation authority and refuses after source revocation",async locale=>{
  const data=acquired(locale),clock=createClock({fixedTime:1,stepMs:1}),fixture=storageFixtureForEvaluation({evidence:data.evidence,clockNow:()=>clock.now()});let active=true;
  fixture.storage.languageMemory.listLanguagePatterns=async query=>{if(!query?.patternSchemas?.includes("scce.source_owned_computation_construction.v1"))return [];expect(query.sourceComputationBindingId).toBe(sourceComputationBindingIdForRequest(locale.question(101,37),hasher));return active?data.compiled.families.map(row=>row.pattern):[];};
  fixture.storage.userModelClaims={putClaim:async()=>undefined,listClaims:async()=>[]};fixture.storage.taskResumption={putSnapshot:async()=>undefined,getLatestSnapshot:async()=>null};fixture.storage.documentGeneration={putSession:async()=>undefined,getSession:async()=>null,compareAndPutSession:async()=>({stored:true,currentUpdatedAt:null})};fixture.storage.dialogueMemory=createInMemoryDialogueMemoryStore();
  const kernel=createScceKernel({storage:fixture.storage,files:{streamPath:async function*(){}},buildTest:{executeProgram:async()=>{throw Error("Computation must not execute a program process");}},clock,idFactory:createIdFactory({clock,hasher,deterministicReplay:true}),deterministicReplay:true});
  const requestText=locale.question(101,37),result=await kernel.turn({text:requestText,requestedAuthority:"factual"});
  expect(result.events.some(event=>event.typeId==="ComputationEvaluated"),result.answer).toBe(true);
  expect(result.events.some(event=>event.typeId==="MouthSpoken"),JSON.stringify(result.mouth)).toBe(true);
  expect(JSON.stringify(result.mouth)).toContain("verified_computation");expect(result.answer).toContain(locale.id==="en"?"138":locale.id==="ru"?"3737":locale.id==="es"?"-64":"101/37");
  active=false;const refused=await kernel.turn({text:requestText,requestedAuthority:"factual"});expect(refused.events.some(event=>event.typeId==="ComputationEvaluated")).toBe(false);
 });
});
