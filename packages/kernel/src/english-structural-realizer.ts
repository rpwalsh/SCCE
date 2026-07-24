import nlp from "compromise";

import {
  ENGLISH_CREATIVE_EVENT_COMPILER_ID,
  type DurableCreativeEventConstruction
} from "./language-construction-memory.js";
import {
  normalizeResponseFormSurfaceLayout,
  type ActivatedResponseForm,
  type ResponseFormSurfaceLayout
} from "./turn-requirements.js";
import type { JsonValue } from "./types.js";

export interface LearnedResponseExtentHint {
  unitSurface: string;
  wordsPerUnit: number;
  requestSpan: {
    charStart: number;
    charEnd: number;
  };
  sourcePatternId: string;
}

export interface EnglishStructuralCreativeInput {
  requestText: string;
  contentTerms: readonly string[];
  plannedEvents: readonly EnglishStructuralPlannedEvent[];
  responseForm?: ActivatedResponseForm;
  responseExtentHints?: readonly LearnedResponseExtentHint[];
  defaultTargetWords?: number;
}

export interface EnglishStructuralTransformation {
  outputIndex: number;
  sourceBundleId: string;
  sourceLabelDigest: string;
  sourceEventId: string;
  constructionId: string;
  replacedRoles: string[];
  sourceBoundRoles: string[];
  unchangedTokenRun: number;
  discourseBridgeRelationId?: NarrativeBridgeRelationId;
  ordering: {
    sourceDistance: number | null;
    participantContinuity: number;
    lexicalContinuity: number;
    requestFit: number;
  };
}

export interface EnglishStructuralCreativeResult {
  text: string;
  confidence: number;
  targetWords: number;
  actualWords: number;
  extentSatisfied: boolean;
  protagonist: string;
  antagonist?: string;
  action?: string;
  importedBundleIds: string[];
  transformations: EnglishStructuralTransformation[];
  audit: JsonValue;
}

export type NarrativeBridgeRelationId =
  | "scce.relation.concurrent"
  | "scce.relation.subsequent"
  | "scce.relation.contrastive"
  | "scce.relation.resolution";

export interface EnglishStructuralPlannedEvent {
  outputIndex: number;
  bundleId: string;
  event: DurableCreativeEventConstruction;
  discourseRelationId: NarrativeBridgeRelationId;
  requestFit: number;
  routeId?: string;
  discourseBeatId: string;
  requestRoleBindings: readonly EnglishStructuralRequestRoleBinding[];
}

export interface EnglishStructuralRequestRoleBinding {
  eventRoleId: "scce.role.patient" | "scce.role.complement";
  requestRoleId: "scce.request.role.antagonist";
  admissible: true;
}

interface RequestRole {
  protagonist: string;
  protagonistSurface: string;
  protagonistProper: boolean;
  protagonistPlural: boolean;
  antagonist?: string;
  antagonistSurface?: string;
  antagonistPlural: boolean;
  action?: string;
  actionPast?: string;
  actionGerund?: string;
  actionParticiple?: string;
  actionBridge?: string;
  settingTail?: string;
  contentNouns: string[];
}

interface RealizedClause {
  predicate: string;
  relationId: NarrativeBridgeRelationId;
  beatId: string;
  transformation: EnglishStructuralTransformation;
}

interface RealizedSentence {
  text: string;
  beatId: string;
  transformations: EnglishStructuralTransformation[];
}

interface RealizedBeat {
  id: string;
  relationId: NarrativeBridgeRelationId;
  clauses: RealizedClause[];
}

export const MAX_ENGLISH_STRUCTURAL_CREATIVE_EVENTS = 1_800;
const MAX_TARGET_WORDS = 6_000;
const MAX_OUTPUT_SENTENCES = MAX_ENGLISH_STRUCTURAL_CREATIVE_EVENTS;
const structuralEventRealizabilityCache = new WeakMap<DurableCreativeEventConstruction, boolean>();
const sourceArgumentSurfaceCache = new Map<string, string | null>();

export function isEnglishCreativeEventStructurallyRealizable(
  event: DurableCreativeEventConstruction
): boolean {
  const cached = structuralEventRealizabilityCache.get(event);
  if (cached !== undefined) return cached;
  const forms = Object.values(event.forms);
  if (!event.id
    || event.compilerId !== ENGLISH_CREATIVE_EVENT_COMPILER_ID
    || !event.constructionId
    || !event.relationId
    || !event.sourceVersionId
    || !event.evidenceId
    || !event.sourceLabelDigest
    || !event.roleIds.includes("scce.role.agent")
    || forms.some(form => !form.trim())
    || normalizeSurface(event.forms.past) === "be"
    || event.argumentFrame.compilerId !== ENGLISH_CREATIVE_EVENT_COMPILER_ID
    || !event.argumentFrame.roleIds.includes("scce.role.agent")) {
    structuralEventRealizabilityCache.set(event, false);
    return false;
  }
  if (event.valencyId !== "scce.valency.agent_patient") {
    structuralEventRealizabilityCache.set(event, true);
    return true;
  }
  const realizable = event.argumentFrame.bindings.some(binding => {
    if (binding.roleId !== "scce.role.patient" && binding.roleId !== "scce.role.complement") return false;
    const sourceSurface = sourceBoundEnglishArgumentSurface(binding.surface);
    if (!sourceSurface) return false;
    return binding.roleId !== "scce.role.complement"
      || Boolean(binding.connector && admissibleEnglishArgumentConnector(binding.connector.surface));
  });
  structuralEventRealizabilityCache.set(event, realizable);
  return realizable;
}

