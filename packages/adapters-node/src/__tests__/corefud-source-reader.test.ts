// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher } from "@scce/kernel";
import { assertCorefUDSourceDisjoint, readCorefUDSource } from "../corefud-source-reader.js";

const row = (id: string, form: string, misc = "_") => [id, form, "_", "_", "_", "_", "_", "_", "_", misc].join("\t");
function fixture(body: string) {
  const text = "# global.Entity = eid-etype-head-other\n" + body;
  return { text, owner: { corpusId: "test-authored-controls", sourceUri: "fixture://test-authored/coreference", artifactSha256: createHasher().digestHex(text),
    declaredLicense: "test-authored", attribution: "test-authored annotation controls", sourceOrigin: "test-authored-fixture" as const } };
}
const points = (text: string, start: number, end: number) => [...text].slice(start, end).join("");

describe("source-annotated CorefUD projection", () => {
  it("links exact declared spans across sentences while keeping document and homonym identities separate", () => {
    const source = fixture("# newdoc id = first\n# sent_id = one\n# text = luma luma\n"
      + row("1", "luma", "Entity=(a-person-1)") + "\n" + row("2", "luma", "Entity=(b-person-1)")
      + "\n\n# sent_id = two\n# text = qzeta\n" + row("1", "qzeta", "Entity=(a-person-1)")
      + "\n\n# newdoc id = second\n# sent_id = three\n# text = luma\n" + row("1", "luma", "Entity=(a-person-1)") + "\n");
    const result = readCorefUDSource(source);
    expect(result).toMatchObject({ inputKind: "source-annotated-only", rawTextInference: "unavailable" });
    const [first, second] = result.documents;
    const [left, right, anaphor] = first!.declaration.occurrences;
    expect(left!.referentId).not.toBe(right!.referentId);
    expect(anaphor!.referentId).toBe(left!.referentId);
    expect(second!.declaration.occurrences[0]!.referentId).not.toBe(left!.referentId);
    expect(first!.declaration.completeReferentIds).toHaveLength(2);
    expect(first!.declaration.occurrences.every(mention => !Object.hasOwn(mention, "propertyId"))).toBe(true);
    expect(points(first!.text, anaphor!.startCodePoint, anaphor!.endCodePoint)).toBe("qzeta");
  });

  it("projects NFC Unicode code-point coordinates without fabricating name properties", () => {
    const result = readCorefUDSource(fixture("# newdoc id = unicode\n# text = 🙂 Mari\u0301a\n" + row("1", "🙂") + "\n" + row("2", "Mari\u0301a", "Entity=(a-person-1)") + "\n"));
    const document = result.documents[0]!;
    expect(document.text).toBe("🙂 María");
    expect(document.declaration.occurrences[0]).toMatchObject({ startCodePoint: 2, endCodePoint: 7 });
    expect(document.declaration.sourceTextHash).toBe(createHasher().digestHex(document.text));
    expect(document.declaration).not.toHaveProperty("completeProperties");
  });

  it("never treats repeated NOCOREF markables as shared identities or negative labels", () => {
    const result = readCorefUDSource(fixture("# newdoc id = unlinked\n# text = x y\n" + row("1", "x", "Entity=(NOCOREF:Spec.person-person-1)") + "\n" + row("2", "y", "Entity=(NOCOREF:Spec.person-person-1)") + "\n"));
    expect(result.documents[0]).toMatchObject({ unlinkedAnnotations: 2, declaration: { occurrences: [], completeReferentIds: [] } });
  });

  it("preserves split antecedent and bridging declarations without fusing their referents", () => {
    const result = readCorefUDSource(fixture("# newdoc id = split\n# text = x y z\n" + row("1", "x", "Entity=(a-person-1)") + "\n" + row("2", "y", "Entity=(b-person-1)|Bridge=a<b:part") + "\n" + row("3", "z", "Entity=(c-person-1)|SplitAnte=a<c,b<c") + "\n"));
    const mentions = result.documents[0]!.declaration.occurrences;
    expect(new Set(mentions.map(mention => mention.referentId)).size).toBe(3);
    expect(JSON.stringify(mentions[2]!.sourceTags)).toContain("SplitAnte");
  });

  it("abstains from discontinuous, zero-node and contraction-boundary spans and marks their chains incomplete", () => {
    const result = readCorefUDSource(fixture("# newdoc id = unsupported\n# text = al x y\n" + row("1-2", "al") + "\n" + row("1", "a") + "\n"
      + row("2", "el", "Entity=(a-person-1)") + "\n" + row("2.1", "_", "Entity=(b-person-1)") + "\n"
      + row("3", "x", "Entity=(c[1/2]-person-1)") + "\n" + row("4", "y", "Entity=(c[2/2]-person-1)") + "\n"));
    const document = result.documents[0]!;
    expect(document.declaration).toMatchObject({ occurrences: [], completeReferentIds: [] });
    expect(document.issues.map(issue => issue.code)).toEqual(["multiword_boundary", "empty_node_mention", "discontinuous_mention", "discontinuous_mention"]);
  });

  it("does not guess offsets after a source-text mismatch or accept competing annotations for one span", () => {
    const mismatch = readCorefUDSource(fixture("# newdoc id = mismatch\n# text = x\n" + row("1", "other", "Entity=(a-person-1)") + "\n"));
    expect(mismatch.documents[0]!.declaration.occurrences).toEqual([]);
    const conflict = readCorefUDSource(fixture("# newdoc id = conflict\n# text = x\n" + row("1", "x", "Entity=(a-person-1)(b-person-1)") + "\n"));
    expect(conflict.documents[0]!.declaration).toMatchObject({ occurrences: [], completeReferentIds: [] });
  });

  it("requires exact artifact ownership and declared document/schema/text boundaries", () => {
    const source = fixture("# newdoc id = owned\n# text = x\n" + row("1", "x", "Entity=(a-person-1)") + "\n");
    expect(() => readCorefUDSource({ ...source, text: source.text + "\n" })).toThrow(/artifact hash/u);
    expect(() => readCorefUDSource(fixture("# text = x\n" + row("1", "x") + "\n"))).toThrow(/document id/u);
    expect(() => readCorefUDSource(fixture("# newdoc id = missing\n" + row("1", "x") + "\n"))).toThrow(/exact text/u);
  });

  it("rejects source leakage across artifact versions while admitting independent source documents", () => {
    const source = fixture("# newdoc id = owned\n# text = x\n" + row("1", "x", "Entity=(a-person-1)") + "\n");
    const first = readCorefUDSource(source).documents;
    const revised = readCorefUDSource({ ...source, owner: { ...source.owner, sourceUri: "fixture://another-artifact-version" } }).documents;
    expect(() => assertCorefUDSourceDisjoint(first, revised)).toThrow(/source-document overlap/u);
    const independent = readCorefUDSource(fixture(source.text.replace("newdoc id = owned", "newdoc id = independent").replace("# global.Entity = eid-etype-head-other\n", ""))).documents;
    expect(() => assertCorefUDSourceDisjoint(first, independent)).not.toThrow();
  });
});
