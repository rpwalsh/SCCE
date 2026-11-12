// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { structuredSourceRequestValueResolver } from "../structured-source-request-binding.js";
import type { LearnedRequestOmittedSlotAudit } from "../source-construction-request-binding.js";
import type { EvidenceSpan } from "../types.js";

const REQUEST = "Which Rust version does Walkdir's pinned CI build use?";

function demand(requestSurface = REQUEST.replace(/\?$/u, ""), matchedSurfaces = ["Which Rust version does", "Walkdir's pinned CI build", "use"],
  roleSurfaces = [matchedSurfaces[1]!]): LearnedRequestOmittedSlotAudit {
  const roles = new Set(roleSurfaces);
  return { status: "value_demand", visited: 7, matchedConstructionIds: ["construction.version"], demand: {
    requestSurface, relationId: "relation.version", requestedRoleId: "role.version", valueKind: "opaque.version",
    constructionIds: ["construction.version"], bindingIds: ["binding.version"],
    matchedLiteralSurfaces: matchedSurfaces.filter(surface => !roles.has(surface)),
    matchedRoleSurfaces: roleSurfaces.map((surface, index) => ({ surface, roleId: `role.subject.${index}`,
      occurrenceId: `occurrence.subject.${index}`, graphBinding: {
        relationId: "relation.version", roleId: `role.subject.${index}`, valueKind: "opaque.subject"
      } })),
    matchedSurfaces
  } };
}

function span(id: string, text: string, options: { mediaType?: string; status?: EvidenceSpan["status"]; title?: string; uri?: string } = {}): EvidenceSpan {
  const mediaType = options.mediaType ?? "application/yaml";
  return {
    id: id as EvidenceSpan["id"], sourceId: `source.${id}` as EvidenceSpan["sourceId"],
    sourceVersionId: `version.${id}` as EvidenceSpan["sourceVersionId"], chunkId: `chunk.${id}` as EvidenceSpan["chunkId"],
    contentHash: `sha256_${id}` as EvidenceSpan["contentHash"], mediaType,
    byteStart: 0, byteEnd: text.length, charStart: 0, charEnd: text.length, text, textPreview: text,
    languageHints: {}, scriptHints: {}, trustVector: { trust: 1, sourceTrust: 1, structuralConfidence: 1, forceClass: "direct_evidence" },
    provenance: { title: options.title ?? id, uri: options.uri ?? (mediaType.includes("json") ? `fixture://${id}.json` : `fixture://${id}.yml`) },
    features: [], status: options.status ?? "promoted", alpha: 1, observedAt: 1
  };
}

const CI = [
  "matrix:", "  include:", "    - build: pinned", "      os: ubuntu-latest", "      rust: 1.60.0",
  "    - build: pinned-win", "      os: windows-latest", "      rust: stable"
].join("\n");

