import { describe, expect, it } from "vitest";
import {
  buildLanguageProfileClusters,
  createLanguageAcquisitionEngine,
  languageProfileClusterCacheKey,
  languageHintFromProfile,
  selectLanguageProfileClusterForSurface,
  rankLanguageProfilesForSurface,
  selectLanguageProfileForSurface
} from "../language.js";
import { createIdFactory } from "../ids.js";
import { createClock, createHasher } from "../primitives.js";
import type { LanguageProfile } from "../types.js";

describe("learned language-profile surface selection", () => {
  it("selects between profiles whose scripts are both unknown to the runtime", () => {
    const left = profile("profile.left", "აბგდევზთიკლმნოპჟრსტუფქღყშჩცძწჭხჯჰ");
    const right = profile("profile.right", "ᎠᎡᎢᎣᎤᎥᎦᎧᎨᎩᎪᎫᎬᎭᎮᎯᎰᎱᎲᎳ");

    expect(selectLanguageProfileForSurface([right, left], "დევზთიკლ")).toBe(left);
    expect(selectLanguageProfileForSurface([left, right], "ᎨᎩᎪᎫᎬ")).toBe(right);
  });

  it("uses learned trigrams to separate profiles that share a script label", () => {
    const first = profile("profile.first", "qelari venatu qelari venatu", "script.shared");
    const second = profile("profile.second", "zomiku pafedo zomiku pafedo", "script.shared");
    const ranked = rankLanguageProfilesForSurface([second, first], "qelari vena");

    expect(ranked.map(row => row.profile.id)).toEqual([first.id, second.id]);
    expect(ranked[0]!.trigramCoverage).toBeGreaterThan(ranked[1]!.trigramCoverage);
  });

  it("is deterministic and derives storage hints from the selected learned profile", () => {
    const later = profile("profile.z", "miran solak miran solak", "script.opaque", "rtl");
    const earlier = profile("profile.a", "miran solak miran solak", "script.opaque", "rtl");

    expect(selectLanguageProfileForSurface([later, earlier], "miran solak")?.id).toBe(earlier.id);
    expect(languageHintFromProfile(earlier)).toBe("script:script.opaque;direction:rtl");
  });

  it("clusters compatible document profiles without merging a different same-script distribution", () => {
    const firstDocument = profile("profile.doc-a", "qelari venatu torim qelari venatu", "script.shared", "ltr");
    const secondDocument = profile("profile.doc-b", "qelari venatu saven qelari venatu", "script.shared", "ltr");
    const otherLanguage = profile("profile.other", "zomiku pafedo lurin zomiku pafedo", "script.shared", "ltr");
    const clusters = buildLanguageProfileClusters([otherLanguage, secondDocument, firstDocument]);
    const selected = selectLanguageProfileClusterForSurface(clusters, "qelari venatu");

    expect(selected?.cluster.profileIds).toEqual([firstDocument.id, secondDocument.id]);
    expect(selected?.cluster.profileIds).not.toContain(otherLanguage.id);
    expect(selected?.margin).toBeGreaterThanOrEqual(0.12);
  });

  it("keeps empty, punctuation-only, and ambiguous surfaces unscoped", () => {
    const left = profile("profile.left", "ababa ababa", "script.shared");
    const right = profile("profile.right", "acaca acaca", "script.shared");
    const clusters = buildLanguageProfileClusters([left, right]);

    expect(selectLanguageProfileClusterForSurface(clusters, "")).toBeUndefined();
    expect(selectLanguageProfileClusterForSurface(clusters, "...?!")).toBeUndefined();
    expect(selectLanguageProfileClusterForSurface(clusters, "a")).toBeUndefined();
  });

  it("selects learned unknown and mixed-script clusters without script-name routing", () => {
    const learned = profile("profile.mixed", "აბგᎠᎡᎢაბგᎠᎡᎢ", "script.unregistered");
    learned.scripts = [
      { script: "script:opaque:block:0010", mass: 0.5 },
      { script: "script:opaque:block:0013", mass: 0.5 }
    ];
    const selected = selectLanguageProfileClusterForSurface(buildLanguageProfileClusters([learned]), "აბგᎠᎡᎢ");

    expect(selected?.cluster.profileIds).toEqual([learned.id]);
  });

  it("derives deterministic cluster and cache identities independent of member order", () => {
    const first = profile("profile.a", "qelari venatu qelari venatu", "script.opaque");
    const second = profile("profile.b", "qelari venatu qelari venatu", "script.opaque");
    const forward = buildLanguageProfileClusters([first, second])[0]!;
    const reverse = buildLanguageProfileClusters([second, first])[0]!;

    expect(reverse.id).toBe(forward.id);
    expect(languageProfileClusterCacheKey(reverse)).toBe(languageProfileClusterCacheKey(forward));
    expect(languageProfileClusterCacheKey(undefined)).toBe("language-cluster:unscoped");
  });

  it("learns distinct opaque script blocks and preserves mixed unknown scripts", () => {
    const acquisition = acquisitionEngine();
    const georgian = acquisition.acquire({ sourceVersionId: "source.georgian" as never, text: "ქართული ქართული ტექსტი", createdAt: 1 });
    const cherokee = acquisition.acquire({ sourceVersionId: "source.cherokee" as never, text: "ᎠᎡᎢᎣᎤ ᎠᎡᎢᎣᎤ", createdAt: 1 });
    const mixed = acquisition.acquire({ sourceVersionId: "source.mixed" as never, text: "ქართული ᎠᎡᎢᎣᎤ", createdAt: 1 });

    expect(georgian.scripts.some(row => row.script === "script:opaque:block:0010")).toBe(true);
    expect(cherokee.scripts.some(row => row.script === "script:opaque:block:0013")).toBe(true);
    const mixedScripts = new Set(mixed.scripts.map(row => row.script));
    expect(mixedScripts.has("script:opaque:block:0010")).toBe(true);
    expect(mixedScripts.has("script:opaque:block:0013")).toBe(true);
    expect(buildLanguageProfileClusters([georgian, cherokee])).toHaveLength(2);
  });

  it("clusters diverse same-language topics without merging a distinct same-script distribution", () => {
    const acquisition = acquisitionEngine();
    const physics = acquisition.acquire({
      sourceVersionId: "source.physics" as never,
      text: "Quantum mechanics describes particles, measurements, waves, and physical systems. The theory predicts experimental outcomes.",
      createdAt: 1
    });
    const baking = acquisition.acquire({
      sourceVersionId: "source.baking" as never,
      text: "A baker kneads dough, prepares bread, heats the oven, and serves a fresh loaf each morning. Recipes guide careful preparation.",
      createdAt: 1
    });
    const distinct = acquisition.acquire({
      sourceVersionId: "source.distinct" as never,
      text: "Zomiku pafedo lurin zomiku pafedo lurin. Vekosa jupani toruze vekosa jupani toruze.",
      createdAt: 1
    });
    const clusters = buildLanguageProfileClusters([distinct, baking, physics]);
    const shared = clusters.find(cluster => cluster.profileIds.includes(physics.id));

    expect(shared?.profileIds).toContain(baking.id);
    expect(shared?.profileIds).not.toContain(distinct.id);
  });
});

function acquisitionEngine(): ReturnType<typeof createLanguageAcquisitionEngine> {
  const hasher = createHasher();
  return createLanguageAcquisitionEngine({
    idFactory: createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true })
  });
}

function profile(
  id: string,
  corpus: string,
  script = "script.unknown",
  direction: LanguageProfile["direction"] = "unknown"
): LanguageProfile {
  const normalized = corpus.normalize("NFC").toLowerCase();
  const chars = [...normalized].filter(char => !/\s/u.test(char));
  const trigrams = new Map<string, number>();
  for (let index = 0; index <= chars.length - 3; index += 1) {
    const gram = chars.slice(index, index + 3).join("");
    trigrams.set(gram, (trigrams.get(gram) ?? 0) + 1);
  }
  return {
    id,
    sourceVersionId: `source.${id}` as never,
    scripts: [{ script, mass: 1 }],
    symbolShapes: [],
    charNgrams: [...trigrams].map(([ngram, count]) => ({ ngram, count })),
    direction,
    entropy: 1,
    createdAt: 1
  };
}
