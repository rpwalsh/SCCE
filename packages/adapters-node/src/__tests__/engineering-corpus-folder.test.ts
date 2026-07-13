import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dryRunEngineeringCorpusIngest, inspectEngineeringCorpusFolder, routeEngineeringCorpusFixture } from "../engineering-corpus-folder.js";

describe("engineering corpus folder runtime", () => {
  it("inspects a source-only engineering folder without database or server mutation", async () => {
    const root = await createEngineeringFixture();
    try {
      const inspection = await inspectEngineeringCorpusFolder(root);
      expect(inspection.schema).toBe("scce.engineeringCorpusFolderInspection.v1");
      expect(inspection.totals.filesFound).toBeGreaterThanOrEqual(8);
      expect(inspection.totals.filesImportable).toBeGreaterThanOrEqual(8);
      expect(inspection.extractors.csv_table).toBe(1);
      expect(inspection.extractors.tsv_table).toBe(1);
      expect(inspection.extractors.structured_json).toBe(1);
      expect(inspection.extractors.structured_json_lines).toBe(1);
      expect(inspection.extractors.workbook_metadata_fixture).toBe(1);
      expect(inspection.extractors.document_metadata_fixture).toBe(1);
      expect(inspection.extractors.engineering_log).toBe(1);
      expect(inspection.extractors.package_lock).toBe(1);
      expect(inspection.extractors.structural_source_code).toBeGreaterThanOrEqual(1);
      expect(inspection.files.every(file => file.importable ? Boolean(file.contentHash) : true)).toBe(true);
      expect(inspection.files.map(file => file.path)).not.toContain("archives/review.zip");
      expect(inspection.skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "archives/review.zip", reason: "archive_file" })
      ]));
      expect(inspection.readPlan.importableFileCount).toBe(inspection.totals.filesImportable);
      expect(inspection.readPlan.hashChunkBytes).toBeGreaterThan(0);
      expect(inspection.readPlan.estimatedResidentCeilingBytes).toBeLessThanOrEqual(inspection.limits.maxFileBytes + inspection.readPlan.hashChunkBytes + inspection.readPlan.textChunkBytes * 2);
      expect(inspection.warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes typed observations across docs, tables, formulas, logs, and code while blocking raw numeric/log/code language training", async () => {
    const root = await createEngineeringFixture();
    try {
      const report = await routeEngineeringCorpusFixture(root);
      expect(report.schema).toBe("scce.engineeringCorpusFolderRuntime.v1");
      expect(report.dryRun).toBe(true);
      expect(report.mutation).toEqual({ postgres: false, filesystemWrites: false, serverStarted: false });
      for (const kind of [
        "language",
        "document_structure",
        "table",
        "cell",
        "formula",
        "schema",
        "measurement",
        "time_series",
        "figure",
        "log_event",
        "code",
        "derived"
      ]) {
        expect(report.observations.byKind[kind]).toBeGreaterThan(0);
      }
      expect(report.routes.durableStores.language_memory).toBeGreaterThan(0);
      expect(report.routes.durableStores.data_graph).toBeGreaterThan(0);
      expect(report.routes.durableStores.computation_graph).toBeGreaterThan(0);
      expect(report.routes.durableStores.event_graph).toBeGreaterThan(0);
      expect(report.routes.durableStores.program_graph).toBeGreaterThan(0);
      expect(report.routes.forbiddenStores.language_memory).toBeGreaterThan(0);
      expect(report.routes.graphNodeKinds.log_event).toBeGreaterThan(0);
      expect(report.routes.graphNodeKinds.formula).toBeGreaterThan(0);
      expect(report.routes.graphNodeKinds.repo).toBeGreaterThan(0);
      expect(report.fileProjections.some(file => file.path === "README.md" && (file.observationCounts.language ?? 0) > 0 && (file.observationCounts.table ?? 0) > 0)).toBe(true);
      expect(report.fileProjections.some(file => file.path === "data/records.json" && (file.observationCounts.table ?? 0) > 0 && (file.observationCounts.schema ?? 0) > 0)).toBe(true);
      expect(report.fileProjections.some(file => file.path === "data/events.ndjson" && (file.observationCounts.table ?? 0) > 0 && (file.observationCounts.measurement ?? 0) > 0)).toBe(true);
      expect(report.fileProjections.some(file => file.path === "logs/app.log" && (file.forbiddenStores.language_memory ?? 0) > 0 && (file.durableStores.event_graph ?? 0) > 0)).toBe(true);
      expect(report.fileProjections.some(file => file.path === "docs/workbook.fixture.json" && (file.durableStores.computation_graph ?? 0) > 0)).toBe(true);
      expect(report.routeAudit.passed).toBe(true);
      expect(report.routeAudit.issues).toEqual([]);
      expect(report.routeAudit.invariants.some(item => item.code === "logs_block_raw_language_memory" && item.passed)).toBe(true);
      expect(report.engineering.packageManagers.length).toBeGreaterThan(0);
      expect(report.engineering.packageManagers).toContain("pnpm");
      expect(JSON.stringify(report.engineering.commandCandidates)).toContain("build");
      expect(JSON.stringify(report.engineering.commandCandidates)).toContain("test");
      expect(JSON.stringify(report.engineering.entrypointCandidates)).toContain("src/app.ts");

      const dryRun = await dryRunEngineeringCorpusIngest(root);
      expect(dryRun.observations.byKind).toEqual(report.observations.byKind);
      expect(dryRun.mutation.postgres).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function createEngineeringFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce-phase4-corpus-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(root, "logs"), { recursive: true });
  await mkdir(path.join(root, "docs"), { recursive: true });
  await mkdir(path.join(root, "archives"), { recursive: true });
  await writeFile(path.join(root, "README.md"), [
    "# Field Workbench",
    "",
    "This fixture describes a small typed engineering corpus for route inspection.",
    "It includes prose, code, tabular measurements, workbook metadata, document metadata, and runtime log events.",
    "",
    "| section | status | note |",
    "| --- | --- | --- |",
    "| typed ingest | active | table inside markdown should become structured observations |"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "phase4-fixture",
    version: "1.0.0",
    scripts: {
      build: "tsc -p tsconfig.json",
      test: "vitest run",
      dev: "vite --host 127.0.0.1"
    },
    dependencies: {
      "@example/runtime": "^1.2.3"
    },
    devDependencies: {
      vitest: "^3.2.0",
      typescript: "^5.8.0"
    }
  }, null, 2), "utf8");
  await writeFile(path.join(root, "pnpm-lock.yaml"), [
    "lockfileVersion: '9.0'",
    "importers:",
    "  .:",
    "    dependencies:",
    "      '@example/runtime':",
    "        specifier: ^1.2.3",
    "        version: 1.2.3"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "src", "app.ts"), [
    "import { createServer } from '@example/runtime';",
    "export interface WorkbenchState { ready: boolean }",
    "export class FieldWorkbench {",
    "  start() { return createServer().get('/api/field', handler); }",
    "}",
    "export function renderWorkbench(state: WorkbenchState) { return state.ready; }",
    "test('renders field workbench', () => renderWorkbench({ ready: true }));"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "data", "sample.csv"), [
    "timestamp,temperature_c,pressure_kpa,note",
    "2026-01-01T00:00,21.5,101.2,baseline observation was stable",
    "2026-01-01T00:01,21.8,101.3,minor rise observed",
    "2026-01-01T00:02,22.1,101.4,measurement remained inside tolerance"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "data", "sample.tsv"), [
    "timestamp\tvoltage_v\tcurrent_a\tcomment",
    "2026-01-01T00:00\t3.30\t0.20\tstartup sample",
    "2026-01-01T00:01\t3.31\t0.22\tsteady sample",
    "2026-01-01T00:02\t3.32\t0.24\tloaded sample"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "data", "records.json"), JSON.stringify({
    records: [
      { timestamp: "2026-01-01T00:00", torque_nm: 10.5, station: "alpha", note: "json record baseline" },
      { timestamp: "2026-01-01T00:01", torque_nm: 10.8, station: "alpha", note: "json record steady" },
      { timestamp: "2026-01-01T00:02", torque_nm: 11.2, station: "beta", note: "json record loaded" }
    ],
    metadata: { source: "synthetic fixture", kind: "object array table" }
  }, null, 2), "utf8");
  await writeFile(path.join(root, "data", "events.ndjson"), [
    "{\"timestamp\":\"2026-01-01T00:00\",\"latency_ms\":31,\"component\":\"ui\",\"message\":\"first record\"}",
    "{\"timestamp\":\"2026-01-01T00:01\",\"latency_ms\":29,\"component\":\"api\",\"message\":\"second record\"}",
    "{\"timestamp\":\"2026-01-01T00:02\",\"latency_ms\":33,\"component\":\"api\",\"message\":\"third record\"}"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "logs", "app.log"), [
    "2026-01-01T00:00:00Z INFO field service=api message=started request_id=abc",
    "[2026-01-01T00:00:02Z] [WARN] [sensor] calibration drift=0.02",
    "{\"timestamp\":\"2026-01-01T00:00:03Z\",\"level\":\"error\",\"component\":\"api\",\"message\":\"handler retry\",\"attempt\":2}"
  ].join("\n"), "utf8");
  await writeFile(path.join(root, "docs", "report.fixture.json"), JSON.stringify({
    schema: "scce.fixture.document.v1",
    mediaType: "application/pdf",
    text: "Field report summary. The instrument stayed inside the acceptance envelope during the fixture run.",
    structure: {
      headings: [{ text: "Field Report", page: 1 }],
      paragraphs: [{ text: "The report explains the measurement envelope and the calibration result." }],
      sections: [{ title: "Calibration", text: "Calibration remained stable across the observed interval." }],
      pages: [{ number: 1, text: "A page-level preview is available for inspection." }],
      figures: [{ id: "fig-1", caption: "Figure 1: temperature and pressure traces", page: 1, extractedLabels: ["temperature", "pressure"] }]
    }
  }, null, 2), "utf8");
  await writeFile(path.join(root, "docs", "workbook.fixture.json"), JSON.stringify({
    schema: "scce.fixture.workbook.v1",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    workbook: {
      sheets: [{
        name: "Measurements",
        rows: [
          ["timestamp", "value", "unit", "status"],
          ["2026-01-01T00:00", 10, "ms", "nominal sample"],
          ["2026-01-01T00:01", 12, "ms", "nominal sample"],
          ["2026-01-01T00:02", 14, "ms", "nominal sample"]
        ],
        formulas: [{ address: "B5", row: 5, column: 2, formula: "AVERAGE(B2:B4)", displayValue: "12", dependencies: ["B2:B4"] }]
      }]
    }
  }, null, 2), "utf8");
  await writeFile(path.join(root, "archives", "review.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
  return root;
}
