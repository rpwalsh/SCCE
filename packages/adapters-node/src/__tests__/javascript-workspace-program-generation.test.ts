// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {it,expect} from "vitest";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {ordinaryWorkspaceProgramFixture} from "./fixtures/ordinary-workspace-program.js";
import {readWorkspaceOwnedProgramContracts} from "@scce/kernel";
it.each([false,true])("retains ordinary CommonJS generation with a configless native driver (nested source root: %s)",async(nested)=>{
 const base=await mkdtemp(path.join(tmpdir(),"scce-js-generation-route-"));
 const root=nested?path.join(base,"nested \u0394 workspace"):base;await mkdir(root,{recursive:true});
 try{
  const spec="freshTripleDot(left,middle,right)\nfreshTripleDot(2,3,4) => 14\nfreshTripleDot(-1,5,2) => 9\nfreshTripleDot(4,-2,3) => -2";
  await writeFile(path.join(root,"package.json"),JSON.stringify({private:true,type:"commonjs"}));
  await writeFile(path.join(root,"driver.cjs"),'const m=require("./fresh-cargo.cjs");const p=JSON.parse(process.argv[2]);console.log(m.freshTripleDot(...p));');
  await writeFile(path.join(root,"specification.txt"),spec);
  const fixture=ordinaryWorkspaceProgramFixture(root,{runtimeWorkspaceRoot:base}),ingested=await fixture.runtime.ingest(root,{maxFiles:10,maxFileBytes:100000});expect(ingested.failed).toBe(0);
  const context={schema:"scce.workspace.program-context.v1",workspaceId:ingested.workspace.id,expectedWorkspaceUpdatedAt:ingested.workspace.updatedAt};
  const owned=await readWorkspaceOwnedProgramContracts({storage:fixture.storage,context,informationAccess:{tenantId:"workspace-contract-test",principalId:"owner",compartments:[],maximumExportClass:"restricted"}});expect(owned.status,JSON.stringify({receipt:ingested.sourceContracts,owned})).toBe("available");
  const result=await fixture.kernel.turn({text:`javascript fresh-cargo.cjs\n${spec}`,requestedAuthority:"program",metadata:{workspaceProgramContext:context}});
  expect(result.constructGraph.program,JSON.stringify(result.constructGraph.nodes.filter(node=>node.kind==="program_emission_unavailable"))).toBeDefined();
  expect(result.constructGraph.program!.files.some(file=>file.path==="fresh-cargo.cjs")).toBe(true);
 }finally{await rm(base,{recursive:true,force:true});}
});

// The evidence reader returns cold database-shaped rows: URI representation
// must not change ownership, and identical bytes cannot substitute a path.
it.each(["file-url","absolute","foreign-same-basename","non-file-url","invalid-file-url","wrong-version"] as const)("checks exact cold source ownership: %s",async(mode)=>{
 const base=await mkdtemp(path.join(tmpdir(),"scce-source-uri-"));
 const root=path.join(base,"owned \u0394 space"),other=path.join(base,"other \u0394 space");
 try{
  await mkdir(root,{recursive:true});await mkdir(other,{recursive:true});
  const spec="freshTripleDot(left,middle,right)\nfreshTripleDot(2,3,4) => 14\nfreshTripleDot(-1,5,2) => 9\nfreshTripleDot(4,-2,3) => -2";
  for(const directory of [root,other])await writeFile(path.join(directory,"specification.txt"),spec);
  const fixture=ordinaryWorkspaceProgramFixture(root,{runtimeWorkspaceRoot:base});
  const original=fixture.storage.evidence.sourceVersionsForEvidence!;
  fixture.storage.evidence.sourceVersionsForEvidence=async ids=>(await original(ids)).map(row=>{
   const cold=JSON.parse(JSON.stringify(row)) as typeof row;
   const absolute=path.resolve(base,cold.canonicalUri);
   cold.canonicalUri=mode==="file-url"?pathToFileURL(absolute).href:mode==="absolute"?absolute:mode==="foreign-same-basename"?path.relative(base,path.join(other,path.basename(absolute))):mode==="non-file-url"?"https://example.invalid/specification.txt":mode==="invalid-file-url"?"file:///bad%ZZ":cold.canonicalUri;
   if(mode==="wrong-version")cold.sourceVersionId=`${cold.sourceVersionId}-different-version` as typeof cold.sourceVersionId;
   return cold;
  });
  const ingested=await fixture.runtime.ingest(root,{maxFiles:10,maxFileBytes:100000});expect(ingested.failed).toBe(0);
  expect(ingested.sourceContracts?.status).toBe(mode==="file-url"||mode==="absolute"?"compiled":"unavailable");
 }finally{await rm(base,{recursive:true,force:true});}
});

it("retains ambiguity refusal for two evidence-owned versions at the same exact path",async()=>{
 const base=await mkdtemp(path.join(tmpdir(),"scce-source-ambiguity-")),root=path.join(base,"nested \u0394 space");
 try{
  await mkdir(root,{recursive:true});await writeFile(path.join(root,"specification.txt"),"freshOpaquePair(a,b)\nfreshOpaquePair(2,3) => 5\nfreshOpaquePair(-1,5) => 4\nfreshOpaquePair(4,-2) => 2");
  const fixture=ordinaryWorkspaceProgramFixture(root,{runtimeWorkspaceRoot:base});await fixture.runtime.ingest(root,{maxFiles:10,maxFileBytes:100000});
  const before=await fixture.runtime.project(root);expect(before.sources.find(row=>row.path==="specification.txt")?.sourceVersionId).toBeDefined();
  const version=fixture.versions.find(row=>row.canonicalUri.endsWith("specification.txt"))!;
  const span=fixture.spans.find(row=>row.sourceVersionId===version.sourceVersionId)!;
  const duplicateVersion={...version,sourceVersionId:`${version.sourceVersionId}-competing` as typeof version.sourceVersionId};
  const duplicateSpan={...span,id:`${span.id}-competing` as typeof span.id,sourceVersionId:duplicateVersion.sourceVersionId};
  fixture.versions.push(duplicateVersion);fixture.spans.push(duplicateSpan);
  const list=fixture.storage.workspace.listSourceFiles!;
  fixture.storage.workspace.listSourceFiles=async query=>(await list(query)).map(row=>({...row,sourceVersionId:undefined,evidenceIds:[...row.evidenceIds,duplicateSpan.id]}));
  const project=await fixture.runtime.project(root);
  expect(project.sources.find(row=>row.path==="specification.txt")?.sourceVersionId).toBeUndefined();
 }finally{await rm(base,{recursive:true,force:true});}
});
