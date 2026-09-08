// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  CORPUS_SOURCE_SYSTEM_IDS,
  corpusSourceAlias,
  codeIntentFromDocumentation,
  codeLanguageForPath,
  induceCodeConstructions,
  codeSurfaceTokens,
  codeIdentifierTokens,
  generateLearnedCodeRepairs,
  learnedCodeRepairOperation,
  type CodeConstruction,
  type CodeIntent,
  type KneserNeyModel,
  type LearnedCodeRepairCandidate,
  type LearnedCodeRepairSpan,
  type JsonValue,
  type NgramModelRecord,
  type ProgramDiagnostic,
  type ScceStorage
} from "@scce/kernel";
import type { CodeMouthContext, CodeMouthProposal } from "./code-mouth.js";
import { typeScriptProjectSnapshot } from "./code-mouth-compiler-proposer.js";
import { typeScriptRepairSites } from "./typescript-code-actions.js";

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
/**
 * What a request has to do with code, read off the documentation corpus.
 *
 * Every source file trains twice -- its tokens into the code corpus, its comments and identifier words into the
 * documentation corpus -- and both carry the same path. Matching a request against documentation is therefore
 * ordinary retrieval that lands on files, and a file names the models, shapes and symbols that are relevant. A
 * corpus that has never been shown code about this request returns nothing, which is the honest answer.
 */
export async function codeIntentForRequest(input: {
  storage: ScceStorage;
  requestText: string;
  knownSymbols?: ReadonlySet<string>;
  languageId?: string;
  limit?: number;
}): Promise<CodeIntent> {
  const found = await input.storage.evidence.searchEvidence({
    text: input.requestText,
    status: "promoted",
    limit: Math.max(1, Math.min(64, Math.floor(input.limit ?? 16)))
  }).catch(() => []);
  const documentation = found
    .map(result => result.span)
    .filter(span => documentationCorpusSpan(span));
  return codeIntentFromDocumentation({
    requestText: input.requestText,
    documentation,
    ...(input.knownSymbols ? { knownSymbols: input.knownSymbols } : {}),
    ...(input.languageId ? { languageId: input.languageId } : {})
  });
}

/** A span the documentation projection of the code corpus produced, as the corpus lane stamped it. */
function documentationCorpusSpan(span: { provenance?: unknown }): boolean {
  const provenance = span.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return false;
  return (provenance as Record<string, unknown>).sourceSystem === corpusSourceAlias(CORPUS_SOURCE_SYSTEM_IDS.ossDocs);
}

export interface LearnedCodeProposer {
  propose(input: {
    request: string;
    context: CodeMouthContext;
    diagnostics: readonly ProgramDiagnostic[];
    attempt: number;
  }): Promise<CodeMouthProposal | undefined>;
  /** What the last call composed, best first: the audit trail behind whatever the gate then accepted or rejected. */
  lastCandidates(): readonly LearnedCodeRepairCandidate[];
  /**
   * Models hydrated for a language, bounded by `modelLimit` -- not the corpus total.
   *
   * Zero is the answer that matters: a language this brain was never shown is one it cannot write, and saying so
   * is different from a repair loop declining.
   */
  availableModelCount(languageId: string): Promise<number>;
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
  // Which candidate to offer, and what state it was chosen against.
  //
  // The loop's attempt number counts every turn of the loop, including the ones that accepted a repair and moved
  // on. Indexing candidates by it meant that after a step was kept the next state was offered this proposer's
  // *second* choice for it, and its first was never tried at all. Retrying is what advances the index; making
  // progress resets it, because the question has changed.
  let lastState = "";
  let retry = 0;
  // Shapes induced from the project being repaired, not from the corpus at large.
  //
  // A repair should read like the code around it, and the strongest evidence for how this code is written is
  // this code. The project slice the language service already loads is exactly that corpus, so the shapes come
  // out of it for free; a workspace too small to attest a shape across files simply yields none, and the lane
  // falls back to continuing sequences.
  const constructionsByWorkspace = new Map<string, CodeConstruction[]>();

  const modelsFor = (languageId: string): Promise<KneserNeyModel[]> => {
    const cached = byLanguage.get(languageId);
    if (cached) return cached;
    const loading = loadCodeModels(options.storage, languageId, modelLimit);
    byLanguage.set(languageId, loading);
    return loading;
  };

