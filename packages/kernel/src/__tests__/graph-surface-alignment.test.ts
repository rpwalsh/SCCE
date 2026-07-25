import { describe, expect, it } from "vitest";
import {
  createHasher,
  createLanguageInductionEngine,
  GRAPH_SURFACE_ROLE_IDS,
  induceGraphSurfaceAlignments,
  induceLearnedConstructions,
  realizeLearnedSurface,
  type SurfaceMeaningPlan
} from "../index.js";

describe("graph-surface alignment -> anti-unification -> realization (first JGSCI module)", () => {
  const hasher = createHasher();

  it("aligns real corpus occurrences into AlignedSurfaceExamples with correct evidence-traced spans", () => {
    const text = [
      "cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball.",
      "cat chased mouse.", "dog chased ball.", "cat chased ball.", "dog chased mouse."
    ].join(" ");
    const documents = [{ id: "doc.1", text, evidenceIds: ["evidence:doc.1" as never] }];
    const model = createLanguageInductionEngine({ hasher }).induce({ documents });

    const alignments = induceGraphSurfaceAlignments({
      documents,
      constructions: model.graphBoundConstructions,
      profileId: "profile.univ",
      hasher
    });

    expect(alignments.length).toBeGreaterThan(0);
    const set = alignments[0]!;
    expect(set.observations.length).toBeGreaterThanOrEqual(2);
    for (const example of set.observations) {
      expect(example.evidenceIds).toEqual(["evidence:doc.1"]);
      for (const span of example.roleSpans) {
        expect(example.surface.slice(span.start, span.end)).toBe(span.surface);
        expect(span.evidenceIds).toEqual(["evidence:doc.1"]);
      }
    }
    // Real pre-predicate fillers observed across the aligned examples.
    const beforePredicateSurfaces = new Set(
      set.observations.flatMap(example => example.roleSpans.filter(span => span.roleId === GRAPH_SURFACE_ROLE_IDS.beforePredicate).map(span => span.surface))
    );
    expect(beforePredicateSurfaces.has("cat")).toBe(true);
    expect(beforePredicateSurfaces.has("dog")).toBe(true);
  });

  it("anti-unifies aligned examples into one reusable construction and realizes an unseen agent/patient combination", () => {
    const text = [
      "cat chased mouse.", "dog chased mouse.", "cat chased ball.",
      "cat chased mouse.", "cat chased ball.", "dog chased mouse."
    ].join(" ");
    const documents = [{ id: "doc.1", text, evidenceIds: ["evidence:doc.1" as never] }];
    const model = createLanguageInductionEngine({ hasher }).induce({ documents });
    const alignments = induceGraphSurfaceAlignments({
      documents,
      constructions: model.graphBoundConstructions,
      profileId: "profile.univ",
      hasher
    });
    const set = alignments.find(row => row.observations.length >= 2);
    expect(set).toBeDefined();

    const induction = induceLearnedConstructions({ examples: set!.observations, hasher });
    expect(induction.rejected).toEqual([]);
    expect(induction.constructions.length).toBeGreaterThan(0);
    const construction = induction.constructions[0]!;
    expect(construction.sequence.some(part => part.kind === "slot" && part.roleId === GRAPH_SURFACE_ROLE_IDS.beforePredicate)).toBe(true);

    // Real generalization proof: every agent surface ever aligned for this
    // construction is a legitimate variant of its form class -- including
    // ones drawn from a *different* observation than the exemplar sequence
    // used to build the construction id, i.e. the construction generalizes
    // across the corpus rather than memorizing one sentence.
    const agentFormClass = induction.formClasses.find(formClass => formClass.roleId === GRAPH_SURFACE_ROLE_IDS.beforePredicate);
    expect(agentFormClass).toBeDefined();
    const observedAgentSurfaces = new Set(agentFormClass!.variants.map(variant => variant.surface));
    expect(observedAgentSurfaces.size).toBeGreaterThanOrEqual(2);

    const patientFormClass = induction.formClasses.find(formClass => formClass.roleId === GRAPH_SURFACE_ROLE_IDS.afterPredicate);
    expect(patientFormClass).toBeDefined();
    const chosenAgent = agentFormClass!.variants.find(variant => variant.surface === "dog");
    const chosenPatient = patientFormClass!.variants.find(variant => variant.surface === "ball");
    expect(chosenAgent).toBeDefined();
    expect(chosenPatient).toBeDefined();
    expect(text).not.toContain("dog chased ball");

    // Deliberately combine an agent and patient that were each learned but
    // never co-occurred in the corpus.
    const plan: SurfaceMeaningPlan = {
      id: "plan.unseen-combination",
      profileKey: "profile.univ",
      roleSignature: construction.roleSignature,
      slots: construction.roleOccurrences.map(occurrence => ({
        roleId: occurrence.roleId,
        occurrenceId: occurrence.occurrenceId,
        realization: occurrence.realization,
        variants: occurrence.realization === "spoken" && occurrence.roleId === GRAPH_SURFACE_ROLE_IDS.beforePredicate
          ? [{
            id: "variant.chosen-agent",
            profileKey: "profile.univ",
            surface: chosenAgent!.surface,
            evidenceIds: chosenAgent!.evidenceIds,
            formClassId: agentFormClass!.id,
            provenance: chosenAgent!.provenance
          }]
          : occurrence.realization === "spoken" && occurrence.roleId === GRAPH_SURFACE_ROLE_IDS.afterPredicate
            ? [{
              id: "variant.chosen-patient",
              profileKey: "profile.univ",
              surface: chosenPatient!.surface,
              evidenceIds: chosenPatient!.evidenceIds,
              formClassId: patientFormClass!.id,
              provenance: chosenPatient!.provenance
            }]
          : occurrence.realization === "spoken"
            ? (() => {
              const formClass = induction.formClasses
                .find(item => item.roleId === occurrence.roleId && item.occurrenceId === occurrence.occurrenceId)!;
              return formClass.variants.slice(0, 1).map(variant => ({
                id: `variant.${occurrence.roleId}`,
                profileKey: "profile.univ",
                surface: variant.surface,
                evidenceIds: variant.evidenceIds,
                formClassId: formClass.id,
                provenance: variant.provenance
              }));
            })()
            : []
      }))
    };
    const realized = realizeLearnedSurface({
      plan,
      constructions: [construction],
      formClasses: induction.formClasses,
      hasher
    });
    expect(realized.status).toBe("realized");
    if (realized.status !== "realized") return;
    // The realized surface is driven by the learned construction's literal
    // frame plus the chosen learned slot filler -- not a copy of any single
    // source sentence.
    expect(realized.realization.text).toBe("dog chased ball");
  });

  it("does not fabricate an alignment set when fewer than two real occurrences exist for a construction", () => {
    const text = "alpha bravo charlie delta echo foxtrot golf hotel.";
    const documents = [{ id: "doc.sparse", text, evidenceIds: ["evidence:sparse" as never] }];
    const model = createLanguageInductionEngine({ hasher }).induce({ documents });

    const alignments = induceGraphSurfaceAlignments({
      documents,
      constructions: model.graphBoundConstructions,
      profileId: "profile.sparse",
      hasher
    });

    expect(alignments).toEqual([]);
  });

  it("skips documents with no evidence ids rather than fabricating unattributed alignments", () => {
    const text = [
      "cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball."
    ].join(" ");
    const documents = [{ id: "doc.no-evidence", text }];
    const model = createLanguageInductionEngine({ hasher }).induce({ documents });

    const alignments = induceGraphSurfaceAlignments({
      documents,
      constructions: model.graphBoundConstructions,
      profileId: "profile.univ",
      hasher
    });

    expect(alignments).toEqual([]);
  });
});
