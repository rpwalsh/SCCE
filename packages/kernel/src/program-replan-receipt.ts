// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {canonicalStringify,toJsonValue} from "./primitives.js";
import type {EpisodeId,JsonValue,ProgramConstructIntent,ProgramGraph} from "./types.js";
/** Execution telemetry joins the real repair observation; it never participates in artifact construction. */
export function programReplanExecutionReceipt(input:{intent?:ProgramConstructIntent;episodeId:EpisodeId;programId:string;ownerRequirementIds:readonly string[];selectedTransformationIds:readonly string[]}):ProgramGraph["nodes"][number]|undefined {
 if(input.intent?.behaviorImplementationPhase!=="selected")return undefined;
 const record=object(object(input.intent.metadata).replan);
 if(typeof record.selectionId!=="string"||!record.selectionId||typeof record.failureObservationId!=="string"||!record.failureObservationId
  ||typeof record.failedPlanHash!=="string"||!record.failedPlanHash||typeof record.validatorId!=="string"||!record.validatorId
  ||record.transformationId!=="program.transformation.expression_search.v1"&&record.transformationId!=="program.transformation.state_transition_search.v1")return undefined;
 const owners=[...input.ownerRequirementIds].sort(),selected=[...input.selectedTransformationIds].sort();
 if(!owners.length||!selected.length||!Array.isArray(record.ownerRequirementIds)||!Array.isArray(record.selectedTransformationIds)
  ||canonicalStringify([...record.ownerRequirementIds].sort())!==canonicalStringify(owners)||canonicalStringify([...record.selectedTransformationIds].sort())!==canonicalStringify(selected))return undefined;
 return {id:record.selectionId,kind:"program_execution_replan_receipt",label:"program.execution.replan_receipt",metadata:toJsonValue({schema:"scce.program.execution_replan_receipt.v1",
  episodeId:input.episodeId,programId:input.programId,selectionId:record.selectionId,failureObservationId:record.failureObservationId,
  failedPlanHash:record.failedPlanHash,validatorId:record.validatorId,transformationId:record.transformationId,ownerRequirementIds:owners,selectedTransformationIds:selected})};
}
function object(value:JsonValue|undefined):Record<string,JsonValue>{return value&&typeof value==="object"&&!Array.isArray(value)?value:{};}
