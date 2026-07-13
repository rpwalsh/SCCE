import type { CcrResult } from "./ccr.js";
import type { LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import type { NgramModelRecord } from "./storage.js";
import type { EvidenceSpan, FieldState, JsonValue, SemanticEntailmentResult } from "./types.js";
import { clamp01, featureSet, sourceTextSurface, toJsonValue, weightedJaccard } from "./primitives.js";
import { createSurfaceRealizer } from "./surface-realizer.js";
import { ensureSurfaceSentence, hasUncasedNonLatinLetter, hasUppercaseLetter, splitSurfaceSentences, surfaceWords } from "./surface-linguistics.js";

export interface EvidenceGroundedAnswer {
  answer: string;
  evidenceIds: string[];
  audit: JsonValue;
}

interface EvidenceCandidate {
  evidenceId?: string;
  source: "ccr" | "evidence";
  score: number;
  lcb: number;
  features: string[];
  textHash: string;
}

export function composeEvidenceGroundedAnswer(input: {
  requestText: string;
  entailment: SemanticEntailmentResult;
  evidence: readonly EvidenceSpan[];
  field: FieldState;
  ccr?: CcrResult;
  languageModels?: readonly NgramModelRecord[];
  languageMemory?: LanguageMemoryRuntimeState;
  locale?: string;
  maxSentences?: number;
}): EvidenceGroundedAnswer {
  const maxSentences = Math.max(1, Math.min(12, input.maxSentences ?? 3));
  const claimFeatures = input.entailment.claim.features.length
    ? input.entailment.claim.features
    : featureSet(input.entailment.claim.text, 512);
  const ppfMass = new Map(input.field.ppf.map(item => [String(item.nodeId), item.mass]));
  const evidenceMass = new Map<string, number>();
  for (const active of input.field.active) evidenceMass.set(String(active.nodeId), Math.max(evidenceMass.get(String(active.nodeId)) ?? 0, active.activation));

  const candidates = [
    ...ccrCandidates(input.ccr, claimFeatures),
    ...evidenceCandidates(input.evidence, claimFeatures, ppfMass, evidenceMass)
  ].sort((a, b) => b.score - a.score || b.lcb - a.lcb || a.textHash.localeCompare(b.textHash));
  const selected = selectDiverse(candidates, maxSentences);
  const selectedIds = selected.flatMap(item => item.evidenceId ? [item.evidenceId] : []);
  const referencedIds = [...new Set([...input.entailment.evidenceIds.map(String), ...selectedIds])];
  const referencedEvidence = referencedIds.length
    ? input.evidence.filter(span => referencedIds.includes(String(span.id)))
    : input.evidence.slice(0, Math.min(8, input.evidence.length));

  const realized = createSurfaceRealizer().realize({
    requestText: input.requestText,
    entailment: input.entailment,
    evidence: referencedEvidence.length ? referencedEvidence : input.evidence,
    ccr: input.ccr,
    ngramModels: input.languageModels,
    languageMemory: input.languageMemory,
    maxPoints: maxSentences,
    locale: input.locale
  });
  const evidenceIds = [...new Set([...referencedIds, ...realized.evidenceIds.map(String)])];
  const evidenceSurface = evidenceAnswerSurface(input.requestText, referencedEvidence.length ? referencedEvidence : input.evidence, maxSentences);
  const realizedSurface = usableAnswerSurface(realized.text);
  const answer = evidenceSurface || realizedSurface || "I do not have enough source-backed evidence to answer that.";
  return {
    answer,
    evidenceIds,
    audit: toJsonValue({
      source: "evidence-grounded-answer-emitter",
      surface: realized.audit,
      evidenceSurfaceUsed: Boolean(evidenceSurface),
      insufficientSupportSurfaceUsed: !evidenceSurface && !realizedSurface,
      candidates: candidates.slice(0, 24).map(item => ({
        source: item.source,
        score: item.score,
        lcb: item.lcb,
        evidenceId: item.evidenceId ?? null,
        textHash: item.textHash
      })),
      selected: selected.map(item => ({ source: item.source, score: item.score, lcb: item.lcb, evidenceId: item.evidenceId ?? null })),
      force: input.entailment.force,
      semanticVerdict: input.entailment.semanticVerdict,
      obligationCount: input.entailment.obligations.length,
      languageModels: input.languageModels?.length ?? 0,
      ccrAccepted: input.ccr?.accepted ?? false
    })
  };
}

function ccrCandidates(ccr: CcrResult | undefined, claimFeatures: readonly string[]): EvidenceCandidate[] {
  if (!ccr) return [];
  return ccr.l3.sentences.map(sentence => {
    const text = cleanSentence(sentence.text);
    const features = featureSet(text, 256);
    return {
      evidenceId: sentence.evidenceIds[0],
      source: "ccr" as const,
      score: clamp01(0.45 * sentence.lcb + 0.35 * weightedJaccard(claimFeatures, features) + 0.2 * (sentence.accepted ? 1 : 0)),
      lcb: sentence.lcb,
      features,
      textHash: hashText(text)
    };
  }).filter(item => item.textHash !== "0");
}

function evidenceCandidates(evidence: readonly EvidenceSpan[], claimFeatures: readonly string[], ppfMass: Map<string, number>, evidenceMass: Map<string, number>): EvidenceCandidate[] {
  const out: EvidenceCandidate[] = [];
  for (const span of evidence.slice(0, 48)) {
    const spanMass = Math.max(ppfMass.get(String(span.id)) ?? 0, evidenceMass.get(String(span.id)) ?? 0);
    for (const sentence of splitSentences(sourceTextSurface(span.text || span.textPreview, 24000)).slice(0, 80)) {
      const text = cleanSentence(sentence);
      if (!text) continue;
      const features = featureSet(text, 256);
      const lexical = weightedJaccard(claimFeatures, features);
      const trust = span.status === "promoted" ? 1 : 0.55;
      const score = clamp01(0.22 * lexical + 0.2 * span.alpha + 0.16 * spanMass + 0.14 * trust + 0.16 * namedSurfaceMass(text) + 0.22 * collectionListSignal(text) - longSentencePenalty(text));
      out.push({ evidenceId: String(span.id), source: "evidence", score, lcb: clamp01(0.55 * lexical + 0.45 * span.alpha), features, textHash: hashText(text) });
    }
  }
  return out;
}

function selectDiverse(candidates: readonly EvidenceCandidate[], maxSentences: number): EvidenceCandidate[] {
  const selected: EvidenceCandidate[] = [];
  for (const candidate of candidates) {
    if (selected.length >= maxSentences) break;
    const redundant = selected.some(item => weightedJaccard(item.features, candidate.features) > 0.82 || item.textHash === candidate.textHash);
    if (!redundant && candidate.score >= 0.08) selected.push(candidate);
  }
  return selected.length ? selected : candidates.slice(0, maxSentences);
}

function splitSentences(text: string): string[] {
  const raw = splitSurfaceSentences(text);
  const merged: string[] = [];
  for (const sentence of raw) {
    const previous = merged[merged.length - 1];
    if (previous && previous.length <= 3 && previous.endsWith(".")) {
      merged[merged.length - 1] = `${previous} ${sentence}`;
    } else {
      merged.push(sentence);
    }
  }
  return merged;
}

function cleanSentence(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 900);
}