export function englishCreativeStructuralRouteEvents<
  T extends DurableCreativeEventConstruction
>(events: readonly T[]): T[] {
  const realizable = events.filter(isEnglishCreativeEventStructurallyRealizable);
  const sourceBoundTransitiveInfinitives = new Set(
    realizable
      .filter(event => event.valencyId === "scce.valency.agent_patient")
      .map(event => normalizeSurface(event.forms.infinitive))
      .filter(Boolean)
  );
  return realizable.filter(event => (
    event.valencyId === "scce.valency.agent_patient"
    || !sourceBoundTransitiveInfinitives.has(normalizeSurface(event.forms.infinitive))
  ));
}

/**
 * English Mouth adapter over hydrated, verified construction/event memory.
 * It never reads evidence bodies or source clauses. Source-derived lexical
 * material is limited to event morphology and independently verified argument
 * heads/connectors compiled at ingest.
 */
export function realizeEnglishStructuralCreative(
  input: EnglishStructuralCreativeInput
): EnglishStructuralCreativeResult | undefined {
  const phaseStart = performance.now();
  const role = requestRole(input.contentTerms, input.requestText);
  if (!role) return undefined;
  const roleParseMs = performance.now() - phaseStart;
  const targetWords = responseTargetWords(input);
  const hydrateStart = performance.now();
  const events = input.plannedEvents;
  const typedHydrationMs = performance.now() - hydrateStart;
  if (events.length < 4
    || events.some(row => !isEnglishCreativeEventStructurallyRealizable(row.event))) return undefined;

  const planStart = performance.now();
  const beats = microplanEnglishBeats(events, role);
  const planningMs = performance.now() - planStart;
  if (!beats.length) return undefined;
  const realizationStart = performance.now();
  const availableClauses = beats.reduce((sum, beat) => sum + beat.clauses.length, 0);
  const clausesPerSentence = Math.min(2, Math.max(1, Math.floor(availableClauses / 6)));
  const availableSentences = beats.flatMap((beat, beatIndex) =>
    realizeEnglishBeat(beat, role, beatIndex, clausesPerSentence)
  );
  const sentences: RealizedSentence[] = [];
  let realizedWordCount = 0;
  for (const sentence of availableSentences) {
    if (sentences.length >= MAX_OUTPUT_SENTENCES) break;
    sentences.push(sentence);
    realizedWordCount += wordCount(sentence.text);
    if (realizedWordCount >= targetWords) break;
  }

  if (sentences.length < 4) return undefined;
  const responseFormLayout = normalizeResponseFormSurfaceLayout(input.responseForm?.surfaceLayout);
  const text = renderResponseFormLayout(sentences, targetWords, role, responseFormLayout).trim();
  if (!admissibleTypedNarrativeSurface(text, role)) return undefined;
  const actualWords = wordCount(text);
  const extentSatisfied = actualWords >= targetWords;
  const transformations = sentences.flatMap(sentence => sentence.transformations);
  const importedBundleIds = uniqueStrings(transformations.map(row => row.sourceBundleId));
  const coverage = actualWords / Math.max(1, targetWords);
  const confidence = clamp01(
    0.54
    + Math.min(0.14, events.length / 160)
    + Math.min(0.12, importedBundleIds.length / 16)
    + Math.min(0.12, coverage * 0.12)
  );
  return {
    text,
    confidence,
    targetWords,
    actualWords,
    extentSatisfied,
    protagonist: role.protagonist,
    ...(role.antagonist ? { antagonist: role.antagonist } : {}),
    ...(role.action ? { action: role.action } : {}),
    importedBundleIds,
    transformations,
    audit: toJson({
      schema: "scce.mouth.english_structural_creative.v3",
      languageBoundary: "en",
      inputBoundary: {
        typedConstructionBundlesOnly: true,
        rawEvidenceBodyRead: false,
        runtimeSourceSurfaceRead: false,
        copiedSourceClauses: false
      },
      parser: {
        package: "compromise",
        use: "request_role_and_morphology_only",
        hiddenWeights: false,
        hostedInference: false
      },
      rolePlan: {
        protagonist: role.protagonist,
        antagonist: role.antagonist ?? null,
        action: role.action ?? null,
        contentNouns: role.contentNouns
      },
      extent: {
        targetWords,
        actualWords,
        coverage,
        satisfied: extentSatisfied,
        shortfallWords: Math.max(0, targetWords - actualWords),
        learnedHintPatternIds: (input.responseExtentHints ?? []).map(row => row.sourcePatternId)
      },
      responseForm: {
        id: input.responseForm?.id ?? null,
        sourceActivationIds: input.responseForm?.sourceActivationIds ?? [],
        selectedUpstream: Boolean(input.responseForm),
        layoutApplied: responseFormLayout ?? null,
        semanticEventSelectionChanged: false
      },
      performance: {
        roleParseMs,
        typedHydrationMs,
        planningMs,
        realizationMs: performance.now() - realizationStart,
        totalMs: performance.now() - phaseStart
      },
      typedEventGraph: {
        schema: "scce.mouth.typed_event_graph.v1",
        events: transformations.map(row => ({
          eventId: row.sourceEventId,
          constructionBundleId: row.sourceBundleId,
          constructionId: row.constructionId,
          discourseBridgeRelationId: row.discourseBridgeRelationId ?? null,
          sourceBoundRoles: row.sourceBoundRoles,
          ordering: row.ordering
        })),
        roleIds: uniqueStrings(transformations.flatMap(row => [
          ...row.replacedRoles,
          ...row.sourceBoundRoles
        ])),
        relationLabelsSourceDerived: true
      },
      provenance: events
        .filter(row => transformations.some(item => item.sourceEventId === row.event.id))
        .map(row => ({
          eventId: row.event.id,
          constructionBundleId: row.bundleId,
          sourceVersionId: row.event.sourceVersionId,
          evidenceId: row.event.evidenceId,
          evidenceContentHash: row.event.evidenceContentHash,
          labelStartCodePoint: row.event.labelStartCodePoint,
          labelEndCodePoint: row.event.labelEndCodePoint,
          relationId: row.event.relationId,
          sourceLabelDigest: row.event.sourceLabelDigest,
          argumentFrameId: row.event.argumentFrame.id,
          argumentBindings: row.event.argumentFrame.bindings.map(binding => ({
            roleId: binding.roleId,
            surfaceDigest: binding.surfaceDigest,
            startCodePoint: binding.startCodePoint,
            endCodePoint: binding.endCodePoint,
            connectorDigest: binding.connector?.surfaceDigest ?? null
          }))
        })),
      certification: {
        claimBasis: "invented",
        factualEvidenceAuthority: false,
        evidenceIds: [],
        surfaceExtentSatisfied: extentSatisfied,
        surfaceExtentStatus: extentSatisfied ? "satisfied" : "under_target"
      }
    })
  };
}

