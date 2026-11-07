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
  return { profile, profiles: [profile, forms.profile], evidence: [...evidence, ...forms.evidence], grammarEvidence: evidence,
    models: compiled.models, patterns: forms.projection.patterns, compiled, state, closedClass: deriveClosedClassWords({ models: state.models }), forms };
}
