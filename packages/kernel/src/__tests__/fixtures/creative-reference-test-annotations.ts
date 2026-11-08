// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { Hasher } from "../../types.js";
import type { SourceReferenceBindingDeclaration } from "../../source-reference-bindings.js";

/** Explicit review annotations for these tests; the original human datasets do not provide these labels. */
export function creativeReferenceTestAnnotation(fixtureName: string, text: string, hasher: Hasher): SourceReferenceBindingDeclaration {
  const russian = fixtureName === "oasst-human-russian-creative-pair.json";
  const ranges = russian ? [
    [57, 67, 57, 62], [123, 133, 123, 128], [149, 158, 149, 154], [390, 399, 390, 395],
    [579, 588, 579, 584], [754, 763, 754, 759], [914, 924, 914, 919]
  ] : [[58, 62, 58, 62], [1826, 1830, 1826, 1830], [1942, 1946, 1942, 1946]];
  const points = [...text], expected = russian ? "Спанч" : "room";
  if (ranges.some(([, , start, end]) => points.slice(start, end).join("") !== expected)) throw new Error("test reference annotation source changed");
  return { schema: "scce.source_reference_bindings.v1", coordinateSpace: "unicode_code_point", sourceTextHash: hasher.digestHex(text),
    basis: { kind: "source_annotated", annotationSchema: "test.explicit_review.references.v1", annotationId: `test.review.${fixtureName}` },
    completeReferentIds: ["referent.participant", ...(!russian ? ["referent.other.room"] : [])],
    completeProperties: [{ referentId: "referent.participant", propertyId: "property.surface" }],
    occurrences: [...ranges.map(([start, end, propertyStart, propertyEnd], index) => ({ id: `occurrence.participant.${index}`,
      referentId: "referent.participant", propertyId: "property.surface", startCodePoint: start!, endCodePoint: end!,
      propertyStartCodePoint: propertyStart!, propertyEndCodePoint: propertyEnd! })),
      ...(!russian ? [{ id: "occurrence.other.room", referentId: "referent.other.room", propertyId: "property.surface", startCodePoint: 1405, endCodePoint: 1409 }] : [])] };
}

export function replyWithReviewedProperty(input: { declaration: SourceReferenceBindingDeclaration; reply: string; replyStart: number; value: string }): string {
  const points = [...input.reply];
  for (const occurrence of input.declaration.occurrences.filter(row => row.referentId === "referent.participant" && row.startCodePoint >= input.replyStart)
    .sort((a, b) => b.startCodePoint - a.startCodePoint)) {
    const start = (occurrence.propertyStartCodePoint ?? occurrence.startCodePoint) - input.replyStart;
    const end = (occurrence.propertyEndCodePoint ?? occurrence.endCodePoint) - input.replyStart;
    points.splice(start, end - start, input.value);
  }
  return points.join("");
}
