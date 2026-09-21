// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  evidenceSourceDeclaredLicense,
  isLicenseDeclared,
  resolveSourceDeclaredLicense,
  type EvidenceSpan,
  type JsonValue,
  type LanguagePatternRecord,
  type LanguageProfile,
  type LanguageUnitRecord,
  type NgramModelRecord,
  type NgramObservation,
  type ScceEvent,
  type ScceStorage,
  type SemanticFrameRecord,
  type SourceVersion
} from "@scce/kernel";
import { dryRunEngineeringCorpusIngest } from "../engineering-corpus-folder.js";
import { trainOssCorpus } from "../oss-corpus.js";
import { createProjectLicenseIndex, readDeclaredLicense, summarizeDeclaredLicenses } from "../project-artifact-declarations.js";
import { blobContentHash } from "../postgres.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * The declared identifier names no licence family that appears anywhere in the fixture's own licence prose, so
 * an implementation that recognises a licence by matching wording rather than by reading the project's own
 * declaration cannot satisfy this file.
 */
const DECLARED_LICENSE = "BlueOak-1.0.0";
const MISLEADING_LICENSE_PROSE = [
  "The MIT License (MIT)",
  "",
  "Permission is hereby granted, free of charge, under the Apache License, Version 2.0 as well.",
  ""
].join("\n");

describe("a corpus's licence is read from its declaration, at the producer", () => {
  it("reads the declared identifier and never the licence file's prose", async () => {
    const root = await fixtureRoot("declared");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", license: DECLARED_LICENSE }), "utf8");
    await writeFile(path.join(root, "LICENSE"), MISLEADING_LICENSE_PROSE, "utf8");

    // The property this file exists for: the prose names other licences, and the declaration names this one.
    expect(MISLEADING_LICENSE_PROSE).toContain("MIT");
    expect(MISLEADING_LICENSE_PROSE).not.toContain(DECLARED_LICENSE);

    const resolution = await readDeclaredLicense(root);
    expect(resolution.license).toBe(DECLARED_LICENSE);
    expect(resolution.declaredBy).toBe("package_manifest");
    expect(resolution.declaration).toEqual([`package.json#license=${DECLARED_LICENSE}`]);
    // The licence file carries no identifier declaration, which is carried as a reason rather than as an answer.
    expect(resolution.unreadable.map(item => item.reason)).toContain("license-file-carries-no-spdx-identifier-declaration");
  });

  it("accepts an SPDX tag standing in the licence file's own leading block", async () => {
    const root = await fixtureRoot("spdx-tag");
    await writeFile(path.join(root, "LICENSE"), [`Copyright (c) 2026 Fixture`, `SPDX-License-Identifier: ${DECLARED_LICENSE}`, ``, MISLEADING_LICENSE_PROSE].join("\n"), "utf8");

    const resolution = await readDeclaredLicense(root);
    expect(resolution.license).toBe(DECLARED_LICENSE);
    expect(resolution.declaredBy).toBe("license_file");
  });

  it("refuses to adopt a tag an aggregate notice file quotes from a bundled component", async () => {
    const root = await fixtureRoot("aggregate");
    await writeFile(path.join(root, "LICENSE"), [
      "This project is licensed for use as follows:",
      MISLEADING_LICENSE_PROSE,
      "The bundled component is licensed as follows:",
      "",
      "  SPDX-License-Identifier: Unicode-3.0",
      ""
    ].join("\n"), "utf8");

    const resolution = await readDeclaredLicense(root);
    expect(isLicenseDeclared(resolution)).toBe(false);
    expect(resolution.license).toBe("");
    expect(resolution.unreadable.map(item => item.reason)).toContain("license-file-carries-no-spdx-identifier-declaration");
    // The quoted identifier is not destroyed: it is the bundled component's, and it is carried as an observation.
    expect(resolution.observations.map(item => item.license)).toContain("Unicode-3.0");
  });

  it("reports a project that declares nothing as undeclared rather than as permitted", async () => {
    const root = await fixtureRoot("undeclared");
    await writeFile(path.join(root, "index.ts"), "export const value = 1;\n", "utf8");

    const resolution = await readDeclaredLicense(root);
    expect(resolution).toMatchObject({ license: "", declaredBy: "none" });
    expect(isLicenseDeclared(resolution)).toBe(false);
  });

  it("reports a declaration format it has no parser for as unreadable, which is not a licence", async () => {
    const root = await fixtureRoot("reuse");
    await writeFile(path.join(root, "REUSE.toml"), `version = 1\n[[annotations]]\npath = "**"\nSPDX-License-Identifier = "${DECLARED_LICENSE}"\n`, "utf8");

    const resolution = await readDeclaredLicense(root);
    expect(isLicenseDeclared(resolution)).toBe(false);
    expect(resolution.unreadable.map(item => item.reason)).toContain("no-parser-for-manifest-format");
  });

  it("lets a nested package's own declaration govern its own files", async () => {
    const root = await fixtureRoot("nested");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "host", license: DECLARED_LICENSE }), "utf8");
    await mkdir(path.join(root, "vendored"), { recursive: true });
    await writeFile(path.join(root, "vendored", "package.json"), JSON.stringify({ name: "vendored", license: "Zlib" }), "utf8");
    await writeFile(path.join(root, "vendored", "bundled.ts"), "export const bundled = 1;\n", "utf8");
    await writeFile(path.join(root, "own.ts"), "export const own = 1;\n", "utf8");

    const index = createProjectLicenseIndex({ stopAt: root });
    expect((await index.licenseFor(path.join(root, "vendored", "bundled.ts"))).license).toBe("Zlib");
    expect((await index.licenseFor(path.join(root, "own.ts"))).license).toBe(DECLARED_LICENSE);
  });
});

