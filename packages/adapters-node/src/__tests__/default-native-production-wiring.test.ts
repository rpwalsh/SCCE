// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {codeRequestSignal,programIntentForTurn,createClock,createHasher,createIdFactory,createProgramPlanner,COGNITIVE_OPERATOR_IDS,type SemanticEntailmentResult} from "@scce/kernel";

const languages=["typescript","javascript","python","rust","go"] as const;
type PublicCase={language:string;category:string;public:{outputContract:string;steps:Array<{prompt:string;files:Record<string,string>;sources:unknown[]}>}};
let root:string, rows:PublicCase[];
beforeAll(async()=>{
  root=await mkdtemp(path.join(tmpdir(),"scce-default-public-wiring-"));
  const moduleUrl=pathToFileURL(path.resolve("tools/blind-comparison/providers/default/cases.mjs")).href;
  const {createDefaultPool}=await import(moduleUrl);
  const capabilities={formalLanguages:[...languages],naturalLanguages:[]};
  const tools=Object.fromEntries(["node",...languages].map(language=>[language,{available:true,path:process.execPath,compilerPath:process.execPath,budget:{timeMs:10000,outputBytes:131072}}]));
  const inventory={...capabilities,cells:languages.flatMap(language=>["code_generation_stateful","code_generation_numeric"].map(category=>({language,category,grading:"native"})))};
  const result=await createDefaultPool({seed:"test-authored public wiring regression",privateRoot:root,inventory,tools,count:2,attempts:2,hiddenVectors:2,
    budgets:{timeMs:10000,outputBytes:131072,artifactBytes:131072,caseBytes:262144,maxSteps:4}});
  rows=(await readFile(result.poolFile,"utf8")).trim().split("\n").map(line=>{const row=JSON.parse(line);return {language:row.language,category:row.category,public:row.public};});
});
afterAll(async()=>{await rm(root,{recursive:true,force:true});});

// The ordinary public request enters the actual code-signal?intent?planner handoff without typed metadata or substituted source contracts.
describe("default public native provider production handoff",()=>{
  it.each(languages)("keeps %s public stateful requests in their declared formal language",language=>{
    for(const row of rows.filter(row=>row.language===language && row.category==="code_generation_stateful")){
      expect(codeRequestSignal(row.public.steps[0]!.prompt).language).toBe(language);
    }
  });

  it.each(["typescript","javascript","python"])("preserves %s public generation target paths in emitted artifacts",language=>{
    for(const row of rows.filter(row=>row.language===language)){
      const contract=JSON.parse(row.public.outputContract), requestText=row.public.steps[0]!.prompt;
      const signal=codeRequestSignal(requestText);
      const intent=programIntentForTurn({requestedAuthority:"program",activeOperatorIds:[COGNITIVE_OPERATOR_IDS.programPlanning],codeSignal:signal,evidence:[]})!;
      const hasher=createHasher(),ids=createIdFactory({hasher,clock:createClock({fixedTime:1}),deterministicReplay:true});
      const emitted=createProgramPlanner({idFactory:ids,hasher}).emitIfAvailable({episodeId:ids.episodeId(),requestText,evidence:[],programIntent:intent,entailment:entailment(ids)});
      expect(emitted.availability,`${row.category}/${language}`).toEqual({status:"available",languageId:language,reasonIds:[]});
      expect(emitted.program!.files.map(file=>file.path),row.category).toContain(contract.targetPaths[0]);
    }
  });
  it.each(["typescript","javascript"])("preserves %s immutable public driver and package files",language=>{
    for(const row of rows.filter(row=>row.language===language)){
      const contract=JSON.parse(row.public.outputContract),step=row.public.steps[0]!,requestText=step.prompt;
      const signal=codeRequestSignal(requestText),intent=programIntentForTurn({requestedAuthority:"program",activeOperatorIds:[COGNITIVE_OPERATOR_IDS.programPlanning],codeSignal:signal,evidence:[]})!;
      const hasher=createHasher(),ids=createIdFactory({hasher,clock:createClock({fixedTime:1}),deterministicReplay:true});
      const emitted=createProgramPlanner({idFactory:ids,hasher}).emitIfAvailable({episodeId:ids.episodeId(),requestText,evidence:[],programIntent:intent,entailment:entailment(ids)});
      const collisions=emitted.program!.files.filter(file=>Object.hasOwn(step.files,file.path)&&!contract.writablePaths.includes(file.path)&&file.content!==step.files[file.path]).map(file=>file.path);
      expect(collisions,row.category).toEqual([]);
    }
  });

});
function entailment(ids:ReturnType<typeof createIdFactory>):SemanticEntailmentResult{
 const claimId=ids.claimId("public native handoff"),proofId=ids.proofId({claimId,evidenceIds:[],transforms:[],validatorVersion:"fixture"});
 return {claim:{id:claimId,text:"",normalized:"",features:[],polarity:1},verdict:"underdetermined",semanticVerdict:"underdetermined",force:"unknown",support:0,contradiction:0,faithfulnessLcb:0,
 confidence:{verdict:"underdetermined",support:0,contradiction:0,faithfulnessLcb:0,supportingEvidence:0,sourceVersions:[],structuralCoverage:0,roleCoverage:0,relationCompatibility:0,transformationSupport:0,causalMass:0,stability:1,satisfiedObligations:0,requiredObligations:0},
 scores:{structuralCoverage:0,roleCoverage:0,relationCompatibility:0,transformationSupport:0,causalMass:0,faithfulnessLCB:0,contradiction:0,stability:1},obligations:[],mappings:[],transforms:[],counterexamples:[],missing:[],evidenceIds:[],boundaries:[],
 proof:{id:proofId,claimId,verdict:"unknown",confidence:{},proofGraph:{nodes:[],edges:[]},evidenceIds:[],transformIds:[],scores:{},validatorVersion:"fixture",createdAt:1}};
}
