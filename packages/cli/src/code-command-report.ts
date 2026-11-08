// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CodeMouthResult, WorkspaceApplicationVerification } from "@scce/adapters-node";
import type { LearnedCodeRepairCandidate } from "@scce/kernel";

export function codeCommandReport(input: {
  result: CodeMouthResult;
  projectVerification?: WorkspaceApplicationVerification;
  language: string | undefined;
  modelsAvailable: number;
  composed: readonly LearnedCodeRepairCandidate[];
}) {
  return {
    ...input.result,
    ...(input.projectVerification ? { projectVerification: input.projectVerification } : {}),
    learned: {
      language: input.language ?? null,
      modelsAvailable: input.modelsAvailable,
      composed: input.composed.map(candidate => ({
        strategy: candidate.strategy,
        line: candidate.startLine,
        content: candidate.content,
        averageLogProbability: candidate.averageLogProbability
      }))
    }
  };
}
