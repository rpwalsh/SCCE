import type { EpistemicForce, EvidenceId, EvidenceSpan, JsonValue, TruthState } from "./types.js";
import { truthStateFromProofVerdict } from "./truth-contract.js";
import type { SemanticProofEngineVerdict } from "./semantic-proof-engine.js";
import { featureSet, toJsonValue, symbolizeData, weightedJaccard } from "./primitives.js";

export type PcaCertificateKind = "direct_quote" | "paraphrase" | "inference" | "rejected";
export type PcaRule = "quote" | "levenshtein" | "R1_conjunction" | "R2_specialization" | "R3_transitivity" | "R4_contrapositive" | "boundary";

export interface PcaDerivationStep {
  rule: PcaRule;
  premises: string[];
  conclusion: string;
  score: number;
  note: string;
}

export interface PcaCertificate {
  sentence: string;
  kind: PcaCertificateKind;
  steps: PcaDerivationStep[];
  paraphraseRatio?: number;
  citedSpanIds: EvidenceId[];
  unsupportedSymbolRatio: number;
  rejectReason?: "empty" | "no_admissible_derivation" | "unsupported_introduction";
}

export interface PcaReport {
  certificates: PcaCertificate[];
  admitted: PcaCertificate[];
  rejected: PcaCertificate[];
  supportedSentences: number;
  totalSentences: number;
  grounding: "high" | "medium" | "low" | "none";
  unsupportedSymbolRatio: number;
  releaseAnswer: string;
  truthState?: TruthState;
  audit: JsonValue;
}

export interface ProofCarryingAnswerConfig {
  paraphraseMaxRatio: number;
  minSpanLength: number;
  conjunctionJaccard: number;
  specializationCoverage: number;
  specializationJaccard: number;
  transitivitySharedMiddle: number;
  transitivityTargetJaccard: number;
  unsupportedSymbolCeiling: number;
}

const DEFAULT_PCA: ProofCarryingAnswerConfig = {
  paraphraseMaxRatio: 0.35,
  minSpanLength: 16,
  conjunctionJaccard: 0.65,
  specializationCoverage: 0.7,
  specializationJaccard: 0.5,
  transitivitySharedMiddle: 0.3,
  transitivityTargetJaccard: 0.55,
  unsupportedSymbolCeiling: 0.38
};

export function createProofCarryingAnswer(config: Partial<ProofCarryingAnswerConfig> = {}) {
  const cfg = { ...DEFAULT_PCA, ...config };
  return {
    certify(input: { answer: string; evidence: EvidenceSpan[]; force: EpistemicForce }): PcaReport {
      const sentences = splitSentences(input.answer);
      const atoms = evidenceAtoms(input.evidence, cfg);
      const certificates = sentences.map(sentence => certifySentence(sentence, atoms, input.force, cfg));
      const admitted = certificates.filter(cert => cert.kind !== "rejected");
      const rejected = certificates.filter(cert => cert.kind === "rejected");
      const quoteLike = admitted.filter(cert => cert.kind === "direct_quote" || cert.kind === "paraphrase").length;
      const grounding = admitted.length === 0
        ? "none"
        : rejected.length > 0
          ? "low"
          : quoteLike / admitted.length >= 0.6
            ? "high"
            : "medium";
      const unsupportedSymbolRatio = certificates.length
        ? certificates.reduce((sum, cert) => sum + cert.unsupportedSymbolRatio, 0) / certificates.length
        : 0;
      const releaseAnswer = releaseText(input.answer, certificates, input.force);
      const derivedVerdict: SemanticProofEngineVerdict = admitted.length === 0
        ? "insufficient_evidence"
        : grounding === "high" ? "certified"
        : grounding === "none" ? "unsupported_prior_only"
        : "source_bound_only";
      return {
        certificates,
        admitted,
        rejected,
        supportedSentences: admitted.length,
        totalSentences: certificates.length,
        grounding,
        unsupportedSymbolRatio,
        releaseAnswer,
        truthState: truthStateFromProofVerdict(derivedVerdict),
        audit: toJsonValue({
          supportedSentences: admitted.length,
          totalSentences: certificates.length,
          grounding,
          unsupportedSymbolRatio,
          rejected: rejected.map(cert => ({ sentence: cert.sentence.slice(0, 160), reason: cert.rejectReason, unsupportedSymbolRatio: cert.unsupportedSymbolRatio })),
          citedSpanIds: [...new Set(admitted.flatMap(cert => cert.citedSpanIds.map(String)))]
        })
      };
    }
  };
}

interface EvidenceAtom {
  span: EvidenceSpan;
  segment: string;
  normalized: string;
  symbols: Set<string>;
  features: string[];
}

