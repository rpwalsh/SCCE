// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  CORPUS_SOURCE_SYSTEM_IDS,
  corpusSourceAlias,
  anchorFeatureSet,
  codeIntentFromDocumentation,
  codeLanguageForPath,
  codeLanguageForModelRecord,
  induceCodeConstructions,
  codeSurfaceTokens,
  codeIdentifierTokens,
  createHasher,
  toJsonValue,
  generateLearnedCodeRepairs,
  generateLearnedBehaviorCodeRepairs,
  generateLearnedSyntaxCodeInsertions,
  learnedCodeRepairOperations,
  materializeKneserNey,
  type CodeConstruction,
  type CodeIntent,
  type KneserNeyModel,
  type LearnedCodeRepairCandidate,
  type LearnedCodeRepairSpan,
  type JsonValue,
  type NgramModelRecord,
  type ProgramDiagnostic,
  type SourceVersionId,
  type ScceStorage
} from "@scce/kernel";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { CodeMouthContext, CodeMouthProposal } from "./code-mouth.js";
import { typeScriptProjectSnapshot } from "./code-mouth-compiler-proposer.js";
import { typeScriptRepairSites } from "./typescript-code-actions.js";
import { grammaticalTreeSitterRepairs, treeSitterBehaviorRepairSites, treeSitterRepairSpans, treeSitterSyntaxInsertionSites } from "./tree-sitter-repair-spans.js";

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
  // Features, not text.
  //
  // searchEvidence ranks over the feature postings an evidence span was indexed with and ignores a `text` field
  // entirely, so a query carrying only prose matched nothing at all -- 418 documentation files in the store and
  // every request returning no references. The request has to be reduced to the same anchors the index was
  // built from, which is what the retrieval lane does everywhere else.
  const features = anchorFeatureSet(input.requestText, 96);
  const found = features.length
    ? await input.storage.evidence.searchEvidence({
      features,
      status: "promoted",
      limit: Math.max(1, Math.min(64, Math.floor(input.limit ?? 16)))
    }).catch(() => [])
    : [];
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

export type LearnedCodeCorpusAvailability = {
  languageId: string;
  modelLimit: number;
  countSemantics: "admitted_run_models";
} & ({ status: "unqueried" | "loading" | "failed"; modelsAvailable: null } | { status: "loaded"; modelsAvailable: number });

