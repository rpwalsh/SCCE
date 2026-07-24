import { type IdFactory } from "./ids.js";
import { boundedEditDistance, collapsePriorWhitespace, genericQuestionSignal, jsonRecord, kernelClamp01, kernelNumber, kernelString, kernelStringArray, namedSubjectAnchors, normalizePriorKey, requestContentPriorUnits, splitPriorUnits, stripOuterPriorSeparators, surfaceEntityRuns, uniqueKernelStrings } from "./kernel-answer-primitives.js";
import { featureSet, mean, sourceTextSurface, toJsonValue, weightedJaccard } from "./primitives.js";
import { evidenceRetrievalSurface } from "./evidence-retrieval-surface.js";
import type { SemanticAnswerConstructFact } from "./semantic-answer-construct.js";
import { collapseSurfaceWhitespace, ensureSurfaceSentence as ensureUnicodeSurfaceSentence, hasUncasedNonLatinLetter, hasUppercaseLetter, splitSurfaceSentences, surfaceWords } from "./surface-linguistics.js";
import type {
  ConstructGraph,
  EpistemicForce,
  EvidenceSpan,
  GraphNode,
  GraphSlice,
  JsonValue,
  TurnResult
} from "./types.js";



 const SESSION_QUESTION_TERMINAL_CODE_POINTS = new Set([
  0x003f,
  0x037e,
  0x055e,
  0x061f,
  0x1367,
  0x1945,
  0x2047,
  0x2048,
  0x2049,
  0x2cfa,
  0x2cfb,
  0x2e2e,
  0xa60f,
  0xa6f7,
  0xfe56,
  0xff1f,
  0x11143,
  0x1144b,
  0x115f0
]);


 const SESSION_EXCLAMATION_TERMINAL_CODE_POINTS = new Set([
  0x0021,
  0x055c,
  0x203c,
  0xfe57,
  0xff01
]);


 const LOCAL_ANSWER_KIND_IDS = {
  evidenceBoundary: "ans.kind.6f2a4b81",
  collection: "ans.kind.3be50f92",
  temporalCounterexample: "ans.kind.7f1c2a90"
} as const;


 const LOCAL_ANSWER_SLOT_IDS = {
  sentence: "ans.slot.0f3a7c61",
  memberList: "ans.slot.91db4a63",
  subject: "ans.slot.4c2d07a9",
  requestHead: "ans.slot.1a678d0b",
  requestPredicate: "ans.slot.42f8e39c",
  conceptEvidence: "ans.slot.b5d1c337",
  counterexampleEvidence: "ans.slot.f9a41e0d"
} as const;


 const LOCAL_ANSWER_RELATION_IDS = {
  sourceQuote: "rel.1f7c4a92",
  polarityReject: "rel.8d64be21",
  member: "rel.91db4a63",
  temporalCounterexample: "rel.7f1c2a90"
} as const;


 interface LocalEvidenceAnswerPlan {
  planId: string;
  kindId: string;
  evidence: EvidenceSpan[];
  slotSurfaces: Record<string, string | string[]>;
  maxSentences: number;
  audit: JsonValue;
}


 interface LocalEvidenceAnswerCandidate {
  answer: string;
  evidence: EvidenceSpan[];
  audit: JsonValue;
  plan: LocalEvidenceAnswerPlan;
}


export function evidenceBatchFromSlice(evidence: readonly EvidenceSpan[], evidenceIds: readonly EvidenceSpan["id"][]): EvidenceSpan[] | undefined {
  const byId = new Map(evidence.map(span => [String(span.id), span]));
  const selected = evidenceIds.map(id => byId.get(String(id)));
  if (selected.some(span => !span)) return undefined;
  return selected.filter((span): span is EvidenceSpan => Boolean(span));
}


export function evidenceForRequest(
  text: string,
  evidence: readonly EvidenceSpan[],
  priorityIds: ReadonlySet<string> = new Set(),
  explicitContextEvidenceIds: ReadonlySet<string> = new Set(),
  semanticFrameBoundEvidenceIds: ReadonlySet<string> = new Set()
): EvidenceSpan[] {
  const requestFeatures = featureSet(text, 256);
  const anchors = sourceEvidenceAnchorsForRequest(text);
  const orderedRequestUnits = requestUnitsFromText(text);
  const contentUnits = requestContentEvidenceUnits(text);
  const promoted = evidence.filter(span => span.status === "promoted");
  const pool = promoted.length ? promoted : evidence.filter(span => span.status !== "quarantined");
  const rows = pool
    .map(span => {
      const surfaceFeatures = featureSet(evidenceRetrievalSurface(span), 256);
      const lexical = Math.max(weightedJaccard(requestFeatures, span.features), weightedJaccard(requestFeatures, surfaceFeatures));
      const sessionSpan = String(span.id).startsWith("evidence_session_");
      const contentOverlap = evidenceRequestContentOverlap(span, contentUnits);
      const anchorAligned = anchors.length > 0 && (
        evidenceExactSourceAnchorMatches(span, anchors) ||
        evidenceTitleDistinctAnchorMatches(span, anchors) ||
        evidenceSourceMatchesAnchors(span, anchors)
      );
      const explicitContextAligned = explicitContextEvidenceIds.has(String(span.id));
      const semanticFrameBoundAligned = semanticFrameBoundEvidenceIds.has(String(span.id));
      const priorityAligned = priorityIds.has(String(span.id)) && (
        explicitContextAligned ||
        !anchors.length ||
        evidenceExactSourceAnchorMatches(span, anchors) ||
        evidenceTitleDistinctAnchorMatches(span, anchors) ||
        evidenceRequestAdjacentUnitPairOverlap(span, orderedRequestUnits) >= 2
      );
      const priorityBoost = explicitContextAligned ? 0.48 : (semanticFrameBoundAligned || priorityAligned) ? 0.36 : anchorAligned ? 0.22 : 0;
      const alphaBoost = lexical >= 0.025 || semanticFrameBoundAligned || priorityAligned || anchorAligned ? span.alpha * 0.18 : 0;
      const sessionBoost = sessionSpan && (lexical >= 0.045 || priorityAligned) ? 0.08 : 0;
      return { span, score: lexical + alphaBoost + sessionBoost + priorityBoost + Math.min(0.16, contentOverlap * 0.04), lexical, priorityAligned, explicitContextAligned, semanticFrameBoundAligned, anchorAligned, sessionSpan, contentOverlap };
    })
    .filter(row => {
      if (row.explicitContextAligned || row.semanticFrameBoundAligned || row.priorityAligned || row.anchorAligned) return true;
      if (!contentUnits.length || row.contentOverlap <= 0) return false;
      return row.lexical >= (row.sessionSpan ? 0.045 : 0.025);
    })
    .sort((a, b) => b.score - a.score || b.span.alpha - a.span.alpha || String(a.span.id).localeCompare(String(b.span.id)));
  const pinned = rows.filter(row => row.explicitContextAligned || row.semanticFrameBoundAligned || (
    priorityIds.has(String(row.span.id)) &&
    (evidenceExactSourceAnchorMatches(row.span, anchors) || evidenceTitleDistinctAnchorMatches(row.span, anchors))
  ));
  return uniqueEvidenceById([...pinned.map(row => row.span), ...rows.map(row => row.span)]).slice(0, 16);
}


export function evidenceWithGraphPreviewWindows(text: string, evidence: readonly EvidenceSpan[], nodes: readonly GraphNode[], preserveIds: ReadonlySet<string> = new Set()): EvidenceSpan[] {
  const requestFeatures = featureSet(text, 256);
  const previewsByEvidenceId = new Map<string, string[]>();
  for (const node of nodes) {
    const representation = jsonRecord(node.representation);
    const preview = sourceTextSurface(kernelString(representation.preview) ?? kernelString(representation.textPreview) ?? "", 2400);
    if (!preview) continue;
    const ids = uniqueKernelStrings([
      ...node.evidenceIds.map(String),
      ...kernelStringArray(representation.evidenceIds)
    ]);
    for (const id of ids) {
      const rows = previewsByEvidenceId.get(id) ?? [];
      rows.push(preview);
      previewsByEvidenceId.set(id, rows);
    }
  }
  return evidence.map(span => {
    if (preserveIds.has(String(span.id))) return span;
    const previews = previewsByEvidenceId.get(String(span.id)) ?? [];
    if (!previews.length) return span;
    const currentFull = sourceTextSurface(span.text || span.textPreview, 24000);
    const current = sourceTextSurface(currentFull, 2400);
    const currentScore = weightedJaccard(requestFeatures, featureSet(current, 128));
    const selected = previews
      .map(preview => ({ preview, score: weightedJaccard(requestFeatures, featureSet(preview, 128)) + Math.min(0.12, preview.length / 6000) }))
      .sort((a, b) => b.score - a.score || a.preview.length - b.preview.length)[0];
    if (selected && currentFull.length > Math.max(2400, selected.preview.length * 2)) return span;
    if (!selected || selected.score < Math.max(0.015, currentScore * 0.7)) return span;
    return { ...span, text: selected.preview, textPreview: selected.preview };
  });
}


