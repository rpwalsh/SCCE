// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {it,expect} from "vitest";
import {createHash} from "node:crypto";
import {canonicalStringify,programValidationApprovalInput,type CapabilityPlan,type ProgramGraph,type ScceEvent,type JsonValue} from "@scce/kernel";
import {createApprovalSession} from "../../../adapters-node/src/approval-session.js";
import {pendingProgramValidationApproval} from "../program-validation-approval.js";
it("surfaces only the current session exact command and artifact-bound native plan",()=>{
 const program={id:"program.owned",language:"python",build:{command:"python",args:["-m","py_compile","module.py"],cwd:"."},test:{command:"python",args:["test/program_test.py"],cwd:"."},
  hydration:{ownerRequirementIds:["source_assertion.1"]},files:[{path:"module.py",content:"pass",contentHash:`sha256_${"a".repeat(64)}`},{path:"test/program_test.py",content:"pass",contentHash:`sha256_${"b".repeat(64)}`}]} as unknown as ProgramGraph;
 const payload=programValidationApprovalInput(program),approvals=createApprovalSession();
 const plan={id:"capability.exact",capabilityId:"process.build_test",input:payload,permission:{allowed:false,dryRun:true},createdAt:1} as unknown as CapabilityPlan;
 approvals.observePending(plan);
 const event={typeId:"CapabilityPlanned",payload:plan} as unknown as ScceEvent;
 const read=(events:ScceEvent[]=[event])=>pendingProgramValidationApproval({events,pending:approvals.snapshot().pending});
 expect(read()).toMatchObject({planId:"capability.exact",input:{build:program.build,test:program.test,provider:{id:"program.runtime.python-stdlib.v1"},files:[{path:"module.py"},{path:"test/program_test.py"}]}});
 expect(pendingProgramValidationApproval({events:[event],pending:createApprovalSession().snapshot().pending})).toBeUndefined();
 expect(read([{...event,payload:{...plan,id:"capability.other"} as unknown as JsonValue}])).toBeUndefined();
 approvals.approve("capability.exact");
 expect(approvals.isApproved({capabilityId:"process.build_test",input:payload})).toBe(true);
 for(const changed of [{...program,build:{...program.build,args:["-c","unsafe()"]}},{...program,files:program.files.map((file,index)=>index===0?{...file,contentHash:`sha256_${"c".repeat(64)}`}:file)}]) {
  const next=programValidationApprovalInput(changed);
  expect(approvals.isApproved({capabilityId:"process.build_test",input:next})).toBe(false);
  expect(createHash("sha256").update(canonicalStringify(next)).digest("hex")).not.toBe(createHash("sha256").update(canonicalStringify(payload)).digest("hex"));
 }
 expect(read()).toBeUndefined();
});