function certifySentence(sentence: string, atoms: EvidenceAtom[], force: EpistemicForce, cfg: ProofCarryingAnswerConfig): PcaCertificate {
  const normalized = normalizeSentence(sentence);
  if (!normalized) return rejected(sentence, "empty", 1);

  const quote = atoms.find(atom => atom.normalized.includes(normalized));
  if (quote) {
    return {
      sentence,
      kind: "direct_quote",
      steps: [{ rule: "quote", premises: [String(quote.span.id)], conclusion: sentence, score: 1, note: "pca.note.quote_contained_in_evidence_segment" }],
      citedSpanIds: [quote.span.id],
      unsupportedSymbolRatio: 0
    };
  }

  const paraphrase = bestParaphrase(normalized, atoms, cfg);
  if (paraphrase && paraphrase.ratio <= cfg.paraphraseMaxRatio) {
    return {
      sentence,
      kind: "paraphrase",
      steps: [{ rule: "levenshtein", premises: [String(paraphrase.atom.span.id)], conclusion: sentence, score: 1 - paraphrase.ratio, note: `pca.note.edit_ratio:${paraphrase.ratio.toFixed(3)}` }],
      paraphraseRatio: paraphrase.ratio,
      citedSpanIds: [paraphrase.atom.span.id],
      unsupportedSymbolRatio: unsupportedRatio(symbolSet(normalized), [paraphrase.atom.symbols])
    };
  }

  const inference = infer(sentence, atoms, cfg);
  if (inference) return inference;

  const target = symbolSet(normalized);
  const globalCoverage = atoms.length ? unsupportedRatio(target, atoms.slice(0, 24).map(atom => atom.symbols)) : 1;
  if ((force === "invented" || force === "conjectured") && globalCoverage <= cfg.unsupportedSymbolCeiling) {
    const cited = bestAtomsForTarget(target, atoms, 2);
    return {
      sentence,
      kind: "inference",
      steps: [{ rule: "boundary", premises: cited.map(atom => String(atom.span.id)), conclusion: sentence, score: 1 - globalCoverage, note: "pca.note.bounded_conjecture_inside_proof_boundary" }],
      citedSpanIds: cited.map(atom => atom.span.id),
      unsupportedSymbolRatio: globalCoverage
    };
  }

  return rejected(sentence, globalCoverage > cfg.unsupportedSymbolCeiling ? "unsupported_introduction" : "no_admissible_derivation", globalCoverage);
}

function infer(sentence: string, atoms: EvidenceAtom[], cfg: ProofCarryingAnswerConfig): PcaCertificate | undefined {
  const target = symbolSet(normalizeSentence(sentence));
  if (target.size === 0) return undefined;
  const ranked = bestAtomsForTarget(target, atoms, 12);

  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i]!;
      const b = ranked[j]!;
      const union = unionSet(a.symbols, b.symbols);
      const scoreA = jaccard(target, a.symbols);
      const scoreB = jaccard(target, b.symbols);
      const unionScore = jaccard(target, union);
      const unsupported = unsupportedRatio(target, [a.symbols, b.symbols]);
      if (scoreA >= 0.25 && scoreB >= 0.25 && unionScore >= cfg.conjunctionJaccard && unsupported <= cfg.unsupportedSymbolCeiling) {
        return {
          sentence,
          kind: "inference",
          steps: [{ rule: "R1_conjunction", premises: [String(a.span.id), String(b.span.id)], conclusion: sentence, score: unionScore, note: "pca.note.conjunction_covers_target" }],
          citedSpanIds: [a.span.id, b.span.id],
          unsupportedSymbolRatio: unsupported
        };
      }
    }
  }

  for (const atom of ranked) {
    const jac = jaccard(target, atom.symbols);
    const coverage = coverageOf(target, atom.symbols);
    const unsupported = unsupportedRatio(target, [atom.symbols]);
    if (jac >= cfg.specializationJaccard && coverage >= cfg.specializationCoverage && unsupported <= cfg.unsupportedSymbolCeiling) {
      return {
        sentence,
        kind: "inference",
        steps: [{ rule: "R2_specialization", premises: [String(atom.span.id)], conclusion: sentence, score: Math.min(jac, coverage), note: "pca.note.specialization_covers_target" }],
        citedSpanIds: [atom.span.id],
        unsupportedSymbolRatio: unsupported
      };
    }
  }

  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i]!;
      const b = ranked[j]!;
      const middle = jaccard(a.symbols, b.symbols);
      const targetFit = jaccard(target, unionSet(a.symbols, b.symbols));
      const unsupported = unsupportedRatio(target, [a.symbols, b.symbols]);
      if (middle >= cfg.transitivitySharedMiddle && targetFit >= cfg.transitivityTargetJaccard && unsupported <= cfg.unsupportedSymbolCeiling) {
        return {
          sentence,
          kind: "inference",
          steps: [{ rule: "R3_transitivity", premises: [String(a.span.id), String(b.span.id)], conclusion: sentence, score: Math.min(middle, targetFit), note: "pca.note.transitivity_covers_target" }],
          citedSpanIds: [a.span.id, b.span.id],
          unsupportedSymbolRatio: unsupported
        };
      }
    }
  }

  return undefined;
}

