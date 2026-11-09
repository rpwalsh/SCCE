// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { codeIdentifierTokens, codeSurfaceTokens } from "./code-surface.js";
import { codeLanguageForPath, type CodeRequestSignal } from "./code-request.js";
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import { ownedNativeArguments, ownedNativeCallableAbi, ownedNativeLiteral, type ProgramNativeCallableAbi } from "./program-native-abi.js";
import type { EvidenceSpan, JsonValue, ProgramBehaviorRequirement, ProgramStatefulBehaviorRequirement } from "./types.js";
import {ownedProjectContractClosure,type SourceOwnedProjectContractClosure} from "./source-owned-project-contract.js";

/**
 * What a request written in a human language has to do with code.
 *
 * The code lane is driven by compiler diagnostics, which is why it can repair a file and has nothing to say when
 * asked to write one: a request has no diagnostics. Reading the request with a code tokenizer is not an answer
 * either -- every word in every language looks like an identifier to it, so "fix the misspelled property access"
 * came back as five symbols and none of them meant anything.
 *
 * The connection already exists in the corpus. Every source file is trained twice: its token stream into the
 * code corpus, and its comments and the words its identifiers are spelled out of into the documentation corpus.
 * Both carry the same file path. So a request matched against documentation surfaces -- ordinary retrieval, the
 * same lane a question about a document uses -- lands on files, and those files name the code models, the
 * constructions and the symbols that are relevant. Prose in, code out, with no vocabulary written down anywhere.
 */

export interface CodeIntentReference {
  /** The file whose documentation matched, when the corpus recorded one. */
  relativePath?: string;
  /** The formal language that path is written in. */
  languageId?: string;
  /** Stable repository/source-family owner recorded by corpus ingestion. */
  sourceFamily?: string;
  /** Raw-source content hash shared across code and documentation projections. */
  sourceHash?: string;
  /** How strongly this surface answered the request, as the retrieval scored it. */
  score: number;
}

export interface CodeIntent {
  /** Formal language the intent concerns, when the references agree on one. */
  languageId?: string;
  /**
   * Names the request puts in play.
   *
   * A request's own words qualify only when some code actually uses them as a name; the rest come from the
   * documentation surfaces that answered it, which is how a request that names nothing still reaches the
   * vocabulary of the code it is about.
   */
  symbols: string[];
  /** Names occurring in the request itself; documentation-contributed names remain separately visible in `symbols`. */
  requestSymbols?: string[];
  /** The files the request is about, best first. */
  references: CodeIntentReference[];
  audit: JsonValue;
}

const REFERENCE_LIMIT = 8;
const SYMBOL_LIMIT = 32;

/**
 * The intent behind a request, read off documentation the corpus already holds.
 *
 * Retrieval is the caller's -- this is pure, and takes the spans that came back. A request that matched nothing
 * yields an intent with no references and no borrowed symbols, which is the honest result: the corpus has not
 * been shown code this request is about, and saying so is different from guessing.
 */
