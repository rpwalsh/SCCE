import { describe, expect, it } from "vitest";
import { creativeRequestContentSurface, realizeCreativeSection } from "../creative-section-realization.js";
import { createLanguageMemoryRuntime, type LanguageGenerationInput } from "../language-memory-runtime.js";
import { induceLearnedConstructions, type SurfaceMeaningPlan } from "../language-construction.js";
import { createHasher } from "../primitives.js";
import { LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA } from "../language-construction-memory.js";
import { sourceDerivedCasingHints } from "../surface-linguistics.js";
import type { NarrativeConditioning } from "../document-generation-session.js";

describe("creative section realization handoff", () => {
  it("keeps classifying topic matches while removing only learned control syntax", () => {
    const request = "Write a short scene about a sailor who befriends a clockmaker.";
    const span = (surface: string) => ({ charStart: [...request.slice(0, request.indexOf(surface))].length,
      charEnd: [...request.slice(0, request.indexOf(surface) + surface.length)].length });
    const field = { trace: { activations: [
      { kind: "pattern", requestSpanRole: "control", span: span("Write a short scene about") },
      { kind: "pattern", requestSpanRole: "content", span: span("sailor") },
      { kind: "pattern", requestSpanRole: null, span: span("clockmaker") }
    ] } };
    expect(creativeRequestContentSurface(request, field)).toBe("a sailor who befriends a clockmaker.");
  });

  it.each([
    ["Write a short scene about a sailor who befriends a clockmaker.", "Write a short scene about", "sailor", "clockmaker"],
    ["物語を書いて 船乗り と 時計職人", "物語を書いて", "船乗り", "時計職人"]
  ])("uses learned request spans as the section's content role: %s", (requestText, control, first, second) => {
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrateFromImportedBrain({ importRunId: "creative.subject", models: [], observations: [], units: [], patterns: [], semanticFrames: [] });
    const start = [...requestText.slice(0, requestText.indexOf(control))].length;
    const field = { trace: { activations: [{ kind: "pattern", requestSpanRole: "control", span: { charStart: start, charEnd: start + [...control].length } }] } };
    let generatedInput: LanguageGenerationInput | undefined;
    const generate = runtime.generate.bind(runtime);
    runtime.generate = input => { generatedInput = input; return generate(input); };
    realizeCreativeSection({ languageMemory: runtime, state, requestText, sectionGoal: requestText, requirementField: field });
    const lexicalInput = JSON.stringify({ context: generatedInput?.contextSymbols, atoms: generatedInput?.frames?.[0]?.propositionAtoms,
      terms: generatedInput?.frames?.[0]?.requiredTerms });
    expect(lexicalInput).toContain(first);
    expect(lexicalInput).toContain(second);
    expect(lexicalInput).not.toContain(control);
  });

  it("preserves all contiguous content spans around learned control material", () => {
    const content = "κάλυ ρονά ζίμα τέλου";
    for (const [request, controlSpans] of [
      [`μήσα τάλι ${content}`, [[0, 4], [5, 9]]],
      [`${content} τάλι μήσα`, [[content.length + 1, content.length + 5], [content.length + 6, content.length + 10]]]
    ] as const) {
      const field = { trace: { activations: controlSpans.map(([charStart, charEnd]) => ({ kind: "pattern", requestSpanRole: "control", span: { charStart, charEnd } })) } };
      expect(creativeRequestContentSurface(request, field)).toBe(content);
    }
    const left = "κάλυ ρονά";
    const right = "ζίμα τέλου";
    const request = `μήσα ${left} τάλι ${right}`;
    const field = {
      trace: {
        activations: [
          { kind: "pattern", requestSpanRole: "control", span: { charStart: 0, charEnd: [..."μήσα"].length } },
          { kind: "pattern", requestSpanRole: "control", span: { charStart: [...`μήσα ${left} `].length, charEnd: [...`μήσα ${left} τάλι`].length } }
        ]
      }
    };
    expect(creativeRequestContentSurface(request, field)).toBe(`${left} ${right}`);
  });

  it("varies a retry through the sampler without turning its nonce into language context", () => {
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrateFromImportedBrain({ importRunId: "retry", models: [], observations: [], units: [], patterns: [], semanticFrames: [] });
    const inputs: LanguageGenerationInput[] = [];
    const generate = runtime.generate.bind(runtime);
    runtime.generate = input => { inputs.push(input); return generate(input); };
    for (const attempt of [1, 2]) realizeCreativeSection({ languageMemory: runtime, state, requestText: "κάλα τόνι", sectionGoal: "κάλα τόνι", attempt });
    expect(inputs[0]?.choiceSeed).not.toBe(inputs[1]?.choiceSeed);
    expect(inputs[0]?.contextSymbols).toEqual(inputs[1]?.contextSymbols);
  });
  it("carries committed typed state separately from the prior surface and never speaks its opaque IDs", () => {
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrateFromImportedBrain({ importRunId: "run.opaque", models: [], observations: [], units: [], patterns: [], semanticFrames: [] });
    const conditioning: NarrativeConditioning = {
      establishedFacts: [{ subjectId: "人物.甲", factId: "状态.乙", value: { "位置": "丙" } }],
      openSetupIds: ["伏线.丁"]
    };
    let generatedInput: LanguageGenerationInput | undefined;
    const generate = runtime.generate.bind(runtime);
    runtime.generate = input => {
      generatedInput = input;
      return generate(input);
    };
    const realized = realizeCreativeSection({
      languageMemory: runtime,
      state,
      requestText: "계속 이어지는 이야기",
      sectionGoal: "다음 장면",
      priorSurfaceTexts: ["이전 장면에서 새로운 길이 나타났다."],
      narrativeConditioning: conditioning
    });
    expect(generatedInput?.frames?.[0]?.narrativeConditioning).toBe(conditioning);
    const lexicalInput = JSON.stringify({
      context: generatedInput?.contextSymbols,
      atoms: generatedInput?.frames?.[0]?.propositionAtoms,
      terms: generatedInput?.frames?.[0]?.requiredTerms,
      vocabulary: generatedInput?.frames?.[0]?.topicVocabulary
    });
    for (const id of ["人物.甲", "状态.乙", "伏线.丁"]) expect(lexicalInput).not.toContain(id);
    expect(lexicalInput).toContain("나타났다");
    expect(realized.accepted).toBe(false);
  });

  it("uses typed narrative values to choose an attested learned surface without speaking opaque state ids", () => {
    const hasher = createHasher(), runtime = createLanguageMemoryRuntime({ hasher });
    const state = runtime.hydrate({ models: [] });
    const examples = ["lantern", "compass"].map(item => ({ id: `source.${item}`, profileKey: "profile.fixture",
      surface: `The ${item} glowed beside the harbor.`, evidenceIds: [`proof.${item}`],
      roleSpans: [{ roleId: "item", start: 4, end: 4 + item.length, surface: item, evidenceIds: [`proof.${item}`] }] }));
    const learned = induceLearnedConstructions({ hasher, examples });
    state.importedConstructionBundles = [{ schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, id: "source.grammar", bindingId: "scene.grammar",
      sourceProfileId: "profile.fixture", targetProfileId: "profile.fixture", sourceVersionIds: ["source.fixture"], evidenceIds: ["proof.lantern", "proof.compass"],
      evidenceContentHashes: [], sourceExamples: [], constructions: [...learned.constructions], formClasses: [...learned.formClasses], contentDigest: "fixture" }];
    const plans: SurfaceMeaningPlan[] = ["lantern", "compass"].map(item => ({ id: `plan.${item}`, profileKey: "profile.fixture", roleSignature: ["item"],
      slots: [{ roleId: "item", variants: [{ id: `value.${item}`, surface: item, profileKey: "profile.fixture", support: 1, evidenceIds: [`proof.${item}`] }] }] }));
    const generateUnder = (value: string) => runtime.generate({
      state, constructionPlans: plans,
      contextSymbols: ["scene"],
      frames: [{
        id: "frame.conditioned",
        role: "answer",
        force: "creative",
        narrativeConditioning: {
          establishedFacts: [{ subjectId: "entity.protagonist", factId: "state.carried_object", value }],
          openSetupIds: ["setup.unspoken"]
        }
      }],
      generationExtent: 24
    });

    const lantern = generateUnder("lantern");
    const compass = generateUnder("compass");

    expect(lantern.text).toContain("lantern");
    expect(lantern.text).not.toContain("compass");
    expect(compass.text).toContain("compass");
    expect(compass.text).not.toContain("lantern");
    expect(lantern.text).not.toContain("entity.protagonist");
    expect(lantern.text).not.toContain("state.carried_object");
    expect(lantern.text).not.toContain("setup.unspoken");
    expect(lantern.text).not.toBe(compass.text);
    expect(JSON.stringify(lantern.audit)).toContain("narrativeConditioning");
  });
});

describe("source-derived casing observations", () => {
  it("recovers short names and acronyms from attested interiors in any cased script", () => {
    const hints = sourceDerivedCasingHints(["За рекой Ю встречает РАН. Потом Ю видит РАН."]);
    expect(hints).toMatchObject({ "ю": "Ю", "ран": "РАН" });
    expect(hints).not.toHaveProperty("потом");
  });

  it("does not give one Latin token a built-in capitalization rule", () => {
    expect(sourceDerivedCasingHints(["x i y."])).not.toHaveProperty("i");
    const hints = sourceDerivedCasingHints(["x I y."]);
    expect(hints).toMatchObject({ i: "I" });
  });

  it("abstains on conflicting casing and ignores inherited object properties", () => {
    const hints = sourceDerivedCasingHints(["x Ю y. z ю w."]);
    expect(hints).not.toHaveProperty("ю");
    expect(Object.hasOwn(hints, "constructor")).toBe(false);
  });
});