function microplanEnglishBeats(
  events: readonly EnglishStructuralPlannedEvent[],
  role: RequestRole
): RealizedBeat[] {
  const beats: RealizedBeat[] = [];
  let previous: EnglishStructuralPlannedEvent | undefined;
  let active: RealizedBeat | undefined;
  for (const row of events) {
    const clause = realizeTypedEvent(row, role, previous);
    previous = row;
    if (!clause) continue;
    const beatId = row.discourseBeatId;
    if (!beatId) return [];
    if (!active || active.id !== beatId || active.relationId !== row.discourseRelationId) {
      active = {
        id: beatId,
        relationId: row.discourseRelationId,
        clauses: []
      };
      beats.push(active);
    }
    active.clauses.push({ ...clause, beatId });
  }
  return beats;
}

function realizeTypedEvent(
  row: EnglishStructuralPlannedEvent,
  role: RequestRole,
  previous: EnglishStructuralPlannedEvent | undefined
): Omit<RealizedClause, "beatId"> | undefined {
  const form = row.event.forms.past;
  if (!form || normalizeSurface(form) === "be") return undefined;
  const frame = row.event.argumentFrame;
  if (frame.compilerId !== ENGLISH_CREATIVE_EVENT_COMPILER_ID
    || !frame.roleIds.includes("scce.role.agent")) return undefined;
  const argumentSurfaces: string[] = [];
  const replacedRoles = ["scce.role.agent", "scce.role.request_action"];
  const sourceBoundRoles: string[] = [];
  let unchangedTokenRun = 0;
  const requestBoundArgument = frame.bindings.find(binding =>
    row.requestRoleBindings?.some(candidate =>
      candidate.admissible
      && candidate.requestRoleId === "scce.request.role.antagonist"
      && candidate.eventRoleId === binding.roleId
    )
  );
  const sourceBoundArgument = frame.bindings.find(binding => binding.roleId === "scce.role.patient")
    ?? frame.bindings[0];
  const realizedBindings = requestBoundArgument
    ? [requestBoundArgument]
    : sourceBoundArgument
      ? [sourceBoundArgument]
      : [];
  for (const binding of realizedBindings) {
    const plannedRequestBinding = row.requestRoleBindings?.find(candidate =>
      candidate.admissible
      && candidate.requestRoleId === "scce.request.role.antagonist"
      && candidate.eventRoleId === binding.roleId
    );
    const connector = binding.connector && admissibleEnglishArgumentConnector(binding.connector.surface)
      ? binding.connector.surface
      : undefined;
    if (plannedRequestBinding && role.antagonistSurface) {
      argumentSurfaces.push([connector, role.antagonistSurface].filter(Boolean).join(" "));
      replacedRoles.push(binding.roleId);
      continue;
    }
    const sourceSurface = sourceBoundEnglishArgumentSurface(binding.surface);
    if (!sourceSurface) continue;
    if (binding.roleId === "scce.role.complement" && !connector) continue;
    argumentSurfaces.push([connector, sourceSurface].filter(Boolean).join(" "));
    sourceBoundRoles.push(binding.roleId);
    unchangedTokenRun = Math.max(unchangedTokenRun, connector ? 2 : 1);
  }
  if (row.event.valencyId === "scce.valency.agent_patient" && !argumentSurfaces.length) {
    return undefined;
  }
  const predicate = cleanInline([form, ...argumentSurfaces].join(" "));
  if (!admissibleTypedPredicateSurface(predicate)) return undefined;
  return {
    predicate,
    relationId: row.discourseRelationId,
    transformation: transformationFor({
      outputIndex: row.outputIndex,
      row,
      relationId: row.discourseRelationId,
      previous,
      replacedRoles,
      sourceBoundRoles,
      unchangedTokenRun
    })
  };
}

