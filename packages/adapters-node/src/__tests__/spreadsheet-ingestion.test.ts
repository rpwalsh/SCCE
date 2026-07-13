import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import type {
  IngestInput,
  JsonValue,
  WorkspaceRecord,
  WorkspaceReportRecord,
  WorkspaceSourceFileRecord,
  WorkspaceStore
} from "@scce/kernel";
import type { ScceRuntimeConfig } from "../config.js";
import { extractDocument } from "../document.js";
import { dryRunEngineeringCorpusIngest, inspectEngineeringCorpusFolder } from "../engineering-corpus-folder.js";
import { NodeFileIngestAdapter } from "../files.js";
import type { NodeScceRuntime } from "../runtime.js";
import { parseWorkbookBytes } from "../spreadsheet-parser.js";
import { createWorkspaceRuntime } from "../workspace-runtime.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("bounded spreadsheet ingestion", () => {
  it.each(["xlsx", "xlsm", "xls"] as const)("parses real %s workbooks with sheets, typed cells, merges, and security disclosure", bookType => {
    const parsed = parseWorkbookBytes(workbookBytes(bookType), `public-review-fixture.${bookType}`);
    const workbook = parsed.typedExtraction.workbook;
    expect(workbook.sourceFormat).toBe(bookType);
    expect(workbook.complete).toBe(true);
    expect(workbook.sheets.map(sheet => sheet.name)).toEqual(["Sales Data", "다국어"]);
    expect(workbook.sheets[1]?.state).toBe("hidden");
    const sales = workbook.sheets[0]!;
    expect(sales.rows[1]?.slice(0, 6)).toEqual(["2026-07-12T00:00:00.000Z", 2, 5, 10, true, "#DIV/0!"]);
    expect(sales.mergedRanges).toContainEqual({ range: "A4:B4", start: "A4", end: "B4" });
    if (bookType === "xls") {
      // The SheetJS BIFF writer used to construct this ephemeral fixture stores the
      // cached value but does not emit the source formula. The reader must not invent it.
      expect(sales.formulas).toEqual([]);
      expect(parsed.text).toContain("['Sales Data'!D2]\tnumber\t10");
    } else {
      expect(sales.formulas).toEqual(expect.arrayContaining([
        expect.objectContaining({
          address: "D2",
          row: 2,
          column: 4,
          formula: "B2*C2",
          computedValue: 10,
          cachedValueStatus: "stored-unverified",
          dependencies: ["B2", "C2"]
        })
      ]));
      expect(parsed.text).toContain("['Sales Data'!D2]\tformula\t=B2*C2\tcached=10");
    }
    expect(workbook.security).toMatchObject({
      formulaEvaluation: false,
      cachedFormulaValues: "stored-unverified",
      macroExecution: false,
      macroPayloadExposed: false,
      externalLinkResolution: false,
      externalLinkPayloadExposed: false,
      embeddedObjectPayloadExposed: false,
      archivePayloadValidation: bookType === "xls" ? "not-applicable" : "inflated-bounded",
      htmlRendering: false,
      encryptedWorkbookAccepted: false
    });
  });

  it("fails closed when workbook or archive limits are exceeded", () => {
    const bytes = workbookBytes("xlsx");
    expect(() => parseWorkbookBytes(bytes, "bounded.xlsx", { maxSourceBytes: bytes.length - 1 })).toThrow(/spreadsheet source has .* limit/);
    expect(() => parseWorkbookBytes(bytes, "bounded.xlsx", { maxRowsPerSheet: 2 })).toThrow(/row 3 exceeds 2/);
    expect(() => parseWorkbookBytes(bytes, "bounded.xlsx", { maxDenseCells: 10 })).toThrow(/dense projection has more than 10 cells/);
    expect(() => parseWorkbookBytes(bytes, "bounded.xlsx", { maxMergedRanges: 1 })).toThrow(/more than 1 merged ranges/);
    expect(() => parseWorkbookBytes(bytes, "bounded.xlsx", { maxArchiveUncompressedBytes: 512 })).toThrow(/expands beyond 512 bytes/);
    expect(() => parseWorkbookBytes(bytes, "bounded.xlsx", { maxArchiveCompressionRatio: 1 })).toThrow(/entry compression ratio/);
    const mismatchedLocalHeader = Buffer.from(bytes);
    mismatchedLocalHeader[30] = (mismatchedLocalHeader[30] ?? 0) ^ 1;
    expect(() => parseWorkbookBytes(mismatchedLocalHeader, "tampered.xlsx")).toThrow(/local and central entry names disagree/);
    expect(() => parseWorkbookBytes(forgeFirstZipEntryUncompressedSize(bytes), "forged-size.xlsx")).toThrow(/bounded inflation|inflated to/);
    expect(() => parseWorkbookBytes(addZip64CentralExtra(bytes), "zip64-extra.xlsx")).toThrow(/ZIP64 workbook entries/);
    expect(() => parseWorkbookBytes(Buffer.from("not an OOXML package"), "fake.xlsx")).toThrow(/not a ZIP container/);
    expect(() => parseWorkbookBytes(Buffer.from("not an OLE file"), "fake.xls")).toThrow(/not an OLE Compound File/);
  });

  it("rejects extension/content-type mismatches and foreign spreadsheet polyglots", () => {
    const bytes = workbookBytes("xlsx");
    expect(() => parseWorkbookBytes(bytes, "renamed.xlsm")).toThrow(/xlsm workbook content type mismatch/);
    expect(() => parseWorkbookBytes(addForeignArchiveMarker(bytes), "polyglot.xlsx")).toThrow(/foreign spreadsheet marker/);
    expect(() => parseWorkbookBytes(addSecondWorkbookMainPart(bytes), "multiple-main.xlsx")).toThrow(/exactly one workbook main part/);
    expect(() => parseWorkbookBytes(addXmlComment(bytes), "xml-comment.xlsx")).toThrow(/uses unsupported declaration, comment/);
    expect(() => parseWorkbookBytes(changeWorksheetContentTypeOnly(bytes), "hybrid-sheet.xlsx")).toThrow(/must declare exactly one supported worksheet content type/);
    expect(() => parseWorkbookBytes(unsupportedSheetWorkbookBytes(), "macro-sheet.xlsx")).toThrow(/unsupported type .*xlMacrosheet/);
  });

  it("uses actual cell coordinates when an OOXML dimension underdeclares the sheet", () => {
    const parsed = parseWorkbookBytes(underdeclaredDimensionWorkbookBytes(), "underdeclared.xlsx");
    const sales = parsed.typedExtraction.workbook.sheets[0]!;
    expect(sales.range.end.address).toBe("F4");
    expect(sales.rows[1]?.slice(0, 6)).toEqual(["2026-07-12T00:00:00.000Z", 2, 5, 10, true, "#DIV/0!"]);
    expect(() => parseWorkbookBytes(outOfWindowUnderdeclaredWorkbookBytes(), "underdeclared-far.xlsx")).toThrow(/row 5000 exceeds 2000/);
    expect(() => parseWorkbookBytes(customTargetUnderdeclaredWorkbookBytes(), "custom-target.xlsx")).toThrow(/noncanonical target/);
  });

  it("preserves an offset worksheet range and rejects merge coordinates outside the contract", () => {
    const parsed = parseWorkbookBytes(offsetWorkbookBytes(), "offset.xlsx");
    const sheet = parsed.typedExtraction.workbook.sheets[0]!;
    expect(sheet.range).toMatchObject({ start: { row: 5, column: 27, address: "AA5" }, end: { row: 6, column: 28, address: "AB6" } });
    expect(sheet.rows).toEqual([["item", "total"], ["widget", 14]]);
    expect(() => parseWorkbookBytes(oversizedMergeWorkbookBytes(), "oversized-merge.xlsx")).toThrow(/merged range .* exceeds configured coordinates/);
  });

  it("escapes control characters in evidence labels while preserving the raw sheet name", () => {
    const parsed = parseWorkbookBytes(controlNameWorkbookBytes(), "control-name.xlsx");
    expect(parsed.typedExtraction.workbook.sheets[0]?.name).toBe("A\n\tB");
    expect(parsed.text).not.toContain("['A\n\tB'!A1]");
    expect(parsed.text).toContain("['A\\u000a\\u0009B'!A1]\tstring\tvalue");
    const span = parsed.typedExtraction.workbook.sheets[0]?.cellSpans[0];
    expect(span).toBeDefined();
    if (!span) throw new Error("control-name cell span missing");
    expect([...parsed.text].slice(span.charStart, span.charEnd).join("")).toBe("['A\\u000a\\u0009B'!A1]\tstring\tvalue\n");
  });

  it("extracts a workbook through the production parser process and emits typed metadata with coordinate spans", async () => {
    const root = await temporaryRoot();
    const workbookPath = path.join(root, "public-review.xlsx");
    await writeFile(workbookPath, workbookBytes("xlsx"));
    const extracted = await extractDocument(workbookPath, configFor(root));
    expect(extracted.parser).toBe("sheetjs-ce-0.20.3");
    expect(extracted.mediaType).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(extracted.attempts).toEqual([expect.objectContaining({ parser: "sheetjs-ce-0.20.3", ok: true })]);
    expect(extracted.structural.sheets).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Sales Data", rows: 4, cols: 6 })
    ]));
    const metadata = asRecord(extracted.metadata);
    const typed = asRecord(metadata.typedExtraction);
    const workbook = asRecord(typed.workbook);
    const sheets = workbook.sheets as JsonValue[];
    const sales = asRecord(sheets[0]);
    const spans = sales.cellSpans as JsonValue[];
    const formulaSpan = asRecord(spans.find(item => asRecord(item).address === "D2"));
    expect(Number(formulaSpan.charEnd)).toBeGreaterThan(Number(formulaSpan.charStart));
    expect(extracted.text.slice(Number(formulaSpan.charStart), Number(formulaSpan.charEnd))).toContain("'Sales Data'!D2");
  });

  it("routes workbooks through the live file adapter and the engineering-corpus dry-run lane", async () => {
    const root = await temporaryRoot();
    const workbookPath = path.join(root, "public-review.xlsm");
    await writeFile(workbookPath, workbookBytes("xlsm"));
    const events = [];
    for await (const event of new NodeFileIngestAdapter(configFor(root)).streamPath(workbookPath)) events.push(event);
    const fileEvent = events.find(event => event.type === "file");
    expect(fileEvent?.type).toBe("file");
    if (fileEvent?.type !== "file") throw new Error("workbook file event missing");
    expect(fileEvent.file.mediaType).toBe("application/vnd.ms-excel.sheet.macroEnabled.12");
    expect(asRecord(asRecord(fileEvent.file.metadata).typedExtraction).workbook).toBeTruthy();

    const inspection = await inspectEngineeringCorpusFolder(root);
    expect(inspection.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "public-review.xlsm", extractor: "sheetjs_workbook", importable: true })
    ]));
    const report = await dryRunEngineeringCorpusIngest(root);
    const projection = report.fileProjections.find(item => item.path === "public-review.xlsm");
    expect(projection?.observationCounts.table).toBe(2);
    expect(projection?.observationCounts.formula).toBeGreaterThan(0);
    expect(projection?.durableStores.data_graph).toBeGreaterThan(0);
    expect(projection?.durableStores.computation_graph).toBeGreaterThan(0);
  });

  it("forwards a discovered XLSX file through the live WorkspaceRuntime ingest call", async () => {
    const root = await temporaryRoot();
    const workbookPath = path.join(root, "public-review.xlsx");
    await writeFile(workbookPath, workbookBytes("xlsx"));
    const workspace = new SpreadsheetWorkspaceStore();
    const ingestCalls: IngestInput[] = [];
    const runtime = createWorkspaceRuntime({
      runtime: recordingRuntime(workspace, ingestCalls),
      config: configFor(root)
    });

    const result = await runtime.ingest(root);

    expect(result).toMatchObject({ ingested: 1, failed: 0, unsupported: 0 });
    expect(ingestCalls).toHaveLength(1);
    expect(ingestCalls[0]?.path).toBe(workbookPath);
    expect(asRecord(ingestCalls[0]?.metadata).ingestionLane).toBe("workspace");
    expect(workspace.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "public-review.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ingestionStatus: "ingested" })
    ]));
  });

  it("does not reinterpret malformed workbook bytes as Unicode text", async () => {
    const root = await temporaryRoot();
    const workbookPath = path.join(root, "malformed.xlsx");
    await writeFile(workbookPath, "this is text with an xlsx extension", "utf8");
    const extracted = await extractDocument(workbookPath, configFor(root));
    expect(extracted.text).toBe("");
    expect(extracted.parser).toBe("none");
    expect(extracted.attempts).toEqual([expect.objectContaining({ parser: "sheetjs-ce-0.20.3", ok: false })]);
  });
});

