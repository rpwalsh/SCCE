// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createClock, createHasher } from "../../primitives.js";
import { createIdFactory } from "../../ids.js";
import { createLanguageAcquisitionEngine } from "../../language.js";
import { createEvidenceExtractor } from "../../evidence.js";
import { attachPooledLanguageProfileOwnership, preparePooledLanguageProfileBinding } from "../../pooled-language-profile-binding.js";

export function pooledProfileOwnerFixture(texts: readonly string[], namespace = "fixture.pooled") {
  const hasher = createHasher(), ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace });
  const acquisition = createLanguageAcquisitionEngine({ idFactory: ids }), extractor = createEvidenceExtractor({ idFactory: ids, hasher });
  const pages = texts.map((text, index) => {
    const sourceId = ids.sourceId(namespace, `fixture://${namespace}/${index}`), sourceVersionId = ids.sourceVersionId(`${sourceId}:${text}`);
    const profile = acquisition.acquire({ text, sourceVersionId, createdAt: 1 });
    const evidence = extractor.extract({ sourceId, sourceVersionId, namespace, uri: `fixture://${namespace}/${index}`, mediaType: "text/plain", text,
      languageProfile: profile, sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
        independenceGroup: String(sourceId), accessScope: "fixture", licenseStatus: "fixture" }, observedAt: 1, metadata: {}, exactSourceText: true, maxChunkBytes: 65536 }).spans
      .map(span => ({ ...span, status: "promoted" as const }));
    return { text, profile, evidence };
  });
  const text = texts.join("\n\n"), sourceVersionId = ids.sourceVersionId(`aggregate:${namespace}:${text}`);
  const profile = acquisition.acquire({ text, sourceVersionId, createdAt: 1 });
  let start = 0;
  const sourceFamilyRanges = pages.map(page => {
    const range = { start, end: start + page.text.length, sourceFamilyId: String(page.evidence[0]!.sourceId), sourceVersionId: page.profile.sourceVersionId };
    start = range.end + 2; return range;
  });
  const input = { profile, text, sourceVersionId, parentSourceVersionIds: pages.map(page => String(page.profile.sourceVersionId)),
    evidence: pages.flatMap(page => page.evidence), sourceFamilyRanges, hasher };
  const binding = preparePooledLanguageProfileBinding(input);
  return { ...input, pages, binding, owned: attachPooledLanguageProfileOwnership(profile, binding, hasher) };
}
