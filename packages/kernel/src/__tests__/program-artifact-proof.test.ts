// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {it,expect} from "vitest";
import {createClock,createHasher,createIdFactory,createAlphaFieldEngine,createSemanticEntailmentEngine,createProgramPlanner,programIntentForTurn,codeRequestSignal,COGNITIVE_OPERATOR_IDS} from "../index.js";
import {programArtifactProofBinding} from "../program-artifact-proof.js";
it("binds artifact proof semantics and source obligations independently of execution receipt identities",()=>{
 const clock=createClock({fixedTime:1,stepMs:1}),hasher=createHasher(),ids=createIdFactory({clock,hasher,deterministicReplay:true});
 const text="JavaScript q(1)=2; q(2)=4; q(3)=6",field=createAlphaFieldEngine().activate({text,nodes:[],edges:[]});
 const entailment=createSemanticEntailmentEngine({idFactory:ids,hasher}).check({text,evidence:[],nodes:[],field,createdAt:1});
 const changedReceipt={...entailment,claim:{...entailment.claim,id:ids.claimId("other execution")},proof:{...entailment.proof,id:ids.proofId({claimId:ids.claimId("receipt"),evidenceIds:[],transforms:[],validatorVersion:"receipt"}),createdAt:99}};
 const input={requestText:text,entailment,evidence:[],requirements:[],ownerScope:{tenant:"owner.a"}};
 const binding=programArtifactProofBinding(input);
 expect(programArtifactProofBinding({...input,entailment:changedReceipt})).toEqual(binding);
 expect(programArtifactProofBinding({...input,entailment:{...entailment,claim:{...entailment.claim,text:"q(1)=99"}}})).not.toEqual(binding);
 const obligation={id:"source.obligation",kind:"source_version" as const,status:"satisfied" as const,claimText:text,evidenceIds:[],sourceVersionIds:[ids.sourceVersionId("owned.changed")],support:1,contradiction:0,required:true,reason:"owned",metadata:{}};
 expect(programArtifactProofBinding({...input,entailment:{...entailment,obligations:[...entailment.obligations,obligation]}})).not.toEqual(binding);
 expect(programArtifactProofBinding({...input,ownerScope:{tenant:"owner.b"}})).not.toEqual(binding);
 const intent=programIntentForTurn({requestedAuthority:"program",activeOperatorIds:[COGNITIVE_OPERATOR_IDS.programPlanning],codeSignal:codeRequestSignal(text),evidence:[]})!;
 const planner=createProgramPlanner({idFactory:ids,hasher}),base={episodeId:ids.episodeId(),requestText:text,entailment,evidence:[],programIntent:{...intent,metadata:{sourceOwnerScope:input.ownerScope}}};
 const first=planner.emit(base),second=planner.emit({...base,episodeId:ids.episodeId(),entailment:changedReceipt});
 expect(first.id).toBe(second.id);expect(first.files).toEqual(second.files);
 expect(planner.emit({...base,entailment:{...entailment,obligations:[...entailment.obligations,obligation]}}).files).not.toEqual(first.files);
 expect(planner.emit({...base,programIntent:{...base.programIntent,metadata:{sourceOwnerScope:{tenant:"owner.b"}}}}).id).not.toBe(first.id);
});
