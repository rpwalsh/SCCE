import { describe, expect, it } from "vitest";
import {
  realizeEnglishStructuralCreative,
  type EnglishStructuralPlannedEvent
} from "../english-structural-realizer.js";
import {
  CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
  ENGLISH_CREATIVE_EVENT_COMPILER_ID,
  type DurableCreativeEventConstruction
} from "../language-construction-memory.js";
import type { ActivatedResponseForm, ResponseFormSurfaceLayout } from "../turn-requirements.js";

describe("English structural response-form layout", () => {
  it("applies an opaque upstream form profile without changing selected semantic events", () => {
    const baseline = realizeEnglishStructuralCreative(fixtureInput());
    const ordered = realizeEnglishStructuralCreative(fixtureInput({
      sentencesPerBlock: 1,
      orderedBlocks: true
    }));
    const lineated = realizeEnglishStructuralCreative(fixtureInput({
      sentencesPerBlock: 4,
      wordsPerLine: 8
    }));

    expect(baseline).toBeDefined();
    expect(ordered?.text).toMatch(/^1\. /u);
    expect(ordered?.text).toContain("\n\n2. ");
    expect(lineated?.text.split("\n").some(line => line.trim().split(/\s+/u).length <= 8)).toBe(true);
    expect(ordered?.transformations.map(row => row.sourceEventId))
      .toEqual(baseline?.transformations.map(row => row.sourceEventId));
    expect(lineated?.transformations.map(row => row.sourceEventId))
      .toEqual(baseline?.transformations.map(row => row.sourceEventId));
    const audit = ordered?.audit as Record<string, unknown>;
    expect(audit.responseForm).toMatchObject({
      id: "response.form.fixture.731.v1",
      selectedUpstream: true,
      semanticEventSelectionChanged: false
    });
  });

  it("uses only the learned layout vector rather than assigning semantics to the opaque ID", () => {
    const cue = realizeEnglishStructuralCreative(fixtureInput({
      sentencesPerBlock: 2,
      subjectCuePerBlock: true
    }));
    const signature = realizeEnglishStructuralCreative(fixtureInput({
      sentencesPerBlock: 4,
      subjectSignature: true
    }));

    expect(cue?.text).toMatch(/^THE SCIENTIST\n/u);
    expect(signature?.text).toMatch(/— the scientist$/u);
    expect(cue?.transformations.map(row => row.sourceEventId))
      .toEqual(signature?.transformations.map(row => row.sourceEventId));
  });

  it("preserves learned absolute extent coefficients above the unit interval", () => {
    const requestText = "Write a 20 page short story about a scientist fighting dragons.";
    const pageStart = [...requestText.slice(0, requestText.indexOf("page"))].length;
    const realized = realizeEnglishStructuralCreative({
      ...fixtureInput(),
      requestText,
      responseExtentHints: [{
        unitSurface: "page",
        wordsPerUnit: 250,
        requestSpan: {
          charStart: pageStart,
          charEnd: pageStart + [..."page"].length
        },
        sourcePatternId: "pattern.fixture.page_extent"
      }]
    });

    expect(realized).toBeDefined();
    expect(realized?.audit).toMatchObject({
      extent: {
        targetWords: 5_000,
        learnedHintPatternIds: ["pattern.fixture.page_extent"]
      }
    });
  });

  it("binds full imperative artifact and operating-context spans without topic rules", () => {
    const requestText = "Invent a new kind of clock for a city under the ocean.";
    const realized = realizeEnglishStructuralCreative({
      requestText,
      contentTerms: ["new", "kind", "clock", "city", "ocean"],
      plannedEvents: fixtureEvents(true),
      defaultTargetWords: 120
    });

    expect(realized).toBeDefined();
    expect(realized?.protagonist).toBe("new kind of clock");
    expect(realized?.antagonist).toBe("city under the ocean");
    expect(realized?.text).toContain("new kind of clock");
    expect(realized?.text).toContain("city under the ocean");
  });
});

