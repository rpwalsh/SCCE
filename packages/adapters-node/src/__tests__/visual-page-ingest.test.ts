// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEvidenceExtractor,
  createSourceAdmissionController,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine,
  knownLanguageFrom
} from "@scce/kernel";
import {
  bigramsOf,
  frequenciesOf,
  renderTextPage,
  sampleWords,
  syntheticLanguage,
  wrapWords
} from "@scce/kernel/dist/__tests__/page-fixtures.js";
import { transcribeImageFile } from "../visual-page-reader.js";
import {
  VISUAL_PAGE_TRANSFORM_ID,
  ingestTranscribedImage,
  visualPageDerivative,
  visualPageMetadata,
  visualPageSourceTrust
} from "../visual-page-ingest.js";

// The claim: a page the eye read becomes knowledge a turn can answer from and CITE, without anything claiming
// the image said something it did not. The image's own bytes stay the source; the transcription is an evidence
// derivative, which is the concept SCCE already uses for a PDF's or a scan's text layer; and every span carries
// the derivative's own bytes so it reconstructs from its own byte range.
//
// The byte-identity assertion here is the same one the ingestion runtime makes before it will write a
// derivative at all. If a transcription could not satisfy it, it would not be ingestible, and the test would be
// measuring a fake rather than the thing.

const WEIGHTS = syntheticLanguage(20260918);
const CORPUS = sampleWords(WEIGHTS, 4242, 4000);
const LANGUAGE = { bigrams: bigramsOf(CORPUS), frequencies: frequenciesOf(CORPUS) };

const TRUST = {
  identity: 1, integrity: 1, parserReliability: 1, directness: 1,
  authority: 1, freshness: 1, independenceGroup: "fixture:visual-page",
  accessScope: "owner_private", licenseStatus: "owner_authorized"
} as const;

const ADMISSION = { mode: "owner_private", declaredBy: "fixture" } as const;

/** A page written to disk as the simplest honest format a scanner can emit. */
async function pageFile(lines: readonly string[]): Promise<{ path: string; bytes: Buffer }> {
  const image = renderTextPage(lines);
  const bytes = Buffer.concat([
    Buffer.from(`P5\n${image.width} ${image.height}\n255\n`, "ascii"),
    Buffer.from(image.data)
  ]);
  const directory = await mkdtemp(join(tmpdir(), "scce-page-ingest-"));
  const path = join(directory, "page.pgm");
  await writeFile(path, bytes);
  return { path, bytes };
}

