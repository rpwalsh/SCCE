// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { SEMANTIC_VERDICT, SEMANTIC_SOURCE } from "./semantic-codes.js";
import { atomizeText } from "./semantic-proof-system.js";
import { type IdFactory } from "./ids.js";
import { boundedEditDistance, collapsePriorWhitespace, genericQuestionSignal, jsonRecord, kernelClamp01, kernelNumber, kernelString, kernelStringArray, namedSubjectAnchors, normalizePriorKey, requestContentPriorUnits, splitPriorUnits, stripOuterPriorSeparators, surfaceEntityRuns, uniqueKernelStrings } from "./kernel-answer-primitives.js";
import { isProseSentence } from "./evidence-gist.js";
import { featureSet, mean, sourceTextSurface, toJsonValue, weightedJaccard } from "./primitives.js";
import { evidenceRetrievalSurface, evidenceWindowText } from "./evidence-retrieval-surface.js";
import type { SemanticAnswerConstructFact } from "./semantic-answer-construct.js";
import { collapseSurfaceWhitespace, ensureSurfaceSentence as ensureUnicodeSurfaceSentence, hasUncasedNonLatinLetter, hasUppercaseLetter, splitSurfaceSentences, surfaceWords, tidySurfaceText } from "./surface-linguistics.js";
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
  temporalCounterexample: "ans.kind.7f1c2a90",
  sourceConflict: "ans.kind.5c83b1d7"
} as const;


 const LOCAL_ANSWER_SLOT_IDS = {
  sentence: "ans.slot.0f3a7c61",
  memberList: "ans.slot.91db4a63",
  subject: "ans.slot.4c2d07a9",
  requestHead: "ans.slot.1a678d0b",
  requestPredicate: "ans.slot.42f8e39c",
  conceptEvidence: "ans.slot.b5d1c337",
  counterexampleEvidence: "ans.slot.f9a41e0d",
  conflictingStatement: "ans.slot.2e6b90fa"
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
  proofExcerpts?: Array<{ text: string; evidenceId: EvidenceSpan["id"] }>;
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


/** Every content unit of the request's anchors inside one sentence of the span: a binding mention, not a passing one. Pure. */
function anchorBindingSentenceAligned(span: EvidenceSpan, anchors: readonly string[]): boolean {
  const units = uniqueKernelStrings(anchors.flatMap(anchor => splitPriorUnits(normalizePriorKey(anchor)))).filter(unit => [...unit].length >= 3);
  if (!units.length) return false;
  return splitSurfaceSentences(String(span.text ?? span.textPreview ?? ""))
    .some(sentence => { const folded = normalizePriorKey(sentence); return units.every(unit => folded.includes(unit)); });
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
  const initialismTokens = requestInitialismCandidates(text, anchors);
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
      const contentAnchorAligned = anchors.some(anchor => evidenceContentAnchorFitsRequest(span, anchor, text));
      // The same binding-sentence rule admission uses: a span whose one sentence carries every content anchor
      // ("Sisko, played by Avery Brooks" for "Who played Sisko?") is about the subject, whatever its title says.
      // Without it the article was admitted and then dropped here on a 0.007 lexical overlap.
      const bindingSentenceAligned = anchorBindingSentenceAligned(span, anchors);
      const anchorAligned = anchors.length > 0 && (
        evidenceExactSourceAnchorMatches(span, anchors) ||
        evidenceTitleDistinctAnchorMatches(span, anchors) ||
        evidenceSourceMatchesAnchors(span, anchors) ||
        contentAnchorAligned ||
        bindingSentenceAligned
      );
      const initialismAligned = evidenceTitleInitialismMatches(span, initialismTokens);
      // A whole-article span must not lose to a dense passage on size alone: an anchor-aligned oversized span is also scored by its best sentence window.
      const windowLexical = anchorAligned && [...String(span.text ?? "")].length > 4096 ? bestSentenceWindowLexical(span, requestFeatures) : 0;
      const rankedLexical = Math.max(lexical, windowLexical);
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
      const initialismBoost = initialismAligned ? 0.6 : 0;
      const alphaBoost = lexical >= 0.025 || semanticFrameBoundAligned || priorityAligned || anchorAligned || initialismAligned ? span.alpha * 0.18 : 0;
      const sessionBoost = sessionSpan && (lexical >= 0.045 || priorityAligned) ? 0.08 : 0;
      // A request that names only the subject ("Who was Ada Lovelace?") leaves every chunk of the article tied on
      // lexical overlap, and the tie fell to alpha and id: chunk 16370 beat the opening sentence. The article's
      // opening is the definitional sentence; among anchor-aligned chunks it leads unless content outscores it.
      // The opening chunk is the definition of the article's own subject; when the request names a subject the
      // title does not ("Who played Sisko?" against Star Trek: Deep Space Nine), the chunk whose sentence binds
      // that subject is the one that answers, and the opening must not outrank it.
      const titleAligned = anchors.length > 0 && (evidenceExactSourceAnchorMatches(span, anchors) || evidenceTitleDistinctAnchorMatches(span, anchors) || evidenceSourceMatchesAnchors(span, anchors));
      const openingBoost = titleAligned && span.charStart === 0 ? 0.03 : 0;
      const bindingBoost = bindingSentenceAligned ? 0.06 : 0;
      return { span, score: rankedLexical + alphaBoost + sessionBoost + priorityBoost + initialismBoost + openingBoost + bindingBoost + Math.min(0.16, contentOverlap * 0.04), lexical, priorityAligned, explicitContextAligned, semanticFrameBoundAligned, anchorAligned, initialismAligned, sessionSpan, contentOverlap };
    })
    .filter(row => {
      if (row.explicitContextAligned || row.semanticFrameBoundAligned || row.priorityAligned || row.anchorAligned || row.initialismAligned) return true;
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


 function requestOrderedUnits(text: string): string[] {
  return splitPriorUnits(normalizePriorKey(text.replace(/[?!.]+$/u, "")))
    .map(unit => unit.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}


export function trailingInitialismTokensForAnchor(text: string, anchor: string): string[] {
  // Language-neutral by construction: a candidate is any short token
  // trailing a full, already-recognized multi-word subject anchor -- e.g.
  // "star trek tos" or "スタートレック tos" -- rather than a fixed
  // English stopword list, which would silently fail for every other
  // language this kernel is required to support. Requiring the anchor's
  // complete unit sequence (not just its last word) and trailing-only
  // (not leading) keeps ordinary surrounding words ("...known for?") from
  // being mistaken for a disambiguator: real initialisms are short and
  // follow the full subject phrase, they don't precede or partially
  // overlap it.
  //
  // A digit run trailing a single-word name is the same disambiguator, and the multi-word requirement above
  // was hiding it: "Apollo 11" reduces to the one unit "apollo", so nothing carried the 11 and the request
  // searched the Greek god. The corpus indexes anchor:bi:apollo|11 with 99 postings, 32 of them the Apollo 11
  // article, so the discriminating feature existed the whole time and was never asked for. Digits are the one
  // trailing shape that cannot be an ordinary word of any language, which is why the single-word case is
  // narrowed to them: a word trailing a one-word anchor is usually just the rest of the sentence.
  const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
  const namedSingleAnchor = anchorUnits.length === 1 && [...(anchorUnits[0] ?? "")].length >= 5;
  if (anchorUnits.length < 2 && !namedSingleAnchor) return [];
  const units = requestOrderedUnits(text);
  const out: string[] = [];
  for (let index = 0; index + anchorUnits.length < units.length; index++) {
    const matches = anchorUnits.every((anchorUnit, offset) => units[index + offset] === anchorUnit);
    if (!matches) continue;
    const next = units[index + anchorUnits.length] ?? "";
    const digitQualifier = /^\p{Number}+$/u.test(next);
    if (next.length >= 2 && next.length <= 4 && (anchorUnits.length >= 2 || digitQualifier)) out.push(next);
  }
  return uniqueKernelStrings(out);
}


export function requestInitialismCandidates(text: string, anchors: readonly string[]): string[] {
  return uniqueKernelStrings(anchors.flatMap(anchor => trailingInitialismTokensForAnchor(text, anchor)));
}


export function evidenceTitleInitialismMatches(span: EvidenceSpan, initialismTokens: readonly string[]): boolean {
  if (!initialismTokens.length) return false;
  const title = evidenceTitle(span);
  if (!title) return false;
  const words = title.match(/\p{L}[\p{L}\p{N}]*/gu) ?? [];
  if (words.length < 2) return false;
  const initials = words.map(word => (word[0] ?? "").toLocaleLowerCase());
  for (const token of initialismTokens) {
    if (token.length < 2 || token.length > initials.length) continue;
    const suffix = initials.slice(initials.length - token.length).join("");
    if (suffix === token) return true;
  }
  return false;
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
    const currentFull = sourceTextSurface(evidenceWindowText(span), 24000);
    const current = sourceTextSurface(currentFull, 2400);
    const currentScore = weightedJaccard(requestFeatures, featureSet(current, 128));
    const selected = previews
      .map(preview => ({ preview, score: weightedJaccard(requestFeatures, featureSet(preview, 128)) + Math.min(0.12, preview.length / 6000) }))
      .sort((a, b) => b.score - a.score || a.preview.length - b.preview.length)[0];
    if (selected && currentFull.length > Math.max(2400, selected.preview.length * 2)) return span;
    if (!selected || selected.score < Math.max(0.015, currentScore * 0.7)) return span;
    // Identity invariant: narrow into retrievalWindow only. Overwriting
    // text/textPreview here left byteStart/byteEnd/contentHash describing
    // the original span while text described a different, re-joined
    // string -- which made every span uncitable downstream.
    return { ...span, retrievalWindow: selected.preview };
  });
}


/** Best request overlap of any sentence in an oversized span (memoized sentence split); bounded to the first 12000 chars. */
function bestSentenceWindowLexical(span: EvidenceSpan, requestFeatures: ReturnType<typeof featureSet>): number {
  let best = 0;
  for (const sentence of fastAnswerSentences(sourceTextSurface(evidenceWindowText(span), 12000))) {
    if (sentence.length < 24) continue;
    const score = weightedJaccard(requestFeatures, featureSet(sentence, 128));
    if (score > best) best = score;
  }
  return best;
}

export function runtimeEvidenceWindowsForRequest(text: string, evidence: readonly EvidenceSpan[]): EvidenceSpan[] {
  const requestFeatures = featureSet(text, 256);
  const requestUnits = requestUnitSet(text);
  const definitionAnchor = definitionRequestAnchor(text);
  return evidence.slice(0, 8).map(span => {
    const source = sourceTextSurface(evidenceWindowText(span), 12000);
    if (source.length <= 6000) return span;
    let sentences = source
      .split(/(?<=[.!?。！？])\s+|\n+/u)
      .map(item => item.replace(/\s+/gu, " ").trim())
      .filter(Boolean);
    // A citation states where something was published, not what was asked. It names the subject and carries
    // years, so it wins both the lexical and the date-seeking paths: "When was Ada Lovelace born?" answered with
    // the 8 March 2018 publication date of a cited article. Citation lines stand aside while real prose remains.
    const prose = sentences.filter(sentence => {
      const folded = sentence.toLocaleLowerCase();
      return !folded.includes("http://") && !folded.includes("https://") && !folded.includes("www.");
    });
    if (prose.length) sentences = prose;
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
    for (const row of [...leadRows, ...ranked, ...dateRows]) byIndex.set(row.index, row);
    for (const row of sectionRows) {
      const index = sentences.length + row.index;
      byIndex.set(index, { ...row, index });
    }
    const selectedRows = [...byIndex.values()]
      .sort((a, b) => a.index - b.index);
    const selected = (selectedRows.length ? selectedRows : sentences.slice(0, 8).map((sentence, index) => ({ sentence, index, score: 0 })))
      .map(row => row.sentence)
      .join(" ")
      .slice(0, 6000)
      .trim();
    // Identity invariant: see evidenceWithGraphPreviewWindows. This window
    // re-joins non-adjacent sentences, so it has no single byte range and
    // must never masquerade as the span's own bytes.
    return selected ? { ...span, retrievalWindow: selected } : span;
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


/** The span a source opens with: a chunk in the middle of a document has no lead sentence to boost. Pure. */
function documentOpeningSpan(span: EvidenceSpan): boolean {
  return span.charStart === 0;
}

export function localEvidenceAnswerSurface(input: {
  requestText: string;
  selectedEvidence: readonly EvidenceSpan[];
  temporalEvidence?: readonly EvidenceSpan[];
  entailment?: Pick<TurnResult["entailment"], "contradiction" | "evidenceIds" | "force">;
  semanticProof?: { verdict: string; contradiction: number; conflictingEvidenceIds?: readonly string[] };
  translationTarget?: string;
  sessionContextEvidence?: boolean;
  explicitContextEvidenceIds?: ReadonlySet<string>;
  semanticFrameBoundEvidenceIds?: ReadonlySet<string>;
  closedClassWords?: ReadonlySet<string>;
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
  /**
   * Sentence budget from the request's LEARNED response form
   * (`requirementField.responseForm.surfaceLayout.sentencesPerBlock`) --
   * enumeration-shaped requests get the selected span's contiguous lead
   * block instead of a single sentence. 1 (the default) preserves the
   * classic single-sentence behavior exactly.
   */
  responseSentenceBudget?: number;
  /** The learned closed class (role language plus request scaffolding); when present, the relation asked about is required. */
  closedClassWords?: ReadonlySet<string>;
}): LocalEvidenceAnswerCandidate | undefined {
  const promoted = input.selectedEvidence.filter(span => span.status === "promoted" || promotedSessionEvidence(span));
  if (!promoted.length) return undefined;
  // A request implying a temporal counterexample (e.g. "did X invent Y?"
  // when Y's evidence-attested history predates X's lifespan) needs the
  // richer, multi-sentence temporalCounterexampleAnswerPlan in
  // localEvidenceAnswerPlan -- pairing the counterexample marker sentence
  // with its development context, not this function's single
  // highest-scoring sentence. Defer to that path instead of returning a
  // single generic sentence that happens to score well here.
  // A near-duplicate request is a quotation with a hole, not a temporal
  // question: the anachronism check hijacked every year-hole cloze.
  const proposeSequences = requestSentenceSequences(input.requestText);
  const proposeNearDuplicate = proposeSequences.length > 0
    && promoted.some(span => spanContainsRequestNearDuplicateSentence(span, proposeSequences));
  // Single admission authority; a private copy of this filter silently
  // dropped content-admitted (near-duplicate) spans at the answer stage.
  const anchored = sourceIdentityAdmissibleEvidenceForRequest(
    input.requestText,
    promoted,
    input.semanticFrameBoundEvidenceIds ?? new Set()
  );
  const evidence = anchored.required ? anchored.evidence : promoted;
  if (!evidence.length) return undefined;
  const requestFeatures = featureSet(input.requestText, 256);
  const requestUnits = requestUnitSet(input.requestText);
  // The lead boost below exists so a deep-article sentence that merely
  // repeats the topic name several times can't outrank the article's own
  // opening definition -- but as an unconditional flat boost it also made
  // the opener unbeatable when a deeper sentence covered strictly more of
  // the request's actual content terms (verified live in the sealed eval:
  // "Who played Benjamin Sisko" always got DS9's opening definition, never
  // the sentence naming Avery Brooks; three sentence-ranking-side fix
  // attempts each broke definitional questions and were reverted, because
  // they attacked overlap scoring instead of the boost's blindness). The
  // discriminating signal is the request's units NET OF the span's own
  // title units: choosing this titled source already satisfied the title
  // terms, so only the remaining content terms ("played", "created",
  // "sisko", ...) say which sentence actually answers. (Request ANCHORS are
  // deliberately not the exclusion set -- anchor extraction emits request
  // n-grams that can swallow real content terms like "played".) The boost
  // stays with the lead when the lead covers those content terms at least
  // as well as any other sentence (definitional questions: the opener
  // contains "created", ties keep the lead); it transfers -- once, to the
  // best-covering sentence -- only when a deeper sentence strictly beats
  // every lead sentence on them.
  const rows = evidence.flatMap(span => {
    // Rank REAL sentences in the exact normalization space the mouth's
    // source-excerpt verifier compares in. fastAnswerSentences' cleaning
    // could fail to split a quote-heavy region, producing one giant
    // "sentence" block that hoovers up unit overlap from everything it
    // swallowed and wins the ranking on content it never surfaces
    // (verified live: "Who played Captain James T. Kirk..." selected a
    // block whose visible head was the retronym sentence). Sentences
    // split from tidySurfaceText are verbatim substrings of the span by
    // construction, so whatever wins here survives excerpt verification
    // unchanged. Truncation drops the final (possibly cut) sentence.
    const tidySpanText = tidySurfaceText(span.text);
    const boundedChars = [...tidySpanText].slice(0, 12000);
    const boundedText = boundedChars.join("");
    const allSentences = splitSurfaceSentences(boundedText);
    let sentences = (boundedChars.length < [...tidySpanText].length ? allSentences.slice(0, -1) : allSentences).slice(0, 80);
    // Splitter mismatch guard (see bestEvidenceSentences): inject the
    // near-duplicate gate's matching sentences when verbatim-preserving.
    if (proposeSequences.length) {
      const gateMatches = fastAnswerSentences(sourceTextSurface(evidenceWindowText(span), 6000))
        .filter(candidate => proposeSequences.some(sequence =>
          surfaceRequestOrderedAdjacentPairFraction(candidate, sequence) >= 0.5))
        .filter(candidate => tidySpanText.includes(candidate) && !sentences.includes(candidate));
      if (gateMatches.length) sentences = [...gateMatches, ...sentences].slice(0, 80);
    }
    const titleMatches = anchored.anchors.length > 0
      && evidenceTitleDistinctAnchorMatches(span, anchored.anchors);
    const titleUnits = new Set(requestUnitsFromText(evidenceTitle(span)));
    // Net of the title, the learned closed class, and the short word the request opens with: "What is
    // acupuncture?" transferred the lead boost to whichever deep sentence happened to contain "what".
    const leadingScaffolding = requestLeadingScaffoldingUnit(input.requestText);
    const contentRequestUnits = new Set([...requestUnits].filter(unit =>
      ![...titleUnits].some(titleUnit => requestUnitMatchesSurface(unit, titleUnit))
      && !input.closedClassWords?.has(unit)
      && unit !== leadingScaffolding));
    // Cross-span source affinity: content-net overlap is asymmetric across
    // sources (request words inside THIS span's title are excluded here
    // but count as "content" for a sibling source whose title lacks them
    // -- verified live: sealed TOS questions drew their answers from the
    // DS9 article because "original"/"series" scored as content there).
    // Weighting each span by how completely the request covers its title
    // restores symmetry: the source the request names most completely
    // wins, in either direction, with no language assumptions.
    const titleUnitList = [...titleUnits];
    const titleRequestCoverage = titleUnitList.length
      ? titleUnitList.filter(titleUnit =>
        [...requestUnits].some(unit => requestUnitMatchesSurface(unit, titleUnit))).length / titleUnitList.length
      : 0;
    // The primary anchor's own article carries the topic; another titled source that also fits gets most, not all, of the affinity.
    const primaryAnchor = anchored.anchors[0];
    const primaryTitle = Boolean(primaryAnchor) && (evidenceTitleDistinctAnchorMatches(span, [primaryAnchor!]) || evidenceExactSourceAnchorMatches(span, [primaryAnchor!]));
    const sourceAffinityBoost = titleMatches ? 3 * titleRequestCoverage * (primaryTitle ? 1 : 0.7) : 0;
    let contentBoostIndex = -1;
    // Only the document's opening block has a lead to transfer from: in a mid-article chunk the first two
    // "sentences" are whatever the cut left, their coverage is zero, and the boost went to any sentence with a
    // content word -- "The Athens area encompasses a variety of terrain ... the capital is the only major city in
    // Europe" beat "'Athens' is the capital and largest city of Greece" by exactly that (live 2026-09-10).
    if (titleMatches && contentRequestUnits.size && documentOpeningSpan(span)) {
      // Fragments (lowercase-initial in a cased script -- markup or
      // splitting leftovers) are ineligible to receive the transferred
      // boost: a glued image-caption block was winning the transfer on a
      // full-overlap tie-break over the article's real cast sentence.
      const coverage = sentences
        .map((sentence, index) => ({
          index,
          contentOverlap: requestUnitOverlapForSurface(sentence, contentRequestUnits),
          fullOverlap: requestUnitOverlapForSurface(sentence, requestUnits)
        }))
        .filter(row => !lowercaseInitialFragment(sentences[row.index] ?? ""));
      const leadContent = Math.max(0, ...coverage.filter(row => row.index <= 1).map(row => row.contentOverlap));
      const best = [...coverage].sort((left, right) =>
        right.contentOverlap - left.contentOverlap
        || right.fullOverlap - left.fullOverlap
        || left.index - right.index)[0];
      if (best && best.contentOverlap > leadContent) contentBoostIndex = best.index;
    }
    return sentences.map((sentence, index) => {
      // Same doctrine as the transfer logic above, applied to the overlap
      // term itself: once this span's title matches the request anchors,
      // repeating title words earns a sentence nothing -- otherwise a
      // lexically-empty sentence that restates the full title outscores
      // the sentence carrying the actual content terms (verified live:
      // "Who created Star Trek: The Original Series?" selected the
      // retronym sentence, which answers nothing, over the lead that
      // names Roddenberry, purely on five title-unit hits).
      const unitOverlap = titleMatches && contentRequestUnits.size
        ? requestUnitOverlapForSurface(sentence, contentRequestUnits)
        : requestUnitOverlapForSurface(sentence, requestUnits);
      const anchorBoost = sourceSurfaceMatchesAnyAnchor(sentence, anchored.anchors) ? 0.54 : 0;
      // Must outweigh unitOverlap*0.92's realistic ceiling (~3 units); see
      // the coverage-transfer note above for when it moves off the lead.
      const titleLeadBoost = titleMatches
        && (contentBoostIndex >= 0 ? index === contentBoostIndex : (documentOpeningSpan(span) && index <= 1))
        ? 4
        : 0;
      // Sentence-completeness prior: in cased scripts a well-formed
      // sentence opens with an uppercase letter, digit, or opening
      // punctuation. A lowercase-initial "sentence" is a fragment left by
      // markup or splitting noise (verified live: an image-caption tail
      // "as Captain James T. Kirk in action, ..." outranked the article's
      // real cast sentence). Uncased scripts are exempt by construction.
      const fragmentPenalty = (lowercaseInitialFragment(sentence) ? 1.2 : 0) + (danglingTailFragment(sentence) ? 1.2 : 0);
      // Same near-duplicate dominance as bestEvidenceSentences.
      const nearDuplicateFraction = proposeSequences.reduce((best, sequence) =>
        Math.max(best, surfaceRequestOrderedAdjacentPairFraction(sentence, sequence, titleUnits)), 0);
      const nearDuplicateBoost = nearDuplicateFraction >= 0.5 && !promotedSessionEvidence(span)
        ? 12 * nearDuplicateFraction
        : 0;
      return {
        span,
        sentence,
        index,
        nearDuplicate: nearDuplicateBoost > 0,
        score: unitOverlap * 0.92
          + weightedJaccard(requestFeatures, featureSet(sentence, 256)) * 0.35
          + anchorBoost
          + titleLeadBoost
          + sourceAffinityBoost
          + nearDuplicateBoost
          + Math.max(0, 0.16 - index * 0.018)
          - fastAnswerLongSentencePenalty(sentence)
          - fragmentPenalty
      };
    });
  })
    // Heading/list clozes duplicate real but short surfaces ("== Cultural impact ==").
    .filter(row => (row.sentence.length >= 24 || row.nearDuplicate) && !isHeadingOnlySurface(row.sentence) && !cliticOpeningFragment(row.sentence))
    // The duplicated sentence outranks everything: a unit-rich table blob
    // can beat the boost on raw overlap count.
    .sort((left, right) => Number(right.nearDuplicate) - Number(left.nearDuplicate) || right.score - left.score || left.index - right.index || String(left.span.id).localeCompare(String(right.span.id)));
  const leadingScaffoldingUnit = requestLeadingScaffoldingUnit(input.requestText);
  const coverageUnits = requestContentEvidenceUnits(input.requestText)
    .filter(unit => !input.closedClassWords?.has(unit) && unit !== leadingScaffoldingUnit);
  const relationRequired = Boolean(input.closedClassWords?.size);
  const covers = (row: { sentence: string; span: EvidenceSpan; nearDuplicate: boolean }) =>
    row.nearDuplicate || answerCoversRequest([row.sentence], row.span, coverageUnits, input.requestText, { relationRequired });
  // A request that names its subject and asks nothing else is answered by the subject's own opening sentence when
  // a titled source has one: an encyclopedic lead predicates about its subject by construction, even when it names
  // the subject in a longer form the anchor test cannot see ("Augusta Ada King, Countess of Lovelace ... also known
  // as Ada Lovelace" lost the predication check to a Starfield trivia bullet, live 2026-09-10).
  // The named subject's own units, not every derived anchor phrase: derived anchors carry neighbouring request words
  // ("played benjamin sisko"), which would make a relation look like part of the name.
  const subjectUnitSet = new Set(namedSubjectAnchors(input.requestText).flatMap(anchor => splitPriorUnits(normalizePriorKey(anchor)).filter(Boolean)));
  const definitional = subjectUnitSet.size > 0 && coverageUnits.every(unit => subjectUnitSet.has(unit));
  const openingRow = definitional
    ? rows.find(row => covers(row) && row.index <= 1 && documentOpeningSpan(row.span) && anchored.anchors.length > 0
      && evidenceTitleDistinctAnchorMatches(row.span, anchored.anchors) && isProseSentence(row.sentence))
    : undefined;
  // Two sentences can both name the subject while only one says anything about it. Nothing above separates them:
  // "The character was portrayed by Sylvie Briggs, alongside characterisations of Charles Babbage and Noor Inayat
  // Khan." beat "Charles Babbage and Ada Lovelace conceived the first programmable computer" by 0.056 for "Who was
  // Charles Babbage?", entirely on the document-position prior -- a where-it-sits artefact deciding a what-it-says
  // question. The turn's own proposition compiler already draws the distinction: the subject of a predication lands
  // in the atom's leading role, a passing mention lands in a trailing one. Preference, not a weight -- when no
  // candidate predicates about the anchor the original ordering stands, so this can only reorder, never exclude.
  // Bounded: compiling propositions is turn-time work, and only sentences already near the top can win anyway.
  // Among the top covering sentences, what a sentence says of the request comes first: the one carrying the most
  // of the request's relation units wins outright ("Her contributions included publishing an algorithm" over the
  // lead, for "what did she contribute?"). Predication about the subject and then the document's opening block
  // only break ties among sentences that cover equally -- the opening block states the standing fact, the body
  // its history ("From 1826 to 1846, Tuscaloosa served as Alabama's capital" outranked the lead's Montgomery, and
  // "The Athens area encompasses ..." outranked "'Athens' is the capital and largest city of Greece", live
  // 2026-09-10). Preferences, never exclusions: the original order stands where nothing separates candidates.
  const relationRankUnits = coverageUnits.filter(unit => !subjectUnitSet.has(unit));
  const relationCoverage = (row: { sentence: string }) => {
    const units = memoizedSurfaceUnits(row.sentence).map(stripOuterPriorSeparators);
    return relationRankUnits.filter(unit => units.some(surfaceUnit => requestUnitSharesStem(unit, surfaceUnit))).length;
  };
  const covering = !openingRow ? rows.slice(0, ANCHOR_PREDICATION_RERANK_LIMIT).filter(covers) : [];
  const fullestCoverage = Math.max(0, ...covering.map(relationCoverage));
  const fullest = covering.filter(row => relationCoverage(row) === fullestCoverage);
  const predicating = anchored.anchors.length
    ? fullest.filter(row => sentencePredicatesAboutAnchors(row.sentence, anchored.anchors))
    : [];
  const openingFirst = (list: typeof rows) => [...list.filter(row => documentOpeningSpan(row.span)), ...list.filter(row => !documentOpeningSpan(row.span))];
  const selected = openingRow ?? openingFirst(predicating)[0] ?? openingFirst(fullest)[0] ?? rows.find(covers);
  if (!selected) return undefined;
  // Learned response-form sentence budget (lexical-gap fix for
  // enumeration-shaped requests): a request like "list the main characters
  // of X" names things the source expresses only as instances (names and
  // ranks in the article lead), so no single sentence can win on unit
  // overlap -- the highest-overlap sentence is whichever lead sentence
  // repeats the title, and the actual enumeration a few sentences later is
  // lexically unreachable. When the request's LEARNED response form (from
  // the hand-authored request-requirement corpus -- no keyword lists, works
  // for any language the corpus covers) declares a multi-sentence surface
  // layout, the plan returns a contiguous, document-order window of the
  // selected span's sentences instead of one: anchored at the span start
  // when the winner is a lead sentence (the lead block IS the enumeration
  // context), else at the winner. Contiguity is the coherence guarantee --
  // never stitched fragments from disjoint places.
  // A quotation with a hole is answered by the quoted sentence alone; the enumeration window is for enumeration requests.
  const sentenceBudget = selected.nearDuplicate ? 1 : Math.max(1, Math.min(8, Math.floor(input.responseSentenceBudget ?? 1)));
  // Ranked sentences are already tidy-space verbatim substrings of the
  // span (see the ranking block above), so the single-sentence answer
  // needs no remapping and the multi-sentence window below verifies by
  // construction.
  // A subject the span's title does not name is answered by the clause that binds it: "Who played Sisko?" was
  // answered with the whole 346-character sentence whose last clause is "Benjamin Sisko (played by Avery
  // Brooks)". The focused clause is a slice of the sentence, so every verbatim-substring guarantee still holds.
  const titleAnswersRequest = anchored.anchors.length > 0 && evidenceTitleDistinctAnchorMatches(selected.span, anchored.anchors);
  const focusedSentence = !selected.nearDuplicate && anchored.anchors.length > 0 && !titleAnswersRequest
    ? anchorFocusedAnswerSurface(selected.sentence, anchored.anchors, evidenceTitle(selected.span))
    : selected.sentence;
  let answerSentences = [focusedSentence && focusedSentence.length >= 24 && selected.sentence.includes(focusedSentence) ? focusedSentence : selected.sentence];
  if (sentenceBudget > 1) {
    // The window is built in tidySurfaceText space -- the exact space
    // mouth.ts's source-excerpt verification compares answers to evidence
    // text in -- and self-verified as a substring before use, so the
    // multi-sentence answer keeps every downstream exactness guarantee
    // (excerpt preemption, certification, byte-verified citations). A
    // window that fails reconstruction falls back to the classic
    // single-sentence behavior rather than shipping an unverifiable
    // surface.
    const tidySpan = tidySurfaceText(selected.span.text);
    const tidySentences = splitSurfaceSentences(tidySpan).filter(sentence => sentence.length >= 24);
    const matchIndex = tidySentences.findIndex(sentence =>
      sentence.includes(selected.sentence) || selected.sentence.includes(sentence));
    const start = selected.index <= 1 || matchIndex <= 1
      ? 0
      : Math.min(Math.max(0, matchIndex), Math.max(0, tidySentences.length - sentenceBudget));
    const window = tidySentences.slice(start, start + sentenceBudget);
    if (window.length > 1 && tidySpan.includes(window.join(" "))) {
      answerSentences = window;
    }
  }
  // A sentence that carries the request's relation but names its subject only by anaphora ("Her contributions
  // included publishing an algorithm...") is read with the sentence that names her: the two are spoken together,
  // contiguous and verified as a substring the same way the window above is. The subject test is the one
  // answerCoversRequest resolves through the preceding sentence; here that sentence becomes part of the answer.
  if (answerSentences.length === 1 && !sentenceNamesRequestSubject(answerSentences[0]!, input.requestText)) {
    const tidySpan = tidySurfaceText(selected.span.text);
    const tidySentences = splitSurfaceSentences(tidySpan);
    const matchIndex = tidySentences.findIndex(sentence => sentence.includes(selected.sentence) || selected.sentence.includes(sentence));
    const preceding = matchIndex > 0 ? tidySentences[matchIndex - 1] : undefined;
    if (preceding && sentenceNamesRequestSubject(preceding, input.requestText) && isProseSentence(preceding)) {
      const pair = [preceding, tidySentences[matchIndex]!];
      if (tidySpan.includes(pair.join(" "))) answerSentences = pair;
    }
  }
  const plan: LocalEvidenceAnswerPlan = {
    planId: "ans.plan.source_exact.31a6c2f8",
    kindId: LOCAL_ANSWER_KIND_IDS.evidenceBoundary,
    evidence: [selected.span],
    slotSurfaces: {
      [LOCAL_ANSWER_SLOT_IDS.sentence]: answerSentences
    },
    maxSentences: answerSentences.length,
    proofExcerpts: answerSentences.map(sentence => ({ text: sentence, evidenceId: selected.span.id })),
    audit: toJsonValue({
      source: "kernel.turn.source_exact_proposal",
      basisClassId: "basis.source_exact.54d2a9be",
      evidenceIds: [String(selected.span.id)],
      sourceAnchorRequired: anchored.required,
      sourceAnchors: anchored.anchors,
      proposalScore: selected.score,
      proposalSentenceIndex: selected.index,
      nearDuplicate: selected.nearDuplicate,
      responseSentenceBudget: sentenceBudget,
      proofEnrichmentOptional: true,
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
  semanticProof?: { verdict: string; contradiction: number; conflictingEvidenceIds?: readonly string[] };
  sessionContextEvidence?: boolean;
  explicitContextEvidenceIds?: ReadonlySet<string>;
  semanticFrameBoundEvidenceIds?: ReadonlySet<string>;
  closedClassWords?: ReadonlySet<string>;
}): LocalEvidenceAnswerPlan | undefined {
  const evidence = input.selectedEvidence.filter(span => span.status === "promoted" || promotedSessionEvidence(span));
  if (!evidence.length) return undefined;
  const temporalEvidence = (input.temporalEvidence ?? evidence)
    .filter(span => span.status === "promoted" || promotedSessionEvidence(span));
  // Same near-duplicate exemption as proposeSourceExactEvidenceAnswer.
  const planSequences = requestSentenceSequences(input.requestText);
  const planNearDuplicate = planSequences.length > 0
    && evidence.some(span => spanContainsRequestNearDuplicateSentence(span, planSequences));
  if (!planNearDuplicate) {
    // A found counterexample answers; merely expecting one must not veto the evidence-boundary answer below.
    const counterexample = temporalCounterexampleAnswerPlan(input.requestText, temporalEvidence);
    if (counterexample) return counterexample;
  }
  // A near-duplicate is a quotation, not an enumeration request: the
  // collection plan answered clozes with name-list salads.
  const collection = planNearDuplicate
    ? undefined
    : collectionAnswerPlan(input.requestText, evidence, input.entailment, input.semanticProof);
  if (collection) return collection;
  // Single admission authority (same fix as proposeSourceExactEvidenceAnswer).
  const anchored = sourceIdentityAdmissibleEvidenceForRequest(input.requestText, evidence, input.semanticFrameBoundEvidenceIds ?? new Set());
  const answerAnchoredEvidence = anchored.evidence;
  const explicitContextEvidence = input.explicitContextEvidenceIds?.size
    ? evidence.filter(span => input.explicitContextEvidenceIds?.has(String(span.id)))
    : [];
  if (anchored.required && !answerAnchoredEvidence.length && !explicitContextEvidence.length) return undefined;
  const answerEvidence = answerAnchoredEvidence.length
    ? answerAnchoredEvidence
    : explicitContextEvidence.length
      ? explicitContextEvidence
      : sourceCoherentUnanchoredEvidence(input.requestText, evidence);
  if (!answerEvidence.length) return undefined;
  const contradiction = Math.max(input.entailment?.contradiction ?? 0, input.semanticProof?.contradiction ?? 0);
  // A contradicted proof blocks a plain answer whatever the mass is. The bounds below are calibrated for
  // claim-versus-evidence contradiction; a verdict of contradicted also covers two admitted sources refuting each
  // other, which scores lower than either bound and means something stronger -- there is no side to answer from.
  // There is still something to say: which sources disagree, and what each of them states.
  if (input.semanticProof?.verdict === SEMANTIC_VERDICT.CONTRADICTED) {
    return sourceConflictAnswerPlan(input.requestText, answerEvidence, input.semanticProof.conflictingEvidenceIds ?? []);
  }
  if (contradiction >= 0.72 || (contradiction >= 0.45 && !answerAnchoredEvidence.length)) return undefined;
  const rankedSentences = bestEvidenceSentences(input.requestText, answerEvidence, input.sessionContextEvidence === true);
  // A subject the title does not name is answered by the clause that binds it, not by the whole sentence it sits
  // in: "Who played Sisko?" was answered with a 443-character sentence about Roddenberry and space stations whose
  // final clause was "Benjamin Sisko (played by Avery Brooks)". anchorFocusedAnswerSurface existed for exactly this
  // and was called from nowhere. It applies only when no span's title matches the anchors, so definitional
  // answers about an article's own subject keep their full lead sentence.
  const titleAnswersRequest = anchored.anchors.length > 0 && answerEvidence.some(span => evidenceTitleDistinctAnchorMatches(span, anchored.anchors));
  // Applied to the WHOLE sentences, before anchorFocusedAnswerSurface below rewrites them into clauses. Focusing
  // moves the anchor to the front of whatever clause contains it, so "alongside characterisations of Charles Babbage
  // and Noor Inayat Khan." comes out looking exactly like a sentence predicating about Babbage. Judge the sentence
  // the corpus actually wrote, then focus whichever survives.
  const predicatingRanked = anchored.anchors.length && !planNearDuplicate
    ? rankedSentences.slice(0, ANCHOR_PREDICATION_RERANK_LIMIT)
      .filter(sentence => sentencePredicatesAboutAnchors(sentence, anchored.anchors))
    : [];
  // A preference, as the comment below says, so a reorder: the sentences that predicate about the subject lead and
  // the rest follow. Dropping the rest silently cut "Who was Ada Lovelace, and what did she contribute?" to its
  // first sentence once the lead was recognised as predicating (2026-09-10).
  const preferredRanked = predicatingRanked.length
    ? [...predicatingRanked, ...rankedSentences.filter(sentence => !predicatingRanked.includes(sentence))]
    : rankedSentences;
  const sentences = planNearDuplicate || titleAnswersRequest || !anchored.anchors.length
    ? preferredRanked
    : preferredRanked.map(sentence => {
      const focused = anchorFocusedAnswerSurface(sentence, anchored.anchors, evidenceTitle(answerEvidence[0]!));
      return focused && focused.length >= 24 ? focused : sentence;
    });
  if (!sentences.length) return undefined;
  // Same rule the exact-sentence plan applies, at the branch that actually wins the priority comparison: among
  // sentences that name the subject, prefer the ones that say something about it. Measured on "Who was Charles
  // Babbage?", this plan carried three sentences of Doctor Who trivia from the Ada Lovelace article while the
  // sentence stating what Babbage did ranked below them -- and this plan, not the exact-sentence proposal, is what
  // preferredLocalEvidenceAnswer selected and the mouth spoke. Preference, never exclusion: when nothing predicates
  // about the anchor the ranked order stands unchanged.
  const answerSurfaceSentences = sentences;
  const planCoverageUnits = requestContentEvidenceUnits(input.requestText).filter(unit => !input.closedClassWords?.has(unit));
  if (!planNearDuplicate && !answerEvidence.some(span => answerCoversRequest(answerSurfaceSentences, span, planCoverageUnits, input.requestText, { relationRequired: Boolean(input.closedClassWords?.size) }))) return undefined;
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
      [LOCAL_ANSWER_SLOT_IDS.sentence]: answerSurfaceSentences
    },
    maxSentences: evidenceAnswerSentenceLimit(input.requestText, answerEvidence, input.sessionContextEvidence === true),
    audit: toJsonValue({
      source: "kernel.turn.fast_local_evidence",
      basisClassId: "basis.54d2a9be",
      certificationId: evidenceBound ? "cert.2b4f8a11" : "cert.4e8b2d11",
      evidenceIds: answerEvidence.map(span => String(span.id)),
      evidenceCount: answerEvidence.length,
      sourceAnchorRequired: anchored.required,
      sourceAnchorMatched: answerAnchoredEvidence.length > 0,
      sourceAnchors: anchored.anchors,
      evidenceBound,
      sessionBound: answerSessionBound,
      explicitContextBound,
      relevance,
      contradiction,
      entailmentForce: input.entailment?.force ?? "unverified-proposal",
      certificationVerifierVerdict: input.semanticProof?.verdict ?? "unverified-proposal",
      selectedSentenceCount: sentences.length,
      nearDuplicate: planNearDuplicate,
      fakeEvidenceForbidden: true
    })
  };
}


/** A chunk cut inside a word leaves its clitic as the opening: "'s well-developed ferry system". Never a sentence. */
export function cliticOpeningFragment(sentence: string): boolean {
  // One or two letters after the apostrophe and then a boundary: 's, 't, 'll, 're. A quoted title ("'Star Trek...") is not one.
  return /^['’]\p{L}{1,2}(?!\p{L})/u.test(sentence.trimStart());
}

 function lowercaseInitialFragment(sentence: string): boolean {
  const leadChar = [...sentence][0] ?? "";
  return Boolean(leadChar)
    && leadChar.toLocaleLowerCase() !== leadChar.toLocaleUpperCase()
    && leadChar !== leadChar.toLocaleUpperCase();
}

/** The short word a request opens with, normalized: "who", "what", "does", "tell" -- scaffolding by position and
 *  length, the same rule the subject-anchor primitive applies, so no word list and no language assumption. */
export function requestLeadingScaffoldingUnit(requestText: string): string | undefined {
  const first = requestText.trim().split(/\s+/u)[0] ?? "";
  const unit = normalizePriorKey(stripOuterPriorSeparators(first));
  return unit && [...unit].length <= 5 ? unit : undefined;
}

/** A sentence that ends on a comma, a bare conjunction-length word after a comma, or no terminal mark at all:
 *  the splitter stopped at a line break or a stripped citation, not at the end of a claim. Structural only. */
 function danglingTailFragment(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (!trimmed) return true;
  const last = [...trimmed].pop() ?? "";
  if (/[.!?…;:"”'’)\]»]/u.test(last)) return false;
  if (/[,\-–—(\[«]$/u.test(trimmed)) return true;
  const words = trimmed.split(/\s+/u);
  const lastWord = words[words.length - 1] ?? "";
  // The final word is short and lowercase after a comma-bearing clause: "... , Andrew Jackson and".
  return trimmed.includes(",") && [...lastWord].length <= 3 && lastWord === lastWord.toLocaleLowerCase();
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


/**
 * The one sentence immediately before the answering material within its own span: enough to resolve what an
 * anaphoric answering sentence ("the mission", "he", a bare continuation) refers to, without reaching past the local
 * context into a sentence about something else the article also discusses. Matching is by prefix/substring, since
 * the answering text can be a whole sentence or a focused clause cut from one. Pure.
 */
function precedingSentenceContext(span: EvidenceSpan, answeringText: string): string {
  const tidyAnswer = tidySurfaceText(answeringText).trim();
  if (!tidyAnswer) return "";
  const spanSentences = splitSurfaceSentences(tidySurfaceText(String(span.text ?? span.textPreview ?? "")));
  const index = spanSentences.findIndex(sentence => {
    if (!sentence) return false;
    const probeLength = Math.min(sentence.length, tidyAnswer.length, 40);
    if (probeLength < 12) return sentence === tidyAnswer;
    return sentence.slice(0, probeLength) === tidyAnswer.slice(0, probeLength)
      || tidyAnswer.includes(sentence)
      || sentence.includes(tidyAnswer);
  });
  return index > 0 ? spanSentences[index - 1]! : "";
}

/** Corpus-oriented truth: an answer must carry a third of the request's content units, in its sentences or its source title; a passage sharing none of them is a different topic, however well it scores lexically. Pure. */
export function answerCoversRequest(
  sentences: readonly string[],
  span: EvidenceSpan,
  contentUnits: readonly string[],
  requestText = "",
  options: { relationRequired?: boolean } = {}
): boolean {
  // The request's subject: its named anchors when it has any, else its longer content units. A request with none (a pronoun follow-up) is covered by whatever it was bound to.
  // A lone short cased run (a sentence-initial question word) is not a name.
  // A digit qualifier stays: it is the whole difference between Apollo and Apollo 11, and between Project Apollo
  // reaching for the Moon and the mission that landed on it.
  const namedGroups = namedSubjectAnchors(requestText)
    .map(anchor => splitPriorUnits(normalizePriorKey(anchor)).filter(unit => [...unit].length >= 3 || /^\p{Number}+$/u.test(unit)))
    .filter(units => units.length >= 2 || [...(units[0] ?? "")].length >= 5);
  const subjectUnits = namedGroups.length ? namedGroups.flat() : contentUnits.filter(unit => [...unit].length >= 6);
  if (!subjectUnits.length) return true;
  // Short units match exactly (the fuzzy matcher confuses "what" with "that"); longer ones tolerate inflection.
  const surfaceUnits = memoizedSurfaceUnits(sentences.join(" ") + " " + evidenceTitle(span)).map(stripOuterPriorSeparators);
  const matches = (unit: string) => surfaceUnits.some(surfaceUnit => [...unit].length < 5 ? surfaceUnit === unit : requestUnitMatchesSurface(unit, surfaceUnit));
  // A subject matches by identity or inflection only: similarity let "Majorian" stand in for "Bajoran".
  const subjectMatches = (unit: string) => surfaceUnits.some(surfaceUnit => surfaceUnit === unit
    || ((unit.startsWith(surfaceUnit) || surfaceUnit.startsWith(unit)) && Math.min(unit.length, surfaceUnit.length) / Math.max(unit.length, surfaceUnit.length) >= 0.72));
  // Aboutness and answerhood are two different questions. The subject may be bound by the title (that is what an
  // article about the subject is); the relation asked about must be carried by the sentence itself. With the learned
  // request scaffolding stripped from the units, what remains after the subject is exactly that relation: "commanded"
  // in "Who commanded Apollo 11?", "born" in "When was Albert Einstein born?", "dentist" in a question the corpus
  // cannot answer. A quota of one third let the relation drop and admitted any sentence naming the subject: the songs
  // that reference the Apollo 11 landing answered who commanded it, and the article's opening sentence answered who
  // Einstein's dentist was. Every relation unit is required, tolerating inflection (commanded/commander, land/landed).
  //
  // The relation can only be required when the caller could tell scaffolding from relation, which takes a learned
  // language (a hydrated model or the interaction corpus's request patterns). Without one, "what" and "known" are
  // indistinguishable from "commanded", and the one-third quota is the honest gate.
  if (!options.relationRequired) {
    const covered = contentUnits.filter(matches).length;
    return subjectUnits.some(subjectMatches) && covered >= Math.max(1, Math.ceil(contentUnits.length / 3));
  }
  // The sentence itself must name the subject it predicates about: with the title standing in, "Their son Eduard was
  // born in Zurich in July 1910" answered when Einstein was born, because the article is about Einstein and the
  // sentence carries "born".
  const relationUnits = contentUnits.filter(unit => !subjectUnits.includes(unit));
  const answeringText = sentences.join(" ");
  const sentenceUnits = memoizedSurfaceUnits(answeringText).map(stripOuterPriorSeparators);
  const missingRelationUnits = relationUnits.filter(unit => !sentenceUnits.some(surfaceUnit => requestUnitSharesStem(unit, surfaceUnit)));
  // A request that ends on a category ("...the capital of which country?", "...indigenous to which country?") is
  // answered by a member of that category, and the member's sentence does not repeat the category: "'Athens' is the
  // capital and largest city of Greece" never says "country". The one relation unit allowed to be absent is the
  // request's last content unit, and only when the sentence names something cased the request did not -- the
  // member. Every other relation unit is still required, so a sentence about the subject that merely shares a word
  // with the request does not pass (the fabrication case this gate exists for).
  const lastContentUnit = contentUnits[contentUnits.length - 1];
  const categoryMemberAnswer = missingRelationUnits.length === 1
    && relationUnits.length >= 2
    && missingRelationUnits[0] === lastContentUnit
    && sentenceNamesEntityOutsideRequest(answeringText, requestText);
  const relationCarried = missingRelationUnits.length === 0 || categoryMemberAnswer;
  const unitPresentIn = (units: readonly string[]) => (unit: string) => units.some(surfaceUnit => surfaceUnit === unit
    || ((unit.startsWith(surfaceUnit) || surfaceUnit.startsWith(unit)) && Math.min(unit.length, surfaceUnit.length) / Math.max(unit.length, surfaceUnit.length) >= 0.72));
  // Real prose names its subject once and continues by anaphora ("the mission", omission, a bare pronoun): requiring
  // the literal name in every answering sentence rejected most of an article after its lead. Measured live: "Commander
  // Neil Armstrong and Lunar Module Pilot ... landed the Lunar Module 'Eagle'" carries the relation and never repeats
  // "Apollo 11" -- the sentence before it does, and that is where a reader resolves the subject too.
  //
  // The answering sentence's own subject match stays the original rule exactly -- a surname alone still answers for
  // its subject, as it always could. Widening to the one preceding sentence applies only when the answering text
  // names nothing of the subject at all, and there the WHOLE named anchor must be present together, not just one of
  // its units: "In May 1904, their son Hans Albert was born in Bern, Switzerland" sits one sentence before Eduard's
  // birth and carries the bare token "Albert", which is not the same evidence a full "Albert Einstein" repeated
  // nearby would be. A single shared given name between two different people must not pass this gate.
  const subjectInAnsweringText = subjectUnits.some(unitPresentIn(sentenceUnits));
  const contextUnits = memoizedSurfaceUnits(`${precedingSentenceContext(span, answeringText)} ${answeringText}`).map(stripOuterPriorSeparators);
  const subjectGroups = namedGroups.length ? namedGroups : [subjectUnits];
  const subjectSatisfied = subjectInAnsweringText || subjectGroups.some(group => group.every(unitPresentIn(contextUnits)));
  // A name's parts are redundant (Einstein names Albert Einstein); a numeric qualifier is not (Apollo does not name
  // Apollo 11), so every numeric unit of the subject must be in the answering text or the one sentence before it --
  // checked in the widened context regardless of whether a bare name already matched there, since that is exactly
  // what tells "Apollo" alone apart from "Apollo 11".
  const numericQualifiersPresent = subjectUnits.filter(unit => /^\p{Number}+$/u.test(unit)).every(unit => contextUnits.includes(unit));
  return subjectSatisfied && numericQualifiersPresent && relationCarried;
}

/** Whether a sentence names the request's subject itself: every unit of one named anchor is present (by identity or
 *  inflection), the same test answerCoversRequest applies before it widens to the preceding sentence. Pure. */
function sentenceNamesRequestSubject(sentence: string, requestText: string): boolean {
  const groups = namedSubjectAnchors(requestText)
    .map(anchor => splitPriorUnits(normalizePriorKey(anchor)).filter(unit => [...unit].length >= 3 || /^\p{Number}+$/u.test(unit)))
    .filter(units => units.length > 0);
  if (!groups.length) return true;
  const units = memoizedSurfaceUnits(sentence).map(stripOuterPriorSeparators);
  const present = (unit: string) => units.some(surfaceUnit => surfaceUnit === unit
    || ((unit.startsWith(surfaceUnit) || surfaceUnit.startsWith(unit)) && Math.min(unit.length, surfaceUnit.length) / Math.max(unit.length, surfaceUnit.length) >= 0.72));
  return groups.some(group => group.every(present));
}

/** A cased word inside the sentence (not its first) whose normalized form the request does not contain: the member a
 *  category question is answered with ("Greece", "Japan", "Maurya"). Cased scripts only; uncased scripts never pass. */
function sentenceNamesEntityOutsideRequest(sentence: string, requestText: string): boolean {
  const requestUnits = new Set(memoizedSurfaceUnits(requestText).map(stripOuterPriorSeparators).map(unit => normalizePriorKey(unit)));
  const words = surfaceWords(sentence).map(stripOuterPriorSeparators).filter(Boolean);
  return words.some((word, index) => index > 0
    && hasUppercaseLetter(word)
    && [...word].length >= 3
    && !requestUnits.has(normalizePriorKey(word)));
}

/**
 * Two surfaces share a stem when one matches the other by identity or inflection, or when their common prefix is at
 * least four code points and most of the longer surface: commanded/commander, land/landed, develop/developing. A
 * learned morphology would replace the prefix rule; until then this is the same tolerance the fuzzy matcher already
 * grants, extended to the short verbs it refused. Pure.
 */
export function requestUnitSharesStem(unit: string, surfaceUnit: string): boolean {
  if (!unit || !surfaceUnit) return false;
  if (unit === surfaceUnit) return true;
  if ([...unit].length >= 5 && requestUnitMatchesSurface(unit, surfaceUnit)) return true;
  const left = [...unit];
  const right = [...surfaceUnit];
  // The same one-letter rule as requestUnitMatchesSurface: "capita" shares no stem with "capital".
  if ((unit.startsWith(surfaceUnit) || surfaceUnit.startsWith(unit)) && Math.abs(left.length - right.length) === 1) {
    const tail = (left.length > right.length ? unit : surfaceUnit).slice(Math.min(unit.length, surfaceUnit.length));
    if (/\p{L}/u.test(tail)) return tail === "s";
  }
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared++;
  return shared >= 4 && shared / Math.max(left.length, right.length) >= 0.6;
}

export function requestContentEvidenceUnits(requestText: string): string[] {
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

/** A request that quotes a remembered sentence is recall, whatever its surface suggested before memory was consulted. */
export function localEvidenceAnswerIsQuotationRecall(candidate: LocalEvidenceAnswerCandidate | undefined): boolean {
  return candidate !== undefined && jsonRecord(candidate.plan.audit).nearDuplicate === true;
}

export function localEvidenceAnswerClaimSurface(candidate: LocalEvidenceAnswerCandidate): string {
  // Members of a collection are separated as a list; a run of sentences reads on.
  const separator = candidate.plan.kindId === LOCAL_ANSWER_KIND_IDS.collection ? ", " : " ";
  return sourceTextSurface(
    localEvidenceAnswerProofExcerpts(candidate).map(excerpt => excerpt.text).join(separator),
    12000
  );
}

export function localEvidenceAnswerProofExcerpts(
  candidate: LocalEvidenceAnswerCandidate
): Array<{ text: string; evidenceId: EvidenceSpan["id"] }> {
  if (candidate.plan.proofExcerpts?.length) {
    return candidate.plan.proofExcerpts.map(excerpt => ({ ...excerpt }));
  }
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
  if (plan.kindId === LOCAL_ANSWER_KIND_IDS.sourceConflict) return 4;
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
  semanticProof?: { verdict: string; contradiction: number; conflictingEvidenceIds?: readonly string[] }
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
    .flatMap(span => fastAnswerSentences(sourceTextSurface(evidenceWindowText(span), 24000)).slice(0, 80).map((sentence, index) => {
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
    const source = sourceTextSurface(evidenceWindowText(span), 24000);
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


/**
 * What the sources actually say, when they do not say the same thing.
 *
 * The proof reports which spans refute each other. Answering from one of them is the failure this exists to
 * prevent, and answering with nothing tells the reader less than the corpus knows. Both statements are carried,
 * each with the source that made it, and the disagreement is expressed by the relation rather than by any word:
 * the mouth realizes it from learned constructions, so no phrasing is written here.
 */
function sourceConflictAnswerPlan(
  requestText: string,
  evidence: readonly EvidenceSpan[],
  conflictingEvidenceIds: readonly string[]
): LocalEvidenceAnswerPlan | undefined {
  if (conflictingEvidenceIds.length < 2) return undefined;
  const wanted = new Set(conflictingEvidenceIds.map(String));
  const spans = evidence.filter(span => wanted.has(String(span.id)));
  if (spans.length < 2) return undefined;
  const statements: string[] = [];
  const kept: EvidenceSpan[] = [];
  for (const span of spans) {
    const sentence = cleanSourceAnswerSurface(bestEvidenceSentences(requestText, [span], false)[0] ?? "");
    if (!sentence || statements.includes(sentence)) continue;
    statements.push(sentence);
    kept.push(span);
  }
  if (statements.length < 2) return undefined;
  return {
    planId: "ans.plan.5c83b1d7",
    kindId: LOCAL_ANSWER_KIND_IDS.sourceConflict,
    evidence: uniqueEvidenceById(kept),
    slotSurfaces: {
      [LOCAL_ANSWER_SLOT_IDS.subject]: cleanSourceAnswerSurface(evidenceTitle(kept[0]!) || requestText),
      [LOCAL_ANSWER_SLOT_IDS.conflictingStatement]: statements
    },
    maxSentences: Math.max(2, statements.length),
    proofExcerpts: statements.map((text, index) => ({ text, evidenceId: kept[index]!.id })),
    audit: toJsonValue({ source: "local-evidence.source-conflict", statements: statements.length })
  };
}

 function temporalCounterexampleAnswerPlan(requestText: string, evidence: readonly EvidenceSpan[]): LocalEvidenceAnswerPlan | undefined {
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  if (!anchors.length) return undefined;
  const requestUnits = requestUnitSet(requestText);
  const orderedRequestUnits = requestUnitsFromText(requestText);
  const subject = evidence
    .map(span => ({ span, title: evidenceTitle(span), key: normalizePriorKey(evidenceTitle(span)) }))
    .map(row => ({ ...row, lifespan: documentOpeningSpan(row.span) ? lifespanYears(row.span) : undefined }))
    .map(row => ({
      ...row,
      anchorFit: row.title && row.lifespan && anchors.some(anchor => temporalSubjectAnchorMatches(row.key, anchor)) ? 1 : 0,
      requestOverlap: evidenceRequestUnitOverlap(row.span, requestUnits)
    }))
    // A request that names its subject takes only a source titled with it: word overlap put a 1935-1976
    // biography in for "Who was Albert Einstein and what did he invent?" and dated a "counterexample" against it.
    .filter(row => row.title && row.lifespan && (row.anchorFit > 0 || (!namedSubjectAnchors(requestText).length && row.requestOverlap >= 2)))
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
      const sourceSurface = sourceTextSurface(evidenceWindowText(span), 24000);
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
    // Without this, localEvidenceAnswerProofExcerpts falls back to
    // Object.values(slotSurfaces), whose order is incidental to object key
    // insertion order rather than a deliberate answer order. State the
    // order explicitly: the counterexample itself (e.g. "attested in
    // 1478") leads, the broader development context it's drawn from
    // follows -- readers need the specific fact that contradicts the
    // premise before the surrounding history that explains it.
    proofExcerpts: uniqueKernelStrings([counterSentence, conceptSentence])
      .map(text => ({ text, evidenceId: counter.span.id })),
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
  const subject = temporalCounterexampleSubject(requestText, evidence);
  if (!subject || !requestDerivedPolaritySlots(requestText, subject.title)) return false;
  return temporalCounterexampleConceptUnits(requestText, subject.title).size > 0;
}

/** Sources titled with the concept a premise attributes to its subject, taken from the retrieval pool that title
 *  admission kept out: "did martha washington invent ... flags" needs the Flag article to date the practice against
 *  her lifespan, and cross-title admission refuses it by design. Only for a request expecting a counterexample. */
export function temporalConceptTitledEvidence(requestText: string, admitted: readonly EvidenceSpan[], pool: readonly EvidenceSpan[]): EvidenceSpan[] {
  const subject = temporalCounterexampleSubject(requestText, admitted);
  if (!subject) return [];
  const conceptUnits = [...temporalCounterexampleConceptUnits(requestText, subject.title)].filter(unit => [...unit].length >= 4);
  if (!conceptUnits.length) return [];
  const admittedIds = new Set(admitted.map(span => String(span.id)));
  return pool
    .filter(span => !admittedIds.has(String(span.id)))
    .filter(span => {
      const title = evidenceTitle(span);
      return title && normalizePriorKey(title) !== subject.key && !containedTitlePair(subject.title, title)
        && titleAnchorUnits(title).some(titleUnit => conceptUnits.some(unit => titleAnchorUnitMatches(unit, titleUnit)));
    })
    .slice(0, 8);
}

 function temporalCounterexampleSubject(requestText: string, evidence: readonly EvidenceSpan[]): { span: EvidenceSpan; title: string; key: string; lifespan: { birthYear: number; deathYear: number } } | undefined {
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  if (!anchors.length) return undefined;
  const requestUnits = requestUnitSet(requestText);
  const subject = evidence
    // A lifespan is read from the document's opening block only: a mid-article chunk carries other people's years
    // ("(1935–1976)" inside the Albert Einstein article dated an anachronism against him).
    .map(span => ({ span, title: evidenceTitle(span), key: normalizePriorKey(evidenceTitle(span)), lifespan: documentOpeningSpan(span) ? lifespanYears(span) : undefined }))
    .map(row => ({
      ...row,
      anchorFit: row.title && row.lifespan && anchors.some(anchor => temporalSubjectAnchorMatches(row.key, anchor)) ? 1 : 0,
      requestOverlap: evidenceRequestUnitOverlap(row.span, requestUnits)
    }))
    // A request that names its subject takes only a source titled with it: word overlap put a 1935-1976
    // biography in for "Who was Albert Einstein and what did he invent?" and dated a "counterexample" against it.
    .filter(row => row.title && row.lifespan && (row.anchorFit > 0 || (!namedSubjectAnchors(requestText).length && row.requestOverlap >= 2)))
    .sort((left, right) => right.anchorFit - left.anchorFit || right.requestOverlap - left.requestOverlap || left.title.localeCompare(right.title))[0];
  return subject?.lifespan ? { span: subject.span, title: subject.title, key: subject.key, lifespan: subject.lifespan } : undefined;
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
  const years = [...sourceTextSurface(evidenceWindowText(span), 900).matchAll(/\b(1[0-9]{3}|20[0-9]{2})\b/gu)]
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
  const sentences = fastAnswerSentences(sourceTextSurface(evidenceWindowText(span), 24000));
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


/**
 * Pair-memoized (re-applied after the 8cdd0d1 revert: the memo is pure
 * performance with byte-identical results, measured at 1.8s of a 6.9s
 * steady-state turn; the behavioral admission/ordering changes from that
 * commit are what regressed and stay reverted).
 */
const requestUnitMatchMemo = new Map<string, boolean>();
const REQUEST_UNIT_MATCH_MEMO_MAX = 200_000;

// Corpus sentences are stable strings re-tokenized by several scorers per turn.
const surfaceUnitsMemo = new Map<string, string[]>();
const SURFACE_UNITS_MEMO_MAX = 100_000;

 function memoizedSurfaceUnits(surface: string): string[] {
  const cached = surfaceUnitsMemo.get(surface);
  if (cached) return cached;
  const units = splitPriorUnits(normalizePriorKey(surface));
  if (surfaceUnitsMemo.size >= SURFACE_UNITS_MEMO_MAX) surfaceUnitsMemo.clear();
  surfaceUnitsMemo.set(surface, units);
  return units;
}

 function requestUnitMatchesSurface(unit: string, surfaceUnit: string): boolean {
  if (!unit || !surfaceUnit) return false;
  if (unit === surfaceUnit) return true;
  const memoKey = unit.length <= 64 && surfaceUnit.length <= 64 ? `${unit}${surfaceUnit}` : undefined;
  if (memoKey !== undefined) {
    const cached = requestUnitMatchMemo.get(memoKey);
    if (cached !== undefined) return cached;
  }
  const minLength = Math.min(unit.length, surfaceUnit.length);
  const maxLength = Math.max(unit.length, surfaceUnit.length);
  const prefixRelated = unit.startsWith(surfaceUnit) || surfaceUnit.startsWith(unit);
  // One character is not an inflection unless it is a plural: "capita" is not "capital" and "Borna" is not
  // "born" (both live 2026-09-10, answering "the capital of Afghanistan" with per-capita aid). Decided here, before
  // similarity, which would accept a one-letter difference on any word long enough.
  const longer = unit.length > surfaceUnit.length ? unit : surfaceUnit;
  const tail = longer.slice(minLength);
  if (prefixRelated && tail.length === 1 && /\p{L}/u.test(tail)) {
    const value = tail === "s";
    if (memoKey !== undefined) requestUnitMatchMemo.set(memoKey, value);
    return value;
  }
  const prefixCompatible = prefixRelated && minLength / Math.max(1, maxLength) >= 0.72;
  const value = prefixCompatible || requestUnitSimilarity(unit, surfaceUnit) >= 0.72;
  if (memoKey !== undefined) {
    if (requestUnitMatchMemo.size >= REQUEST_UNIT_MATCH_MEMO_MAX) requestUnitMatchMemo.clear();
    requestUnitMatchMemo.set(memoKey, value);
  }
  return value;
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
  const sentences = fastAnswerSentences(sourceTextSurface(evidenceWindowText(span), 24000));
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
  const surfaceUnits = memoizedSurfaceUnits(surface).filter(unit => unit.length >= 4);
  let overlap = 0;
  for (const unit of requestUnits) {
    if (surfaceUnits.some(surfaceUnit => requestUnitMatchesSurface(unit, surfaceUnit))) overlap++;
  }
  return overlap;
}


export function evidenceSpanProvenanceTitle(span: EvidenceSpan): string {
  return evidenceTitle(span);
}

/** Wikitable rows and template calls that survived ingestion as "prose": never an answer surface, never admissible evidence. */
export function isUnparsedMarkupText(text: string): boolean {
  const pipeCount = (text.match(/\|/gu) ?? []).length;
  if (pipeCount >= 3) return true;
  if (/\|style=|background:#|\{\{|\}\}/u.test(text)) return true;
  // A section heading alone ("==== Einstein as an inventor ====") names a section; it states nothing.
  const trimmed = text.trim();
  return /^=+\s*[^=]+\s*=+$/u.test(trimmed) || /^\[\[[^\]]*\]\]$/u.test(trimmed);
}

/** A heading-only or otherwise markup-only sentence has no claim in it; used where a single sentence is chosen. */
export function isHeadingOnlySurface(sentence: string): boolean {
  const trimmed = sentence.trim();
  return /^=+\s*[^=]+\s*=+\s*$/u.test(trimmed) || /^=+\s*[^=]+$/u.test(trimmed) && trimmed.length < 80;
}

export function spanIsUnparsedMarkup(span: EvidenceSpan): boolean {
  return isUnparsedMarkupText(String(span.text ?? span.textPreview ?? ""));
}

/** True when some span's source title names one of the request's own named subjects. A resident shortcut that
 *  cannot show this is a tangential mention, and must not preempt the corpus search that can find the subject's article. */
export function evidenceTitledForRequestSubject(text: string, spans: readonly EvidenceSpan[]): boolean {
  const anchors = namedSubjectAnchors(text).map(anchor => normalizePriorKey(anchor)).filter(anchor => anchor.length >= 3);
  if (!anchors.length) return true;
  // Whole units, not substrings: "born" is inside "Borna Reichstag constituency", and that match kept a pronoun
  // follow-up on the wrong article.
  return spans.some(span => {
    const titleUnits = splitPriorUnits(normalizePriorKey(evidenceTitle(span))).filter(Boolean);
    if (!titleUnits.length) return false;
    const title = ` ${titleUnits.join(" ")} `;
    return anchors.some(anchor => {
      const phrase = ` ${splitPriorUnits(anchor).filter(Boolean).join(" ")} `;
      // An uncased request has no name to cut at, so its anchor is a phrase that carries the title whole:
      // "martha washington invent the concept" names Martha Washington. A one-unit title ("Flag") is not a subject.
      return title.includes(phrase) || (titleUnits.length >= 2 && phrase.includes(title));
    });
  });
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
  return fastAnswerSentences(sourceTextSurface(evidenceWindowText(span), 24000)).find(sentence => sentence.length >= 24) ?? "";
}


 function sentenceContaining(text: string, needle: string): string {
  const lowerNeedle = needle.toLocaleLowerCase();
  return fastAnswerSentences(text).find(sentence => sentence.toLocaleLowerCase().includes(lowerNeedle)) ?? "";
}


/** The tier that admitted on the last call, for tracing. Diagnostic only; nothing reads it to make a decision. */
export let admissionTierDiagnostics: Record<string, unknown> = {};

export function sourceAnchoredEvidenceForRequest(
  requestText: string,
  evidence: readonly EvidenceSpan[],
  semanticFrameBoundEvidenceIds?: ReadonlySet<string>,
  /** The request's learned scaffolding: never a unit a source has to contain. */
  closedClassWords?: ReadonlySet<string>
): { required: boolean; anchors: string[]; evidence: EvidenceSpan[] } {
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  const initialismTokens = requestInitialismCandidates(requestText, anchors);
  // The initialism must refine among anchor-matched titles, not admit any
  // title with matching initials ("...visit Babbage as often..." admitted
  // Arthur Schopenhauer and Antoun Saad via "as").
  const initialismEvidence = initialismTokens.length
    ? evidence.filter(span => evidenceTitleInitialismMatches(span, initialismTokens)
      && (evidenceTitleDistinctAnchorMatches(span, anchors) || evidenceExactSourceAnchorMatches(span, anchors)))
    : [];
  if (initialismEvidence.length) {
    return { required: true, anchors: uniqueKernelStrings(anchors), evidence: initialismEvidence };
  }
  // Near-duplicate (cloze/quotation) requests: the span containing the
  // duplicated sentence IS the source identity; anchor heuristics are
  // question-shaped machinery and pick wrong-topic spans here.
  const nearDuplicateSequences = requestSentenceSequences(requestText);
  if (nearDuplicateSequences.length) {
    const nearDuplicates = evidence.filter(span =>
      spanContainsRequestNearDuplicateSentence(span, nearDuplicateSequences));
    if (nearDuplicates.length) {
      return { required: true, anchors: uniqueKernelStrings(anchors), evidence: nearDuplicates };
    }
  }
  if (!anchors.length) return { required: false, anchors, evidence: [...evidence] };
  const durableEvidencePresent = evidence.some(span => !String(span.id).startsWith("evidence_session_"));
  if (!durableEvidencePresent) {
    const sessionEvidence = evidence.filter(promotedSessionEvidence);
    if (sessionEvidence.length) return { required: true, anchors, evidence: sessionEvidence };
  }
  // A prior turn is not a source. `spanContainsRequestNearDuplicateSentence` already says so, and the fallback
  // above already treats session spans as the no-durable-memory case, but admission still returned them alongside
  // durable spans and let ranking choose between them. It chose them: asked "Who was Ada Lovelace?" against a
  // corpus holding her article, the live system answered with the 27-character text of an earlier question in the
  // same session, because an echo of the request matches the request better than a real sentence does.
  evidence = evidence.filter(span => !String(span.id).startsWith("evidence_session_"));
  const primaryAnchor = primarySourceAnchorForRequest(requestText, evidence, closedClassWords);
  const primaryAnchorUnits = primaryAnchor ? splitPriorUnits(primaryAnchor).filter(Boolean) : [];
  const primaryEvidence = primaryAnchor
    ? primaryEvidenceForSourceAnchor(primaryAnchor, requestText, evidence, closedClassWords)
    : [];
  const semanticFrameBoundEvidence = semanticFrameBoundEvidenceIds?.size
    ? evidence.filter(span => semanticFrameBoundEvidenceIds.has(String(span.id)))
    : [];
  // A named subject owns content admission: instruction phrases around it must not admit whatever article contains them.
  const contentAnchors = anchorsAboutNamedSubject(requestText);
  const contentBoundEvidence = evidence.filter(span =>
    contentAnchors.some(anchor => evidenceContentAnchorFitsRequest(span, anchor, requestText))
  );
  // A mention is admissible when the span is about the subject, not when it merely contains its name.
  //
  // Excluding the mention tier outright for name-only requests was wrong in the other direction: a subject that
  // appears only inside someone else's document -- a dictionary entry, a chapter, an email thread -- would become
  // permanently unanswerable, and the only reason Ada Lovelace survived it is that this corpus happens to carry an
  // article titled with her name. Aboutness cannot depend on that; a corpus of chapters has no such titles.
  //
  // Prominence is the test, and it needs no title and no grammar: a span about a subject returns to it, while a
  // span that lists it names it once among others. "Who was Charles Babbage?" bound to a Lovelace span naming him
  // once beside Noor Inayat Khan, in a paragraph that says "Lovelace" repeatedly -- the subject of that span is
  // plainly not Babbage, and counting says so.
  const subjectOnlyRequest = requestContentEvidenceUnits(requestText).length <= 3;
  const contentMentionEvidence = contentBoundEvidence.length
    ? []
    : evidence.filter(span => contentAnchors.some(anchor =>
      evidenceContentMentionsAnchor(span, anchor)
      && (!subjectOnlyRequest || spanIsAboutAnchor(span, anchor))));
  if (primaryAnchor
    && !primaryEvidence.length
    && !contentBoundEvidence.length
    && !contentMentionEvidence.length
    && !semanticFrameBoundEvidence.length) return { required: true, anchors: uniqueKernelStrings([primaryAnchor, ...anchors]), evidence: [] };
  const primaryExact = primaryAnchor
    ? evidence.filter(span => evidenceExactSourceAnchorMatches(span, [primaryAnchor]) && evidenceAnchorFitForRequest(span, requestText, closedClassWords))
    : [];
  if (primaryAnchor && primaryExact.length && requestContentEvidenceUnits(requestText).length <= 3) {
    return { required: true, anchors: uniqueKernelStrings([primaryAnchor, ...anchors]), evidence: uniqueEvidenceById([...primaryExact, ...semanticFrameBoundEvidence]) };
  }
  if (primaryAnchor && primaryAnchorUnits.length === 1 && primaryEvidence.length) {
    return { required: true, anchors: uniqueKernelStrings([primaryAnchor, ...anchors]), evidence: uniqueEvidenceById([...primaryEvidence, ...semanticFrameBoundEvidence]) };
  }
  const exact = evidence.filter(span => (
    (evidenceExactSourceAnchorMatches(span, contentAnchors) || evidenceTitleDistinctAnchorMatches(span, contentAnchors)) &&
    evidenceAnchorFitForRequest(span, requestText, closedClassWords)
  ));
  const selected = evidence.filter(span => (
    (evidenceSourceMatchesAnchors(span, contentAnchors) || evidenceTitleDistinctAnchorMatches(span, contentAnchors)) &&
    evidenceAnchorFitForRequest(span, requestText, closedClassWords)
  ));
  // Which tier admitted, not just how many: "the wrong span was admitted" and "the right span was never retrieved"
  // are indistinguishable from a count, and every admission bug this file has had was a question of which rule fired.
  admissionTierDiagnostics = {
    primaryAnchor: primaryAnchor ?? null,
    primaryEvidence: primaryEvidence.length,
    exact: exact.length,
    selected: selected.length,
    contentBound: contentBoundEvidence.length,
    contentMention: contentMentionEvidence.length,
    semanticFrameBound: semanticFrameBoundEvidence.length,
    subjectOnlyRequest,
    contentAnchors: contentAnchors.slice(0, 6)
  };
  return {
    required: true,
    anchors: uniqueKernelStrings([...(primaryAnchor ? [primaryAnchor] : []), ...anchors]),
    evidence: preferExactTitleSources(
      exact.length
        ? uniqueEvidenceById([...primaryEvidence, ...exact, ...contentBoundEvidence, ...contentMentionEvidence, ...selected, ...semanticFrameBoundEvidence])
        : uniqueEvidenceById([...primaryEvidence, ...contentBoundEvidence, ...contentMentionEvidence, ...selected, ...semanticFrameBoundEvidence]),
      uniqueKernelStrings([...(primaryAnchor ? [primaryAnchor] : []), ...anchors]),
      semanticFrameBoundEvidenceIds
    )
  };
}


/**
 * Source-identity admission (sealed-eval finding, rehearsal-20260816): a
 * title that merely *contains* a request anchor satisfies the same
 * distinct-anchor match as the article the request actually names -- "List
 * of Star Trek: The Original Series episodes" competed on equal footing
 * with "Star Trek: The Original Series" and could win, after which no
 * amount of downstream sentence ranking could recover the right answer.
 *
 * A title that exactly names the requested subject is strictly stronger
 * source identity than one embedding it in a longer, different subject.
 * So when any admitted source matches a request anchor exactly, the
 * merely-containing ones stop competing. Applied only when a real exact
 * match exists, so requests with no exactly-titled source are unaffected;
 * explicitly semantic-frame-bound evidence is always retained, since that
 * binding is a stronger, deliberate signal than title shape.
 */
 function preferExactTitleSources(
  evidence: readonly EvidenceSpan[],
  anchors: readonly string[],
  semanticFrameBoundEvidenceIds?: ReadonlySet<string>
): EvidenceSpan[] {
  if (evidence.length < 2 || !anchors.length) return [...evidence];
  const exactTitled = evidence.filter(span => anchors.some(anchor => evidenceTitleExactlyMatchesAnchor(span, anchor)));
  if (!exactTitled.length || exactTitled.length === evidence.length) return [...evidence];
  const frameBound = semanticFrameBoundEvidenceIds?.size
    ? evidence.filter(span => semanticFrameBoundEvidenceIds.has(String(span.id)))
    : [];
  return uniqueEvidenceById([...exactTitled, ...frameBound]);
}

export function sourceIdentityAdmissibleEvidenceForRequest(
  requestText: string,
  evidence: readonly EvidenceSpan[],
  semanticFrameBoundEvidenceIds: ReadonlySet<string> = new Set(),
  /** The request's learned scaffolding: never a unit a source has to contain. */
  closedClassWords?: ReadonlySet<string>
): { required: boolean; anchors: string[]; evidence: EvidenceSpan[] } {
  // Reset first: the tiers are written at the final return, so an early return left the previous call's values in
  // place and a trace read them as this turn's.
  admissionTierDiagnostics = { earlyReturn: true };
  const anchored = sourceAnchoredEvidenceForRequest(
    requestText,
    evidence,
    semanticFrameBoundEvidenceIds,
    closedClassWords
  );
  if (!anchored.required) return anchored;
  // Generic single-unit anchors admitted unrelated articles by title; match
  // multi-unit anchors when any exist.
  const specificAnchors = anchored.anchors.filter(anchor =>
    splitPriorUnits(normalizePriorKey(anchor)).filter(Boolean).length >= 2);
  // The same subject-unit rule the retrieval feature builder uses, for the same reason: the two-unit anchors are
  // often just the subject plus a neighbouring request word, and dropping the one-unit subject leaves only phrases
  // that occur nowhere. "What did Einstein discover?" admitted against `einstein discover` and `did einstein`,
  // matched no title, and admitted 0 of 36 spans that had matched `einstein` exactly.
  // The request's own named subject is a subject anchor whether or not every phrase carries it: "Athens is the
  // capital of which country?" forms "capital which country" and "which country", so the every-phrase test refused
  // "athens", the only anchor its article is titled with, and admitted nothing (live 2026-09-10).
  const namedSubjectSingles = namedSubjectAnchors(requestText)
    .map(anchor => normalizePriorKey(anchor))
    .filter(anchor => splitPriorUnits(anchor).filter(Boolean).length === 1 && [...anchor].length >= 3 && !genericQuestionSignal(anchor));
  const subjectAnchors = uniqueKernelStrings([
    ...namedSubjectSingles,
    ...anchored.anchors.filter(anchor => anchorIsRequestSubjectUnit(anchor, anchored.anchors))
  ]);
  const admissionAnchors = specificAnchors.length || subjectAnchors.length
    ? uniqueKernelStrings([...specificAnchors, ...subjectAnchors])
    : anchored.anchors;
  // Content admits only in the near-duplicate regime, so cross-title
  // mentions still stay out for question-shaped requests.
  const admissionSequences = requestSentenceSequences(requestText);
  const admitted = anchored.evidence.filter(span => (
    evidenceExactSourceAnchorMatches(span, admissionAnchors)
    || evidenceTitleDistinctAnchorMatches(span, admissionAnchors)
    || semanticFrameBoundEvidenceIds.has(String(span.id))
    || spanContainsRequestNearDuplicateSentence(span, admissionSequences)
  ));
  // Titleless corpora (workspace files) can never satisfy title-identity
  // admission; content-anchor admission applies to titleless spans ONLY, so
  // titled corpora keep the strict cross-title abstention guarantees.
  if (!admitted.length && evidence.length) {
    const titleless = evidence.filter(span => !evidenceTitle(span));
    const contentAnchors = uniqueKernelStrings(anchored.anchors.flatMap(anchor => splitPriorUnits(normalizePriorKey(anchor)))).filter(unit => [...unit].length >= 3);
    const requiredHits = Math.min(2, contentAnchors.length);
    const scored = titleless
      .map(span => {
        const surface = normalizePriorKey(String(span.text ?? span.textPreview ?? ""));
        return { span, hits: contentAnchors.filter(anchor => surface.includes(anchor)).length };
      })
      .filter(row => row.hits >= requiredHits)
      .sort((left, right) => right.hits - left.hits);
    admitted.push(...scored.slice(0, 12).map(row => row.span));
    // A titled article can still be the only source that binds the subject asked about: "Who played Sisko?"
    // names a character, and the article that answers is titled Star Trek: Deep Space Nine. Title identity
    // admits nothing, so the choice is between this article and answering nothing at all. It is admitted when
    // every content anchor sits inside one of its sentences -- a binding mention, not a passing one -- and
    // only when no title-identified span exists, so cross-title abstention holds whenever a title does match.
    if (!admitted.length && contentAnchors.length) {
      const titled = evidence.filter(span => evidenceTitle(span));
      const bound = titled
        .map(span => {
          const hits = splitSurfaceSentences(String(span.text ?? span.textPreview ?? ""))
            .map(sentence => normalizePriorKey(sentence))
            .reduce((best, sentence) => Math.max(best, contentAnchors.filter(anchor => sentence.includes(anchor)).length), 0);
          return { span, hits };
        })
        .filter(row => row.hits >= Math.max(1, contentAnchors.length))
        .sort((left, right) => right.hits - left.hits);
      admitted.push(...bound.slice(0, 12).map(row => row.span));
    }
  }
  // Post-rechunk, 4KB children carry the same content; parents are graph linkage only.
  const passages = admitted.filter(span => [...String(span.text ?? "")].length <= 4096);
  const oversized = admitted.filter(span => [...String(span.text ?? "")].length > 4096);
  return {
    ...anchored,
    evidence: [...passages, ...oversized]
  };
}

// Gate per REQUEST sentence: a two-sentence cloze context halves the whole-
// request fraction, so no single corpus sentence could ever reach 0.5.
export function requestSentenceSequences(text: string): string[][] {
  // An interrogative request is never a near-duplicate: a question can
  // restate a short evidence sentence, a cloze never ends with "?".
  if (endsWithUnicodeQuestionMark(text.trim())) return [];
  const whole = orderedSequenceUnits(text);
  const sequences = splitSurfaceSentences(text)
    .map(sentence => orderedSequenceUnits(sentence))
    .filter(sequence => sequence.length >= 4);
  if (whole.length >= 4 && !sequences.length) return [whole];
  return sequences;
}

export function spanContainsRequestNearDuplicateSentence(span: EvidenceSpan, requestSequences: readonly (readonly string[])[]): boolean {
  if (!requestSequences.length) return false;
  // Session spans echo the request itself; only durable memory counts as a source.
  if (String(span.id).startsWith("evidence_session_")) return false;
  const titleUnits = new Set(requestUnitsFromText(evidenceTitle(span)));
  // slice(0,4000) blinded the gate to the last ~90 chars of a 4096-byte
  // chunk, exactly where boundary-split sentences live.
  const window = evidenceWindowText(span);
  // A boundary-joined span carries its quoted sentence at the join, past the cheap head window.
  const bounded = window.length <= 6000 || boundaryJoinedSpan(span) ? window.slice(0, 12000) : window.slice(0, 4000);
  return fastAnswerSentences(bounded).some(sentence =>
    requestSequences.some(sequence =>
      surfaceRequestOrderedAdjacentPairFraction(sentence, sequence, titleUnits) >= 0.5));
}


function boundaryJoinedSpan(span: EvidenceSpan): boolean {
  const provenance = span.provenance;
  return Boolean(provenance && typeof provenance === "object" && !Array.isArray(provenance) && Array.isArray((provenance as Record<string, unknown>).boundaryJoin));
}

function evidenceContentAnchorFitsRequest(span: EvidenceSpan, anchor: string, requestText: string): boolean {
  const anchorUnits = splitPriorUnits(normalizePriorKey(anchor)).filter(Boolean);
  if (anchorUnits.length < 2) return false;
  // What the request asks *about* its subject, not every word it used to ask.
  //
  // Drawing these from `requestAnchorFitUnits` admitted the request's own question words as though they were the
  // relation being asked for, and one of them landed: "Who was Charles Babbage?" bound to a sentence in the Ada
  // Lovelace article because the interrogative "who" matched the title "Doctor Who", and the live system answered
  // a biographical question with a list of television characters. Content units carry the same structural filter
  // used elsewhere -- four characters, or any uncased non-Latin script -- so short interrogatives drop out without
  // a word list and without assuming a language.
  //
  // A request that asks nothing beyond naming its subject therefore has no relation to bind, and content admission
  // declines rather than reaching for a sentence that merely contains the name. Title is never consulted here:
  // aboutness has to work for a dictionary entry, a chapter or an email, none of which are titled with their
  // subject the way an encyclopedia article is.
  const relationUnits = requestContentEvidenceUnits(requestText)
    .filter(unit => !anchorUnits.some(anchorUnit => requestUnitMatchesSurface(unit, anchorUnit)));
  if (!relationUnits.length) return false;
  return fastAnswerSentences(evidenceWindowText(span).slice(0, 4000)).some(sentence => {
    const sentenceUnits = splitPriorUnits(normalizePriorKey(sentence)).filter(Boolean);
    if (!sourceAnchorPhraseContains(sentenceUnits, anchorUnits)) return false;
    return relationUnits.some(unit => sentenceUnits.some(sentenceUnit => requestUnitMatchesSurface(unit, sentenceUnit)));
  });
}

/**
 * Whether a span is *about* an anchor rather than merely containing it, by how much of the span returns to it.
 *
 * Structural and source-shape neutral: no title, no grammar, no word list. A document about a subject keeps
 * referring to it; one that lists the subject names it once among other names. So the anchor's own occurrences are
 * compared against the most frequent competing capitalized-run in the same span, and the anchor has to hold its own.
 * This is what lets a dictionary entry, a book chapter or a mail thread answer a question about someone the corpus
 * has no article for, while keeping a passing mention from answering a question about its subject.
 */
function spanIsAboutAnchor(span: EvidenceSpan, anchor: string): boolean {
  const text = evidenceWindowText(span).slice(0, 4000);
  const anchorUnits = splitPriorUnits(normalizePriorKey(anchor)).filter(Boolean);
  if (!anchorUnits.length) return false;
  const units = splitPriorUnits(normalizePriorKey(text)).filter(Boolean);
  if (!units.length) return false;
  // The anchor's least-common unit bounds how often the whole phrase can occur, without matching the phrase itself
  // repeatedly across a large window.
  const anchorOccurrences = Math.min(...anchorUnits.map(unit => units.filter(candidate => candidate === unit).length));
  if (anchorOccurrences < 1) return false;
  const competing = new Map<string, number>();
  for (const run of surfaceEntityRuns(text)) {
    const runUnits = splitPriorUnits(normalizePriorKey(run)).filter(Boolean);
    if (!runUnits.length) continue;
    if (runUnits.some(unit => anchorUnits.includes(unit))) continue;
    const occurrences = Math.min(...runUnits.map(unit => units.filter(candidate => candidate === unit).length));
    const key = runUnits.join(" ");
    competing.set(key, Math.max(competing.get(key) ?? 0, occurrences));
  }
  const strongestCompetitor = competing.size ? Math.max(...competing.values()) : 0;
  return anchorOccurrences >= strongestCompetitor;
}

function evidenceContentMentionsAnchor(span: EvidenceSpan, anchor: string): boolean {
  const anchorUnits = splitPriorUnits(normalizePriorKey(anchor)).filter(Boolean);
  if (anchorUnits.length < 2) return false;
  const previewUnits = splitPriorUnits(normalizePriorKey(evidenceWindowText(span).slice(0, 4000))).filter(Boolean);
  return sourceAnchorPhraseContains(previewUnits, anchorUnits);
}


 function primaryEvidenceForSourceAnchor(primaryAnchor: string, requestText: string, evidence: readonly EvidenceSpan[], closedClassWords?: ReadonlySet<string>): EvidenceSpan[] {
  const exact = evidence.filter(span =>
    evidenceExactSourceAnchorMatches(span, [primaryAnchor]) &&
    evidenceAnchorFitForRequest(span, requestText, closedClassWords)
  );
  const primaryAnchorUnits = splitPriorUnits(primaryAnchor).filter(Boolean);
  if (primaryAnchorUnits.length === 1 && exact.length) return exact;
  return evidence.filter(span => {
    const titleMatched = evidenceExactSourceAnchorMatches(span, [primaryAnchor]) || evidenceTitleDistinctAnchorMatches(span, [primaryAnchor]);
    if (titleMatched && evidenceAnchorFitForRequest(span, requestText, closedClassWords)) return true;
    return primaryAnchorUnits.length >= 2 && evidenceMatchesSourceAnchor(span, primaryAnchor);
  });
}


/** The values the last anchor-fit decision was made from, for tracing. Diagnostic only; nothing reads it to decide. */
let anchorFitDiagnostics: Record<string, unknown> = {};

export function lastAnchorFitDiagnostics(): Record<string, unknown> {
  return anchorFitDiagnostics;
}

export function evidenceAnchorFitForRequest(span: EvidenceSpan, requestText: string, closedClassWords?: ReadonlySet<string>): boolean {
  const titleUnits = sourceTitleAnchorFitUnitSet(span);
  const requestUnits = requestAnchorFitUnits(requestText, closedClassWords);
  const decided = (fits: boolean, reason: string, extra: Record<string, unknown> = {}): boolean => {
    anchorFitDiagnostics = { fits, reason, span: String(span.id).slice(-12), titleUnits: [...titleUnits], requestUnits, ...extra };
    return fits;
  };
  if (!titleUnits.size) return decided(true, "untitled_source");
  if (!requestUnits.length) return decided(true, "no_request_units");
  const matchedTitleUnits = [...titleUnits].filter(titleUnit => requestUnits.some(unit => requestUnitMatchesSurface(unit, titleUnit)));
  const firstTitlePosition = firstTitleUnitPosition(requestUnits, titleUnits);
  if (!matchedTitleUnits.length) return decided(false, "no_title_unit_matched", { firstTitlePosition });
  if (matchedTitleUnits.length >= 2 && firstTitlePosition <= 2) return decided(true, "title_units_lead_request", { matchedTitleUnits, firstTitlePosition });
  // What the request asks beyond naming the title: the same four-letter content rule evidenceContentAnchorFitsRequest
  // uses, so a short interrogative is not a unit the span has to contain. "Who is Aphrodite?" required the word "who"
  // inside the span, and the article's own opening block -- which does not say "who" -- was the one span it dropped.
  const nonTitleUnits = requestUnits
    .filter(unit => ![...titleUnits].some(titleUnit => requestUnitMatchesSurface(unit, titleUnit)))
    .filter(unit => [...unit].length >= 4 || hasUncasedNonLatinLetter(unit));
  // A request that only names the title is answered by the titled source itself.
  if (!nonTitleUnits.length) return decided(matchedTitleUnits.length >= 1, "request_names_title_only", { matchedTitleUnits, firstTitlePosition });
  const sourceSurface = sourceTextSurface(evidenceWindowText(span), 3200);
  const nonTitleOverlap = requestUnitOverlapForSurface(sourceSurface, new Set(nonTitleUnits));
  const singleLateTitleOverlapFloor = titleUnits.size === 1 && firstTitlePosition > 2 ? 2 : 1;
  if (matchedTitleUnits.length >= 1 && nonTitleOverlap >= singleLateTitleOverlapFloor) {
    return decided(true, "non_title_overlap_met", { matchedTitleUnits, firstTitlePosition, nonTitleUnits, nonTitleOverlap, floor: singleLateTitleOverlapFloor });
  }
  return decided(
    titleUnits.size > 1 && firstTitlePosition <= 2 && matchedTitleUnits.length / Math.max(1, titleUnits.size) >= 0.67,
    "title_majority_fallback",
    { matchedTitleUnits, firstTitlePosition, nonTitleUnits, nonTitleOverlap, floor: singleLateTitleOverlapFloor }
  );
}


 function sourceTitleAnchorFitUnitSet(span: EvidenceSpan): Set<string> {
  return new Set(splitPriorUnits(normalizePriorKey(evidenceTitle(span)))
    .map(unit => unit.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(unit => unit.length >= 3 && !genericQuestionSignal(unit)));
}


 function requestAnchorFitUnits(text: string, closedClassWords?: ReadonlySet<string>): string[] {
  // The request's learned scaffolding is not a unit a source must contain. "What is the capital of Albania?" made
  // "what" a content unit, and with the title late in the request the overlap floor is two: the article's own lead
  // block says "capital" and never says "what", so it was dropped while body chunks that happen to say both passed.
  return splitPriorUnits(normalizePriorKey(text.replace(/[?!.]+$/u, "")))
    .map(unit => unit.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(unit => unit.length >= 3 && !genericQuestionSignal(unit) && !closedClassWords?.has(unit));
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


/** An anchor that titles only a few documents is a subject, not an instruction word that happens to sit in many titles. */
const SUBJECT_ANCHOR_TITLE_MATCH_BOUND = 4;

/** How far down the ranked sentences the predication check runs. Compiling propositions is turn-time work. */
const ANCHOR_PREDICATION_RERANK_LIMIT = 8;

/**
 * Whether the sentence says something ABOUT the anchor, rather than merely naming it.
 *
 * Decided by the turn's own proposition compiler, not by a new rule: atomizeText puts the material a sentence
 * predicates over in the atom's leading role and a passing mention in a trailing one. Measured on "Who was Charles
 * Babbage?" against the Ada Lovelace article -- "Charles Babbage and Ada Lovelace conceived the first programmable
 * computer" places the anchor in the leading role, while "The character was portrayed by Sylvie Briggs, alongside
 * characterisations of Charles Babbage and Noor Inayat Khan." places it in a trailing one.
 */
function sentencePredicatesAboutAnchors(sentence: string, anchors: readonly string[]): boolean {
  const normalizedAnchors = anchors.map(anchor => normalizePriorKey(anchor)).filter(Boolean);
  if (!normalizedAnchors.length) return false;
  // A sentence that opens on the anchor predicates about it by construction ("'Athens' is the capital and largest
  // city of Greece"): the proposition compiler leaves a sentence-initial subject out of the leading role, so every
  // encyclopedic lead failed this test while "The Athens area encompasses..." passed it (live 2026-09-10).
  const sentenceUnits = splitPriorUnits(normalizePriorKey(sentence))
    .map(unit => unit.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  if (normalizedAnchors.some(anchor => {
    const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
    return anchorUnits.length > 0 && anchorUnits.every((unit, index) => sentenceUnits[index] === unit);
  })) return true;
  for (const atom of atomizeText({ text: sentence, source: SEMANTIC_SOURCE.CLAIM, maxAtoms: 2 })) {
    const leading = atom.roles[0];
    if (!leading) continue;
    const leadingSurface = normalizePriorKey(leading.normalized || leading.value);
    if (normalizedAnchors.some(anchor => leadingSurface.includes(anchor))) return true;
  }
  return false;
}
/**
 * Every request anchor built on a named subject, in the request's own anchor order; the full anchor list
 * when the request names none. This is what keeps an instruction phrase ("short story") from owning a
 * request while still allowing the anchor that actually titles the source ("Voynich manuscript"). Pure.
 */
function anchorsAboutNamedSubject(requestText: string): string[] {
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  const named = namedSubjectAnchors(requestText)
    .flatMap(anchor => splitPriorUnits(normalizePriorKey(anchor)))
    .filter(unit => unit.length >= 3);
  if (!named.length) return anchors;
  const about = anchors.filter(anchor => {
    const units = splitPriorUnits(normalizePriorKey(anchor));
    return units.some(unit => named.includes(unit));
  });
  return about.length ? about : anchors;
}

function subjectLikeAnchor(row: { exactTitleMatches: number }): boolean {
  return row.exactTitleMatches > 0 && row.exactTitleMatches <= SUBJECT_ANCHOR_TITLE_MATCH_BOUND;
}

 function primarySourceAnchorForRequest(requestText: string, evidence: readonly EvidenceSpan[], closedClassWords?: ReadonlySet<string>): string | undefined {
  // The subject owns the request, but the anchor that names it is often longer than the capitalised part
  // ("Voynich manuscript" for the name "Voynich"), so keep every anchor built on a named subject and drop
  // only the instruction phrases that name none.
  const ranked = anchorsAboutNamedSubject(requestText)
    .map(anchor => {
      const anchorUnits = splitPriorUnits(normalizePriorKey(anchor)).filter(Boolean);
      if (!anchorUnits.length) return undefined;
      let exactTitleMatches = 0;
      let completeSourceMatches = 0;
      let supportMass = 0;
      for (const span of evidence) {
        if (!evidenceAnchorFitForRequest(span, requestText, closedClassWords)) continue;
        const exactTitle = evidenceExactSourceAnchorMatches(span, [anchor]);
        const sourceUnits = splitPriorUnits(normalizePriorKey(evidenceSourceAnchorSurface(span))).filter(Boolean);
        const completeSourceMatch = sourceAnchorPhraseContains(sourceUnits, anchorUnits);
        if (!exactTitle && !completeSourceMatch) continue;
        if (exactTitle) exactTitleMatches++;
        if (completeSourceMatch) completeSourceMatches++;
        supportMass += kernelClamp01(span.alpha);
      }
      if (!exactTitleMatches && !completeSourceMatches) return undefined;
      const requestOrder = normalizePriorKey(requestText).indexOf(normalizePriorKey(anchor));
      return { anchor, exactTitleMatches, completeSourceMatches, supportMass, requestOrder: requestOrder < 0 ? Number.MAX_SAFE_INTEGER : requestOrder };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row))
    .sort((left, right) =>
      // Existence first, then SPECIFICITY, then RARITY -- never raw match
      // count descending. Counting title matches was a proxy for "this
      // anchor is a real document title at all", and it inverts the moment
      // a generic unit is part of many titles: on a live cloze request the
      // sentence-initial instruction word "complete" out-titled the actual
      // subjects ("ada byron building", "zaragoza university") because it
      // matched dozens of unrelated documents, so the primary anchor -- and
      // with it the admitted evidence -- locked onto prompt wording instead
      // of the subject. A subject anchor is precisely the one that matches
      // FEW documents.
      (right.exactTitleMatches > 0 ? 1 : 0) - (left.exactTitleMatches > 0 ? 1 : 0) ||
      // Two subject-like anchors (both rare titles): the request states its topic first, so the earlier one owns the answer.
      (subjectLikeAnchor(left) && subjectLikeAnchor(right) ? left.requestOrder - right.requestOrder : 0) ||
      sourceAnchorPhraseRank(right.anchor) - sourceAnchorPhraseRank(left.anchor) ||
      (left.exactTitleMatches || Number.MAX_SAFE_INTEGER) - (right.exactTitleMatches || Number.MAX_SAFE_INTEGER) ||
      right.completeSourceMatches - left.completeSourceMatches ||
      right.supportMass - left.supportMass ||
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
      // Count the anchor's raw units here: a short unit ("ada") is still a unit of the phrase.
      // A one-unit anchor was refused against a multi-unit title unless the title matched it exactly, which made
      // every surname-only reference unanswerable: "What did Einstein discover?" retrieved 71 promoted spans of
      // the Albert Einstein article and admitted none of them. The refusal exists to stop a generic word admitting
      // an article by title, and the subject test below separates the two without a word list -- a unit the
      // request's own multi-unit anchors are all built around is that request's subject, and a stray word is not.
      if (splitPriorUnits(anchor).filter(Boolean).length === 1
        && rawCoreUnits.length > 1
        && !evidenceTitleExactlyMatchesAnchor(span, anchor)
        && !anchorIsRequestSubjectUnit(anchor, anchors)) continue;
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


/**
 * Whether a one-unit anchor is the subject the request is built around, rather than a word that happens to be one.
 *
 * Structural and request-local: the anchors a request produces include both its subject and phrases formed from the
 * subject plus neighbouring words. A unit that appears in every multi-unit anchor is what those phrases are about;
 * one that appears in none of them is not. For "What did Einstein discover?" the anchors are einstein, what,
 * einstein discover and did einstein -- einstein passes and what does not, with no list of words anywhere.
 */
function anchorIsRequestSubjectUnit(anchor: string, anchors: readonly string[]): boolean {
  const unit = normalizePriorKey(anchor);
  if (!unit) return false;
  const multiUnitAnchors = anchors.filter(candidate => splitPriorUnits(normalizePriorKey(candidate)).filter(Boolean).length >= 2);
  if (!multiUnitAnchors.length) return false;
  return multiUnitAnchors.every(candidate =>
    splitPriorUnits(normalizePriorKey(candidate)).filter(Boolean).includes(unit));
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
  if (paddedTitle.includes(` ${anchor} `) || paddedAnchor.includes(` ${title} `)) return true;
  // Unit-wise with suffix tolerance: an inflected or possessive form of a title unit ("lovelace's") still names the title.
  const titleUnits = splitPriorUnits(title).filter(Boolean);
  const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
  return titleUnits.length >= 1 && titleUnits.length === anchorUnits.length && titleUnits.every((unit, index) => titleAnchorUnitMatches(anchorUnits[index]!, unit));
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
    const surface = sourceTextSurface(evidenceWindowText(span), 24000);
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


/**
 * Binds the selected answer into the entailment the mouth speaks from.
 *
 * The evidence was already bound here; the answer TEXT was not, and the mouth does not receive the candidate it is
 * realizing -- answerFromObligations re-derives a surface from the entailment and evidence on its own. So the turn
 * could select the right sentence and say a different one: measured on "Who was Charles Babbage?", the plan selected
 * "Charles Babbage and Ada Lovelace conceived the first programmable computer" and the mouth spoke three sentences of
 * unrelated trivia from the same article, because entailment.claim.text still held what the graph path seeded.
 * answerText is a verified verbatim substring of its evidence span (the plan guarantees it), so carrying it here
 * states what the turn decided rather than letting a second, differently-scored selection overrule the first.
 */
export function bindSelectedEvidenceToEntailment(entailment: TurnResult["entailment"], evidence: readonly EvidenceSpan[], audit: JsonValue, answerText?: string): TurnResult["entailment"] {
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
  const boundClaimText = answerText?.trim();
  return {
    ...entailment,
    ...(boundClaimText ? { claim: { ...entailment.claim, text: boundClaimText } } : {}),
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
  nearDuplicate: boolean;
}


 function bestEvidenceSentences(requestText: string, evidence: readonly EvidenceSpan[], sessionContextEvidence = false): string[] {
  // Mirrors proposeSourceExactEvidenceAnswer's ranking contract exactly
  // (see the long notes there): sentences are ranked IN tidySurfaceText
  // space so every returned surface is a verbatim substring of its span
  // (fastAnswerSentences' cleaning could glue quote-heavy regions into one
  // giant block that wins on content it never surfaces, and its
  // anchor-focus trimming mangled quotes/parentheses into surfaces the
  // mouth's excerpt verifier then rejected); lowercase-initial fragments
  // are penalized; and cross-span ranking carries the source-affinity
  // weight so the span whose title the request names most completely wins
  // over a sibling source scoring on words that happen to be absent from
  // its own title.
  const limit = evidenceAnswerSentenceLimit(requestText, evidence, sessionContextEvidence);
  const requestFeatures = featureSet(requestText, 256);
  const requestUnits = requestUnitSet(requestText);
  const orderedRequestUnits = requestUnitsFromText(requestText);
  const requestSequences = requestSentenceSequences(requestText);
  const anchors = sourceEvidenceAnchorsForRequest(requestText);
  const singleSpan = evidence.length === 1;
  const candidates = evidence
    .flatMap(span => {
      const tidySpanText = tidySurfaceText(span.text);
      const boundedChars = [...tidySpanText].slice(0, 24000);
      const allSentences = splitSurfaceSentences(boundedChars.join(""));
      let sentences = (boundedChars.length < [...tidySpanText].length ? allSentences.slice(0, -1) : allSentences).slice(0, 80);
      // This builder keeps verbatim substrings and so bypasses fastAnswerSentences; the same rule applies here.
      // A reference line names the subject and carries years, which is how a cited article's publication date
      // answered "When was Ada Lovelace born?". Citations stand aside while any prose remains.
      const citationFlags = citationSentenceFlags(sentences);
      const proseSentences = sentences.filter((_, index) => !citationFlags[index]);
      if (proseSentences.length) sentences = proseSentences;
      // Splitter mismatch guard: the near-duplicate GATE segments with
      // fastAnswerSentences; in table-heavy chunks this splitter glues the
      // duplicated sentence into a blob no row can match. Inject the
      // gate's matching sentences as rows, but only when they survive as
      // verbatim tidy-space substrings (the mouth verifier's contract).
      if (requestSequences.length) {
        const gateMatches = fastAnswerSentences(sourceTextSurface(evidenceWindowText(span), 6000))
          .filter(candidate => requestSequences.some(sequence =>
            surfaceRequestOrderedAdjacentPairFraction(candidate, sequence) >= 0.5))
          .filter(candidate => tidySpanText.includes(candidate) && !sentences.includes(candidate));
        if (gateMatches.length) sentences = [...gateMatches, ...sentences].slice(0, 80);
      }
      const titleMatches = anchors.length > 0 && evidenceTitleDistinctAnchorMatches(span, anchors);
      const titleUnitList = requestUnitsFromText(evidenceTitle(span));
      const titleUnitSet = new Set(titleUnitList);
      const titleRequestCoverage = titleUnitList.length
        ? titleUnitList.filter(titleUnit =>
          [...requestUnits].some(unit => requestUnitMatchesSurface(unit, titleUnit))).length / titleUnitList.length
        : 0;
      const sourceAffinityBoost = titleMatches && !singleSpan ? 3 * titleRequestCoverage : 0;
      // Content-net scoring + coverage transfer, identical in doctrine to
      // proposeSourceExactEvidenceAnswer (see the notes there): without
      // it, the boosted article lead beats the deeper sentence carrying
      // the request's actual content terms (verified live in run-f: "Who
      // played Captain James T. Kirk / Benjamin Sisko" both returned the
      // article opener without the actor's name).
      const leadingScaffolding = requestLeadingScaffoldingUnit(requestText);
      const contentRequestUnits = new Set([...requestUnits].filter(unit =>
        !titleUnitList.some(titleUnit => requestUnitMatchesSurface(unit, titleUnit)) && unit !== leadingScaffolding));
      let contentBoostIndex = -1;
      // Only the document's opening block has a lead to transfer from: in a mid-article chunk the first two
    // "sentences" are whatever the cut left, their coverage is zero, and the boost went to any sentence with a
    // content word -- "The Athens area encompasses a variety of terrain ... the capital is the only major city in
    // Europe" beat "'Athens' is the capital and largest city of Greece" by exactly that (live 2026-09-10).
    if (titleMatches && contentRequestUnits.size && documentOpeningSpan(span)) {
        const coverage = sentences
          .map((sentence, index) => ({
            index,
            contentOverlap: requestUnitOverlapForSurface(sentence, contentRequestUnits),
            fullOverlap: requestUnitOverlapForSurface(sentence, requestUnits)
          }))
          .filter(row => !lowercaseInitialFragment(sentences[row.index] ?? ""));
        const leadContent = Math.max(0, ...coverage.filter(row => row.index <= 1).map(row => row.contentOverlap));
        const best = [...coverage].sort((left, right) =>
          right.contentOverlap - left.contentOverlap
          || right.fullOverlap - left.fullOverlap
          || left.index - right.index)[0];
        if (best && best.contentOverlap > leadContent) contentBoostIndex = best.index;
      }
      return sentences.map((sentence, index): EvidenceSentenceRow => {
        const features = featureSet(sentence, 256);
        const lexical = weightedJaccard(requestFeatures, features) + (singleSpan ? 0 : weightedJaccard(requestFeatures, span.features) * 0.35);
        const unitOverlap = titleMatches && contentRequestUnits.size
          ? requestUnitOverlapForSurface(sentence, contentRequestUnits)
          : requestUnitOverlapForSurface(sentence, requestUnits);
        const pairOverlap = surfaceRequestAdjacentUnitPairOverlap(sentence, orderedRequestUnits);
        const anchorBoost = sourceSurfaceMatchesAnyAnchor(sentence, anchors) ? 0.54 : 0;
        const titleLeadBoost = titleMatches
          && (contentBoostIndex >= 0 ? index === contentBoostIndex : (documentOpeningSpan(span) && index <= 1))
          && (contentBoostIndex >= 0 || evidenceTitleAppearsInSurface(span, sentence))
          ? 4
          : 0;
        const fragmentPenalty = (lowercaseInitialFragment(sentence) ? 1.2 : 0) + (danglingTailFragment(sentence) ? 1.2 : 0);
        // Near-duplicated source sentence must outrank titleLead(4)+affinity(<=3).
        const nearDuplicateFraction = requestSequences.reduce((best, sequence) =>
          Math.max(best, surfaceRequestOrderedAdjacentPairFraction(sentence, sequence, titleUnitSet)), 0);
        const nearDuplicateBoost = nearDuplicateFraction >= 0.5 && !promotedSessionEvidence(span)
          ? 12 * nearDuplicateFraction
          : 0;
        return {
          span,
          sentence,
          features,
          index,
          unitOverlap,
          nearDuplicate: nearDuplicateBoost > 0,
          score: unitOverlap * 0.92
            + lexical * 0.35
            + pairOverlap * 0.16
            + nearDuplicateBoost
            + span.alpha * 0.12
            + anchorBoost
            + titleLeadBoost
            + sourceAffinityBoost
            + Math.max(0, 0.18 - index * 0.015)
            - fastAnswerLongSentencePenalty(sentence)
            - fragmentPenalty
        };
      });
    })
    // Heading/list clozes duplicate real but short surfaces ("== Cultural impact ==").
    .filter(row => (row.sentence.length >= 24 || row.nearDuplicate) && !isHeadingOnlySurface(row.sentence) && !cliticOpeningFragment(row.sentence))
    // The duplicated sentence outranks everything: a unit-rich table blob
    // can beat the boost on raw overlap count.
    .sort((left, right) => Number(right.nearDuplicate) - Number(left.nearDuplicate) || right.score - left.score || right.unitOverlap - left.unitOverlap || left.index - right.index || String(left.span.id).localeCompare(String(right.span.id)));
  // The quoted sentence answers a quotation by itself (same doctrine as the source-exact window).
  // Among the top candidates, the ones that predicate about the requested subject go first -- before the limit cuts
  // the list, because a preference applied after truncation can only reorder sentences that already survived.
  // Measured on "Who was Charles Babbage?": this returned two sentences, both merely naming him (a cast list and a
  // Doctor Who credit), while "Charles Babbage and Ada Lovelace conceived the first programmable computer" ranked
  // below the cut and never reached the answer. Stable partition of a bounded prefix: nothing is dropped, and when
  // no candidate predicates about the anchor the order is untouched.
  // Same rule as proposeSourceExactEvidenceAnswer: a request that only names its subject is answered by the titled
  // source's opening sentence, which predicates about its subject by construction even when it names it in a
  // longer form the anchor test cannot see. This ranker is the one the fast local-evidence plan actually uses, and
  // it sent "Who is Ada Lovelace?" to a Starfield trivia bullet while her article's lead sat in the pool.
  const leadingScaffoldingUnit = requestLeadingScaffoldingUnit(requestText);
  const coverageUnits = requestContentEvidenceUnits(requestText).filter(unit => unit !== leadingScaffoldingUnit);
  const subjectUnitSet = new Set(namedSubjectAnchors(requestText).flatMap(anchor => splitPriorUnits(normalizePriorKey(anchor)).filter(Boolean)));
  const definitional = subjectUnitSet.size > 0 && coverageUnits.every(unit => subjectUnitSet.has(unit));
  const openingRow = definitional && !candidates[0]?.nearDuplicate
    ? candidates.find(row => row.index <= 1 && documentOpeningSpan(row.span) && anchors.length > 0 && evidenceTitleDistinctAnchorMatches(row.span, anchors) && isProseSentence(row.sentence))
    : undefined;
  const rerankable = anchors.length && !candidates[0]?.nearDuplicate && !openingRow
    ? candidates.slice(0, ANCHOR_PREDICATION_RERANK_LIMIT)
    : [];
  const ranked = openingRow
    ? [openingRow, ...candidates.filter(row => row !== openingRow && String(row.span.id) === String(openingRow.span.id))]
    : rerankable.length
      ? [
        ...rerankable.filter(row => sentencePredicatesAboutAnchors(row.sentence, anchors)),
        ...rerankable.filter(row => !sentencePredicatesAboutAnchors(row.sentence, anchors)),
        ...candidates.slice(ANCHOR_PREDICATION_RERANK_LIMIT)
      ]
      : candidates;
  const selected = selectEvidenceSentenceRows(ranked, ranked[0]?.nearDuplicate ? 1 : limit);
  // Adjacent sentences read in document order, whatever order they were
  // scored in (run-f emitted "It acquired the retronym... 'Star Trek' is
  // an American..." -- the article's sentences reversed).
  return [...selected]
    .sort((left, right) => String(left.span.id).localeCompare(String(right.span.id)) || left.index - right.index)
    .map(item => item.sentence);
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
  const words = localSurfaceWordSpans(surface);
  if (words.length < 12) return surface;
  const normalized = words.map(word => word.key);
  for (const anchor of anchors) {
    const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
    if (!anchorUnits.length) continue;
    const first = anchorUnits[0] ?? "";
    const index = normalized.findIndex(unit => requestUnitMatchesSurface(first, unit));
    if (index <= 8) continue;
    const anchorStart = words[index]?.start ?? 0;
    const clauseStart = sourceBoundaryAlignedClauseStart(surface, anchorStart);
    if (clauseStart <= 0) continue;
    const clipped = cleanSourceAnswerSurface(surface.slice(clauseStart));
    if (clipped && sourceSurfaceMatchesAnyAnchor(clipped, [anchor])) return clipped;
  }
  return surface;
}


 function sourceBoundaryAlignedClauseStart(surface: string, beforeIndex: number): number {
  const prefix = surface.slice(0, Math.max(0, beforeIndex));
  // A clause boundary, not only a sentence terminal: the clause that binds the subject may open at a colon,
  // semicolon or comma inside one long sentence ("...central character: Starfleet Commander, later Captain,
  // Benjamin Sisko (played by Avery Brooks)"). Punctuation only, so it reads the same in any script.
  const boundary = [...prefix.matchAll(/[\p{Sentence_Terminal}\u3002\uff01\uff1f:;,\u3001\uff0c\uff1b\uff1a\u2013\u2014]\s*/gu)].at(-1);
  if (!boundary || boundary.index === undefined) return 0;
  const start = boundary.index + boundary[0].length;
  const interveningWords = localSurfaceWordSpans(surface.slice(start, beforeIndex));
  return interveningWords.length <= 12 ? start : 0;
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
  const units = memoizedSurfaceUnits(surface).filter(Boolean);
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
    // Coherence contract shared with every other multi-sentence surface
    // (source-exact window, direct-evidence join): sentences shown
    // together must be document-adjacent in the same span, or the reader
    // gets verbatim-but-disjoint prose whose pronouns and discourse
    // markers dangle ("He went on to appear in 31 episodes..." with no
    // antecedent -- verified live in the sealed-eval DS9 answers). A
    // non-adjacent runner-up is dropped rather than stitched; a
    // single-sentence answer is always coherent by construction.
    // Character-index adjacency, no language assumptions.
    if (selected.length && !selected.some(item => item.span.id === candidate.span.id && Math.abs(item.index - candidate.index) === 1)) continue;
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


// True word order with repetitions; requestUnitsFromText dedupes and so destroys adjacency.
export function orderedSequenceUnits(text: string): string[] {
  return memoizedSurfaceUnits(text)
    .map(unit => unit.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(unit => unit.length >= 4);
}


// Fraction of the request's ordered adjacent unit pairs appearing as ordered
// adjacent pairs in the sentence; only a near-duplicate (cloze/quotation)
// scores high, a natural question's word order never does.
export function surfaceRequestOrderedAdjacentPairFraction(surface: string, requestSequenceUnits: readonly string[], excludedUnits?: ReadonlySet<string>): number {
  if (requestSequenceUnits.length < 2) return 0;
  const surfaceUnits = orderedSequenceUnits(surface);
  if (surfaceUnits.length < 2) return 0;
  const surfacePairs = new Set<string>();
  for (let index = 0; index < surfaceUnits.length - 1; index++) {
    surfacePairs.add(`${surfaceUnits[index]} ${surfaceUnits[index + 1]}`);
  }
  let pairs = 0;
  let matched = 0;
  for (let index = 0; index < requestSequenceUnits.length - 1; index++) {
    const left = requestSequenceUnits[index] ?? "";
    const right = requestSequenceUnits[index + 1] ?? "";
    if (!left || !right || left === right) continue;
    // Title-internal pairs are naming, not content.
    if (excludedUnits?.has(left) && excludedUnits.has(right)) continue;
    pairs++;
    if (surfacePairs.has(`${left} ${right}`)) matched++;
  }
  // Symmetric denominator: a multi-sentence cloze context fully contains
  // its source sentence, so coverage is measured against the smaller pair
  // set; the absolute floor keeps trivial fragments and question-shaped
  // requests (whose non-title matches stay tiny) out.
  if (matched < 3) return 0;
  const denominator = Math.min(pairs, Math.max(1, surfacePairs.size));
  return denominator ? Math.min(1, matched / denominator) : 0;
}


 function surfaceRequestAdjacentUnitPairOverlap(surface: string, requestUnits: readonly string[]): number {
  if (requestUnits.length < 2) return 0;
  const surfaceUnits = memoizedSurfaceUnits(surface).filter(unit => unit.length >= 4);
  let overlap = 0;
  for (let index = 0; index < requestUnits.length - 1; index++) {
    const left = requestUnits[index] ?? "";
    const right = requestUnits[index + 1] ?? "";
    if (!left || !right || left === right) continue;
    if (requestUnitAppearsInSurface(left, surfaceUnits) && requestUnitAppearsInSurface(right, surfaceUnits)) overlap++;
  }
  return overlap;
}


// Pure of its input; span windows are stable corpus text re-split every
// turn — measured 2.2s of a 2.4s admission stage.
const fastAnswerSentencesMemo = new Map<string, string[]>();
const FAST_ANSWER_SENTENCES_MEMO_MAX = 4096;

 /** A citation says where something was published, not what was asked; a URL marks it in any script. Pure. */
function fastAnswerSentenceIsCitation(sentence: string): boolean {
  const folded = sentence.toLocaleLowerCase();
  if (folded.includes("http://") || folded.includes("https://") || folded.includes("www.")) return true;
  // A reference without a link still shows its shape: a short page range (both sides at most three digits, so a
  // life span like "1815 - 27 November 1852" is not one) together with a year. "Edinburgh Review: 263- 327.
  // Retrieved 11 October 2022." answered a birth question that way. Punctuation and digits only.
  const pageRange = /(?<![\p{Nd}])[\p{Nd}]{1,3}\s*[\u2013\u2014-]\s*[\p{Nd}]{1,3}(?![\p{Nd}])/u.test(sentence);
  const year = /(?<![\p{Nd}])[\p{Nd}]{4}(?![\p{Nd}])/u.test(sentence);
  return pageRange && year;
}

/** A reference often splits into two short sentences at its own period; each is judged with its neighbour. Pure. */
function citationSentenceFlags(sentences: readonly string[]): boolean[] {
  return sentences.map((sentence, index) => {
    if (fastAnswerSentenceIsCitation(sentence)) return true;
    if (sentence.length >= 80) return false;
    const next = sentences[index + 1];
    const previous = sentences[index - 1];
    return (next !== undefined && next.length < 80 && fastAnswerSentenceIsCitation(sentence + " " + next))
      || (previous !== undefined && previous.length < 80 && fastAnswerSentenceIsCitation(previous + " " + sentence));
  });
}

function fastAnswerSentences(text: string): string[] {
  const cached = fastAnswerSentencesMemo.get(text);
  if (cached) return cached;
  const all = fastAnswerSentencesUncached(text);
  // A reference line names the subject and carries years, so it beat real prose on both the lexical and the
  // date-seeking paths: "When was Ada Lovelace born?" answered with a cited article's 8 March 2018 publication
  // date. Citation lines stand aside while any prose remains, and still speak when they are all there is.
  const citation = citationSentenceFlags(all);
  const prose = all.filter((_, index) => !citation[index]);
  const value = prose.length ? prose : all;
  if (fastAnswerSentencesMemo.size >= FAST_ANSWER_SENTENCES_MEMO_MAX) fastAnswerSentencesMemo.clear();
  fastAnswerSentencesMemo.set(text, value);
  return value;
}

 function fastAnswerSentencesUncached(text: string): string[] {
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


/** The force of an answer that reports disagreement between sources rather than answering from one of them. */
export const SOURCE_CONFLICT_FORCE_ID = "output.force.source_conflict_answer";

/** Whether this answer reports that the sources disagree, rather than answering from one of them. Pure. */
export function localEvidenceAnswerReportsSourceConflict(plan: { kindId: string }): boolean {
  return plan.kindId === LOCAL_ANSWER_KIND_IDS.sourceConflict;
}

export function attachLocalEvidenceAnswerConstruct(input: {
  construct: ConstructGraph;
  plan: LocalEvidenceAnswerPlan;
  requestText: string;
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
  /** A higher-precision fact this turn already bound outside the local-evidence quote path (e.g. the temporal-
   *  value fast path's bare bound value) -- real bug, confirmed live: that fact never reached this
   *  ConstructGraph, so mouth.ts's construction-bundle lookup (semanticLearnedCandidate) never saw it and
   *  never had a chance to realize a real sentence around it; only the local-evidence quote's own facts were
   *  ever offered. REPLACES the quote-derived facts rather than merging with them: mouth.ts's
   *  completeLearnedFactCoverage requires exactly one relation/one answer slot, and this fact is strictly more
   *  precise than the quote it was extracted from, so there is nothing to gain from carrying both. */
  additionalFacts?: readonly SemanticAnswerConstructFact[];
}): ConstructGraph {
  const facts = input.additionalFacts?.length
    ? [...input.additionalFacts]
    : localEvidenceAnswerFacts(input.plan, input.requestText, input.hasher);
  if (!facts.length) return input.construct;
  const marker = jsonRecord(input.brainMarker);
  const evidenceIds = uniqueKernelStrings(input.plan.evidence.map(span => String(span.id)));
  const sourceVersionIds = uniqueKernelStrings(input.plan.evidence.map(span => String(span.sourceVersionId)));
  const nodeId = `construct:ans:${input.hasher.digestHex(JSON.stringify({ planId: input.plan.planId, evidenceIds })).slice(0, 20)}`;
  // completeLearnedFactCoverage requires state.selectedSubject === fact.subject exactly -- when additionalFacts
  // replaced the quote-derived facts above, selectedSubject must track that same fact's own subject, not the
  // local-evidence plan's independently-derived one (real risk of a byte-level mismatch between the two).
  const selectedSubject = input.additionalFacts?.length ? input.additionalFacts[0]!.subject : localEvidenceSelectedSubject(input.plan, input.requestText);
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
    // A conflict answer is source-bound like any other, and it is not one source speaking: the mouth must realize
    // every fact rather than lead with one, so the force says so instead of leaving it to be inferred.
    forceId: localEvidenceAnswerReportsSourceConflict(input.plan)
      ? SOURCE_CONFLICT_FORCE_ID
      : "output.force.source_bound_answer",
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


// Request relation minus subject anchors, so predicate hashes to a relation word ("born"), not a whole sentence.
function localAnswerRelationText(requestText: string): string {
  if (!requestText) return "";
  const subjectUnits = new Set(namedSubjectAnchors(requestText)
    .flatMap(anchor => splitPriorUnits(normalizePriorKey(anchor)).filter(Boolean)));
  return requestContentEvidenceUnits(requestText).filter(unit => !subjectUnits.has(unit)).join(" ");
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
  if (plan.kindId === LOCAL_ANSWER_KIND_IDS.sourceConflict) {
    const statements = plan.slotSurfaces[LOCAL_ANSWER_SLOT_IDS.conflictingStatement];
    const surfaces = Array.isArray(statements) ? statements : [statements].filter(Boolean) as string[];
    return surfaces.map((statement, index) => localEvidenceSemanticFact({
      // Same shape the ordinary source quote uses. semanticAnswerFactFromJson drops any fact with an empty
      // subject, predicate or object, so a fact carrying the statement only in its object was discarded, the
      // construct read as having no facts at all, and the turn fell back to answering from one side.
      subject: localEvidenceSelectedSubject(plan, requestText),
      predicate: ensureUnicodeSurfaceSentence(statement),
      object: ensureUnicodeSurfaceSentence(statement),
      relationId: LOCAL_ANSWER_RELATION_IDS.sourceQuote,
      evidence: plan.evidence[index] ? [plan.evidence[index]!] : plan.evidence,
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
      // The counterexample itself (e.g. "attested in 1478") leads; the
      // broader development context it's drawn from follows -- readers
      // need the specific fact that contradicts the premise before the
      // surrounding history that explains it.
      object: uniqueKernelStrings([counter, concept]).map(surface => ensureUnicodeSurfaceSentence(surface)).join(" "),
      relationId: LOCAL_ANSWER_RELATION_IDS.temporalCounterexample,
      evidence: plan.evidence,
      index: facts.length,
      hasher
    }));
    return facts;
  }
  const relationText = localAnswerRelationText(requestText);
  return localEvidenceFactSurfaces(plan, requestText).map((sentence, index) => localEvidenceSemanticFact({
    subject: localEvidenceSelectedSubject(plan, requestText),
    predicate: relationText || sentence,
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
    questionSlotReasonIds: [input.relationId],
    // Real bug, confirmed live: mouth.ts's learnedFactRouteAdmissible (the gate construction-bundle
    // realization requires) checks answerGrade/finalQuestionFit/certificationPower/semanticQuality, and this
    // fact never set any of them -- undefined fails every check, so construction-grammar realization was
    // unreachable for every local-evidence answer, not just a ranking loss. This fact was already selected as
    // an answer candidate by the caller; answerGrade is honestly true regardless (learnedFactRouteAdmissible
    // still independently requires finalQuestionFit >= 0.44, so a genuinely weak-evidence fact is still
    // correctly rejected by that check). finalQuestionFit deliberately has NO floor, unlike support/
    // questionSlotScore above -- learned-graph-prior-runtime.ts derives its own answerGrade from this exact
    // signal crossing that same 0.44 threshold (factQuestionFitAllowsSurface), so flooring it here would let a
    // fact past a gate its own real evidence quality does not support. certificationPower/semanticQuality
    // reuse the same 0.86 already governing this fact's score/activation/overlap above, not a new literal.
    answerGrade: true,
    finalQuestionFit: mean(input.evidence.map(span => span.alpha)),
    certificationPower: 0.86,
    semanticQuality: 0.86
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
  // A near-duplicated sentence is emitted whole: anchor-mention trimming
  // cut the answer span out of the sentence head (Horsley Towers).
  const realizationSequences = requestSentenceSequences(requestText);
  if (realizationSequences.some(sequence => surfaceRequestOrderedAdjacentPairFraction(clean, sequence) >= 0.5)) return clean;
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