function namedSurfaceMass(text: string): number {
  const runs = surfaceEntityRuns(text);
  const parentheticalRuns = (text.match(/\([^)]{2,100}\)/gu) ?? []).filter(item => surfaceEntityRuns(item).length > 0).length;
  return clamp01(Math.min(1, runs.length / 16) * 0.38 + Math.min(1, parentheticalRuns / 4) * 0.62);
}

function collectionListSignal(text: string): number {
  const compact = cleanSentence(text);
  const parentheticals = (compact.match(/\([^)]{2,100}\)/gu) ?? []).filter(item => surfaceEntityRuns(item).length > 0).length;
  const nameRuns = surfaceEntityRuns(compact);
  const delimiters = (compact.match(/[,;:]/gu) ?? []).length;
  return clamp01(Math.min(1, nameRuns.length / 7) * 0.45 + Math.min(1, parentheticals / 4) * 0.35 + Math.min(1, delimiters / 8) * 0.2);
}

function compactMemberListSignal(text: string): number {
  const compact = cleanSentence(text);
  const parentheticals = (compact.match(/\([^)]{2,100}\)/gu) ?? []).filter(item => surfaceEntityRuns(item).length > 0).length;
  const nameRuns = surfaceEntityRuns(compact);
  const separators = (compact.match(/[,;]/gu) ?? []).length;
  if (parentheticals < 2 || nameRuns.length < 3) return 0;
  return clamp01(0.5 + Math.min(0.3, parentheticals / 10) + Math.min(0.2, separators / 12));
}

