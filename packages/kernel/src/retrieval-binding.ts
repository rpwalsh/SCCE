// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { corpusIdentitySignals, corpusIdentityUnits } from "./corpus-identity.js";
import { evidenceSourceIdentity, isCodeEvidenceSpan } from "./evidence-source-identity.js";
import { evidenceIdentityBindingDetail } from "./local-evidence-runtime.js";
import type { EvidenceSourceIdentity, EvidenceSpan } from "./types.js";

/**
 * Why this evidence is relevant to this request, resolved once.
 *
 * The retrieval layer had no authoritative answer to that question, only filters that each approximated it and
 * disagreed: the SQL source-kind exclusion, the per-group prose filter, the post-search filter, the merged-pool
 * filter, the unanchored graph filter, the evidence-only filter and the turn's access policy. Four stated the
 * whole rule and three stated only its source-kind half, so a source file that declares the identifier a request
 * names survived three of them and was erased by the others.
 *
 * Every consumer reads the binding instead. Admissibility is a FIELD of it, not a filter somewhere upstream, and
 * source kind is a prior and a cost on it, never an erasure performed before cognition has looked.
 */
export type RetrievalBindingMechanism =
  /** The source's own title or identity is what the request names. */
  | "source_identity"
  /** The source declares an identifier the request names -- a code file whose identity is its path. */
  | "source_declaration"
  /** Measured against the request's constituents, and nothing bound. */
  | "unbound"
  /** The request named no constituent to bind against. Not a failure to bind: no binding was measured. */
  | "unmeasured";

export type RetrievalAdmissibility =
  | "admissible"
  /** Measured, and this source kind is not what this request is about. */
  | "inadmissible_unbound"
  /** No binding was measurable, so no refusal was earned. Carried forward, ranked last. */
  | "undetermined";

export interface RetrievalSourceKind {
  /** What provenance declares the source is; empty when it declared none. */
  readonly declared: string;
  /** Whether the span itself is source code: declared media type, then URI extension, then content shape. */
  readonly sourceCode: boolean;
  /** Whether this kind pays the frontier cost: it ranks behind every other kind, and is never removed. */
  readonly deprioritized: boolean;
}

/**
 * The source kinds a request that was not routed to source code makes pay the frontier cost.
 *
 * This is the whole of the prior, declared once, read by the SQL frontier rank and by `retrievalBindingRank` so
 * the two cannot disagree. It was an `excludeSourceKinds` erasure applied before ranking, which made the operator
 * selection decide the epistemic universe: to recognise a request as being about source the turn needs source
 * evidence, and to retrieve source evidence it had to have recognised the request already. As a rank it costs a
 * deprioritized kind every frontier slot another kind wants, and nothing more.
 */
export const RETRIEVAL_DEPRIORITIZED_SOURCE_KINDS: readonly string[] = ["developer_intelligence", "construction_training"];

/**
 * How discriminative the binding constituent is, measured over the corpus and not over this request's slice.
 * `spread` is distinct sources carrying every unit of a run, measured by sourceSpreadDistribution against the
 * whole store; `concentration` is the Otsu split of that corpus-wide distribution. Selection population is not
 * measurement population, so neither is ever derived from the retrieved candidates.
 */
export interface RetrievalBindingSpecificity {
  /** Distinct corpus sources carrying the bound constituent; fewer is more discriminative. Absent = unmeasured. */
  readonly bindingSourceCount: number | undefined;
  /** Whether the corpus's own split calls that count concentrated. Absent = unmeasured, which is not false. */
  readonly concentrated: boolean | undefined;
}

export interface RetrievalBinding {
  readonly evidenceId: string;
  /** The request's constituents this binding was measured against; empty means none existed to measure. */
  readonly requestConstituents: readonly string[];
  /** The source's own constituents that carried the binding; empty when none did. */
  readonly sourceConstituents: readonly string[];
  readonly mechanism: RetrievalBindingMechanism;
  readonly specificity: RetrievalBindingSpecificity;
  readonly provenance: EvidenceSourceIdentity;
  readonly sourceKind: RetrievalSourceKind;
  readonly admissibility: RetrievalAdmissibility;
}

export interface RetrievalBindingContext {
  readonly requestText: string;
  /** The request's learned scaffolding; a constituent made only of it names no subject. */
  readonly closedClassWords?: ReadonlySet<string>;
  /** Constituents a caller already narrowed; the request's own are derived when absent. */
  readonly anchors?: readonly string[];
  /** Operator-granted access. When source code is allowed its kind carries no cost at this boundary. */
  readonly sourceCodeEvidenceAllowed?: boolean;
  /** The kinds that pay the frontier cost; the declared prior when absent. */
  readonly deprioritizedSourceKinds?: readonly string[];
}

const MECHANISM_BY_IDENTITY_BINDING = { title: "source_identity", declaration: "source_declaration", none: "unbound" } as const;