function fixtureInput(surfaceLayout?: ResponseFormSurfaceLayout) {
  return {
    requestText: "Write a story about a scientist fighting dragons.",
    contentTerms: ["scientist", "fighting", "dragons"],
    plannedEvents: fixtureEvents(),
    ...(surfaceLayout ? { responseForm: responseForm(surfaceLayout) } : {}),
    defaultTargetWords: 120
  };
}

function responseForm(surfaceLayout: ResponseFormSurfaceLayout): ActivatedResponseForm {
  return {
    id: "response.form.fixture.731.v1",
    activation: 0.9,
    posterior: 0.84,
    selectionMargin: 0.62,
    exampleSupport: 6,
    sourceActivationIds: ["pattern.fixture.response.1"],
    surfaceLayout,
    trace: {}
  };
}

function fixtureEvents(bindRequestContext = false): EnglishStructuralPlannedEvent[] {
  const verbs = [
    ["search", "searched"],
    ["cross", "crossed"],
    ["challenge", "challenged"],
    ["guard", "guarded"],
    ["discover", "discovered"],
    ["escape", "escaped"],
    ["follow", "followed"],
    ["return", "returned"]
  ] as const;
  return verbs.map(([infinitive, past], outputIndex) => ({
    outputIndex,
    bundleId: "bundle.fixture",
    event: fixtureEvent(outputIndex, infinitive, past, bindRequestContext),
    discourseRelationId: "scce.relation.subsequent",
    discourseBeatId: "beat.fixture",
    requestRoleBindings: bindRequestContext
      ? [{
        eventRoleId: "scce.role.patient" as const,
        requestRoleId: "scce.request.role.antagonist" as const,
        admissible: true as const
      }]
      : [],
    requestFit: 0.9
  }));
}

function fixtureEvent(
  sourceOrdinal: number,
  infinitive: string,
  past: string,
  withPatient = false
): DurableCreativeEventConstruction {
  return {
    id: `event.fixture.${sourceOrdinal}`,
    compilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
    constructionId: `construction.fixture.${sourceOrdinal}`,
    profileId: "profile.fixture.en",
    sourceVersionId: "source-version.fixture",
    evidenceId: "evidence.fixture",
    evidenceContentHash: "hash.fixture",
    evidenceCharStart: sourceOrdinal * 10,
    evidenceCharEnd: sourceOrdinal * 10 + 5,
    labelStartCodePoint: sourceOrdinal * 10,
    labelEndCodePoint: sourceOrdinal * 10 + 5,
    sourceOrdinal,
    relationId: `relation.fixture.${sourceOrdinal}`,
    sourceLabel: infinitive,
    sourceLabelDigest: `digest.fixture.${sourceOrdinal}`,
    tenseId: "scce.tense.past",
    valencyId: withPatient ? "scce.valency.agent_patient" : "scce.valency.agent",
    roleIds: withPatient
      ? ["scce.role.agent", "scce.role.patient"]
      : ["scce.role.agent"],
    argumentFrame: {
      id: `frame.fixture.${sourceOrdinal}`,
      schema: CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
      compilerId: ENGLISH_CREATIVE_EVENT_COMPILER_ID,
      sourceSentenceStartCodePoint: sourceOrdinal * 10,
      sourceSentenceEndCodePoint: sourceOrdinal * 10 + 5,
      roleIds: withPatient
        ? ["scce.role.agent", "scce.role.patient"]
        : ["scce.role.agent"],
      bindings: withPatient
        ? [{
          roleId: "scce.role.patient",
          surface: "fixture object",
          surfaceDigest: `digest.fixture.patient.${sourceOrdinal}`,
          startCodePoint: sourceOrdinal * 10 + 1,
          endCodePoint: sourceOrdinal * 10 + 3
        }]
        : []
    },
    forms: {
      infinitive,
      past,
      present: infinitive,
      gerund: `${infinitive}ing`,
      participle: past
    }
  };
}