function requestAnchorSignal(requestText: string, text: string): number {
  const surface = normalizeAnchorSurface(text);
  if (!surface) return 0;
  const surfaceUnits = surface.split(" ").filter(Boolean);
  let best = 0;
  for (const anchor of namedSurfaceAnchors(requestText)) {
    const anchorUnits = anchor.split(" ").filter(Boolean);
    if (!anchorUnits.length || !anchorPhraseAppears(surfaceUnits, anchorUnits)) continue;
    best = Math.max(best, anchorPhraseAppears(surfaceUnits.slice(0, anchorUnits.length), anchorUnits) ? 1 : 0.78);
  }
  return best;
}

function namedSurfaceAnchors(text: string): string[] {
  const runs = surfaceEntityRuns(text);
  return [...new Set(runs.map(normalizeAnchorSurface).filter(anchor => anchor.split(" ").length >= 2))]
    .sort((left, right) => right.length - left.length)
    .slice(0, 8);
}

function normalizeAnchorSurface(text: string): string {
  return text
    .toLocaleLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function anchorPhraseAppears(surfaceUnits: readonly string[], anchorUnits: readonly string[]): boolean {
  if (!surfaceUnits.length || !anchorUnits.length || anchorUnits.length > surfaceUnits.length) return false;
  for (let index = 0; index <= surfaceUnits.length - anchorUnits.length; index++) {
    if (anchorUnits.every((unit, offset) => surfaceUnits[index + offset] === unit)) return true;
  }
  return false;
}

function longSentencePenalty(text: string): number {
  return clamp01(Math.max(0, text.length - 560) / 1600) * 0.18;
}

function hashText(text: string): string {
  if (!text) return "0";
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

function usableAnswerSurface(text: string): string {
  const clean = sourceTextSurface(text, 1400);
  if (!clean) return "";
  const lower = clean.toLocaleLowerCase();
  if (clean.startsWith("{") && lower.includes("schema")) return "";
  if (lower.includes("scce.surface.realizer") || lower.includes("scce.surface.candidate")) return "";
  if (lower.includes("surface.point=") || lower.includes("surface.limit=") || lower.includes("proof_")) return "";
  return ensureSentence(clean);
}

function evidenceAnswerSurface(requestText: string, evidence: readonly EvidenceSpan[], maxSentences: number): string {
  const requestFeatures = featureSet(requestText, 256);
  const sentences = evidence
    .filter(span => span.status === "promoted")
    .flatMap(span => splitSentences(sourceTextSurface(span.text || span.textPreview, 24000)).slice(0, 80).map(text => ({
      text,
      evidenceId: String(span.id),
      compactMemberList: compactMemberListSignal(text),
      anchorSignal: requestAnchorSignal(requestText, text),
      score: weightedJaccard(requestFeatures, featureSet(text, 128)) + span.alpha * 0.14 + namedSurfaceMass(text) * 0.26 + collectionListSignal(text) * 0.42 + compactMemberListSignal(text) * 0.36 + requestAnchorSignal(requestText, text) * 0.48 - longSentencePenalty(text)
    })))
    .filter(row => cleanSentence(row.text))
    .sort((a, b) => b.score - a.score || a.evidenceId.localeCompare(b.evidenceId));
  const compactMemberList = sentences.find(row => row.compactMemberList >= 0.62);
  if (compactMemberList) return ensureSentence(compactMemberList.text);
  const anchoredLead = sentences.find(row => row.anchorSignal >= 0.78 && cleanSentence(row.text).length >= 72);
  if (anchoredLead) return ensureSentence(anchoredLead.text);
  const selected: string[] = [];
  for (const row of sentences) {
    if (selected.length >= maxSentences) break;
    const text = cleanSentence(row.text);
    if (selected.some(existing => weightedJaccard(featureSet(existing, 128), featureSet(text, 128)) > 0.9)) continue;
    selected.push(text);
  }
  return selected.length ? selected.map(ensureSentence).join(" ") : "";
}

function ensureSentence(text: string): string {
  return ensureSurfaceSentence(cleanSentence(text));
}

function surfaceEntityRuns(text: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length >= 2 || current.some(hasUncasedNonLatinLetter)) out.push(current.join(" "));
    current = [];
  };
  for (const word of surfaceWords(text)) {
    const entityish = hasUppercaseLetter(word) || hasUncasedNonLatinLetter(word);
    if (entityish) {
      current.push(word);
      continue;
    }
    flush();
  }
  flush();
  return [...new Set(out)].slice(0, 32);
}
