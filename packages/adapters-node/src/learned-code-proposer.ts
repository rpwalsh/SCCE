// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  CORPUS_SOURCE_SYSTEM_IDS,
  corpusSourceAlias,
  codeLanguageForPath,
  codeSurfaceTokens,
  codeIdentifierTokens,
  generateLearnedCodeRepairs,
  learnedCodeRepairOperation,
  type KneserNeyModel,
  type LearnedCodeRepairCandidate,
  type JsonValue,
  type NgramModelRecord,
  type ProgramDiagnostic,
  type ScceStorage
} from "@scce/kernel";
import type { CodeMouthContext, CodeMouthProposal } from "./code-mouth.js";

/**
 * The proposer that writes code instead of transcribing a fix.
 *
 * The other proposers in this package answer a diagnostic by applying the repair its compiler already computed,
 * which limits them to defects some toolchain owns an answer for. This one reads the diagnostic for its location
 * only and composes the replacement out of the code corpus for that language -- the same predict-from-what-was-
 * learned machinery the mouth speaks prose with, over a formal language instead of a natural one.
 *
 * Nothing here decides whether the result is correct. `runCodeMouth` applies it, runs the build, and rolls back
 * what does not compile, so a wrong composition costs one attempt and leaves the workspace exactly as it was.
 */

/** Trained code models, per language, for the life of the process. Hydration is a query; generation is not. */
export interface LearnedCodeProposer {
  propose(input: {
    request: string;
    context: CodeMouthContext;
    diagnostics: readonly ProgramDiagnostic[];
    attempt: number;
  }): Promise<CodeMouthProposal | undefined>;
  /** What the last call composed, best first: the audit trail behind whatever the gate then accepted or rejected. */
  lastCandidates(): readonly LearnedCodeRepairCandidate[];
  /** Models found for a language, so a caller can report "nothing learned for this language" as itself. */
  trainedModelCount(languageId: string): Promise<number>;
}

export interface LearnedCodeProposerOptions {
  storage: ScceStorage;
  /** How many trained models to hydrate per language. */
  modelLimit?: number;
  maxCandidates?: number;
  corpusWeight?: number;
  log?: (message: string) => void;
}

export function createLearnedCodeProposer(options: LearnedCodeProposerOptions): LearnedCodeProposer {
  const modelLimit = Math.max(1, Math.min(256, Math.floor(options.modelLimit ?? 96)));
  const log = options.log ?? (() => {});
  const byLanguage = new Map<string, Promise<KneserNeyModel[]>>();
  let lastCandidates: LearnedCodeRepairCandidate[] = [];

  const modelsFor = (languageId: string): Promise<KneserNeyModel[]> => {
    const cached = byLanguage.get(languageId);
    if (cached) return cached;
    const loading = loadCodeModels(options.storage, languageId, modelLimit);
    byLanguage.set(languageId, loading);
    return loading;
  };

  return {
    lastCandidates: () => lastCandidates,

    async trainedModelCount(languageId) {
      return (await modelsFor(languageId)).length;
    },

    async propose({ request, context, diagnostics, attempt }) {
      lastCandidates = [];
      const languageId = context.language || codeLanguageForPath(context.targetPath);
      if (!languageId) return undefined;
      const models = await modelsFor(languageId);
      if (!models.length) {
        log(`no trained ${languageId} corpus; the learned lane has nothing to compose from`);
        return undefined;
      }
      const candidates = generateLearnedCodeRepairs({
        models,
        languageId,
        targetPath: context.targetPath,
        targetText: context.targetText,
        diagnostics,
        requiredSymbols: requiredSymbols(request),
        ...(options.maxCandidates !== undefined ? { maxCandidates: options.maxCandidates } : {}),
        ...(options.corpusWeight !== undefined ? { corpusWeight: options.corpusWeight } : {})
      });
      lastCandidates = candidates;
      // One attempt, one candidate: the loop is what tries the next one, and it only gets there by watching this
      // one fail its build. Reusing a rejected composition would spend the budget re-proving the same failure.
      const candidate = candidates[Math.max(0, attempt - 1)];
      if (!candidate) return undefined;
      log(`attempt ${attempt}: composed ${languageId} from ${models.length} trained models (${candidate.strategy}, avg log p ${candidate.averageLogProbability.toFixed(3)})`);
      return {
        operations: [learnedCodeRepairOperation(candidate, context.targetPath)],
        surface: candidate.surface
      };
    }
  };
}

/**
 * The names generation is pulled toward: what the request itself spells.
 *
 * Not the file's whole symbol table. The generator already models the file directly, so every name in it is
 * represented there at its real frequency; passing the same names in again as a flat boost only tells the search
 * that all of them are equally wanted, which is exactly what they are not.
 */
function requiredSymbols(request: string): string[] {
  return codeIdentifierTokens(codeSurfaceTokens(request), 32);
}

/**
 * The code corpus for one formal language.
 *
 * The corpus lane files each source file's model under a stream named for that file, so the language a model
 * speaks is the language of the path in its stream id. That is also what keeps a Python model out of a
 * TypeScript repair without a second index to maintain.
 */
async function loadCodeModels(storage: ScceStorage, languageId: string, limit: number): Promise<KneserNeyModel[]> {
  // Storage indexes language-memory rows by the corpus *label*, not by the opaque source-system identity, so
  // the query has to name it the same way the trainer stamped it.
  const records = await storage.languageMemory.listNgramModels({
    sourceSystem: corpusSourceAlias(CORPUS_SOURCE_SYSTEM_IDS.ossCode),
    limit
  });
  const models: KneserNeyModel[] = [];
  for (const record of records) {
    if (modelLanguage(record) !== languageId) continue;
    const model = kneserNeyModelFromRecord(record);
    if (model) models.push(model);
  }
  return models;
}

function modelLanguage(record: NgramModelRecord): string | undefined {
  const stored = jsonRecord(record.modelJson);
  const declared = stored.formalLanguage;
  if (typeof declared === "string" && declared) return declared;
  // The stream id is `<source system>:<relative path>`; the path's extension is the language.
  return codeLanguageForPath(record.streamId);
}

/** A stored model back into the runtime shape, or nothing when the record does not carry one. */
function kneserNeyModelFromRecord(record: NgramModelRecord): KneserNeyModel | undefined {
  const stored = jsonRecord(record.modelJson).model;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return undefined;
  const model = stored as unknown as KneserNeyModel;
  return Number.isInteger(model.order) && model.order >= 1 && model.counts ? model : undefined;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
