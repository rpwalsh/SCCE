// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {emittedProgramRuntimeForLanguage} from "./code-learning.js";
import {toJsonValue} from "./primitives.js";
import type {JsonValue,ProgramGraph} from "./types.js";
/** The exact generated workspace and native commands reviewed by a process.build_test approval. */
export function programValidationApprovalInput(program:ProgramGraph):JsonValue {
 const provider=emittedProgramRuntimeForLanguage(program.language,{requireNativeBackend:true});
 return toJsonValue({schema:"scce.program.native_validation_approval.v1",program:program.id,
  provider:{id:provider.id,languageId:provider.languageId,commandName:provider.commandName},
  workingDirectory:"ephemeral_program_workspace",build:program.build,test:program.test,
  ownerRequirementIds:[...program.hydration?.ownerRequirementIds??[]].sort(),
  files:program.files.map(file=>({path:file.path,hash:file.contentHash,byteLength:new TextEncoder().encode(file.content).byteLength})).sort((a,b)=>a.path.localeCompare(b.path))});
}
