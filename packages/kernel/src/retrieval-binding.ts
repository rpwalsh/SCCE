// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { corpusIdentitySignals, corpusIdentityUnits } from "./corpus-identity.js";
import { evidenceSourceIdentity } from "./evidence-source-identity.js";
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
}

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
}

const MECHANISM_BY_IDENTITY_BINDING = { title: "source_identity", declaration: "source_declaration", none: "unbound" } as const;

/** The one producer. Pure: it reads the span, the request and the primed corpus measurement, and nothing else. */
export function retrievalBinding(span: EvidenceSpan, context: RetrievalBindingContext): RetrievalBinding {
  const detail = evidenceIdentityBindingDetail(span, context.requestText, context.closedClassWords, context.anchors);
  const mechanism: RetrievalBindingMechanism = detail.requestConstituents.length
    ? MECHANISM_BY_IDENTITY_BINDING[detail.binding]
    : "unmeasured";
  const provenance = evidenceSourceIdentity(span);
  const sourceKind: RetrievalSourceKind = { declared: provenance.sourceKind, sourceCode: isCodeEvidenceSpan(span) };
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
 * Rank order for the source-kind prior: a bound candidate, then one whose kind costs nothing, then one whose
 * binding was never measurable. A cost on the frontier, not an erasure before ranking.
 */
export function retrievalBindingRank(binding: RetrievalBinding): number {
  if (binding.mechanism === "source_identity" || binding.mechanism === "source_declaration") return 0;
  if (!binding.sourceKind.sourceCode) return 1;
  return binding.admissibility === "undetermined" ? 2 : 3;
}

/** Code evidence: a span whose source is code (media type, code-graph facts, or a code file extension). */
const CODE_MEDIA_MARKERS = ["javascript", "typescript", "x-python", "x-rust", "x-go", "x-java", "x-csharp", "x-c++", "source"];
const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".rs", ".go", ".java", ".cs", ".cpp", ".c", ".h", ".hpp", ".php", ".rb", ".swift", ".kt"];
/** Markup media types that share the `text/x-` prefix with source code but are prose sources. */
const MARKUP_MEDIA_TYPES = ["text/x-wiki", "text/x-markdown", "text/x-rst", "text/x-org"] as const;

/**
 * The one predicate for "this span is source code", used by both the prose filter and the program-authority rule.
 *
 * Two predicates existed and disagreed. The retrieval-side one required a `file://` URI; the repository is ingested
 * with a bare repo-relative path and `text/plain`, so 6,522 promoted spans of the owner's own TypeScript were invisible
 * to it, and "Who was Ada Lovelace?" was answered live from a comment in `mouth.ts` that names her as an example.
 * Declared media type, declared URI and content shape are each checked, because a repository span declares neither.
 */
export function isCodeEvidenceSpan(span: EvidenceSpan): boolean {
  const media = String(span.mediaType ?? "").toLocaleLowerCase();
  // Wiki markup shares the `text/x-` prefix with source media types and is the media type of every ingested
  // Wikipedia span; treating the family as code once emptied the prose corpus from every non-code request.
  if (MARKUP_MEDIA_TYPES.some(markup => media.startsWith(markup))) return false;
  if (CODE_MEDIA_MARKERS.some(marker => media.includes(marker))) return true;
  const provenance = span.provenance && typeof span.provenance === "object" && !Array.isArray(span.provenance) ? span.provenance as Record<string, unknown> : {};
  // Source-code METADATA says the span came from a code project, not that the span is code. Ingesting a
  // repository stamps it on every file in the tree, so it was true of the README, the HTML pages and the
  // package manifest as much as of the TypeScript -- and returning true here on that basis made every prose
  // document in an ingested project invisible to every non-code question. The private-docs corpus is one such
  // project: asked what license SlopBlocker uses, the markdown span answering it was classified as code and
  // filtered out of the pool, after the retrieval fix had already found it.
  //
  // The two checks below decide it from the span instead: the URI extension names the language, and failing
  // that the punctuation shape reads the content. The workspace TypeScript this branch was added for is caught
  // by both -- it is ingested with its .ts path, and it reads as code -- so nothing that was excluded on
  // evidence stops being excluded.
  const uri = String(provenance.uri ?? provenance.canonicalUri ?? "").toLocaleLowerCase();
  if (CODE_EXTENSIONS.some(extension => uri.endsWith(extension))) return true;
  return textShapeIsSourceCode(String(span.text ?? ""));
}

/** Code shape from punctuation alone, for spans whose media type and URI both fail to declare it. No language rules. Pure. */
export function textShapeIsSourceCode(text: string): boolean {
  const lines = text.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  if (lines.length < 3) return false;
  const codeLines = lines.filter(line =>
    line.startsWith("//") || line.startsWith("/*") || /[;{}]$/u.test(line)
    || /(=>|::|->|\(\)|\{\}|\[\])/u.test(line)).length;
  return codeLines / lines.length >= 0.34;
}