function realizeEnglishBeat(
  beat: RealizedBeat,
  role: RequestRole,
  beatIndex: number,
  clausesPerSentence: number
): RealizedSentence[] {
  const out: RealizedSentence[] = [];
  for (let start = 0; start < beat.clauses.length; start += clausesPerSentence) {
    const clauses = beat.clauses.slice(start, start + clausesPerSentence);
    const subject = beatIndex === 0 && start === 0
      ? role.actionGerund ? role.protagonistSurface : subjectFor(role, clauses[0]!.transformation.outputIndex)
      : start === 0 && beatIndex % 2 === 0
        ? subjectFor(role, clauses[0]!.transformation.outputIndex)
        : "they";
    const predicates = clauses.map(clause => clause.predicate);
    const core = `${subject} ${joinEnglishPredicates(predicates)}`;
    const text = start === 0
      ? realizeEnglishBeatOpening(core, role, beat.relationId, beatIndex)
      : cleanSentence(core);
    if (!admissibleTypedSentenceSurface(text)) continue;
    out.push({
      text,
      beatId: beat.id,
      transformations: clauses.map(clause => clause.transformation)
    });
  }
  return out;
}

function realizeEnglishBeatOpening(
  core: string,
  role: RequestRole,
  relationId: NarrativeBridgeRelationId,
  beatIndex: number
): string {
  if (beatIndex === 0 && role.actionGerund) {
    const bridge = role.actionBridge ? ` ${role.actionBridge}` : "";
    const object = role.antagonistSurface ? ` ${role.antagonistSurface}` : "";
    const setting = role.settingTail ? ` ${role.settingTail}` : "";
    return cleanSentence(
      `While ${role.actionGerund}${bridge}${object}${setting}, ${core}`
    );
  }
  if (beatIndex === 0) return cleanSentence(core);
  const transition = relationId === "scce.relation.concurrent"
    ? "Meanwhile"
    : relationId === "scce.relation.subsequent"
      ? "Afterward"
      : relationId === "scce.relation.contrastive"
        ? "Even so"
        : "At last";
  return cleanSentence(`${transition}, ${core}`);
}

function joinEnglishPredicates(predicates: readonly string[]): string {
  if (predicates.length <= 1) return predicates[0] ?? "";
  if (predicates.length === 2) return `${predicates[0]} and ${predicates[1]}`;
  return `${predicates.slice(0, -1).join(", ")}, and ${predicates.at(-1)}`;
}

function admissibleEnglishArgumentConnector(surface: string): boolean {
  const document = nlp(surface);
  return Boolean(
    document.match("#Preposition").found
    || document.match("#Particle").found
    || normalizeSurface(surface) === "to"
  );
}

function transformationFor(input: {
  outputIndex: number;
  row: EnglishStructuralPlannedEvent;
  relationId: NarrativeBridgeRelationId | undefined;
  previous: EnglishStructuralPlannedEvent | undefined;
  replacedRoles: string[];
  sourceBoundRoles: string[];
  unchangedTokenRun: number;
}): EnglishStructuralTransformation {
  const previous = input.previous;
  const sameProfile = Boolean(previous && previous.event.profileId === input.row.event.profileId);
  return {
    outputIndex: input.outputIndex,
    sourceBundleId: input.row.bundleId,
    sourceLabelDigest: input.row.event.sourceLabelDigest,
    sourceEventId: input.row.event.id,
    constructionId: input.row.event.constructionId,
    replacedRoles: input.replacedRoles,
    sourceBoundRoles: input.sourceBoundRoles,
    unchangedTokenRun: input.unchangedTokenRun,
    ...(input.relationId ? { discourseBridgeRelationId: input.relationId } : {}),
    ordering: {
      sourceDistance: sameProfile && previous
        ? Math.max(0, input.row.event.sourceOrdinal - previous.event.sourceOrdinal)
        : null,
      participantContinuity: previous ? 1 : 0,
      lexicalContinuity: previous
        ? Number(lexicalRoot(previous.event.forms.infinitive) === lexicalRoot(input.row.event.forms.infinitive))
        : 0,
      requestFit: input.row.requestFit
    }
  };
}

