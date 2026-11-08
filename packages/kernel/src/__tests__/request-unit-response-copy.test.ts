// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createHasher } from "../primitives.js";
import { compileRequestRequirementCorpus, REQUEST_REQUIREMENT_CORPUS_SCHEMA, REQUEST_REQUIREMENT_PATTERN_COMPILER_FINGERPRINT,
  REQUEST_UNIT_RESPONSE_COPY_RECIPE_ID, reconcileRequestRequirementPatterns, type RequestRequirementCorpusExample } from "../request-requirement-learning.js";
import type { EvidenceId, SourceVersionId } from "../types.js";

function compile(examples: RequestRequirementCorpusExample[]) {
  return compileRequestRequirementCorpus({ corpus: { schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA, language: "und", examples },
    profileId: "profile.raw-copy", sourceVersionId: "source-version.raw-copy" as SourceVersionId,
    evidenceIds: ["evidence.raw-copy" as EvidenceId], sourceSystem: "dialogue", updatedAt: 1,
    makeId: value => `pattern.${createHasher().digestHex(JSON.stringify(value))}` }).patterns;
}

const subjects = ["neralis", "arulis", "vilonis", "neralis", "arulis", "vilonis"];
const paired = (control: string, predicate: string, names = subjects): RequestRequirementCorpusExample[] => names.map((subject, index) => ({
  text: `${control} ${subject} ${predicate}?`, responseText: `${subject} ${predicate} pelora${index}.`, authority: "factual"
}));
const row = (patterns: ReturnType<typeof compile>, surface: string) => patterns.map(pattern => pattern.patternJson as Record<string, unknown>)
  .find(pattern => pattern.surface === surface && pattern.anchor === "any")!;

it.each([["where is", "located", subjects], ["ψ μ", "λ", ["α", "β", "γ", "α", "β", "γ"]]] as const)(
  "separates raw copied predicate units from rarity-filtered request roles for %s", (control, predicate, names) => {
    const patterns = compile(paired(control, predicate, [...names]));
    const predicateRow = row(patterns, predicate);
    expect(predicateRow).toMatchObject({ requestSpanRole: "control", responseMatchRate: 0, pairedExamples: 6,
      requestUnitResponseCopyRecipe: REQUEST_UNIT_RESPONSE_COPY_RECIPE_ID, requestUnitResponseCopyAuthority: "factual",
      requestUnitResponseCopy: [{ unit: predicate, supportedPairs: 6, copiedPairs: 6 }] });
    expect(row(patterns, control).requestUnitResponseCopy).toEqual(control.split(" ").map(unit => ({ unit, supportedPairs: 6, copiedPairs: 0 })));
  });

it("does not license erasing a copied predicate inside a larger control feature absent from the reply", () => {
  const patterns = compile(subjects.map(subject => ({ text: `where is located ${subject}?`, responseText: `${subject} located pelora.`, authority: "factual" })));
  expect(row(patterns, "where is located")).toMatchObject({ requestSpanRole: "control", responseMatchRate: 0,
    requestUnitResponseCopy: [{ unit: "where", supportedPairs: 6, copiedPairs: 0 }, { unit: "is", supportedPairs: 6, copiedPairs: 0 },
      { unit: "located", supportedPairs: 6, copiedPairs: 6 }] });
});

it("reads the complete paired reply when a copied predicate occurs beyond the legacy style token budget", () => {
  const examples = paired("where is", "located").map(example => ({ ...example, responseText: `${"padding ".repeat(600)}${example.responseText}` }));
  expect(row(compile(examples), "located").requestUnitResponseCopy).toEqual([{ unit: "located", supportedPairs: 6, copiedPairs: 6 }]);
});

it("counts opaque copied units independently of JavaScript object property names", () => {
  expect(row(compile(paired("where is", "constructor")), "constructor").requestUnitResponseCopy)
    .toEqual([{ unit: "constructor", supportedPairs: 6, copiedPairs: 6 }]);
});

it("keeps raw copy witnesses conditioned on the authority that supplied the request pattern", () => {
  const factual: RequestRequirementCorpusExample[] = subjects.map(subject => ({ text: `where is located ${subject}?`, responseText: `${subject} located pelora.`, authority: "factual" }));
  const creative: RequestRequirementCorpusExample[] = subjects.map((subject, index) => ({ text: index < 2 ? `where is located ${subject}?` : `compose a tale ${subject}`,
    responseText: `${subject} imagined stars.`, authority: "creative" }));
  expect(row(compile([...factual, ...creative]), "where is located")).toMatchObject({ selectedAuthority: "factual", requestUnitResponseCopyAuthority: "factual",
    requestUnitResponseCopy: [{ unit: "where", supportedPairs: 6, copiedPairs: 0 }, { unit: "is", supportedPairs: 6, copiedPairs: 0 },
      { unit: "located", supportedPairs: 6, copiedPairs: 6 }] });
});

it("does not turn incomplete or unknown paired replies into zero-copy erasure witnesses", () => {
  for (const examples of [paired("where is", "located").map(({ responseText: _reply, ...example }) => example),
    paired("where is", "located").map((example, index) => index < 3 ? example : { ...example, responseText: undefined }),
    paired("where is", "located").map((example, index) => index < 3 ? example : { ...example, responseText: "   " }),
    paired("where is", "located").map((example, index) => index < 3 ? example : { ...example, responseText: "." })]) {
    expect(row(compile(examples), "located").requestUnitResponseCopy).toBeUndefined();
  }
});

it("cold-restores measured per-unit counts while leaving legacy rarity-only rows without invented copy witnesses", () => {
  const patterns = compile(paired("where is", "located"));
  const runtime = createLanguageMemoryRuntime();
  const cold = runtime.hydrate({ models: [], patterns: JSON.parse(JSON.stringify(patterns)) });
  expect(row(cold.importedPatterns, "located").requestUnitResponseCopy).toEqual([{ unit: "located", supportedPairs: 6, copiedPairs: 6 }]);
  const legacy = patterns.map(pattern => {
    const { requestUnitResponseCopy: _copy, requestUnitResponseCopyRecipe: _recipe, requestUnitResponseCopyAuthority: _authority, ...value } = pattern.patternJson as Record<string, unknown>;
    return { ...pattern, patternJson: { ...value, compilerFingerprint: "scce.request_requirement_pattern.source_background.v4" } as never };
  });
  const restored = runtime.hydrate({ models: [], patterns: JSON.parse(JSON.stringify(legacy)) });
  expect(row(restored.importedPatterns, "located")).toMatchObject({ compilerFingerprint: REQUEST_REQUIREMENT_PATTERN_COMPILER_FINGERPRINT, requestSpanRole: "control", responseMatchRate: 0 });
  expect(row(restored.importedPatterns, "located").requestUnitResponseCopy).toBeUndefined();
});

it("recompiles the same source scope into stable witness identities and supersedes the old compiler's rows", () => {
  const first = compile(paired("where is", "located"));
  const replay = compile(paired("where is", "located"));
  expect(replay).toEqual(first);
  const legacy = first.map(pattern => ({ ...pattern, id: `${pattern.id}.legacy`, patternJson: { ...(pattern.patternJson as object),
    compilerFingerprint: "scce.request_requirement_pattern.source_background.v4" } as never }));
  const replaced = reconcileRequestRequirementPatterns([...legacy, ...replay]);
  expect(replaced.report.superseded).toBe(legacy.length);
  expect(replaced.patterns).toEqual(first);
});
