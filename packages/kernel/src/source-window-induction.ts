// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createLanguageInductionEngine, type LanguageInductionDocument, type InducedLanguageModel } from "./language-induction.js";
import type { InducedLanguageMemoryModel } from "./language-induction-memory.js";
import { canonicalStringify } from "./primitives.js";
import { inductionCharBudget, inductionDocumentCharCap } from "./training-orchestrator.js";
import { surfaceSentenceRanges } from "./surface-linguistics.js";
import { canonicalGraphemeSegmenter } from "./normalization-contract.js";
import type { Hasher } from "./types.js";

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

export function sourceInductionInputDigest(documents: readonly LanguageInductionDocument[], hasher: Hasher): string {
  return hasher.digestHex(canonicalStringify({ recipe: SOURCE_WINDOW_INDUCTION_RECIPE_ID,
    batchBudgetUtf16: inductionCharBudget(), windowCapUtf16: inductionDocumentCharCap(), documents }));
}

export function* sourceInductionBatches(documents: readonly LanguageInductionDocument[], hasher: Hasher): Generator<{
  documents: LanguageInductionDocument[];
  windows: SourceInductionWindow[];
}> {
  const budget = inductionCharBudget();
  const cap = Math.min(budget, inductionDocumentCharCap());
  let batch: LanguageInductionDocument[] = [];
  let windows: SourceInductionWindow[] = [];
  let used = 0;
  for (const document of documents) {
    const text = document.text;
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
        SOURCE_WINDOW_INDUCTION_RECIPE_ID, document.id, document.sourceVersionId ?? null, start, end, contentDigest
      ]))}`;
      batch.push({ ...document, id, text: content, sourceFamilyId: document.sourceFamilyId ?? String(document.sourceVersionId ?? document.id),
        sourceWindow: { ownerDocumentId: document.id, startUtf16: start, endUtf16: end },
        ...(document.boundaryAnchors ? { boundaryAnchors: document.boundaryAnchors.filter(anchor => anchor.positionGrapheme >= startGrapheme && anchor.positionGrapheme < endGrapheme)
          .map(anchor => ({ ...anchor, positionGrapheme: anchor.positionGrapheme - startGrapheme })) } : {}) });
      windows.push({ documentId: id, ownerDocumentId: document.id, sourceVersionId: document.sourceVersionId ? String(document.sourceVersionId) : null,
        evidenceIds: (document.evidenceIds ?? []).map(String), startUtf16: start, endUtf16: end, contentDigest });
      used += end - start;
      start = end;
      startGrapheme = endGrapheme;
    }
  }
  if (batch.length) yield { documents: batch, windows };
}

export function compileSourceInductionWindows(input: { documents: readonly LanguageInductionDocument[]; hasher: Hasher }): {
  models: readonly InducedLanguageMemoryModel[];
  fullModel?: InducedLanguageModel;
  coverage: SourceInductionCoverage;
} {
  const models: InducedLanguageMemoryModel[] = [];
  const windows: SourceInductionWindow[] = [];
  let first: InducedLanguageModel | undefined;
  for (const batch of sourceInductionBatches(input.documents, input.hasher)) {
    windows.push(...batch.windows);
    if (!batch.documents.some(document => document.text.trim())) continue;
    if (models.length) first = undefined;
    const model = createLanguageInductionEngine({ hasher: input.hasher }).induce({ documents: batch.documents });
    if (!models.length) first = model;
    else first = undefined;
    const { id, audit, morphology, morphologyClassBindings, syntaxTemplates, boundarySignals, joinProgram,
      semanticFrames, graphBoundConstructions, lexicalClasses, relationHypothesisModel, translationSeeds } = model;
    models.push({ id, audit, morphology, morphologyClassBindings, syntaxTemplates, boundarySignals, joinProgram,
      semanticFrames, graphBoundConstructions: graphBoundConstructions.map(construction => ({ ...construction,
        sourceWindows: batch.windows.filter(window => window.evidenceIds.some(id => construction.evidenceIds.includes(id as typeof construction.evidenceIds[number])))
          .map(({ ownerDocumentId, startUtf16, endUtf16 }) => ({ ownerDocumentId, startUtf16, endUtf16 }))
      })), lexicalClasses, relationHypothesisModel, translationSeeds });
  }
  const inputUtf16Length = input.documents.reduce((total, document) => total + document.text.length, 0);
  const coveredUtf16Length = windows.reduce((total, window) => total + window.endUtf16 - window.startUtf16, 0);
  if (coveredUtf16Length !== inputUtf16Length) throw new Error("source induction windows do not cover the complete owned input");
  return Object.freeze({ models: freezeProducts(models), ...(first ? { fullModel: first } : {}), coverage: freezeProducts<SourceInductionCoverage>({
    schema: "scce.source_induction_coverage.v1", recipe: SOURCE_WINDOW_INDUCTION_RECIPE_ID,
    inputDigest: sourceInductionInputDigest(input.documents, input.hasher), complete: true,
    inputUtf16Length, coveredUtf16Length, batches: models.length,
    batchBudgetUtf16: inductionCharBudget(), windowCapUtf16: inductionDocumentCharCap(), windows
  }) });
}