/** The one producer. Pure: it reads the span, the request and the primed corpus measurement, and nothing else. */
export function retrievalBinding(span: EvidenceSpan, context: RetrievalBindingContext): RetrievalBinding {
  const detail = evidenceIdentityBindingDetail(span, context.requestText, context.closedClassWords, context.anchors);
  const mechanism: RetrievalBindingMechanism = detail.requestConstituents.length
    ? MECHANISM_BY_IDENTITY_BINDING[detail.binding]
    : "unmeasured";
  const provenance = evidenceSourceIdentity(span);
  const deprioritized = context.sourceCodeEvidenceAllowed === true
    ? false
    : (context.deprioritizedSourceKinds ?? RETRIEVAL_DEPRIORITIZED_SOURCE_KINDS).includes(provenance.sourceKind);
  const sourceKind: RetrievalSourceKind = { declared: provenance.sourceKind, sourceCode: isCodeEvidenceSpan(span), deprioritized };
  return {
    evidenceId: String(span.id),
    requestConstituents: detail.requestConstituents,
    sourceConstituents: detail.sourceConstituents,
    mechanism,
    specificity: bindingSpecificity(detail.boundRequestConstituents),
    provenance,
    sourceKind,
    admissibility: bindingAdmissibility(mechanism, sourceKind, context.sourceCodeEvidenceAllowed === true)
  };
}

/**
 * Admissibility, stated once.
 *
 * Prose passes this boundary on any mechanism -- relevance ranking and the answerhood gate decide it downstream,
 * and erasing it here is what made the merged filter disagree with its own upstream. Source code passes when the
 * request's own identity bound it. When the request named nothing to bind against, nothing was measured, and an
 * unmeasured binding is not a refused one.
 */
function bindingAdmissibility(
  mechanism: RetrievalBindingMechanism,
  sourceKind: RetrievalSourceKind,
  sourceCodeEvidenceAllowed: boolean
): RetrievalAdmissibility {
  if (sourceCodeEvidenceAllowed || !sourceKind.sourceCode) return "admissible";
  if (mechanism === "source_identity" || mechanism === "source_declaration") return "admissible";
  return mechanism === "unmeasured" ? "undetermined" : "inadmissible_unbound";
}

function bindingSpecificity(boundConstituents: readonly string[]): RetrievalBindingSpecificity {
  const signals = corpusIdentitySignals();
  if (!signals || !boundConstituents.length) return { bindingSourceCount: undefined, concentrated: undefined };
  const counts = boundConstituents
    .map(constituent => signals.spread.get(constituent) ?? signals.spread.get(corpusIdentityUnits(constituent).join(" ")))
    .filter((count): count is number => count !== undefined);
  if (!counts.length) return { bindingSourceCount: undefined, concentrated: undefined };
  const bindingSourceCount = Math.min(...counts);
  return { bindingSourceCount, concentrated: bindingSourceCount <= signals.concentration };
}

/**
 * What a retrieval lane may carry forward: everything except a measured refusal.
 *
 * `undetermined` travels with the candidate rather than being resolved into a boolean here; the turn's access
 * policy re-reads the binding once the request text is in hand, which is the first point where it CAN be measured.
 */
export function retrievalBindingCarries(binding: RetrievalBinding): boolean {
  return binding.admissibility !== "inadmissible_unbound";
}

/**
 * What a turn may treat as support for a factual claim, which is a narrower question than what retrieval carries.
 *
 * `undetermined` resolves conservatively HERE and nowhere upstream: this is the boundary that commits the system
 * to an assertion, and it is the first one holding the request text, so refusing here is a decision that was
 * actually made rather than a measurement that was never taken.
 */
export function retrievalBindingSupports(binding: RetrievalBinding): boolean {
  return binding.admissibility === "admissible";
}

/**
 * The source-kind prior as a rank: a cost on the frontier, never an erasure before ranking.
 *
 * A source the request is titled with leads. Prose follows, ahead of a declaration match, because a source file
 * whose comment happens to name the subject must not unseat the article about it -- the admission tier states the
 * same order, and this is that order where no admission tier runs. An unmeasured binding is carried last.
 *
 * A deprioritized kind sorts behind every kind that is not, matching the SQL frontier rank exactly: what the
 * database ordered last must not be re-interleaved here, or the frontier's prose guarantee ends at the read
 * boundary. Within each tier the order above is unchanged.
 */
const RETRIEVAL_BINDING_TIER = 4;

export function retrievalBindingRank(binding: RetrievalBinding): number {
  const tier = binding.sourceKind.deprioritized ? RETRIEVAL_BINDING_TIER : 0;
  if (binding.mechanism === "source_identity") return tier;
  if (!binding.sourceKind.sourceCode) return tier + 1;
  if (binding.mechanism === "source_declaration") return tier + 2;
  return tier + 3;
}

/**
 * Code evidence and its code-shape test live with the source identity both of them read, so the declaration half
 * of the binding can use the same predicate without a module cycle. Re-exported here because this is the contract
 * every retrieval consumer asks through.
 */
export { isCodeEvidenceSpan, textShapeIsSourceCode } from "./evidence-source-identity.js";
