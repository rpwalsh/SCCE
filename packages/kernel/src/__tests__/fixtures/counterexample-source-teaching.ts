// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { compileLanguageConstructionPattern } from "../../language-construction-memory.js";
import { createLanguageAcquisitionEngine } from "../../language.js";
import { COUNTEREXAMPLE_ROLE_IDS, counterexampleConstructionBindingId } from "../../mouth-counterexample.js";
import { featureSet } from "../../primitives.js";
import type { IdFactory } from "../../ids.js";
import type { EvidenceSpan, Hasher } from "../../types.js";

export function contrastSourceSpan(text: string, ids: IdFactory): EvidenceSpan {
  const bytes = Buffer.from(text, "utf8");
  const sourceVersionId = ids.sourceVersionId(bytes);
  const contentHash = ids.contentHash(bytes);
  return {
    id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: bytes.length, spanHash: contentHash }),
    sourceId: ids.sourceId("fixture", `fixture://contrast/${contentHash}`), sourceVersionId, contentHash,
    chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: bytes.length, chunkHash: contentHash }),
    text, textPreview: text, mediaType: "text/plain", byteStart: 0, byteEnd: bytes.length,
    charStart: 0, charEnd: [...text].length, status: "promoted", alpha: 0.9, observedAt: 1000,
    languageHints: {}, scriptHints: {}, trustVector: { forceClass: "direct_evidence" },
    provenance: { provenanceClass: "direct_evidence", uri: `fixture://contrast/${contentHash}`, sourceVersionId,
      byteRange: [0, bytes.length], charRange: [0, [...text].length] },
    features: featureSet(text, 128)
  };
}

export function counterexampleSourceTeaching(input: {
  ids: IdFactory; hasher: Hasher; render?: (supported: string, denied: string) => string; reversedRoles?: boolean;
}) {
  const values = [["20%", "80%"], ["30%", "90%"]] as const;
  const render = input.render ?? ((supported: string, denied: string) => `The supported reading is ${supported}, rather than ${denied}.`);
  const sentences = values.map(([supported, denied]) => render(supported, denied));
  const evidence = contrastSourceSpan(sentences.join("\n"), input.ids);
  const profile = createLanguageAcquisitionEngine({ idFactory: input.ids }).acquire({
    sourceVersionId: evidence.sourceVersionId, text: evidence.text, createdAt: 1000
  });
  const bindingId = counterexampleConstructionBindingId("quantity");
  const roleIds = [COUNTEREXAMPLE_ROLE_IDS.supported, COUNTEREXAMPLE_ROLE_IDS.denied];
  const compiled = compileLanguageConstructionPattern({ bindingId, profileId: profile.id, evidence: [evidence], hasher: input.hasher,
    updatedAt: 1000, observations: sentences.map((sentence, index) => {
      const surfaceStartCodePoint = [...evidence.text.slice(0, evidence.text.indexOf(sentence))].length;
      return { sourceVersionId: String(evidence.sourceVersionId), evidenceId: String(evidence.id), surfaceStartCodePoint,
        surfaceEndCodePoint: surfaceStartCodePoint + [...sentence].length,
        roles: values[index]!.map((value, slotIndex) => {
          const startCodePoint = [...sentence.slice(0, sentence.indexOf(value))].length;
          return { slotIndex, startCodePoint, endCodePoint: startCodePoint + [...value].length,
            graphBinding: { relationId: bindingId, roleId: roleIds[input.reversedRoles ? 1 - slotIndex : slotIndex]!, valueKind: "quantity" } };
        }) };
    }) });
  if (compiled.status !== "compiled") throw new Error(`Contrast source did not compile: ${JSON.stringify(compiled)}`);
  return { evidence, profile, pattern: compiled.pattern };
}
