// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { EvidenceSpan, ProgramConstructIntent, RequestedAuthority } from "./types.js";
import { codeRequestRecognized, type CodeRequestSignal } from "./code-request.js";
import { hasEngineeringCorpusMetadata } from "./program.js";
import { toJsonValue } from "./primitives.js";

/**
 * The turn's structured program intent, derived once from what the turn already decided: the projected
 * authority, the structural code signal, and the engineering evidence it admitted. The program builder and the
 * planner both read it, so a request projected as `program` yields a ProgramGraph whether or not the request's
 * vocabulary also trips the builder's own activation. Absent, not fabricated, for a turn that is not about code.
 */
export function programIntentForTurn(input: {
  requestedAuthority: RequestedAuthority;
  codeSignal: CodeRequestSignal;
  evidence: readonly EvidenceSpan[];
}): ProgramConstructIntent | undefined {
  const structural = codeRequestRecognized(input.codeSignal);
  if (input.requestedAuthority !== "program" && !structural) return undefined;
  const engineering = input.evidence.filter(span => hasEngineeringCorpusMetadata(span));
  // A request naming paths asks for an edit plan over those files; one naming none asks for a callable artifact.
  const artifactKindIds = input.codeSignal.paths.length ? ["program.artifact.patch_plan"] : ["program.artifact.library"];
  return {
    artifactKindIds,
    capabilityIds: input.codeSignal.paths.length ? ["program.capability.source_edit_plan"] : [],
    ...(input.codeSignal.language ? { languageId: input.codeSignal.language } : {}),
    ...(input.codeSignal.paths.length ? { entrypointPath: input.codeSignal.paths[0] } : {}),
    constraints: engineering.length ? ["program.constraint.source_backed"] : [],
    provenanceEvidenceIds: engineering.map(span => String(span.id)),
    metadata: toJsonValue({
      requestedAuthority: input.requestedAuthority,
      demand: input.codeSignal.demand,
      signals: input.codeSignal.signals,
      paths: input.codeSignal.paths
    })
  };
}