export function codeIntentFromDocumentation(input: {
  requestText: string;
  /** Documentation-corpus spans retrieved for this request, best first. */
  documentation: readonly EvidenceSpan[];
  /** Every symbol some code in play actually uses, so a request word is admitted only when it names something. */
  knownSymbols?: ReadonlySet<string>;
  /** Formal language the request already named, when it did. */
  languageId?: string;
  referenceLimit?: number;
  symbolLimit?: number;
}): CodeIntent {
  const referenceLimit = Math.max(1, Math.min(32, Math.floor(input.referenceLimit ?? REFERENCE_LIMIT)));
  const symbolLimit = Math.max(1, Math.min(128, Math.floor(input.symbolLimit ?? SYMBOL_LIMIT)));

  const references: CodeIntentReference[] = [];
  for (const span of input.documentation.slice(0, referenceLimit * 2)) {
    const relativePath = documentedPath(span);
    if (!relativePath) continue;
    if (references.some(reference => reference.relativePath === relativePath)) continue;
    const languageId = codeLanguageForPath(relativePath);
    references.push({
      relativePath,
      ...(languageId ? { languageId } : {}),
      ...(documentedRepositoryFamily(span) ? { sourceFamily: documentedRepositoryFamily(span) } : {}),
      ...(documentedSourceHash(span) ? { sourceHash: documentedSourceHash(span) } : {}),
      score: Number.isFinite(span.alpha) ? span.alpha : 0
    });
    if (references.length >= referenceLimit) break;
  }

  // A request's own words are names only where code uses them as names; the documentation's are already about
  // code, so its identifiers are admitted on the evidence of having been written next to it.
  const requested = codeIdentifierTokens(codeSurfaceTokens(input.requestText), symbolLimit * 2);
  const known = input.knownSymbols;
  const symbols: string[] = [];
  const requestSymbols: string[] = [];
  const admit = (symbol: string): void => {
    if (!symbol || symbols.includes(symbol) || symbols.length >= symbolLimit) return;
    symbols.push(symbol);
  };
  for (const symbol of requested) if (!known || known.has(symbol)) { admit(symbol); if (!requestSymbols.includes(symbol)) requestSymbols.push(symbol); }
  for (const span of input.documentation.slice(0, referenceLimit)) {
    if (!documentedPath(span)) continue;
    for (const symbol of codeIdentifierTokens(codeSurfaceTokens(span.text || span.textPreview || ""), symbolLimit)) {
      if (known && !known.has(symbol)) continue;
      admit(symbol);
    }
  }

  const languageId = input.languageId ?? dominantLanguage(references);
  return {
    ...(languageId ? { languageId } : {}),
    symbols,
    requestSymbols,
    references,
    audit: toJsonValue({
      source: "code-intent.codeIntentFromDocumentation",
      documentationSpans: input.documentation.length,
      references: references.length,
      requestedSymbols: requested.length,
      admittedSymbols: symbols.length,
      languageId: languageId ?? null
    })
  };
}

