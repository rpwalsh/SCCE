// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {createHash} from "node:crypto";
import {canonicalStringify,type JsonValue,type ScceEvent} from "@scce/kernel";
/** Surface only this turn's exact pending plan, already owned by the current session. */
export function pendingProgramValidationApproval(input:{events:readonly ScceEvent[];pending:readonly unknown[]}):Record<string,JsonValue>|undefined {
 for(const event of [...input.events].reverse()) {
  if(event.typeId!=="CapabilityPlanned")continue;
  const plan=object(event.payload),payload=object(plan.input),permission=object(plan.permission);
  if(plan.capabilityId!=="process.build_test"||typeof plan.id!=="string"||payload.schema!=="scce.program.native_validation_approval.v1"
   ||permission.allowed===true&&permission.dryRun!==true)continue;
  const fingerprint=createHash("sha256").update(`process.build_test\u001f${canonicalStringify(plan.input)}`).digest("hex");
  const pending=input.pending.map(object).find(record=>record.planId===plan.id&&record.capabilityId===plan.capabilityId&&record.fingerprint===fingerprint
   &&canonicalStringify(record.input)===canonicalStringify(plan.input));
  if(pending)return pending;
 }
 return undefined;
}
function object(value:unknown):Record<string,JsonValue>{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,JsonValue>:{};}
