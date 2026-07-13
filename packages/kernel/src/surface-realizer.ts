import type { EvidenceSpan, JsonValue, SemanticEntailmentResult } from "./types.js";
import type { CcrResult } from "./ccr.js";
import type { NgramModelRecord } from "./storage.js";
import type { LanguageMemoryRuntime, LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { createLanguageMemoryRuntime } from "./language-memory-runtime.js";
import { canonicalStringify, clamp01, featureSet, sourceTextSurface, toJsonValue, weightedJaccard } from "./primitives.js";
import { ensureSurfaceSentence, splitSurfaceSentences } from "./surface-linguistics.js";

export interface SurfaceRealizerCandidate {
  text: string;
  role: "lead" | "point" | "limit" | "unknown" | "contradiction";
  evidenceIds: string[];
  source: "obligation" | "evidence" | "ccr" | "boundary" | "counterexample" | "surface.profile_absence";
  fit: number;
}

export interface SurfaceRealizerResult {
  text: string;
  evidenceIds: string[];
  audit: JsonValue;
}

export interface SurfaceRealizerInput {
  requestText: string;
  entailment: SemanticEntailmentResult;
  evidence: readonly EvidenceSpan[];
  ccr?: CcrResult;
  ngramModels?: readonly NgramModelRecord[];
  languageMemory?: LanguageMemoryRuntimeState;
  maxPoints?: number;
  locale?: string;
}

export function createSurfaceRealizer() {
  return {
    realize(input: SurfaceRealizerInput): SurfaceRealizerResult {
      const languageRuntime = createLanguageMemoryRuntime();
      const languageMemory = input.languageMemory ?? languageRuntime.hydrate({ models: input.ngramModels ?? [] });
      const contextFeatures = [
        ...featureSet(input.requestText, 512),
        ...input.entailment.claim.features.slice(0, 256),
        ...input.evidence.flatMap(span => span.features.slice(0, 16))
      ];
      const contextText = [input.requestText, input.entailment.claim.text, ...input.evidence.slice(0, 12).map(span => evidenceSurfaceText(span, 1200))].join("\n").slice(0, 12000);
      const lead = chooseSurface(leadCandidates(input), contextFeatures, languageRuntime, languageMemory, contextText, input.locale);
      const points = chooseDiverseSurfaces(materialPointCandidates(input), contextFeatures, languageRuntime, languageMemory, contextText, input.maxPoints ?? 5);
      const limits = chooseDiverseSurfaces(limitCandidates(input), contextFeatures, languageRuntime, languageMemory, contextText, 3);
      const evidenceIds = [...new Set([...points.flatMap(item => item.evidenceIds), ...lead.evidenceIds])];
      const answerLines = renderAnswer({
        lead,
        points,
        limits,
        evidence: input.evidence.filter(span => evidenceIds.includes(String(span.id))).slice(0, 6),
        force: input.entailment.force,
        verdict: input.entailment.semanticVerdict,
        locale: input.locale
      });
      return {
        text: answerLines,
        evidenceIds,
        audit: toJsonValue({
          source: "learned-surface-realizer",
          languageMemory: languageMemory.audit,
          selectedLead: scoredSurface(lead, contextFeatures, languageRuntime, languageMemory, contextText),
          selectedPoints: points.map(point => scoredSurface(point, contextFeatures, languageRuntime, languageMemory, contextText)),
          selectedLimits: limits.map(limit => scoredSurface(limit, contextFeatures, languageRuntime, languageMemory, contextText)),
          formula: "A_ngram(x,F)=sum_n omega_n(F)*exp(-I_n(x|h))*fit_n(x,F)"
        })
      };
    }
  };
}

function leadCandidates(input: SurfaceRealizerInput): SurfaceRealizerCandidate[] {
  const support = input.entailment.support;
  const contradiction = input.entailment.contradiction;
  const claim = compactClaim(input.entailment.claim.text);
  const evidenceLead = compactClaim(input.evidence[0] ? evidenceSurfaceText(input.evidence[0], 480) : claim);
  if (input.entailment.semanticVerdict === "contradicted") return [
    candidate(claim || surfaceRecord({ kind: "surface.verdict.contradicted", proofId: input.entailment.proof.id }), "contradiction", [], "counterexample", 0.9),
    candidate(evidenceLead || surfaceRecord({ kind: "surface.counterexample.absent", proofId: input.entailment.proof.id }), "contradiction", input.entailment.evidenceIds.map(String), "counterexample", 0.82)
  ];
  if (input.evidence.length && evidenceLead) return [
    candidate(evidenceLead, "lead", [String(input.evidence[0]!.id)], "evidence", clamp01(0.62 + support * 0.24 - contradiction * 0.12)),
    candidate(claim || evidenceLead, "lead", input.entailment.evidenceIds.map(String), "obligation", 0.58)
  ];
  if (input.entailment.semanticVerdict === "unknown" || support < 0.12) return [
    candidate(claim || surfaceRecord({ kind: "surface.verdict.unknown", proofId: input.entailment.proof.id }), "unknown", [], "surface.profile_absence", 0.86),
    candidate(surfaceRecord({ kind: "surface.evidence.absent", proofId: input.entailment.proof.id, support }), "unknown", [], "surface.profile_absence", 0.72)
  ];
  if (input.entailment.semanticVerdict === "underdetermined") return [
    candidate(claim || surfaceRecord({ kind: "surface.verdict.underdetermined", proofId: input.entailment.proof.id }), "lead", [], "obligation", 0.78),
    candidate(evidenceLead || surfaceRecord({ kind: "surface.evidence.partial", proofId: input.entailment.proof.id }), "lead", input.entailment.evidenceIds.map(String), "obligation", 0.72)
  ];
  return [
    candidate(evidenceLead || claim || surfaceRecord({ kind: "surface.verdict.grounded", proofId: input.entailment.proof.id }), "lead", input.entailment.evidenceIds.map(String), "obligation", clamp01(0.58 + support * 0.36 - contradiction * 0.2)),
    candidate(claim || evidenceLead || surfaceRecord({ kind: "surface.claim.bound", proofId: input.entailment.proof.id }), "lead", input.entailment.evidenceIds.map(String), "obligation", 0.68)
  ];
}

function materialPointCandidates(input: SurfaceRealizerInput): SurfaceRealizerCandidate[] {
  const out: SurfaceRealizerCandidate[] = [];
  for (const obligation of input.entailment.obligations.filter(item => item.status === "satisfied" && item.required).slice(0, 10)) {
    const text = obligationPoint(obligation.claimText, obligation.kind, input.locale);
    if (text) out.push(candidate(text, "point", obligation.evidenceIds.map(String), "obligation", clamp01(0.45 + obligation.support * 0.5 - obligation.contradiction * 0.5)));
  }
  for (const trace of input.entailment.counterexamples.slice(0, 6)) {
    out.push(candidate(compactClaim(trace.claimText) || surfaceRecord({ kind: "surface.counterexample", proofId: input.entailment.proof.id }), "contradiction", trace.evidenceIds.map(String), "counterexample", clamp01(0.55 + trace.contradiction * 0.4)));
  }
  const evidenceById = new Map(input.evidence.map(span => [String(span.id), span]));
  const preferredEvidence = input.entailment.evidenceIds.map(id => evidenceById.get(String(id))).filter((span): span is EvidenceSpan => Boolean(span));
  for (const span of (preferredEvidence.length ? preferredEvidence : input.evidence).slice(0, 8)) {
    const sentence = bestEvidenceSentence(span, input.requestText);
    const paraphrase = paraphraseEvidence(sentence, input.requestText);
    if (paraphrase) out.push(candidate(paraphrase, "point", [String(span.id)], "evidence", clamp01(0.35 + span.alpha * 0.35 + (span.status === "promoted" ? 0.2 : 0.05))));
  }
  for (const sentence of input.ccr?.l3.sentences.slice(0, 6) ?? []) {
    const paraphrase = paraphraseEvidence(sentence.text, input.requestText);
    if (paraphrase) out.push(candidate(paraphrase, "point", sentence.evidenceIds.map(String), "ccr", clamp01(0.4 + sentence.lcb * 0.5)));
  }
  if (!out.length && input.entailment.semanticVerdict !== "contradicted") {
    out.push(candidate(surfaceRecord({ kind: "surface.verdict", verdict: input.entailment.semanticVerdict, proofId: input.entailment.proof.id }), "point", input.entailment.evidenceIds.map(String), "surface.profile_absence", 0.25));
  }
  return out;
}

function limitCandidates(input: SurfaceRealizerInput): SurfaceRealizerCandidate[] {
  const out: SurfaceRealizerCandidate[] = [];
  for (const missing of input.entailment.missing.slice(0, 4)) {
    out.push(candidate(surfaceRecord({ kind: "surface.limit.missing", missingKind: missing.kind, claim: compactClaim(missing.claimText) }), "limit", missing.evidenceIds.map(String), "boundary", 0.72));
  }
  for (const boundary of input.entailment.boundaries.filter(item => !item.startsWith("underdetermined-obligations:")).slice(0, 4)) {
    out.push(candidate(readableBoundary(boundary), "limit", [], "boundary", 0.5));
  }
  return out.filter(item => item.text.trim().length > 0);
}

function renderAnswer(input: {
  lead: SurfaceRealizerCandidate;
  points: SurfaceRealizerCandidate[];
  limits: SurfaceRealizerCandidate[];
  evidence: readonly EvidenceSpan[];
  force: SemanticEntailmentResult["force"];
  verdict: SemanticEntailmentResult["semanticVerdict"];
  locale?: string;
}): string {
  const points = input.points.map(point => normalizeSentence(point.text));
  const limits = input.limits.map(limit => normalizeSentence(limit.text));
  const lines = [
    normalizeSentence(input.lead.text),
    ...points,
    ...limits
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

function chooseDiverseSurfaces(
  candidates: SurfaceRealizerCandidate[],
  contextFeatures: readonly string[],
  languageRuntime: LanguageMemoryRuntime,
  languageMemory: LanguageMemoryRuntimeState,
  contextText: string,
  limit: number
): SurfaceRealizerCandidate[] {
  const sorted = candidates
    .map(item => ({ item, score: scoreSurface(item, contextFeatures, languageRuntime, languageMemory, contextText) }))
    .sort((a, b) => b.score.total - a.score.total || a.item.text.localeCompare(b.item.text));
  const selected: SurfaceRealizerCandidate[] = [];
  for (const row of sorted) {
    if (selected.length >= limit) break;
    const features = featureSet(row.item.text, 128);
    if (selected.some(item => weightedJaccard(features, featureSet(item.text, 128)) > 0.78)) continue;
    selected.push(row.item);
  }
  return selected;
}

function chooseSurface(
  candidates: SurfaceRealizerCandidate[],
  contextFeatures: readonly string[],
  languageRuntime: LanguageMemoryRuntime,
  languageMemory: LanguageMemoryRuntimeState,
  contextText: string,
  locale?: string
): SurfaceRealizerCandidate {
  return candidates
    .map(item => ({ item, score: scoreSurface(item, contextFeatures, languageRuntime, languageMemory, contextText) }))
    .sort((a, b) => b.score.total - a.score.total || a.item.text.localeCompare(b.item.text))[0]?.item ?? candidates[0] ?? candidate(surfaceRecord({ kind: "surface.empty", locale: locale ?? null }), "unknown", [], "surface.profile_absence", 0);
}

function scoredSurface(
  candidate: SurfaceRealizerCandidate,
  contextFeatures: readonly string[],
  languageRuntime: LanguageMemoryRuntime,
  languageMemory: LanguageMemoryRuntimeState,
  contextText: string
): JsonValue {
  return toJsonValue({ textHash: hashText(candidate.text), role: candidate.role, source: candidate.source, evidenceIds: candidate.evidenceIds, ...scoreSurface(candidate, contextFeatures, languageRuntime, languageMemory, contextText) });
}

function scoreSurface(
  candidate: SurfaceRealizerCandidate,
  contextFeatures: readonly string[],
  languageRuntime: LanguageMemoryRuntime,
  languageMemory: LanguageMemoryRuntimeState,
  contextText: string
): { total: number; fit: number; ngramActivation: number; information: number } {
  const features = featureSet(candidate.text, 256);
  const fit = clamp01(0.55 * weightedJaccard(features, contextFeatures) + 0.45 * candidate.fit);
  const memory = languageRuntime.score({ state: languageMemory, text: candidate.text, contextText });
  const ngramActivation = languageMemory.models.length ? memory.activation : 0.35;
  const information = languageMemory.models.length ? memory.information : 1;
  return { total: clamp01(0.58 * fit + 0.32 * ngramActivation + 0.1 * candidate.fit), fit, ngramActivation, information };
}

function obligationPoint(text: string, kind: string, locale?: string): string {
  void locale;
  const compact = compactClaim(text);
  if (!compact) return "";
  if (kind === "source_version") return surfaceRecord({ kind: "surface.obligation.source_version" });
  return compact;
}

function paraphraseEvidence(sentence: string, requestText: string): string {
  const clean = normalizeSentence(sourceTextSurface(sentence, 900)).replace(/\[[^\]]+\]|\([^)]{0,80}\)/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean) return "";
  if (sameSurfaceForRelevance(clean, requestText)) return "";
  if (!evidenceRelevantToRequest(clean, requestText)) return "";
  return compactClaim(clean);
}

function evidenceRelevantToRequest(sentence: string, requestText: string): boolean {
  const requestUnits = relevanceUnits(requestText);
  if (!requestUnits.length) return true;
  const sentenceUnits = relevanceUnits(sentence);
  if (!sentenceUnits.length) return false;
  if (weightedJaccard(sentenceUnits, requestUnits) >= 0.12) return true;
  const requestFeatures = relevanceFeatures(requestText);
  const sentenceFeatures = relevanceFeatures(sentence);
  return weightedJaccard(sentenceFeatures, requestFeatures) >= 0.08 && sentenceUnits.some(unit => requestUnits.includes(unit));
}

function relevanceFeatures(text: string): string[] {
  return featureSet(text, 256).filter(feature => !feature.startsWith("char:"));
}

function relevanceUnits(text: string): string[] {
  const units = sourceTextSurface(text, 900).normalize("NFKC").match(/[\p{Letter}\p{Number}_]+/gu) ?? [];
  return [...new Set(units
    .map(unit => unit.toLocaleLowerCase())
    .filter(unit => unit.length >= 4 || /\p{Number}/u.test(unit) || /[^\p{Script=Latin}\p{Number}_]/u.test(unit)))];
}

function sameSurfaceForRelevance(left: string, right: string): boolean {
  const normalize = (text: string) => relevanceUnits(text).join(" ");
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a === b);
}

