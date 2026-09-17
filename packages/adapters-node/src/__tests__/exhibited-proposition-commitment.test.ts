// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  candidateCommitmentInventory,
  candidateCommitmentsLicensed,
  candidateMayAssertAsKnown,
  citedSpansForSurface,
  commitmentEvidenceText,
  createEvidenceExtractor,
  createHasher,
  createIdFactory,
  createClock,
  createLanguageAcquisitionEngine,
  propositionAssertionalStance,
  retrievalBinding,
  retrievalBindingSupports,
  COMMITMENT_AUTHORITY_IDS,
  type EvidenceSpan,
  type JsonValue
} from "@scce/kernel";
import { NodeFileIngestAdapter } from "../files.js";
import type { ScceRuntimeConfig } from "../config.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** The declared glob names no conventional test token, so nothing here can be reached by name-matching a path. */
const DECLARED_TEST_GLOB = "lib/**/*.probe.ts";
const WORLD_FACT = "Apollo 11 landed on the Moon on July 20, 1969.";
const ANSWERING_SURFACE = "July 20, 1969";
/** Deliberately false, exactly as the control the live corpus promoted at alpha 0.72. */
const FALSE_CONTROL = "Albert Einstein was born in Ulm and later won the Nobel Prize in Chemistry.";
/** The resident closed class this surface is judged against; measured elsewhere, supplied here as a fixture would be. */
const CLOSED_CLASS = ["on", "the", "and", "in", "was", "later"];
const SEPARATOR = String.fromCharCode(10);

