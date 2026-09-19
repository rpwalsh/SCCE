// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Closing the loop: a page the eye read becomes knowledge a turn can answer from and cite.
//
// This needs no new concept, because SCCE already has the right one. An evidence span must carry its source's
// own bytes, and an image has no text bytes, so a reading of an image cannot be evidence over the image. That
// is exactly the case an EVIDENCE DERIVATIVE covers, and it is already how a PDF's or a scan's text layer is
// ingested: the raw bytes remain the source and get their own durable source version, the extracted text is a
// second source version with `role: "evidence-derivative"` and a `derivation` recording what it came from, and
// every span is bound to the derivative and carries the derivative's own bytes. The invariant holds honestly
// and the lineage is on the record.
//
// A transcription is that same kind of projection, so it declares the same coordinate space the HTML and PDF
// text layers do: `extracted-text-utf8` with an empty redaction map. There is no inverse from a character of
// the transcription back to a byte of the PNG -- what produced it was a shape, not a byte range -- and
// recording a map that claimed otherwise would be recording false lineage.
//
// A reading the eye would not stand behind is not ingested at all. There is nothing for a page it abstained on
// to teach, and a confident wrong transcription in the corpus is worse than no transcription.

import type { PageTranscription } from "./visual-page-reader.js";

/** The transform that produced this text, recorded on the derivative's lineage. */
export const VISUAL_PAGE_TRANSFORM_ID = "scce.visual-page-text.v1";

/** The shape `IngestInput.evidenceDerivative` requires, restated so this module needs no kernel-internal import. */
export interface VisualPageDerivative {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly kind: "extracted-text";
  readonly transformId: string;
  readonly originalCoordinateSpace: "extracted-text-utf8";
  readonly redactionMap: readonly never[];
}

/**
 * The transcription as a derivative of the image. Nothing for a reading the eye abstained on, and nothing for
 * a reading that came back empty: a derivative whose text is empty carries no span and would only assert that
 * the image was read.
 */
export function visualPageDerivative(transcription: PageTranscription): VisualPageDerivative | undefined {
  if (transcription.abstained || !transcription.text.length) return undefined;
  const bytes = Buffer.from(transcription.text, "utf8");
  return {
    bytes,
    text: transcription.text,
    kind: "extracted-text",
    transformId: VISUAL_PAGE_TRANSFORM_ID,
    originalCoordinateSpace: "extracted-text-utf8",
    redactionMap: []
  };
}

/**
 * What the reading measured about itself, carried on the source's metadata. These are the numbers a later
 * consumer needs to decide how much weight to give the page, and they are recorded rather than folded into a
 * trust score here: how strongly a reading has to be supported before it counts is the caller's policy.
 */
export function visualPageMetadata(transcription: PageTranscription): Record<string, unknown> {
  return {
    transform: VISUAL_PAGE_TRANSFORM_ID,
    imageSha256: transcription.imageSha256,
    imageBytes: transcription.imageBytes,
    imageWidth: transcription.imageWidth,
    imageHeight: transcription.imageHeight,
    colourProjected: transcription.colourProjected,
    illuminationFlattened: transcription.illuminationFlattened,
    orientation: transcription.orientation,
    grouping: transcription.grouping,
    granularity: transcription.granularity,
    rightToLeft: transcription.rightToLeft,
    signCount: transcription.signCount,
    glyphCount: transcription.glyphCount,
    recalledSigns: transcription.recalledSigns,
    // How far ahead the chosen reading was, and how many readings the page admitted at all. A page with a
    // small margin said more than one thing, and a consumer that cites it should know that.
    fit: transcription.fit,
    directionMargin: transcription.directionMargin,
    readingMargin: transcription.readingMargin,
    readingsConsidered: transcription.alternatives.length
  };
}