function workbookBytes(bookType: "xlsx" | "xlsm" | "xls"): Buffer {
  const workbook = XLSX.utils.book_new();
  const sales = XLSX.utils.aoa_to_sheet([
    ["date", "quantity", "price", "total", "active", "error"],
    [new Date(2026, 6, 12), 2, 5, null, true, null],
    [new Date(2026, 6, 13), 3, 7, null, false, null],
    ["merged note", null, null, null, null, null]
  ], { cellDates: true });
  sales.D2 = { t: "n", f: "B2*C2", v: 10, w: "10" };
  sales.D3 = { t: "n", f: "B3*C3", v: 21, w: "21" };
  sales.F2 = { t: "e", v: 7, w: "#DIV/0!" };
  sales["!merges"] = [XLSX.utils.decode_range("A4:B4"), XLSX.utils.decode_range("C4:D4")];
  XLSX.utils.book_append_sheet(workbook, sales, "Sales Data");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["언어", "값"],
    ["한국어", "증거"],
    ["Español", "señal"]
  ]), "다국어");
  workbook.Workbook = {
    Sheets: [{ name: "Sales Data", Hidden: 0 }, { name: "다국어", Hidden: 1 }],
    WBProps: { date1904: false }
  };
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType, compression: true, cellDates: true }));
}

