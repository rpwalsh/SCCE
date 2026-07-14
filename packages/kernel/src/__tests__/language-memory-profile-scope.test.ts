import { describe, expect, it } from "vitest";
import {
  createLanguageMemoryRuntime,
  markLanguageMemoryStateUnscoped,
  scopeLanguageMemoryStateToCluster,
  scopeLanguageMemoryStateToProfile
} from "../language-memory-runtime.js";
import type { LanguageProfileCluster } from "../language.js";
import type { LanguagePatternRecord, LanguageUnitRecord, NgramModelRecord, NgramObservation, SemanticFrameRecord } from "../storage.js";
import type { LanguageProfile } from "../types.js";

describe("language-memory profile scope", () => {
  it("retains only surface material bound to the selected learned profile", () => {
    const selected = profile("profile.selected", "source.selected");
    const other = profile("profile.other", "source.other");
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrate({
      models: [],
      observations: [],
      units: [unit(selected, "unit.selected"), unit(other, "unit.other")],
      patterns: [pattern(selected, "pattern.selected"), pattern(other, "pattern.other")],
      semanticFrames: [
        frame("frame.profile", { profileId: selected.id, sourceVersionId: "source.unrelated" }),
        frame("frame.source", { sourceVersionId: selected.sourceVersionId }),
        frame("frame.other", { profileId: other.id, sourceVersionId: other.sourceVersionId }),
        frame("frame.unscoped", {})
      ]
    });

    const scoped = scopeLanguageMemoryStateToProfile(state, selected);

    expect(scoped.importedUnits.map(row => row.id)).toEqual(["unit.selected"]);
    expect(scoped.importedPatterns.map(row => row.id)).toEqual(["pattern.selected"]);
    expect(scoped.importedSemanticFrames.map(row => row.id)).toEqual(["frame.profile", "frame.source"]);
    expect(scoped.audit).toMatchObject({
      profileId: selected.id,
      purityProven: true,
      retained: { units: 1, patterns: 1, semanticFrames: 2 },
      rejected: { units: 1, patterns: 1, semanticFrames: 2 }
    });
  });

  it("scopes same-hint models and all surface records by cluster ownership", () => {
    const first = profile("profile.member-a", "source.member-a");
    const second = profile("profile.member-b", "source.member-b");
    const other = profile("profile.other-language", "source.other-language");
    const selected = cluster("cluster.selected", [first, second]);
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrate({
      models: [model(first, "model.a"), model(second, "model.b"), model(other, "model.other")],
      observations: [observation(first, "observation.a"), observation(second, "observation.b"), observation(other, "observation.other")],
      units: [
        { ...unit(first, "unit.a"), script: "script:Zxxx" },
        { ...unit(second, "unit.b"), script: "script:Hang" },
        unit(other, "unit.other")
      ],
      patterns: [pattern(first, "pattern.a"), pattern(second, "pattern.b"), pattern(other, "pattern.other")],
      semanticFrames: [
        frame("frame.explicit-member", { profileId: first.id, sourceVersionId: "source.unrelated" }),
        frame("frame.source-fallback", { sourceVersionId: second.sourceVersionId }),
        frame("frame.explicit-other", { profileId: other.id, sourceVersionId: first.sourceVersionId }),
        frame("frame.unowned", {})
      ]
    });

    const scoped = scopeLanguageMemoryStateToCluster(state, selected);

    expect(scoped.records.map(row => row.id)).toEqual(["model.a", "model.b"]);
    expect(scoped.importedObservations.map(row => row.id).sort()).toEqual(["observation.a", "observation.b"]);
    expect(scoped.importedUnits.map(row => row.id).sort()).toEqual(["unit.a", "unit.b"]);
    expect(scoped.importedPatterns.map(row => row.id).sort()).toEqual(["pattern.a", "pattern.b"]);
    expect(scoped.importedSemanticFrames.map(row => row.id).sort()).toEqual(["frame.explicit-member", "frame.source-fallback"]);
    expect(scoped.scope).toMatchObject({
      mode: "cluster",
      clusterId: selected.id,
      profileIds: [first.id, second.id],
      sourceVersionIds: [first.sourceVersionId, second.sourceVersionId],
      purityProven: true,
      degraded: false
    });
    expect(scoped.audit).toMatchObject({
      purityProven: true,
      retained: { modelRecords: 2, observations: 2, units: 2, patterns: 2, semanticFrames: 2 },
      rejected: { modelRecords: 1, observations: 1, units: 1, patterns: 1, semanticFrames: 2 }
    });
  });

  it("keeps no-match generation empty instead of mixing available profiles", () => {
    const learned = profile("profile.learned", "source.learned");
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrate({ models: [], units: [unit(learned, "unit.learned")], patterns: [], observations: [], semanticFrames: [] });
    const unscoped = markLanguageMemoryStateUnscoped(state, "surface-ambiguous-or-no-signal");
    const synthetic = profile("surface-und", "source.synthetic");

    const generated = runtime.generate({
      state: unscoped,
      targetLanguageProfile: synthetic,
      requiredTerms: [{ id: "term.learned", text: "unit.learned" }],
      generationExtent: 24
    });

    expect(unscoped.importedUnits).toEqual([]);
    expect(unscoped.scope).toMatchObject({ mode: "unscoped", purityProven: false, degraded: true, reason: "surface-ambiguous-or-no-signal" });
    expect(generated.importedLanguageUnitIdsUsed).not.toContain("unit.learned");
  });

  it("can switch the same hydrated state from a source cluster to a translation target cluster", () => {
    const source = profile("profile.source", "source.source");
    const target = profile("profile.target", "source.target");
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrate({
      models: [model(source, "model.source"), model(target, "model.target")],
      observations: [observation(source, "observation.source"), observation(target, "observation.target")],
      units: [unit(source, "unit.source"), unit(target, "unit.target")],
      patterns: [pattern(source, "pattern.source"), pattern(target, "pattern.target")],
      semanticFrames: [
        frame("frame.source", { profileId: source.id, sourceVersionId: source.sourceVersionId }),
        frame("frame.target", { profileId: target.id, sourceVersionId: target.sourceVersionId })
      ]
    });

    const targetState = scopeLanguageMemoryStateToCluster(state, cluster("cluster.target", [target]));

    expect(targetState.records.map(row => row.id)).toEqual(["model.target"]);
    expect(targetState.importedUnits.map(row => row.id)).toEqual(["unit.target"]);
    expect(targetState.importedSemanticFrames.map(row => row.id)).toEqual(["frame.target"]);
    expect(targetState.scope.clusterId).toBe("cluster.target");
  });

  it("gives explicit n-gram profile ownership precedence over a shared source version", () => {
    const selected = profile("profile.selected", "source.shared");
    const other = profile("profile.other", "source.shared");
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrate({
      models: [model(selected, "model.selected"), model(other, "model.other")],
      observations: [observation(selected, "observation.selected"), observation(other, "observation.other")]
    });

    const scoped = scopeLanguageMemoryStateToCluster(state, cluster("cluster.selected", [selected]));

    expect(scoped.records.map(row => row.id)).toEqual(["model.selected"]);
    expect(scoped.importedObservations.map(row => row.id)).toEqual(["observation.selected"]);
  });
});

