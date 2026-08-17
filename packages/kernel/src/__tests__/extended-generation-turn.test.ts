import { describe, expect, it } from "vitest";
import {
  buildExtendedGenerationPlan,
  extendedGenerationDecision,
  extendedGenerationSessionForTurn,
  runExtendedGeneration
} from "../extended-generation-turn.js";
import { deriveTurnRequirementField } from "../turn-requirements.js";
import type { DocumentPlanNode } from "../document-plan.js";

/**
 * Plan items 221-228, live routing. The multi-section narrative machinery
 * existed and was tested, but nothing turned an ordinary request for a long
 * piece of writing into a sequence of calls into it -- such a request
 * collapsed into a single realization call and produced one or two
 * sentences. These tests pin the routing decision, the generated plan, the
 * iterative section loop, and the real validation gate.
 */
describe("extended generation routing (plan items 221-228 live routing)", () => {
  const detailedField = () => deriveTurnRequirementField({
    requestText: "Write a five page story about Einstein fighting a dragon.",
    explicitRequirements: [
      { dimension: "brevityDetailBalance", value: 0.95, status: "explicit", semanticRoleId: "role.test.detail", learnedFrameOrPatternId: "pattern.test.detail" },
      { dimension: "noveltyDemand", value: 0.9, status: "explicit", semanticRoleId: "role.test.novelty", learnedFrameOrPatternId: "pattern.test.novelty" }
    ]
  });

  it("routes a high-detail high-novelty creative turn into extended generation", () => {
    const decision = extendedGenerationDecision({
      requirementField: detailedField(),
      requestedAuthority: "creative"
    });
    expect(decision.required).toBe(true);
    expect(decision.sectionTarget).toBeGreaterThanOrEqual(3);
  });

  it("never fires on an uncalibrated requirement model, which answers identically for every request", () => {
    // Real measured behavior of an untrained deployment: deriveTurnRequirementField
    // returns the same constants for "hi" and for a five-page story request,
    // with confidence 0. Routing on that would fire for literally every
    // creative turn.
    const unfit = deriveTurnRequirementField({ requestText: "Write a five page story about Einstein fighting a dragon." });
    const trivial = deriveTurnRequirementField({ requestText: "hi" });
    expect(unfit.confidence).toBe(0);
    expect(unfit.brevityDetailBalance).toBe(trivial.brevityDetailBalance);
    expect(extendedGenerationDecision({ requirementField: unfit, requestedAuthority: "creative" }).required).toBe(false);
  });

  it("does not hijack non-creative authority", () => {
    for (const authority of ["factual", "reasoned", "program", "action", "translation"] as const) {
      expect(extendedGenerationDecision({ requirementField: detailedField(), requestedAuthority: authority }).required).toBe(false);
    }
  });

  it("builds a real ordered plan whose sections cannot be written out of order", () => {
    const plan = buildExtendedGenerationPlan({
      requestText: "Write a five page story about Einstein fighting a dragon.",
      sectionTarget: 4
    });
    const sections = Object.values(plan.nodes).filter(node => node.kind === "section");
    expect(sections).toHaveLength(4);
    // Each section after the first genuinely depends on its predecessor.
    const ordered = sections.sort((a, b) => a.order - b.order);
    for (let index = 1; index < ordered.length; index++) {
      expect(ordered[index]!.rhetoricalDependsOnIds).toContain(ordered[index - 1]!.id);
    }
  });

  it("realizes every section iteratively through the injected realizer and assembles them", async () => {
    const session = extendedGenerationSessionForTurn({
      requestText: "Write a five page story about Einstein fighting a dragon.",
      sectionTarget: 4
    });
    const seen: string[] = [];
    const run = await runExtendedGeneration({
      session,
      realizeSection: async (section: DocumentPlanNode, index: number) => {
        seen.push(section.id);
        return { text: `Section ${index + 1} body text about the confrontation.` };
      }
    });

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(run.sections.every(row => row.accepted)).toBe(true);
    // A real assembled multi-section document, not one realization.
    expect(run.answer.split("\n\n")).toHaveLength(4);
    expect(run.answer.length).toBeGreaterThan(120);
  });

  it("blocks a section that copies a protected passage, via the real anti-copy guard", async () => {
    const protectedText = "The dragon circled the tower while Einstein calculated the precise angle of its descent.";
    const session = extendedGenerationSessionForTurn({
      requestText: "Write a five page story about Einstein fighting a dragon.",
      sectionTarget: 3,
      protectedPassages: [{ sourceId: "protected.1", text: protectedText }]
    });
    // A session only guards when it carries a voice profile; attach one so the
    // real guard in document-generation-session.ts is genuinely exercised.
    const guarded = { ...session, voiceProfile: { id: "voice.test", cadence: { averageSentenceLength: 12, sentenceLengthVariance: 2 }, lexicalPreferences: [], syntacticPreferences: [] } as never };

    const run = await runExtendedGeneration({
      session: guarded,
      realizeSection: async () => ({ text: protectedText })
    });

    const rejected = run.sections.find(row => !row.accepted);
    expect(rejected).toBeDefined();
    expect(run.answer).toBe("");
  });

  it("stops rather than emitting a document with an empty section", async () => {
    const session = extendedGenerationSessionForTurn({
      requestText: "Write a five page story about Einstein fighting a dragon.",
      sectionTarget: 4
    });
    const run = await runExtendedGeneration({
      session,
      realizeSection: async (_section, index) => ({ text: index === 1 ? "   " : "Real section content here." })
    });
    expect(run.sections.filter(row => row.accepted)).toHaveLength(1);
    expect(run.sections.some(row => row.reason === "empty realization")).toBe(true);
  });
});
