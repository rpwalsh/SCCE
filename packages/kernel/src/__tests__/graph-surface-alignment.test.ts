import { describe, expect, it } from "vitest";
import {
  createHasher,
  createLanguageInductionEngine,
  evaluateHeldOutConstructionCoverage,
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
    const preSurfaces = new Set(
      set.observations.flatMap(example => example.roleSpans.filter(span => span.roleId === "scce.role.pre_predicate").map(span => span.surface))
    );
    expect(preSurfaces.has("cat")).toBe(true);
    expect(preSurfaces.has("dog")).toBe(true);
  });

  it("anti-unifies aligned examples into one reusable construction and realizes an unseen pre-/post-predicate combination", () => {
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
    expect(construction.sequence.some(part => part.kind === "slot" && part.roleId === "scce.role.pre_predicate")).toBe(true);

    // Real generalization proof: every pre-predicate surface ever aligned for this
    // construction is a legitimate variant of its form class -- including
    // ones drawn from a *different* observation than the exemplar sequence
    // used to build the construction id, i.e. the construction generalizes
    // across the corpus rather than memorizing one sentence.
    const preFormClass = induction.formClasses.find(formClass => formClass.roleId === "scce.role.pre_predicate");
    expect(preFormClass).toBeDefined();
    const observedPreSurfaces = new Set(preFormClass!.variants.map(variant => variant.surface));
    expect(observedPreSurfaces.size).toBeGreaterThanOrEqual(2);

    const postFormClass = induction.formClasses.find(formClass =>
      formClass.roleId === GRAPH_SURFACE_ROLE_IDS.postPredicate
    );
    expect(postFormClass).toBeDefined();
    const chosenPre = preFormClass!.variants.find(variant => variant.surface === "dog");
    const chosenPost = postFormClass!.variants.find(variant => variant.surface === "ball");
    expect(chosenPre).toBeDefined();
    expect(chosenPost).toBeDefined();
    expect(text).not.toContain("dog chased ball");

    // Combine two individually learned fillers that never co-occurred in the
    // training corpus.
    const plan: SurfaceMeaningPlan = {
      id: "plan.unseen-combination",
      profileKey: "profile.univ",
      roleSignature: construction.roleSignature,
      slots: construction.roleOccurrences.map(occurrence => ({
        roleId: occurrence.roleId,
        occurrenceId: occurrence.occurrenceId,
        realization: occurrence.realization,
        variants: occurrence.realization === "spoken" && occurrence.roleId === "scce.role.pre_predicate"
          ? [{
            id: "variant.chosen-pre",
            profileKey: "profile.univ",
            surface: chosenPre!.surface,
            evidenceIds: chosenPre!.evidenceIds,
            formClassId: preFormClass!.id,
            provenance: chosenPre!.provenance
          }]
          : occurrence.realization === "spoken" && occurrence.roleId === GRAPH_SURFACE_ROLE_IDS.postPredicate
            ? [{
              id: "variant.chosen-post",
              profileKey: "profile.univ",
              surface: chosenPost!.surface,
              evidenceIds: chosenPost!.evidenceIds,
              formClassId: postFormClass!.id,
              provenance: chosenPost!.provenance
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

  it("measures real, honest held-out generalization -- covers a known pre-predicate filler, correctly misses an unknown one", () => {
    const trainText = [
      "cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball.",
      "cat chased mouse.", "dog chased ball.", "cat chased ball.", "dog chased mouse."
    ].join(" ");
    const trainDocuments = [{ id: "doc.train", text: trainText, evidenceIds: ["evidence:train" as never] }];
    // Held-out text was never seen by induction: one sentence reuses a
    // learned pre-predicate filler ("cat") and post-predicate filler
    // ("ball"); the other introduces a pre-predicate filler ("bird") that
    // training never observed for this predicate.
    const heldOutText = "cat chased ball. bird chased mouse.";
    const heldOutDocuments = [{ id: "doc.held-out", text: heldOutText, evidenceIds: ["evidence:held-out" as never] }];

    const reports = evaluateHeldOutConstructionCoverage({
      trainDocuments,
      heldOutDocuments,
      profileId: "profile.univ",
      hasher
    });

    expect(reports.length).toBeGreaterThan(0);
    const report = reports.find(row => row.predicate === "chased");
    expect(report).toBeDefined();
    expect(report!.trainedPrePredicateVariantCount).toBeGreaterThanOrEqual(2);
    expect(report!.heldOutOccurrences).toBe(2);
    // Real, partial coverage -- not fabricated as 100% or silently 0%.
    expect(report!.heldOutPrePredicateCovered).toBe(1);
    expect(report!.heldOutPostPredicateOccurrences).toBe(2);
    expect(report!.heldOutPostPredicateCovered).toBe(2);
  });

  it("does not fabricate a coverage report when no construction has any held-out occurrence", () => {
    const trainText = [
      "cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball.",
      "cat chased mouse.", "dog chased ball.", "cat chased ball.", "dog chased mouse."
    ].join(" ");
    const trainDocuments = [{ id: "doc.train", text: trainText, evidenceIds: ["evidence:train" as never] }];
    const heldOutDocuments = [{ id: "doc.unrelated", text: "alpha bravo charlie delta echo foxtrot.", evidenceIds: ["evidence:unrelated" as never] }];

    const reports = evaluateHeldOutConstructionCoverage({
      trainDocuments,
      heldOutDocuments,
      profileId: "profile.univ",
      hasher
    });

    expect(reports).toEqual([]);
  });
});