describe("the declared licence survives to the evidence it licenses", () => {
  it("carries the declaration on the repository identity and on every trained span's provenance", async () => {
    const root = await fixtureRoot("trained");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", license: DECLARED_LICENSE }), "utf8");
    await writeFile(path.join(root, "LICENSE"), MISLEADING_LICENSE_PROSE, "utf8");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "README.md"), "Readable docs explain the pump API and the maintenance flow.", "utf8");
    await writeFile(path.join(root, "src", "pump.ts"), [
      "// Stabilize pump pressure before returning a status object.",
      "export function stabilizePumpPressure(input: number) {",
      "  return { pressureReading: input, stable: input > 0 };",
      "}"
    ].join("\n"), "utf8");
    const fixture = memoryStorage();

    const report = await trainOssCorpus({ storage: fixture.storage, rootPath: root, maxFiles: 10, maxFileBytes: 100_000, ngramMaxOrder: 3, ngramMaxCountersPerOrder: 64 });
    expect(report.filesSkipped.filter(item => item.reason.startsWith("training_failed"))).toEqual([]);
    expect(fixture.state.evidence.length).toBeGreaterThan(0);

    for (const source of fixture.state.sourceVersions) {
      const resolution = resolveSourceDeclaredLicense(source.metadata as JsonValue);
      expect(resolution.license).toBe(DECLARED_LICENSE);
      expect(resolution.declaredBy).toBe("package_manifest");
    }
    // A span answers the question on its own, without a join to something that may have moved.
    for (const span of fixture.state.evidence) {
      expect(evidenceSourceDeclaredLicense(span).license).toBe(DECLARED_LICENSE);
    }
    // The repository snapshot's own identity carries it too, next to the commit and snapshot hash.
    const repository = recordOf(recordOf(fixture.state.sourceVersions[0]!.metadata as JsonValue).repository);
    expect(resolveSourceDeclaredLicense({ license: repository.license } as JsonValue).license).toBe(DECLARED_LICENSE);
  });
});

describe("the dry run answers what licences an ingest is about to take in", () => {
  it("counts the files each declaration covers, and counts undeclared files as their own class", async () => {
    const root = await fixtureRoot("summary");
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "host", license: DECLARED_LICENSE }), "utf8");
    await writeFile(path.join(root, "one.ts"), "export const one = 1;\n", "utf8");
    await mkdir(path.join(root, "vendored"), { recursive: true });
    await writeFile(path.join(root, "vendored", "package.json"), JSON.stringify({ name: "vendored", license: "Zlib" }), "utf8");
    await writeFile(path.join(root, "vendored", "two.ts"), "export const two = 2;\n", "utf8");

    const summary = await summarizeDeclaredLicenses({ rootPath: root, files: ["one.ts", "vendored/two.ts"] });
    expect(summary.filesConsidered).toBe(2);
    expect(summary.filesWithDeclaredLicense).toBe(2);
    expect(summary.licenses.map(bucket => bucket.license).sort()).toEqual([DECLARED_LICENSE, "Zlib"].sort());
    expect(summary.licenses.flatMap(bucket => bucket.declarations)).toContain(`vendored/package.json#license=Zlib`);
    expect(summary.repository.license).toBe(DECLARED_LICENSE);

    const dryRun = await dryRunEngineeringCorpusIngest(root);
    expect(dryRun.licensing.schema).toBe("scce.declaredLicenseSummary.v1");
    expect(dryRun.licensing.repository.license).toBe(DECLARED_LICENSE);
    expect(dryRun.licensing.filesConsidered).toBe(dryRun.inspection.totals.filesImportable);
    const declared = new Map(dryRun.licensing.licenses.map(bucket => [bucket.license, bucket.files] as const));
    // The nested package's own manifest is itself one of its files, so its declaration covers both of them.
    expect(declared.get("Zlib")).toBe(2);
    expect(declared.get(DECLARED_LICENSE)).toBeGreaterThanOrEqual(1);
    // Report, never enforce: every importable file is still in the plan, whatever its licence class.
    expect(dryRun.fileProjections.length).toBeGreaterThanOrEqual(dryRun.inspection.totals.filesImportable);
  });

  it("names the undeclared class rather than leaving a repository's licence implicit", async () => {
    const root = await fixtureRoot("summary-undeclared");
    await writeFile(path.join(root, "one.ts"), "export const one = 1;\n", "utf8");

    const dryRun = await dryRunEngineeringCorpusIngest(root);
    expect(dryRun.licensing.filesWithDeclaredLicense).toBe(0);
    expect(dryRun.licensing.filesWithUndeclaredLicense).toBe(dryRun.licensing.filesConsidered);
    expect(dryRun.licensing.licenses.every(bucket => bucket.declaredBy === "none")).toBe(true);
  });
});

