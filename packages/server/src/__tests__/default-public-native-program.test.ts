// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {it,expect} from "vitest";
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
import {ordinaryWorkspaceProgramFixture} from "../../../adapters-node/src/__tests__/fixtures/ordinary-workspace-program.js";
import {findCodeVerifierCapability} from "../../../adapters-node/src/index.js";
import {pendingProgramValidationApproval} from "../program-validation-approval.js";
import {readWorkspaceOwnedProgramContracts} from "@scce/kernel";

it.each(["go","rust"])("executes the exact default public %s stateful generation packet through ordinary workspace ownership",async language=>{
 const capabilities=await Promise.all([findCodeVerifierCapability("go"),findCodeVerifierCapability("rust")]);
 if(capabilities.some(row=>row.status!=="available"))throw Error("Default native comparison requires the declared Go and Rust compilers");
 const nativeTool=(index:number)=>{const row=capabilities[index]!;if(row.status!=="available")throw Error("Native compiler unavailable");return{available:true,path:row.verifier.command,version:row.verifier.version,budget:{timeMs:120000,outputBytes:2000000}};};
 const base=await mkdtemp(path.join(tmpdir(),"scce-default-public-native-")),root=path.join(base,"public"),privateRoot=path.join(base,"not-ingested-empty-validator");
 await mkdir(root);await mkdir(privateRoot);
 try{
  const module=async(name:string)=>import(pathToFileURL(path.resolve("tools/blind-comparison",name)).href);
  const {codeCase,randomStream}=await module("providers/default/cases.mjs"),{nativeContract,applyArtifacts,runPublicChecks}=await module("adapters/native-contract.mjs"),{nativeProgramApprovalAllowed}=await module("adapters/native-program-approval.mjs"),{execute}=await module("runner.mjs");
  const tools={node:{available:true,path:process.execPath,version:process.version,budget:{timeMs:120000,outputBytes:2000000}},go:nativeTool(0),rust:nativeTool(1)};
  const budgets={timeMs:120000,outputBytes:2000000,caseBytes:4000000,artifactBytes:2000000,maxSteps:4};
  const generated=await codeCase({category:"code_generation_stateful",language,grading:"native"},0,randomStream("test_authored.public_only","native-packet"),{tools,attempts:2,hiddenVectors:0,privateRoot,budgets},"test_authored_public_case");
  const packet=generated.public,input={...packet,caseId:"test_authored_public_case",category:"code_generation_stateful",language,budgets,history:[],isolation:{mode:"trusted-host"}};
  const contract=nativeContract(input),files=packet.steps[0].files as Record<string,string>;
  for(const [name,content] of Object.entries(files)){await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),content,"utf8");}
  await expect(access(path.join(root,contract.targetPaths[0]))).rejects.toThrow();
  const fixture=ordinaryWorkspaceProgramFixture(root),ingested=await fixture.runtime.ingest(root,{maxFiles:100,maxFileBytes:1000000});
  expect(ingested.failed).toBe(0);
  const context={schema:"scce.workspace.program-context.v1",workspaceId:ingested.workspace.id,expectedWorkspaceUpdatedAt:ingested.workspace.updatedAt};
  const owned=await readWorkspaceOwnedProgramContracts({storage:fixture.storage,context,informationAccess:{tenantId:"workspace-contract-test",principalId:"owner",compartments:[],maximumExportClass:"restricted"}});
  expect(owned.status,JSON.stringify({receipt:ingested.sourceContracts,owned})).toBe("available");
  if(owned.status!=="available")throw Error(owned.reasonId);
  expect(owned.contracts.filter(row=>(row.patternJson as {schema?:string}).schema==="scce.source_owned_native_declaration.v1")).toHaveLength(3);
  let turn;
  for(let step=0;step<budgets.maxSteps;step++){
   turn=await fixture.kernel.turn({text:packet.steps[0].prompt,requestedAuthority:"program",metadata:{workspaceProgramContext:context}});
   if(turn.buildTest?.passed)break;
   const pending=pendingProgramValidationApproval({events:turn.events,pending:fixture.approvals.snapshot().pending});
   expect(pending,JSON.stringify({program:turn.constructGraph.program&&{language:turn.constructGraph.program.language,diagnostics:turn.constructGraph.program.hydration?.diagnostics},nodes:turn.constructGraph.nodes.filter(row=>row.kind==="program_emission_unavailable"),build:turn.buildTest&&{build:turn.buildTest.build,test:turn.buildTest.test}})).toBeDefined();
   expect(nativeProgramApprovalAllowed({input,contract,pending}),JSON.stringify(pending)).toBe(true);
   fixture.approvals.approve(String(pending!.planId));
  }
  expect(turn?.buildTest?.passed).toBe(true);expect(turn?.constructGraph.program?.language).toBe(language);
  const artifacts=Object.fromEntries(turn!.buildTest!.artifacts.map(file=>[file.path,file.content]));
  await applyArtifacts(root,artifacts,contract,budgets.artifactBytes);
  const checked=await runPublicChecks(contract,input,{cwd:root,executeCommand:execute,remainingMs:()=>budgets.timeMs});
  expect(checked.passed,JSON.stringify(checked)).toBe(true);
  for(const [name,content] of Object.entries(files))expect(await readFile(path.join(root,name),"utf8")).toBe(content);
  const originalPaths=fixture.versions.filter(row=>row.role!=="evidence-derivative").map(row=>(row.metadata as {workspaceFile?:{path?:string}}).workspaceFile?.path);
  expect(originalPaths.length).toBeGreaterThan(0);expect(originalPaths.every(name=>typeof name==="string"&&Object.hasOwn(files,name))).toBe(true);
  expect(originalPaths).toContain("specification.txt");
  expect(await fixture.storage.model.listLanguageProfiles()).toHaveLength(0);
 }finally{await rm(base,{recursive:true,force:true});}
});
