// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { createClock, createHasher } from "../../primitives.js";
import { createIdFactory } from "../../ids.js";
import { createEvidenceExtractor } from "../../evidence.js";
import { createLanguageAcquisitionEngine } from "../../language.js";
import { createNgramMemoryCompiler } from "../../ngram-memory.js";
import { createLanguageMemoryRuntime } from "../../language-memory-runtime.js";
import { deriveClosedClassWords } from "../../closed-class-words.js";
import { sourceOwnedAnswerUnitForms } from "./source-owned-answer-unit-forms.js";
import { canonicalCorpusSourceSystemId } from "../../corpus-registry.js";
import type { ScceStorage } from "../../storage.js";

/** Actual source wording supplies scaffolding; separate raw examples supply observed name forms. */
export function sourceOwnedAnswerhoodLanguage(rawFormsText = "einstein r0. einstein's r0. newton r0. newton's r0. curie r0. curie's r0.") {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 1 });
  const ids = createIdFactory({ hasher, clock, deterministicReplay: true });
  const text = readFileSync(new URL("./pride-and-prejudice-context-excerpt.txt", import.meta.url), "utf8");
  const provenance = JSON.parse(readFileSync(new URL("./pride-and-prejudice-context-excerpt.provenance.json", import.meta.url), "utf8"));
  if (hasher.digestHex(Buffer.from(text)) !== provenance.excerptSha256) throw new Error("answerhood language excerpt hash mismatch");
  const sourceVersionId = ids.sourceVersionId(Buffer.from(text));
  const uri = `${provenance.sourceUri}#opening-chapters`;
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: 1 });
  const evidence = createEvidenceExtractor({ hasher, idFactory: ids }).extract({ sourceId: ids.sourceId("gutenberg", uri), sourceVersionId,
    namespace: "fixture", uri, mediaType: "text/plain", text, languageProfile: profile, observedAt: 1, maxChunkBytes: 4096, exactSourceText: true,
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
      independenceGroup: provenance.sourceUri, accessScope: "public", licenseStatus: "public-domain" } }).spans;
  const compiled = createNgramMemoryCompiler({ hasher, idFactory: ids }).compile({ streamId: uri, sourceSystem: "gutenberg", profile, sourceVersionId,
    text, evidence, createdAt: 1, maxOrder: 3, maxCountersPerOrder: 4096, vocabularyLimit: 2048, retainObservations: false });
  const state = createLanguageMemoryRuntime({ hasher, idFactory: ids }).hydrate({ models: compiled.models });
  const forms = sourceOwnedAnswerUnitForms(rawFormsText);
  const profiles = [profile, forms.profile];
  const sameSource = (actual: unknown, requested?: string) => !requested || typeof actual === "string"
    && canonicalCorpusSourceSystemId(actual) === canonicalCorpusSourceSystemId(requested);
  const readModels: ScceStorage["languageMemory"]["listNgramModels"] = async query => compiled.models.filter(row => {
    const metadata = row.modelJson as Record<string, unknown>;
    return sameSource(metadata.sourceSystem, query?.sourceSystem) && (!query?.profileIds || query.profileIds.includes(String(metadata.profileId)))
      && (!query?.streamId || query.streamId === row.streamId) && (!query?.languageHint || query.languageHint === row.languageHint);
  }).slice(0, query?.limit);
  const readPatterns: ScceStorage["languageMemory"]["listLanguagePatterns"] = async query => forms.projection.patterns.filter(row => {
    const metadata = row.patternJson as Record<string, unknown>;
    return sameSource(metadata.sourceSystem, query?.sourceSystem) && (!query?.profileIds || query.profileIds.includes(row.profileId))
      && (!query?.profileId || query.profileId === row.profileId) && (!query?.patternKind || query.patternKind === row.patternKind)
      && (!query?.patternSchemas || query.patternSchemas.includes(String(metadata.schema)))
      && (!query?.formalLanguage || query.formalLanguage === metadata.formalLanguage)
      && (query?.parameterCount === undefined || query.parameterCount === metadata.parameterCount);
  }).slice(0, query?.limit);
  const readProfiles: ScceStorage["model"]["listLanguageProfiles"] = async query => typeof query === "object" && query?.sourceDerivedAliases?.length ? []
    : profiles.filter(row => typeof query === "number" || !query?.sourceVersionIds || query.sourceVersionIds.includes(row.sourceVersionId))
      .slice(0, typeof query === "number" ? query : query?.limit);
  return { profile, profiles, readModels, readPatterns, readProfiles, evidence: [...evidence, ...forms.evidence], grammarEvidence: evidence,
    models: compiled.models, patterns: forms.projection.patterns, compiled, state, closedClass: deriveClosedClassWords({ models: state.models }), forms };
}
