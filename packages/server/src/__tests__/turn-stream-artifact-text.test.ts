// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {createServer} from "node:http";
import {it,expect,vi} from "vitest";
vi.mock("@scce/adapters-node",async original=>({...await original<typeof import("@scce/adapters-node")>(),assertHydratedRuntimeReady:vi.fn(async()=>({activeBrainVersion:"brain.transport-test",activeImportRunIds:[]}))}));
import {createScceKernel,createInMemoryDialogueMemoryStore,createHasher,decodeProgramArtifactWire,type TurnResult,type ScceStorage} from "@scce/kernel";
import {storageFixtureForEvaluation} from "../../../kernel/src/__tests__/evidence-promotion-evaluation-fixture.js";
import {handleRequest,type ApiContext} from "../routes.js";
import {turnTaskRegistryFor} from "../turn-task-registry.js";
it.each([false,true])("preserves artifact NUL bytes over actual HTTP stream and cold reconnect (full=%s)",async full=>{
 const {storage}=storageFixtureForEvaluation({evidence:[],clockNow:()=>Date.now()});storage.dialogueMemory=createInMemoryDialogueMemoryStore();
 storage.userModelClaims={putClaim:async()=>undefined,listClaims:async()=>[]};
 storage.taskResumption={putSnapshot:async()=>undefined,getLatestSnapshot:async()=>null};
 storage.documentGeneration={putSession:async()=>undefined,getSession:async()=>null,compareAndPutSession:async()=>({stored:true,currentUpdatedAt:null})};
 const kernel=createScceKernel({storage,files:{streamPath:async function*(){}},buildTest:{executeProgram:async()=>{throw Error("transport test does not execute programs");}}});
 const template=await kernel.turn({text:"opaque transport fixture",requestedAuthority:"creative"});
 const content="prefix\u0000\ud83e\uddedA\u030a literal\\u0000 suffix",hasher=createHasher();
 const artifact={artifactId:"artifact:exact-nul",path:"fixture.txt",mediaType:"text/plain",role:"doc" as const,content,contentHash:`sha256_${hasher.digestHex(content)}` as const};
 const result={...template,answer:"Transport fixture.",withheld:undefined,epistemicForce:"invented",buildTest:{build:{code:0,stdout:"",stderr:"",durationMs:1},test:{code:0,stdout:"",stderr:"",durationMs:1},passed:true,repairAttempted:false,repairApplied:false,artifacts:[artifact]},events:[]} as unknown as TurnResult;
 const context={runtime:{storage,kernel:{turn:async()=>result}},config:{server:{url:"http://127.0.0.1"}},startupReadiness:{snapshot:()=>({phase:"running",ok:true,complete:true})}} as unknown as ApiContext;
 const server=createServer((request,response)=>{void handleRequest(request,response,context);});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
 const address=server.address();if(!address||typeof address==="string")throw Error("no fixture API address");const base=`http://127.0.0.1:${address.port}`;
 try{
  const request={method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:"transport fixture"})};
  const plain=await fetch(`${base}/api/turn${full?"?full=1":""}`,request);expect(plain.status).toBe(200);
  const ordinary=decodeProgramArtifactWire(await plain.json() as Record<string,unknown>);expect((ordinary.buildTest as {artifacts:Array<{content:string}>}).artifacts[0]!.content).toBe(content);
  const response=await fetch(`${base}/api/turn?stream=1${full?"&full=1":""}`,request);
  const frames=(await response.text()).trim().split("\n").map(line=>JSON.parse(line) as Record<string,unknown>),terminal=frames.find(frame=>frame.type==="result");expect(terminal).toBeDefined();
  const value=terminal!.value as Record<string,unknown>;expect((decodeProgramArtifactWire(value).buildTest as {artifacts:Array<{content:string}>}).artifacts[0]!.content).toBe(content);
  const taskId=String(terminal!.taskId);await turnTaskRegistryFor(storage).drain(taskId);
  // A fresh storage adapter identity forces the public reconnect handler to
  // load the saved events through a cold registry, rather than its live map.
  context.runtime.storage={...storage,events:storage.events} as ScceStorage;
  const replay=await fetch(`${base}/api/turn/task/${encodeURIComponent(taskId)}/stream?after=1`);
  const recovered=(await replay.text()).trim().split("\n").map(line=>JSON.parse(line) as Record<string,unknown>).find(frame=>frame.type==="result");
  expect(recovered?.value).toEqual(value);
  const restored=decodeProgramArtifactWire(recovered!.value as Record<string,unknown>),file=(restored.buildTest as {artifacts:Array<{content:string;contentHash:string}>}).artifacts[0]!;
  expect(file.content).toBe(content);expect(`sha256_${hasher.digestHex(file.content)}`).toBe(file.contentHash);
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
},30000);