export function runtimeEvidenceWindowsForRequest(text: string, evidence: readonly EvidenceSpan[]): EvidenceSpan[] {
  const requestFeatures = featureSet(text, 256);
  const requestUnits = requestUnitSet(text);
  const definitionAnchor = definitionRequestAnchor(text);
  return evidence.slice(0, 8).map(span => {
    const source = evidenceRetrievalSurface(span, 12000);
    if (source.length <= 6000) return span;
    const sentences = source
      .split(/(?<=[.!?。！？])\s+|\n+/u)
      .map(item => item.replace(/\s+/gu, " ").trim())
      .filter(Boolean);
    const leadRows = sentences.slice(0, 6).map((sentence, index) => ({
      sentence,
      index,
      score: definitionAnchor && definitionSentenceMatches(sentence, definitionAnchor) ? 2.5 - index * 0.05 : 0
    }));
    const ranked = sentences
      .map((sentence, index) => ({
        sentence,
        index,
        score: weightedJaccard(requestFeatures, featureSet(sentence, 128)) + Math.min(0.18, Math.max(0, sentence.length - 40) / 1200)
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 8);
    const dateRows = sentences
      .map((sentence, index) => ({
        sentence,
        index,
        score: requestUnitOverlapForSurface(sentence, requestUnits)
      }))
      .filter(row => row.score > 0 && /\b(1[0-9]{3}|[2-9][0-9]{2}|20[0-9]{2})\b/u.test(row.sentence))
      .sort((a, b) => a.index - b.index)
      .slice(0, 6);
    const sectionRows = sourceSections(source)
      .map(section => ({
        sentence: sourceTextSurface(`==${section.heading}== ${section.body}`, 3600),
        index: section.index,
        score: sourceHeadingOverlap(section.heading, requestUnits, sourceTitleUnitSet(span))
      }))
      .filter(row => row.score > 0 && row.sentence.length >= 24)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 4);
    const byIndex = new Map<number, { sentence: string; index: number; score: number }>();
    for (const row of [...leadRows, ...ranked, ...dateRows, ...sectionRows]) byIndex.set(row.index, row);
    const selectedRows = [...byIndex.values()]
      .sort((a, b) => a.index - b.index);
    const selected = (selectedRows.length ? selectedRows : sentences.slice(0, 8).map((sentence, index) => ({ sentence, index, score: 0 })))
      .map(row => row.sentence)
      .join(" ")
      .slice(0, 6000)
      .trim();
    return selected ? { ...span, text: selected, textPreview: selected } : span;
  });
}


/** @internal Focused session-evidence invariant; not re-exported by the package entrypoint. */
export function sessionOwnerObservationSurface(text: string, typedState?: JsonValue): boolean {
  const typed = typedSessionOwnerObservation(typedState);
  if (typed !== undefined) return typed;
  const clean = text.trim();
  if (!clean || endsWithUnicodeQuestionMark(clean)) return false;
  return /\p{Terminal_Punctuation}$/u.test(clean);
}


 function typedSessionOwnerObservation(value: JsonValue | undefined): boolean | undefined {
  const record = jsonRecord(value);
  const metadata = jsonRecord(record.metadata);
  const ownerMetadata = jsonRecord(metadata.metadata);
  const dialogueRows = [
    jsonRecord(record.dialogue),
    jsonRecord(metadata.dialogue),
    jsonRecord(ownerMetadata.dialogue)
  ];
  const turnActs = [
    jsonRecord(record.dialogueAct),
    jsonRecord(record.turnAct),
    ...dialogueRows.map(row => jsonRecord(row.turnAct))
  ];
  for (const act of turnActs) {
    if (act.schema !== "scce.dialogue.turn_act.v1") continue;
    const questionMass = kernelNumber(act.questionMass) ?? 0;
    const assertionMass = kernelNumber(act.assertionMass) ?? 0;
    if (questionMass >= 0.5 && questionMass > assertionMass) return false;
    if (assertionMass >= 0.5 && assertionMass > questionMass) return true;
  }
  const questionActs = [
    jsonRecord(record.questionAct),
    jsonRecord(metadata.questionAct),
    jsonRecord(ownerMetadata.questionAct),
    ...dialogueRows.map(row => jsonRecord(row.questionAct))
  ];
  for (const act of questionActs) {
    if (act.schema !== "scce.dialogue.question_act.v1") continue;
    if (act.active === true || kernelStringArray(act.requestedSlotIds).length > 0) return false;
  }
  return undefined;
}


 function endsWithUnicodeQuestionMark(text: string): boolean {
  const symbols = [...text.trim()];
  for (let index = symbols.length - 1; index >= 0; index--) {
    const symbol = symbols[index] ?? "";
    if (!symbol) continue;
    const codePoint = symbol.codePointAt(0);
    if (codePoint !== undefined && SESSION_QUESTION_TERMINAL_CODE_POINTS.has(codePoint)) return true;
    if (codePoint !== undefined && SESSION_EXCLAMATION_TERMINAL_CODE_POINTS.has(codePoint)) continue;
    if (/^[\p{Pe}\p{Pf}\p{Cf}]$/u.test(symbol)) continue;
    return false;
  }
  return false;
}


export function sessionContextEvidenceEnabled(metadata: JsonValue | undefined): boolean {
  const record = jsonRecord(metadata);
  const runtime = jsonRecord(record.runtime);
  return record.sessionContextEvidence === true || runtime.sessionContextEvidence === true;
}


export function localEvidenceAnswerSurface(input: {
  requestText: string;
  selectedEvidence: readonly EvidenceSpan[];
  temporalEvidence?: readonly EvidenceSpan[];
  entailment?: Pick<TurnResult["entailment"], "contradiction" | "evidenceIds" | "force">;
  semanticProof?: { verdict: string; contradiction: number };
  translationTarget?: string;
  sessionContextEvidence?: boolean;
  explicitContextEvidenceIds?: ReadonlySet<string>;
  semanticFrameBoundEvidenceIds?: ReadonlySet<string>;
}): LocalEvidenceAnswerCandidate | undefined {
  if (input.translationTarget) return undefined;
  const plan = localEvidenceAnswerPlan(input);
  if (!plan) return undefined;
  return {
    answer: "",
    evidence: plan.evidence,
    audit: toJsonValue({
      ...jsonRecord(plan.audit),
      answerPlanId: plan.planId,
      answerKindId: plan.kindId,
      slotIds: Object.keys(plan.slotSurfaces),
      mouthRealizationRequired: true,
      fakeEvidenceForbidden: true
    }),
    plan
  };
}

export function proposeSourceExactEvidenceAnswer(input: {
  requestText: string;
  selectedEvidence: readonly EvidenceSpan[];
  semanticFrameBoundEvidenceIds?: ReadonlySet<string>;
}): LocalEvidenceAnswerCandidate | undefined {
  const promoted = input.selectedEvidence.filter(span => span.status === "promoted" || promotedSessionEvidence(span));
  if (!promoted.length) return undefined;
  const anchored = sourceAnchoredEvidenceForRequest(
    input.requestText,
    promoted,
    input.semanticFrameBoundEvidenceIds
  );
  const evidence = anchored.required ? anchored.evidence : promoted;
  if (!evidence.length) return undefined;
  const requestFeatures = featureSet(input.requestText, 256);
  const requestUnits = requestUnitSet(input.requestText);
  const rows = evidence.flatMap(span =>
    fastAnswerSentences(evidenceRetrievalSurface(span, 12000))
      .slice(0, 80)
      .map((sentence, index) => {
        const unitOverlap = requestUnitOverlapForSurface(sentence, requestUnits);
        const anchorBoost = sourceSurfaceMatchesAnyAnchor(sentence, anchored.anchors) ? 0.54 : 0;
        const titleLeadBoost = anchored.anchors.length
          && index <= 1
          && evidenceTitleDistinctAnchorMatches(span, anchored.anchors)
          ? 0.32
          : 0;
        return {
          span,
          sentence,
          index,
          score: unitOverlap * 0.92
            + weightedJaccard(requestFeatures, featureSet(sentence, 256)) * 0.35
            + anchorBoost
            + titleLeadBoost
            + Math.max(0, 0.16 - index * 0.018)
            - fastAnswerLongSentencePenalty(sentence)
        };
      })
  )
    .filter(row => row.sentence.length >= 24)
    .sort((left, right) => right.score - left.score || left.index - right.index || String(left.span.id).localeCompare(String(right.span.id)));
  const selected = rows[0];
  if (!selected) return undefined;
  const plan: LocalEvidenceAnswerPlan = {
    planId: "ans.plan.source_exact.31a6c2f8",
    kindId: LOCAL_ANSWER_KIND_IDS.evidenceBoundary,
    evidence: [selected.span],
    slotSurfaces: {
      [LOCAL_ANSWER_SLOT_IDS.sentence]: [selected.sentence]
    },
    maxSentences: 1,
    audit: toJsonValue({
      source: "kernel.turn.source_exact_proposal",
      basisClassId: "basis.source_exact.54d2a9be",
      evidenceIds: [String(selected.span.id)],
      sourceAnchorRequired: anchored.required,
      sourceAnchors: anchored.anchors,
      proposalScore: selected.score,
      proposalSentenceIndex: selected.index,
      proofRequired: true,
      fakeEvidenceForbidden: true
    })
  };
  return {
    answer: "",
    evidence: [selected.span],
    audit: plan.audit,
    plan
  };
}


 function localEvidenceAnswerPlan(input: {
  requestText: string;
  selectedEvidence: readonly EvidenceSpan[];
  temporalEvidence?: readonly EvidenceSpan[];
  entailment?: Pick<TurnResult["entailment"], "contradiction" | "evidenceIds" | "force">;
  semanticProof?: { verdict: string; contradiction: number };
  sessionContextEvidence?: boolean;
  explicitContextEvidenceIds?: ReadonlySet<string>;
  semanticFrameBoundEvidenceIds?: ReadonlySet<string>;
}): LocalEvidenceAnswerPlan | undefined {
  const evidence = input.selectedEvidence.filter(span => span.status === "promoted" || promotedSessionEvidence(span));
  if (!evidence.length) return undefined;
  const temporalEvidence = (input.temporalEvidence ?? evidence)
    .filter(span => span.status === "promoted" || promotedSessionEvidence(span));
  const counterexample = temporalCounterexampleAnswerPlan(input.requestText, temporalEvidence);
  if (counterexample) return counterexample;
  if (temporalCounterexampleExpected(input.requestText, temporalEvidence)) return undefined;
  const collection = collectionAnswerPlan(input.requestText, evidence, input.entailment, input.semanticProof);
  if (collection) return collection;
  const anchored = sourceAnchoredEvidenceForRequest(input.requestText, evidence, input.semanticFrameBoundEvidenceIds);
  const explicitContextEvidence = input.explicitContextEvidenceIds?.size
    ? evidence.filter(span => input.explicitContextEvidenceIds?.has(String(span.id)))
    : [];
  if (anchored.required && !anchored.evidence.length && !explicitContextEvidence.length) return undefined;
  const answerEvidence = anchored.evidence.length
    ? anchored.evidence
    : explicitContextEvidence.length
      ? explicitContextEvidence
      : sourceCoherentUnanchoredEvidence(input.requestText, evidence);
  if (!answerEvidence.length) return undefined;
  const contradiction = Math.max(input.entailment?.contradiction ?? 0, input.semanticProof?.contradiction ?? 0);
  if (contradiction >= 0.72 || (contradiction >= 0.45 && !anchored.evidence.length)) return undefined;
  const sentences = bestEvidenceSentences(input.requestText, answerEvidence, input.sessionContextEvidence === true);
  if (!sentences.length) return undefined;
  const relevance = localEvidenceAnswerScore(input.requestText, answerEvidence);
  const evidenceBound = (input.entailment?.evidenceIds.length ?? 0) > 0;
  const answerSessionBound = answerEvidence.some(promotedSessionEvidence);
  const explicitContextBound = answerEvidence.some(span => input.explicitContextEvidenceIds?.has(String(span.id)) === true);
  if (!evidenceBound && !answerSessionBound && relevance < 0.035) return undefined;
  return {
    planId: "ans.plan.31a6c2f8",
    kindId: LOCAL_ANSWER_KIND_IDS.evidenceBoundary,
    evidence: answerEvidence,
    slotSurfaces: {
      [LOCAL_ANSWER_SLOT_IDS.sentence]: sentences
    },
    maxSentences: evidenceAnswerSentenceLimit(input.requestText, answerEvidence, input.sessionContextEvidence === true),
    audit: toJsonValue({
      source: "kernel.turn.fast_local_evidence",
      basisClassId: "basis.54d2a9be",
      certificationId: evidenceBound ? "cert.2b4f8a11" : "cert.4e8b2d11",
      evidenceIds: answerEvidence.map(span => String(span.id)),
      evidenceCount: answerEvidence.length,
      sourceAnchorRequired: anchored.required,
      sourceAnchorMatched: anchored.evidence.length > 0,
      sourceAnchors: anchored.anchors,
      evidenceBound,
      sessionBound: answerSessionBound,
      explicitContextBound,
      relevance,
      contradiction,
      entailmentForce: input.entailment?.force ?? "unverified-proposal",
      certificationVerifierVerdict: input.semanticProof?.verdict ?? "unverified-proposal",
      selectedSentenceCount: sentences.length,
      fakeEvidenceForbidden: true
    })
  };
}


 function sourceCoherentUnanchoredEvidence(requestText: string, evidence: readonly EvidenceSpan[]): EvidenceSpan[] {
  const contentUnits = requestContentEvidenceUnits(requestText);
  if (!contentUnits.length) return [];
  const compatible = evidence.filter(span => evidenceRequestContentOverlap(span, contentUnits) > 0);
  if (!compatible.length) return [];
  const groups = new Map<string, EvidenceSpan[]>();
  for (const span of compatible) {
    const sourceVersionId = String(span.sourceVersionId);
    groups.set(sourceVersionId, [...(groups.get(sourceVersionId) ?? []), span]);
  }
  if (groups.size <= 1) return compatible;
  const ranked = [...groups.entries()]
    .map(([sourceVersionId, spans]) => ({
      sourceVersionId,
      spans,
      score: localEvidenceAnswerScore(requestText, spans)
        + Math.max(...spans.map(span => evidenceRequestContentOverlap(span, contentUnits))) * 0.08
        + Math.min(0.12, spans.length * 0.02)
    }))
    .sort((left, right) => right.score - left.score || right.spans.length - left.spans.length || left.sourceVersionId.localeCompare(right.sourceVersionId));
  return ranked[0]?.spans ?? [];
}


 function requestContentEvidenceUnits(requestText: string): string[] {
  return uniqueKernelStrings(requestContentAnchorUnits(requestText)
    .filter(unit => [...unit].length >= 4 || hasUncasedNonLatinLetter(unit)));
}


 function evidenceRequestContentOverlap(span: EvidenceSpan, contentUnits: readonly string[]): number {
  if (!contentUnits.length) return 0;
  const units = new Set(contentUnits);
  return Math.max(
    requestUnitOverlapForSurface(evidenceRetrievalSurface(span), units),
    requestUnitOverlapForSurface(evidenceSourceAnchorSurface(span), units),
    requestUnitOverlapForSurface(evidenceTitle(span), units)
  );
}


export function preferredLocalEvidenceAnswer(
  primary: LocalEvidenceAnswerCandidate | undefined,
  alternate: LocalEvidenceAnswerCandidate | undefined
): LocalEvidenceAnswerCandidate | undefined {
  if (!primary) return alternate;
  if (!alternate) return primary;
  return localEvidenceAnswerPriority(alternate.plan) > localEvidenceAnswerPriority(primary.plan) ? alternate : primary;
}

export function localEvidenceAnswerClaimSurface(candidate: LocalEvidenceAnswerCandidate): string {
  return sourceTextSurface(
    localEvidenceAnswerProofExcerpts(candidate).map(excerpt => excerpt.text).join(" "),
    12000
  );
}

export function localEvidenceAnswerProofExcerpts(
  candidate: LocalEvidenceAnswerCandidate
): Array<{ text: string; evidenceId: EvidenceSpan["id"] }> {
  const surfaces = Object.values(candidate.plan.slotSurfaces)
    .flatMap(value => Array.isArray(value) ? value : [value])
    .map(value => sourceTextSurface(String(value), 12000))
    .filter(Boolean);
  const evidenceSurfaces = candidate.evidence.map(span => ({
    span,
    normalized: normalizePriorKey(evidenceRetrievalSurface(span, 12000))
  }));
  const excerpts: Array<{ text: string; evidenceId: EvidenceSpan["id"] }> = [];
  for (const text of surfaces) {
    const normalized = normalizePriorKey(text);
    const source = evidenceSurfaces.find(row => normalized && row.normalized.includes(normalized));
    if (!source) continue;
    excerpts.push({ text, evidenceId: source.span.id });
  }
  return excerpts;
}


 function localEvidenceAnswerPriority(plan: LocalEvidenceAnswerPlan): number {
  if (plan.kindId === LOCAL_ANSWER_KIND_IDS.temporalCounterexample) return 3;
  if (plan.kindId === LOCAL_ANSWER_KIND_IDS.collection) return 2;
  return 1;
}


 function stringArrayFromSlot(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(item => sourceTextSurface(String(item), 1200)).filter(Boolean);
  return typeof value === "string" && value ? [value] : [];
}


 function collectionAnswerPlan(
  requestText: string,
  evidence: readonly EvidenceSpan[],
  entailment?: Pick<TurnResult["entailment"], "contradiction">,
  semanticProof?: { verdict: string; contradiction: number }
): LocalEvidenceAnswerPlan | undefined {
  const contradiction = Math.max(entailment?.contradiction ?? 0, semanticProof?.contradiction ?? 0);
  const anchored = sourceAnchoredEvidenceForRequest(requestText, evidence);
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  const titleMatched = evidence.filter(span => evidenceExactSourceAnchorMatches(span, anchors) || evidenceTitleDistinctAnchorMatches(span, anchors));
  const candidateEvidence = titleMatched.length ? titleMatched : anchored.evidence.length ? anchored.evidence : evidence;
  const namedAnchors = namedSubjectAnchors(requestText).filter(sourceAnchorSpecificEnough);
  if (namedAnchors.length && !candidateEvidence.some(span => evidenceExactSourceAnchorMatches(span, namedAnchors) || evidenceTitleDistinctAnchorMatches(span, namedAnchors))) return undefined;
  if (candidateEvidence.some(span => anchoredBiographicalSubject(span, anchors))) return undefined;
  const requestUnits = requestUnitSet(requestText);
  const requestFeatures = featureSet(requestText, 256);
  const sourceSectionRows = sourceDerivedCollectionRows(candidateEvidence, requestText, requestUnits, requestFeatures);
  const rows = [
    ...sourceSectionRows,
    ...candidateEvidence
    .filter(span => span.status === "promoted" || promotedSessionEvidence(span))
    .flatMap(span => fastAnswerSentences(sourceTextSurface(span.text || span.textPreview, 24000)).slice(0, 80).map((sentence, index) => {
      const names = collectionNamesFromSurface(sentence, requestText, span);
      const unitOverlap = requestUnitOverlapForSurface(sentence, requestUnits);
      const lexical = weightedJaccard(requestFeatures, featureSet(sentence, 128));
      const delimiterMass = collectionListMass(sentence);
      const sectionAffinity = sourceDerivedSectionOverlap(sentence, requestUnits, sourceTitleUnitSet(span));
      return {
        span,
        sentence,
        names,
        sectionAffinity,
        delimiterMass,
        score: names.length * 0.18 + unitOverlap * 0.08 + lexical * 0.32 + delimiterMass * 0.18 + sectionAffinity * 0.5 + Math.max(0, 0.08 - index * 0.004)
      };
    }))
  ]
    .filter(row => row.names.length >= 2)
    .sort((left, right) => right.score - left.score || right.names.length - left.names.length);
  const sourceLabelRows = rows.filter(row => row.sectionAffinity > 0 && row.names.length >= 2);
  const listRichRows = rows.filter(row => row.names.length >= 4 && row.delimiterMass >= 0.28);
  if (!sourceLabelRows.length) return undefined;
  if (contradiction >= 0.72 && !sourceLabelRows.length) return undefined;
  const answerRows = (sourceLabelRows.length ? sourceLabelRows : listRichRows.length ? listRichRows : rows)
    .sort((left, right) => right.sectionAffinity - left.sectionAffinity || right.names.length - left.names.length || right.score - left.score);
  const selectedNames: string[] = [];
  const selectedEvidence: EvidenceSpan[] = [];
  for (const row of answerRows.slice(0, 8)) {
    selectedEvidence.push(row.span);
    for (const name of row.names) {
      if (selectedNames.some(existing => sameCollectionName(existing, name))) continue;
      selectedNames.push(name);
      if (selectedNames.length >= 12) break;
    }
    if (selectedNames.length >= 12) break;
  }
  if (selectedNames.length < 2) return undefined;
  const selectedEvidenceUnique = uniqueEvidenceById(selectedEvidence);
  return {
    planId: "ans.plan.6d1f7c0a",
    kindId: LOCAL_ANSWER_KIND_IDS.collection,
    evidence: selectedEvidenceUnique,
    slotSurfaces: {
      [LOCAL_ANSWER_SLOT_IDS.memberList]: selectedNames
    },
    maxSentences: 1,
    audit: toJsonValue({
      source: "kernel.turn.collection_answer",
      basisClassId: "basis.54d2a9be",
      certificationId: "cert.2b4f8a11",
      evidenceIds: selectedEvidenceUnique.map(span => String(span.id)),
      evidenceCount: selectedEvidenceUnique.length,
      sourceDerivedRows: sourceLabelRows.length,
      listRichRows: listRichRows.length,
      answerObjectId: "ans.obj.6d1f7c0a",
      actionId: "act.3be50f92",
      supportStatusId: "support.7d7a2cf1",
      fakeEvidenceForbidden: true
    })
  };
}


 interface CollectionAnswerRow {
  span: EvidenceSpan;
  sentence: string;
  names: string[];
  sectionAffinity: number;
  delimiterMass: number;
  score: number;
}


 function sourceDerivedCollectionRows(
  evidence: readonly EvidenceSpan[],
  requestText: string,
  requestUnits: ReadonlySet<string>,
  requestFeatures: readonly string[]
): CollectionAnswerRow[] {
  const out: CollectionAnswerRow[] = [];
  for (const span of evidence.filter(item => item.status === "promoted" || promotedSessionEvidence(item))) {
    const source = sourceTextSurface(span.text || span.textPreview, 24000);
    const excludedHeadingUnits = sourceTitleUnitSet(span);
    for (const section of sourceSections(source)) {
      const sectionAffinity = sourceHeadingOverlap(section.heading, requestUnits, excludedHeadingUnits);
      if (sectionAffinity <= 0) continue;
      const names = collectionNamesFromSurface(section.body, requestText, span);
      if (names.length < 2) continue;
      const surface = `${section.heading} ${names.join(", ")}`;
      const lexical = weightedJaccard(requestFeatures, featureSet(surface, 128));
      out.push({
        span,
        sentence: surface,
        names,
        sectionAffinity,
        delimiterMass: collectionListMass(section.body),
        score: 0.72 + sectionAffinity * 0.8 + names.length * 0.12 + lexical * 0.28
      });
    }
  }
  return out.sort((left, right) => right.score - left.score || right.names.length - left.names.length);
}


 function sourceSections(source: string): Array<{ heading: string; body: string; index: number }> {
  const matches = [...source.matchAll(/==([^=\r\n]{1,120})==/gu)];
  const sections: Array<{ heading: string; body: string; index: number }> = [];
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    if (!match || match.index === undefined) continue;
    const next = matches[index + 1];
    const start = match.index + match[0].length;
    const end = next?.index ?? source.length;
    const heading = sourceTextSurface(match[1] ?? "", 160);
    const body = sourceTextSurface(source.slice(start, end), 6000);
    if (heading && body) sections.push({ heading, body, index: match.index });
  }
  return sections;
}


 function collectionNamesFromSurface(sentence: string, requestText: string, span: EvidenceSpan): string[] {
  const sourceTitle = normalizePriorKey(evidenceTitle(span));
  const requestAnchors = new Set(sourceEvidenceAnchorsForRequest(requestText));
  const requestUnits = requestUnitSet(requestText);
  const headNames = collectionListHeadNames(sentence);
  const rawNames = headNames.length ? headNames : surfaceEntityRuns(sentence);
  const out: string[] = [];
  for (const raw of rawNames) {
    const clean = raw.replace(/^[\s"'`]+|[\s"'`,;:.]+$/gu, "").replace(/\s+/gu, " ").trim();
    if (!clean) continue;
    const key = normalizePriorKey(clean);
    if (!key) continue;
    const nameUnits = splitPriorUnits(key).filter(unit => unit.length >= 4);
    if (nameUnits.length && nameUnits.every(unit => [...requestUnits].some(requestUnit => requestUnitMatchesSurface(unit, requestUnit)))) continue;
    if (sourceTitle && (key === sourceTitle || sourceTitle.includes(key) || key.includes(sourceTitle))) continue;
    if ([...requestAnchors].some(anchor => anchor === key || anchor.includes(key) || key.includes(anchor))) continue;
    if (collectionNameLooksInstitutional(clean)) continue;
    out.push(clean);
  }
  return uniqueKernelStrings(out).slice(0, 16);
}


 function collectionListHeadNames(surface: string): string[] {
  const out: string[] = [];
  for (const segment of surface.split(/(?:^|\s)[*\u2022]\s+/u).slice(1)) {
    const head = segment
      .split(/\s[-\u2013\u2014:]\s/u)[0]
      ?.replace(/\([^)]{0,160}\)/gu, " ")
      .replace(/==[^=]{1,120}==/gu, " ")
      .trim() ?? "";
    if (!head) continue;
    const direct = sourceBulletHeadName(head);
    if (direct) {
      out.push(direct);
      continue;
    }
    const [name] = surfaceEntityRuns(head);
    if (name) out.push(name);
  }
  return uniqueKernelStrings(out).slice(0, 24);
}


 function sourceBulletHeadName(surface: string): string {
  const clean = cleanSourceAnswerSurface(surface)
    .replace(/\([^)]{0,160}\)/gu, " ")
    .replace(/["'`]+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/^[\s,;:.]+|[\s,;:.]+$/gu, "")
    .trim();
  if (!clean || clean.length > 90) return "";
  const units = splitPriorUnits(normalizePriorKey(clean)).filter(Boolean);
  if (!units.length || units.length > 7) return "";
  if (!units.some(unit => [...unit].some(char => char.toLocaleLowerCase() !== char.toLocaleUpperCase()))) return "";
  return clean;
}


 function collectionListMass(surface: string): number {
  const markers = surface.match(/[,;*\u2022]|\s[-\u2013\u2014:]\s/gu) ?? [];
  return Math.min(1, markers.length / 8);
}


 function sourceDerivedSectionOverlap(surface: string, requestUnits: ReadonlySet<string>, excludedUnits: ReadonlySet<string> = new Set()): number {
  if (!requestUnits.size) return 0;
  let overlap = 0;
  for (const match of surface.matchAll(/==([^=]{1,120})==/gu)) {
    overlap += sourceHeadingOverlap(match[1] ?? "", requestUnits, excludedUnits);
  }
  return Math.min(1, overlap);
}


 function sourceHeadingOverlap(heading: string, requestUnits: ReadonlySet<string>, excludedUnits: ReadonlySet<string> = new Set()): number {
  if (!requestUnits.size) return 0;
  const units = splitPriorUnits(normalizePriorKey(heading))
    .filter(unit => unit.length >= 4 && ![...excludedUnits].some(excluded => requestUnitMatchesSurface(excluded, unit)));
  let overlap = 0;
  for (const unit of units) {
    if ([...requestUnits].some(requestUnit => requestUnitMatchesSurface(requestUnit, unit))) overlap++;
  }
  return Math.min(1, overlap / Math.max(1, units.length));
}


 function sourceTitleUnitSet(span: EvidenceSpan): Set<string> {
  return new Set(splitPriorUnits(normalizePriorKey(evidenceTitle(span))).filter(unit => unit.length >= 4));
}


 function collectionNameLooksInstitutional(name: string): boolean {
  const units = splitPriorUnits(normalizePriorKey(name));
  return units.length > 5;
}


 function sameCollectionName(left: string, right: string): boolean {
  const a = normalizePriorKey(left);
  const b = normalizePriorKey(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}


export function assistantForceFromLocalEvidenceAudit(audit: JsonValue, defaultForce: NonNullable<TurnResult["assistantForce"]>): NonNullable<TurnResult["assistantForce"]> {
  const record = jsonRecord(audit);
  const basisClassId = kernelString(record.basisClassId);
  const evidenceCount = kernelNumber(record.evidenceCount);
  const evidenceBound = record.evidenceBound === true;
  const sourceAnchorMatched = record.sourceAnchorMatched !== false;
  if (basisClassId === "basis.9f1b2c7a") return "reasoned_answer";
  if (evidenceBound && evidenceCount > 0 && sourceAnchorMatched) return "source_grounded_answer";
  return defaultForce;
}


 function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}


 function temporalCounterexampleAnswerPlan(requestText: string, evidence: readonly EvidenceSpan[]): LocalEvidenceAnswerPlan | undefined {
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  if (!anchors.length) return undefined;
  const requestUnits = requestUnitSet(requestText);
  const orderedRequestUnits = requestUnitsFromText(requestText);
  const subject = evidence
    .map(span => ({ span, title: evidenceTitle(span), key: normalizePriorKey(evidenceTitle(span)) }))
    .map(row => ({ ...row, lifespan: lifespanYears(row.span) }))
    .map(row => ({
      ...row,
      anchorFit: row.title && row.lifespan && anchors.some(anchor => temporalSubjectAnchorMatches(row.key, anchor)) ? 1 : 0,
      requestOverlap: evidenceRequestUnitOverlap(row.span, requestUnits)
    }))
    .filter(row => row.title && row.lifespan && (row.anchorFit > 0 || row.requestOverlap >= 2))
    .sort((left, right) => right.anchorFit - left.anchorFit || right.requestOverlap - left.requestOverlap || left.title.localeCompare(right.title))[0];
  if (!subject) return undefined;
  const lifespan = subject.lifespan;
  if (!lifespan) return undefined;
  const conceptUnits = temporalCounterexampleConceptUnits(requestText, subject.title);
  if (!conceptUnits.size) return undefined;
  const orderedConceptUnits = requestUnitsFromText(firstStringSlot(requestDerivedPolaritySlots(requestText, subject.title)?.[LOCAL_ANSWER_SLOT_IDS.requestPredicate])).filter(unit => conceptUnits.has(unit));
  const counter = evidence
    .filter(span => String(span.id) !== String(subject.span.id))
    .map(span => {
      const sourceSurface = sourceTextSurface(span.text || span.textPreview, 24000);
      const markerCandidate = bestTemporalMarkerSentence(span, conceptUnits, orderedConceptUnits, lifespan.birthYear);
      const marker = markerCandidate?.marker;
      const markerSentence = markerCandidate?.sentence ?? "";
      const overlap = Math.max(
        evidenceRequestUnitOverlap(span, requestUnits),
        requestUnitOverlapForSurface(sourceSurface, requestUnits)
      );
      const conceptOverlap = Math.max(
        requestUnitOverlapForSurface(evidenceTitle(span), conceptUnits),
        requestUnitOverlapForSurface(sourceSurface, conceptUnits)
      );
      const pairOverlap = evidenceRequestAdjacentUnitPairOverlap(span, orderedRequestUnits);
      const conceptPairOverlap = surfaceRequestAdjacentUnitPairOverlap(`${evidenceTitle(span)} ${sourceSurface}`, orderedConceptUnits);
      const markerConceptOverlap = markerCandidate?.conceptOverlap ?? 0;
      const titlePosition = evidenceTitleRequestPosition(span, orderedRequestUnits);
      return marker && markerSentence && overlap > 0 ? {
        span,
        marker,
        markerSentence,
        markerQuality: markerCandidate?.quality ?? 0,
        overlap,
        conceptOverlap,
        markerConceptOverlap,
        pairOverlap,
        conceptPairOverlap,
        titlePosition
      } : undefined;
    })
    .filter((row): row is { span: EvidenceSpan; marker: HistoricalMarker; markerSentence: string; markerQuality: number; overlap: number; conceptOverlap: number; markerConceptOverlap: number; pairOverlap: number; conceptPairOverlap: number; titlePosition: number } => Boolean(row))
    .filter(row => row.conceptOverlap >= 2 || row.conceptPairOverlap >= 1)
    .filter(row => row.markerConceptOverlap >= 1 || row.conceptPairOverlap >= 2)
    .filter(row => (row.overlap >= 2 || row.titlePosition < Number.POSITIVE_INFINITY || row.conceptOverlap >= 2) && (row.pairOverlap >= 1 || row.conceptPairOverlap >= 1 || row.marker.absoluteYear < lifespan.birthYear) && !containedTitlePair(subject.title, evidenceTitle(row.span)))
    .filter(row => row.marker.absoluteYear < lifespan.birthYear)
    .sort((left, right) => {
      const leftPosition = Number.isFinite(left.titlePosition) ? left.titlePosition : 9999;
      const rightPosition = Number.isFinite(right.titlePosition) ? right.titlePosition : 9999;
      return right.markerQuality - left.markerQuality || right.conceptPairOverlap - left.conceptPairOverlap || right.conceptOverlap - left.conceptOverlap || leftPosition - rightPosition || right.overlap - left.overlap || right.pairOverlap - left.pairOverlap || left.marker.absoluteYear - right.marker.absoluteYear;
    })[0];
  if (!counter) return undefined;
  const counterSentence = cleanSourceAnswerSurface(counter.markerSentence);
  const conceptSentence = cleanSourceAnswerSurface(temporalDevelopmentContextSentence(counter.span, conceptUnits, counterSentence));
  const polaritySlots = requestDerivedPolaritySlots(requestText, subject.title);
  if (!polaritySlots) return undefined;
  const answerEvidence = uniqueEvidenceById([counter.span, subject.span]);
  return {
    planId: "ans.plan.7f1c2a90",
    kindId: LOCAL_ANSWER_KIND_IDS.temporalCounterexample,
    evidence: answerEvidence,
    slotSurfaces: {
      ...polaritySlots,
      [LOCAL_ANSWER_SLOT_IDS.conceptEvidence]: conceptSentence,
      [LOCAL_ANSWER_SLOT_IDS.counterexampleEvidence]: counterSentence
    },
    maxSentences: 3,
    audit: toJsonValue({
      source: "turn.basis.7f1c2a90",
      basisClassId: "basis.9f1b2c7a",
      certificationId: "cert.4e8b2d11",
      polarityId: "pol.2a4e8c19",
      subject: subject.title,
      subjectEvidenceId: String(subject.span.id),
      counterexampleEvidenceId: String(counter.span.id),
      counterexampleDate: counter.marker.surface,
      counterexampleYear: counter.marker.absoluteYear,
      conceptOverlap: counter.conceptOverlap,
      conceptPairOverlap: counter.conceptPairOverlap,
      birthYear: lifespan.birthYear,
      deathYear: lifespan.deathYear,
      answerObjectId: "ans.obj.7f1c2a90",
      actionId: "act.7f1c2a90",
      supportStatusId: "support.0d7419ce"
    })
  };
}


export function temporalCounterexampleExpected(requestText: string, evidence: readonly EvidenceSpan[]): boolean {
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  if (!anchors.length) return false;
  const requestUnits = requestUnitSet(requestText);
  const subject = evidence
    .map(span => ({ span, title: evidenceTitle(span), key: normalizePriorKey(evidenceTitle(span)), lifespan: lifespanYears(span) }))
    .map(row => ({
      ...row,
      anchorFit: row.title && row.lifespan && anchors.some(anchor => temporalSubjectAnchorMatches(row.key, anchor)) ? 1 : 0,
      requestOverlap: evidenceRequestUnitOverlap(row.span, requestUnits)
    }))
    .filter(row => row.title && row.lifespan && (row.anchorFit > 0 || row.requestOverlap >= 2))
    .sort((left, right) => right.anchorFit - left.anchorFit || right.requestOverlap - left.requestOverlap || left.title.localeCompare(right.title))[0];
  if (!subject || !requestDerivedPolaritySlots(requestText, subject.title)) return false;
  return temporalCounterexampleConceptUnits(requestText, subject.title).size > 0;
}


 function temporalCounterexampleConceptUnits(requestText: string, subjectTitle: string): Set<string> {
  const subjectUnits = new Set(requestUnitsFromText(subjectTitle));
  const polaritySlots = requestDerivedPolaritySlots(requestText, subjectTitle);
  const predicateSurface = firstStringSlot(polaritySlots?.[LOCAL_ANSWER_SLOT_IDS.requestPredicate]);
  const units = requestUnitsFromText(predicateSurface || requestText)
    .filter(unit => !subjectUnits.has(unit))
    .filter(unit => ![...subjectUnits].some(subjectUnit => requestUnitMatchesSurface(unit, subjectUnit)));
  return new Set(units);
}


 function temporalSubjectAnchorMatches(titleKey: string, anchor: string): boolean {
  if (!titleKey || !anchor) return false;
  const titleUnits = splitPriorUnits(titleKey).filter(unit => unit.length >= 4);
  if (titleUnits.length >= 2) return titleKey === anchor || titleKey.includes(anchor) || anchor.includes(titleKey);
  return titleKey === anchor;
}


 function anchoredBiographicalSubject(span: EvidenceSpan, anchors: readonly string[]): boolean {
  const lifespan = lifespanYears(span);
  if (!lifespan) return false;
  const duration = lifespan.deathYear - lifespan.birthYear;
  if (duration < 10 || duration > 130) return false;
  const titleKey = normalizePriorKey(evidenceTitle(span));
  return anchors.some(anchor => temporalSubjectAnchorMatches(titleKey, anchor));
}


 function requestDerivedPolaritySlots(requestText: string, subjectTitle: string): Record<string, string> | undefined {
  const cleanRequest = cleanSourceAnswerSurface(requestText).replace(/[?!.]+$/u, "").trim();
  const cleanSubject = cleanSourceAnswerSurface(subjectTitle).replace(/[?!.]+$/u, "").trim();
  if (!cleanRequest || !cleanSubject) return undefined;
  const subjectIndex = surfaceIndexOf(cleanRequest, cleanSubject);
  if (subjectIndex < 0) return undefined;
  const beforeSubject = cleanRequest.slice(0, subjectIndex).trim();
  const afterSubject = stripLeadingShortBridgeUnits(cleanRequest.slice(subjectIndex + cleanSubject.length).replace(/^[\s,;:]+/u, "").trim());
  const requestHead = surfaceWords(beforeSubject)[0] ?? "";
  if (!requestHead || !afterSubject) return undefined;
  return {
    [LOCAL_ANSWER_SLOT_IDS.subject]: cleanSubject,
    [LOCAL_ANSWER_SLOT_IDS.requestHead]: requestHead,
    [LOCAL_ANSWER_SLOT_IDS.requestPredicate]: afterSubject
  };
}


 function stripLeadingShortBridgeUnits(surface: string): string {
  const clean = cleanSourceAnswerSurface(surface);
  if (!clean) return "";
  const words = localSurfaceWordSpans(clean);
  const contentIndex = words.findIndex(word => [...word.key].length >= 4 || hasUncasedNonLatinLetter(word.key));
  if (contentIndex <= 0 || contentIndex > 4) return clean;
  return clean.slice(words[contentIndex]?.start ?? 0).trim();
}


 function firstStringSlot(value: string | string[] | undefined): string {
  return stringArrayFromSlot(value)[0] ?? "";
}


 function surfaceIndexOf(surface: string, needle: string): number {
  const lowerSurface = surface.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  return lowerSurface.indexOf(lowerNeedle);
}


 interface HistoricalMarker {
  surface: string;
  absoluteYear: number;
}


 interface TemporalMarkerSentence {
  marker: HistoricalMarker;
  sentence: string;
  conceptOverlap: number;
  conceptPairOverlap: number;
  quality: number;
}


 function lifespanYears(span: EvidenceSpan): { birthYear: number; deathYear: number } | undefined {
  const years = [...sourceTextSurface(span.text || span.textPreview, 900).matchAll(/\b(1[0-9]{3}|20[0-9]{2})\b/gu)]
    .map(match => Number(match[1]))
    .filter(year => Number.isSafeInteger(year));
  if (years.length < 2) return undefined;
  const birthYear = years[0] ?? 0;
  const deathYear = years[1] ?? 0;
  if (birthYear <= 0 || deathYear <= 0 || birthYear >= deathYear) return undefined;
  return { birthYear, deathYear };
}


 function historicalMarkersInText(text: string): HistoricalMarker[] {
  const markers: HistoricalMarker[] = [];
  for (const match of text.matchAll(/\b([1-9][0-9]?)(?:st|nd|rd|th)\s+century\s+(?:BC|BCE)\b/giu)) {
    const century = Number(match[1]);
    if (Number.isSafeInteger(century)) markers.push({ surface: match[0], absoluteYear: -((century - 1) * 100 + 1) });
  }
  for (const match of text.matchAll(/\b([1-9][0-9]?)(?:st|nd|rd|th)\s+century(?:\s+(?:AD|CE))?\b(?!\s+(?:BC|BCE)\b)/giu)) {
    const century = Number(match[1]);
    if (Number.isSafeInteger(century)) markers.push({ surface: match[0], absoluteYear: (century - 1) * 100 + 1 });
  }
  for (const match of text.matchAll(/\b(1[0-9]{3}|[7-9][0-9]{2}|20[0-9]{2})\b/gu)) {
    const year = Number(match[1]);
    if (Number.isSafeInteger(year) && historicalYearContextAllowed(text, match.index ?? 0, match[0].length)) markers.push({ surface: match[0], absoluteYear: year });
  }
  const unique = new Map<string, HistoricalMarker>();
  for (const marker of markers) {
    const key = `${marker.absoluteYear}\u0001${normalizePriorKey(marker.surface)}`;
    if (!unique.has(key)) unique.set(key, marker);
  }
  return [...unique.values()].sort((left, right) => left.absoluteYear - right.absoluteYear || left.surface.localeCompare(right.surface));
}


 function bestTemporalMarkerSentence(
  span: EvidenceSpan,
  conceptUnits: ReadonlySet<string>,
  orderedConceptUnits: readonly string[],
  subjectBirthYear: number
): TemporalMarkerSentence | undefined {
  const sentences = fastAnswerSentences(sourceTextSurface(span.text || span.textPreview, 24000));
  const candidates: TemporalMarkerSentence[] = [];
  for (const sentence of sentences) {
    const complete = completeTemporalEvidenceSentence(sentence, 560);
    if (!complete) continue;
    const units = uniqueKernelStrings(splitPriorUnits(normalizePriorKey(complete)).filter(unit => unit.length >= 4));
    const conceptOverlap = requestUnitOverlapForSurface(complete, conceptUnits);
    const conceptPairOverlap = surfaceRequestAdjacentUnitPairOverlap(complete, orderedConceptUnits);
    if (conceptOverlap <= 0 && conceptPairOverlap <= 0) continue;
    const conceptCoverage = kernelClamp01(conceptOverlap / Math.max(1, Math.min(3, conceptUnits.size)));
    const pairCoverage = kernelClamp01(conceptPairOverlap / Math.max(1, Math.min(2, orderedConceptUnits.length - 1)));
    const lengthFitness = complete.length < 48
      ? kernelClamp01(complete.length / 48)
      : complete.length <= 240
        ? 1
        : kernelClamp01(1 - (complete.length - 240) / 320);
    const breadth = kernelClamp01(Math.log1p(units.length) / Math.log(22));
    for (const marker of historicalMarkersInText(complete)) {
      if (marker.absoluteYear >= subjectBirthYear) continue;
      const precedence = kernelClamp01((subjectBirthYear - marker.absoluteYear) / Math.max(1, subjectBirthYear + 2000));
      const quality = 0.32 * conceptCoverage
        + 0.18 * pairCoverage
        + 0.22 * lengthFitness
        + 0.10 * breadth
        + 0.08 * precedence
        + 0.10;
      candidates.push({ marker, sentence: complete, conceptOverlap, conceptPairOverlap, quality });
    }
  }
  const structurallyAdmissible = candidates.filter(candidate => candidate.quality >= 0.56);
  return (structurallyAdmissible.length ? structurallyAdmissible : candidates).sort((left, right) =>
    left.marker.absoluteYear - right.marker.absoluteYear
    || right.quality - left.quality
    || right.conceptPairOverlap - left.conceptPairOverlap
    || right.conceptOverlap - left.conceptOverlap
    || left.sentence.length - right.sentence.length
  )[0];
}


 function completeTemporalEvidenceSentence(surface: string, maxChars: number): string {
  const clean = cleanSourceAnswerSurface(surface);
  if (!clean || clean.length > maxChars) return "";
  if (/\[\[|\]\]|\{\{|\}\}/u.test(clean)) return "";
  if (delimiterBalance(clean, "(", ")") !== 0 || delimiterBalance(clean, "[", "]") !== 0 || delimiterBalance(clean, "{", "}") !== 0) return "";
  return clean;
}


 function historicalYearContextAllowed(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 12), index);
  const after = text.slice(index + length, Math.min(text.length, index + length + 12));
  if (/[-‐‑‒–—]\s*(?:[IVXLCDM]+|\d+(?:\.\d+)?)/iu.test(after)) return false;
  if (/[$€£¥₩₹₽¢]/u.test(before) || /[$€£¥₩₹₽¢]/u.test(after)) return false;
  if (/^\s+\p{Ll}{1,4}\b/u.test(after)) return false;
  if (/^\s*(?:kb|mb|gb|kg|cm|mm|m|km|ha|iv|v|vi|vii|viii|ix|x)\b/iu.test(after)) return false;
  return true;
}


 function evidenceRequestUnitOverlap(span: EvidenceSpan, requestUnits: ReadonlySet<string>): number {
  if (!requestUnits.size) return 0;
  const surfaceUnits = splitPriorUnits(normalizePriorKey(`${evidenceTitle(span)} ${sourceTextSurface(span.textPreview || span.text || "", 1400)}`)).filter(unit => unit.length >= 4);
  let overlap = 0;
  for (const unit of requestUnits) {
    if (surfaceUnits.some(surfaceUnit => requestUnitMatchesSurface(unit, surfaceUnit))) overlap++;
  }
  return overlap;
}


 function requestUnitSet(text: string): Set<string> {
  return new Set(requestUnitsFromText(text));
}


 function definitionRequestAnchor(text: string): string | undefined {
  const units = requestUnitsFromText(text)
    .filter(unit => !definitionQuestionUnit(unit));
  if (units.length !== 1) return undefined;
  const anchor = units[0] ?? "";
  return anchor.length >= 4 ? anchor : undefined;
}


 function definitionQuestionUnit(unit: string): boolean {
  return unit === "what" || unit === "who" || unit === "which" || unit === "define" || unit === "definition";
}


 function definitionSentenceMatches(sentence: string, anchor: string): boolean {
  const units = splitPriorUnits(normalizePriorKey(sentence)).filter(Boolean);
  const anchorIndex = units.findIndex(unit => requestUnitMatchesSurface(anchor, unit));
  if (anchorIndex < 0 || anchorIndex > 4) return false;
  const window = units.slice(anchorIndex + 1, anchorIndex + 7);
  return window.some(unit => unit === "is" || unit === "are" || unit === "was" || unit === "were" || unit === "refers" || unit === "means");
}


 function requestUnitsFromText(text: string): string[] {
  const out = new Set<string>();
  for (const raw of splitPriorUnits(normalizePriorKey(text.replace(/[?!.]+$/u, "")))) {
    const unit = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (unit.length < 4) continue;
    out.add(unit);
  }
  return [...out];
}


 function evidenceRequestAdjacentUnitPairOverlap(span: EvidenceSpan, requestUnits: readonly string[]): number {
  if (requestUnits.length < 2) return 0;
  const surfaceUnits = splitPriorUnits(normalizePriorKey(`${evidenceTitle(span)} ${sourceTextSurface(span.textPreview || span.text || "", 1800)}`)).filter(unit => unit.length >= 4);
  let overlap = 0;
  for (let index = 0; index < requestUnits.length - 1; index++) {
    const left = requestUnits[index] ?? "";
    const right = requestUnits[index + 1] ?? "";
    if (!left || !right || left === right) continue;
    if (requestUnitAppearsInSurface(left, surfaceUnits) && requestUnitAppearsInSurface(right, surfaceUnits)) overlap++;
  }
  return overlap;
}


 function evidenceTitleRequestPosition(span: EvidenceSpan, requestUnits: readonly string[]): number {
  const titleUnits = splitPriorUnits(normalizePriorKey(evidenceTitle(span))).filter(unit => unit.length >= 4);
  if (!titleUnits.length) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < requestUnits.length; index++) {
    const requestUnit = requestUnits[index] ?? "";
    if (titleUnits.some(titleUnit => requestUnitMatchesSurface(requestUnit, titleUnit))) best = Math.min(best, index);
  }
  return best;
}


 function requestUnitAppearsInSurface(unit: string, surfaceUnits: readonly string[]): boolean {
  return surfaceUnits.some(surfaceUnit => requestUnitMatchesSurface(unit, surfaceUnit));
}


 function requestUnitMatchesSurface(unit: string, surfaceUnit: string): boolean {
  if (!unit || !surfaceUnit) return false;
  if (unit === surfaceUnit) return true;
  const minLength = Math.min(unit.length, surfaceUnit.length);
  const maxLength = Math.max(unit.length, surfaceUnit.length);
  const prefixCompatible = (unit.startsWith(surfaceUnit) || surfaceUnit.startsWith(unit)) && minLength / Math.max(1, maxLength) >= 0.72;
  return prefixCompatible || requestUnitSimilarity(unit, surfaceUnit) >= 0.72;
}


 function requestUnitSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const minLength = Math.min(left.length, right.length);
  const maxLength = Math.max(left.length, right.length);
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left)) && minLength / Math.max(1, maxLength) >= 0.72) return 0.82;
  const distance = boundedEditDistance(left, right, 3);
  if (distance > 3 || maxLength <= 0) return 0;
  return kernelClamp01(1 - distance / maxLength);
}


 function temporalDevelopmentContextSentence(span: EvidenceSpan, requestUnits: ReadonlySet<string>, counterSentence: string): string {
  if (!requestUnits.size) return "";
  const sentences = fastAnswerSentences(sourceTextSurface(span.text || span.textPreview, 24000));
  const counterKey = normalizePriorKey(counterSentence);
  const counterIndex = sentences.findIndex(sentence => normalizePriorKey(sentence) === counterKey);
  const counterFeatures = featureSet(counterSentence, 256);
  const sentenceKeyCounts = new Map<string, number>();
  for (const sentence of sentences) {
    const key = normalizePriorKey(sentence);
    if (key) sentenceKeyCounts.set(key, (sentenceKeyCounts.get(key) ?? 0) + 1);
  }
  return sentences
    .map((sentence, index) => {
      const complete = completeTemporalEvidenceSentence(sentence, 360);
      const completeKey = normalizePriorKey(complete);
      const units = uniqueKernelStrings(splitPriorUnits(normalizePriorKey(complete)).filter(unit => unit.length >= 4));
      const overlap = requestUnitOverlapForSurface(complete, requestUnits);
      const conceptCoverage = kernelClamp01(overlap / Math.max(1, Math.min(3, requestUnits.size)));
      const breadth = kernelClamp01(Math.log1p(units.length) / Math.log(18));
      const distinctness = kernelClamp01(1 - weightedJaccard(featureSet(complete, 256), counterFeatures));
      const sourceOrder = sentences.length > 1 ? 1 - index / (sentences.length - 1) : 1;
      const precedingProximity = counterIndex > index
        ? kernelClamp01(1 - Math.max(0, counterIndex - index - 1) / Math.max(1, counterIndex))
        : 0;
      const temporalNeighborhood = kernelClamp01(sentences
        .slice(Math.max(0, index - 2), Math.min(sentences.length, index + 3))
        .filter((_, localIndex) => Math.max(0, index - 2) + localIndex !== index)
        .reduce((sum, row) => sum + Math.min(1, historicalMarkersInText(row).length), 0) / 2);
      const lengthFitness = complete.length < 40
        ? kernelClamp01(complete.length / 40)
        : complete.length <= 220
          ? 1
          : kernelClamp01(1 - (complete.length - 220) / 140);
      const numericSpecificity = kernelClamp01(units.filter(unit => /\p{Number}/u.test(unit)).length / Math.max(1, units.length) * 3);
      const namedSpecificity = fastAnswerNamedSurfaceMass(complete);
      const pointDateSpecificity = historicalMarkersInText(complete).some(marker => /^\p{Number}{3,4}$/u.test(marker.surface.trim())) ? 1 : 0;
      const repetitionPressure = kernelClamp01(((sentenceKeyCounts.get(completeKey) ?? 1) - 1) / 3);
      const score = 0.18 * conceptCoverage
        + 0.16 * breadth
        + 0.16 * distinctness
        + 0.20 * precedingProximity
        + 0.18 * temporalNeighborhood
        + 0.07 * sourceOrder
        + 0.05 * lengthFitness
        - 0.10 * numericSpecificity
        - 0.10 * namedSpecificity
        - 0.22 * pointDateSpecificity
        - 0.18 * repetitionPressure;
      return { sentence: complete, index, overlap, score };
    })
    .filter(row => row.sentence && row.overlap > 0 && row.sentence.length >= 24 && normalizePriorKey(row.sentence) !== counterKey)
    .sort((left, right) => right.score - left.score || left.index - right.index || right.sentence.length - left.sentence.length)[0]?.sentence ?? "";
}


 function requestUnitOverlapForSurface(surface: string, requestUnits: ReadonlySet<string>): number {
  const surfaceUnits = splitPriorUnits(normalizePriorKey(surface)).filter(unit => unit.length >= 4);
  let overlap = 0;
  for (const unit of requestUnits) {
    if (surfaceUnits.some(surfaceUnit => requestUnitMatchesSurface(unit, surfaceUnit))) overlap++;
  }
  return overlap;
}


 function evidenceTitle(span: EvidenceSpan): string {
  const provenance = jsonRecord(span.provenance);
  const metadata = jsonRecord(provenance.metadata);
  return kernelString(provenance.title) ?? kernelString(metadata.title) ?? "";
}


 function containedTitlePair(leftTitle: string, rightTitle: string): boolean {
  const left = normalizePriorKey(leftTitle);
  const right = normalizePriorKey(rightTitle);
  if (!left || !right || left === right) return false;
  return left.includes(right) || right.includes(left);
}


 function firstUsefulSentence(span: EvidenceSpan): string {
  return fastAnswerSentences(sourceTextSurface(span.text || span.textPreview, 24000)).find(sentence => sentence.length >= 24) ?? "";
}


 function sentenceContaining(text: string, needle: string): string {
  const lowerNeedle = needle.toLocaleLowerCase();
  return fastAnswerSentences(text).find(sentence => sentence.toLocaleLowerCase().includes(lowerNeedle)) ?? "";
}


