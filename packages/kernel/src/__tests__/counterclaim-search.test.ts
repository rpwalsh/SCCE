import { describe, expect, it } from "vitest";
import { compileCounterclaimSearchIntent, counterclaimSurfaceViolationIds, realizeCounterclaimSearchIntent } from "../counterclaim-search.js";
import { languageGenerationFramesFromCounterclaimIntent } from "../semantic-realization-frames.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { realizeCounterclaimWithInducedPolarityConstruction } from "../counterclaim-polarity-construction.js";
import { createSemanticProofSystem } from "../semantic-proof-system.js";
import { toJsonValue } from "../primitives.js";
import type { SemanticProofResult } from "../semantic-proof-system.js";
import type { SemanticAtom } from "../semantic-proof-types.js";
import type { LanguageProfile, SourceVersionId } from "../types.js";

const proofSystem = createSemanticProofSystem();
function proof(claims: SemanticAtom[]): Pick<SemanticProofResult, "claimAtoms" | "counterexamples" | "evidenceAtoms" | "graphAtoms"> {
  return { claimAtoms: claims, counterexamples: [], evidenceAtoms: [], graphAtoms: [] };
}

describe("typed counterclaim search intent", () => {
  it("flips only polarity and preserves opaque predicate/role bindings without reparsing a request", () => {
    const atom = proofSystem.atomizeClaim("α β γ")[0]!;
    atom.id = "原子.甲";
    atom.predicate = "关系.乙";
    atom.roles = [
      { ...atom.roles[0]!, name: "角色.丙", value: "α", normalized: "α" },
      { ...atom.roles[0]!, name: "角色.丁", value: "γ", normalized: "γ" }
    ];
    const intent = compileCounterclaimSearchIntent({ proof: proof([atom]) })!;
    expect(intent.targetPolarity).toBe(-1);
    expect(intent.predicate).toBe(atom.predicate);
    expect(intent.roles).toEqual(atom.roles);
    expect(atom.polarity).toBe(1);
    const frame = languageGenerationFramesFromCounterclaimIntent(intent, { targetLanguage: "语言.戊", targetScript: "script:Grek" })[0]!;
    expect(frame.realizationConstraints).toMatchObject({ predicate: "关系.乙", requiredPolarity: -1, roles: toJsonValue(atom.roles) });
    expect(frame.targetLanguage).toBe("语言.戊");
    const lexical = JSON.stringify({ terms: frame.requiredTerms?.map(term => term.text), atoms: frame.propositionAtoms?.map(term => term.text) });
    for (const id of ["原子.甲", "关系.乙", "角色.丙", "角色.丁"]) expect(lexical).not.toContain(id);
  });

  it("prioritizes an existing counterexample's claim and accepts only structurally opposing seed material", () => {
    const claims = proofSystem.atomizeClaim("α β γ");
    const unrelated = { ...claims[0]!, id: "atom.other", predicate: "δ", alpha: 1 };
    const opposing = proofSystem.atomizeClaim("!α β γ")[0]!;
    const input = proof([unrelated, claims[0]!]);
    input.evidenceAtoms.push(opposing);
    input.counterexamples.push({ id: "反例.己", claimAtomId: claims[0]!.id, evidenceAtomId: opposing.id, contradiction: 0.9, reason: "typed", evidenceIds: [] });
    const intent = compileCounterclaimSearchIntent({ proof: input })!;
    expect(intent.claimAtomId).toBe(claims[0]!.id);
    expect(intent.counterexampleIds).toEqual(["反例.己"]);
    expect(intent.opposingSourceSurfaces).toEqual(["!α β γ"]);
  });

  it("requires independently interpreted opposite polarity, exact role/predicate shape, and a distinct query", () => {
    const intent = compileCounterclaimSearchIntent({ proof: proof(proofSystem.atomizeClaim("α β γ")) })!;
    const check = (surface: string) => counterclaimSurfaceViolationIds({ intent, surface, originalQuerySurface: "α β γ", interpretedAtoms: proofSystem.atomizeClaim(surface) });
    expect(check("!α β γ")).toEqual([]);
    expect(check("α β γ")).toContain("counterclaim.query_echo");
    expect(check("α β γ")).toContain("counterclaim.polarity_not_preserved");
    expect(check("!δ β γ")).toContain("counterclaim.predicate_roles_or_constraints_changed");
    expect(check("!α γ β")).toContain("counterclaim.predicate_roles_or_constraints_changed");
    expect(check("!α β γ. !δ ε ζ.")).toContain("counterclaim.predicate_roles_or_constraints_changed");
  });

  it("does not treat English negation words as a learned polarity capability", () => {
    const intent = compileCounterclaimSearchIntent({ proof: proof(proofSystem.atomizeClaim("α β γ")) })!;
    const surface = "α not β γ";
    expect(counterclaimSurfaceViolationIds({ intent, surface, originalQuerySurface: "α β γ", interpretedAtoms: proofSystem.atomizeClaim(surface) }))
      .toContain("counterclaim.polarity_not_preserved");
  });
});