describe("an exhibited proposition has no authority to license the claim it states", () => {
  it("refuses the fixture's licence for a world fact while the article licenses it, without refusing the fixture's file", async () => {
    const built = await corpus();
    const fixture = built.spanCarrying("lib/apollo.probe.ts", WORLD_FACT);
    const article = built.spanCarrying("lib/mission.ts", WORLD_FACT);

    // The property, stated over the measurement rather than over a file name: one span exhibits this
    // proposition and the other asserts it. Neither is identified by path, title or source kind, and both
    // files are code the same measurement ran over.
    expect(propositionAssertionalStance(fixture, WORLD_FACT)).toBe("exhibited");
    expect(propositionAssertionalStance(article, WORLD_FACT)).toBe("asserted");

    const fromFixture = inventory(WORLD_FACT, [fixture]);
    const fromArticle = inventory(WORLD_FACT, [article]);
    const fromBoth = inventory(WORLD_FACT, [fixture, article]);

    // A span that only exhibits the proposition licenses no unit of it, so the claim is unsupported.
    expect(candidateCommitmentsLicensed(fromFixture)).toBe(false);
    expect(candidateMayAssertAsKnown(fromFixture)).toBe(false);
    expect(authorityIdsFor(fromFixture)).not.toContain(COMMITMENT_AUTHORITY_IDS.documentary);
    // Carried, not collapsed: the span that held it is recorded as having exhibited it.
    expect(exhibitedHoldersFor(fromFixture)).toContain(String(fixture.id));

    // The asserting source is unaffected, so the correct answer stays available.
    expect(candidateCommitmentsLicensed(fromArticle)).toBe(true);
    expect(candidateMayAssertAsKnown(fromArticle)).toBe(true);

    // With both in the pool the claim is licensed, and only the asserting span is named as its licence.
    expect(candidateCommitmentsLicensed(fromBoth)).toBe(true);
    expect(documentaryLicenceIdsFor(fromBoth)).toContain(String(article.id));
    expect(documentaryLicenceIdsFor(fromBoth)).not.toContain(String(fixture.id));

    // Law: the whole file is never refused. The fixture still binds and still supports retrieval, so
    // "what does the probe assert?" reaches it.
    const bound = retrievalBinding(fixture, { requestText: "what does the apollo probe assert", sourceCodeEvidenceAllowed: true });
    expect(retrievalBindingSupports(bound)).toBe(true);
    // And the code the probe itself asserts is licensed by the very same span.
    const assertedSource = "landedOnMoon";
    expect(propositionAssertionalStance(fixture, assertedSource)).toBe("asserted");
    expect(candidateCommitmentsLicensed(inventory(assertedSource, [fixture]))).toBe(true);
  });

  it("never names an exhibiting span as the provenance of the surface it exhibits", async () => {
    const built = await corpus();
    const fixture = built.spanCarrying("lib/apollo.probe.ts", WORLD_FACT);
    const article = built.spanCarrying("lib/mission.ts", WORLD_FACT);
    const tidy = (value: string) => value.trim();

    // The realizer referenced the fixture, which is how a fixture title reached the citation surface.
    const cited = citedSpansForSurface([fixture, article], [String(fixture.id)], ANSWERING_SURFACE, tidy);
    expect(cited.map(span => String(span.id))).not.toContain(String(fixture.id));

    // A span that asserts the same surface is still cited when the realizer referenced it.
    const citedArticle = citedSpansForSurface([fixture, article], [String(article.id)], ANSWERING_SURFACE, tidy);
    expect(citedArticle.map(span => String(span.id))).toContain(String(article.id));
  });

  it("cannot license a claim about Einstein from a deliberately false control literal", async () => {
    const built = await corpus();
    const control = built.spanCarrying("lib/apollo.probe.ts", FALSE_CONTROL);
    expect(propositionAssertionalStance(control, FALSE_CONTROL)).toBe("exhibited");
    const probed = inventory(FALSE_CONTROL, [control]);
    expect(candidateCommitmentsLicensed(probed)).toBe(false);
    expect(authorityIdsFor(probed)).not.toContain(COMMITMENT_AUTHORITY_IDS.documentary);
  });

  it("treats an unmeasured span exactly as before, so unknown is never read as exhibited", async () => {
    const built = await corpus();
    // Prose the AST never measured. Its stance is unknown, and unknown licenses.
    const prose = built.spanCarrying("NOTES.md", WORLD_FACT);
    expect(propositionAssertionalStance(prose, WORLD_FACT)).toBe("unknown");
    expect(candidateCommitmentsLicensed(inventory(WORLD_FACT, [prose]))).toBe(true);
    expect(exhibitedHoldersFor(inventory(WORLD_FACT, [prose]))).not.toContain(String(prose.id));

    const fixture = built.spanCarrying("lib/apollo.probe.ts", WORLD_FACT);
    // The live corpus predates the measurement: strip the block and the span reports unknown, not exhibited.
    const unmeasured = withoutExhibitedMeasurement(fixture);
    expect(propositionAssertionalStance(unmeasured, WORLD_FACT)).toBe("unknown");
    const probed = inventory(WORLD_FACT, [unmeasured]);
    expect(candidateCommitmentsLicensed(probed)).toBe(true);
    expect(documentaryLicenceIdsFor(probed)).toContain(String(unmeasured.id));
    // Distinguishable at the consumer: an unmeasured span is never recorded as having exhibited anything.
    expect(exhibitedHoldersFor(probed)).not.toContain(String(unmeasured.id));
  });
});

function inventory(text: string, spans: readonly EvidenceSpan[]) {
  return candidateCommitmentInventory({
    text,
    evidenceTexts: spans.map(commitmentEvidenceText),
    conversationTurns: [],
    claimBases: [],
    closedClass: CLOSED_CLASS
  });
}

function authorityIdsFor(built: ReturnType<typeof candidateCommitmentInventory>): string[] {
  return built.units.filter(unit => unit.externallyMeaningful).map(unit => unit.authorityId);
}

function documentaryLicenceIdsFor(built: ReturnType<typeof candidateCommitmentInventory>): string[] {
  return built.units
    .filter(unit => unit.authorityId === COMMITMENT_AUTHORITY_IDS.documentary)
    .flatMap(unit => [...unit.licenceIds]);
}

function exhibitedHoldersFor(built: ReturnType<typeof candidateCommitmentInventory>): string[] {
  return built.units.flatMap(unit => [...unit.exhibitedByIds]);
}

function withoutExhibitedMeasurement(span: EvidenceSpan): EvidenceSpan {
  const provenance = { ...(span.provenance as Record<string, JsonValue>) };
  const metadata = { ...(provenance.metadata as Record<string, JsonValue>) };
  delete metadata.exhibitedContent;
  delete provenance.exhibitedContent;
  return { ...span, provenance: { ...provenance, metadata } as JsonValue };
}

