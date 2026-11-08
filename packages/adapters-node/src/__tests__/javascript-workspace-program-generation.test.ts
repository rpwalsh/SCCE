// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {it,expect} from "vitest";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {ordinaryWorkspaceProgramFixture} from "./fixtures/ordinary-workspace-program.js";
import {readWorkspaceOwnedProgramContracts} from "@scce/kernel";
it("retains ordinary CommonJS generation with an absent target and a configless ingested native driver",async()=>{
 const root=await mkdtemp(path.join(tmpdir(),"scce-js-generation-route-"));
 try{
  const spec="freshTripleDot(left,middle,right)\nfreshTripleDot(2,3,4) => 14\nfreshTripleDot(-1,5,2) => 9\nfreshTripleDot(4,-2,3) => -2";
  await writeFile(path.join(root,"package.json"),JSON.stringify({private:true,type:"commonjs"}));
  await writeFile(path.join(root,"driver.cjs"),'const m=require("./fresh-cargo.cjs");const p=JSON.parse(process.argv[2]);console.log(m.freshTripleDot(...p));');
  await writeFile(path.join(root,"specification.txt"),spec);
  const fixture=ordinaryWorkspaceProgramFixture(root),ingested=await fixture.runtime.ingest(root,{maxFiles:10,maxFileBytes:100000});expect(ingested.failed).toBe(0);
  const context={schema:"scce.workspace.program-context.v1",workspaceId:ingested.workspace.id,expectedWorkspaceUpdatedAt:ingested.workspace.updatedAt};
  const owned=await readWorkspaceOwnedProgramContracts({storage:fixture.storage,context,informationAccess:{tenantId:"workspace-contract-test",principalId:"owner",compartments:[],maximumExportClass:"restricted"}});expect(owned.status,JSON.stringify({receipt:ingested.sourceContracts,owned})).toBe("available");
  const result=await fixture.kernel.turn({text:`javascript fresh-cargo.cjs\n${spec}`,requestedAuthority:"program",metadata:{workspaceProgramContext:context}});
  expect(result.constructGraph.program,JSON.stringify(result.constructGraph.nodes.filter(node=>node.kind==="program_emission_unavailable"))).toBeDefined();
  expect(result.constructGraph.program!.files.some(file=>file.path==="fresh-cargo.cjs")).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});
