// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createLanguageInductionEngine, type LanguageInductionDocument, type InducedLanguageModel } from "./language-induction.js";
import { INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID, type InducedLanguageMemoryModel } from "./language-induction-memory.js";
import { canonicalDigestHex } from "./canonical-json-digest.js";
import { canonicalStringify } from "./primitives.js";
import { inductionCharBudget, inductionDocumentCharCap } from "./training-orchestrator.js";
import { surfaceSentenceRanges } from "./surface-linguistics.js";
import { canonicalGraphemeSegmenter } from "./normalization-contract.js";
import type { Hasher } from "./types.js";
import type { CorpusSegmentationBatchLoader, VerifiedCorpusSegmentation } from "./corpus-segmentation-cursor.js";
import { prepareCorpusSegmentationMeasurement } from "./surface-lattice.js";
import { corpusSegmentationInputDigest, validateCorpusSegmentationForDocuments } from "./corpus-segmentation-input.js";
import {
  attachSourceSegmentationReplayRecipe,
  exportSourceSegmentationReplayRecipe,
  type SourceSegmentationWitness
} from "./source-segmentation-witness.js";
import { validateSurfaceSegmentationReplayRecipe } from "./surface-lattice.js";

import type { SourceInductionBatch, SourceInductionBatchExecution, SourceInductionBatchIdentity, SourceInductionBatchJob, SourceInductionBatchProduct,
  SourceInductionSegmentationReplay } from "./source-induction-execution.js";
export type { SourceInductionBatch } from "./source-induction-execution.js";

export const SOURCE_WINDOW_INDUCTION_RECIPE_ID = "kernel.source_window_induction.v3" as const;

function freezeProducts<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezeProducts(child, seen);
    Object.freeze(value);
  }
  return value;
}

export interface SourceInductionWindow {
  documentId: string;
  ownerDocumentId: string;
  sourceVersionId: string | null;
  evidenceIds: readonly string[];
  startUtf16: number;
  endUtf16: number;
  contentDigest: string;
}

export interface SourceInductionCoverage {
  schema: "scce.source_induction_coverage.v1";
  recipe: typeof SOURCE_WINDOW_INDUCTION_RECIPE_ID;
  inputDigest: string;
  complete: true;
  inputUtf16Length: number;
  coveredUtf16Length: number;
  batches: number;
  batchBudgetUtf16: number;
  windowCapUtf16: number;
  windows: readonly SourceInductionWindow[];
}

export function sourceInductionInputDigest(documents: readonly LanguageInductionDocument[], hasher: Hasher,
  corpusIdentity?: CorpusSegmentationBatchLoader["identity"]): string {
  return hasher.digestHex(canonicalStringify({ recipe: SOURCE_WINDOW_INDUCTION_RECIPE_ID,
    batchBudgetUtf16: inductionCharBudget(), windowCapUtf16: inductionDocumentCharCap(), documents,
    ...(corpusIdentity ? { corpusSegmentation: corpusIdentity } : {}) }));
}

