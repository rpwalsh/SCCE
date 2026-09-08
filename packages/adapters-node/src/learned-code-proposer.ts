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
import { typeScriptProjectSnapshot } from "./code-mouth-compiler-proposer.js";
import { typeScriptLegalIdentifiersAt } from "./typescript-code-actions.js";

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
  /**
   * Workspace to ask the type system what may legally be written at a defect site.
   *
   * Optional, and absent it the lane composes from the corpus alone. What it buys is a vocabulary: a corpus that
   * has never met an API cannot supply its names, and no amount of fluency substitutes for knowing that `row`
   * has exactly one member. This is the symbol table, not a suggested fix -- the compiler says what is legal,
   * the learned distribution says what is likely, and the build still decides.
   */
  workspaceRoot?: string;
  tsconfigPath?: string;
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
      const legal = await legalIdentifiers(options, languageId, context, diagnostics);
      if (legal.length) log(`the type system admits ${legal.length} identifier(s) at the defect site`);
      const candidates = generateLearnedCodeRepairs({
        models,
        languageId,
        targetPath: context.targetPath,
        targetText: context.targetText,
        diagnostics,
        requiredSymbols: [...new Set([...requiredSymbols(request), ...legal])],
        ...(legal.length ? { admissibleSiteSymbols: legal } : {}),
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
 * What the type system will accept at the first located defect, when a workspace is available to ask.
 *
 * Bounded to TypeScript because that is the toolchain this package can query for a symbol table; every other
 * language falls back to the corpus alone, which is the honest degradation -- fewer right names available, never
 * a wrong one asserted.
 */
async function legalIdentifiers(
  options: LearnedCodeProposerOptions,
  languageId: string,
  context: CodeMouthContext,
  diagnostics: readonly ProgramDiagnostic[]
): Promise<string[]> {
  if (!options.workspaceRoot || languageId !== "typescript") return [];
  const site = diagnostics.find(diagnostic => Number.isInteger(diagnostic.line) && (diagnostic.line ?? 0) > 0);
  if (!site) return [];
  const snapshot = await typeScriptProjectSnapshot({
    workspaceRoot: options.workspaceRoot,
    targetPath: context.targetPath,
    targetText: context.targetText,
    imports: context.imports,
    ...(options.tsconfigPath ? { tsconfigPath: options.tsconfigPath } : {})
  });
  if (!snapshot) return [];
  const at = (column: number): string[] => {
    try {
      return typeScriptLegalIdentifiersAt({
        rootPath: snapshot.root.replace(/\\/gu, "/"),
        requestedPaths: [snapshot.relativeTarget],
        files: snapshot.files,
        compilerCommand: snapshot.compilerCommand,
        site: { path: snapshot.relativeTarget, line: site.line!, column }
      });
    } catch {
      return [];
    }
  };
  // A diagnostic points at the first character of the offending token, and TypeScript only resolves a member
  // access from inside that token: asked at the token start it answers with the whole global scope, asked one
  // character in it answers with the members of whatever precedes the dot. The tighter answer is the useful
  // one, and where there is no token to be inside, the position itself still bounds what may be named there.
  const column = Math.max(1, site.column ?? 1);
  const inside = at(column + 1);
  return inside.length ? inside : at(column);
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