function requestRole(contentTerms: readonly string[], requestText: string): RequestRole | undefined {
  const content = contentTerms.join(" ").replace(/\s+/gu, " ").trim();
  const request = requestText.replace(/\s+/gu, " ").trim();
  if (!content && !request) return undefined;
  const contentDocument = nlp(content || request);
  const requestDocument = nlp(request || content);
  contentDocument.match("/[a-z]{3,}ing$/").tag("Verb").tag("Gerund");
  requestDocument.match("/[a-z]{3,}ing$/").tag("Verb").tag("Gerund");
  const requestNouns = unknownArray(requestDocument.nouns().json({ terms: { tags: true } }))
    .map(nounRow)
    .filter((row): row is NonNullable<ReturnType<typeof nounRow>> => Boolean(row));
  const contentNouns = unknownArray(contentDocument.nouns().json({ terms: { tags: true } }))
    .map(nounRow)
    .filter((row): row is NonNullable<ReturnType<typeof nounRow>> => Boolean(row));
  const verbRows = unknownArray(requestDocument.verbs().json({ terms: { tags: true } }))
    .map(verbRow)
    .filter((row): row is NonNullable<ReturnType<typeof verbRow>> => Boolean(row));
  const relational = verbRows
    .flatMap(verb => {
      const protagonist = [...requestNouns]
        .filter(row => row.lastTermIndex < verb.firstTermIndex)
        .sort((left, right) => right.lastTermIndex - left.lastTermIndex)[0];
      const antagonist = [...requestNouns]
        .filter(row => row.firstTermIndex > verb.lastTermIndex)
        .sort((left, right) => left.firstTermIndex - right.firstTermIndex)[0];
      if (!protagonist || !antagonist) return [];
      return [{
        verb,
        protagonist,
        antagonist,
        distance: (verb.firstTermIndex - protagonist.lastTermIndex)
          + (antagonist.firstTermIndex - verb.lastTermIndex)
      }];
    })
    .sort((left, right) =>
      left.distance - right.distance
      || right.verb.firstTermIndex - left.verb.firstTermIndex
    )[0];
  const imperative = relational
    ? undefined
    : verbRows
      .flatMap(verb => {
        const hasSubjectBeforeVerb = requestNouns.some(row => row.lastTermIndex < verb.firstTermIndex);
        const objects = requestNouns
          .filter(row => row.firstTermIndex > verb.lastTermIndex)
          .sort((left, right) => left.firstTermIndex - right.firstTermIndex);
        if (hasSubjectBeforeVerb || !objects.length) return [];
        return [{
          verb,
          protagonist: objects[0]!,
          antagonist: objects[1],
          distance: objects[0]!.firstTermIndex - verb.lastTermIndex
        }];
      })
      .sort((left, right) =>
        left.distance - right.distance
        || left.verb.firstTermIndex - right.verb.firstTermIndex
      )[0];
  const actionlessProtagonist = contentNouns.find(row => row.proper)
    ?? contentNouns[0]
    ?? requestNouns.find(row => row.proper)
    ?? requestNouns[0];
  const nearbyAppositiveProper = relational
    ? [...requestNouns]
      .filter(row => (
        row.proper
        && row.lastTermIndex < relational.protagonist.firstTermIndex
        && relational.protagonist.firstTermIndex - row.lastTermIndex <= 3
      ))
      .sort((left, right) => right.lastTermIndex - left.lastTermIndex)[0]
    : undefined;
  const protagonistRow = nearbyAppositiveProper
    ?? relational?.protagonist
    ?? imperative?.protagonist
    ?? actionlessProtagonist;
  const antagonistRow = relational?.antagonist ?? imperative?.antagonist;
  const roleDocument = relational || imperative ? requestDocument : contentDocument;
  const protagonistRole = protagonistRow
    ? boundedNounRole(roleDocument, protagonistRow)
    : undefined;
  const antagonistRole = antagonistRow
    ? boundedNounRole(requestDocument, antagonistRow)
    : undefined;
  const protagonist = protagonistRole?.surface
    || cleanNounSurface(protagonistRow?.text || protagonistRow?.root || "");
  if (!protagonist) return undefined;
  const antagonist = antagonistRole?.surface
    || (antagonistRow
    ? cleanNounSurface(antagonistRow.text || antagonistRow.root)
    : undefined);
  const protagonistProper = protagonistRole?.proper ?? Boolean(protagonistRow?.proper);
  const protagonistPlural = protagonistRole?.plural ?? protagonistRow?.plural ?? false;
  const antagonistProper = antagonistRole?.proper ?? antagonistRow?.proper ?? false;
  const antagonistPlural = antagonistRole?.plural ?? antagonistRow?.plural ?? false;
  const protagonistSurface = protagonistProper ? protagonist : englishDefiniteSurface(protagonist);
  const antagonistSurface = antagonist
    ? antagonistProper
      ? antagonist
      : antagonistPlural
      ? antagonist
      : englishDefiniteSurface(antagonist)
    : undefined;
  const selectedVerb = relational?.verb;
  const action = selectedVerb?.infinitive || selectedVerb?.text;
  const forms = action ? verbConjugations(action) : undefined;
  const actionBridge = selectedVerb && antagonistRow
    ? requestBridge(requestDocument, selectedVerb.lastTermIndex, antagonistRow.firstTermIndex)
    : undefined;
  const settingTail = antagonistRole
    ? requestSettingTail(requestDocument, antagonistRole.lastTermIndex)
    : undefined;
  return {
    protagonist,
    protagonistSurface,
    protagonistProper,
    protagonistPlural,
    ...(antagonist ? { antagonist } : {}),
    ...(antagonistSurface ? { antagonistSurface } : {}),
    antagonistPlural,
    ...(action ? { action } : {}),
    ...(forms?.past ? { actionPast: forms.past } : {}),
    ...(forms?.gerund ? { actionGerund: forms.gerund } : {}),
    ...(forms?.participle ? { actionParticiple: forms.participle } : {}),
    ...(actionBridge ? { actionBridge } : {}),
    ...(settingTail ? { settingTail } : {}),
    contentNouns: uniqueStrings(
      (relational ? requestNouns : contentNouns)
        .map(row => cleanNounSurface(row.text || row.root))
        .filter(Boolean)
    )
  };
}