function forgeFirstZipEntryUncompressedSize(bytes: Buffer): Buffer {
  const forged = Buffer.from(bytes);
  const eocd = forged.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("fixture ZIP EOCD missing");
  const central = forged.readUInt32LE(eocd + 16);
  const local = forged.readUInt32LE(central + 42);
  const original = forged.readUInt32LE(central + 24);
  if (original < 2) throw new Error("fixture ZIP entry too small for size forgery");
  forged.writeUInt32LE(original - 1, central + 24);
  if ((forged.readUInt16LE(local + 6) & 0x0008) === 0) forged.writeUInt32LE(original - 1, local + 22);
  return forged;
}

function addZip64CentralExtra(bytes: Buffer): Buffer {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("fixture ZIP EOCD missing");
  const central = bytes.readUInt32LE(eocd + 16);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const nameLength = bytes.readUInt16LE(central + 28);
  const extraLength = bytes.readUInt16LE(central + 30);
  const insertAt = central + 46 + nameLength + extraLength;
  const zip64Extra = Buffer.from([0x01, 0x00, 0x00, 0x00]);
  const mutated = Buffer.concat([bytes.subarray(0, insertAt), zip64Extra, bytes.subarray(insertAt)]);
  mutated.writeUInt16LE(extraLength + zip64Extra.length, central + 30);
  mutated.writeUInt32LE(centralSize + zip64Extra.length, eocd + zip64Extra.length + 12);
  return mutated;
}