/** Convert only persisted, exact-source assertion cases whose target file was selected by documentation retrieval. */
export function sourceOwnedProgramBehaviorFromDocumentation(input: {
  readonly requestText: string;
  readonly intent: CodeIntent;
  readonly patterns: readonly { readonly patternJson: JsonValue }[];
  /** Formal caller-declared callable IDs from the already parsed request signal. */
  readonly ownerCallableIds?: readonly string[];
  /** Formal declarations select exact source names; unlike an observed caller alias, they never rename a source callable. */
  readonly declaredCallableIds?: readonly string[];
}): { behaviorRequirements: ProgramBehaviorRequirement[]; statefulBehaviorRequirements: ProgramStatefulBehaviorRequirement[]; nativeDeclarations?: ProgramNativeCallableAbi[] } {
  const nativeDeclarations:ProgramNativeCallableAbi[]=[];
  for(const pattern of input.patterns){
    const row=objectRecord(pattern.patternJson);
    if(row.schema!=="scce.source_owned_native_declaration.v1"||row.formalLanguage!==input.intent.languageId
      ||!input.intent.references.some(reference=>reference.sourceFamily===row.repositoryFamily&&reference.relativePath===row.sourcePath&&reference.sourceHash===row.sourceHash)
      ||typeof row.targetName!=="string"||typeof row.targetSymbolId!=="string"||typeof row.sourcePath!=="string"||typeof row.sourceHash!=="string"||typeof row.sourceVersionId!=="string")continue;
    const abi=ownedNativeCallableAbi(row.nativeAbi,{callableName:row.targetName,targetSymbolId:row.targetSymbolId,sourcePath:row.sourcePath,sourceHash:row.sourceHash,sourceVersionId:row.sourceVersionId,languageId:String(row.formalLanguage)});
    if(abi)nativeDeclarations.push(abi);
  }
  const empty = { behaviorRequirements: [], statefulBehaviorRequirements: [], ...(nativeDeclarations.length?{nativeDeclarations}:{}) };
  const references = new Set(input.intent.references.filter(row => row.sourceFamily && row.sourceHash)
    .map(row => `${row.sourceFamily}\u0000${row.relativePath}\u0000${row.sourceHash}`));
  const grouped = new Map<string, Array<Record<string, JsonValue>>>();
  const matchedKeys = new Map<string,{closure:SourceOwnedProjectContractClosure|undefined;sourceHash:string;targetName:string;roots:Set<string>;versions:Set<string>}>();
  for (const pattern of input.patterns) {
    const body = objectRecord(pattern.patternJson);
    if (body.schema !== "scce.source_owned_test_contract.v1" || typeof body.sourcePath !== "string"
      || typeof body.targetSymbolId !== "string" || typeof body.targetName !== "string"
      || !references.has(`${body.repositoryFamily}\u0000${body.sourcePath}\u0000${body.sourceHash}`) || body.formalLanguage !== input.intent.languageId
      || typeof body.sourceHash !== "string" || !validContentHash(body.sourceHash) || typeof body.sourceVersionId !== "string"
      || typeof body.repositoryFamily !== "string" || !Array.isArray(body.cases)) continue;
    const key = `${body.repositoryFamily}\u0000${body.sourcePath}\u0000${body.sourceVersionId}\u0000${body.targetSymbolId}`;
    const projectClosure=body.sourceContractClosure===undefined?undefined:ownedProjectContractClosure(body.sourceContractClosure,body.repositoryFamily,body.componentRecipe);
    if(body.sourceContractClosure!==undefined&&!projectClosure)return empty;
    const previous=matchedKeys.get(key);
    if(previous&&(!previous.closure||!projectClosure||previous.sourceHash!==body.sourceHash||previous.targetName!==body.targetName
      ||previous.closure.scopeIdentity!==projectClosure.scopeIdentity||previous.closure.snapshotHash!==projectClosure.snapshotHash||previous.closure.configPath!==projectClosure.configPath||previous.closure.configHash!==projectClosure.configHash
      ||previous.closure.recipe!==projectClosure.recipe||previous.closure.compilerVersion!==projectClosure.compilerVersion
      ||previous.roots.has(projectClosure.testSourceId)||previous.versions.has(projectClosure.testSourceVersionId)))return empty;
    const matched=previous??{closure:projectClosure,sourceHash:body.sourceHash,targetName:body.targetName,roots:new Set<string>(),versions:new Set<string>()};
    if(projectClosure){matched.roots.add(projectClosure.testSourceId);matched.versions.add(projectClosure.testSourceVersionId);}
    matchedKeys.set(key,matched);
    const cases = grouped.get(key) ?? [];
    for (const value of body.cases) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const row = value as Record<string, JsonValue>;
      if(projectClosure&&(row.testPath!==projectClosure.testPath||row.testSourceVersionId!==projectClosure.testSourceVersionId||row.testHash!==projectClosure.testHash))return empty;
      if (row.targetSymbolId !== body.targetSymbolId || !Array.isArray(row.arguments) || !isJsonValue(row.expectedResult)
        || typeof row.testPath !== "string" || !row.testPath || typeof row.testSourceVersionId !== "string" || typeof row.testHash !== "string" || !validContentHash(row.testHash)
        || !validSpan(row.inputSpan) || !validSpan(row.expectedSpan) || !validSpan(row.assertionSpan)) continue;
      if (row.nativeAbi !== undefined && !ownedNativeCallableAbi(row.nativeAbi, { targetSymbolId: body.targetSymbolId, callableName: body.targetName,
        sourcePath: body.sourcePath, sourceHash: body.sourceHash, sourceVersionId: body.sourceVersionId, languageId: String(body.formalLanguage) })) return empty;
      if (row.nativeExpected !== undefined && (body.formalLanguage !== "rust" && body.formalLanguage !== "go" || !ownedNativeLiteral(row.nativeExpected, row.expectedResult))) return empty;
      if (row.nativeArguments !== undefined && !ownedNativeArguments(row.nativeArguments, row.arguments)) return empty;
      if (row.nativeResultProjection !== undefined && (body.formalLanguage !== "go" || row.nativeResultProjection !== "dereference")) return empty;
      cases.push({ ...row, sourceHash: body.sourceHash, sourcePath: body.sourcePath, sourceVersionId: body.sourceVersionId,
        targetName: body.targetName, targetSymbolId: body.targetSymbolId, repositoryFamily: body.repositoryFamily,projectClosure:projectClosure?toJsonValue(projectClosure):null });
    }
    grouped.set(key, cases);
  }
  if (!grouped.size) return empty;
  const requestSymbols = new Set(input.intent.requestSymbols ?? []);
  const ownerCallableIds = [...new Set(input.ownerCallableIds ?? [])];
  const explicitBindings=[...new Set([...ownerCallableIds,...input.declaredCallableIds??[]])];
  const requestedSourceGroups = [...grouped.entries()].filter(([, rows]) => {
    const sourceName = String(rows[0]?.targetName);
    return requestSymbols.has(sourceName) || explicitBindings.includes(sourceName);
  });
  let selectedGroups = requestedSourceGroups.length === 1 ? requestedSourceGroups : grouped.size === 1 ? [...grouped.entries()] : [];
  if (explicitBindings.length > 1) {
    // Formal owner ports select providers within one current project context.
    const boundGroups=[...grouped.entries()].filter(([,rows])=>explicitBindings.includes(String(rows[0]?.targetName)));
    const names=boundGroups.map(([,rows])=>String(rows[0]?.targetName));
    if(explicitBindings.length!==names.length || new Set(names).size!==names.length || names.some(name=>!explicitBindings.includes(name)))return empty;
    const contexts=boundGroups.map(([key])=>{
      const closure=matchedKeys.get(key)?.closure;
      return closure?canonicalStringify([key.split("\u0000")[0],closure.recipe,closure.compilerVersion,closure.configPath,closure.configHash,
        closure.snapshotCheckpointId,closure.snapshotHash,closure.scopeIdentity]):undefined;
    });
    if(contexts.some(context=>context===undefined)||new Set(contexts).size!==1)return empty;
    selectedGroups=[...boundGroups].sort(([a],[b])=>a<b?-1:a>b?1:0);
  }
  if(!selectedGroups.length)return empty;
  const lowered=selectedGroups.map(([familyKey,rows])=>sourceOwnedGroupRequirements({input,familyKey,rows,ownerCallableIds:selectedGroups.length>1?explicitBindings:ownerCallableIds,references}));
  if(lowered.some(group=>!group.behaviorRequirements.length&&!group.statefulBehaviorRequirements.length))return empty;
  const behaviorRequirements=lowered.flatMap(group=>group.behaviorRequirements),statefulBehaviorRequirements=lowered.flatMap(group=>group.statefulBehaviorRequirements);
  // Existing planners and repair selection admit one representation per program.
  if(behaviorRequirements.length&&statefulBehaviorRequirements.length)return empty;
  // Distinct stateful providers require an owned state-composition binding.
  if(selectedGroups.length>1&&statefulBehaviorRequirements.length)return empty;
  return {behaviorRequirements,statefulBehaviorRequirements,...(nativeDeclarations.length?{nativeDeclarations}:{})};
}

