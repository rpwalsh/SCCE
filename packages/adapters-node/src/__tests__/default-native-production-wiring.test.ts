// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {mkdtemp,readFile,rm,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {NodeBuildTestAdapter} from "../process.js";
import type {ScceRuntimeConfig} from "../config.js";
import {pathToFileURL} from "node:url";
import {codeRequestSignal,programIntentForTurn,createClock,createHasher,createIdFactory,createProgramPlanner,COGNITIVE_OPERATOR_IDS,createProgramGraphBuilder,replanOwnerBehaviorProgramIntent,type SemanticEntailmentResult} from "@scce/kernel";

const languages=["typescript","javascript","python","rust","go"] as const;
type PublicCase={language:string;category:string;public:{outputContract:string;steps:Array<{prompt:string;files:Record<string,string>;sources:unknown[]}>}};
let root:string, rows:PublicCase[];
beforeAll(async()=>{
  root=await mkdtemp(path.join(tmpdir(),"scce-default-public-wiring-"));
  const moduleUrl=pathToFileURL(path.resolve("tools/blind-comparison/providers/default/cases.mjs")).href;
  const {createDefaultPool}=await import(moduleUrl);
  const capabilities={formalLanguages:[...languages],naturalLanguages:[]};
  const tools=Object.fromEntries(["node",...languages].map(language=>[language,{available:true,path:language==="python"?"python":process.execPath,compilerPath:language==="typescript"?createRequire(import.meta.url).resolve("typescript/bin/tsc"):process.execPath,budget:{timeMs:10000,outputBytes:131072}}]));
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
  it.each(["javascript","typescript","python"])("executes %s default public stateful drivers against the real requested module",async language=>{
    const row=rows.find(row=>row.language===language&&row.category==="code_generation_stateful")!,step=row.public.steps[0]!,requestText=step.prompt;
    const signal=codeRequestSignal(requestText),programIntent=programIntentForTurn({requestedAuthority:"program",activeOperatorIds:[COGNITIVE_OPERATOR_IDS.programPlanning],codeSignal:signal,evidence:[]})!;
    const hasher=createHasher(),ids=createIdFactory({hasher,clock:createClock({fixedTime:1}),deterministicReplay:true}),builder=createProgramGraphBuilder({idFactory:ids,hasher});
    const temp=await mkdtemp(path.join(tmpdir(),"scce-public-stateful-driver-"));
    try{
      const build=(intent:typeof programIntent)=>builder.build({episodeId:ids.episodeId(),text:requestText,createdAt:1,evidence:[],entailment:entailment(ids),programIntent:intent});
      const native=new NodeBuildTestAdapter({runtime:{tempRoot:temp}} as ScceRuntimeConfig),probe=build(programIntent);
      const failed=await native.executeProgram({episodeId:probe.episodeId,construct:probe});
      expect(failed.build.code,failed.build.stderr).toBe(0);expect(failed.passed).toBe(false);
      const retry=replanOwnerBehaviorProgramIntent({intent:programIntent,program:probe.program!,hasher,
       failure:{observationId:"actual-public-stateful-probe",programId:probe.program!.id,planHash:hasher.digestHex(JSON.stringify(probe.program!.files)),validatorId:"validator.actual-native",checkId:"tests",status:"failed",
        ownerRequirementIds:signal.statefulBehaviorRequirements.map(item=>item.id),command:probe.program!.test}});
      const selected=build(retry.intent),passed=await native.executeProgram({episodeId:selected.episodeId,construct:selected});
      expect(passed.passed,`${JSON.stringify(selected.program!.build)}\n${passed.build.stderr}\n${passed.test.stderr}`).toBe(true);
      const publicRoot=path.join(temp,"public");await mkdir(publicRoot);
      for(const [name,text] of Object.entries(step.files)){const target=path.join(publicRoot,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,text);}
      for(const artifact of passed.artifacts){const target=path.join(publicRoot,artifact.path);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,artifact.content);}
      if(language==="typescript"){
        try{await promisify(execFile)(process.execPath,[createRequire(import.meta.url).resolve("typescript/bin/tsc"),"-p","tsconfig.json"],{cwd:publicRoot,timeout:60000});}
        catch(error){const result=error as Error & {stdout?:string;stderr?:string};throw new Error(`${result.message}\n${result.stdout}\n${result.stderr}`);}
      }
      await promisify(execFile)(process.execPath,["public-check.mjs"],{cwd:publicRoot,timeout:60000});
      const requirements=signal.statefulBehaviorRequirements;
      const names={write:requirements[0]!.invocations[0]!.callableId,read:requirements[0]!.invocations.at(-1)!.callableId,remove:requirements[2]!.invocations.at(-2)!.callableId};
      const secret="sealed-\u03bb-\ud83e\udeb6",other="__proto__";
      if(language==="python"){
        const script=`import module\nnames=${JSON.stringify(names)}\nkey=${JSON.stringify(secret)}\nother=${JSON.stringify(other)}\nw,r,d=(getattr(module,names[role]) for role in ("write","read","remove"))\nassert r(key)=="~"\nw(key,"993");w(other,"994");w(key,"995")\nassert r(key)=="995" and r(other)=="994"\nd(key)\nassert r(key)=="~" and r(other)=="994"\np,q=module.createStatefulProgram(),module.createStatefulProgram()\np[names["write"]](key,"996")\nassert p[names["read"]](key)=="996" and q[names["read"]](key)=="~"\n`;
        const validator=path.join(publicRoot,"sealed_check.py");await writeFile(validator,script);await promisify(execFile)("python",[validator],{cwd:publicRoot,timeout:30000});
      }else{
        const target=language==="typescript"?"./.native-build/module.js":"./module.cjs";
        const script=`const assert=require('node:assert/strict'),m=require(${JSON.stringify(target)}),names=${JSON.stringify(names)},key=${JSON.stringify(secret)},other=${JSON.stringify(other)};const w=m[names.write],r=m[names.read],d=m[names.remove];assert.equal(r(key),'~');w(key,'993');w(other,'994');w(key,'995');assert.equal(r(key),'995');assert.equal(r(other),'994');d(key);assert.equal(r(key),'~');assert.equal(r(other),'994');const p=m.createStatefulProgram(),q=m.createStatefulProgram();p[names.write](key,'996');assert.equal(p[names.read](key),'996');assert.equal(q[names.read](key),'~');`;
        const validator=path.join(publicRoot,"sealed_check.cjs");await writeFile(validator,script);await promisify(execFile)(process.execPath,[validator],{cwd:publicRoot,timeout:30000});
      }
      expect(JSON.stringify(row.public)).not.toContain(secret);
    }finally{await rm(temp,{recursive:true,force:true});}
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
