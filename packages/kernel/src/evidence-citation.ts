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
  const title = kernelString(provenance.title);
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

export function formatCitationSuffix(citations: readonly EvidenceCitation[]): string {
  if (!citations.length) return "";
  const rendered = citations.map(citation => citation.url ? `${citation.title} (${citation.url})` : citation.title);
  return `\n\nSource${rendered.length > 1 ? "s" : ""}: ${rendered.join("; ")}`;
}
