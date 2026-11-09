// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { BuildTestResult, ConstructGraph, ProgramGraph } from "@scce/kernel";

export type ProgramResponseReadiness =
  | { schema: "scce.program.response_readiness.v1"; status: "not_ready"; reasonId: string }
  | { schema: "scce.program.response_readiness.v1"; status: "ready"; reasonId: "program.readiness.verified"; artifactIds: string[]; artifactCount: number };

export function unsupportedProgramResponseReadiness(error: unknown): (ProgramResponseReadiness & { status: "not_ready"; languageId: string }) | undefined {
  if (!error || typeof error !== "object") return undefined;
  const failure = error as { code?: unknown; languageId?: unknown };
  if (failure.code !== "SCCE_PROGRAM_LANGUAGE_UNSUPPORTED" || typeof failure.languageId !== "string" || !failure.languageId) return undefined;
  return { schema: "scce.program.response_readiness.v1", status: "not_ready",
    reasonId: "program.readiness.unsupported_language", languageId: failure.languageId };
}

/** Code output is ready only when an owner-bound behavior contract was actually built and tested. */
export function programResponseReadiness(input: { program?: ProgramGraph; buildTest?: BuildTestResult;construct?:Pick<ConstructGraph,"nodes"> }): ProgramResponseReadiness {
  const program = input.program;
  if (!program) {
    const missingContract=input.construct?.nodes.some(node=>{
      if(node.kind!=="program_emission_unavailable")return false;
      const row=record(node.metadata),intent=record(row.programIntent);
      return Array.isArray(row.reasonIds)&&row.reasonIds.includes("program.emission.declared_callable_unresolved")
        &&Array.isArray(intent.declaredCallableIds)&&intent.declaredCallableIds.length>0
        &&(intent.behaviorRequirements===undefined||Array.isArray(intent.behaviorRequirements)&&intent.behaviorRequirements.length===0)
        &&(intent.statefulBehaviorRequirements===undefined||Array.isArray(intent.statefulBehaviorRequirements)&&intent.statefulBehaviorRequirements.length===0);
    });
    return { schema: "scce.program.response_readiness.v1", status: "not_ready", reasonId: missingContract?"program.readiness.behavior_contract_missing":"program.readiness.no_program" };
  }
  const ownerRequirementIds = program.hydration?.ownerRequirementIds ?? [];
  if (program.hydration?.valid !== true || !ownerRequirementIds.length) {
    return { schema: "scce.program.response_readiness.v1", status: "not_ready", reasonId: "program.readiness.behavior_contract_missing" };
  }
  const testContents = program.files.filter(file => file.role === "test").map(file => file.content);
  if (!testContents.length || !ownerRequirementIds.every(id => testContents.some(content => content.includes(id)))) {
    return { schema: "scce.program.response_readiness.v1", status: "not_ready", reasonId: "program.readiness.behavior_contract_not_bound_to_test" };
  }
  const result = input.buildTest;
  if (!result) return { schema: "scce.program.response_readiness.v1", status: "not_ready", reasonId: "program.readiness.build_test_not_run" };
  const receipt = result.testExecutionReceipt;
  const commandMatches = Boolean(receipt
    && receipt.command === program.test.command
    && receipt.cwd === program.test.cwd
    && receipt.args.length === program.test.args.length
    && receipt.args.every((arg, index) => arg === program.test.args[index]));
  if (!result.passed || result.build.code !== 0 || result.test.code !== 0 || receipt?.status !== "executed" || !commandMatches) {
    return { schema: "scce.program.response_readiness.v1", status: "not_ready", reasonId: "program.readiness.build_test_not_passed" };
  }
  const builtByPath = new Map(result.artifacts.map(artifact => [artifact.path, artifact]));
  const uniquePaths = new Set(result.artifacts.map(artifact => artifact.path));
  const allProgramFilesVerified = program.files.length > 0
    && result.artifacts.length === program.files.length
    && uniquePaths.size === result.artifacts.length
    && program.files.every(file => {
      const built = builtByPath.get(file.path);
      return built?.artifactId === file.artifactId && built.contentHash === file.contentHash;
    });
  if (!allProgramFilesVerified) {
    return { schema: "scce.program.response_readiness.v1", status: "not_ready", reasonId: "program.readiness.artifact_set_mismatch" };
  }
  return {
    schema: "scce.program.response_readiness.v1",
    status: "ready",
    reasonId: "program.readiness.verified",
    artifactIds: result.artifacts.map(artifact => String(artifact.artifactId)),
    artifactCount: result.artifacts.length
  };
}

function record(value:unknown):Record<string,unknown>{return value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};}
