// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {createServer} from "node:http";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {it,expect,vi} from "vitest";
vi.mock("@scce/adapters-node",async original=>({...await original<typeof import("@scce/adapters-node")>(),assertHydratedRuntimeReady:vi.fn(async()=>({activeBrainVersion:"brain.owned-api-test",activeImportRunIds:[]}))}));
import {ordinaryWorkspaceProgramFixture} from "../../../adapters-node/src/__tests__/fixtures/ordinary-workspace-program.js";
import {handleRequest,type ApiContext} from "../routes.js";
import type {TurnResult} from "@scce/kernel";
it("retains exact native approval across cold and warm ordinary API requests with owned sources and dialogue memory",async()=>{
 const base=await mkdtemp(path.join(tmpdir(),"scce-api-program-approval-")),root=path.join(base,"nested \u0394 workspace");
 let server:ReturnType<typeof createServer>|undefined;
 try{
  await mkdir(root,{recursive:true});
  const spec="freshOpaqueDouble(2)=4; freshOpaqueDouble(-1)=-2; freshOpaqueDouble(4)=8";
  await writeFile(path.join(root,"specification.txt"),spec);
  await writeFile(path.join(root,"driver.cjs"),'const m=require("./fresh-cargo.cjs");const p=JSON.parse(process.argv[2]);console.log(m.freshOpaqueDouble(...p));');
  await writeFile(path.join(root,"package.json"),JSON.stringify({private:true,type:"commonjs"}));
  const fixture=ordinaryWorkspaceProgramFixture(root,{runtimeWorkspaceRoot:base,realClock:true});
  const ingested=await fixture.runtime.ingest(root,{maxFiles:10,maxFileBytes:100000});expect(ingested.sourceContracts?.status).toBe("compiled");
  // A nonempty resident graph exercises ordinary time-sensitive causal field
  // diagnostics, which the empty-graph approval fixtures could not observe.
  const graphRead=fixture.storage.graph.getSlice.bind(fixture.storage.graph),temporalRead=fixture.storage.graph.getTemporalSlice.bind(fixture.storage.graph),edgeTime=Date.now()-100000;
  fixture.storage.graph.getSlice=async query=>{const graph=await graphRead(query);if(graph.nodes.length<2)return graph;
   return {...graph,edges:[{id:"edge.owned-workspace-context" as never,source:graph.nodes[0]!.id,target:graph.nodes[1]!.id,relationId:"relation.workspace-context" as never,
    alpha:0.2,weight:0.3,temporalScope:{status:"atemporal"},evidenceIds:fixture.spans.map(span=>span.id),createdAt:edgeTime,updatedAt:edgeTime,metadata:{}}]};};
  fixture.storage.graph.getTemporalSlice=async query=>({...await temporalRead(query),...await fixture.storage.graph.getSlice(query)});
  // Source ownership is read by exact IDs. A code specification is not a
  // documentary world-fact answer to the requested generation task.
  fixture.storage.evidence.searchEvidence=async()=>[];
  const results:TurnResult[]=[],nativeTurn=fixture.kernel.turn.bind(fixture.kernel);
  fixture.kernel.turn=async input=>{const result=await nativeTurn(input);results.push(result);return result;};
  const context={runtime:{kernel:fixture.kernel,storage:fixture.storage,approvals:fixture.approvals},
   config:{server:{url:"http://127.0.0.1"},runtime:{workspaceRoot:base,allowedRoots:[root],tempRoot:root,tools:{}},policy:{allowMutation:false}},
   startupReadiness:{snapshot:()=>({phase:"running",ok:true,complete:true})}} as unknown as ApiContext;
  server=createServer((request,response)=>{void handleRequest(request,response,context);});
  await new Promise<void>(resolve=>server!.listen(0,"127.0.0.1",resolve));
  const address=server.address();if(!address||typeof address==="string")throw Error("no test API address");
  const url=`http://127.0.0.1:${address.port}`;
  const post=(endpoint:string,body:unknown)=>fetch(`${url}${endpoint}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const request={text:`javascript fresh-cargo.cjs\n${spec}`,requestedAuthority:"program",conversationId:"conversation.owned-program-replay",sessionId:"session.owned-program-replay",
   metadata:{workspaceProgramContext:{schema:"scce.workspace.program-context.v1",workspaceId:ingested.workspace.id,expectedWorkspaceUpdatedAt:ingested.workspace.updatedAt}}};
  const cold=await post("/api/turn",request);expect(cold.status,JSON.stringify(await cold.json())).toBe(202);
  const first=fixture.approvals.snapshot().pending.find(row=>row.capabilityId==="process.build_test")!;expect(first).toBeDefined();
  const warm=await post("/api/turn",request);expect(warm.status,JSON.stringify(await warm.json())).toBe(202);
  const repeated=fixture.approvals.snapshot().pending.filter(row=>row.capabilityId==="process.build_test");
  const files=(result:TurnResult)=>result.constructGraph.program!.files.map(row=>({path:row.path,hash:row.contentHash}));
  expect(files(results[1]!)).toEqual(files(results[0]!));
  expect([...new Set(repeated.map(row=>row.fingerprint))]).toEqual([first.fingerprint]);
  expect((await post("/api/session/approve",{planId:first.planId})).status).toBe(200);
  const probe=await post("/api/turn",request);const probeBody=await probe.json();expect(results.at(-1)!.buildTest,JSON.stringify({status:probe.status,body:probeBody,results:results.map(row=>({confidence:row.entailment.confidence,sourceMemory:JSON.parse(row.constructGraph.program!.files.find(file=>file.path==="source.memory.json")!.content).confidence}))})).toBeDefined();
  const selected=fixture.approvals.snapshot().pending.find(row=>row.capabilityId==="process.build_test"&&!fixture.approvals.isApproved(row));
  if(selected){expect(selected.fingerprint).not.toBe(first.fingerprint);expect((await post("/api/session/approve",{planId:selected.planId})).status).toBe(200);
   const completed=await post("/api/turn",request);expect(completed.status,JSON.stringify(await completed.json())).toBe(200);}
  expect(results.at(-1)!.buildTest?.passed).toBe(true);
  expect(fixture.approvals.snapshot().pending.filter(row=>row.capabilityId==="process.build_test"&&!fixture.approvals.isApproved(row))).toHaveLength(0);
  const changed=await post("/api/turn",{...request,text:"javascript fresh-cargo.cjs\nfreshOpaqueDouble(2)=6; freshOpaqueDouble(-1)=-3; freshOpaqueDouble(4)=12"});
  expect(changed.status,JSON.stringify(await changed.json())).toBe(202);
  expect(results.at(-1)!.buildTest).toBeUndefined();
  expect(fixture.approvals.snapshot().pending.some(row=>row.capabilityId==="process.build_test"&&!fixture.approvals.isApproved(row))).toBe(true);
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await rm(base,{recursive:true,force:true});}
},60000);
