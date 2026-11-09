// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createLanguageInductionEngine, type LanguageInductionDocument, type InducedLanguageModel } from "./language-induction.js";
import type { InducedLanguageMemoryModel } from "./language-induction-memory.js";
import { canonicalStringify } from "./primitives.js";
import { joinProgramMixtureStorageForm } from "./join-program-storage.js";
import { inductionCharBudget, inductionDocumentCharCap } from "./training-orchestrator.js";
import { surfaceSentenceRanges } from "./surface-linguistics.js";
import { canonicalGraphemeSegmenter } from "./normalization-contract.js";
import type { Hasher } from "./types.js";
import type { CorpusSegmentationBatchLoader, VerifiedCorpusSegmentation } from "./corpus-segmentation-cursor.js";
import { prepareCorpusSegmentationMeasurement } from "./surface-lattice.js";
import { validateCorpusSegmentationForDocuments } from "./corpus-segmentation-input.js";

export const SOURCE_WINDOW_INDUCTION_RECIPE_ID = "kernel.source_window_induction.v1" as const;

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

interface SourceInductionBatch {
  documents: LanguageInductionDocument[];
  windows: SourceInductionWindow[];
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
interface SourceInductionCompileInput { documents: readonly LanguageInductionDocument[]; hasher: Hasher; modelCache?: Map<string, InducedLanguageMemoryModel> }

function createSourceInductionCompiler(input: SourceInductionCompileInput & { corpusIdentity?: CorpusSegmentationBatchLoader["identity"] }) {
  const models: InducedLanguageMemoryModel[] = [];
  const windows: SourceInductionWindow[] = [];
  let first: InducedLanguageModel | undefined;
  const corpusBindings: string[] = [];
  return { add(batch: SourceInductionBatch, verified?: VerifiedCorpusSegmentation): void {
    windows.push(...batch.windows);
    if (!batch.documents.some(document => document.text.trim())) return;
    let batchKey = sourceInductionInputDigest(batch.documents, input.hasher);
    if (verified) {
      const validated = validateCorpusSegmentationForDocuments(batch.documents.filter(document => document.text.trim()), verified, input.hasher);
      corpusBindings.push(validated.inputDigest);
      batchKey = input.hasher.digestHex(canonicalStringify([batchKey, validated.inputDigest]));
    }
    const cached = input.modelCache?.get(batchKey);
    if (cached) { first = undefined; models.push(cached); return; }
    if (models.length) first = undefined;
    const model = createLanguageInductionEngine({ hasher: input.hasher }).induce({ documents: batch.documents,
      ...(verified ? { verifiedCorpusSegmentation: verified } : {}) });
    if (!models.length) first = model;
    else first = undefined;
    const { id, audit, morphology, morphologyClassBindings, syntaxTemplates, boundarySignals, joinProgram,
      semanticFrames, graphBoundConstructions, lexicalClasses, relationHypothesisModel, translationSeeds } = model;
    const windowsByEvidence = new Map<string, number[]>();
    for (let index = 0; graphBoundConstructions.length && index < batch.windows.length; index++) {
      const window = batch.windows[index]!;
      for (const evidenceId of new Set(window.evidenceIds)) {
        const matches = windowsByEvidence.get(evidenceId);
        if (matches) matches.push(index);
        else windowsByEvidence.set(evidenceId, [index]);
      }
    }
    const compact = freezeProducts({ id, audit, morphology, morphologyClassBindings, syntaxTemplates, boundarySignals,
      joinProgram: joinProgramMixtureStorageForm(joinProgram, { immutable: true }),
      semanticFrames, graphBoundConstructions: graphBoundConstructions.map(construction => {
        const matches = new Set<number>();
        for (const evidenceId of construction.evidenceIds) {
          for (const index of windowsByEvidence.get(evidenceId) ?? []) matches.add(index);
        }
        // Preserve physical source-window order independently of construction evidence order.
        return { ...construction, sourceWindows: [...matches].sort((left, right) => left - right).map(index => {
          const { ownerDocumentId, startUtf16, endUtf16 } = batch.windows[index]!;
          return { ownerDocumentId, startUtf16, endUtf16 };
        }) };
      }), lexicalClasses, relationHypothesisModel, translationSeeds });
    models.push(compact);
    input.modelCache?.set(batchKey, compact);
  }, finish(): SourceInductionProducts {
  const inputUtf16Length = input.documents.reduce((total, document) => total + document.text.length, 0);
  const coveredUtf16Length = windows.reduce((total, window) => total + window.endUtf16 - window.startUtf16, 0);
  if (coveredUtf16Length !== inputUtf16Length) throw new Error("source induction windows do not cover the complete owned input");
  return Object.freeze({ models: freezeProducts(models), ...(first ? { fullModel: first } : {}), coverage: freezeProducts<SourceInductionCoverage>({
    schema: "scce.source_induction_coverage.v1", recipe: SOURCE_WINDOW_INDUCTION_RECIPE_ID,
    inputDigest: input.corpusIdentity ? input.hasher.digestHex(canonicalStringify({ source: sourceInductionInputDigest(input.documents, input.hasher, input.corpusIdentity), corpusBindings }))
      : sourceInductionInputDigest(input.documents, input.hasher), complete: true,
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
