// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { BuildTestResult, ProgramGraph } from "@scce/kernel";

export type ProgramResponseReadiness =
  | { schema: "scce.program.response_readiness.v1"; status: "not_ready"; reasonId: string }
  | { schema: "scce.program.response_readiness.v1"; status: "ready"; reasonId: "program.readiness.verified"; artifactIds: string[]; artifactCount: number };

/** Code output is ready only when an owner-bound behavior contract was actually built and tested. */
export function programResponseReadiness(input: { program?: ProgramGraph; buildTest?: BuildTestResult }): ProgramResponseReadiness {
  const program = input.program;
  if (!program) return { schema: "scce.program.response_readiness.v1", status: "not_ready", reasonId: "program.readiness.no_program" };
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