function bestEvidenceSentence(span: EvidenceSpan, requestText: string): string {
  const requestFeatures = featureSet(requestText, 256);
  const text = evidenceSurfaceText(span, 1800);
  return splitSentences(text)
    .map(text => ({ text, score: weightedJaccard(featureSet(text, 128), requestFeatures) + Math.min(0.2, text.length / 1000) }))
    .sort((a, b) => b.score - a.score)[0]?.text ?? text;
}

function compactClaim(text: string): string {
  return normalizeSentence(sourceTextSurface(text, 600))
    .replace(/\s+/gu, " ")
    .slice(0, 240)
    .replace(/[,;:\s]+$/u, "");
}

function readableBoundary(boundary: string): string {
  return boundary.replace(/\s+/gu, " ").trim();
}

function normalizeSentence(text: string): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  if (!clean) return "";
  const capped = clean.length > 480 ? `${clean.slice(0, 477).replace(/\s+\S*$/u, "")}...` : clean;
  return ensureSurfaceSentence(capped);
}

function splitSentences(text: string): string[] {
  return splitSurfaceSentences(text);
}

function evidenceSurfaceText(span: EvidenceSpan, maxChars: number): string {
  return sourceTextSurface(span.textPreview || span.text || "", maxChars);
}

function candidate(text: string, role: SurfaceRealizerCandidate["role"], evidenceIds: string[], source: SurfaceRealizerCandidate["source"], fit: number): SurfaceRealizerCandidate {
  return { text, role, evidenceIds, source, fit: clamp01(fit) };
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

function surfaceRecord(value: JsonValue): string {
  return canonicalStringify({ schema: "scce.surface.realizer.v1", value });
}