function addForeignArchiveMarker(bytes: Buffer): Buffer {
  const archive = XLSX.CFB.read(bytes, { type: "buffer" });
  XLSX.CFB.utils.cfb_add(archive, "/META-INF/manifest.xml", Buffer.from("<manifest/>", "utf8"));
  return Buffer.from(XLSX.CFB.write(archive, { fileType: "zip", type: "buffer", compression: true }));
}

function addSecondWorkbookMainPart(bytes: Buffer): Buffer {
  const archive = XLSX.CFB.read(bytes, { type: "buffer" });
  XLSX.CFB.utils.cfb_add(archive, "/xl/workbook.bin", Buffer.from([0x00]));
  replaceArchiveText(
    archive,
    "/[Content_Types].xml",
    text => text.replace(
      "<Override",
      '<Override PartName="/xl/workbook.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/><Override'
    )
  );
  return Buffer.from(XLSX.CFB.write(archive, { fileType: "zip", type: "buffer", compression: true }));
}

function addXmlComment(bytes: Buffer): Buffer {
  const archive = XLSX.CFB.read(bytes, { type: "buffer" });
  replaceArchiveText(
    archive,
    "/[Content_Types].xml",
    text => text.replace("<Types", "<!-- deliberately unsupported preflight construct --><Types")
  );
  return Buffer.from(XLSX.CFB.write(archive, { fileType: "zip", type: "buffer", compression: true }));
}

