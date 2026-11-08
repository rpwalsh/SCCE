// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {it,expect} from "vitest";
import {createClock,createHasher,createIdFactory,createAlphaFieldEngine,createSemanticEntailmentEngine,createProgramPlanner,programIntentForTurn,codeRequestSignal,COGNITIVE_OPERATOR_IDS,replanOwnerBehaviorProgramIntent,programValidationApprovalInput,validateProgramGraphHydration,canonicalStringify} from "../index.js";
import type {JsonValue} from "../types.js";
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

it("retains actual replan receipt references without changing semantic program identity, artifacts or approval",()=>{
 const clock=createClock({fixedTime:1,stepMs:1}),hasher=createHasher(),ids=createIdFactory({clock,hasher,deterministicReplay:true});
 const text="JavaScript q(1)=2; q(2)=4; q(3)=6",field=createAlphaFieldEngine().activate({text,nodes:[],edges:[]});
 const entailment=createSemanticEntailmentEngine({idFactory:ids,hasher}).check({text,evidence:[],nodes:[],field,createdAt:1});
 const intent=programIntentForTurn({requestedAuthority:"program",activeOperatorIds:[COGNITIVE_OPERATOR_IDS.programPlanning],codeSignal:codeRequestSignal(text),evidence:[]})!;
 const planner=createProgramPlanner({idFactory:ids,hasher}),base={episodeId:ids.episodeId(),requestText:text,entailment,evidence:[],programIntent:intent},probe=planner.emit(base);
 const replan=(observationId:string)=>replanOwnerBehaviorProgramIntent({intent,program:probe,hasher,failure:{observationId,programId:probe.id,planHash:hasher.digestHex(canonicalStringify(probe.hydration)),validatorId:"test.actual-native-contract",checkId:"tests",status:"failed",ownerRequirementIds:intent.behaviorRequirements!.map(row=>row.id),command:probe.test}});
 const a=replan("observation.execution.a"),b=replan("observation.execution.b");
 const first=planner.emit({...base,episodeId:ids.episodeId(),programIntent:a.intent}),second=planner.emit({...base,episodeId:ids.episodeId(),programIntent:b.intent});
 expect(first.id).toBe(second.id);expect(first.files).toEqual(second.files);expect(programValidationApprovalInput(first)).toEqual(programValidationApprovalInput(second));
 expect(validateProgramGraphHydration(first).valid).toBe(true);expect(validateProgramGraphHydration(second).valid).toBe(true);
 expect(first.hydration!.program.nodeCount).toBe(first.nodes.filter(row=>row.kind!=="program_hydration_contract").length);
 expect(first.nodes.find(row=>row.kind==="program_execution_replan_receipt")?.metadata).toMatchObject({selectionId:a.selection.id,failureObservationId:"observation.execution.a",programId:first.id});
 expect(second.nodes.find(row=>row.kind==="program_execution_replan_receipt")?.metadata).toMatchObject({selectionId:b.selection.id,failureObservationId:"observation.execution.b",programId:second.id});
 for(const artifact of first.files){expect(artifact.content).not.toContain(a.selection.id);expect(artifact.content).not.toContain("observation.execution.a");}
 const metadata=a.intent.metadata as Record<string,JsonValue>;
 const receiptMetadata=metadata.replan as Record<string,JsonValue>;
 const foreign=planner.emit({...base,programIntent:{...a.intent,metadata:{...metadata,replan:{...receiptMetadata,ownerRequirementIds:["foreign.owner"]}}}});
 expect(foreign.nodes.some(row=>row.kind==="program_execution_replan_receipt")).toBe(false);
});

it("keeps elapsed causal diagnostics in the execution receipt rather than changing an owned program approval",()=>{
 const clock=createClock({fixedTime:1,stepMs:1}),hasher=createHasher(),ids=createIdFactory({clock,hasher,deterministicReplay:true});
 const text="JavaScript q(1)=2; q(2)=4; q(3)=6",field=createAlphaFieldEngine().activate({text,nodes:[],edges:[]});
 const entailment=createSemanticEntailmentEngine({idFactory:ids,hasher}).check({text,evidence:[],nodes:[],field,createdAt:1});
 const intent=programIntentForTurn({requestedAuthority:"program",activeOperatorIds:[COGNITIVE_OPERATOR_IDS.programPlanning],codeSignal:codeRequestSignal(text),evidence:[]})!;
 const planner=createProgramPlanner({idFactory:ids,hasher}),base={episodeId:ids.episodeId(),requestText:text,entailment,evidence:[],programIntent:intent};
 const later={...entailment,confidence:{...entailment.confidence,causalMass:entailment.confidence.causalMass+Number.EPSILON}};
 expect(programArtifactProofBinding({requestText:text,entailment,evidence:[],requirements:[],ownerScope:{}})).toEqual(programArtifactProofBinding({requestText:text,entailment:later,evidence:[],requirements:[],ownerScope:{}}));
 const first=planner.emit(base),second=planner.emit({...base,episodeId:ids.episodeId(),entailment:later});
 expect(second.files).toEqual(first.files);expect(programValidationApprovalInput(second)).toEqual(programValidationApprovalInput(first));
 expect(later.confidence.causalMass).not.toBe(entailment.confidence.causalMass);
});