async function fixtureRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `scce-declared-license-${label}-`));
  roots.push(root);
  return root;
}

function recordOf(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

interface MemoryState {
  events: ScceEvent[];
  sourceVersions: SourceVersion[];
  evidence: EvidenceSpan[];
  profiles: LanguageProfile[];
  observations: NgramObservation[];
  models: NgramModelRecord[];
  units: LanguageUnitRecord[];
  patterns: LanguagePatternRecord[];
  frames: SemanticFrameRecord[];
}

function memoryStorage(): { storage: ScceStorage; state: MemoryState } {
  const state: MemoryState = { events: [], sourceVersions: [], evidence: [], profiles: [], observations: [], models: [], units: [], patterns: [], frames: [] };
  const storage = {
    events: {
      append: async (event: ScceEvent) => { state.events.push(event); },
      appendBatch: async (events: ScceEvent[]) => { state.events.push(...events); },
      readEpisode: async () => state.events,
      readRange: async () => state.events,
      latestLedgerHash: async () => state.events.at(-1)?.hash ?? ""
    },
    evidence: {
      putSourceVersion: async (source: SourceVersion) => { state.sourceVersions.push(source); },
      putEvidenceSpan: async (span: EvidenceSpan) => { state.evidence.push(span); },
      putEvidenceSpans: async (spans: readonly EvidenceSpan[]) => { state.evidence.push(...spans); },
      promoteEvidence: async (ids: EvidenceSpan["id"][]) => ids.length,
      getEvidence: async () => null,
      getEvidenceBatch: async () => [],
      searchEvidence: async () => [],
      sourceVersionsForEvidence: async () => []
    },
    model: {
      readModel: async () => ({ languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }),
      writeModel: async () => undefined,
      putLanguageProfile: async (profile: LanguageProfile) => { state.profiles.push(profile); },
      listLanguageProfiles: async () => state.profiles
    },
    languageMemory: {
      putNgramObservation: async (row: NgramObservation) => { state.observations.push(row); },
      putNgramObservationsBatch: async (rows: readonly NgramObservation[]) => { state.observations.push(...rows); },
      putNgramModel: async (row: NgramModelRecord) => { state.models.push(row); },
      putNgramModels: async (rows: readonly NgramModelRecord[]) => { state.models.push(...rows); },
      putLanguageUnit: async (row: LanguageUnitRecord) => { state.units.push(row); },
      putLanguageUnits: async (rows: readonly LanguageUnitRecord[]) => { state.units.push(...rows); },
      putLanguagePattern: async (row: LanguagePatternRecord) => { state.patterns.push(row); },
      putLanguagePatterns: async (rows: readonly LanguagePatternRecord[]) => { state.patterns.push(...rows); },
      putSemanticFrame: async (row: SemanticFrameRecord) => { state.frames.push(row); },
      putSemanticFrames: async (rows: readonly SemanticFrameRecord[]) => { state.frames.push(...rows); },
      putTranslationAlignment: async () => undefined,
      listNgramModels: async () => state.models,
      listNgramObservations: async () => state.observations,
      listLanguageUnits: async () => state.units,
      listLanguagePatterns: async () => state.patterns,
      listSemanticFrames: async () => state.frames,
      listTranslationAlignments: async () => []
    },
    init: async () => undefined,
    transaction: async <T>(fn: () => Promise<T>) => fn(),
    migrate: async () => undefined,
    verify: async () => ({ ok: true, tables: [], errors: [] }),
    stats: async () => ({}),
    close: async () => undefined,
    conversation: unusedStore(),
    ingestion: unusedStore(),
    graph: { getSlice: async () => ({ nodes: [], edges: [], hyperedges: [], bounded: true, query: {} }) },
    blobs: { put: async (bytes: Uint8Array) => blobContentHash(bytes) },
    quarantine: unusedStore(),
    proofs: unusedStore(),
    constructs: unusedStore(),
    capabilities: unusedStore(),
    forecasts: unusedStore(),
    benchmarks: unusedStore(),
    brainImports: unusedStore(),
    corrections: unusedStore(),
    localization: unusedStore(),
    flowCache: unusedStore(),
    selfRewrite: unusedStore(),
    workspace: unusedStore(),
    dialogueMemory: unusedStore()
  } as unknown as ScceStorage;
  return { storage, state };
}

function unusedStore(): Record<string, (...args: never[]) => Promise<unknown>> {
  return new Proxy({}, { get: () => async () => null }) as Record<string, (...args: never[]) => Promise<unknown>>;
}