export function sourceAnchoredEvidenceForRequest(
  requestText: string,
  evidence: readonly EvidenceSpan[],
  semanticFrameBoundEvidenceIds?: ReadonlySet<string>
): { required: boolean; anchors: string[]; evidence: EvidenceSpan[] } {
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  if (!anchors.length) return { required: false, anchors, evidence: [...evidence] };
  const durableEvidencePresent = evidence.some(span => !String(span.id).startsWith("evidence_session_"));
  if (!durableEvidencePresent) {
    const sessionEvidence = evidence.filter(promotedSessionEvidence);
    if (sessionEvidence.length) return { required: true, anchors, evidence: sessionEvidence };
  }
  const primaryAnchor = primarySourceAnchorForRequest(requestText, evidence);
  const primaryAnchorUnits = primaryAnchor ? splitPriorUnits(primaryAnchor).filter(Boolean) : [];
  const primaryEvidence = primaryAnchor
    ? primaryEvidenceForSourceAnchor(primaryAnchor, requestText, evidence)
    : [];
  const semanticFrameBoundEvidence = semanticFrameBoundEvidenceIds?.size
    ? evidence.filter(span => semanticFrameBoundEvidenceIds.has(String(span.id)))
    : [];
  if (primaryAnchor && !primaryEvidence.length && !semanticFrameBoundEvidence.length) return { required: true, anchors: uniqueKernelStrings([primaryAnchor, ...anchors]), evidence: [] };
  const primaryExact = primaryAnchor
    ? evidence.filter(span => evidenceExactSourceAnchorMatches(span, [primaryAnchor]) && evidenceAnchorFitForRequest(span, requestText))
    : [];
  if (primaryAnchor && primaryExact.length && requestContentEvidenceUnits(requestText).length <= 3) {
    return { required: true, anchors: uniqueKernelStrings([primaryAnchor, ...anchors]), evidence: uniqueEvidenceById([...primaryExact, ...semanticFrameBoundEvidence]) };
  }
  if (primaryAnchor && primaryAnchorUnits.length === 1 && primaryEvidence.length) {
    return { required: true, anchors: uniqueKernelStrings([primaryAnchor, ...anchors]), evidence: uniqueEvidenceById([...primaryEvidence, ...semanticFrameBoundEvidence]) };
  }
  const exact = evidence.filter(span => (
    (evidenceExactSourceAnchorMatches(span, anchors) || evidenceTitleDistinctAnchorMatches(span, anchors)) &&
    evidenceAnchorFitForRequest(span, requestText)
  ));
  const selected = evidence.filter(span => (
    (evidenceSourceMatchesAnchors(span, anchors) || evidenceTitleDistinctAnchorMatches(span, anchors)) &&
    evidenceAnchorFitForRequest(span, requestText)
  ));
  return {
    required: true,
    anchors: uniqueKernelStrings([...(primaryAnchor ? [primaryAnchor] : []), ...anchors]),
    evidence: exact.length
      ? uniqueEvidenceById([...primaryEvidence, ...exact, ...selected, ...semanticFrameBoundEvidence])
      : uniqueEvidenceById([...primaryEvidence, ...selected, ...semanticFrameBoundEvidence])
  };
}


 function primaryEvidenceForSourceAnchor(primaryAnchor: string, requestText: string, evidence: readonly EvidenceSpan[]): EvidenceSpan[] {
  const exact = evidence.filter(span =>
    evidenceExactSourceAnchorMatches(span, [primaryAnchor]) &&
    evidenceAnchorFitForRequest(span, requestText)
  );
  const primaryAnchorUnits = splitPriorUnits(primaryAnchor).filter(Boolean);
  if (primaryAnchorUnits.length === 1 && exact.length) return exact;
  return evidence.filter(span => {
    const titleMatched = evidenceExactSourceAnchorMatches(span, [primaryAnchor]) || evidenceTitleDistinctAnchorMatches(span, [primaryAnchor]);
    if (titleMatched && evidenceAnchorFitForRequest(span, requestText)) return true;
    return primaryAnchorUnits.length >= 2 && evidenceMatchesSourceAnchor(span, primaryAnchor);
  });
}


 function evidenceAnchorFitForRequest(span: EvidenceSpan, requestText: string): boolean {
  const titleUnits = sourceTitleAnchorFitUnitSet(span);
  if (!titleUnits.size) return true;
  const requestUnits = requestAnchorFitUnits(requestText);
  if (!requestUnits.length) return true;
  const matchedTitleUnits = [...titleUnits].filter(titleUnit => requestUnits.some(unit => requestUnitMatchesSurface(unit, titleUnit)));
  const firstTitlePosition = firstTitleUnitPosition(requestUnits, titleUnits);
  if (!matchedTitleUnits.length) return false;
  if (matchedTitleUnits.length >= 2 && firstTitlePosition <= 2) return true;
  const nonTitleUnits = requestUnits.filter(unit => ![...titleUnits].some(titleUnit => requestUnitMatchesSurface(unit, titleUnit)));
  const sourceSurface = sourceTextSurface(span.text || span.textPreview, 3200);
  const nonTitleOverlap = requestUnitOverlapForSurface(sourceSurface, new Set(nonTitleUnits));
  const singleLateTitleOverlapFloor = titleUnits.size === 1 && firstTitlePosition > 2 ? 2 : 1;
  if (matchedTitleUnits.length >= 1 && nonTitleOverlap >= singleLateTitleOverlapFloor) return true;
  return titleUnits.size > 1 && firstTitlePosition <= 2 && matchedTitleUnits.length / Math.max(1, titleUnits.size) >= 0.67;
}


 function sourceTitleAnchorFitUnitSet(span: EvidenceSpan): Set<string> {
  return new Set(splitPriorUnits(normalizePriorKey(evidenceTitle(span)))
    .map(unit => unit.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(unit => unit.length >= 3 && !genericQuestionSignal(unit)));
}


 function requestAnchorFitUnits(text: string): string[] {
  return splitPriorUnits(normalizePriorKey(text.replace(/[?!.]+$/u, "")))
    .map(unit => unit.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(unit => unit.length >= 3 && !genericQuestionSignal(unit));
}


 function firstTitleUnitPosition(requestUnits: readonly string[], titleUnits: ReadonlySet<string>): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < requestUnits.length; index++) {
    const unit = requestUnits[index] ?? "";
    if ([...titleUnits].some(titleUnit => requestUnitMatchesSurface(unit, titleUnit))) best = Math.min(best, index);
  }
  return best;
}