function sourceOwnedGroupRequirements({input,familyKey,rows,ownerCallableIds,references}:{
  input:Parameters<typeof sourceOwnedProgramBehaviorFromDocumentation>[0];familyKey:string;rows:Array<Record<string,JsonValue>>;
  ownerCallableIds:string[];references:Set<string>;
}):{behaviorRequirements:ProgramBehaviorRequirement[];statefulBehaviorRequirements:ProgramStatefulBehaviorRequirement[]}{
  const empty={behaviorRequirements:[],statefulBehaviorRequirements:[]};
  const ordered = rows.sort((a, b) => (a.projectClosure&&b.projectClosure?String(a.testPath).localeCompare(String(b.testPath)):0)||spanStart(a.assertionSpan) - spanStart(b.assertionSpan));
  if (ordered.length < 2) return empty;
  const [family, sourcePath, sourceVersionId, targetSymbolId] = familyKey.split("\u0000");
  const sourceTargetName = ordered[0]!.targetName;
  if (typeof sourceTargetName !== "string" || typeof sourcePath !== "string" || typeof sourceVersionId !== "string" || typeof targetSymbolId !== "string" || typeof family !== "string") return empty;
  if (ordered.some(row => row.targetName !== sourceTargetName)) return empty;
  const callableId = ownerCallableIds.length === 1 ? ownerCallableIds[0]! : sourceTargetName;
  if (ownerCallableIds.length > 1 && !ownerCallableIds.includes(sourceTargetName)) return empty;
  const requestHash = `sha256:${createHasher().digestHex(input.requestText)}`;
  const requestSpan = { charStart: 0, charEnd: [...input.requestText].length };
  const behaviorRequirements: ProgramBehaviorRequirement[] = ordered.map((row, index) => ({
    id: `source_assertion.${createHasher().digestHex(canonicalStringify([family, sourcePath, sourceVersionId, targetSymbolId, row.testSourceVersionId, row.assertionSpan,...(row.projectClosure?[row.projectClosure]:[])])).slice(0, 40)}`,
    requestHash,
    callableId,
    arguments: row.arguments as JsonValue[],
    expectedResult: row.expectedResult as JsonValue,
    verificationRole: index === ordered.length - 1 ? "held_out" : "fit",
    relationSurface: "source-owned-assertion",
    sourceSpan: requestSpan,
    sourceContract: {
      ...(row.projectClosure?{projectClosure:row.projectClosure as unknown as SourceOwnedProjectContractClosure}:{}),
      ...(row.nativeAbi !== undefined ? { nativeAbi: ownedNativeCallableAbi(row.nativeAbi, { targetSymbolId, callableName: sourceTargetName,
        sourcePath, sourceVersionId, sourceHash: String(row.sourceHash), languageId: input.intent.languageId ?? "" })! } : {}),
      ...(row.nativeExpected !== undefined ? { nativeExpected: ownedNativeLiteral(row.nativeExpected, row.expectedResult!)! } : {}),
      ...(row.nativeArguments !== undefined ? { nativeArguments: ownedNativeArguments(row.nativeArguments, row.arguments as JsonValue[])! } : {}),
      ...(row.nativeResultProjection === "dereference" ? { nativeResultProjection: "dereference" as const } : {}),
      targetSymbolId, sourcePath, sourceVersionId,
      sourceHash: String(row.sourceHash), testPath: String(row.testPath),
      testSourceVersionId: String(row.testSourceVersionId), testHash: String(row.testHash),
      inputSpan: row.inputSpan as unknown as NonNullable<ProgramBehaviorRequirement["sourceContract"]>["inputSpan"],
      expectedSpan: row.expectedSpan as unknown as NonNullable<ProgramBehaviorRequirement["sourceContract"]>["expectedSpan"],
      assertionSpan: row.assertionSpan as unknown as NonNullable<ProgramBehaviorRequirement["sourceContract"]>["assertionSpan"]
    }
  }));
  return sourceOwnedStatefulRequirements({ ordered, behaviorRequirements, references, family, sourcePath, sourceVersionId, targetSymbolId, sourceTargetName, ownerCallableIds,
    languageId: input.intent.languageId ?? "" });
}

