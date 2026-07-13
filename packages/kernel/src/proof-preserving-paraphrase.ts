import { canonicalStringify, toJsonValue } from "./primitives.js";
import type { DialogueAnswerGraphLike } from "./dialogue-pragmatics.js";
import type { JsonValue } from "./types.js";

export interface PreservationConstraints {
  protectedSpans: readonly string[];
  requireNegationPreservation: boolean;
  requireUncertaintyPreservation: boolean;
  requireContradictionPreservation: boolean;
}

export interface ParaphraseVariantCheck {
  variantId: string;
  valid: boolean;
  missingProtectedSpans: string[];
  droppedNegation: boolean;
  upgradedUncertainty: boolean;
  droppedContradiction: boolean;
  unsupportedContent: boolean;
}

export interface ProofPreservingParaphraseReport {
  schema: "scce.proof_preserving_paraphrase.report.v1";
  id: string;
  answerGraphId: string;
  protectedSpans: string[];
  checks: ParaphraseVariantCheck[];
  protectedSpanFailureRate: number;
  unsupportedContentRate: number;
  passed: boolean;
  trace: JsonValue;
}

export function preservationConstraintsFromGraph(answerGraph: DialogueAnswerGraphLike): PreservationConstraints {
  const sourceText = [
    ...answerGraph.claims.map(claim => claim.surface),
    ...answerGraph.caveats.map(caveat => caveat.text),
    ...answerGraph.actions.flatMap(action => action.affectedFiles)
  ].join("\n");
  return {
    protectedSpans: uniqueStrings([
      ...extractProtectedSpans(sourceText),
      ...answerGraph.actions.flatMap(action => action.affectedFiles),
      ...answerGraph.supportLinks.map(link => link.sourceRef?.path ?? "").filter(Boolean)
    ]),
    requireNegationPreservation: hasNegation(sourceText),
    requireUncertaintyPreservation: answerGraph.uncertainty.unsupported || answerGraph.uncertainty.missingEvidenceCount > 0 || hasUncertainty(sourceText),
    requireContradictionPreservation: answerGraph.uncertainty.contradictionCount > 0
  };
}

export function verifyProofPreservingParaphrases(input: {
  answerGraph: DialogueAnswerGraphLike;
  variants: readonly string[];
  constraints?: PreservationConstraints;
}): ProofPreservingParaphraseReport {
  const constraints = input.constraints ?? preservationConstraintsFromGraph(input.answerGraph);
  const checks = input.variants.map((variant, index) => checkVariant(`variant.${index}`, variant, constraints));
  const protectedSpanFailures = checks.filter(check => check.missingProtectedSpans.length > 0).length;
  const unsupportedFailures = checks.filter(check => check.unsupportedContent).length;
  return {
    schema: "scce.proof_preserving_paraphrase.report.v1",
    id: `proof_paraphrase.${hashText(canonicalStringify({ graph: input.answerGraph.id, variants: input.variants, constraints }))}`,
    answerGraphId: input.answerGraph.id,
    protectedSpans: [...constraints.protectedSpans],
    checks,
    protectedSpanFailureRate: checks.length ? protectedSpanFailures / checks.length : 0,
    unsupportedContentRate: checks.length ? unsupportedFailures / checks.length : 0,
    passed: checks.every(check => check.valid),
    trace: toJsonValue({
      source: "proof-preserving-paraphrase.verify",
      variantCount: input.variants.length,
      constraintCount: constraints.protectedSpans.length
    })
  };
}

function checkVariant(variantId: string, variant: string, constraints: PreservationConstraints): ParaphraseVariantCheck {
  const missingProtectedSpans = constraints.protectedSpans.filter(span => !variant.includes(span));
  const droppedNegation = constraints.requireNegationPreservation && !hasNegation(variant);
  const upgradedUncertainty = constraints.requireUncertaintyPreservation && !hasUncertainty(variant);
  const droppedContradiction = constraints.requireContradictionPreservation && !hasContradiction(variant);
  const unsupportedContent = droppedNegation || upgradedUncertainty || droppedContradiction;
  return {
    variantId,
    valid: missingProtectedSpans.length === 0 && !unsupportedContent,
    missingProtectedSpans,
    droppedNegation,
    upgradedUncertainty,
    droppedContradiction,
    unsupportedContent
  };
}

function extractProtectedSpans(text: string): string[] {
  const patterns = [
    /https?:\/\/[^\s)]+/giu,
    /\b[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|json|md|sql|yaml|yml)\b/giu,
    /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?\b/gu,
    /\b\d+(?:\.\d+)?\s?(?:ms|s|kg|m|cm|mm|MB|GB|%)\b/gu,
    /\b\d+(?:\.\d+)?\b/gu,
    /`[^`]+`/gu,
    /"[^"]+"/gu,
    /\{[A-Z0-9_]+\}/gu
  ];
  return uniqueStrings(patterns.flatMap(pattern => text.match(pattern) ?? []).map(value => value.replace(/^`|`$/gu, "").replace(/^"|"$/gu, "")));
}

function hasNegation(text: string): boolean {
  return /\b(?:no|not|never|without|cannot|can't|isn't|aren't|wasn't|weren't|impossible)\b/iu.test(text);
}

function hasUncertainty(text: string): boolean {
  return /\b(?:uncertain|unknown|missing|not enough|insufficient|may|might|could|undetermined|source-backed)\b/iu.test(text) || text.includes("?");
}

function hasContradiction(text: string): boolean {
  return /\b(?:contradiction|conflict|incompatible|disagree)\b/iu.test(text);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