describe("a page the eye read becomes citable knowledge", () => {
  it("projects the transcription into a derivative whose spans carry their own bytes", async () => {
    const lines = wrapWords(sampleWords(WEIGHTS, 777, 60), 8);
    const { path, bytes } = await pageFile(lines);
    const transcription = await transcribeImageFile(path, LANGUAGE);
    expect(transcription.abstained).toBe(false);
    expect(transcription.text.length).toBeGreaterThan(0);

    const derivative = visualPageDerivative(transcription);
    expect(derivative).toBeDefined();
    expect(derivative!.kind).toBe("extracted-text");
    expect(derivative!.transformId).toBe(VISUAL_PAGE_TRANSFORM_ID);
    // A character of the transcription came from a SHAPE, not from a byte range of the PNG, so there is no
    // inverse to record. Claiming one would be recording false lineage.
    expect(derivative!.originalCoordinateSpace).toBe("extracted-text-utf8");
    expect(derivative!.redactionMap).toEqual([]);
    // The assertion the ingestion runtime makes before it will write a derivative at all.
    expect(Buffer.from(derivative!.text, "utf8").equals(Buffer.from(derivative!.bytes))).toBe(true);

    // The derivative is a source in its own right, distinct from the image it came from.
    const clock = { now: () => 1_000 };
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const imageSourceVersionId = ids.sourceVersionId(bytes);
    const derivativeSourceVersionId = ids.sourceVersionId(derivative!.bytes);
    expect(derivativeSourceVersionId).not.toBe(imageSourceVersionId);

    const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({
      sourceVersionId: derivativeSourceVersionId,
      text: derivative!.text,
      createdAt: clock.now()
    });
    const extracted = createEvidenceExtractor({ idFactory: ids, hasher }).extract({
      sourceId: ids.sourceId("fixture", "file://page.pgm"),
      sourceVersionId: derivativeSourceVersionId,
      namespace: "fixture",
      uri: "file://page.pgm",
      mediaType: "text/plain; charset=utf-8",
      text: derivative!.text,
      languageProfile: profile,
      sourceTrust: TRUST,
      observedAt: clock.now(),
      maxChunkBytes: 4096,
      exactSourceText: true
    });

    expect(extracted.spans.length).toBeGreaterThan(0);
    for (const span of extracted.spans) {
      // Bound to the derivative, never to the image.
      expect(span.sourceVersionId).toBe(derivativeSourceVersionId);
      expect(span.sourceVersionId).not.toBe(imageSourceVersionId);
      // And citable: the span's text reconstructs from its own byte range in its own source.
      expect(Buffer.from(derivative!.bytes)
        .subarray(span.byteStart, span.byteEnd)
        .toString("utf8")).toBe(span.text);
    }
  });

  it("carries what the reading measured about itself onto the source", async () => {
    const { path } = await pageFile(wrapWords(sampleWords(WEIGHTS, 777, 60), 8));
    const transcription = await transcribeImageFile(path, LANGUAGE);
    const metadata = visualPageMetadata(transcription);
    expect(metadata.transform).toBe(VISUAL_PAGE_TRANSFORM_ID);
    expect(metadata.imageSha256).toBe(transcription.imageSha256);
    // A consumer deciding how much to trust the page needs the margin as much as the text: a page that only
    // just beat its alternative said more than one thing.
    expect(metadata.readingMargin).toBe(transcription.readingMargin);
    expect(metadata.readingsConsidered).toBeGreaterThan(1);
    expect(metadata.fit).toBe(transcription.fit);
    expect(metadata.granularity).toBe(transcription.granularity);
  });

  it("hands the image bytes to ingest as the source and the transcription as the derivative", async () => {
    const { path, bytes } = await pageFile(wrapWords(sampleWords(WEIGHTS, 777, 60), 8));
    const transcription = await transcribeImageFile(path, LANGUAGE);

    const seen: unknown[] = [];
    const result = await ingestTranscribedImage({
      kernel: {
        async ingest(input) {
          seen.push(input);
          // Exactly the check ingestion-runtime makes before writing a derivative.
          expect(Buffer.from(input.evidenceDerivative!.text, "utf8")
            .equals(Buffer.from(input.evidenceDerivative!.bytes))).toBe(true);
          return { sources: 2, evidence: 3, promotedEvidenceIds: ["e1", "e2", "e3"] };
        }
      },
      imageBytes: bytes,
      transcription,
      uri: "file://page.pgm",
      namespace: "fixture",
      sourceAdmission: ADMISSION,
      sourceTrust: TRUST
    });

    expect(result.ingested).toBe(true);
    // Two sources: the image, and the transcription derived from it.
    expect(result.sources).toBe(2);
    expect(result.evidence).toBe(3);
    expect(result.promotedEvidenceIds).toEqual(["e1", "e2", "e3"]);
    const call = seen[0] as { content: Uint8Array; evidenceDerivative: { text: string } };
    // The IMAGE's bytes are the content. The reading never stands in for them.
    expect(Buffer.from(call.content).equals(bytes)).toBe(true);
    expect(call.evidenceDerivative.text).toBe(transcription.text);
  });

  it("ingests nothing from a page the eye would not stand behind", async () => {
    // Blank paper. The eye refuses it with a reason, and a refusal is not knowledge.
    const width = 80;
    const height = 60;
    const directory = await mkdtemp(join(tmpdir(), "scce-page-ingest-blank-"));
    const path = join(directory, "blank.pgm");
    await writeFile(path, Buffer.concat([
      Buffer.from(`P5\n${width} ${height}\n255\n`, "ascii"),
      Buffer.from(new Uint8Array(width * height).fill(230))
    ]));
    const transcription = await transcribeImageFile(path, LANGUAGE);
    expect(transcription.abstained).toBe(true);
    expect(visualPageDerivative(transcription)).toBeUndefined();

    let called = false;
    const result = await ingestTranscribedImage({
      kernel: { async ingest() { called = true; return { sources: 0, evidence: 0 }; } },
      imageBytes: Buffer.from([1, 2, 3]),
      transcription,
      uri: "file://blank.pgm",
      sourceAdmission: ADMISSION,
      sourceTrust: TRUST
    });
    expect(called).toBe(false);
    expect(result.ingested).toBe(false);
    expect(result.reason).toBe(transcription.abstainedBecause);
    expect(result.sources).toBe(0);
  });
});