function sourceOwnedStatefulRequirements(input: {
  ordered: Array<Record<string, JsonValue>>; behaviorRequirements: ProgramBehaviorRequirement[];
  references: ReadonlySet<string>; family: string; sourcePath: string; sourceVersionId: string;
  targetSymbolId: string; sourceTargetName: string; ownerCallableIds: readonly string[];
  languageId: string;
}): ReturnType<typeof sourceOwnedProgramBehaviorFromDocumentation> {
  const { ordered, behaviorRequirements, references, family, sourcePath, sourceVersionId, targetSymbolId, sourceTargetName, ownerCallableIds } = input;
  const empty = { behaviorRequirements: [], statefulBehaviorRequirements: [] };
  if (!ordered.some(row => row.invocations !== undefined)) return { behaviorRequirements, statefulBehaviorRequirements: [] };
  const statefulBehaviorRequirements: ProgramStatefulBehaviorRequirement[] = [];
  for (const [index, row] of ordered.entries()) {
    const observed = row.invocations === undefined ? [{ targetSymbolId, targetName: sourceTargetName, sourcePath, sourceVersionId,
      sourceHash: row.sourceHash, arguments: row.arguments, inputSpan: row.inputSpan, callSpan: row.callSpan,
      ...(row.nativeAbi !== undefined ? { nativeAbi: row.nativeAbi } : {}),
      ...(row.nativeArguments !== undefined ? { nativeArguments: row.nativeArguments } : {}) }] : row.invocations;
    if (!Array.isArray(observed) || !observed.length) return empty;
    const bindings: Array<NonNullable<ProgramStatefulBehaviorRequirement["sourceContract"]>["invocations"][number]> = [];
    const invocations: ProgramStatefulBehaviorRequirement["invocations"] = [];
    let previousEnd = -1;
    for (const value of observed) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
      const invocation = value as Record<string, JsonValue>;
      if (typeof invocation.targetSymbolId !== "string" || typeof invocation.targetName !== "string" || typeof invocation.sourcePath !== "string"
        || typeof invocation.sourceVersionId !== "string" || typeof invocation.sourceHash !== "string" || !validContentHash(invocation.sourceHash)
        || !references.has(`${family}\u0000${invocation.sourcePath}\u0000${invocation.sourceHash}`)
        || !Array.isArray(invocation.arguments) || !validSpan(invocation.inputSpan) || !validSpan(invocation.callSpan)) return empty;
      if (invocation.sourcePath === sourcePath && (invocation.sourceVersionId !== sourceVersionId || invocation.sourceHash !== row.sourceHash)) return empty;
      const nativeAbi = invocation.nativeAbi === undefined ? undefined : ownedNativeCallableAbi(invocation.nativeAbi, {
        targetSymbolId: invocation.targetSymbolId, callableName: invocation.targetName, sourcePath: invocation.sourcePath,
        sourceVersionId: invocation.sourceVersionId, sourceHash: invocation.sourceHash, languageId: input.languageId });
      if (invocation.nativeAbi !== undefined && !nativeAbi) return empty;
      const nativeArguments = invocation.nativeArguments === undefined ? undefined : ownedNativeArguments(invocation.nativeArguments, invocation.arguments as JsonValue[]);
      if (invocation.nativeArguments !== undefined && !nativeArguments) return empty;
      const callSpan = objectRecord(invocation.callSpan), inputSpan = objectRecord(invocation.inputSpan);
      if (Number(callSpan.start) < previousEnd || Number(inputSpan.start) < Number(callSpan.start) || Number(inputSpan.end) > Number(callSpan.end)) return empty;
      previousEnd = Number(callSpan.end);
      invocations.push({ callableId: invocation.targetName, arguments: invocation.arguments as JsonValue[], sourceSpan: behaviorRequirements[index]!.sourceSpan });
      bindings.push({ targetSymbolId: invocation.targetSymbolId, targetName: invocation.targetName,
        ...(nativeAbi ? { nativeAbi } : {}),
        ...(nativeArguments ? { nativeArguments } : {}),
        sourcePath: invocation.sourcePath, sourceVersionId: invocation.sourceVersionId, sourceHash: invocation.sourceHash,
        inputSpan: invocation.inputSpan as unknown as NonNullable<ProgramBehaviorRequirement["sourceContract"]>["inputSpan"],
        callSpan: invocation.callSpan as unknown as NonNullable<ProgramBehaviorRequirement["sourceContract"]>["assertionSpan"] });
    }
    const last = bindings.at(-1)!;
    if (last.targetSymbolId !== targetSymbolId || last.sourcePath !== sourcePath || last.sourceVersionId !== sourceVersionId
      || invocations.at(-1)!.callableId !== sourceTargetName
      || last.callSpan.start < Number(objectRecord(row.assertionSpan).start) || last.callSpan.end > Number(objectRecord(row.assertionSpan).end)
      || canonicalStringify(invocations.at(-1)!.arguments) !== canonicalStringify(row.arguments)) return empty;
    if (ownerCallableIds.length && invocations.some(invocation => !ownerCallableIds.includes(invocation.callableId))) return empty;
    const scalar = behaviorRequirements[index]!;
    statefulBehaviorRequirements.push({ id: scalar.id, requestHash: scalar.requestHash, invocations, expectedResult: scalar.expectedResult,
      verificationRole: scalar.verificationRole, relationSurface: scalar.relationSurface, sourceSpan: scalar.sourceSpan,
      sourceContract: { ...scalar.sourceContract!, invocations: bindings } });
  }
  return { behaviorRequirements: [], statefulBehaviorRequirements };
}