/**
 * One repository holding both sides of the distinction: a file the project's own manifest declares a test,
 * whose world-fact sentences live inside literals, and an ordinary documentary note asserting the same
 * sentence. Built through the production walk and the production chunker, so the spans are the ones an
 * ingest would write.
 */
async function corpus(): Promise<{ spanCarrying: (uri: string, needle: string) => EvidenceSpan }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce-exhibited-commitment-"));
  roots.push(root);
  await writeFile(path.join(root, "vitest.config.ts"), [
    `import { defineConfig } from "vitest/config";`,
    `export default defineConfig({ test: { include: ["${DECLARED_TEST_GLOB}"] } });`
  ].join("\n"), "utf8");
  await mkdir(path.join(root, "lib"), { recursive: true });
  const files = new Map<string, string>([
    ["lib/apollo.probe.ts", probeSource()],
    ["lib/mission.ts", missionSource()],
    ["NOTES.md", [WORLD_FACT, "", "The mission is described in the paragraph above.", ""].join(SEPARATOR)]
  ]);
  for (const [uri, text] of files) await writeFile(path.join(root, uri), text, "utf8");

  const metadataByUri = new Map<string, JsonValue>();
  for await (const event of new NodeFileIngestAdapter(configFor(root)).streamPath(root)) {
    if (event.type === "file") metadataByUri.set(event.file.uri, event.file.metadata);
  }
  const spansByUri = new Map<string, EvidenceSpan[]>();
  for (const [uri, text] of files) spansByUri.set(uri, spansFor(uri, text, metadataByUri.get(uri)!));

  return {
    spanCarrying(uri: string, needle: string): EvidenceSpan {
      const found = (spansByUri.get(uri) ?? []).find(span => String(span.text).includes(needle));
      if (!found) throw new Error(`no span of ${uri} carried ${needle}`);
      return found;
    }
  };
}

/** A production source file whose documentary sentence lives in a comment, which the measurement excludes. */
function missionSource(): string {
  return [
    `/** ${WORLD_FACT} */`,
    `export function landedOnMoon(sentence: string): boolean {`,
    `  return sentence.length > 0;`,
    `}`,
    ``
  ].join(SEPARATOR);
}

function probeSource(): string {
  return [
    `import { describe, expect, it } from "vitest";`,
    `import { landedOnMoon } from "./apollo.js";`,
    ``,
    `const article = "${WORLD_FACT}";`,
    `const control = "${FALSE_CONTROL}";`,
    ``,
    `describe("landedOnMoon", () => {`,
    `  it("recognises the mission sentence", () => {`,
    `    expect(landedOnMoon(article)).toBe(true);`,
    `    expect(landedOnMoon(control)).toBe(false);`,
    `  });`,
    `});`,
    ``
  ].join("\n");
}

function spansFor(uri: string, text: string, metadata: JsonValue): EvidenceSpan[] {
  const clock = createClock({ fixedTime: 1_000 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({
    sourceVersionId: ids.sourceVersionId(Buffer.from(text, "utf8")),
    text,
    createdAt: 1_000
  });
  return createEvidenceExtractor({ idFactory: ids, hasher }).extract({
    sourceId: ids.sourceId("local-file", uri),
    sourceVersionId: ids.sourceVersionId(Buffer.from(text, "utf8")),
    namespace: "local-file",
    uri,
    mediaType: "text/plain",
    text,
    languageProfile: profile,
    sourceTrust: {
      identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
      independenceGroup: "fixture", accessScope: "owner_private", licenseStatus: "owner_authorized"
    },
    observedAt: 1_000,
    maxChunkBytes: 4096,
    metadata,
    exactSourceText: true
  }).spans;
}

function configFor(root: string): ScceRuntimeConfig {
  return {
    server: { url: "http://127.0.0.1:3873" },
    database: { url: "postgresql://fixture:fixture@127.0.0.1:5432/fixture", schema: "fixture" },
    runtime: {
      workspaceRoot: root,
      tempRoot: path.join(root, ".tmp"),
      maxFileBytes: 1024 * 1024,
      maxChunkBytes: 64 * 1024,
      allowedRoots: [root],
      excludedPaths: [],
      spreadsheet: { maxParseMs: 10_000, maxHeapMb: 192 },
      tools: {}
    },
    connectors: {},
    policy: {} as ScceRuntimeConfig["policy"]
  };
}
