// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { DurableLanguageConstructionBundle } from "./language-construction-memory.js";
import { factualRoundTripGate } from "./semantic-round-trip.js";
import { canonicalStringify, createHasher } from "./primitives.js";

const hasher = createHasher();

/** Hydrated source coordinates bind the fact's roles before its attested surface enters the strict cycle gate. */
export function sourceBoundFactSurfaceWitness(input: {
  text: string;
  fact: { subject: string; predicate: string; object: string; relationId: string; sourceVersionId?: string;
    evidenceIds?: readonly string[]; relationRoleId?: string; requestedSlotId?: string };
  bundles: readonly DurableLanguageConstructionBundle[];
  profileIds: ReadonlySet<string>;
}): { bundleId: string; constructionId: string; sourceExampleId: string; sourceVersionId: string; evidenceId: string } | undefined {
  if (!input.fact.predicate || !input.fact.relationId
    || (input.fact.relationRoleId && input.fact.requestedSlotId && input.fact.relationRoleId !== input.fact.requestedSlotId)) return undefined;
  const values = [input.fact.subject, input.fact.predicate, input.fact.object];
  const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
  for (const bundle of input.bundles) {
    if (!input.profileIds.has(bundle.targetProfileId)) continue;
    for (const example of bundle.sourceExamples) {
      if (example.nullRoles.length || example.roles.length !== values.length
        || !bundle.sourceVersionIds.includes(example.sourceVersionId) || !bundle.evidenceIds.includes(example.evidenceId)
        || (input.fact.sourceVersionId && input.fact.sourceVersionId !== example.sourceVersionId)
        || (input.fact.evidenceIds?.length && !input.fact.evidenceIds.includes(example.evidenceId))) continue;
      const points = [...example.surface];
      if (!values.every((value, slotIndex) => {
        const roles = example.roles.filter(role => role.slotIndex === slotIndex);
        return roles.length === 1 && roles[0]!.graphBinding?.relationId === input.fact.relationId
          && Boolean(roles[0]!.graphBinding?.roleId && roles[0]!.graphBinding?.valueKind)
          && (slotIndex !== 2 || !input.fact.relationRoleId || roles[0]!.graphBinding?.roleId === input.fact.relationRoleId)
          && normalize(roles[0]!.surface) === normalize(value)
          && points.slice(roles[0]!.startCodePoint, roles[0]!.endCodePoint).join("") === roles[0]!.surface;
      })) continue;
      const construction = bundle.constructions.find(row => row.sourceExampleIds.includes(example.id)
        && row.roleOccurrences.length === example.roles.length
        && example.roles.every(role => row.roleOccurrences.some(occurrence => occurrence.roleId === role.roleId
          && occurrence.occurrenceId === role.occurrenceId && occurrence.realization === "spoken")));
      if (!construction || !factualRoundTripGate({ intendedText: example.surface, realizedText: input.text, requireComplete: true }).accepted) continue;
      const { id, contentDigest, qualificationStatus: _qualification, ...content } = bundle;
      if (id !== `surface.construction.bundle.${contentDigest}` || hasher.digestHex(canonicalStringify(content)) !== contentDigest) continue;
      return { bundleId: bundle.id, constructionId: construction.id, sourceExampleId: example.id,
        sourceVersionId: example.sourceVersionId, evidenceId: example.evidenceId };
    }
  }
  return undefined;
}