export function sourceOwnedBehaviorRequirementsFromDocumentation(input: Parameters<typeof sourceOwnedProgramBehaviorFromDocumentation>[0]): ProgramBehaviorRequirement[] {
  return sourceOwnedProgramBehaviorFromDocumentation(input).behaviorRequirements;
}

export function projectSourceOwnedProgramBehavior(input: {
  codeSignal: CodeRequestSignal; intent: CodeIntent;
  sourceBehavior: ReturnType<typeof sourceOwnedProgramBehaviorFromDocumentation>;
}): CodeRequestSignal {
  const language = input.codeSignal.language ?? input.intent.languageId;
  return { ...input.codeSignal, ...(language ? { language } : {}),
    ...(input.sourceBehavior.nativeDeclarations?.length?{nativeDeclarations:input.sourceBehavior.nativeDeclarations}:{}),
    behaviorRequirements: [...input.codeSignal.behaviorRequirements, ...input.sourceBehavior.behaviorRequirements],
    statefulBehaviorRequirements: [...input.codeSignal.statefulBehaviorRequirements, ...input.sourceBehavior.statefulBehaviorRequirements] };
}

function objectRecord(value: JsonValue | undefined): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }
function isJsonValue(value: JsonValue | undefined): value is JsonValue { return value !== undefined; }
function validSpan(value: JsonValue | undefined): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const span = value as Record<string, JsonValue>;
  return Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && Number(span.start) >= 0 && Number(span.end) > Number(span.start)
    && typeof span.textHash === "string" && /^sha256:[0-9a-f]{64}$/u.test(span.textHash);
}
function validContentHash(value: JsonValue): boolean { return typeof value === "string" && /^(?:sha256:|sha256_)?[0-9a-f]{64}$/iu.test(value); }
function spanStart(value: JsonValue | undefined): number { return objectRecord(value ?? null).start as number; }