function changeWorksheetContentTypeOnly(bytes: Buffer): Buffer {
  const archive = XLSX.CFB.read(bytes, { type: "buffer" });
  replaceArchiveText(
    archive,
    "/[Content_Types].xml",
    text => text.replace(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
      "application/vnd.ms-excel.macrosheet+xml"
    )
  );
  return Buffer.from(XLSX.CFB.write(archive, { fileType: "zip", type: "buffer", compression: true }));
}

function underdeclaredDimensionWorkbookBytes(): Buffer {
  const archive = XLSX.CFB.read(workbookBytes("xlsx"), { type: "buffer" });
  const index = archive.FullPaths.findIndex((name: string) => name.endsWith("/xl/worksheets/sheet1.xml"));
  const entry = archive.FileIndex[index];
  if (!entry?.content) throw new Error("fixture worksheet XML missing");
  const xml = Buffer.from(entry.content).toString("utf8");
  const underdeclared = xml.replace(/<dimension ref="[^"]+"\/>/, '<dimension ref="A1:A1"/>');
  if (underdeclared === xml) throw new Error("fixture worksheet dimension missing");
  entry.content = Buffer.from(underdeclared, "utf8");
  entry.size = entry.content.length;
  return Buffer.from(XLSX.CFB.write(archive, { fileType: "zip", type: "buffer", compression: true }));
}

function outOfWindowUnderdeclaredWorkbookBytes(): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["header"]]);
  sheet.A5000 = { t: "s", v: "outside parser row window" };
  sheet["!ref"] = "A1:A5000";
  XLSX.utils.book_append_sheet(workbook, sheet, "Far Cell");
  const archive = XLSX.CFB.read(XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }), { type: "buffer" });
  replaceArchiveText(archive, "/xl/worksheets/sheet1.xml", text => text.replace(/<dimension ref="[^"]+"\/>/, '<dimension ref="A1:A1"/>'));
  return Buffer.from(XLSX.CFB.write(archive, { fileType: "zip", type: "buffer", compression: true }));
}

function customTargetUnderdeclaredWorkbookBytes(): Buffer {
  const archive = XLSX.CFB.read(outOfWindowUnderdeclaredWorkbookBytes(), { type: "buffer" });
  XLSX.CFB.utils.cfb_mov(archive, "Root Entry/xl/worksheets/sheet1.xml", "Root Entry/xl/custom/sheet1.xml");
  replaceArchiveText(
    archive,
    "/xl/_rels/workbook.xml.rels",
    text => text.replace("worksheets/sheet1.xml", "custom/sheet1.xml")
  );
  replaceArchiveText(
    archive,
    "/[Content_Types].xml",
    text => text.replace("/xl/worksheets/sheet1.xml", "/xl/custom/sheet1.xml")
  );
  return Buffer.from(XLSX.CFB.write(archive, { fileType: "zip", type: "buffer", compression: true }));
}

function offsetWorkbookBytes(): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([]);
  XLSX.utils.sheet_add_aoa(sheet, [["item", "total"], ["widget", 14]], { origin: "AA5" });
  XLSX.utils.book_append_sheet(workbook, sheet, "Offset");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }));
}

function oversizedMergeWorkbookBytes(): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["value"]]);
  sheet["!merges"] = [XLSX.utils.decode_range("A1:XFD1048576")];
  XLSX.utils.book_append_sheet(workbook, sheet, "Huge Merge");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }));
}

function controlNameWorkbookBytes(): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["value"]]), "A\n\tB");
  return Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }));
}

function unsupportedSheetWorkbookBytes(): Buffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([["macro payload"]]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Macro Sheet");
  const archive = XLSX.CFB.read(XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true }), { type: "buffer" });
  XLSX.CFB.utils.cfb_mov(archive, "Root Entry/xl/worksheets/sheet1.xml", "Root Entry/xl/macrosheets/sheet1.xml");
  replaceArchiveText(
    archive,
    "/xl/_rels/workbook.xml.rels",
    text => text
      .replace("http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet", "http://schemas.microsoft.com/office/2006/relationships/xlMacrosheet")
      .replace("worksheets/sheet1.xml", "macrosheets/sheet1.xml")
  );
  replaceArchiveText(
    archive,
    "/[Content_Types].xml",
    text => text
      .replace("/xl/worksheets/sheet1.xml", "/xl/macrosheets/sheet1.xml")
      .replace("application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml", "application/vnd.ms-excel.macrosheet+xml")
  );
  return Buffer.from(XLSX.CFB.write(archive, { fileType: "zip", type: "buffer", compression: true }));
}

