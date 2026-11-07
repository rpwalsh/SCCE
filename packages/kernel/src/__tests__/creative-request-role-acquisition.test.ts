// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { compileCreativeEventCompatibilityCorpus, compileCreativeRequestFrameFromCompatibilityModels,
  creativeEventCompatibilityModelsFromPatterns, parseCreativeEventCompatibilityCorpus,
  type CreativeEventCompatibilityCorpusExample } from "../creative-event-compatibility.js";
import { canonicalStringify, createHasher } from "../primitives.js";
import type { EvidenceId } from "../types.js";

const hasher = createHasher();
const owner = "evidence.request.role.source" as EvidenceId;

function learned(prefix: string, middle: string, suffix: string) {
  const examples: CreativeEventCompatibilityCorpusExample[] = [["mira", "astronomer"], ["vela", "navigator"], ["sora", "gardener"]].map(([left, right], index) => {
    const requestText = `${prefix}${left}${middle}${right}${suffix}`;
    const leftStart = [...prefix].length;
    const rightStart = [...`${prefix}${left}${middle}`].length;
    return { requestText, requestFrameId: "frame.source", requestCompilerId: "compiler.source.request", eventCompilerId: "compiler.source.event",
      eventRelationId: "relation.source.event", partition: index === 0 ? "train" : "calibration", accepted: true,
      roleBindings: [
        { requestRoleId: "role.a", eventRoleId: "scce.role.patient", accepted: true, requestSpan: { charStart: leftStart, charEnd: leftStart + [...left!].length } },
        { requestRoleId: "role.b", eventRoleId: "scce.role.complement", accepted: true, requestSpan: { charStart: rightStart, charEnd: rightStart + [...right!].length } }
      ] };
  });
  const corpus = parseCreativeEventCompatibilityCorpus(JSON.stringify({ schema: "scce.creative_event_compatibility_corpus.v1",
    calibrationId: "calibration.source", minimumAdmissiblePosterior: 0.5, minimumRolePosterior: 0.5,
    minimumTrainingSupport: 1, minimumCalibrationSupport: 1, examples }))!;
  const compile = () => compileCreativeEventCompatibilityCorpus({ corpus, profileId: "profile.source", evidenceIds: [owner], updatedAt: 1,
    makeId: value => hasher.digestHex(canonicalStringify(value)) });
  const compiled = compile();
  const models = creativeEventCompatibilityModelsFromPatterns(JSON.parse(JSON.stringify(compiled.patterns)));
  return { examples: corpus.examples, compiled, compile, models,
    parse: (requestText: string) => compileCreativeRequestFrameFromCompatibilityModels({ requestText, models, hasher }) };
}

describe("source-acquired creative request roles", () => {
  it.each(["portray", "PORTRAY", "PoRtRaY"])("binds short and multiword values from observed role spans: %s", command => {
    const fixture = learned("PORTRAY ", " beside ", ".");
    const text = `${command} li beside an extraordinarily verbose antagonist.`;
    const frame = fixture.parse(text)!;
    expect(frame).toBeDefined();
    expect(frame.arguments.map(role => [role.roleId, role.span.text])).toEqual([
      ["role.a", "li"], ["role.b", "an extraordinarily verbose antagonist"]
    ]);
    for (const { span } of frame.arguments) {
      expect([...text].slice(span.charStart, span.charEnd).join("")).toBe(span.text);
      expect(new TextDecoder().decode(new TextEncoder().encode(text).slice(span.byteStart, span.byteEnd))).toBe(span.text);
    }
    expect(fixture.compile().patterns).toEqual(fixture.compiled.patterns);
    expect(frame.sourceActivationIds).toContain("frame.source");
  });

  it("uses the same learned program for uncased scripts and grapheme-safe exact role spans", () => {
    const fixture = learned("演じて：", "と", "。");
    const text = "演じて：👩🏽‍💻と月。";
    const frame = fixture.parse(text)!;
    expect(frame.arguments.map(role => role.span.text)).toEqual(["👩🏽‍💻", "月"]);
    for (const role of frame.arguments) expect([...text].slice(role.span.charStart, role.span.charEnd).join("")).toBe(role.span.text);
  });

  it("rejects unseen or reordered instruction forms instead of guessing roles from overlapping words", () => {
    const fixture = learned("portray ", " beside ", ".");
    expect(fixture.parse("unseen li beside an antagonist.")).toBeUndefined();
    expect(fixture.parse("beside an antagonist portray li.")).toBeUndefined();
  });

  it("does not assign roles without annotated source spans or from foreign-owned examples", () => {
    const fixture = learned("portray ", " beside ", ".");
    for (const example of fixture.examples) for (const role of example.roleBindings!) delete role.requestSpan;
    const withoutSpans = creativeEventCompatibilityModelsFromPatterns(fixture.compile().patterns);
    expect(compileCreativeRequestFrameFromCompatibilityModels({ requestText: "portray li beside antagonist.", models: withoutSpans, hasher })).toBeUndefined();
    const foreign = creativeEventCompatibilityModelsFromPatterns(fixture.compiled.patterns.map(pattern => ({ ...pattern, evidenceIds: ["evidence.foreign" as EvidenceId] })));
    expect(compileCreativeRequestFrameFromCompatibilityModels({ requestText: "portray li beside antagonist.", models: foreign, hasher })).toBeUndefined();
  });

  it("leaves genuinely ambiguous adjacent values unresolved", () => {
    const fixture = learned("", " ", "");
    expect(fixture.parse("li big wolf")).toBeUndefined();
  });
});
