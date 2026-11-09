// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalDigestHex, canonicalStringify, createHasher, normalizeInformationLabel, type CorpusSegmentationScope, type SegmentationPageBounds,
  type CorpusSegmentationBatchLoader, type ScceStorage } from "@scce/kernel";

export interface LanguageTrainingSegmentationDeclaration {
  scope: CorpusSegmentationScope; recipeId: string; normalizationContractId: string; bounds: SegmentationPageBounds;
}
export interface PreparedLanguageTrainingSegmentation {
  readonly identity: {
    schema: "scce.language_training_segmentation.v1";
    mode: "local_bootstrap" | "corpus_snapshot";
    declaration: LanguageTrainingSegmentationDeclaration | null;
    population: CorpusSegmentationBatchLoader["identity"] | null;
    transition: "new_derived_compilation_required";
  };
}
const prepared = new WeakMap<PreparedLanguageTrainingSegmentation, { storage: ScceStorage; digest: string; loader?: CorpusSegmentationBatchLoader }>();
const hasher = createHasher();

export function validateLanguageTrainingSegmentationDeclaration(value: LanguageTrainingSegmentationDeclaration): void {
  if (!value || !value.scope || typeof value.recipeId !== "string" || !value.recipeId.trim()
    || typeof value.normalizationContractId !== "string" || !value.normalizationContractId.trim()
    || !value.bounds || ![value.bounds.pageRows, value.bounds.maxPageBytes].every(number => Number.isSafeInteger(number) && number > 0)) throw new Error("Invalid runtime.corpusSegmentation declaration");
  const fields = (object: object, allowed: readonly string[]) => { if (Object.keys(object).some(key => !allowed.includes(key))) throw new Error("Unknown runtime.corpusSegmentation scope field"); };
  fields(value, ["scope", "recipeId", "normalizationContractId", "bounds"]);
  fields(value.scope, ["informationLabel", "sourceVersionIds", "sourceSystems", "activeImportVersion", "ownerFamilyBindings"]);
  fields(value.bounds, ["pageRows", "maxPageBytes"]);
  normalizeInformationLabel(value.scope.informationLabel);
  for (const ids of [value.scope.sourceVersionIds, value.scope.sourceSystems]) if (ids !== undefined
    && (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== "string" || !id.trim()))) throw new Error("Invalid corpus segmentation source scope");
  if (value.scope.activeImportVersion !== undefined && (typeof value.scope.activeImportVersion !== "string" || !value.scope.activeImportVersion.trim())) throw new Error("Invalid corpus segmentation import scope");
  if (value.scope.ownerFamilyBindings !== undefined && (!Array.isArray(value.scope.ownerFamilyBindings) || value.scope.ownerFamilyBindings.some(row =>
    !row || typeof row.sourceId !== "string" || !row.sourceId.trim() || typeof row.familyId !== "string" || !row.familyId.trim()))) throw new Error("Invalid declared corpus segmentation owner families");
}

export async function prepareLanguageTrainingSegmentationInput(storage: ScceStorage, declaration?: LanguageTrainingSegmentationDeclaration): Promise<PreparedLanguageTrainingSegmentation> {
  if (declaration) validateLanguageTrainingSegmentationDeclaration(declaration);
  const declared = declaration ? structuredClone(declaration) : null;
  const active = declared ? await requireActive(storage, declared) : null;
  const identity: PreparedLanguageTrainingSegmentation["identity"] = { schema: "scce.language_training_segmentation.v1",
    mode: active ? "corpus_snapshot" : "local_bootstrap", declaration: declared,
    population: active ? structuredClone(active.loader.identity) : null, transition: "new_derived_compilation_required" };
  const token = Object.freeze({ identity: Object.freeze(identity) });
  prepared.set(token, { storage, digest: canonicalDigestHex(identity, hasher), ...(active ? { loader: active.loader } : {}) });
  return token;
}

async function requireActive(storage: ScceStorage, declaration: LanguageTrainingSegmentationDeclaration, lockForCommit = false) {
  if (!storage.corpusSegmentation) throw new Error("Configured corpus segmentation storage is unavailable; initialize schema and consolidate the declared cohort");
  const active = await storage.corpusSegmentation.readActive(declaration.scope,
    { recipeId: declaration.recipeId, normalizationContractId: declaration.normalizationContractId }, declaration.bounds, { lockForCommit });
  if (!active) throw new Error("No consolidated corpus segmentation snapshot matches runtime.corpusSegmentation; run scce db consolidate-segmentation with the exact declared cohort before training");
  return active;
}

export async function languageTrainingSegmentationLoader(storage: ScceStorage, declaration: LanguageTrainingSegmentationDeclaration | undefined,
  token: PreparedLanguageTrainingSegmentation, revalidate = false): Promise<CorpusSegmentationBatchLoader | undefined> {
  const held = prepared.get(token);
  if (!held || held.storage !== storage || held.digest !== canonicalDigestHex(token.identity, hasher)
    || canonicalStringify(token.identity.declaration) !== canonicalStringify(declaration ?? null)) throw new Error("Language training segmentation preparation changed");
  if (revalidate && declaration) {
    const active = await requireActive(storage, declaration, true);
    if (canonicalStringify(active.loader.identity) !== canonicalStringify(token.identity.population)) throw new Error("Corpus segmentation snapshot changed; restart derived compilation with the new snapshot");
  }
  return held.loader;
}
