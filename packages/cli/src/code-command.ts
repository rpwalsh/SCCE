// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { runWorkspaceCodeCommand, type StructuredPatchValidationPolicy } from "@scce/adapters-node";
import { type InformationAccessContext, type ScceStorage } from "@scce/kernel";
import { codeCommandReport } from "./code-command-report.js";

/** CLI parsing delegates to the existing shared proposal and validation path. */
export async function runCodeCommand(input: {
  storage: ScceStorage; workspaceRoot: string; targetPath?: string; request: string; maxAttempts: number;
  informationAccess?: InformationAccessContext;
  projectValidation?: { policy: StructuredPatchValidationPolicy }; log?: (message: string) => void;
}) {
  const execution = await runWorkspaceCodeCommand(input);
  return { ...codeCommandReport({ result: execution.result, projectVerification: execution.projectVerification,
    language: execution.language, corpusAvailability: execution.corpusAvailability, composed: execution.composed }),
    localization: execution.localization, initialVerification: execution.initialVerification, targetPath: execution.targetPath };
}