export function requestNeedsSourceAnchoredEvidence(requestText: string): boolean {
  return sourceEvidenceAnchorsForRequest(requestText).length > 0;
}


 function uniqueEvidenceById(evidence: readonly EvidenceSpan[]): EvidenceSpan[] {
  const byId = new Map<string, EvidenceSpan>();
  for (const span of evidence) if (!byId.has(String(span.id))) byId.set(String(span.id), span);
  return [...byId.values()];
}


export function graphFilteredToEvidence(graph: GraphSlice, evidence: readonly EvidenceSpan[]): GraphSlice {
  const ids = new Set(evidence.map(span => String(span.id)));
  if (!ids.size) return { ...graph, nodes: [], edges: [], hyperedges: [] };
  const nodeIds = new Set<string>();
  const nodes = graph.nodes.filter(node => {
    const matched = node.evidenceIds.some(id => ids.has(String(id)));
    if (matched) nodeIds.add(String(node.id));
    return matched;
  });
  const edges = graph.edges.filter(edge =>
    edge.evidenceIds.some(id => ids.has(String(id))) ||
    nodeIds.has(String(edge.source)) && nodeIds.has(String(edge.target))
  );
  const hyperedges = graph.hyperedges.filter(edge =>
    edge.provenanceRefs.some(id => ids.has(String(id))) ||
    edge.memberNodeIds.some(id => nodeIds.has(String(id)))
  );
  return { ...graph, nodes, edges, hyperedges };
}