function subjectFor(role: RequestRole, outputIndex: number): string {
  if (outputIndex > 0 && outputIndex % 3 !== 0) return "they";
  if (role.protagonistProper && outputIndex > 0 && outputIndex % 4 === 0) {
    const parts = role.protagonist.split(/\s+/u).filter(Boolean);
    return parts.at(-1) || role.protagonistSurface;
  }
  return role.protagonistSurface;
}

function requestBridge(
  document: ReturnType<typeof nlp>,
  verbEndIndex: number,
  objectStartIndex: number
): string | undefined {
  if (objectStartIndex <= verbEndIndex + 1) return undefined;
  const bridge = documentTermRows(document)
    .filter(row => row.index > verbEndIndex && row.index < objectStartIndex)
    .filter(row => row.tags.includes("Preposition") || row.tags.includes("Particle"))
    .map(row => row.text)
    .join(" ")
    .trim();
  return bridge || undefined;
}

function requestSettingTail(
  document: ReturnType<typeof nlp>,
  antagonistEndIndex: number
): string | undefined {
  const after = documentTermRows(document)
    .filter(row => row.index > antagonistEndIndex)
    .sort((left, right) => left.index - right.index);
  const first = after[0];
  if (!first
    || first.index !== antagonistEndIndex + 1
    || first.tags.includes("Verb")
    || first.tags.includes("Noun")
    || first.tags.includes("Determiner")) return undefined;
  const tail: string[] = [];
  let previousIndex = antagonistEndIndex;
  for (const row of after) {
    if (row.index !== previousIndex + 1 || row.tags.includes("Verb") || tail.length >= 6) break;
    tail.push(row.text);
    previousIndex = row.index;
  }
  return tail.length >= 2 ? cleanInline(tail.join(" ")) : undefined;
}

function documentTermRows(
  document: ReturnType<typeof nlp>
): Array<{ text: string; tags: string[]; index: number }> {
  return unknownArray(document.json({ terms: { tags: true } }))
    .flatMap(row => unknownArray(recordUnknown(row).terms))
    .map(termRow)
    .filter((row): row is NonNullable<ReturnType<typeof termRow>> => Boolean(row));
}

function responseTargetWords(input: EnglishStructuralCreativeInput): number {
  const defaultTarget = clampInteger(input.defaultTargetWords ?? 220, 120, 500);
  const candidates = (input.responseExtentHints ?? []).flatMap(hint => {
    const points = [...input.requestText];
    const context = points.slice(
      Math.max(0, hint.requestSpan.charStart - 32),
      Math.min(points.length, hint.requestSpan.charEnd + 12)
    ).join("");
    const values = unknownArray(nlp(context).numbers().get())
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
    const quantity = values.at(-1);
    return quantity && hint.wordsPerUnit > 0 ? [quantity * hint.wordsPerUnit] : [];
  });
  return clampInteger(candidates.sort((left, right) => right - left)[0] ?? defaultTarget, 80, MAX_TARGET_WORDS);
}

function admissibleTypedSentenceSurface(text: string): boolean {
  const words = surfaceTokens(text);
  if (words.length < 2 || words.length > 48) return false;
  if (/\b(?:undefined|null|nan)\b/iu.test(text)) return false;
  return !/[�]/u.test(text);
}