describe("the page's trust vector is measured, not chosen", () => {
  it("derives every number from the bytes or the reading, and takes only the strings as declared", async () => {
    const { path } = await pageFile(wrapWords(sampleWords(WEIGHTS, 777, 60), 8));
    const transcription = await transcribeImageFile(path, LANGUAGE);
    const trust = visualPageSourceTrust(transcription, {
      independenceGroup: "owner:visual:target",
      accessScope: "owner_private",
      licenseStatus: "owner_authorized"
    });

    // Content addressing gives exact identity and verifiability. Facts about hashing, not judgements.
    expect(trust.identity).toBe(1);
    expect(trust.integrity).toBe(1);
    // How decisively this reading beat the next best: the MDL posterior from the margin in nats. This fixture
    // happens to TIE -- its two cheapest readings cost the same -- so it sits exactly at 0.5, which is the
    // honest reading of a page that admitted two equally good interpretations.
    expect(trust.parserReliability).toBeCloseTo(1 / (1 + Math.exp(-transcription.readingMargin)), 12);
    expect(trust.parserReliability as number).toBeGreaterThanOrEqual(0.5);
    expect(trust.parserReliability as number).toBeLessThanOrEqual(1);
    // One transform from the artifact.
    expect(trust.directness).toBe(0.5);
    // Neither is knowable from an image, so neither is asserted.
    expect(trust.authority).toBe(0);
    expect(trust.freshness).toBe(0);
    expect(trust.independenceGroup).toBe("owner:visual:target");
  });

  it("gives a worse-read page a lower parser reliability than a better-read one", async () => {
    const clean = await transcribeImageFile((await pageFile(wrapWords(sampleWords(WEIGHTS, 777, 60), 8))).path, LANGUAGE);
    // The same passage set in columns: read correctly, but scored by the same language on its own terms.
    const declared = { independenceGroup: "g", accessScope: "owner_private", licenseStatus: "owner_authorized" };
    const trust = visualPageSourceTrust(clean, declared);
    // A tie asserts no preference between the two readings; a decisive margin approaches certainty.
    const tied = visualPageSourceTrust({ ...clean, readingMargin: 0 }, declared);
    const decisive = visualPageSourceTrust({ ...clean, readingMargin: 700 }, declared);
    expect(tied.parserReliability).toBeCloseTo(0.5, 12);
    expect(decisive.parserReliability as number).toBeGreaterThan(0.99);
    expect(decisive.parserReliability as number).toBeGreaterThan(tied.parserReliability as number);
  });
});

describe("a read page can actually clear admission", () => {
  it("passes the trust gate as a learned prior, and cannot as direct evidence", async () => {
    // The defect this guards: visualPageSourceTrust asserts authority 0, because a machine reading of a
    // photograph is not an authority on its subject. Admission applies an authority floor only to
    // direct_evidence, so declaring that use made every read page fail the gate and quarantine -- and --admit
    // could never promote one. The honest fix was the declared use, not the number.
    const { path } = await pageFile(wrapWords(sampleWords(WEIGHTS, 777, 60), 8));
    const transcription = await transcribeImageFile(path, LANGUAGE);
    const trust = visualPageSourceTrust(transcription, {
      independenceGroup: "owner:visual:target",
      accessScope: "owner_private",
      licenseStatus: "owner_authorized"
    });
    expect(trust.authority).toBe(0);

    const source = {
      sourceId: "source_visual", sourceVersionId: "source_version_visual", namespace: "visual",
      canonicalUri: "file://page.pgm", contentHash: "sha256_visual", mediaType: "text/plain",
      observedAt: 1_000, byteLength: 128, sourceTrust: trust, metadata: {}
    } as never;
    const evidence = [{
      id: "evidence_visual", sourceId: "source_visual", sourceVersionId: "source_version_visual",
      chunkId: "chunk_visual", contentHash: "sha256_chunk", mediaType: "text/plain",
      byteStart: 0, byteEnd: 16, charStart: 0, charEnd: 16,
      text: transcription.text.slice(0, 16), textPreview: transcription.text.slice(0, 16),
      languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {},
      features: [], status: "quarantined", alpha: 0.5, observedAt: 1_000
    }] as never[];

    const asLearnedPrior = createSourceAdmissionController().decide({
      source, evidence,
      context: { sourceClass: "owner_local", intendedUse: "learned_prior", promotionAuthority: "owner" }
    });
    expect(asLearnedPrior.trustChecks.authority).toBe(true);
    expect(asLearnedPrior.disposition).toBe("promote");

    // And the reason the declared use had to change: as direct evidence the honest authority of 0 fails.
    const asDirectEvidence = createSourceAdmissionController().decide({
      source, evidence,
      context: { sourceClass: "owner_local", intendedUse: "direct_evidence", promotionAuthority: "owner" }
    });
    expect(asDirectEvidence.trustChecks.authority).toBe(false);
    expect(asDirectEvidence.disposition).not.toBe("promote");
  });
});

describe("the eye's own language is the one the brain holds", () => {
  it("reads against a known language and reports the fit that language assigned", async () => {
    const { path } = await pageFile(wrapWords(sampleWords(WEIGHTS, 777, 60), 8));
    const known = knownLanguageFrom(LANGUAGE.bigrams, LANGUAGE.frequencies);
    expect(known.frequencies.length).toBeGreaterThan(0);
    const transcription = await transcribeImageFile(path, LANGUAGE);
    // A finite per-symbol log-likelihood: the page was scored, not merely segmented.
    expect(Number.isFinite(transcription.fit)).toBe(true);
    expect(transcription.fit).toBeLessThan(0);
  });
});
