// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { evidenceIdentityBinding } from "../local-evidence-runtime.js";
import type { EvidenceSpan } from "../types.js";

/**
 * The live corpus measurement these cases replay (scce3_runtime, 2026-09-16), so every expectation below is a
 * property of measured spread and the corpus's own Otsu split rather than of a unit's length or case.
 */
const CONCENTRATION = 289;
const SPREAD = new Map<string, number>([
  ["einstein", 125],
  ["discover", 240],
  ["capital", 812],
  ["createprogramplanner", 10],
  ["sentences", 12]
]);
const CLOSED_CLASS = new Set(["what", "did", "which", "is", "the", "of", "file", "defines"]);

function codeSpan(uri: string, text: string): EvidenceSpan {
  return {
    id: `evidence_span.${uri}`,
    sourceId: `source.${uri}`,
    sourceVersionId: `source_version.${uri}`,
    chunkId: `chunk.${uri}`,
    contentHash: `sha256_${uri}`,
    mediaType: "text/plain; charset=utf-8",
    text,
    textPreview: text.slice(0, 80),
    languageHints: ["en"],
    scriptHints: ["Latn"],
    trustVector: { reliability: 1, corroboration: 1, recency: 1 },
    status: "promoted",
    alpha: 1,
    observedAt: new Date(1000).toISOString(),
    byteStart: 0,
    byteEnd: text.length,
    charStart: 0,
    charEnd: text.length,
    features: [],
    provenance: { uri, metadata: {} }
  } as unknown as EvidenceSpan;
}

const NL = String.fromCharCode(10);
const MOUTH_COMMENT = codeSpan("packages/kernel/src/mouth.ts", [
  "// Albert Einstein is named in this comment only as an example.",
  "export function realizeSurface(plan) {",
  "  return plan.surface;",
  "}"
].join(NL));

function prime(spread: ReadonlyMap<string, number>, concentration = CONCENTRATION): void {
  primeCorpusIdentitySignals({ closedClass: CLOSED_CLASS, identities: new Set(), spread: new Map(spread), concentration });
}

afterEach(() => clearCorpusIdentitySignals());

describe("a source file declares what the corpus measures as concentrated, on a line that bears code", () => {
  it("does not bind a prose subject the corpus spreads, named only in a comment", () => {
    prime(SPREAD);
    // Measured, not asserted: einstein IS concentrated (125 <= 289), so specificity alone cannot refuse it -- the
    // comment is refused because a comment mentions rather than declares.
    expect(SPREAD.get("einstein")!).toBeLessThanOrEqual(CONCENTRATION);
    expect(evidenceIdentityBinding(MOUTH_COMMENT, "What did Einstein discover?", CLOSED_CLASS)).toBe("none");
  });

  it("binds the file whose code line declares the identifier", () => {
    prime(SPREAD);
    const planner = codeSpan("packages/kernel/src/program-planner.ts", [
      "// Program planning over the corpus's own measured quantities.",
      "export function createProgramPlanner(options) {",
      "  return buildPlanner(options);",
      "}"
    ].join(NL));
    expect(evidenceIdentityBinding(planner, "Which file defines createProgramPlanner?", CLOSED_CLASS)).toBe("declaration");
  });

  it("refuses a unit the corpus spreads above its own split even on a code line", () => {
    prime(SPREAD);
    const wide = codeSpan("packages/kernel/src/budget.ts", ["export const capital = readCapital();", "return capital;"].join(NL));
    expect(SPREAD.get("capital")!).toBeGreaterThan(CONCENTRATION);
    expect(evidenceIdentityBinding(wide, "what is the capital of Albania?", CLOSED_CLASS)).toBe("none");
  });

  it("decides two units of equal measured spread alike, whatever their case or length", () => {
    // `sentences` and `createprogramplanner` are measured at 12 and 10 sources: both concentrated, one lowercase
    // and nine characters, one mixed-case and twenty. The old rule bound only the second.
    prime(SPREAD);
    const lower = codeSpan("packages/kernel/src/a.ts", "export const sentences = split(text);");
    const mixed = codeSpan("packages/kernel/src/b.ts", "export function createProgramPlanner(options) {");
    expect(SPREAD.get("sentences")!).toBeLessThanOrEqual(CONCENTRATION);
    expect(SPREAD.get("createprogramplanner")!).toBeLessThanOrEqual(CONCENTRATION);
    expect(evidenceIdentityBinding(lower, "Which file defines sentences?", CLOSED_CLASS)).toBe("declaration");
    expect(evidenceIdentityBinding(mixed, "Which file defines createProgramPlanner?", CLOSED_CLASS)).toBe("declaration");
  });

  it("carries an unmeasured unit rather than refusing it, and refuses nothing when the split is unmeasured", () => {
    // Law 1: no measurement is not a failed measurement. An identifier the corpus never measured still binds.
    prime(new Map([["einstein", 125]]));
    const span = codeSpan("packages/kernel/src/c.ts", "export function nowhereMeasured(input) {");
    expect(evidenceIdentityBinding(span, "Which file defines nowhereMeasured?", CLOSED_CLASS)).toBe("declaration");
    prime(SPREAD, 0);
    const wide = codeSpan("packages/kernel/src/budget.ts", "export const capital = readCapital();");
    expect(evidenceIdentityBinding(wide, "what is the capital of Albania?", CLOSED_CLASS)).toBe("declaration");
  });
});
