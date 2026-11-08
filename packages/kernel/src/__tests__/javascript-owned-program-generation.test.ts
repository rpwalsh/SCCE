// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {it,expect} from "vitest";
import {createClock,createHasher,createIdFactory,createScceKernel,createInMemoryDialogueMemoryStore} from "../index.js";
import {storageFixtureForEvaluation} from "./evidence-promotion-evaluation-fixture.js";
it("builds a native CommonJS artifact from ordinary fresh owner examples",async()=>{
 const clock=createClock({fixedTime:1,stepMs:1}),hasher=createHasher(),fixture=storageFixtureForEvaluation({evidence:[],clockNow:()=>clock.now()});
 fixture.storage.userModelClaims={putClaim:async()=>undefined,listClaims:async()=>[]};fixture.storage.taskResumption={putSnapshot:async()=>undefined,getLatestSnapshot:async()=>null};fixture.storage.documentGeneration={putSession:async()=>undefined,getSession:async()=>null,compareAndPutSession:async()=>({stored:true,currentUpdatedAt:null})};fixture.storage.dialogueMemory=createInMemoryDialogueMemoryStore();
 const runtime=createScceKernel({storage:fixture.storage,clock,idFactory:createIdFactory({clock,hasher,deterministicReplay:true}),deterministicReplay:true,files:{streamPath:async function*(){}},buildTest:{executeProgram:async()=>{throw Error("No owner process approval supplied");}}});
 const request="javascript fresh-composition.cjs\nfreshOpaquePulse(6,4) => 10\nfreshOpaquePulse(-9,2) => -7\nfreshOpaquePulse(11,-8) => 3";
 const result=await runtime.turn({text:request,requestedAuthority:"program"});
 expect(result.constructGraph.program,JSON.stringify(result.constructGraph.nodes.filter(node=>node.kind==="program_emission_unavailable"))).toBeDefined();
 expect(result.constructGraph.program!.files.some(file=>file.path==="fresh-composition.cjs")).toBe(true);
});