describe("learned-demand structured source binding", () => {
  it("binds the unique same-item YAML key and selector under the typed omitted slot", () => {
    const evidence = span("ci", CI, { uri: "fixture://BurntSushi--walkdir/.github/workflows/ci.yml" });
    expect(structuredSourceRequestValueResolver(demand()).resolve(REQUEST, [evidence])).toEqual({
      value: "1.60.0", subject: "Walkdir's pinned CI build", relationId: "relation.version",
      requestedRoleId: "role.version", evidenceIds: ["ci"]
    });
  });

  it("uses the same structural rule for JSON", () => {
    const evidence = span("manifest", JSON.stringify({ matrix: { include: [
      { build: "pinned", rust: "1.60.0" }, { build: "pinned-win", rust: "stable" }
    ] } }), { mediaType: "application/json", uri: "fixture://walkdir/ci.json" });
    expect(structuredSourceRequestValueResolver(demand()).resolve(REQUEST, [evidence])).toMatchObject({ value: "1.60.0" });
  });

  it("does not turn polar or supplied-value requests into missing-value answers", () => {
    const evidence = span("ci", CI);
    const polar: LearnedRequestOmittedSlotAudit = { status: "closed_proposition", visited: 3, matchedConstructionIds: ["construction.polar"] };
    expect(structuredSourceRequestValueResolver(polar).resolve("Does the pinned build use Rust?", [evidence])).toBeUndefined();
    expect(structuredSourceRequestValueResolver(polar).resolve("Is the pinned build's Rust stable?", [evidence])).toBeUndefined();
    expect(structuredSourceRequestValueResolver(demand()).resolve("Does the pinned build use Rust?", [evidence])).toBeUndefined();
    expect(structuredSourceRequestValueResolver(demand()).resolve("Is the pinned build's Rust stable?", [evidence])).toBeUndefined();
  });

  it("abstains on duplicate selected records, missing selectors, and competing selector bindings", () => {
    expect(structuredSourceRequestValueResolver(demand()).resolve(REQUEST, [span("duplicate", [
      "include:", "  - build: pinned", "    rust: 1.60.0", "  - build: pinned", "    rust: 1.61.0"
    ].join("\n"))])).toBeUndefined();
    expect(structuredSourceRequestValueResolver(demand()).resolve(REQUEST, [span("no-selector", "rust: 1.60.0")])).toBeUndefined();
    expect(structuredSourceRequestValueResolver(demand()).resolve(REQUEST, [span("two-selectors", "build: pinned\nci: pinned\nrust: 1.60.0")])).toBeUndefined();
  });

  it("does not assemble a target key from unrelated learned literal fragments", () => {
    const audit = demand(REQUEST.replace(/\?$/u, ""), ["Which foo", "bar value", "Walkdir's pinned CI build"],
      ["Walkdir's pinned CI build"]);
    expect(structuredSourceRequestValueResolver(audit).resolve(REQUEST, [span("cross-fragment", [
      "build: pinned", "foo bar: 1.60.0"
    ].join("\n"))])).toBeUndefined();
  });

  it("does not assemble one selector from separate typed role fills", () => {
    const audit = demand(REQUEST.replace(/\?$/u, ""), ["Which Rust version", "Walkdir build", "pinned CI", "use"],
      ["Walkdir build", "pinned CI"]);
    expect(structuredSourceRequestValueResolver(audit).resolve(REQUEST, [span("cross-role", [
      "build: pinned", "rust: 1.60.0"
    ].join("\n"))])).toBeUndefined();
  });

  it("abstains when bounded traversal hides a later duplicate", () => {
    const records = [{ build: "pinned", rust: "1.60.0" },
      ...Array.from({ length: 4_095 }, (_, index) => ({ build: `other-${index}`, rust: `value-${index}` })),
      { build: "pinned", rust: "1.61.0" }];
    const evidence = span("bounded", JSON.stringify({ matrix: { include: records } }), { mediaType: "application/json" });
    expect(structuredSourceRequestValueResolver(demand()).resolve(REQUEST, [evidence])).toBeUndefined();
  });

  it("requires the learned owner surface when multiple structured sources compete", () => {
    const alpha = span("alpha", "build: pinned\nrust: 1.59.0", { uri: "fixture://alpha/ci.yml" });
    const walkdir = span("walkdir", "build: pinned\nrust: 1.60.0", { uri: "fixture://walkdir/ci.yml" });
    expect(structuredSourceRequestValueResolver(demand()).resolve(REQUEST, [alpha, walkdir])).toMatchObject({ value: "1.60.0", evidenceIds: ["walkdir"] });
    expect(structuredSourceRequestValueResolver(demand("Which Rust version does the pinned CI build use", ["Which Rust version does", "pinned CI build", "use"]))
      .resolve("Which Rust version does the pinned CI build use?", [alpha, walkdir])).toBeUndefined();
  });

  it("matches Unicode keys and selectors without an English inventory", () => {
    const request = "\u0938\u094d\u0925\u093f\u0930 \u0928\u093f\u0930\u094d\u092e\u093e\u0923 \u0915\u0940 \u092d\u093e\u0937\u093e?";
    const audit = demand(request.replace(/\?$/u, ""), ["\u0938\u094d\u0925\u093f\u0930 \u0928\u093f\u0930\u094d\u092e\u093e\u0923", "\u092d\u093e\u0937\u093e"],
      ["\u0938\u094d\u0925\u093f\u0930 \u0928\u093f\u0930\u094d\u092e\u093e\u0923"]);
    const evidence = span("unicode", [
      "\u0915\u093e\u0930\u094d\u092f:", "  - \u0928\u093f\u0930\u094d\u092e\u093e\u0923: \u0938\u094d\u0925\u093f\u0930", "    \u092d\u093e\u0937\u093e: \u0938\u0902\u0938\u094d\u0915\u0930\u0923-\u096d",
      "  - \u0928\u093f\u0930\u094d\u092e\u093e\u0923: \u0928\u0935\u0940\u0928", "    \u092d\u093e\u0937\u093e: \u0938\u0902\u0938\u094d\u0915\u0930\u0923-\u096e"
    ].join("\n"));
    expect(structuredSourceRequestValueResolver(audit).resolve(request, [evidence])).toMatchObject({
      value: "\u0938\u0902\u0938\u094d\u0915\u0930\u0923-\u096d", subject: "\u0938\u094d\u0925\u093f\u0930"
    });
  });

  it("rejects prose, aliases, invalid documents, and unpromoted evidence", () => {
    const resolver = structuredSourceRequestValueResolver(demand());
    expect(resolver.resolve(REQUEST, [span("prose", "build: pinned\nrust: 1.60.0", { mediaType: "text/plain", uri: "fixture://prose.txt" })])).toBeUndefined();
    expect(resolver.resolve(REQUEST, [span("alias", "build: pinned\nbase: &base 1.60.0\nrust: *base")])).toBeUndefined();
    expect(resolver.resolve(REQUEST, [span("bad", "build: pinned\nrust: [")])).toBeUndefined();
    expect(resolver.resolve(REQUEST, [span("draft", "build: pinned\nrust: 1.60.0", { status: "quarantined" })])).toBeUndefined();
  });
});
