// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { canonicalStringify, createClock, createHasher } from "../../primitives.js";
import { createIdFactory } from "../../ids.js";
import { createEvidenceExtractor } from "../../evidence.js";
import { createLanguageAcquisitionEngine } from "../../language.js";
import { createLanguageMemoryRuntime, scopeLanguageMemoryStateToProfile } from "../../language-memory-runtime.js";
import { deriveClosedClassWords } from "../../closed-class-words.js";
import { canonicalCorpusSourceSystemId } from "../../corpus-registry.js";
import type { ScceStorage } from "../../storage.js";
import { compileLanguageTrainingBatch } from "../../language-training-batch.js";
import { preparePooledLanguageProfileBinding } from "../../pooled-language-profile-binding.js";
import { preparedLanguageInductionModel, sourceLanguageInductionDocuments } from "../../graph-surface-alignment.js";
import { primeLearnedAnswerUnitForms } from "../../learned-answer-unit-forms.js";

/** Actual source wording supplies scaffolding; separate raw examples supply observed name forms. */
export function sourceOwnedAnswerhoodLanguage(rawFormsText = "einstein r0. einstein's r0. newton r0. newton's r0. curie r0. curie's r0.") {
  if (lastTeaching?.text === rawFormsText) return lastTeaching.value;
  const value = Object.freeze(buildSourceOwnedAnswerhoodLanguage(rawFormsText));
  lastTeaching = { text: rawFormsText, value };
  return value;
}

let lastTeaching: { text: string; value: ReturnType<typeof buildSourceOwnedAnswerhoodLanguage> } | undefined;

function buildSourceOwnedAnswerhoodLanguage(rawFormsText: string) {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 1 });
  const ids = createIdFactory({ hasher, clock, deterministicReplay: true });
  const grammarText = readFileSync(new URL("./pride-and-prejudice-context-excerpt.txt", import.meta.url), "utf8");
  const provenance = JSON.parse(readFileSync(new URL("./pride-and-prejudice-context-excerpt.provenance.json", import.meta.url), "utf8"));
  if (hasher.digestHex(Buffer.from(grammarText)) !== provenance.excerptSha256) throw new Error("answerhood language excerpt hash mismatch");
  const language = createLanguageAcquisitionEngine({ idFactory: ids });
  const extractor = createEvidenceExtractor({ hasher, idFactory: ids });
  const parents = [
    { uri: "fixture://source-owned-answer-forms", sourceSystem: "workspace", family: "fixture.authored-language-examples", text: rawFormsText },
    { uri: `${provenance.sourceUri}#opening-chapters`, sourceSystem: "gutenberg", family: provenance.sourceUri as string, text: grammarText }
  ].map(parent => {
    const sourceId = ids.sourceId(parent.sourceSystem, parent.uri);
    const sourceVersionId = ids.sourceVersionId(canonicalStringify({ sourceId, contentHash: ids.contentHash(parent.text), role: "original" }));
    const profile = language.acquire({ sourceVersionId, text: parent.text, createdAt: 1 });
    const evidence = extractor.extract({ sourceId, sourceVersionId, namespace: parent.sourceSystem, uri: parent.uri, mediaType: "text/plain", text: parent.text,
      languageProfile: profile, observedAt: 1, maxChunkBytes: 4096, exactSourceText: true, metadata: { sourceSystem: parent.sourceSystem, sourceFamilyId: parent.family },
      sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
        independenceGroup: parent.family, accessScope: "fixture", licenseStatus: "fixture" } }).spans
      .map(span => ({ ...span, status: "promoted" as const, provenance: { ...span.provenance as object, sourceFamilyId: parent.family } }));
    return { ...parent, sourceVersionId, evidence };
  });
  const text = parents.map(parent => parent.text).join("\n\n");
  const uri = "fixture://source-owned-answerhood-language-pool";
  const sourceId = ids.sourceId("fixture-pool", uri);
  const sourceVersionId = ids.sourceVersionId(canonicalStringify({ sourceId, contentHash: ids.contentHash(text), role: "derived",
    parentSourceVersionIds: parents.map(parent => parent.sourceVersionId), transform: "exact-source-concatenation" }));
  const profile = language.acquire({ sourceVersionId, text, createdAt: 1 });
  const evidence = parents.flatMap(parent => parent.evidence);
  const profileBinding = preparePooledLanguageProfileBinding({ profile, sourceVersionId, text, evidence,
    parentSourceVersionIds: parents.map(parent => parent.sourceVersionId), hasher,
    sourceFamilyRanges: parents.map((parent, index) => ({ start: index ? parents[0]!.text.length + 2 : 0,
      end: (index ? parents[0]!.text.length + 2 : 0) + parent.text.length, sourceVersionId: parent.sourceVersionId, sourceFamilyId: parent.family })) });
  const runtime = createLanguageMemoryRuntime({ hasher, idFactory: ids });
  const compiled = compileLanguageTrainingBatch({ runtime, hasher, batch: { streamId: uri, sourceSystem: "gutenberg", profile, sourceVersionId, text, evidence,
    createdAt: 1, maxOrder: 3, maxCountersPerOrder: 4096, vocabularyLimit: 2048, retainNgramObservations: false, profileBinding } });
  const state = scopeLanguageMemoryStateToProfile(runtime.hydrate({ models: compiled.models, units: compiled.units, patterns: compiled.patterns,
    semanticFrames: compiled.semanticFrames, constructionEvidence: evidence }), profile);
  const model = preparedLanguageInductionModel({ documents: sourceLanguageInductionDocuments(evidence), hasher, prepared: compiled.preparedInduction })!;
  const forms = { profile, evidence, model, runtime, state, projection: { patterns: compiled.patterns },
    prime: () => primeLearnedAnswerUnitForms({ deltas: state.structuralDeltas ?? [], profileIds: new Set([profile.id]) }) };
  const profiles = [profile];
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
  return { profile, profiles, readModels, readPatterns, readProfiles, evidence, grammarEvidence: parents[1]!.evidence, profileBinding, parents,
    models: compiled.models, patterns: forms.projection.patterns, compiled, state, closedClass: deriveClosedClassWords({ models: state.models }), forms };
}