export function* sourceInductionBatches(documents: readonly LanguageInductionDocument[], hasher: Hasher): Generator<SourceInductionBatch> {
  const budget = inductionCharBudget();
  const cap = Math.min(budget, inductionDocumentCharCap());
  let batch: LanguageInductionDocument[] = [];
  let windows: SourceInductionWindow[] = [];
  let used = 0;
  for (const document of documents) {
    const text = document.text;
    const ownerDocumentId = document.sourceWindow?.ownerDocumentId ?? document.id;
    const ownerBase = document.sourceWindow?.startUtf16 ?? 0;
    if (document.sourceWindow && (!ownerDocumentId || !Number.isSafeInteger(ownerBase) || ownerBase < 0
      || document.sourceWindow.endUtf16 - ownerBase !== text.length)) throw new Error("source induction window has inconsistent owner ranges");
    const graphemeOffsets = [...canonicalGraphemeSegmenter().segment(text)].map(segment => segment.index);
    graphemeOffsets.push(text.length);
    let startGrapheme = 0;
    const boundaries = surfaceSentenceRanges(text).map(range => range.endUtf16);
    let boundaryIndex = 0;
    for (let start = 0; start < text.length;) {
      let end = Math.min(text.length, start + cap);
      while (boundaryIndex < boundaries.length && boundaries[boundaryIndex]! <= start) boundaryIndex++;
      let lastBoundary: number | undefined;
      while (boundaryIndex < boundaries.length && boundaries[boundaryIndex]! <= end) lastBoundary = boundaries[boundaryIndex++];
      if (end < text.length && lastBoundary !== undefined) end = lastBoundary;
      let endGrapheme = startGrapheme;
      while (endGrapheme + 1 < graphemeOffsets.length && graphemeOffsets[endGrapheme + 1]! <= end) endGrapheme++;
      end = graphemeOffsets[endGrapheme]!;
      if (end <= start) throw new Error("source induction window cannot fit one Unicode scalar within its budget");
      if (used && used + end - start > budget) {
        yield { documents: batch, windows };
        batch = []; windows = []; used = 0;
      }
      const content = text.slice(start, end);
      const contentDigest = hasher.digestHex(content);
      const id = start === 0 && end === text.length ? document.id : `source_window.${hasher.digestHex(canonicalStringify([
        SOURCE_WINDOW_INDUCTION_RECIPE_ID, ownerDocumentId, document.sourceVersionId ?? null, ownerBase + start, ownerBase + end, contentDigest
      ]))}`;
      batch.push({ ...document, id, text: content, sourceFamilyId: document.sourceFamilyId ?? String(document.sourceVersionId ?? document.id),
        sourceWindow: { ownerDocumentId, startUtf16: ownerBase + start, endUtf16: ownerBase + end },
        ...(document.boundaryAnchors ? { boundaryAnchors: document.boundaryAnchors.filter(anchor => anchor.positionGrapheme >= startGrapheme && anchor.positionGrapheme < endGrapheme)
          .map(anchor => ({ ...anchor, positionGrapheme: anchor.positionGrapheme - startGrapheme })) } : {}) });
      windows.push({ documentId: id, ownerDocumentId, sourceVersionId: document.sourceVersionId ? String(document.sourceVersionId) : null,
        evidenceIds: (document.evidenceIds ?? []).map(String), startUtf16: ownerBase + start, endUtf16: ownerBase + end, contentDigest });
      used += end - start;
      start = end;
      startGrapheme = endGrapheme;
    }
  }
  if (batch.length) yield { documents: batch, windows };
}

export interface SourceInductionProducts {
  models: readonly InducedLanguageMemoryModel[];
  fullModel?: InducedLanguageModel;
  coverage: SourceInductionCoverage;
}
interface SourceInductionCompileInput { documents: readonly LanguageInductionDocument[]; hasher: Hasher;
  relationContextDocuments?: readonly LanguageInductionDocument[]; modelCache?: Map<string, InducedLanguageMemoryModel> }

export function sourceInductionBatchJobDigest(job: Omit<SourceInductionBatchJob, "jobDigest">, hasher: Hasher): string {
  return hasher.digestHex(canonicalStringify({ job, streamingDigest: canonicalDigestHex(job, hasher) }));
}

function sourceInductionBatchKey(sourceDigest: string, corpusBinding: string | undefined,
  relationContextDigest: string, hasher: Hasher): string {
  return hasher.digestHex(canonicalStringify([
    sourceDigest,
    INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID,
    corpusBinding ?? null,
    relationContextDigest
  ]));
}

function compactSourceInductionModel(model: InducedLanguageModel): InducedLanguageMemoryModel {
    const { id, audit, morphology, morphologyClassBindings, syntaxTemplates, boundarySignals, segmentationWitness,
      semanticFrames, graphBoundConstructions, lexicalClasses, relationHypothesisModel, translationSeeds, semanticInductionFactors } = model;
    return freezeProducts({ id, audit, morphology, morphologyClassBindings, syntaxTemplates, boundarySignals,
      segmentationWitness,
      semanticFrames, graphBoundConstructions, lexicalClasses, relationHypothesisModel, translationSeeds,
      ...(semanticInductionFactors ? { semanticInductionFactors } : {}) });
}

