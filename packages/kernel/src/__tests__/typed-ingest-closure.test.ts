import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createTypedIngestProjector,
  observationContract,
  routeObservation,
  toJsonValue,
  type EvidenceSpan,
  type JsonValue,
  type Observation,
  type ObservationKind,
  type SourceId,
  type SourceVersionId
} from "../index.js";

describe("typed ingest closure", () => {
  const clock = createClock({ fixedTime: 42000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "typed-ingest-closure" });

  it("routes and contracts every typed observation kind explicitly", () => {
    const evidence = evidenceFor("closure://observation-kinds", "typed observation closure");
    const base = baseObservation(evidence);
    const observations = {
      language: { ...base, id: "obs_language", kind: "language", role: "prose", text: "Language observations are eligible for language memory.", features: ["language"] },
      document_structure: { ...base, id: "obs_doc", kind: "document_structure", structureKind: "paragraph", title: "Closure", textPreview: "A prose paragraph inside a structured document." },
      table: { ...base, id: "obs_table", kind: "table", datasetId: "dataset", tableId: "table", rowRange: [1, 4], columnRange: [1, 3], headers: ["timestamp", "value", "note"] },
      cell: { ...base, id: "obs_cell", kind: "cell", datasetId: "dataset", tableId: "table", row: 2, column: 2, header: "value", rawValue: 42, displayValue: "42" },
      measurement: { ...base, id: "obs_measurement", kind: "measurement", datasetId: "dataset", tableId: "table", measurementId: "m1", value: 42, unit: "ms", row: 2, column: 2 },
      formula: { ...base, id: "obs_formula", kind: "formula", datasetId: "dataset", tableId: "table", cellAddress: "B5", formula: "AVERAGE(B2:B4)", dependencies: ["B2:B4"], computedValue: "42" },
      schema: { ...base, id: "obs_schema", kind: "schema", datasetId: "dataset", tableId: "table", columns: [column("value", 1, "numeric")], keyCandidates: [], joinCandidates: [] },
      time_series: { ...base, id: "obs_series", kind: "time_series", datasetId: "dataset", tableId: "table", seriesId: "series", timestampColumn: "timestamp", valueColumn: "value", points: [{ t: "2026-01-01T00:00", value: 42 }] },
      figure: { ...base, id: "obs_figure", kind: "figure", figureId: "fig1", caption: "Figure 1: measurement trace.", page: 1, extractedLabels: ["measurement", "trace"] },
      log_event: { ...base, id: "obs_log", kind: "log_event", streamId: "log", sequence: 1, timestamp: "2026-01-01T00:00:00Z", severity: "warn", component: "api", message: "retry", attributes: { attempt: 2 } },
      code: { ...base, id: "obs_code", kind: "code", repoId: "repo", filePath: "src/app.ts", language: "extension:.ts", symbolGraph: { symbols: ["start"] }, dependencyGraph: { imports: ["runtime"] }, testGraph: { tests: ["starts"] }, buildGraph: { commands: ["build"] }, programGraph: { file: "src/app.ts" } },
      derived: { ...base, id: "obs_derived", kind: "derived", derivedKind: "column_profile", derivedFromObservationIds: ["obs_measurement"], claim: { column: "value" }, calculation: { method: "profile" } }
    } satisfies Record<ObservationKind, Observation>;

    const expectedKinds: ObservationKind[] = ["language", "document_structure", "table", "cell", "measurement", "formula", "schema", "time_series", "figure", "log_event", "code", "derived"];
    expect(new Set(expectedKinds).size).toBe(expectedKinds.length);
    expect(Object.keys(observations).sort()).toEqual([...expectedKinds].sort());

    for (const kind of expectedKinds) {
      const observation = observations[kind];
      const route = routeObservation(observation);
      const contract = observationContract(observation);
      expect(route.observationKind).toBe(kind);
      expect(route.durableStores).toContain("evidence");
      expect(contract.sourceRef.sourceVersionId).toBe(evidence.sourceVersionId);
      expect(contract.provenance).toEqual(observation.provenance);
      expect(contract.graphIntent.nodeKinds.length).toBeGreaterThan(0);
      expect(contract.proofEligibility.eligible).toBe(kind === "derived" ? true : route.proofEligible);
    }

    expect(routeObservation(observations.language).durableStores).toContain("language_memory");
    expect(routeObservation(observations.language).languageEligible).toBe(true);
    for (const kind of ["table", "measurement", "formula", "schema", "time_series", "log_event"] as const) {
      const route = routeObservation(observations[kind]);
      expect(route.durableStores).not.toContain("language_memory");
      expect(route.forbiddenStores).toContain("language_memory");
    }
    expect(routeObservation(observations.cell).forbiddenStores).toContain("language_memory");
    expect(routeObservation(observations.code).durableStores).toContain("program_graph");
    expect(routeObservation(observations.code).durableStores).not.toContain("language_memory");
    expect(observationContract(observations.derived).forceClass).toBe("derived_observation");
  });

  it("projects CSV and TSV as typed tables, measurements, time series, and language-only comment cells", () => {
    const csv = [
      "timestamp,duration_ms,temperature_c,comment",
      "2026-01-01T00:00,10,21.5,the baseline observation stayed stable and should be remembered as prose.",
      "2026-01-01T00:01,12,21.7,the second observation stayed within tolerance and should remain language eligible.",
      "2026-01-01T00:02,14,21.9,the third observation remained acceptable and describes the run in prose."
    ].join("\n");
    const tsv = [
      "timestamp\tvoltage_v\tcurrent_a\tcomment",
      "2026-01-01T00:00\t3.30\t0.20\tthe startup sample was stable and should be remembered as prose.",
      "2026-01-01T00:01\t3.31\t0.22\tthe steady sample stayed nominal and remains language eligible.",
      "2026-01-01T00:02\t3.32\t0.24\tthe loaded sample stayed nominal and describes the run in prose."
    ].join("\n");

    for (const projected of [
      projectText("closure://sample.csv", "text/csv", csv, {}),
      projectText("closure://sample.tsv", "text/tab-separated-values", tsv, {})
    ]) {
      expect(count(projected.observationCounts, "table")).toBe(1);
      expect(count(projected.observationCounts, "cell")).toBeGreaterThan(0);
      expect(count(projected.observationCounts, "schema")).toBe(1);
      expect(count(projected.observationCounts, "measurement")).toBeGreaterThan(0);
      expect(count(projected.observationCounts, "time_series")).toBeGreaterThan(0);
      expect(projected.suppressRawLanguageTraining).toBe(true);
      expect(projected.languageText).toContain("prose");
      expect(projected.languageText).not.toContain("timestamp,duration_ms");
      expect(projected.languageText).not.toContain("timestamp\tvoltage_v");
      const numericCell = projected.observations.find(observation => observation.kind === "cell" && observation.header?.includes("_"));
      expect(numericCell?.kind).toBe("cell");
      if (numericCell?.kind !== "cell") throw new Error("numeric cell observation missing");
      expect(routeObservation(numericCell).forbiddenStores).toContain("language_memory");
      const table = projected.observations.find(observation => observation.kind === "table");
      expect(table?.kind).toBe("table");
      if (table?.kind === "table") expect(table.headers.length).toBeGreaterThan(1);
    }
  });

  it("projects workbook metadata formulas without turning formulas or numeric cells into prose", () => {
    const projected = projectText("closure://workbook.fixture.json", "application/vnd.scce.workbook+json", "", {
      typedExtraction: {
        workbook: {
          sheets: [{
            name: "Measurements",
            rows: [
              ["timestamp", "duration_ms", "note"],
              ["2026-01-01T00:00", 10, "baseline measurement stayed stable"],
              ["2026-01-01T00:01", 12, "steady measurement stayed stable"],
              ["2026-01-01T00:02", 14, "loaded measurement stayed stable"]
            ],
            formulas: [{ address: "B5", row: 5, column: 2, formula: "AVERAGE(B2:B4)", displayValue: "12", dependencies: ["B2:B4"] }]
          }]
        }
      }
    });
    const formula = projected.observations.find(observation => observation.kind === "formula");
    expect(formula?.kind).toBe("formula");
    if (formula?.kind !== "formula") throw new Error("formula observation missing");
    expect(formula.dependencies).toEqual(["B2:B4"]);
    expect(routeObservation(formula).durableStores).toContain("computation_graph");
    expect(count(projected.observationCounts, "table")).toBe(1);
    expect(count(projected.observationCounts, "measurement")).toBeGreaterThan(0);
    expect(count(projected.observationCounts, "schema")).toBe(1);
    const numericCell = projected.observations.find(observation => observation.kind === "cell" && observation.header === "duration_ms");
    expect(numericCell?.kind).toBe("cell");
    if (numericCell?.kind !== "cell") throw new Error("numeric workbook cell observation missing");
    expect(routeObservation(numericCell).forbiddenStores).toContain("language_memory");
    expect(projected.languageText).not.toContain("AVERAGE");
  });

  it("preserves a missing formula cache instead of inventing a value from display text", () => {
    const projected = projectText("closure://missing-cache.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "", {
      typedExtraction: {
        workbook: {
          sheets: [{
            name: "No Cache",
            range: { start: { row: 1, column: 1 }, end: { row: 2, column: 2 } },
            rows: [["input", "result"], [3, null]],
            formulas: [{
              address: "B2",
              row: 2,
              column: 2,
              formula: "A2*2",
              displayValue: "stale-display-must-not-be-used",
              computedValue: null,
              cachedValueStatus: "missing",
              dependencies: ["A2"]
            }]
          }]
        }
      }
    });
    const formula = projected.observations.find(observation => observation.kind === "formula");
    expect(formula?.kind).toBe("formula");
    if (formula?.kind !== "formula") throw new Error("missing-cache formula observation missing");
    expect(formula.computedValue).toBeNull();
    expect(formula.metadata).toMatchObject({ cachedValueStatus: "missing", formulaEvaluation: false });
    const formulaCell = projected.observations.find(observation => observation.kind === "cell" && observation.column === 2);
    expect(formulaCell?.metadata).toMatchObject({ cachedFormulaValue: "missing" });
  });

  it("preserves non-A1 workbook coordinates and narrows cell and formula evidence to their serialized spans", () => {
    const uri = "closure://offset-workbook.xlsx";
    const preface = "🧪 normalized workbook preface";
    const dataLine = "['Quarter O''Brien'!AA6]\tstring\twidget";
    const formulaLine = "['Quarter O''Brien'!AB6]\tformula\t=AA6*2\tcached=14";
    const text = [preface, dataLine, formulaLine].join("\n");
    const dataStart = codePointLength(`${preface}\n`);
    const dataEnd = dataStart + codePointLength(dataLine);
    const formulaStart = dataEnd + 1;
    const formulaEnd = formulaStart + codePointLength(formulaLine);
    const whole = evidenceFor(uri, text, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const dataEvidence = evidenceRange(whole, dataStart, dataEnd);
    const formulaEvidence = evidenceRange(whole, formulaStart, formulaEnd);
    const projected = createTypedIngestProjector({ idFactory: ids, hasher }).project({
      sourceId: whole.sourceId,
      sourceVersionId: whole.sourceVersionId,
      uri,
      mediaType: whole.mediaType,
      text,
      metadata: toJsonValue({
        typedExtraction: {
          workbook: {
            sheets: [{
              name: "Quarter O'Brien",
              range: { ref: "AA5:AB6", start: { row: 5, column: 27 }, end: { row: 6, column: 28 } },
              rows: [["item", "total"], ["widget", 14]],
              cellSpans: [
                { address: "AA6", row: 6, column: 27, cellType: "string", charStart: dataStart, charEnd: dataEnd },
                { address: "AB6", row: 6, column: 28, cellType: "formula", charStart: formulaStart, charEnd: formulaEnd }
              ],
              formulas: [{
                address: "AB6",
                row: 6,
                column: 28,
                formula: "AA6*2",
                displayValue: "14",
                computedValue: 14,
                dependencies: ["AA6"],
                charStart: formulaStart,
                charEnd: formulaEnd
              }]
            }]
          }
        }
      }),
      evidence: [dataEvidence, formulaEvidence],
      observedAt: clock.now()
    });

    const table = projected.observations.find(observation => observation.kind === "table");
    expect(table?.kind).toBe("table");
    if (table?.kind !== "table") throw new Error("offset workbook table missing");
    expect(table.rowRange).toEqual([5, 6]);
    expect(table.columnRange).toEqual([27, 28]);

    const dataCell = projected.observations.find(observation => observation.kind === "cell" && observation.rawValue === "widget");
    expect(dataCell?.kind).toBe("cell");
    if (dataCell?.kind !== "cell") throw new Error("offset workbook data cell missing");
    expect(dataCell).toMatchObject({ row: 6, column: 27, address: "'Quarter O''Brien'!AA6" });
    expect(dataCell.evidenceIds).toEqual([dataEvidence.id]);

    const formulaCell = projected.observations.find(observation => observation.kind === "cell" && observation.column === 28);
    expect(formulaCell?.kind).toBe("cell");
    if (formulaCell?.kind !== "cell") throw new Error("offset workbook formula cell missing");
    expect(formulaCell.address).toBe("'Quarter O''Brien'!AB6");
    expect(formulaCell.formulaRef).toBe("'Quarter O''Brien'!AB6");
    expect(formulaCell.evidenceIds).toEqual([formulaEvidence.id]);

    const formula = projected.observations.find(observation => observation.kind === "formula");
    expect(formula?.kind).toBe("formula");
    if (formula?.kind !== "formula") throw new Error("offset workbook formula observation missing");
    expect(formula.cellAddress).toBe("'Quarter O''Brien'!AB6");
    expect(formula.dependencies).toEqual(["AA6"]);
    expect(formula.evidenceIds).toEqual([formulaEvidence.id]);
  });

  it("projects document metadata tables, figures, captions, pages, and prose without text-soup collapse", () => {
    const metadata = {
      structure: {
        headings: [{ text: "Closure Report", page: 1 }],
        sections: [{ title: "Findings", text: "The document section explains the result in prose." }],
        paragraphs: [{ text: "The paragraph carries language eligible content for the document." }],
        pages: [{ number: 1, text: "Page block provenance remains visible." }],
        tables: [{
          label: "Acceptance Table",
          page: 1,
          rows: [
            ["timestamp", "score", "note"],
            ["2026-01-01T00:00", 0.91, "first documented measurement"],
            ["2026-01-01T00:01", 0.93, "second documented measurement"],
            ["2026-01-01T00:02", 0.95, "third documented measurement"]
          ]
        }],
        figures: [{ id: "fig-a", caption: "Figure A: acceptance curve.", page: 1, extractedLabels: ["acceptance", "curve"] }]
      }
    };
    for (const mediaType of ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) {
      const projected = projectText(`closure://report.${mediaType.includes("pdf") ? "pdf" : "docx"}`, mediaType, "", metadata);
      expect(count(projected.observationCounts, "document_structure")).toBeGreaterThan(0);
      expect(count(projected.observationCounts, "language")).toBeGreaterThan(0);
      expect(count(projected.observationCounts, "table")).toBe(1);
      expect(count(projected.observationCounts, "figure")).toBe(1);
      expect(projected.languageText).toContain("paragraph carries language");
      expect(projected.languageText).not.toContain("timestamp,score,note");
      const figure = projected.observations.find(observation => observation.kind === "figure");
      expect(figure?.kind).toBe("figure");
      if (figure?.kind !== "figure") throw new Error("figure observation missing");
      expect(routeObservation(figure).durableStores).toContain("language_memory");
      const page = projected.observations.find(observation => observation.kind === "document_structure" && observation.structureKind === "page");
      expect(page?.kind).toBe("document_structure");
      if (page?.kind === "document_structure") expect(page.pageRange).toEqual([1, 1]);
    }
  });

  it("parses log lines structurally and never treats raw logs as paragraph language", () => {
    const logText = [
      "2026-01-01T00:00:00Z INFO api message text",
      "[2026-01-01T00:00:02Z] [WARN] [sensor] calibration drift=0.02",
      "timestamp=2026-01-01T00:00:03Z component=worker severity=debug message=\"worker retried\" attempts=2",
      "{\"timestamp\":\"2026-01-01T00:00:04Z\",\"level\":\"error\",\"component\":\"api\",\"message\":\"handler retry\",\"attempt\":3}"
    ].join("\n");
    const projected = projectText("closure://app.log", "application/vnd.scce.engineering-log", logText, {});
    const logs = projected.observations.filter(observation => observation.kind === "log_event");
    expect(logs).toHaveLength(4);
    expect(count(projected.observationCounts, "language")).toBe(0);
    expect(projected.languageText).toBe("");
    expect(logs[0]).toMatchObject({ timestamp: "2026-01-01T00:00:00Z", severity: "info", component: "api" });
    expect(logs[1]).toMatchObject({ timestamp: "2026-01-01T00:00:02Z", severity: "warn", component: "sensor" });
    expect(logs[2]).toMatchObject({ timestamp: "2026-01-01T00:00:03Z", severity: "debug", component: "worker", message: "worker retried" });
    expect(logs[3]).toMatchObject({ timestamp: "2026-01-01T00:00:04Z", severity: "error", component: "api", message: "handler retry" });
    for (const log of logs) {
      const route = routeObservation(log);
      expect(route.durableStores).toContain("event_graph");
      expect(route.forbiddenStores).toContain("language_memory");
    }
  });

  function projectText(uri: string, mediaType: string, text: string, metadata: JsonValue) {
    const evidence = evidenceFor(uri, text || uri, mediaType);
    return createTypedIngestProjector({ idFactory: ids, hasher }).project({
      sourceId: evidence.sourceId,
      sourceVersionId: evidence.sourceVersionId,
      uri,
      mediaType,
      text,
      metadata: toJsonValue(metadata),
      evidence: [evidence],
      observedAt: clock.now()
    });
  }

  function evidenceFor(uri: string, text: string, mediaType = "text/plain"): EvidenceSpan {
    const sourceId = ids.sourceId("typed-ingest-closure", uri);
    const sourceVersionId = ids.sourceVersionId(text);
    const contentHash = ids.contentHash(text);
    return {
      id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: text.length, spanHash: contentHash }),
      sourceId,
      sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: text.length, chunkHash: contentHash }),
      contentHash,
      mediaType,
      byteStart: 0,
      byteEnd: text.length,
      charStart: 0,
      charEnd: text.length,
      text,
      textPreview: text.slice(0, 200),
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: 1 },
      provenance: toJsonValue({ uri }),
      features: [],
      status: "promoted",
      alpha: 1,
      observedAt: clock.now()
    };
  }

  function evidenceRange(evidence: EvidenceSpan, charStart: number, charEnd: number): EvidenceSpan {
    const codePoints = [...evidence.text];
    const prefix = codePoints.slice(0, charStart).join("");
    const text = codePoints.slice(charStart, charEnd).join("");
    const byteStart = new TextEncoder().encode(prefix).byteLength;
    const byteEnd = byteStart + new TextEncoder().encode(text).byteLength;
    const contentHash = ids.contentHash(text);
    return {
      ...evidence,
      id: ids.evidenceId({ sourceVersionId: evidence.sourceVersionId, byteStart, byteEnd, spanHash: contentHash }),
      chunkId: ids.chunkId({ sourceVersionId: evidence.sourceVersionId, byteStart, byteEnd, chunkHash: contentHash }),
      contentHash,
      byteStart,
      byteEnd,
      charStart,
      charEnd,
      text,
      textPreview: text
    };
  }

  function codePointLength(text: string): number {
    return [...text].length;
  }

  function baseObservation(evidence: EvidenceSpan): {
    sourceId: SourceId;
    sourceVersionId: SourceVersionId;
    evidenceIds: EvidenceSpan["id"][];
    confidence: number;
    provenance: JsonValue;
    metadata: JsonValue;
  } {
    return {
      sourceId: evidence.sourceId,
      sourceVersionId: evidence.sourceVersionId,
      evidenceIds: [evidence.id],
      confidence: 0.8,
      provenance: toJsonValue({ uri: "closure://observation-kinds" }),
      metadata: toJsonValue({ source: "typed-ingest-closure" })
    };
  }

  function column(name: string, index: number, typeCandidate: "numeric" | "text") {
    return {
      name,
      index,
      typeCandidate,
      count: 3,
      missingCount: 0,
      distinctCount: 3,
      topValues: [],
      unitCandidates: [],
      parseFailures: 0,
      anomalyCandidates: [],
      naturalLanguageLikelihood: typeCandidate === "text" ? 0.8 : 0
    };
  }

  function count(record: Record<string, number>, key: string): number {
    return record[key] ?? 0;
  }
});