  return {
    lastCandidates: () => lastCandidates,

    async availableModelCount(languageId) {
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
      const spans = await repairSpans(options, languageId, context);
      const constructions = await projectConstructions(options, context, constructionsByWorkspace);
      if (constructions.length) log(`${constructions.length} shape(s) learned from this project`);
      // What the request is about, where the corpus has documentation that answers it. A repair is driven by
      // diagnostics and does not need this to work; where it lands, it says which names the request put in play
      // beyond the ones it happened to spell.
      const known = knownSymbols(context.targetText, models);
      const intent = await codeIntentForRequest({ storage: options.storage, requestText: request, knownSymbols: known, languageId });
      if (intent.references.length) {
        log(`the request matches documentation for ${intent.references.length} file(s): ${intent.references.slice(0, 3).map(reference => reference.relativePath).join(", ")}`);
      }
      if (spans.length) {
        log(`${spans.length} candidate defect range(s); the type system admits ${spans[0]!.admissible?.length ?? 0} identifier(s) at the first`);
      }
      // The admitted names bound each hole individually and are not folded into the global boost: a hole whose
      // vocabulary is the whole global scope would otherwise mark 128 names equally wanted, which is the same as
      // wanting none of them and drowns out the handful the request actually spelled.
      const candidates = generateLearnedCodeRepairs({
        models,
        languageId,
        targetPath: context.targetPath,
        targetText: context.targetText,
        diagnostics,
        requiredSymbols: [...new Set([...requiredSymbols(request, known), ...intent.symbols])],
        ...(spans.length ? { spans } : {}),
        ...(constructions.length ? { constructions } : {}),
        ...(options.maxCandidates !== undefined ? { maxCandidates: options.maxCandidates } : {}),
        ...(options.corpusWeight !== undefined ? { corpusWeight: options.corpusWeight } : {})
      });
      lastCandidates = candidates;
      const state = diagnostics.map(diagnostic => `${diagnostic.patternId ?? diagnostic.class}:${diagnostic.message}`).sort().join("");
      retry = state === lastState ? retry + 1 : 0;
      lastState = state;
      // One attempt, one candidate: the loop is what tries the next one, and it only gets there by watching this
      // one fail its build. Reusing a rejected composition would spend the budget re-proving the same failure.
      const candidate = candidates[retry];
      if (!candidate) return undefined;
      log(`attempt ${attempt} (offer ${retry + 1} of ${candidates.length}): composed ${languageId} from ${models.length} trained models (${candidate.strategy}, avg log p ${candidate.averageLogProbability.toFixed(3)})`);
      return {
        operations: [learnedCodeRepairOperation(candidate, context.targetPath)],
        surface: candidate.surface
      };
    }
  };
}

/**
 * The names generation is pulled toward: the ones the request spells that are actually names.
 *
 * A request is written in a human language and this lane reads it with a code tokenizer, so every ordinary word
 * in it comes back looking like an identifier: "fix the misspelled property access" yielded five, each then
 * boosted as strongly as a real symbol. That is not the request being understood, it is prose being mistaken for
 * code. A word earns the boost by being a name this file or this language's corpus actually uses -- which is a
 * question about the evidence and needs no list of words in any language to answer.
 *
 * Not the file's whole symbol table either: the generator already models the file directly, so every name in it
 * is represented there at its real frequency, and passing them all back in as a flat boost only says that all of
 * them are equally wanted, which is exactly what they are not.
 */
function requiredSymbols(request: string, known: ReadonlySet<string>): string[] {
  return codeIdentifierTokens(codeSurfaceTokens(request), 64).filter(symbol => known.has(symbol));
}

/** Every symbol some code in play actually uses: this file's, and the corpus models' vocabularies. */
function knownSymbols(targetText: string, models: readonly KneserNeyModel[]): Set<string> {
  const known = new Set(codeSurfaceTokens(targetText));
  for (const model of models) for (const symbol of model.vocabulary) known.add(symbol);
  return known;
}

/**
 * The shapes this project's own code recurs on, induced once per workspace.
 *
 * The same snapshot the language service binds: the file, its relative imports, its project chain and its
 * directory. Those files are the corpus whose conventions a repair here should match.
 */
async function projectConstructions(
  options: LearnedCodeProposerOptions,
  context: CodeMouthContext,
  cache: Map<string, CodeConstruction[]>
): Promise<CodeConstruction[]> {
  if (!options.workspaceRoot) return [];
  const cached = cache.get(options.workspaceRoot);
  if (cached) return cached;
  const snapshot = await typeScriptProjectSnapshot({
    workspaceRoot: options.workspaceRoot,
    targetPath: context.targetPath,
    targetText: context.targetText,
    imports: context.imports,
    ...(options.tsconfigPath ? { tsconfigPath: options.tsconfigPath } : {})
  });
  const documents = (snapshot?.files ?? [])
    .filter(file => codeLanguageForPath(file.path))
    .map(file => ({ id: file.path, text: file.content }));
  // Two documents cannot attest that a shape belongs to a language rather than to a file, so a small project
  // contributes none and says so by returning nothing.
  const constructions = documents.length >= 3
    ? induceCodeConstructions({ documents, minimumDocuments: 2, minimumOccurrences: 3, limit: 2048 })
    : [];
  cache.set(options.workspaceRoot, constructions);
  return constructions;
}

/**
 * The exact defect ranges in this file, with what the type system admits at each.
 *
 * Bounded to TypeScript because that is the toolchain this package can ask for spans and a symbol table. Every
 * other language falls back to the line and column its compiler prints, which is the honest degradation: a
 * coarser hole, never a wrong answer asserted.
 */
async function repairSpans(
  options: LearnedCodeProposerOptions,
  languageId: string,
  context: CodeMouthContext
): Promise<LearnedCodeRepairSpan[]> {
  if (!options.workspaceRoot || languageId !== "typescript") return [];
  const snapshot = await typeScriptProjectSnapshot({
    workspaceRoot: options.workspaceRoot,
    targetPath: context.targetPath,
    targetText: context.targetText,
    imports: context.imports,
    ...(options.tsconfigPath ? { tsconfigPath: options.tsconfigPath } : {})
  });
  if (!snapshot) return [];
  try {
    return typeScriptRepairSites({
      rootPath: snapshot.root.replace(/\\/gu, "/"),
      requestedPaths: [snapshot.relativeTarget],
      targetPath: snapshot.relativeTarget,
      files: snapshot.files,
      compilerCommand: snapshot.compilerCommand
    }).flatMap(site => site.holes.map((hole): LearnedCodeRepairSpan => ({
      start: hole.start,
      length: hole.length,
      diagnosticId: `TS${site.code}:${hole.start}:${hole.length}:${hole.scope}`,
      admissible: hole.admissible,
      admissibleInside: hole.admissibleInside
    })));
  } catch {
    return [];
  }
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