function segmentationWitnessDocuments(model: InducedLanguageMemoryModel | InducedLanguageModel): SourceSegmentationWitness[] {
  return model.segmentationWitness.populations.flatMap(population => population.documents);
}

function sourceInductionSegmentationReplay(model: InducedLanguageMemoryModel): SourceInductionSegmentationReplay[] {
  const seen = new Set<string>();
  return segmentationWitnessDocuments(model).map(witness => {
    if (seen.has(witness.id)) throw new Error("source induction product repeats a segmentation replay witness");
    seen.add(witness.id);
    const recipe = exportSourceSegmentationReplayRecipe(witness);
    if (!recipe) throw new Error("source induction omitted exact segmentation replay state");
    return { witnessId: witness.id, recipe: validateSurfaceSegmentationReplayRecipe(recipe) };
  });
}

function attachSourceInductionSegmentationReplay(product: SourceInductionBatchProduct): SourceInductionBatchProduct {
  if (!Array.isArray(product.segmentationReplay)) throw new Error("source induction product omitted segmentation replay transport");
  const byWitness = new Map<string, SourceInductionSegmentationReplay>();
  for (const binding of product.segmentationReplay) {
    if (!binding || typeof binding.witnessId !== "string" || !binding.witnessId || byWitness.has(binding.witnessId)) {
      throw new Error("source induction product has invalid segmentation replay transport");
    }
    byWitness.set(binding.witnessId, { witnessId: binding.witnessId, recipe: validateSurfaceSegmentationReplayRecipe(binding.recipe) });
  }
  const attachModel = (model: InducedLanguageMemoryModel | InducedLanguageModel): void => {
    const witnesses = segmentationWitnessDocuments(model);
    if (witnesses.length !== byWitness.size || witnesses.some(witness => !byWitness.has(witness.id))) {
      throw new Error("source induction segmentation replay transport differs from its witnesses");
    }
    for (const witness of witnesses) {
      const recipe = byWitness.get(witness.id)!.recipe;
      const existing = exportSourceSegmentationReplayRecipe(witness);
      if (existing) {
        if (canonicalStringify(validateSurfaceSegmentationReplayRecipe(existing)) !== canonicalStringify(recipe)) {
          throw new Error("source induction segmentation replay transport changed producer state");
        }
      } else {
        attachSourceSegmentationReplayRecipe(witness, recipe);
      }
    }
  };
  attachModel(product.compact);
  if (product.fullModel) attachModel(product.fullModel);
  return product;
}

/** Prepare/induce are the same pure producer in serial execution and worker sessions. */
export function prepareSourceInductionBatch(input: { batch: SourceInductionBatch; hasher: Hasher;
  relationContextDocuments?: readonly LanguageInductionDocument[]; verified?: VerifiedCorpusSegmentation }):
  SourceInductionBatchIdentity & { induce(retainFullModel?: boolean): SourceInductionBatchProduct } {
  const { batch, hasher, verified } = input;
  if (!batch.documents.some(document => document.text.trim())) throw new Error("source induction batch contains no language material");
  const sourceDigest = sourceInductionInputDigest(batch.documents, hasher), windowsDigest = hasher.digestHex(canonicalStringify(batch.windows));
  const corpusBinding = verified ? validateCorpusSegmentationForDocuments(batch.documents.filter(document => document.text.trim()), verified, hasher).inputDigest : undefined;
  // Product schema participates in the cache identity even though it does not
  // change the source-window ownership receipt. This prevents a pre-v4 compact
  // model carrying the retired boundary predictor from satisfying the new witness job.
  const relationContextDigest = sourceInductionInputDigest(input.relationContextDocuments ?? [], hasher);
  const batchKey = sourceInductionBatchKey(sourceDigest, corpusBinding, relationContextDigest, hasher);
  return Object.freeze({ batchKey, ...(corpusBinding ? { corpusBinding } : {}), induce(retainFullModel = true): SourceInductionBatchProduct {
    if (sourceInductionInputDigest(batch.documents, hasher) !== sourceDigest
      || sourceInductionInputDigest(input.relationContextDocuments ?? [], hasher) !== relationContextDigest
      || hasher.digestHex(canonicalStringify(batch.windows)) !== windowsDigest
      || verified && corpusSegmentationInputDigest(batch.documents.filter(document => document.text.trim()), verified, hasher) !== corpusBinding)
      throw new Error("source induction batch inputs changed");
    const model = createLanguageInductionEngine({ hasher }).induce({ documents: batch.documents,
      ...(input.relationContextDocuments?.length ? { relationContextDocuments: input.relationContextDocuments } : {}),
      captureSegmentationReplay: true,
      ...(verified ? { verifiedCorpusSegmentation: verified } : {}) });
    const compact = compactSourceInductionModel(model);
    return { compact, ...(retainFullModel ? { fullModel: model } : {}), segmentationReplay: sourceInductionSegmentationReplay(compact) };
  } });
}

