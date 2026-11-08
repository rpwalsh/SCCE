// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { compileLanguageConstructionPattern } from "../../language-construction-memory.js";
import type { EvidenceSpan, Hasher } from "../../types.js";

export function sourceOwnedSemanticSurfacePatterns(input: {
  evidence: EvidenceSpan; profileId: string; hasher: Hasher;
  facts: readonly { subject: string; predicate: string; object: string; relationId: string; surface: string }[];
}) {
  return input.facts.map(fact => {
    const start = input.evidence.text.indexOf(fact.surface);
    if (start < 0) throw new Error("The teaching surface must belong to its source");
    const compiled = compileLanguageConstructionPattern({
      bindingId: fact.relationId, profileId: input.profileId, hasher: input.hasher,
      evidence: [input.evidence], updatedAt: input.evidence.observedAt,
      observations: [{ sourceVersionId: String(input.evidence.sourceVersionId), evidenceId: String(input.evidence.id),
        surfaceStartCodePoint: [...input.evidence.text.slice(0, start)].length,
        surfaceEndCodePoint: [...input.evidence.text.slice(0, start + fact.surface.length)].length,
        roles: [fact.subject, fact.predicate, fact.object].map((surface, slotIndex) => {
          const at = fact.surface.indexOf(surface);
          if (at < 0) throw new Error("The teaching role must belong to its surface");
          const startCodePoint = [...fact.surface.slice(0, at)].length;
          return { slotIndex, startCodePoint, endCodePoint: startCodePoint + [...surface].length,
            graphBinding: { relationId: fact.relationId, roleId: `source.role.${slotIndex}`, valueKind: "source.lexical" } };
        }) }]
    });
    if (compiled.status !== "compiled") throw new Error(`Source teaching failed: ${JSON.stringify(compiled)}`);
    return compiled.pattern;
  });
}