function evidenceAtoms(evidence: EvidenceSpan[], cfg: ProofCarryingAnswerConfig): EvidenceAtom[] {
  const atoms: EvidenceAtom[] = [];
  for (const span of evidence) {
    for (const segment of splitSentences(span.text || span.textPreview).slice(0, 80)) {
      const normalized = normalizeSentence(segment);
      if (normalized.length < cfg.minSpanLength) continue;
      atoms.push({ span, segment, normalized, symbols: symbolSet(normalized), features: featureSet(normalized, 512) });
    }
    if (!atoms.some(atom => atom.span.id === span.id)) {
      const normalized = normalizeSentence(span.textPreview || span.text);
      if (normalized.length >= cfg.minSpanLength) atoms.push({ span, segment: span.textPreview || span.text, normalized, symbols: symbolSet(normalized), features: span.features });
    }
  }
  return atoms.sort((a, b) => b.span.alpha - a.span.alpha);
}

function bestParaphrase(normalized: string, atoms: EvidenceAtom[], cfg: ProofCarryingAnswerConfig): { atom: EvidenceAtom; ratio: number } | undefined {
  let best: { atom: EvidenceAtom; ratio: number } | undefined;
  for (const atom of atoms) {
    if (atom.normalized.length < cfg.minSpanLength) continue;
    const denominator = Math.max(cfg.minSpanLength, Math.max(normalized.length, atom.normalized.length));
    const ratio = levenshtein(normalized, atom.normalized) / denominator;
    if (!best || ratio < best.ratio) best = { atom, ratio };
  }
  return best;
}

function releaseText(original: string, certificates: PcaCertificate[], force: EpistemicForce): string {
  if (force === "invented" || force === "conjectured") return original;
  const admitted = certificates.filter(cert => cert.kind !== "rejected").map(cert => cert.sentence.trim()).filter(Boolean);
  if (admitted.length === certificates.length) return original;
  if (admitted.length === 0) return original;
  return admitted.join(" ");
}

function splitSentences(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const parts = normalized.split(/(?<=[.!?])\s+|\n{2,}/u).map(part => part.trim()).filter(Boolean);
  return parts.length ? parts : [normalized];
}

function normalizeSentence(text: string): string {
  return symbolizeData(text).join(" ").replace(/\s+/g, " ").trim();
}

function symbolSet(text: string): Set<string> {
  return new Set(symbolizeData(text).filter(symbol => /[\p{Letter}\p{Number}_]/u.test(symbol)));
}

function bestAtomsForTarget(target: Set<string>, atoms: EvidenceAtom[], limit: number): EvidenceAtom[] {
  return [...atoms]
    .map(atom => ({ atom, score: 0.55 * jaccard(target, atom.symbols) + 0.25 * coverageOf(target, atom.symbols) + 0.2 * weightedJaccard([...target], atom.features) * atom.span.alpha }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(item => item.atom);
}

function rejected(sentence: string, reason: PcaCertificate["rejectReason"], unsupportedSymbolRatio: number): PcaCertificate {
  return { sentence, kind: "rejected", steps: [], citedSpanIds: [], unsupportedSymbolRatio, rejectReason: reason };
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const symbol of a) if (b.has(symbol)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function coverageOf(target: Set<string>, evidence: Set<string>): number {
  if (target.size === 0) return 0;
  let covered = 0;
  for (const symbol of target) if (evidence.has(symbol)) covered++;
  return covered / target.size;
}

function unsupportedRatio(target: Set<string>, atoms: Array<Set<string>>): number {
  if (target.size === 0) return 0;
  const support = new Set<string>();
  for (const atom of atoms) for (const symbol of atom) support.add(symbol);
  let unsupported = 0;
  for (const symbol of target) if (!support.has(symbol)) unsupported++;
  return unsupported / target.size;
}

function unionSet(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set(a);
  for (const symbol of b) out.add(symbol);
  return out;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min((curr[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}