function replaceArchiveText(archive: { FullPaths: string[]; FileIndex: Array<{ content?: Uint8Array; size?: number }> }, suffix: string, replace: (text: string) => string): void {
  const index = archive.FullPaths.findIndex(name => name.endsWith(suffix));
  const entry = archive.FileIndex[index];
  if (!entry?.content) throw new Error(`fixture archive entry ${suffix} missing`);
  const original = Buffer.from(entry.content).toString("utf8");
  const updated = replace(original);
  if (updated === original) throw new Error(`fixture archive entry ${suffix} was not changed`);
  entry.content = Buffer.from(updated, "utf8");
  entry.size = entry.content.length;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce-spreadsheet-"));
  tempRoots.push(root);
  return root;
}

function configFor(root: string): ScceRuntimeConfig {
  return {
    server: { url: "http://127.0.0.1:3873" },
    database: { url: "postgresql://fixture:fixture@127.0.0.1:5432/fixture", schema: "fixture" },
    runtime: {
      workspaceRoot: root,
      tempRoot: path.join(root, ".tmp"),
      maxFileBytes: 16 * 1024 * 1024,
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

function asRecord(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

class SpreadsheetWorkspaceStore implements WorkspaceStore {
  readonly workspaces = new Map<string, WorkspaceRecord>();
  readonly files: WorkspaceSourceFileRecord[] = [];
  readonly reports: WorkspaceReportRecord[] = [];

  async putWorkspace(record: WorkspaceRecord): Promise<void> {
    this.workspaces.set(record.id, record);
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | null> {
    return this.workspaces.get(id) ?? null;
  }

  async latestWorkspace(): Promise<WorkspaceRecord | null> {
    return [...this.workspaces.values()].sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
  }

  async putSourceFile(record: WorkspaceSourceFileRecord): Promise<void> {
    const index = this.files.findIndex(item => item.workspaceId === record.workspaceId && item.path === record.path);
    if (index >= 0) this.files[index] = record;
    else this.files.push(record);
  }

  async listSourceFiles(query: { workspaceId?: string; corpusId?: string; status?: WorkspaceSourceFileRecord["ingestionStatus"]; limit?: number } = {}): Promise<WorkspaceSourceFileRecord[]> {
    return this.files
      .filter(item => !query.workspaceId || item.workspaceId === query.workspaceId)
      .filter(item => !query.corpusId || item.corpusId === query.corpusId)
      .filter(item => !query.status || item.ingestionStatus === query.status)
      .slice(0, query.limit ?? 10000);
  }

  async putReport(record: WorkspaceReportRecord): Promise<void> {
    const index = this.reports.findIndex(item => item.id === record.id);
    if (index >= 0) this.reports[index] = record;
    else this.reports.push(record);
  }

  async listReports(query: { workspaceId?: string; reportKind?: WorkspaceReportRecord["reportKind"]; limit?: number } = {}): Promise<WorkspaceReportRecord[]> {
    return this.reports
      .filter(item => !query.workspaceId || item.workspaceId === query.workspaceId)
      .filter(item => !query.reportKind || item.reportKind === query.reportKind)
      .slice(0, query.limit ?? 100);
  }
}

function recordingRuntime(workspace: WorkspaceStore, ingestCalls: IngestInput[]): NodeScceRuntime {
  return {
    storage: { workspace } as NodeScceRuntime["storage"],
    kernel: {
      ingest: async (input: IngestInput) => {
        ingestCalls.push(input);
        return {
          episodeId: "episode_spreadsheet_workspace" as never,
          files: 1,
          sources: 1,
          evidence: 1,
          graphNodes: 1,
          graphEdges: 0,
          languageProfiles: 0,
          typedObservations: { table: 2, cell: 10, formula: 2 },
          observationRoutes: { data_graph: 1, computation_graph: 1 },
          skipped: [],
          events: []
        };
      }
    } as unknown as NodeScceRuntime["kernel"],
    connectors: {} as NodeScceRuntime["connectors"],
    approvals: {} as NodeScceRuntime["approvals"],
    close: async () => {}
  };
}