/**
 * What a read page's trust vector actually is. The existing corpora each carry a hand-written table of six
 * numbers per source system, which is the kind of constant this engine is supposed to measure rather than
 * choose. Every number here is either a fact about the bytes or something the reading measured:
 *
 *   identity, integrity  the image is content-addressed, so it is exactly identified and verifiable. These are
 *                        properties of hashing, not judgements about the page.
 *   parserReliability    how decisively this reading beat the next best one. The eye scores every candidate
 *                        reading by complete description length and reports the margin in nats, so the
 *                        posterior odds of the chosen reading against the runner-up are exp(margin) and its
 *                        posterior probability is 1/(1+exp(-margin)). A tie reads 0.5; a decisive reading
 *                        approaches 1. Derived, with no constant to pick.
 *
 *                        This was exp(fit) first, which was wrong: fit is how likely the TEXT is under the
 *                        known language, not how reliable the PARSE was. It measured 0.12 on a good page and
 *                        so failed admission's parserReliability floor, quarantining every read page.
 *   directness           structural: the page is the artifact and the reading is one transform from it, so
 *                        1/(1+depth) with depth 1. Not taste -- derivation depth.
 *   authority, freshness  whether a photographed page is an authority on its subject, and when it was written,
 *                        are not knowable from the image. Nothing is asserted, the same way human-authored
 *                        dialogue asserts no factual authority.
 *
 * The three strings are the owner's declaration about where the page came from, which no measurement supplies.
 */
export function visualPageSourceTrust(
  transcription: PageTranscription,
  declared: {
    readonly independenceGroup: string;
    readonly accessScope: string;
    readonly licenseStatus: string;
  }
): Record<string, number | string> {
  // Posterior of the chosen reading against the runner-up, from the margin the eye measured in nats.
  const margin = transcription.readingMargin;
  const reliability = Number.isFinite(margin) ? 1 / (1 + Math.exp(-margin)) : 0.5;
  return {
    identity: 1,
    integrity: 1,
    parserReliability: Math.min(1, Math.max(0, reliability)),
    directness: 1 / 2,
    authority: 0,
    freshness: 0,
    independenceGroup: declared.independenceGroup,
    accessScope: declared.accessScope,
    licenseStatus: declared.licenseStatus
  };
}

/** The minimum kernel surface this needs; the real kernel satisfies it, and tests fake it. */
export interface VisualPageIngestKernel {
  ingest(input: {
    readonly uri: string;
    readonly namespace?: string;
    readonly mediaType?: string;
    readonly content: Uint8Array;
    readonly evidenceDerivative?: VisualPageDerivative;
    readonly metadata?: unknown;
    readonly sourceAdmission: unknown;
    readonly sourceTrust: unknown;
  }): Promise<{ readonly sources: number; readonly evidence: number; readonly promotedEvidenceIds?: readonly string[] }>;
}

export interface VisualPageIngestResult {
  /** False when the eye would not stand behind the reading; nothing was written. */
  readonly ingested: boolean;
  readonly reason?: string;
  readonly sources: number;
  readonly evidence: number;
  readonly promotedEvidenceIds: readonly string[];
}

/**
 * Ingest a page the eye read. The image's own bytes are the source and keep their own hash; the transcription
 * is the derivative every span is bound to. `sourceTrust` and `sourceAdmission` are the caller's, because how
 * much a photographed page is trusted and whether it may be admitted at all is provenance policy and not
 * something a reading can decide about itself.
 */
export async function ingestTranscribedImage(input: {
  readonly kernel: VisualPageIngestKernel;
  readonly imageBytes: Uint8Array;
  readonly transcription: PageTranscription;
  readonly uri: string;
  readonly namespace?: string;
  readonly mediaType?: string;
  readonly sourceAdmission: unknown;
  readonly sourceTrust: unknown;
}): Promise<VisualPageIngestResult> {
  const derivative = visualPageDerivative(input.transcription);
  if (!derivative) {
    return {
      ingested: false,
      reason: input.transcription.abstainedBecause ?? "the reading carried no text",
      sources: 0,
      evidence: 0,
      promotedEvidenceIds: []
    };
  }
  const result = await input.kernel.ingest({
    uri: input.uri,
    namespace: input.namespace,
    mediaType: input.mediaType,
    content: input.imageBytes,
    evidenceDerivative: derivative,
    metadata: visualPageMetadata(input.transcription),
    sourceAdmission: input.sourceAdmission,
    sourceTrust: input.sourceTrust
  });
  return {
    ingested: true,
    sources: result.sources,
    evidence: result.evidence,
    promotedEvidenceIds: [...(result.promotedEvidenceIds ?? [])]
  };
}
