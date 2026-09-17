// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { jsonRecord, kernelString } from "./kernel-answer-primitives.js";
import type { EvidenceSourceIdentity, EvidenceSpan, JsonValue } from "./types.js";

/**
 * What a span's provenance says the source IS, resolved once.
 *
 * Two ingestors write these in two places -- the Wikipedia dump at the top level, the repository ingestor under
 * `metadata` -- and every consumer re-derived the pair for itself: evidenceTitle read both, evidenceIdentity read
 * both, evidenceCitation read only the first and cited nothing for the whole repository corpus. The schema already
 * states the rule once (the `source_title` generated column coalesces exactly these two), so this is that same rule
 * on the TypeScript side of the boundary, not a fifth opinion.
 *
 * Pure: the one place raw provenance is read for title, identity and source kind.
 */
export function resolveEvidenceSourceIdentity(provenanceJson: JsonValue | undefined): EvidenceSourceIdentity {
  const provenance = jsonRecord(provenanceJson);
  const metadata = jsonRecord(provenance.metadata);
  return {
    title: kernelString(provenance.title) ?? kernelString(metadata.title) ?? "",
    identity: kernelString(provenance.identity) ?? kernelString(metadata.identity) ?? "",
    sourceKind: kernelString(provenance.sourceKind) ?? kernelString(metadata.sourceKind) ?? ""
  };
}

/**
 * The resolved identity of a span, from the field the read boundary set when it is there and from provenance when
 * it is not. A span built in memory (a session span, a fixture) never crossed that boundary, so the fallback is
 * the same resolver rather than an empty identity.
 */
export function evidenceSourceIdentity(span: EvidenceSpan): EvidenceSourceIdentity {
  return span.sourceIdentity ?? resolveEvidenceSourceIdentity(span.provenance);
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