function createSourceInductionCompiler(input: SourceInductionCompileInput & { corpusIdentity?: CorpusSegmentationBatchLoader["identity"] }) {
  const models: InducedLanguageMemoryModel[] = [];
  const windows: SourceInductionWindow[] = [];
  let first: InducedLanguageModel | undefined;
  const corpusBindings: string[] = [];
  const accept = (identity: SourceInductionBatchIdentity, product: SourceInductionBatchProduct): void => {
    attachSourceInductionSegmentationReplay(product);
    if (identity.corpusBinding) corpusBindings.push(identity.corpusBinding);
    const cached = input.modelCache?.get(identity.batchKey);
    if (cached) { first = undefined; models.push(cached); return; }
    first = models.length ? undefined : product.fullModel;
    const compact = freezeProducts(product.compact);
    models.push(compact); input.modelCache?.set(identity.batchKey, compact);
  };
  return { observe(batch: SourceInductionBatch): void { windows.push(...batch.windows); }, accept,
    add(batch: SourceInductionBatch, verified?: VerifiedCorpusSegmentation): void {
      windows.push(...batch.windows);
      if (!batch.documents.some(document => document.text.trim())) return;
      const prepared = prepareSourceInductionBatch({ batch, hasher: input.hasher,
        ...(input.relationContextDocuments?.length ? { relationContextDocuments: input.relationContextDocuments } : {}),
        ...(verified ? { verified } : {}) });
      const cached = input.modelCache?.get(prepared.batchKey);
      accept(prepared, cached ? { compact: cached, segmentationReplay: sourceInductionSegmentationReplay(cached) } : prepared.induce());
    }, finish(): SourceInductionProducts {
  const inputUtf16Length = input.documents.reduce((total, document) => total + document.text.length, 0);
  const coveredUtf16Length = windows.reduce((total, window) => total + window.endUtf16 - window.startUtf16, 0);
  if (coveredUtf16Length !== inputUtf16Length) throw new Error("source induction windows do not cover the complete owned input");
  return Object.freeze({ models: freezeProducts(models), ...(first ? { fullModel: first } : {}), coverage: freezeProducts<SourceInductionCoverage>({
    schema: "scce.source_induction_coverage.v1", recipe: SOURCE_WINDOW_INDUCTION_RECIPE_ID,
    inputDigest: input.hasher.digestHex(canonicalStringify({
      source: sourceInductionInputDigest(input.documents, input.hasher, input.corpusIdentity),
      relationContext: sourceInductionInputDigest(input.relationContextDocuments ?? [], input.hasher),
      ...(input.corpusIdentity ? { corpusBindings } : {})
    })), complete: true,
    inputUtf16Length, coveredUtf16Length, batches: models.length,
    batchBudgetUtf16: inductionCharBudget(), windowCapUtf16: inductionDocumentCharCap(), windows
  }) });
  } };
}

export function compileSourceInductionWindows(input: SourceInductionCompileInput): SourceInductionProducts {
  const compiler = createSourceInductionCompiler(input);
  for (const batch of sourceInductionBatches(input.documents, input.hasher)) compiler.add(batch);
  return compiler.finish();
}

