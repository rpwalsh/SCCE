// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, joinInformationLabels, normalizeInformationLabel, LANGUAGE_IDENTITY_SCHEMA,
  type InformationLabel, type LanguageIdentityRecord } from "@scce/kernel";

/** The measured catalogue is an input: using it must not widen the construction's information boundary. */
export function dialogueIdentityAllowsInformationFlow(identity: LanguageIdentityRecord | undefined, outputLabel: InformationLabel): boolean {
  if (!identity || identity.schema !== LANGUAGE_IDENTITY_SCHEMA || !identity.evidence
    || identity.evidence.status === "source_observed" || !identity.informationLabel) return false;
  try {
    return canonicalStringify(joinInformationLabels([identity.informationLabel, outputLabel], { explicitMergeAuthority: false }))
      === canonicalStringify(normalizeInformationLabel(outputLabel));
  } catch { return false; }
}
