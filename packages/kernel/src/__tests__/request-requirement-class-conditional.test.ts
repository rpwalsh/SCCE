import { describe, expect, it } from "vitest";
import { compileRequestRequirementCorpus, REQUEST_REQUIREMENT_CORPUS_SCHEMA, reconcileRequestRequirementPatterns, type RequestRequirementCorpusExample } from "../request-requirement-learning.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { deriveTurnRequirementField } from "../turn-requirements.js";
import { projectRequestAuthority } from "../request-authority.js";
import { createHasher } from "../primitives.js";
import type { EvidenceId, JsonValue, SourceVersionId } from "../types.js";

function compile(examples: RequestRequirementCorpusExample[]) {
  return compileRequestRequirementCorpus({
    corpus: { schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA, language: "und", examples },
    profileId: "profile.conditional", sourceVersionId: "source.conditional" as SourceVersionId,
    evidenceIds: ["evidence.conditional" as EvidenceId], sourceSystem: "conditional", updatedAt: 1,
    makeId: value => createHasher().digestHex(JSON.stringify(value))
  }).patterns;
}

function classify(patterns: ReturnType<typeof compile>, requestText: string) {
  const languageMemoryState = createLanguageMemoryRuntime().hydrate({ models: [], patterns });
  return projectRequestAuthority({ requirementField: deriveTurnRequirementField({ requestText, languageMemoryState }) }).projectedAuthority;
}

describe("source class-conditional requirement learning", () => {
  it.each([
    ["Write a short scene", "Tell me the facts", "about a", "who"],
    ["nava sula", "paku zema", "keta", "yiri"],
    ["\u5199 \u4e00\u4e2a \u6545\u4e8b", "\u8bf4\u660e \u4e8b\u5b9e", "\u5173\u4e8e \u4e00\u4e2a", "\u89d2\u8272"]
  ])("calibrates common background independently of source class size: %s", (creative, factual, shared, relative) => {
    const creativeRows = Array.from({ length: 8 }, (_, index) => ({
      text: `${creative} ${shared} subject${index} ${relative} object${index}`,
      authority: "creative" as const
    }));
    const factualRows = Array.from({ length: 8 }, (_, index) => ({
      text: `${factual} ${shared} entity${index} ${relative} item${index}`,
      authority: "factual" as const
    }));
    const balanced = compile([...creativeRows, ...factualRows]);
    const imbalanced = compile([...creativeRows, ...Array.from({ length: 320 }, (_, index) => ({
      text: `${factual} ${shared} entity${index} ${relative} item${index}`, authority: "factual" as const
    }))]);
    const creativeRequest = `${creative} ${shared} unseen ${relative} other`;
    const factualRequest = `${factual} ${shared} unseen ${relative} other`;
    for (const patterns of [balanced, imbalanced]) {
      expect(classify(patterns, creativeRequest)).toBe("creative");
      expect(classify(patterns, factualRequest)).toBe("factual");
    }
    const signatures = (patterns: ReturnType<typeof compile>) => patterns.map(pattern => {
      const row = pattern.patternJson as Record<string, JsonValue>;
      return [row.learnedFrameOrPatternId, row.selectedAuthority, row.requirementCoefficients];
    }).sort((left, right) => String(left[0]).localeCompare(String(right[0])));
    expect(signatures(imbalanced)).toEqual(signatures(balanced));
    const duplicatedSource = [...imbalanced, ...imbalanced.map(pattern => ({ ...pattern, id: `${pattern.id}.copy` }))];
    expect(classify(duplicatedSource, creativeRequest)).toBe("creative");
    const field = (patterns: ReturnType<typeof compile>) => deriveTurnRequirementField({
      requestText: creativeRequest, languageMemoryState: createLanguageMemoryRuntime().hydrate({ models: [], patterns })
    });
    expect(field(duplicatedSource).noveltyDemand).toBeCloseTo(field(imbalanced).noveltyDemand, 12);
    expect(field(duplicatedSource).externalTruthAuthority).toBeCloseTo(field(imbalanced).externalTruthAuthority, 12);
    expect(classify([...imbalanced].reverse(), factualRequest)).toBe("factual");
  });

  it("routes the measured imbalanced source contrast without treating background words as factual priors", () => {
    const examples: RequestRequirementCorpusExample[] = [
      ...Array.from({ length: 900 }, (_, index) => ({
        text: `question${index} ${index < 194 ? "a" : ""} entity${index} ${index < 59 ? "about" : ""} topic${index} ${index < 78 ? "who" : ""} object${index}`,
        authority: "factual" as const
      })),
      ...Array.from({ length: 176 }, (_, index) => ({
        text: `${index < 4 ? "Write a short" : `invent${index}`} ${index < 88 ? "a" : ""} subject${index} ${index < 10 ? "about" : ""} theme${index} ${index < 7 ? "who" : ""} other${index}`,
        authority: "creative" as const
      }))
    ];
    const patterns = compile(examples);
    const bySurface = (surface: string) => patterns.find(pattern => {
      const row = pattern.patternJson as Record<string, JsonValue>;
      return row.surface === surface && row.anchor === "any";
    })?.patternJson as Record<string, JsonValue> | undefined;
    expect(bySurface("a")?.selectedAuthority).toBe("creative");
    expect(bySurface("about")).toBeUndefined();
    expect(bySurface("who")?.authorityProbabilities).toMatchObject({ factual: expect.any(Number), creative: expect.any(Number) });
    expect(classify(patterns, "Write a short scene about a sailor who befriends a clockmaker.")).toBe("creative");
  });

  it("persists class totals and refuses stale calibration when sufficient statistics are absent", () => {
    const patterns = compile([
      { text: "nava toma", authority: "creative" }, { text: "nava ravi", authority: "creative" },
      { text: "sula toma", authority: "factual" }, { text: "sula ravi", authority: "factual" }
    ]);
    const pattern = patterns[0]!;
    const row = pattern.patternJson as Record<string, JsonValue>;
    expect(row.sourceClassTotals).toMatchObject({ creative: 2, factual: 2 });
    const { sourceClassTotals: _totals, ...withoutTotals } = row;
    const stale = { ...pattern, patternJson: { ...withoutTotals, compilerFingerprint: "previous.compiler" } };
    const reconciled = reconcileRequestRequirementPatterns([stale]);
    expect(reconciled.patterns).toEqual([]);
    expect(reconciled.report).toMatchObject({ status: "inert_stale_compiler", droppedStaleCompiler: 1 });
    const carried = reconcileRequestRequirementPatterns([{ ...pattern, patternJson: { ...row, compilerFingerprint: "previous.compiler" } }]);
    expect(carried.report).toMatchObject({ status: "active", recompiled: 1 });
    expect((carried.patterns[0]!.patternJson as Record<string, JsonValue>).requirementCoefficients).toEqual(row.requirementCoefficients);
  });
});