describe("learned counterclaim realization", () => {
  const profile: LanguageProfile = {
    id: "profile.opaque", sourceVersionId: "source.opaque" as SourceVersionId,
    scripts: [{ script: "script:Grek", mass: 1 }], symbolShapes: [], charNgrams: [], direction: "ltr", entropy: 1, createdAt: 1
  };

  it("selects a learned symbolic counterclaim through constrained language realization", () => {
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrateFromImportedBrain({
      importRunId: "import.negative", models: [], observations: [], patterns: [], semanticFrames: [],
      units: [{ id: "unit.negative", profileId: profile.id, sourceVersionId: profile.sourceVersionId, script: "script:Grek", unitKind: "phrase", text: "!α β γ δ ε ζ.", features: [], competenceVector: [], alpha: 1, evidenceIds: [], metadata: {} }]
    });
    const attempt = realizeCounterclaimSearchIntent({
      intent: compileCounterclaimSearchIntent({ proof: proof(proofSystem.atomizeClaim("α β γ δ ε ζ.")) }),
      originalQuerySurface: "α β γ δ ε ζ.", languageMemory: runtime, state, targetLanguageProfile: profile,
      targetLanguageId: "language.opaque", interpretSurface: surface => proofSystem.atomizeClaim(surface)
    });
    expect(attempt.request?.searchKind).toBe("counterclaim");
    expect(attempt.request?.querySurface.startsWith("!")).toBe(true);
    expect(attempt.audit).toMatchObject({
      accepted: true,
      oppositePolarityPreserved: true,
      realizationMode: "source_bound_counterclaim_surface",
      sourceKind: "language_unit",
      importedIds: ["unit.negative"]
    });
  });

  it("selects an independently learned profile-owned construction when units are unavailable", () => {
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrateFromImportedBrain({
      importRunId: "import.frame-negative", models: [], observations: [], patterns: [], units: [],
      semanticFrames: [{
        id: "frame.negative", alpha: 0.9, embedding: [], evidenceIds: [], createdAt: 1,
        frameJson: { profileId: profile.id, surface: "!α β γ" }
      }]
    });
    const attempt = realizeCounterclaimSearchIntent({
      intent: compileCounterclaimSearchIntent({ proof: proof(proofSystem.atomizeClaim("α β γ")) }),
      originalQuerySurface: "α β γ", languageMemory: runtime, state, targetLanguageProfile: profile,
      targetLanguageId: "language.opaque", interpretSurface: surface => proofSystem.atomizeClaim(surface)
    });
    expect(attempt.request?.searchKind).toBe("counterclaim");
    expect(attempt.request?.querySurface.startsWith("!")).toBe(true);
    expect(attempt.audit).toMatchObject({ accepted: true, sourceKind: "semantic_frame", importedIds: ["frame.negative"] });
  });

  it("fails closed when the active language can only realize the original positive claim", () => {
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrateFromImportedBrain({
      importRunId: "import.opaque", models: [], observations: [], patterns: [], semanticFrames: [],
      units: [{ id: "unit.opaque", profileId: profile.id, sourceVersionId: profile.sourceVersionId, script: "script:Grek", unitKind: "phrase", text: "α β γ", features: [], competenceVector: [], alpha: 1, evidenceIds: [], metadata: {} }]
    });
    const attempt = realizeCounterclaimSearchIntent({
      intent: compileCounterclaimSearchIntent({ proof: proof(proofSystem.atomizeClaim("α β γ")) }),
      originalQuerySurface: "α β γ", languageMemory: runtime, state, targetLanguageProfile: profile,
      targetLanguageId: "language.opaque", interpretSurface: surface => proofSystem.atomizeClaim(surface)
    });
    expect(attempt.request).toBeUndefined();
    expect(attempt.audit).toMatchObject({ accepted: false });
    expect(JSON.stringify(attempt.audit)).not.toContain("α β γ");
  });

  it("does not search without typed claims or an active learned target language", () => {
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrateFromImportedBrain({ importRunId: "empty", models: [], observations: [], patterns: [], semanticFrames: [], units: [] });
    const input = { originalQuerySurface: "α β γ", languageMemory: runtime, state, targetLanguageProfile: profile, interpretSurface: (surface: string) => proofSystem.atomizeClaim(surface) };
    expect(realizeCounterclaimSearchIntent(input).audit).toMatchObject({ reasonIds: ["counterclaim.no_typed_claim"] });
    expect(realizeCounterclaimSearchIntent({ ...input, intent: compileCounterclaimSearchIntent({ proof: proof(proofSystem.atomizeClaim("α β γ")) }) }).audit)
      .toMatchObject({ reasonIds: ["counterclaim.learned_language_unavailable"] });
  });

  it("induces a profile-scoped opaque polarity construction and transfers it to a new role value", () => {
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrateFromImportedBrain({
      importRunId: "import.pair-transfer", models: [], observations: [], patterns: [], semanticFrames: [],
      units: [
        { id: "unit.pair.positive", profileId: profile.id, sourceVersionId: profile.sourceVersionId, script: "script:Grek", unitKind: "phrase", text: "α β γ", features: [], competenceVector: [], alpha: 1, evidenceIds: [], metadata: {} },
        { id: "unit.pair.negative", profileId: profile.id, sourceVersionId: profile.sourceVersionId, script: "script:Grek", unitKind: "phrase", text: "!α β γ", features: [], competenceVector: [], alpha: 1, evidenceIds: [], metadata: {} }
      ]
    });
    const intent = compileCounterclaimSearchIntent({ proof: proof(proofSystem.atomizeClaim("α δεζη γ")) })!;
    const constructed = realizeCounterclaimWithInducedPolarityConstruction({
      state,
      profileId: profile.id,
      intent,
      interpretSurface: surface => proofSystem.atomizeClaim(surface)
    });
    expect(constructed.audit).toMatchObject({ accepted: true });
    expect(constructed.surface).toBe("!α δεζη γ");
    expect(constructed.audit).toMatchObject({
      accepted: true,
      sourceIds: ["unit.pair.positive", "unit.pair.negative"],
      operationKinds: ["insert", "copy"]
    });
    const attempt = realizeCounterclaimSearchIntent({
      intent,
      originalQuerySurface: "α δεζη γ",
      languageMemory: runtime,
      state,
      targetLanguageProfile: profile,
      targetLanguageId: "language.opaque",
      interpretSurface: surface => proofSystem.atomizeClaim(surface)
    });
    expect(attempt.request?.querySurface).toBe("!α δεζη γ");
    expect(attempt.audit).toMatchObject({ accepted: true, realizationMode: "induced_source_polarity_construction" });
  });

  it("fails closed when no source-derived positive/negative pair exists for the active profile", () => {
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrateFromImportedBrain({
      importRunId: "import.unpaired", models: [], observations: [], patterns: [], semanticFrames: [],
      units: [{ id: "unit.only-positive", profileId: profile.id, sourceVersionId: profile.sourceVersionId, script: "script:Grek", unitKind: "phrase", text: "α β γ", features: [], competenceVector: [], alpha: 1, evidenceIds: [], metadata: {} }]
    });
    const intent = compileCounterclaimSearchIntent({ proof: proof(proofSystem.atomizeClaim("δ β γ")) })!;
    const constructed = realizeCounterclaimWithInducedPolarityConstruction({
      state,
      profileId: profile.id,
      intent,
      interpretSurface: surface => proofSystem.atomizeClaim(surface)
    });
    expect(constructed.surface).toBeUndefined();
    expect(constructed.audit).toMatchObject({ accepted: false, reasonIds: ["counterclaim.no_profile_scoped_polarity_construction"] });
  });
});