/** The path a documentation surface was trained from, as the corpus lane recorded it. */
function documentedPath(span: EvidenceSpan): string | undefined {
  const provenance = span.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const value = (provenance as Record<string, JsonValue>).relativePath ?? objectRecord(objectRecord((provenance as Record<string, JsonValue>).metadata).workspaceFile).path;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function documentedRepositoryFamily(span: EvidenceSpan): string | undefined {
  const provenance = span.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const repository = (provenance as Record<string, JsonValue>).repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) {
    const workspaceId=objectRecord(objectRecord((provenance as Record<string,JsonValue>).metadata).workspace).id;
    return typeof workspaceId==="string"&&workspaceId?`scce://workspace/${encodeURIComponent(workspaceId)}`:undefined;
  }
  const ownerUri = (repository as Record<string, JsonValue>).ownerUri;
  return typeof ownerUri === "string" && ownerUri.trim() ? ownerUri : undefined;
}

function documentedSourceHash(span: EvidenceSpan): string | undefined {
  const provenance = span.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const value = (provenance as Record<string, JsonValue>).sourceHash ?? objectRecord(objectRecord((provenance as Record<string, JsonValue>).metadata).workspaceFile).contentHash;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** The language most of the matched files are written in, when they agree enough to name one. */
function dominantLanguage(references: readonly CodeIntentReference[]): string | undefined {
  const counts = new Map<string, number>();
  for (const reference of references) {
    if (!reference.languageId) continue;
    counts.set(reference.languageId, (counts.get(reference.languageId) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const best = ranked[0];
  return best && best[1] * 2 > references.length ? best[0] : undefined;
}
