// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { jsonRecord, kernelString } from "./kernel-answer-primitives.js";
import type { EvidenceSpan } from "./types.js";

export interface EvidenceCitation {
  title: string;
  url?: string;
}

/**
 * A real, clickable public URL when one is derivable, never a guess: only
 * built from fields the ingestor itself actually recorded (provenance.uri,
 * corpus, title). wikipedia://enwiki/... internal URIs are not clickable
 * for a reader, so for wikimedia_dump sources this reconstructs the real
 * https://{lang}.wikipedia.org/wiki/{Title} URL from the same corpus name
 * (e.g. "enwiki-latest-pages-articles-multistream") the real language
 * subdomain is already encoded in -- never invented, never defaulted to
 * "en" when the corpus says otherwise.
 */
export function evidenceCitation(span: EvidenceSpan): EvidenceCitation | undefined {
  const provenance = jsonRecord(span.provenance);
  // The same two places evidenceTitle reads: an ingestor that records the title under metadata leaves a span the
  // kernel treats as titled and this cited as untitled, so the source it answered from never reached the reader.
  const title = kernelString(provenance.title) ?? kernelString(jsonRecord(provenance.metadata).title);
  if (!title) return undefined;
  const sourceKind = kernelString(provenance.sourceKind);
  const corpus = kernelString(provenance.corpus);
  const uri = kernelString(provenance.uri);
  if (sourceKind === "wikimedia_dump" && corpus) {
    const lang = /^([a-z]{2,3})wiki/.exec(corpus)?.[1];
    if (lang) {
      const page = title.trim().replace(/\s+/gu, "_");
      return { title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page).replace(/%2F/gu, "/")}` };
    }
  }
  if (uri && /^https?:\/\//u.test(uri)) return { title, url: uri };
  return { title };
}

/** Deduplicated, in first-seen order -- never fabricates a citation for evidence with no title. */
export function evidenceCitations(spans: readonly EvidenceSpan[]): EvidenceCitation[] {
  const seen = new Set<string>();
  const out: EvidenceCitation[] = [];
  for (const span of spans) {
    const citation = evidenceCitation(span);
    if (!citation) continue;
    const key = `${citation.title}${citation.url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(citation);
  }
  return out;
}

/**
 * The spans an answer must name: the ones the realizer referenced, or failing that the one whose own text carries
 * the answer verbatim.
 *
 * A surface realized off the dialogue plan arrives with no evidence refs even when it is an admitted span's own
 * text, and shipped uncited (live 2026-09-16: "* The real per-turn sync (items 217-218)." spoken from
 * task-resumption-turn-request.ts with evidenceRefs 0). Containment stands in for the ref the realizer dropped,
 * never for its absence: a surface no admitted span carries stays uncited, and a surface too short to identify a
 * source is not attributed to one.
 */
export function citedSpansForSurface(
  selectedEvidence: readonly EvidenceSpan[],
  evidenceRefs: readonly string[],
  answer: string,
  tidy: (value: string) => string
): EvidenceSpan[] {
  const referenced = selectedEvidence.filter(span => evidenceRefs.includes(String(span.id)));
  if (referenced.length) return referenced;
  const surface = tidy(answer);
  if ([...surface].length < CITATION_CONTAINMENT_FLOOR) return [];
  return selectedEvidence.filter(span => tidy(String(span.text ?? span.textPreview ?? "")).includes(surface)).slice(0, 1);
}

/** A surface shorter than one clause identifies no source by containment; the same floor answer-sentence selection uses. */
const CITATION_CONTAINMENT_FLOOR = 24;

export function formatCitationSuffix(citations: readonly EvidenceCitation[]): string {
  if (!citations.length) return "";
  const rendered = citations.map(citation => citation.url ? `${citation.title} (${citation.url})` : citation.title);
  return `\n\nSource${rendered.length > 1 ? "s" : ""}: ${rendered.join("; ")}`;
}