function profile(id: string, sourceVersionId: string): LanguageProfile {
  return {
    id,
    sourceVersionId: sourceVersionId as never,
    scripts: [{ script: "script.opaque", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "unknown",
    entropy: 0,
    createdAt: 1
  };
}

function unit(profileValue: LanguageProfile, id: string): LanguageUnitRecord {
  return {
    id,
    profileId: profileValue.id,
    sourceVersionId: profileValue.sourceVersionId,
    script: "script.opaque",
    unitKind: "phrase",
    text: id,
    features: [],
    competenceVector: [],
    alpha: 1,
    evidenceIds: [`evidence.${id}` as never],
    metadata: null
  };
}

function pattern(profileValue: LanguageProfile, id: string): LanguagePatternRecord {
  return {
    id,
    profileId: profileValue.id,
    patternKind: "syntax",
    support: 1,
    entropy: 0,
    patternJson: null,
    evidenceIds: [`evidence.${id}` as never],
    updatedAt: 1
  };
}

function frame(id: string, frameJson: Record<string, string>): SemanticFrameRecord {
  return {
    id,
    frameJson,
    embedding: [],
    evidenceIds: [`evidence.${id}` as never],
    alpha: 1,
    createdAt: 1
  };
}

function cluster(id: string, members: LanguageProfile[]): LanguageProfileCluster {
  return {
    id,
    members,
    profileIds: members.map(member => member.id).sort(),
    sourceVersionIds: members.map(member => member.sourceVersionId).sort(),
    discoveredNames: [],
    scripts: [{ script: "script.opaque", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "unknown",
    artifactSupport: members.length
  };
}

function model(profileValue: LanguageProfile, id: string): NgramModelRecord {
  return {
    id,
    streamId: "stream.shared",
    languageHint: "script:script.opaque;direction:unknown",
    maxOrder: 1,
    discount: 0.75,
    modelJson: {
      sourceVersionId: profileValue.sourceVersionId,
      profileId: profileValue.id,
      model: {
        order: 1,
        discount: 0.75,
        observedSymbolCount: 1,
        vocabularySize: 1,
        counts: { [id]: 1 },
        contextCounts: {},
        continuationCounts: {},
        contextContinuationTypes: {},
        totalContinuationTypes: 0,
        unigramCounts: { [id]: 1 },
        totalUnigramCount: 1,
        vocabulary: [id]
      }
    },
    updatedAt: 1
  };
}

function observation(profileValue: LanguageProfile, id: string): NgramObservation {
  return {
    id,
    streamId: "stream.shared",
    languageHint: "script:script.opaque;direction:unknown",
    order: 1,
    history: [],
    symbol: id,
    count: 1,
    fieldWeight: 1,
    sourceVersionId: profileValue.sourceVersionId,
    observedAt: 1,
    metadata: { profileId: profileValue.id }
  };
}