function admissibleTypedPredicateSurface(text: string): boolean {
  const words = surfaceTokens(text);
  return words.length >= 1
    && words.length <= 18
    && !/\b(?:undefined|null|nan)\b/iu.test(text);
}

function admissibleTypedNarrativeSurface(text: string, role: RequestRole): boolean {
  if (!containsLoose(text, role.protagonist)) return false;
  if (role.antagonist && !containsLoose(text, role.antagonist)) return false;
  if (role.actionGerund && !containsLoose(text, role.actionGerund)
    && role.actionPast && !containsLoose(text, role.actionPast)) return false;
  return true;
}

function verbConjugations(action: string): {
  infinitive: string;
  past: string;
  present: string;
  gerund: string;
  participle: string;
} | undefined {
  const row = recordUnknown(unknownArray(nlp(action).verbs().conjugate())[0]);
  const infinitive = stringUnknown(row.Infinitive) || action;
  if (!infinitive) return undefined;
  return {
    infinitive,
    past: stringUnknown(row.PastTense) || infinitive,
    present: stringUnknown(row.PresentTense) || infinitive,
    gerund: stringUnknown(row.Gerund) || infinitive,
    participle: stringUnknown(row.Participle) || stringUnknown(row.PastTense) || infinitive
  };
}

function nounRow(value: unknown): {
  text: string;
  root: string;
  plural: boolean;
  proper: boolean;
  firstTermIndex: number;
  lastTermIndex: number;
} | undefined {
  const record = recordUnknown(value);
  const text = stringUnknown(record.text);
  const noun = recordUnknown(record.noun);
  const terms = unknownArray(record.terms)
    .map(termRow)
    .filter((row): row is NonNullable<ReturnType<typeof termRow>> => Boolean(row));
  if (!text || !terms.length) return undefined;
  return {
    text,
    root: stringUnknown(noun.root) || text,
    plural: Boolean(noun.isPlural),
    proper: terms.some(term => term.tags.includes("ProperNoun")),
    firstTermIndex: terms[0]!.index,
    lastTermIndex: terms.at(-1)!.index
  };
}

function boundedNounRole(
  document: ReturnType<typeof nlp>,
  noun: NonNullable<ReturnType<typeof nounRow>>
): {
  surface: string;
  proper: boolean;
  plural: boolean;
  lastTermIndex: number;
} | undefined {
  const terms = documentTermRows(document)
    .filter(row => row.index >= noun.firstTermIndex && row.index <= noun.lastTermIndex)
    .sort((left, right) => left.index - right.index);
  if (!terms.some(row => row.tags.includes("Noun"))) return undefined;
  const included = terms.slice(0, 12);
  if (included.some((row, index) =>
    index > 0 && row.index !== included[index - 1]!.index + 1
  )) return undefined;
  const surface = cleanNounSurface(included.map(row => row.text).join(" "));
  if (!surface) return undefined;
  return {
    surface,
    proper: included.some(row => row.tags.includes("ProperNoun")),
    plural: included.at(-1)?.tags.includes("Plural") ?? noun.plural,
    lastTermIndex: included.at(-1)!.index
  };
}

function verbRow(value: unknown): {
  text: string;
  infinitive: string;
  firstTermIndex: number;
  lastTermIndex: number;
} | undefined {
  const record = recordUnknown(value);
  const text = stringUnknown(record.text);
  const verb = recordUnknown(record.verb);
  const terms = unknownArray(record.terms)
    .map(termRow)
    .filter((row): row is NonNullable<ReturnType<typeof termRow>> => Boolean(row));
  if (!text || !terms.length) return undefined;
  return {
    text,
    infinitive: stringUnknown(verb.infinitive),
    firstTermIndex: terms[0]!.index,
    lastTermIndex: terms.at(-1)!.index
  };
}

function termRow(value: unknown): { text: string; tags: string[]; index: number } | undefined {
  const record = recordUnknown(value);
  const text = stringUnknown(record.text);
  const index = unknownArray(record.index)[1];
  if (!text || typeof index !== "number" || !Number.isFinite(index)) return undefined;
  return {
    text,
    tags: stringArray(record.tags),
    index
  };
}

function renderResponseFormLayout(
  sentences: readonly RealizedSentence[],
  targetWords: number,
  role: RequestRole,
  layout: ResponseFormSurfaceLayout | undefined
): string {
  const blocks = paragraphizeBeats(sentences, targetWords, layout?.sentencesPerBlock);
  const rendered = blocks.map((block, index) => {
    const lines = layout?.wordsPerLine
      ? wrapSurfaceWords(block, layout.wordsPerLine)
      : [block];
    const withCue = layout?.subjectCuePerBlock
      ? [role.protagonistSurface.toLocaleUpperCase(), ...lines]
      : lines;
    const surface = withCue.join("\n");
    return layout?.orderedBlocks ? `${index + 1}. ${surface}` : surface;
  });
  if (layout?.subjectSignature) rendered.push(`— ${role.protagonistSurface}`);
  return rendered.join("\n\n");
}

