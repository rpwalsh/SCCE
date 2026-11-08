// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createLearnedCodeProposer, createWorkspaceCodeMouthPorts, runCodeMouth, type StructuredPatchValidationPolicy } from "@scce/adapters-node";
import { codeLanguageForPath, type ScceStorage } from "@scce/kernel";
import { codeCommandReport } from "./code-command-report.js";

/** CLI parsing delegates to the existing shared proposal and validation path. */
export async function runCodeCommand(input: {
  storage: ScceStorage; workspaceRoot: string; targetPath: string; request: string; maxAttempts: number;
  projectValidation?: { policy: StructuredPatchValidationPolicy }; log?: (message: string) => void;
}) {
  const learnedProposer = createLearnedCodeProposer({ storage: input.storage, workspaceRoot: input.workspaceRoot, log: input.log });
  const language = codeLanguageForPath(input.targetPath);
  const ports = createWorkspaceCodeMouthPorts({ workspaceRoot: input.workspaceRoot, targetPath: input.targetPath, learnedProposer, log: input.log,
    ...(input.projectValidation ? { projectValidation: input.projectValidation } : {}) });
  const result = await runCodeMouth({ request: input.request, targetPath: input.targetPath, maxAttempts: input.maxAttempts, log: input.log, ports });
  return codeCommandReport({ result, projectVerification: ports.projectVerification(), language, corpusAvailability: ports.corpusAvailability(),
    composed: learnedProposer.lastCandidates() });
}