export async function compileSourceInductionWindowsFromCorpus(input: SourceInductionCompileInput & { corpusLoader: CorpusSegmentationBatchLoader }): Promise<SourceInductionProducts> {
  const source = input.corpusLoader.identity;
  const expected = { id: source.id, featureContextId: source.featureContextId, normalizationContractId: source.normalizationContractId, sourceInventory: { ...source.sourceInventory } };
  const compiler = createSourceInductionCompiler({ ...input, corpusIdentity: expected });
  for (const batch of sourceInductionBatches(input.documents, input.hasher)) {
    const documents = batch.documents.filter(document => document.text.trim());
    if (!documents.length) { compiler.add(batch); continue; }
    const preparations = documents.map(document => prepareCorpusSegmentationMeasurement({ documentId: document.id, text: document.text,
      sourceVersionId: document.sourceVersionId, evidenceIds: document.evidenceIds, hasher: input.hasher }));
    const verified = await input.corpusLoader.resolve(preparations);
    const actual = verified.populationInference;
    if (actual.id !== expected.id || actual.featureContextId !== expected.featureContextId || actual.sourceInventory.id !== expected.sourceInventory.id
      || actual.sourceInventory.count !== expected.sourceInventory.count || actual.normalizationContractId !== expected.normalizationContractId) throw new Error("corpus segmentation loader snapshot changed");
    compiler.add(batch, verified);
  }
  return compiler.finish();
}