function paragraphizeBeats(
  sentences: readonly RealizedSentence[],
  targetWords: number,
  learnedSentenceTarget?: number
): string[] {
  const sentenceTarget = learnedSentenceTarget
    ?? (targetWords > 1_500 ? 7 : targetWords > 600 ? 6 : 4);
  const paragraphs: string[] = [];
  let currentBeatId = "";
  let current: string[] = [];
  for (const sentence of sentences) {
    if (current.length && (sentence.beatId !== currentBeatId || current.length >= sentenceTarget)) {
      paragraphs.push(current.join(" "));
      current = [];
    }
    currentBeatId = sentence.beatId;
    current.push(sentence.text);
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs;
}

function wrapSurfaceWords(surface: string, wordsPerLine: number): string[] {
  const tokens = surface.match(/\S+/gu) ?? [];
  const width = clampInteger(wordsPerLine, 4, 40);
  const lines: string[] = [];
  for (let index = 0; index < tokens.length; index += width) {
    lines.push(tokens.slice(index, index + width).join(" "));
  }
  return lines.length ? lines : [surface];
}

function lexicalRoot(value: string): string {
  const normalized = normalizeSurface(value).replace(/\s+/gu, "");
  if (normalized.length > 5 && normalized.endsWith("ing")) return normalized.slice(0, -3);
  if (normalized.length > 4 && normalized.endsWith("ied")) return `${normalized.slice(0, -3)}y`;
  if (normalized.length > 4 && normalized.endsWith("ed")) return normalized.slice(0, -2);
  if (normalized.length > 4 && normalized.endsWith("es")) return normalized.slice(0, -2);
  if (normalized.length > 3 && normalized.endsWith("s")) return normalized.slice(0, -1);
  return normalized;
}

function cleanSentence(value: string): string {
  const clean = cleanInline(value).replace(/\s+([,.;:!?])/gu, "$1");
  if (!clean) return "";
  const capitalized = clean[0]!.toLocaleUpperCase() + clean.slice(1);
  return /[.!?]$/u.test(capitalized) ? capitalized : `${capitalized}.`;
}

function cleanInline(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function cleanNounSurface(value: string): string {
  return cleanInline(value)
    .replace(/^(?:a|an|the)\s+/iu, "")
    .replace(/[^\p{L}\p{M}\p{N}'’-]+$/gu, "")
    .trim();
}

function sourceBoundEnglishArgumentSurface(value: string): string | undefined {
  const cacheKey = value.normalize("NFKC");
  if (sourceArgumentSurfaceCache.has(cacheKey)) {
    return sourceArgumentSurfaceCache.get(cacheKey) ?? undefined;
  }
  const clean = cleanNounSurface(value);
  const words = surfaceTokens(clean);
  if (!clean || words.length < 1 || words.length > 4) {
    cacheSourceArgumentSurface(cacheKey, undefined);
    return undefined;
  }
  if (/\b(?:a|an|the|every|some|any|each|this|that|these|those)\b/iu.test(clean)) {
    cacheSourceArgumentSurface(cacheKey, undefined);
    return undefined;
  }
  const document = nlp(clean);
  if (!document.nouns().found || document.verbs().found) {
    cacheSourceArgumentSurface(cacheKey, undefined);
    return undefined;
  }
  const tags = new Set(
    unknownArray(document.json({ terms: { tags: true } }))
      .flatMap(row => unknownArray(recordUnknown(row).terms))
      .flatMap(term => unknownArray(recordUnknown(term).tags).map(String))
  );
  const surface = tags.has("Plural")
    || tags.has("Uncountable")
    || tags.has("ProperNoun")
    || /^(?:(?:some|any|every|no)(?:one|body|thing)|none)$/iu.test(clean)
    ? clean
    : englishDefiniteSurface(clean);
  cacheSourceArgumentSurface(cacheKey, surface);
  return surface;
}

function cacheSourceArgumentSurface(key: string, value: string | undefined): void {
  if (sourceArgumentSurfaceCache.size >= 20_000) return;
  sourceArgumentSurfaceCache.set(key, value ?? null);
}

function englishDefiniteSurface(value: string): string {
  return /^(?:a|an|the|every|some|any|each|this|that|these|those)\b/iu.test(value)
    ? value
    : `the ${value}`;
}

function containsLoose(text: string, surface: string): boolean {
  const haystack = normalizeSurface(text);
  const needle = normalizeSurface(surface);
  return Boolean(needle && (` ${haystack} `).includes(` ${needle} `));
}

function normalizeSurface(value: string): string {
  return cleanInline(value).toLocaleLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
}

function surfaceTokens(value: string): string[] {
  return value.match(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}\p{N}]+)*/gu) ?? [];
}

function wordCount(value: string): number {
  return surfaceTokens(value).length;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(Number.isFinite(value) ? value : minimum)));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return unknownArray(value).filter((item): item is string => typeof item === "string" && item.length > 0);
}

function recordUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringUnknown(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
