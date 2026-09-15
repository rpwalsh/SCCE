// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHasher, clamp01, toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";

/** One source-neutral owner correction shared by dialogue and translation consumers. */
export interface CorrectionObservation {
  schema: "scce.correction.observation.v1";
  target: { kind: "dialogue" | "translation"; id: string };
  prior: { stateId?: string; surfaceId: string };
  corrected: { stateId?: string; surfaceId: string };
  scope: {
    conversationId: string;
    turnId?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    sourceProfileId?: string;
    targetProfileId?: string;
  };
  confidence: number;
  cause: { id: string; kind: string; provenance: JsonValue };
  provenance: { sourceRecordId?: string; sourceTraceId?: string; evidenceIds: string[] };
  affectedModelIds: string[];
}

const hasher = createHasher();

export function correctionSurfaceIdentity(surface: string): string {
  return `surface.${hasher.digestHex(surface).slice(0, 32)}`;
}

export function createCorrectionObservation(input: {
  target: CorrectionObservation["target"];
  prior: { stateId?: string; surface?: string; surfaceId?: string };
  corrected: { stateId?: string; surface?: string; surfaceId?: string };
  scope: CorrectionObservation["scope"];
  confidence: number;
  cause: CorrectionObservation["cause"];
  provenance?: Partial<CorrectionObservation["provenance"]>;
  affectedModelIds?: readonly string[];
}): CorrectionObservation {
  return {
    schema: "scce.correction.observation.v1",
    target: input.target,
    prior: {
      ...(input.prior.stateId ? { stateId: input.prior.stateId } : {}),
      surfaceId: input.prior.surfaceId ?? correctionSurfaceIdentity(input.prior.surface ?? "")
    },
    corrected: {
      ...(input.corrected.stateId ? { stateId: input.corrected.stateId } : {}),
      surfaceId: input.corrected.surfaceId ?? correctionSurfaceIdentity(input.corrected.surface ?? "")
    },
    scope: input.scope,
    confidence: clamp01(input.confidence),
    cause: { id: input.cause.id, kind: input.cause.kind, provenance: toJsonValue(input.cause.provenance) },
    provenance: {
      ...(input.provenance?.sourceRecordId ? { sourceRecordId: input.provenance.sourceRecordId } : {}),
      ...(input.provenance?.sourceTraceId ? { sourceTraceId: input.provenance.sourceTraceId } : {}),
      evidenceIds: [...(input.provenance?.evidenceIds ?? [])]
    },
    affectedModelIds: [...new Set(input.affectedModelIds ?? [])]
  };
}