/** Execute independent windows of ONE captured view; cache publication and model order remain serial. */
export async function compileSourceInductionWindowsAsync(input: SourceInductionCompileInput & {
  execution: SourceInductionBatchExecution; corpusLoader?: CorpusSegmentationBatchLoader; signal?: AbortSignal;
}): Promise<SourceInductionProducts> {
  const { execution, signal } = input;
  if (!Number.isSafeInteger(execution.concurrency) || execution.concurrency < 1) throw new Error("source induction execution concurrency must be a positive integer");
  const source = input.corpusLoader?.identity;
  const identity = source ? { id: source.id, featureContextId: source.featureContextId, normalizationContractId: source.normalizationContractId,
    sourceInventory: { ...source.sourceInventory } } : undefined;
  const compiler = createSourceInductionCompiler({ ...input, ...(identity ? { corpusIdentity: identity } : {}) });
  const relationContextDigest = sourceInductionInputDigest(input.relationContextDocuments ?? [], input.hasher);
  type Completed = { ok: true; identity: SourceInductionBatchIdentity; product: SourceInductionBatchProduct } | { ok: false; error: unknown };
  const queue: Array<Promise<Completed>> = [];
  const inFlight = new Map<string, Promise<SourceInductionBatchProduct>>();
  let ordinal = 0;
  const aborted = () => { void execution.close(signal?.reason).catch(() => {}); };
  const run = async (batch: SourceInductionBatch, index: number): Promise<Completed> => {
    let session: Awaited<ReturnType<SourceInductionBatchExecution["open"]>> | undefined, primary: unknown, failed = false;
    try {
      signal?.throwIfAborted();
      const sourceKey = sourceInductionInputDigest(batch.documents, input.hasher);
      const localBatchKey = sourceInductionBatchKey(sourceKey, undefined, relationContextDigest, input.hasher);
      if (!input.corpusLoader) {
        const cached = input.modelCache?.get(localBatchKey);
        if (cached) return { ok: true, identity: { batchKey: localBatchKey }, product: { compact: cached, segmentationReplay: sourceInductionSegmentationReplay(cached) } };
        const pending = input.modelCache ? inFlight.get(localBatchKey) : undefined;
        if (pending) return { ok: true, identity: { batchKey: localBatchKey }, product: await pending };
      }
      const body = { ordinal: index, batch, retainFullModel: index === 0,
        ...(input.relationContextDocuments?.length ? { relationContextDocuments: [...input.relationContextDocuments] } : {}),
        ...(identity ? { corpusIdentity: identity } : {}),
        batchBudgetUtf16: inductionCharBudget(), windowCapUtf16: inductionDocumentCharCap() };
      const job = { ...body, jobDigest: sourceInductionBatchJobDigest(body, input.hasher) };
      session = await execution.open(job);
      if (session.jobDigest !== job.jobDigest) throw new Error("source induction worker job identity changed");
      const documents = batch.documents.filter(document => document.text.trim());
      let verified: VerifiedCorpusSegmentation | undefined;
      if (input.corpusLoader) {
        if (session.preparations.length !== documents.length || session.preparations.some((preparation, slot) => preparation.documentId !== documents[slot]!.id))
          throw new Error("source induction worker measurement scope changed");
        verified = await input.corpusLoader.resolve(session.preparations);
        const actual = verified.populationInference;
        if (actual.id !== identity!.id || actual.featureContextId !== identity!.featureContextId || actual.sourceInventory.id !== identity!.sourceInventory.id
          || actual.sourceInventory.count !== identity!.sourceInventory.count || actual.normalizationContractId !== identity!.normalizationContractId)
          throw new Error("corpus segmentation loader snapshot changed");
      } else if (session.preparations.length) throw new Error("source induction worker requested an undeclared corpus context");
      const prepared = await session.verify(verified);
      const corpusBinding = verified ? corpusSegmentationInputDigest(documents, verified, input.hasher) : undefined;
      const expectedKey = sourceInductionBatchKey(sourceKey, corpusBinding, relationContextDigest, input.hasher);
      if (prepared.batchKey !== expectedKey || prepared.corpusBinding !== corpusBinding) throw new Error("source induction worker batch identity changed");
      const cached = input.modelCache?.get(prepared.batchKey);
      if (cached) return { ok: true, identity: prepared, product: { compact: cached, segmentationReplay: sourceInductionSegmentationReplay(cached) } };
      const pending = input.modelCache ? inFlight.get(prepared.batchKey) : undefined;
      if (pending) {
        await session.close(); session = undefined;
        return { ok: true, identity: prepared, product: await pending };
      }
      const operation = session.induce();
      if (input.modelCache) inFlight.set(prepared.batchKey, operation);
      const product = await operation;
      if (!product?.compact || typeof product.compact.id !== "string" || job.retainFullModel && !product.fullModel
        || product.fullModel && product.fullModel.id !== product.compact.id) throw new Error("source induction worker omitted its complete model product");
      return { ok: true, identity: prepared, product };
    } catch (error) { primary = error; failed = true; return { ok: false, error }; }
    finally {
      try { await session?.close(); }
      catch (cleanup) { if (failed && cleanup !== primary) throw new AggregateError([primary, cleanup], "source induction session and cleanup failed"); throw cleanup; }
    }
  };
  const retire = async (): Promise<void> => {
    const completed = await queue.shift()!;
    signal?.throwIfAborted();
    if (!completed.ok) throw completed.error;
    compiler.accept(completed.identity, completed.product);
    // The canonical cache now owns only the compact product. Never retain resolved fullModel promises for the whole view.
    inFlight.delete(completed.identity.batchKey);
  };
  try {
    signal?.throwIfAborted(); signal?.addEventListener("abort", aborted, { once: true });
    const batches = sourceInductionBatches(input.documents, input.hasher);
    for (;;) {
      let next: IteratorResult<SourceInductionBatch>;
      try { next = batches.next(); }
      catch (error) { queue.push(Promise.resolve({ ok: false, error })); break; }
      if (next.done) break;
      compiler.observe(next.value);
      if (!next.value.documents.some(document => document.text.trim())) continue;
      // Retained completed products count toward the same bound, preventing an unbounded reorder buffer.
      if (queue.length === execution.concurrency) await retire();
      const promise = run(next.value, ordinal++);
      // Even a failed cleanup is retained as an ordered outcome, never an unhandled later-batch rejection.
      queue.push(promise.catch(error => ({ ok: false, error })));
    }
    while (queue.length) await retire();
    return compiler.finish();
  } catch (error) {
    try { await execution.close(error); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "source induction execution and cleanup failed"); }
    await Promise.all(queue);
    throw error;
  } finally { signal?.removeEventListener("abort", aborted); }
}