export function sourceEvidenceAnchorsForRequest(requestText: string): string[] {
  const named = namedSubjectAnchors(requestText)
    .sort((left, right) => splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length);
  const derived = derivedSourceAnchorPhrases(requestText);
  if (named.length) return uniqueKernelStrings([...named, ...derived]).slice(0, 24);
  const casedSingle = casedSingleSourceAnchors(requestText);
  if (casedSingle.length) return uniqueKernelStrings([...casedSingle, ...derived]).slice(0, 24);
  const singleTopic = singleTopicSourceAnchors(requestText);
  if (singleTopic.length) return singleTopic;
  const anchors = [...derived]
    .filter(sourceAnchorSpecificEnough);
  const pairs = anchors
    .filter(anchor => splitPriorUnits(anchor).length === 2)
    .sort((left, right) => right.length - left.length);
  const wider = anchors
    .filter(anchor => splitPriorUnits(anchor).length > 2)
    .sort((left, right) => splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length);
  return uniqueKernelStrings([...pairs, ...wider]).slice(0, 32);
}


 function primarySourceAnchorForRequest(requestText: string, evidence: readonly EvidenceSpan[]): string | undefined {
  const ranked = sourceEvidenceAnchorsForRequest(requestText)
    .map(anchor => {
      const anchorUnits = splitPriorUnits(normalizePriorKey(anchor)).filter(Boolean);
      if (!anchorUnits.length) return undefined;
      let exactTitleMatches = 0;
      let completeSourceMatches = 0;
      let supportMass = 0;
      for (const span of evidence) {
        if (!evidenceAnchorFitForRequest(span, requestText)) continue;
        const exactTitle = evidenceExactSourceAnchorMatches(span, [anchor]);
        const sourceUnits = splitPriorUnits(normalizePriorKey(evidenceSourceAnchorSurface(span))).filter(Boolean);
        const completeSourceMatch = sourceAnchorPhraseContains(sourceUnits, anchorUnits);
        if (!exactTitle && !completeSourceMatch) continue;
        if (exactTitle) exactTitleMatches++;
        if (completeSourceMatch) completeSourceMatches++;
        supportMass += kernelClamp01(span.alpha);
      }
      if (!exactTitleMatches && !completeSourceMatches) return undefined;
      return { anchor, exactTitleMatches, completeSourceMatches, supportMass };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((left, right) =>
      right.exactTitleMatches - left.exactTitleMatches ||
      right.completeSourceMatches - left.completeSourceMatches ||
      right.supportMass - left.supportMass ||
      sourceAnchorPhraseRank(right.anchor) - sourceAnchorPhraseRank(left.anchor) ||
      left.anchor.localeCompare(right.anchor)
    );
  return ranked[0]?.anchor;
}


 function casedSingleSourceAnchors(requestText: string): string[] {
  return uniqueKernelStrings(surfaceWords(requestText)
    .map(stripOuterPriorSeparators)
    .filter(unit => hasUppercaseLetter(unit) && [...unit].length >= 4)
    .map(normalizePriorKey)
    .filter(Boolean));
}


 function singleTopicSourceAnchors(requestText: string): string[] {
  const units = requestContentAnchorUnits(requestText);
  if (units.length !== 1) return [];
  const unit = units[0] ?? "";
  return [...unit].length >= 5 || hasUncasedNonLatinLetter(unit) ? [unit] : [];
}


 function derivedSourceAnchorPhrases(requestText: string): string[] {
  const units = requestContentAnchorUnits(requestText);
  const phrases: string[] = [];
  for (let index = 0; index < units.length - 1; index++) {
    const pair = [units[index]!, units[index + 1]!];
    if (anchorPhraseUnitsSpecificEnough(pair)) phrases.push(pair.join(" "));
  }
  for (let index = 0; index < units.length - 2; index++) {
    const triple = [units[index]!, units[index + 1]!, units[index + 2]!];
    if (triple.every(unit => unit.length >= 4)) phrases.push(triple.join(" "));
  }
  return uniqueKernelStrings(phrases)
    .sort((left, right) => sourceAnchorPhraseRank(right) - sourceAnchorPhraseRank(left) || splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length)
    .slice(0, 16);
}


 function requestContentAnchorUnits(requestText: string): string[] {
  return requestContentPriorUnits(requestText)
    .map(stripOuterPriorSeparators)
    .map(normalizePriorKey)
    .filter(unit => unit.length >= 3 && !genericQuestionSignal(unit));
}


 function anchorPhraseUnitsSpecificEnough(units: readonly string[]): boolean {
  if (units.length < 2) return false;
  const lengths = units.map(unit => [...unit].length);
  if (lengths.every(length => length >= 4)) return true;
  return units.length === 2 && Math.min(...lengths) >= 3 && lengths.reduce((sum, length) => sum + length, 0) >= 11;
}


 function sourceAnchorPhraseRank(anchor: string): number {
  const units = splitPriorUnits(anchor);
  const lengthMass = units.reduce((sum, unit) => sum + Math.min(12, [...unit].length), 0);
  const shortPenalty = units.filter(unit => [...unit].length < 4).length * 6;
  return lengthMass - shortPenalty + units.length * 2;
}


 function sourceAnchorSpecificEnough(anchor: string): boolean {
  const units = splitPriorUnits(anchor);
  if (units.length >= 2) return true;
  return hasUncasedNonLatinLetter(anchor) && [...anchor].length >= 2;
}


 function evidenceSourceMatchesAnchors(span: EvidenceSpan, anchors: readonly string[]): boolean {
  const source = normalizePriorKey(evidenceSourceAnchorSurface(span));
  if (!source) return false;
  return anchors.some(anchor => evidenceMatchesSourceAnchor(span, anchor));
}


export function evidenceMatchesSourceAnchor(span: EvidenceSpan, anchor: string): boolean {
  const source = normalizePriorKey(evidenceSourceAnchorSurface(span));
  if (!anchor) return false;
  const sourceUnits = splitPriorUnits(source).filter(Boolean);
  const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
  if (!anchorUnits.length) return false;
  if (sourceUnits.length && sourceAnchorPhraseContains(sourceUnits, anchorUnits)) return true;
  if (anchorUnits.length === 1 && sourceUnits.some(unit => requestUnitMatchesSurface(anchorUnits[0]!, unit))) return true;
  const matched = anchorUnits.filter(anchorUnit => sourceUnits.some(sourceUnit => requestUnitMatchesSurface(anchorUnit, sourceUnit))).length;
  return matched >= Math.min(2, anchorUnits.length);
}


export function sourceAnchorPhraseContains(sourceUnits: readonly string[], anchorUnits: readonly string[]): boolean {
  if (!sourceUnits.length || !anchorUnits.length || anchorUnits.length > sourceUnits.length) return false;
  for (let index = 0; index <= sourceUnits.length - anchorUnits.length; index++) {
    const window = sourceUnits.slice(index, index + anchorUnits.length);
    if (window.every((unit, offset) => requestUnitMatchesSurface(anchorUnits[offset]!, unit))) return true;
  }
  return sourceAnchorOrderedNearMatch(sourceUnits, anchorUnits);
}


 function sourceAnchorOrderedNearMatch(sourceUnits: readonly string[], anchorUnits: readonly string[]): boolean {
  if (anchorUnits.length < 2) return false;
  const maxWindow = anchorUnits.length + 2;
  for (let start = 0; start < sourceUnits.length; start++) {
    if (!requestUnitMatchesSurface(anchorUnits[0]!, sourceUnits[start] ?? "")) continue;
    let anchorIndex = 1;
    const end = Math.min(sourceUnits.length - 1, start + maxWindow - 1);
    for (let surfaceIndex = start + 1; surfaceIndex <= end && anchorIndex < anchorUnits.length; surfaceIndex++) {
      if (requestUnitMatchesSurface(anchorUnits[anchorIndex]!, sourceUnits[surfaceIndex] ?? "")) anchorIndex++;
    }
    if (anchorIndex >= anchorUnits.length) return true;
  }
  return false;
}


 function evidenceExactSourceAnchorMatches(span: EvidenceSpan, anchors: readonly string[]): boolean {
  const title = evidenceTitle(span);
  const exactSurfaces = title ? [title] : [];
  return exactSurfaces.some(surface => {
    const normalized = normalizePriorKey(surface);
    return Boolean(normalized) && anchors.some(anchor => normalized === anchor);
  });
}


 function evidenceTitleDistinctAnchorMatches(span: EvidenceSpan, anchors: readonly string[]): boolean {
  const rawTitle = evidenceTitle(span);
  const title = normalizePriorKey(rawTitle);
  const coreTitle = normalizePriorKey(stripParentheticalTitleQualifiers(rawTitle));
  if (!title && !coreTitle) return false;
  const titleUnits = titleAnchorUnits(coreTitle || title);
  const rawCoreUnits = splitPriorUnits(coreTitle || title).filter(Boolean);
  if (!titleUnits.length) return false;
  for (const anchor of anchors) {
    const anchorUnits = titleAnchorUnits(anchor);
    if (!anchorUnits.length) continue;
    if (titleAnchorPhraseMatches(coreTitle || title, anchor)) {
      if (anchorUnits.length === 1 && rawCoreUnits.length > 1 && !evidenceTitleExactlyMatchesAnchor(span, anchor)) continue;
      return true;
    }
    const matchedTitleUnits = titleUnits.filter(titleUnit => anchorUnits.some(unit => titleAnchorUnitMatches(unit, titleUnit)));
    const matchedAnchorUnits = anchorUnits.filter(unit => titleUnits.some(titleUnit => titleAnchorUnitMatches(unit, titleUnit)));
    if (hasUncasedNonLatinLetter(anchor) && titleUnits.length === 1 && rawCoreUnits.length >= 2 && anchorUnits[0] && titleAnchorUnitMatches(anchorUnits[0], titleUnits[0]!)) return true;
    if (titleUnits.length === 1 && rawCoreUnits.length === 1 && titleSingleUnitMatchesNonInitialAnchor(titleUnits[0]!, anchorUnits)) return true;
    if (titleUnits.length >= 2 && matchedTitleUnits.length >= Math.min(2, titleUnits.length) && matchedAnchorUnits.length >= Math.min(2, anchorUnits.length)) return true;
  }
  return false;
}


 function evidenceTitleExactlyMatchesAnchor(span: EvidenceSpan, anchor: string): boolean {
  const rawTitle = evidenceTitle(span);
  const title = normalizePriorKey(rawTitle);
  const coreTitle = normalizePriorKey(stripParentheticalTitleQualifiers(rawTitle));
  const normalizedAnchor = normalizePriorKey(anchor);
  return Boolean(normalizedAnchor) && (title === normalizedAnchor || coreTitle === normalizedAnchor);
}


 function titleAnchorUnits(surface: string): string[] {
  return splitPriorUnits(normalizePriorKey(surface))
    .map(unit => unit.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(unit => unit.length >= 4 && !genericQuestionSignal(unit));
}


 function stripParentheticalTitleQualifiers(value: string): string {
  return value.replace(/\s*\([^)]*\)\s*/gu, " ").trim();
}


 function titleAnchorPhraseMatches(title: string, anchor: string): boolean {
  if (!title || !anchor) return false;
  if (title === anchor) return true;
  const paddedTitle = ` ${title} `;
  const paddedAnchor = ` ${anchor} `;
  return paddedTitle.includes(` ${anchor} `) || paddedAnchor.includes(` ${title} `);
}


 function titleSingleUnitMatchesNonInitialAnchor(titleUnit: string, anchorUnits: readonly string[]): boolean {
  if (!titleUnit || anchorUnits.length < 2) return false;
  return anchorUnits.some((unit, index) => index > 0 && titleAnchorUnitMatches(unit, titleUnit));
}


 function titleAnchorUnitMatches(unit: string, titleUnit: string): boolean {
  if (!unit || !titleUnit) return false;
  if (unit === titleUnit) return true;
  const minLength = Math.min(unit.length, titleUnit.length);
  const maxLength = Math.max(unit.length, titleUnit.length);
  return (unit.startsWith(titleUnit) || titleUnit.startsWith(unit)) && minLength / Math.max(1, maxLength) >= 0.72;
}


export function evidenceSourceAnchorSurface(span: EvidenceSpan): string {
  const provenance = jsonRecord(span.provenance);
  const metadata = jsonRecord(provenance.metadata);
  return [
    evidenceTitle(span),
    kernelString(provenance.uri),
    kernelString(provenance.canonicalUri),
    kernelString(provenance.sourceUri),
    kernelString(metadata.uri),
    kernelString(metadata.canonicalUri),
    kernelString(metadata.sourceUri)
  ].filter(Boolean).join(" ");
}


 function localEvidenceAnswerScore(requestText: string, evidence: readonly EvidenceSpan[]): number {
  const requestFeatures = featureSet(requestText, 256);
  return evidence.reduce((best, span) => {
    const surface = sourceTextSurface(span.text || span.textPreview, 24000);
    const score = Math.max(
      weightedJaccard(requestFeatures, span.features),
      weightedJaccard(requestFeatures, featureSet(surface, 256))
    ) + span.alpha * 0.12;
    return Math.max(best, score);
  }, 0);
}


 interface ArithmeticEvaluation {
  expression: string;
  normalizedExpression: string;
  value: number;
  valueText: string;
  answer: string;
  audit: JsonValue;
}


 interface ArithmeticToken {
  kind: "number" | "operator" | "left" | "right";
  value: string;
  numeric?: number;
}


export function arithmeticAnswerForText(text: string): ArithmeticEvaluation | undefined {
  for (const candidate of arithmeticCandidateSegments(text)) {
    const parsed = parseArithmeticExpression(candidate);
    if (!parsed) continue;
    const valueText = formatArithmeticNumber(parsed.value);
    const expression = formatArithmeticExpression(parsed.normalizedExpression);
    return {
      expression,
      normalizedExpression: parsed.normalizedExpression,
      value: parsed.value,
      valueText,
      answer: `${expression} = ${valueText}.`,
      audit: toJsonValue({
        source: "kernel.turn.deterministic_arithmetic",
        expressionHash: hashTextForLocalProof(parsed.normalizedExpression),
        operatorCount: parsed.operatorCount,
        numberCount: parsed.numberCount,
        valueText
      })
    };
  }
  return undefined;
}


 function arithmeticCandidateSegments(text: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (const char of text) {
    if (arithmeticCandidateChar(char)) {
      current += char;
      continue;
    }
    if (current.trim()) segments.push(current.trim());
    current = "";
  }
  if (current.trim()) segments.push(current.trim());
  return segments
    .map(segment => segment.slice(0, 160))
    .filter(plausibleArithmeticSegment)
    .sort((left, right) => right.length - left.length);
}


 function arithmeticCandidateChar(char: string): boolean {
  const code = char.codePointAt(0);
  return (char >= "0" && char <= "9") || char === "." || char === " " || char === "\t" || char === "\r" || char === "\n" || "+-*/^()[]{}".includes(char) || code === 0xd7 || code === 0xf7 || code === 0x2212;
}


 function plausibleArithmeticSegment(segment: string): boolean {
  const compact = normalizeArithmeticOperators(segment).replace(/\s+/gu, "");
  if (compact.length < 3 || compact.length > 140) return false;
  if (/^\d{4}-\d{1,2}(?:-\d{1,2})?$/u.test(compact)) return false;
  if ((compact.match(/\d+(?:\.\d+)?/gu) ?? []).length < 2) return false;
  return /[+\-*/^]/u.test(compact);
}


 function parseArithmeticExpression(raw: string): { value: number; normalizedExpression: string; operatorCount: number; numberCount: number } | undefined {
  const normalizedExpression = normalizeArithmeticOperators(raw).replace(/\s+/gu, "");
  const tokens = tokenizeArithmeticExpression(normalizedExpression);
  if (!tokens?.length) return undefined;
  let position = 0;
  let operatorCount = 0;
  const numberCount = tokens.filter(token => token.kind === "number").length;
  const peek = (): ArithmeticToken | undefined => tokens[position];
  const fail = (): never => { throw new Error("invalid arithmetic expression"); };
  const consume = (): ArithmeticToken => {
    const token = tokens[position];
    if (!token) return fail();
    position++;
    return token;
  };
  const bounded = (value: number): number => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e15) fail();
    return Object.is(value, -0) ? 0 : value;
  };
  const parseExpression = (): number => parseAdditive();
  const parseAdditive = (): number => {
    let left = parseMultiplicative();
    while (peek()?.kind === "operator" && (peek()?.value === "+" || peek()?.value === "-")) {
      const operator = consume().value;
      const right = parseMultiplicative();
      operatorCount++;
      left = bounded(operator === "+" ? left + right : left - right);
    }
    return left;
  };
  const parseMultiplicative = (): number => {
    let left = parsePower();
    while (peek()?.kind === "operator" && (peek()?.value === "*" || peek()?.value === "/")) {
      const operator = consume().value;
      const right = parsePower();
      if (operator === "/" && right === 0) fail();
      operatorCount++;
      left = bounded(operator === "*" ? left * right : left / right);
    }
    return left;
  };
  const parsePower = (): number => {
    let left = parseUnary();
    if (peek()?.kind === "operator" && peek()?.value === "^") {
      consume();
      const right = parsePower();
      operatorCount++;
      left = bounded(left ** right);
    }
    return left;
  };
  const parseUnary = (): number => {
    if (peek()?.kind === "operator" && (peek()?.value === "+" || peek()?.value === "-")) {
      const operator = consume().value;
      const value = parseUnary();
      return bounded(operator === "-" ? -value : value);
    }
    return parsePrimary();
  };
  const parsePrimary = (): number => {
    const token = consume();
    if (!token) fail();
    if (token.kind === "number" && token.numeric !== undefined) return bounded(token.numeric);
    if (token.kind === "left") {
      const value = parseExpression();
      if (peek()?.kind !== "right") fail();
      consume();
      return bounded(value);
    }
    return fail();
  };
  try {
    const value = bounded(parseExpression());
    if (position !== tokens.length || operatorCount < 1 || numberCount < 2) return undefined;
    return { value, normalizedExpression, operatorCount, numberCount };
  } catch {
    return undefined;
  }
}


 function tokenizeArithmeticExpression(expression: string): ArithmeticToken[] | undefined {
  const tokens: ArithmeticToken[] = [];
  for (let index = 0; index < expression.length;) {
    const char = expression[index];
    if (char === undefined) return undefined;
    if ((char >= "0" && char <= "9") || char === ".") {
      let end = index + 1;
      while (end < expression.length) {
        const next = expression[end];
        if (next === undefined || !((next >= "0" && next <= "9") || next === ".")) break;
        end++;
      }
      const raw = expression.slice(index, end);
      if (!/^\d+(?:\.\d+)?$|^\.\d+$/u.test(raw)) return undefined;
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) return undefined;
      tokens.push({ kind: "number", value: raw, numeric });
      index = end;
      continue;
    }
    if ("+-*/^".includes(char)) {
      tokens.push({ kind: "operator", value: char });
      index++;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      tokens.push({ kind: "left", value: char });
      index++;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      tokens.push({ kind: "right", value: char });
      index++;
      continue;
    }
    return undefined;
  }
  return tokens;
}


 function normalizeArithmeticOperators(text: string): string {
  return [...text].map(char => {
    const code = char.codePointAt(0);
    if (code === 0xd7) return "*";
    if (code === 0xf7) return "/";
    if (code === 0x2212) return "-";
    return char;
  }).join("");
}


 function formatArithmeticExpression(expression: string): string {
  return expression
    .replace(/\*/gu, " * ")
    .replace(/\//gu, " / ")
    .replace(/\^/gu, " ^ ")
    .replace(/\+/gu, " + ")
    .replace(/-/gu, " - ")
    .replace(/\s+/gu, " ")
    .replace(/\(\s+/gu, "(")
    .replace(/\s+\)/gu, ")")
    .trim();
}


 function formatArithmeticNumber(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value;
  if (Number.isSafeInteger(normalized)) return String(normalized);
  return String(Number(normalized.toPrecision(12)));
}


export function createArithmeticEntailment(input: {
  requestText: string;
  arithmetic: ArithmeticEvaluation;
  field: TurnResult["field"];
  idFactory: Pick<IdFactory, "claimId" | "proofId">;
  createdAt: number;
}): TurnResult["entailment"] {
  const normalized = `${input.arithmetic.normalizedExpression}=${input.arithmetic.valueText}`;
  const features = featureSet(normalized, 256);
  const claim = {
    id: input.idFactory.claimId({ normalized, polarity: 1, features: features.slice(0, 96) }),
    text: input.requestText,
    normalized,
    features,
    polarity: 1
  };
  const transformIds = ["deterministic-arithmetic"];
  const proofId = input.idFactory.proofId({ claimId: claim.id, evidenceIds: [], transforms: transformIds, validatorVersion: "scce-deterministic-arithmetic-v1" });
  const scores = {
    structuralCoverage: 1,
    roleCoverage: 1,
    relationCompatibility: 1,
    transformationSupport: 1,
    causalMass: Math.min(1, input.field.causalMass.reduce((sum, row) => sum + Math.max(0, row.mass), 0)),
    faithfulnessLCB: 1,
    contradiction: 0,
    stability: 1
  };
  const confidence = {
    verdict: "entailed" as const,
    support: 1,
    contradiction: 0,
    faithfulnessLcb: 1,
    supportingEvidence: 0,
    sourceVersions: [],
    structuralCoverage: scores.structuralCoverage,
    roleCoverage: scores.roleCoverage,
    relationCompatibility: scores.relationCompatibility,
    transformationSupport: scores.transformationSupport,
    causalMass: scores.causalMass,
    stability: scores.stability,
    satisfiedObligations: 1,
    requiredObligations: 1
  };
  const proofGraph = {
    nodes: [
      { id: String(claim.id), kind: "claim" as const, label: "proof.claim.deterministic_arithmetic", metadata: toJsonValue({ normalizedHash: hashTextForLocalProof(normalized) }) },
      { id: "transform:deterministic-arithmetic", kind: "transform" as const, label: "proof.transform.deterministic_arithmetic", metadata: input.arithmetic.audit },
      { id: "boundary:deterministic-computation", kind: "boundary" as const, label: "proof.boundary.deterministic_computation", metadata: toJsonValue({ validatorVersion: "scce-deterministic-arithmetic-v1", sourceEvidenceRequired: false }) }
    ],
    edges: [
      { source: "transform:deterministic-arithmetic", target: String(claim.id), relation: "transforms" as const, weight: 1, evidenceIds: [] },
      { source: "boundary:deterministic-computation", target: String(claim.id), relation: "bounds" as const, weight: 1, evidenceIds: [] }
    ]
  };
  return {
    claim,
    verdict: "entailed",
    semanticVerdict: "entailed",
    force: "proved",
    support: 1,
    contradiction: 0,
    faithfulnessLcb: 1,
    confidence,
    scores,
    obligations: [{
      id: "obligation:deterministic-quantity",
      kind: "quantity",
      status: "satisfied",
      claimText: input.arithmetic.normalizedExpression,
      evidenceIds: [],
      sourceVersionIds: [],
      support: 1,
      contradiction: 0,
      required: true,
      reason: "proof.obligation.deterministic_quantity",
      metadata: input.arithmetic.audit
    }],
    mappings: [],
    transforms: [{
      id: "transform:deterministic-arithmetic",
      transformKind: "constraint_preservation",
      source: input.arithmetic.normalizedExpression,
      target: input.arithmetic.valueText,
      registered: true,
      support: 1,
      evidenceIds: [],
      sourceVersionIds: [],
      audit: input.arithmetic.audit
    }],
    counterexamples: [],
    missing: [],
    proof: {
      id: proofId,
      claimId: claim.id,
      verdict: "proved",
      confidence: toJsonValue({ ...confidence, deterministicArithmetic: true, sourceEvidenceRequired: false }),
      proofGraph,
      evidenceIds: [],
      transformIds,
      scores: toJsonValue({ deterministicArithmetic: true, scores }),
      validatorVersion: "scce-deterministic-arithmetic-v1",
      createdAt: input.createdAt
    },
    evidenceIds: [],
    boundaries: ["deterministic-arithmetic", "source-evidence-not-required"]
  };
}


 function createLocalEvidenceEntailment(input: {
  requestText: string;
  evidence: readonly EvidenceSpan[];
  field: TurnResult["field"];
  idFactory: Pick<IdFactory, "claimId" | "proofId">;
  createdAt: number;
}): TurnResult["entailment"] {
  const normalized = normalizePriorKey(input.requestText);
  const features = featureSet(input.requestText, 512);
  const claim = {
    id: input.idFactory.claimId({ normalized, polarity: 1, features: features.slice(0, 96) }),
    text: input.requestText,
    normalized,
    features,
    polarity: 1
  };
  const evidenceIds = uniqueKernelStrings(input.evidence.map(span => String(span.id))).map(id => id as EvidenceSpan["id"]);
  const sourceVersions = uniqueKernelStrings(input.evidence.map(span => String(span.sourceVersionId)));
  const relevance = localEvidenceAnswerScore(input.requestText, input.evidence);
  const fieldMass = input.field.ppf.slice(0, 16).reduce((sum, row) => sum + Math.max(0, Math.min(1, row.mass)), 0);
  const support = Math.min(0.74, 0.24 + relevance * 0.72 + Math.min(0.18, input.evidence.length * 0.018) + Math.min(0.08, fieldMass * 0.08));
  const faithfulnessLcb = Math.min(0.64, Math.max(0.24, support * 0.82));
  const stability = Math.min(0.82, 0.42 + Math.min(0.24, input.evidence.length * 0.02) + Math.min(0.16, input.evidence.reduce((sum, span) => sum + span.alpha, 0) / Math.max(1, input.evidence.length) * 0.16));
  const force: EpistemicForce = support >= 0.34 ? "inferred" : "conjectured";
  const transformIds = ["local-evidence-fast-path", "source-bound-surface"];
  const proofId = input.idFactory.proofId({ claimId: claim.id, evidenceIds, transforms: transformIds, validatorVersion: "scce-local-evidence-bound-v1" });
  const scores = {
    structuralCoverage: Math.min(1, relevance + 0.12),
    roleCoverage: Math.min(1, relevance + 0.08),
    relationCompatibility: Math.min(1, relevance + 0.16),
    transformationSupport: 0,
    causalMass: Math.min(1, fieldMass),
    faithfulnessLCB: faithfulnessLcb,
    contradiction: 0,
    stability
  };
  const proofGraph = {
    nodes: [
      { id: String(claim.id), kind: "claim" as const, label: "proof.claim.local_evidence_bound", metadata: toJsonValue({ textHash: hashTextForLocalProof(input.requestText), normalizedHash: hashTextForLocalProof(normalized) }) },
      ...input.evidence.map(span => ({
        id: String(span.id),
        kind: "evidence" as const,
        label: "proof.evidence.selected_local",
        metadata: toJsonValue({
          sourceVersionId: String(span.sourceVersionId),
          contentHash: String(span.contentHash),
          status: span.status,
          alpha: span.alpha
        })
      })),
      { id: "boundary:local-evidence-fast-path", kind: "boundary" as const, label: "proof.boundary.local_evidence_fast_path", metadata: toJsonValue({ validatorVersion: "scce-local-evidence-bound-v1", certifiesFullProof: false }) }
    ],
    edges: [
      ...input.evidence.map(span => ({
        source: String(span.id),
        target: String(claim.id),
        relation: "supports" as const,
        weight: Math.max(0.01, Math.min(1, span.alpha)),
        evidenceIds: [span.id]
      })),
      { source: "boundary:local-evidence-fast-path", target: String(claim.id), relation: "bounds" as const, weight: 1, evidenceIds }
    ]
  };
  const confidence = {
    verdict: "underdetermined" as const,
    support,
    contradiction: 0,
    faithfulnessLcb,
    supportingEvidence: evidenceIds.length,
    sourceVersions,
    structuralCoverage: scores.structuralCoverage,
    roleCoverage: scores.roleCoverage,
    relationCompatibility: scores.relationCompatibility,
    transformationSupport: scores.transformationSupport,
    causalMass: scores.causalMass,
    stability,
    satisfiedObligations: evidenceIds.length ? 1 : 0,
    requiredObligations: 1
  };
  return {
    claim,
    verdict: "underdetermined",
    semanticVerdict: "underdetermined",
    force,
    support,
    contradiction: 0,
    faithfulnessLcb,
    confidence,
    scores,
    obligations: [{
      id: "obligation:source-bound-local-evidence",
      kind: "source_version",
      status: evidenceIds.length ? "satisfied" : "missing",
      claimText: input.requestText,
      evidenceIds,
      sourceVersionIds: sourceVersions.map(id => id as EvidenceSpan["sourceVersionId"]),
      support,
      contradiction: 0,
      required: true,
      reason: "proof.obligation.source_bound_local_evidence",
      metadata: toJsonValue({ validatorVersion: "scce-local-evidence-bound-v1" })
    }],
    mappings: [],
    transforms: [{
      id: "transform:source-bound-surface",
      transformKind: "supported_paraphrase",
      source: "selected-local-evidence",
      target: "answer-surface",
      registered: true,
      support,
      evidenceIds,
      sourceVersionIds: sourceVersions.map(id => id as EvidenceSpan["sourceVersionId"]),
      audit: toJsonValue({ validatorVersion: "scce-local-evidence-bound-v1", relevance })
    }],
    counterexamples: [],
    missing: [],
    proof: {
      id: proofId,
      claimId: claim.id,
      verdict: force,
      confidence: toJsonValue({ ...confidence, localEvidenceBound: true, certifiesFullProof: false, relevance }),
      proofGraph,
      evidenceIds,
      transformIds,
      scores: toJsonValue({ localEvidenceBound: true, relevance, scores }),
      validatorVersion: "scce-local-evidence-bound-v1",
      createdAt: input.createdAt
    },
    evidenceIds,
    boundaries: ["selected-evidence-bound", "fast-local-evidence-answer", "local-evidence-certification-boundary"]
  };
}


export function hashTextForLocalProof(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}


export function bindSelectedEvidenceToEntailment(entailment: TurnResult["entailment"], evidence: readonly EvidenceSpan[], audit: JsonValue): TurnResult["entailment"] {
  const auditRecord = jsonRecord(audit);
  const sourceBoundTemporalInference = kernelString(auditRecord.basisClassId) === "basis.9f1b2c7a";
  const evidenceIds = uniqueKernelStrings([
    ...entailment.evidenceIds.map(String),
    ...evidence.map(span => String(span.id))
  ]).map(id => id as EvidenceSpan["id"]);
  const sourceVersions = uniqueKernelStrings([
    ...entailment.confidence.sourceVersions,
    ...evidence.map(span => String(span.sourceVersionId))
  ]);
  const existingNodeIds = new Set(entailment.proof.proofGraph.nodes.map(node => node.id));
  const evidenceNodes = evidence
    .filter(span => !existingNodeIds.has(String(span.id)))
    .map(span => ({
      id: String(span.id),
      kind: "evidence" as const,
      label: "proof.evidence.selected_local",
      metadata: toJsonValue({
        sourceVersionId: String(span.sourceVersionId),
        contentHash: String(span.contentHash),
        status: span.status,
        alpha: span.alpha
      })
    }));
  const evidenceEdges = evidence.map(span => ({
    source: String(span.id),
    target: String(entailment.claim.id),
    relation: "supports" as const,
    weight: Math.max(0.01, Math.min(1, span.alpha)),
    evidenceIds: [span.id]
  }));
  const confidence = {
    ...entailment.confidence,
    supportingEvidence: evidenceIds.length,
    sourceVersions
  };
  return {
    ...entailment,
    force: sourceBoundTemporalInference ? "inferred" : entailment.force,
    truthState: sourceBoundTemporalInference ? "truth.source_bound_only" : entailment.truthState,
    evidenceIds,
    confidence,
    proof: {
      ...entailment.proof,
      verdict: sourceBoundTemporalInference ? "inferred" : entailment.proof.verdict,
      evidenceIds,
      confidence: toJsonValue({
        ...jsonRecord(entailment.proof.confidence),
        selectedEvidenceBound: audit,
        selectedAnswerForce: sourceBoundTemporalInference ? "inferred" : entailment.force,
        selectedAnswerTruthState: sourceBoundTemporalInference ? "truth.source_bound_only" : entailment.truthState ?? null,
        originalEntailmentForce: entailment.force,
        originalEntailmentTruthState: entailment.truthState ?? null,
        originalContradiction: entailment.contradiction,
        supportingEvidence: evidenceIds.length,
        sourceVersions
      }),
      proofGraph: {
        nodes: [...entailment.proof.proofGraph.nodes, ...evidenceNodes],
        edges: [...entailment.proof.proofGraph.edges, ...evidenceEdges]
      },
      scores: {
        ...jsonRecord(entailment.proof.scores),
        selectedEvidenceBound: audit
      }
    },
    boundaries: [...new Set([
      ...entailment.boundaries,
      "selected-evidence-bound",
      "fast-local-evidence-answer",
      ...(sourceBoundTemporalInference ? ["temporal-counterexample-source-bound-inference"] : [])
    ])]
  };
}


export function promotedSessionEvidence(span: EvidenceSpan): boolean {
  return span.status === "promoted" && String(span.id).startsWith("evidence_session_");
}


 function bestEvidenceSurface(requestText: string, evidence: readonly EvidenceSpan[]): string {
  return bestEvidenceSentences(requestText, evidence)
    .map(ensureSentenceSurface)
    .filter(Boolean)
    .join(" ");
}


 interface EvidenceSentenceRow {
  span: EvidenceSpan;
  sentence: string;
  features: string[];
  index: number;
  score: number;
  unitOverlap: number;
}


 function bestEvidenceSentences(requestText: string, evidence: readonly EvidenceSpan[], sessionContextEvidence = false): string[] {
  const limit = evidenceAnswerSentenceLimit(requestText, evidence, sessionContextEvidence);
  if (evidence.length === 1) {
    const span = evidence[0];
    if (!span) return [];
    const sentences = fastAnswerSentences(sourceTextSurface(span.text || span.textPreview || "", 24000));
    const requestFeatures = featureSet(requestText, 256);
    const requestUnits = requestUnitSet(requestText);
    const anchors = sourceEvidenceAnchorsForRequest(requestText);
    const focused = sentences
      .map((sentence, index): EvidenceSentenceRow => {
        const clean = anchorFocusedAnswerSurface(cleanSourceAnswerSurface(sentence), anchors, evidenceTitle(span));
        const unitOverlap = requestUnitOverlapForSurface(clean, requestUnits);
        const anchorBoost = sourceSurfaceMatchesAnyAnchor(clean, anchors) ? 0.54 : 0;
        const titleLeadBoost = anchors.length && index <= 1 && evidenceTitleDistinctAnchorMatches(span, anchors) && evidenceTitleAppearsInSurface(span, clean) ? 0.32 : 0;
        return {
          span,
          sentence: clean,
          features: featureSet(clean, 256),
          index,
          unitOverlap,
          score: unitOverlap * 0.92 + weightedJaccard(requestFeatures, featureSet(clean, 256)) * 0.35 + Math.max(0, 0.16 - index * 0.018) + titleLeadBoost + anchorBoost - fastAnswerLongSentencePenalty(clean)
        };
      })
      .filter(row => row.sentence && (row.score > 0.16 || (anchors.length > 0 && row.index === 0)))
      .sort((left, right) => right.score - left.score || right.unitOverlap - left.unitOverlap || left.index - right.index);
    const selected = selectEvidenceSentenceRows(focused.length ? focused : sentences.map((sentence, index): EvidenceSentenceRow => {
      const clean = cleanSourceAnswerSurface(sentence);
        return {
          span,
          sentence: clean,
          features: featureSet(clean, 256),
        index,
        unitOverlap: requestUnitOverlapForSurface(clean, requestUnits),
        score: Math.max(0, 0.12 - index * 0.012)
      };
    }), limit);
    return selected.map(row => row.sentence);
  }
  const requestFeatures = featureSet(requestText, 256);
  const requestUnits = requestUnitSet(requestText);
  const orderedRequestUnits = requestUnitsFromText(requestText);
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  const candidates = evidence
    .flatMap(span => fastAnswerSentences(sourceTextSurface(span.text || span.textPreview, 24000)).slice(0, 80).map((surface, index) => {
      const clean = anchorFocusedAnswerSurface(cleanSourceAnswerSurface(surface), anchors, evidenceTitle(span));
      const features = featureSet(clean, 256);
      const lexical = weightedJaccard(requestFeatures, features) + weightedJaccard(requestFeatures, span.features) * 0.35;
      const unitOverlap = requestUnitOverlapForSurface(clean, requestUnits);
      const pairOverlap = surfaceRequestAdjacentUnitPairOverlap(clean, orderedRequestUnits);
      const anchorBoost = sourceSurfaceMatchesAnyAnchor(clean, anchors) ? 0.54 : 0;
      const positionPrior = Math.max(0, 0.18 - index * 0.015);
      return {
        span,
        sentence: clean,
        features,
        index,
        unitOverlap,
        score: lexical + Math.min(4, unitOverlap) * 0.08 + pairOverlap * 0.16 + span.alpha * 0.12 + positionPrior + anchorBoost + fastAnswerNamedSurfaceMass(clean) * 0.22 - fastAnswerLongSentencePenalty(clean)
      };
    }))
    .filter(row => row.sentence)
    .sort((a, b) => b.score - a.score || String(a.span.id).localeCompare(String(b.span.id)));
  const selected = selectEvidenceSentenceRows(candidates, limit);
  return selected.map(item => item.sentence);
}


 function anchorFocusedAnswerSurface(surface: string, anchors: readonly string[], title = ""): string {
  if (!surface || !anchors.length) return surface;
  const parts = splitSourceSentenceBoundaries(surface);
  const selected = parts.find(part => sourceSurfaceMatchesAnyAnchor(part, anchors)) ?? surface;
  return anchorLocalSurface(stripLeadingSourceTitle(selected, title, anchors), anchors);
}


 function stripLeadingSourceTitle(surface: string, title: string, anchors: readonly string[]): string {
  const cleanTitle = cleanSourceAnswerSurface(title);
  if (!surface || !cleanTitle) return surface;
  const rawPrefixMatch = surface.toLocaleLowerCase().startsWith(cleanTitle.toLocaleLowerCase());
  const normalizedPrefixMatch = normalizePriorKey(surface).startsWith(normalizePriorKey(cleanTitle));
  if (!rawPrefixMatch && !normalizedPrefixMatch) return surface;
  const stripped = rawPrefixMatch
    ? surface.slice(cleanTitle.length).replace(/^[\s:;,\-.|]+/u, "").trim()
    : stripLeadingSurfaceUnits(surface, splitPriorUnits(normalizePriorKey(cleanTitle)).length);
  return stripped && sourceSurfaceMatchesAnyAnchor(stripped, anchors) ? stripped : surface;
}


 function stripLeadingSurfaceUnits(surface: string, unitCount: number): string {
  if (unitCount <= 0) return surface;
  let seen = 0;
  let index = 0;
  let inUnit = false;
  for (; index < surface.length; index++) {
    const char = surface[index] ?? "";
    if (/\p{L}|\p{N}/u.test(char)) {
      if (!inUnit) {
        seen++;
        inUnit = true;
      }
      continue;
    }
    if (inUnit && seen >= unitCount) {
      index++;
      break;
    }
    inUnit = false;
  }
  return surface.slice(index).replace(/^[\s:;,\-.|]+/u, "").trim();
}


 function anchorLocalSurface(surface: string, anchors: readonly string[]): string {
  if (!surface || !anchors.length) return surface;
  const words = surfaceWords(surface);
  if (words.length < 12) return surface;
  const normalized = words.map(word => normalizePriorKey(stripOuterPriorSeparators(word))).filter(Boolean);
  for (const anchor of anchors) {
    const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
    if (!anchorUnits.length) continue;
    const first = anchorUnits[0] ?? "";
    const index = normalized.findIndex(unit => requestUnitMatchesSurface(first, unit));
    if (index <= 8) continue;
    const clipped = words.slice(Math.max(0, index - 7)).join(" ").trim();
    if (clipped && sourceSurfaceMatchesAnyAnchor(clipped, [anchor])) return clipped;
  }
  return surface;
}


 interface LocalSurfaceWordSpan {
  start: number;
  end: number;
  key: string;
}


 function anchorMentionSurface(surface: string, anchors: readonly string[]): string {
  if (!surface || !anchors.length) return "";
  const words = localSurfaceWordSpans(surface);
  if (!words.length) return "";
  for (const anchor of anchors) {
    const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
    if (!anchorUnits.length) continue;
    for (let startIndex = 0; startIndex < words.length; startIndex++) {
      if (!requestUnitMatchesSurface(anchorUnits[0] ?? "", words[startIndex]?.key ?? "")) continue;
      let anchorIndex = 1;
      let endIndex = startIndex;
      const maxEnd = Math.min(words.length - 1, startIndex + anchorUnits.length + 4);
      for (let index = startIndex + 1; index <= maxEnd && anchorIndex < anchorUnits.length; index++) {
        if (requestUnitMatchesSurface(anchorUnits[anchorIndex] ?? "", words[index]?.key ?? "")) {
          anchorIndex++;
          endIndex = index;
        }
      }
      if (anchorIndex < anchorUnits.length) continue;
      let end = words[endIndex]?.end ?? 0;
      const parenthetical = surface.slice(end).match(/^\s*\([^)]{1,96}\)/u)?.[0] ?? "";
      if (parenthetical) end += parenthetical.length;
      const mention = cleanSourceAnswerSurface(surface.slice(words[startIndex]?.start ?? 0, end).replace(/[,;:\s]+$/u, ""));
      if (mention && sourceSurfaceMatchesAnyAnchor(mention, [anchor])) return mention;
    }
  }
  return "";
}


 function localSurfaceWordSpans(surface: string): LocalSurfaceWordSpan[] {
  const out: LocalSurfaceWordSpan[] = [];
  for (const match of surface.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)) {
    const raw = match[0] ?? "";
    const start = match.index ?? 0;
    const end = start + raw.length;
    const key = normalizePriorKey(stripOuterPriorSeparators(raw));
    if (key) out.push({ start, end, key });
  }
  return out;
}


 function splitSourceSentenceBoundaries(surface: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let index = 0; index < surface.length; index++) {
    const char = surface[index] ?? "";
    if (char !== "." && char !== "!" && char !== "?" && char !== "。" && char !== "！" && char !== "？") continue;
    const next = surface[index + 1] ?? "";
    if (next && !/\s/u.test(next)) continue;
    if (char === "." && previousSurfaceWord(surface, index).length === 1) continue;
    const part = surface.slice(start, index + 1).trim();
    if (part) out.push(part);
    start = index + 1;
  }
  const tail = surface.slice(start).trim();
  if (tail) out.push(tail);
  return out.length ? out : [surface];
}


 function previousSurfaceWord(surface: string, punctuationIndex: number): string {
  let index = punctuationIndex - 1;
  while (index >= 0 && /\s/u.test(surface[index] ?? "")) index--;
  let word = "";
  while (index >= 0) {
    const char = surface[index] ?? "";
    if (!/\p{L}|\p{N}/u.test(char)) break;
    word = `${char}${word}`;
    index--;
  }
  return word;
}


 function sourceSurfaceMatchesAnyAnchor(surface: string, anchors: readonly string[]): boolean {
  if (!surface || !anchors.length) return false;
  const units = splitPriorUnits(normalizePriorKey(surface)).filter(Boolean);
  return anchors.some(anchor => {
    const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
    return anchorUnits.length > 0 && sourceAnchorPhraseContains(units, anchorUnits);
  });
}


 function selectEvidenceSentenceRows(rows: readonly EvidenceSentenceRow[], limit: number): EvidenceSentenceRow[] {
  const selected: EvidenceSentenceRow[] = [];
  for (const candidate of rows) {
    if (selected.length >= limit) break;
    if (selected.some(item => weightedJaccard(item.features, candidate.features) > 0.9)) continue;
    selected.push(candidate);
  }
  return selected;
}


 function evidenceAnswerSentenceLimit(requestText: string, evidence: readonly EvidenceSpan[], sessionContextEvidence = false): number {
  if (sessionContextEvidence && !namedSubjectAnchors(requestText).length) return 1;
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  if (!anchors.length && evidence.some(promotedSessionEvidence)) return 1;
  return anchors.length ? 2 : 1;
}


 function evidenceTitleAppearsInSurface(span: EvidenceSpan, surface: string): boolean {
  const title = normalizePriorKey(evidenceTitle(span));
  const text = normalizePriorKey(surface);
  return Boolean(title && text && (text.includes(title) || title.includes(text)));
}


 function surfaceRequestAdjacentUnitPairOverlap(surface: string, requestUnits: readonly string[]): number {
  if (requestUnits.length < 2) return 0;
  const surfaceUnits = splitPriorUnits(normalizePriorKey(surface)).filter(unit => unit.length >= 4);
  let overlap = 0;
  for (let index = 0; index < requestUnits.length - 1; index++) {
    const left = requestUnits[index] ?? "";
    const right = requestUnits[index + 1] ?? "";
    if (!left || !right || left === right) continue;
    if (requestUnitAppearsInSurface(left, surfaceUnits) && requestUnitAppearsInSurface(right, surfaceUnits)) overlap++;
  }
  return overlap;
}


 function fastAnswerSentences(text: string): string[] {
  const merged: string[] = [];
  for (const rawSentence of splitSurfaceSentences(text)) {
    const sentence = cleanFastAnswerSentence(rawSentence);
    if (!sentence) continue;
    const previous = merged[merged.length - 1];
    if (previous && (previous.length <= 3 && previous.endsWith(".") || fastAnswerSentenceShouldMerge(previous))) {
      merged[merged.length - 1] = `${previous} ${sentence}`;
    } else {
      merged.push(sentence);
    }
  }
  return merged;
}


 function cleanFastAnswerSentence(sentence: string): string {
  const trimmed = cleanSourceAnswerSurface(sentence);
  const marker = trimmed.lastIndexOf("]]");
  if (marker >= 0 && marker < trimmed.length - 2) return cleanSourceAnswerSurface(trimmed.slice(marker + 2).replace(/^[\s\p{Punctuation}]+/u, "").trim());
  return trimmed;
}


 function cleanSourceAnswerSurface(text: string): string {
  let out = collapseSurfaceWhitespace(text.replace(/\u0000/g, " ").normalize("NFC"));
  if (!out) return "";
  out = out.replace(/\[\[\s*(?:File|Image):[^\]]{0,600}\]\]/giu, " ");
  out = out.replace(/\|(?:alt|thumb|thumbnail|frameless|upright|left|right|center)\s*=?[^|\]]{0,240}/giu, " ");
  out = out.replace(/\|[a-z][a-z0-9_-]{0,32}\s*=[^|\]]{0,240}/giu, " ");
  out = out.replace(/\[\[([^[\]|]+)\|([^\]]+)\]\]/gu, "$2");
  out = out.replace(/\[\[([^\]]+)\]\]/gu, "$1");
  out = out.replace(/\[(?:https?:)?\/\/[^\]\s]+(?:\s+([^\]]+))?\]/giu, "$1");
  out = out.replace(/={2,}\s*([^=]{1,120}?)\s*={2,}/gu, "$1");
  out = out.replace(/'{2,}/gu, "");
  out = out.replace(/(^|[\s([{])'([^']{2,160})'(?=$|[\s,.;:)\]}])/gu, "$1$2");
  out = out.replace(/\(\s*;\s*/gu, "(");
  out = out.replace(/\(\s*\)/gu, " ");
  out = out.replace(/\s+([,.;:!?])/gu, "$1");
  out = out.replace(/([([{])\s+/gu, "$1");
  out = out.replace(/\s+([)\]}])/gu, "$1");
  out = out.replace(/^\s*[,;:]\s*/u, "");
  out = out.replace(/\s+/gu, " ").trim();
  return out;
}


 function fastAnswerSentenceShouldMerge(sentence: string): boolean {
  return delimiterBalance(sentence, "(", ")") > 0 || delimiterBalance(sentence, "[", "]") > 0;
}


 function delimiterBalance(text: string, open: string, close: string): number {
  let balance = 0;
  for (const char of text) {
    if (char === open) balance++;
    else if (char === close) balance--;
  }
  return balance;
}


 function fastAnswerNamedSurfaceMass(text: string): number {
  const names = new Set(surfaceEntityRuns(text).map(item => item.toLocaleLowerCase()));
  const parentheticalNames = (text.match(/\([^)]{2,100}\)/gu) ?? []).filter(item => surfaceEntityRuns(item).length > 0).length;
  return Math.max(0, Math.min(1, Math.min(1, names.size / 16) * 0.38 + Math.min(1, parentheticalNames / 4) * 0.62));
}


 function fastAnswerLongSentencePenalty(text: string): number {
  return Math.max(0, Math.min(1, Math.max(0, text.length - 560) / 1600)) * 0.18;
}


 function ensureSentenceSurface(text: string): string {
  return ensureUnicodeSurfaceSentence(text);
}


 function sentenceBoundarySurface(text: string): string {
  const clean = collapseSurfaceWhitespace(text);
  if (clean.length < 180) return clean;
  const selected: string[] = [];
  let total = 0;
  for (const sentence of splitSurfaceSentences(clean)) {
    selected.push(sentence);
    total += sentence.length;
    if (total >= 180) break;
  }
  return selected.length ? selected.join(" ") : clean;
}


export function attachLocalEvidenceAnswerConstruct(input: {
  construct: ConstructGraph;
  plan: LocalEvidenceAnswerPlan;
  requestText: string;
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
}): ConstructGraph {
  const facts = localEvidenceAnswerFacts(input.plan, input.requestText, input.hasher);
  if (!facts.length) return input.construct;
  const marker = jsonRecord(input.brainMarker);
  const evidenceIds = uniqueKernelStrings(input.plan.evidence.map(span => String(span.id)));
  const sourceVersionIds = uniqueKernelStrings(input.plan.evidence.map(span => String(span.sourceVersionId)));
  const nodeId = `construct:ans:${input.hasher.digestHex(JSON.stringify({ planId: input.plan.planId, evidenceIds })).slice(0, 20)}`;
  const selectedSubject = localEvidenceSelectedSubject(input.plan, input.requestText);
  const metadata = {
    schema: "scce.semantic_answer_construct.v1",
    questionShapeId: `qshape.${input.hasher.digestHex(input.requestText).slice(0, 12)}`,
    selectedSubject,
    selectedFacts: facts,
    answerSlots: facts.map(fact => ({
      id: `slot.${input.hasher.digestHex(localEvidenceSemanticFactKey(fact)).slice(0, 16)}`,
      relationIds: [fact.relationId],
      factKeys: [localEvidenceSemanticFactKey(fact)],
      support: fact.support,
      activation: fact.activation
    })),
    selectedRelations: uniqueKernelStrings(facts.map(fact => fact.relationId)),
    activatedNeighborhood: facts,
    rejectedCandidates: [],
    supportIds: evidenceIds,
    forceId: "output.force.source_bound_answer",
    boundaryId: "output.force.source_bound",
    activeBrainVersion: kernelString(marker.activeBrainVersion) ?? "",
    activeImportRunIds: kernelStringArray(marker.activeImportRunIds),
    alphaRhetoricalPlan: null,
    cognitiveFabric: null,
    questionSlotPlan: null,
    certificationBoundary: {
      directEvidenceCount: evidenceIds.length,
      evidenceSpanIds: evidenceIds,
      sourceVersionIds,
      externalFactCertification: true
    },
    localEvidenceAnswer: {
      planId: input.plan.planId,
      kindId: input.plan.kindId,
      audit: input.plan.audit
    }
  };
  return {
    ...input.construct,
    nodes: [
      ...input.construct.nodes.filter(node => node.kind !== "construct:semantic_answer"),
      {
        id: nodeId,
        kind: "construct:semantic_answer",
        label: selectedSubject || facts[0]?.subject || nodeId,
        metadata: toJsonValue(metadata)
      }
    ],
    edges: [
      ...input.construct.edges,
      ...facts.flatMap(fact => [
        { source: nodeId, target: fact.sourceNodeId, relation: "rel.b40c2e11", weight: fact.support },
        { source: nodeId, target: fact.targetNodeId, relation: "rel.f73a91d0", weight: fact.support }
      ])
    ]
  };
}


 function localEvidenceAnswerFacts(plan: LocalEvidenceAnswerPlan, requestText: string, hasher: { digestHex(input: string | Uint8Array): string }): SemanticAnswerConstructFact[] {
  if (plan.kindId === LOCAL_ANSWER_KIND_IDS.collection) {
    const subject = localEvidenceSelectedSubject(plan, requestText);
    return stringArrayFromSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.memberList]).map((member, index) => localEvidenceSemanticFact({
      subject: member,
      predicate: "\u2208",
      object: subject,
      relationId: LOCAL_ANSWER_RELATION_IDS.member,
      evidence: plan.evidence,
      index,
      hasher
    }));
  }
  if (plan.kindId === LOCAL_ANSWER_KIND_IDS.temporalCounterexample) {
    const facts: SemanticAnswerConstructFact[] = [];
    const subject = firstStringSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.subject]);
    const predicate = firstStringSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.requestPredicate]);
    const concept = firstStringSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.conceptEvidence]);
    const counter = firstStringSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.counterexampleEvidence]);
    if (subject && predicate) facts.push(localEvidenceSemanticFact({
      subject,
      predicate: "\u00ac",
      object: predicate,
      relationId: LOCAL_ANSWER_RELATION_IDS.polarityReject,
      evidence: plan.evidence,
      index: 0,
      hasher
    }));
    if (concept || counter) facts.push(localEvidenceSemanticFact({
      subject: cleanSourceAnswerSurface(evidenceTitle(plan.evidence[0]!) || subject),
      predicate: kernelString(jsonRecord(plan.audit).counterexampleDate) ?? "",
      object: uniqueKernelStrings([concept, counter]).map(surface => ensureUnicodeSurfaceSentence(surface)).join(" "),
      relationId: LOCAL_ANSWER_RELATION_IDS.temporalCounterexample,
      evidence: plan.evidence,
      index: facts.length,
      hasher
    }));
    return facts;
  }
  return localEvidenceFactSurfaces(plan, requestText).map((sentence, index) => localEvidenceSemanticFact({
    subject: localEvidenceSelectedSubject(plan, requestText),
    predicate: sentence,
    object: sentence,
    relationId: LOCAL_ANSWER_RELATION_IDS.sourceQuote,
    evidence: plan.evidence,
    index,
    hasher
  }));
}


 function localEvidenceFactSurfaces(plan: LocalEvidenceAnswerPlan, requestText: string): string[] {
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  const exactTitle = anchors.length > 0 && plan.evidence.some(span => evidenceExactSourceAnchorMatches(span, anchors));
  const surfaces = uniqueKernelStrings(stringArrayFromSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.sentence])
    .map(sentence => boundedLocalQuoteSurface(localEvidenceRealizationSurface(plan, requestText, sentence), 320))
    .filter(Boolean));
  if (!anchors.length || exactTitle) return surfaces;
  const focused = surfaces
    .filter(surface => sourceSurfaceMatchesAnyAnchor(surface, anchors))
    .filter(surface => splitPriorUnits(normalizePriorKey(surface)).length <= 8);
  return focused.length ? focused.slice(0, 1) : surfaces.slice(0, 1);
}


 function localEvidenceSemanticFact(input: {
  subject: string;
  predicate: string;
  object: string;
  relationId: string;
  evidence: readonly EvidenceSpan[];
  index: number;
  hasher: { digestHex(input: string | Uint8Array): string };
}): SemanticAnswerConstructFact {
  const subject = cleanSourceAnswerSurface(input.subject);
  const predicate = cleanSourceAnswerSurface(input.predicate);
  const object = cleanSourceAnswerSurface(input.object);
  const evidenceIds = uniqueKernelStrings(input.evidence.map(span => String(span.id)));
  const sourceVersionId = String(input.evidence[0]?.sourceVersionId ?? "");
  const factKey = input.hasher.digestHex(JSON.stringify({ subject, predicate, object, relationId: input.relationId, index: input.index })).slice(0, 20);
  return {
    subject,
    predicate,
    object: object || predicate,
    sourceNodeId: `local:evidence:subject:${factKey}`,
    targetNodeId: `local:evidence:object:${factKey}`,
    relationId: input.relationId,
    forceClass: "direct_evidence",
    score: 0.86,
    activation: 0.86,
    overlap: 0.86,
    support: Math.max(0.42, mean(input.evidence.map(span => span.alpha))),
    sourceVersionId,
    evidenceIds,
    roleId: input.relationId,
    relationRoleId: input.relationId,
    questionSlotImportance: input.index === 0 ? "core" : "secondary",
    questionSlotScore: Math.max(0.42, 0.9 - input.index * 0.08),
    questionSlotReasonIds: [input.relationId]
  };
}


 function localEvidenceSemanticFactKey(fact: Pick<SemanticAnswerConstructFact, "subject" | "predicate" | "object" | "relationId">): string {
  return [fact.subject, fact.predicate, fact.object, fact.relationId]
    .map(part => collapsePriorWhitespace(part.normalize("NFKC").toLocaleLowerCase()))
    .join("\u0001");
}


 function localEvidenceSelectedSubject(plan: LocalEvidenceAnswerPlan, requestText: string): string {
  const explicit = firstStringSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.subject]);
  if (explicit) return explicit;
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  const mention = stringArrayFromSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.sentence])
    .map(sentence => anchorMentionSurface(sentence, anchors))
    .find(Boolean);
  if (mention) return mention;
  const anchor = anchors.find(value => stringArrayFromSlot(plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.sentence]).some(sentence => sourceSurfaceMatchesAnyAnchor(sentence, [value])));
  if (anchor) return anchor;
  const titled = plan.evidence.map(evidenceTitle).map(cleanSourceAnswerSurface).find(Boolean);
  if (titled) return titled;
  return cleanSourceAnswerSurface(requestText);
}


 function localEvidenceRealizationSurface(plan: LocalEvidenceAnswerPlan, requestText: string, sentence: string): string {
  const clean = cleanSourceAnswerSurface(sentence);
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  if (!clean || !anchors.length) return clean;
  const exactTitle = plan.evidence.some(span => evidenceExactSourceAnchorMatches(span, anchors));
  if (exactTitle) return clean;
  const mention = anchorMentionSurface(clean, anchors);
  if (!mention) return clean;
  const requestUnits = new Set(requestContentEvidenceUnits(requestText));
  if (
    requestUnitOverlapForSurface(clean, requestUnits)
    > requestUnitOverlapForSurface(mention, requestUnits)
  ) return clean;
  const mentionMass = splitPriorUnits(normalizePriorKey(mention)).length;
  const cleanMass = splitPriorUnits(normalizePriorKey(clean)).length;
  return mentionMass >= 2 && cleanMass > mentionMass + 4 ? mention : clean;
}


 function boundedLocalQuoteSurface(surface: string, maxChars: number): string {
  const clean = stripLocalTerminalBoundary(cleanSourceAnswerSurface(surface)).replace(/"/gu, "'");
  if ([...clean].length <= maxChars) return clean;
  return `${[...clean].slice(0, Math.max(0, maxChars - 3)).join("").replace(/\s+\S*$/u, "").trimEnd()}...`;
}


 function stripLocalTerminalBoundary(surface: string): string {
  const clean = cleanSourceAnswerSurface(surface);
  const chars = [...clean];
  const last = chars.at(-1) ?? "";
  return last === "." || last === "!" || last === "?" || last === "\u3002" || last === "\uff01" || last === "\uff1f"
    ? chars.slice(0, -1).join("").trimEnd()
    : clean;
}