export interface LearnedCodeProposer {
  propose(input: {
    request: string;
    context: CodeMouthContext;
    diagnostics: readonly ProgramDiagnostic[];
    attempt: number;
  }): Promise<CodeMouthProposal | undefined>;
  /** What the last call composed, best first: the audit trail behind whatever the gate then accepted or rejected. */
  lastCandidates(): readonly LearnedCodeRepairCandidate[];
  /** Explicitly loads the admitted run models; reporting uses the non-loading snapshot. */
  availableModelCount(languageId: string): Promise<number>;
  /** A detached observation of this run's admitted models; never starts a corpus read. */
  corpusAvailability?(languageId: string): LearnedCodeCorpusAvailability;
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

export function createLearnedCodeProposer(options: LearnedCodeProposerOptions): LearnedCodeProposer & {
  corpusAvailability(languageId: string): LearnedCodeCorpusAvailability;
} {
  const modelLimit = Math.max(1, Math.min(256, Math.floor(options.modelLimit ?? 96)));
  const log = options.log ?? (() => {});
  const byLanguage = new Map<string, Promise<KneserNeyModel[]>>();
  const availabilityByLanguage = new Map<string, LearnedCodeCorpusAvailability>();
  const hasher = createHasher();
  let lastCandidates: LearnedCodeRepairCandidate[] = [];
  // Which candidate to offer, and what state it was chosen against.
  //
  // The loop's attempt number counts every turn of the loop, including the ones that accepted a repair and moved
  // on. Indexing candidates by it meant that after a step was kept the next state was offered this proposer's
  // *second* choice for it, and its first was never tried at all. Retrying is what advances the index; making
  // progress resets it, because the question has changed.
  let lastState: string | undefined;
  let retry = 0;
  // Shapes induced from the project being repaired, not from the corpus at large.
  //
  // A repair should read like the code around it, and the strongest evidence for how this code is written is
  // this code. The project slice the language service already loads is exactly that corpus, so the shapes come
  // out of it for free; a workspace too small to attest a shape across files simply yields none, and the lane
  // falls back to continuing sequences.
  const constructionsByWorkspace = new Map<string, CodeConstruction[]>();

  const modelsFor = (languageId: string, context?: CodeMouthContext): Promise<KneserNeyModel[]> => {
    const cached = byLanguage.get(languageId);
    if (cached) return cached;
    availabilityByLanguage.set(languageId, { languageId, modelLimit, countSemantics: "admitted_run_models", status: "loading", modelsAvailable: null });
    const loading = loadCodeModels(options.storage, languageId, modelLimit, context).then(models => {
      availabilityByLanguage.set(languageId, { languageId, modelLimit, countSemantics: "admitted_run_models", status: "loaded", modelsAvailable: models.length });
      return models;
    }, error => {
      availabilityByLanguage.set(languageId, { languageId, modelLimit, countSemantics: "admitted_run_models", status: "failed", modelsAvailable: null });
      throw error;
    });
    byLanguage.set(languageId, loading);
    return loading;
  };

  return {
    lastCandidates: () => lastCandidates,
    corpusAvailability: languageId => ({ ...(availabilityByLanguage.get(languageId)
      ?? { languageId, modelLimit, countSemantics: "admitted_run_models", status: "unqueried", modelsAvailable: null }) }),

    async availableModelCount(languageId) {
      return (await modelsFor(languageId)).length;
    },

    async propose({ request, context, diagnostics, attempt }) {
      lastCandidates = [];
      const languageId = context.language || codeLanguageForPath(context.targetPath);
      if (!languageId) return undefined;
      const models = await modelsFor(languageId, context);
      if (!models.length) {
        log(`no usable ${languageId} models in the requested corpus slice; the learned lane has nothing to compose from`);
        return undefined;
      }
      const spans = await repairSpans(options, languageId, context, diagnostics);
      const constructions = await projectConstructions(options, context, constructionsByWorkspace);
      if (constructions.length) log(`${constructions.length} shape(s) learned from this project`);
      // What the request is about, where the corpus has documentation that answers it. A repair is driven by
      // diagnostics and does not need this to work; where it lands, it says which names the request put in play
      // beyond the ones it happened to spell.
      const known = knownSymbols(context.targetText, models);
      const holeSymbols = new Set(spans.flatMap(span => codeSurfaceTokens(context.targetText.slice(span.start, span.start + span.length))));
      const intent = await codeIntentForRequest({ storage: options.storage, requestText: request, knownSymbols: known, languageId });
      if (intent.references.length) {
        log(`the request matches documentation for ${intent.references.length} file(s): ${intent.references.slice(0, 3).map(reference => reference.relativePath).join(", ")}`);
      }
      if (spans.length) {
        log(`${spans.length} parser- or compiler-located defect range(s); ${spans[0]!.admissible?.length ?? 0} checker-admitted identifier(s) at the first`);
      }
      // The admitted names bound each hole individually and are not folded into the global boost: a hole whose
      // vocabulary is the whole global scope would otherwise mark 128 names equally wanted, which is the same as
      // wanting none of them and drowns out the handful the request actually spelled.
      const insertionSites = diagnostics.length ? await treeSitterSyntaxInsertionSites({ targetPath: context.targetPath, text: context.targetText }) : [];
      const insertions = insertionSites.length ? await grammaticalTreeSitterRepairs({ targetPath: context.targetPath, text: context.targetText,
        candidates: generateLearnedSyntaxCodeInsertions({ models, languageId, targetPath: context.targetPath, targetText: context.targetText,
          sites: insertionSites, failureObservationId: `sha256:${hasher.digestHex(JSON.stringify({ sourceHash: hasher.digestHex(context.targetText), diagnostics }))}`,
          ...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }) }) }) : [];
      const generated = insertions.length ? insertions : context.behavioralFailure && !spans.length
        ? generateLearnedBehaviorCodeRepairs({ models, languageId, targetPath: context.targetPath, targetText: context.targetText,
          failureObservationId: context.behavioralFailure.observationId,
          sites: await treeSitterBehaviorRepairSites({ targetPath: context.targetPath, text: context.targetText }),
          ...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }) })
        : generateLearnedCodeRepairs({
        models,
        languageId,
        targetPath: context.targetPath,
        targetText: context.targetText,
        diagnostics,
        requiredSymbols: [...new Set([...requiredSymbols(request, known), ...intent.symbols])].filter(symbol => !holeSymbols.has(symbol)),
        ...(spans.length ? { spans } : {}),
        ...(constructions.length ? { constructions } : {}),
        ...(options.maxCandidates !== undefined ? { maxCandidates: options.maxCandidates } : {}),
        ...(options.corpusWeight !== undefined ? { corpusWeight: options.corpusWeight } : {})
        });
      const candidates = insertions.length || languageId === "typescript" ? generated : await grammaticalTreeSitterRepairs({ targetPath: context.targetPath, text: context.targetText, candidates: generated });
      lastCandidates = candidates;
      const state = hasher.digestHex(JSON.stringify({ languageId, targetPath: context.targetPath, sourceHash: hasher.digestHex(context.targetText), request,
        diagnostics: diagnostics.map(diagnostic => `${diagnostic.patternId ?? diagnostic.class}:${diagnostic.message}`).sort(),
        behavioralFailureObservationId: context.behavioralFailure?.observationId ?? null }));
      retry = state === lastState ? retry + 1 : 0;
      lastState = state;
      // One attempt, one candidate: the loop is what tries the next one, and it only gets there by watching this
      // one fail its build. Reusing a rejected composition would spend the budget re-proving the same failure.
      const candidate = candidates[retry];
      if (!candidate) return undefined;
      log(`attempt ${attempt} (offer ${retry + 1} of ${candidates.length}): composed ${languageId} from ${models.length} trained models (${candidate.strategy}, avg log p ${candidate.averageLogProbability.toFixed(3)})`);
      return {
        operations: learnedCodeRepairOperations(candidate, context.targetPath),
        surface: candidate.surface,
        source: "learned_construction",
        audit: toJsonValue({ ...jsonRecord(candidate.audit), targetHash: hasher.digestHex(context.targetText),
          sourceModelKeys: jsonRecord(candidate.audit).sourceModelKeys ?? models.map(model => model.sourceKey ?? null) })
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
  const cacheKey = `${options.workspaceRoot}\u0001${context.language}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const language = codeLanguageForPath(context.targetPath);
  const snapshot = language === "typescript" || language === "javascript"
    ? await typeScriptProjectSnapshot({
      workspaceRoot: options.workspaceRoot,
      targetPath: context.targetPath,
      targetText: context.targetText,
      imports: context.imports,
      ...(options.tsconfigPath ? { tsconfigPath: options.tsconfigPath } : {})
    })
    : undefined;
  // The language service's project slice where there is one, and the target's own directory where there is not.
  // Shapes are induced from a token stream and care about no language in particular, so binding this to the one
  // toolchain that can describe a project would have kept every other language from having any.
  const documents = snapshot
    ? snapshot.files.filter(file => codeLanguageForPath(file.path)).map(file => ({ id: file.path, text: file.content }))
    : await siblingSources(options.workspaceRoot, context.targetPath, language);
  // Two documents cannot attest that a shape belongs to a language rather than to a file, so a small project
  // contributes none and says so by returning nothing.
  const constructions = documents.length >= 3
    ? induceCodeConstructions({ documents, minimumDocuments: 2, minimumOccurrences: 3, limit: 2048 })
    : [];
  cache.set(cacheKey, constructions);
  return constructions;
}

/** Files beside the target in the same language: the corpus for a project no toolchain can describe. */
async function siblingSources(
  workspaceRoot: string,
  targetPath: string,
  languageId: string | undefined
): Promise<Array<{ id: string; text: string }>> {
  if (!languageId) return [];
  const directory = path.dirname(path.resolve(workspaceRoot, targetPath));
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const out: Array<{ id: string; text: string }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || codeLanguageForPath(entry.name) !== languageId) continue;
    const text = await readFile(path.join(directory, entry.name), "utf8").catch(() => "");
    if (text) out.push({ id: entry.name, text });
    if (out.length >= 200) break;
  }
  return out;
}

/** Compiler ranges carry semantic scope; other installed grammars bound leaves at compiler-reported positions. */
async function repairSpans(
  options: LearnedCodeProposerOptions,
  languageId: string,
  context: CodeMouthContext,
  diagnostics: readonly ProgramDiagnostic[]
): Promise<LearnedCodeRepairSpan[]> {
  if (languageId !== "typescript") return treeSitterRepairSpans({ targetPath: context.targetPath, text: context.targetText, diagnostics });
  if (!options.workspaceRoot) return [];
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
      admissibleInside: hole.admissibleInside,
      expectedLiteralKinds: hole.expectedLiteralKinds
    })));
  } catch {
    return [];
  }
}

/** Retrieved source profiles take admission priority over the bounded formal-language prior. */
async function loadCodeModels(storage: ScceStorage, languageId: string, limit: number, context?: CodeMouthContext): Promise<KneserNeyModel[]> {
  const profileIds = context && storage.evidence && storage.model
    ? await sourceProfilesForCode(storage, languageId, limit, context) : [];
  const models = new Map<string, KneserNeyModel>();
  const admit = (records: readonly NgramModelRecord[]) => {
    for (const record of records) {
      if (models.size >= limit) break;
      if (models.has(record.id) || modelLanguage(record) !== languageId) continue;
      const model = kneserNeyModelFromRecord(record);
      if (model) {
        model.sourceKey ??= record.id;
        models.set(record.id, model);
      }
    }
  };
  for (const profileId of profileIds) {
    if (models.size >= limit) break;
    admit(await storage.languageMemory.listNgramModels({
      sourceSystem: corpusSourceAlias(CORPUS_SOURCE_SYSTEM_IDS.ossCode),
      formalLanguage: languageId,
      profileIds: [profileId],
      limit: limit - models.size
    }));
  }
  if (!models.size) admit(await storage.languageMemory.listNgramModels({
    sourceSystem: corpusSourceAlias(CORPUS_SOURCE_SYSTEM_IDS.ossCode),
    formalLanguage: languageId,
    limit
  }));
  return [...models.values()];
}

/** Source evidence owns the profile filter before the storage model budgets apply. */
async function sourceProfilesForCode(storage: ScceStorage, languageId: string, limit: number, context?: CodeMouthContext): Promise<string[]> {
  if (!context || !storage.evidence || !storage.model) return [];
  const features = anchorFeatureSet(codeSurfaceTokens(context.targetText).join(" "));
  if (!features.length) return [];
  const found = await storage.evidence.searchEvidence({ features, status: "promoted", openingBlockPrior: false, limit });
  const queryFeatures = new Set(features);
  const coverageBySource = new Map<SourceVersionId, number>();
  for (const { span } of found) {
    const provenance = jsonRecord(span.provenance);
    if (span.status !== "promoted"
      || provenance.sourceSystem !== corpusSourceAlias(CORPUS_SOURCE_SYSTEM_IDS.ossCode)
      || provenance.formalLanguage !== languageId) continue;
    const coverage = new Set(span.features.filter(feature => queryFeatures.has(feature))).size;
    coverageBySource.set(span.sourceVersionId, Math.max(coverageBySource.get(span.sourceVersionId) ?? 0, coverage));
  }
  const maximumCoverage = Math.max(0, ...coverageBySource.values());
  if (!maximumCoverage) return [];
  const profileIds: string[] = [];
  for (const [sourceVersionId, coverage] of coverageBySource) {
    if (coverage !== maximumCoverage || profileIds.length >= limit) continue;
    const profiles = await storage.model.listLanguageProfiles({
      sourceVersionIds: [sourceVersionId], referencedByLanguageMemory: true, limit: limit - profileIds.length
    });
    for (const profile of profiles) {
      if (profile.sourceVersionId === sourceVersionId && !profileIds.includes(profile.id)) profileIds.push(profile.id);
    }
  }
  return profileIds;
}

function modelLanguage(record: NgramModelRecord): string | undefined {
  return codeLanguageForModelRecord(record);
}

/** A stored model back into the runtime shape, or nothing when the record does not carry one. */
function kneserNeyModelFromRecord(record: NgramModelRecord): KneserNeyModel | undefined {
  const stored = jsonRecord(record.modelJson).model;
  const model = materializeKneserNey(stored);
  if (!model || !Number.isInteger(model.order) || model.order < 1) return undefined;
  const sourceKey = jsonRecord(stored).sourceKey;
  if (typeof sourceKey === "string") model.sourceKey = sourceKey;
  return model;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
