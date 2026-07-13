import { createRequire } from "node:module";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { CellAddress, CellObject, Range, WorkBook, WorkSheet } from "xlsx";
import {
  normalizeSpreadsheetExtractionLimits,
  type SpreadsheetExtractionLimits,
  type SpreadsheetExtractionLimitOverrides,
  type WorkbookCellSpanExtraction,
  type WorkbookExtraction,
  type WorkbookFormulaExtraction,
  type WorkbookSheetExtraction
} from "./spreadsheet-contract.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx") as typeof import("xlsx");

interface ZipPreflight {
  entries: number;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionRatio: number;
  vbaProjectPresent: boolean;
  externalLinkParts: number;
  embeddedObjectParts: number;
}

export function parseWorkbookBytes(
  bytes: Uint8Array,
  fileName: string,
  limitOverrides: SpreadsheetExtractionLimitOverrides = {}
): WorkbookExtraction {
  const limits = normalizeSpreadsheetExtractionLimits(limitOverrides);
  if (bytes.byteLength > limits.maxSourceBytes) {
    throw new Error(`spreadsheet source has ${bytes.byteLength} bytes; limit is ${limits.maxSourceBytes}`);
  }
  const extension = path.extname(fileName).toLocaleLowerCase();
  const sourceFormat = workbookFormat(extension);
  const warnings: string[] = [];
  let archive: ZipPreflight | undefined;

  if (sourceFormat === "xlsx" || sourceFormat === "xlsm") {
    archive = preflightZip(bytes, limits, sourceFormat);
  } else {
    assertOleCompoundFile(bytes);
  }

  let workbook: WorkBook;
  try {
    let selectedSheets: string[] | undefined;
    if (sourceFormat === "xls") {
      const namesOnly = XLSX.read(bytes, {
        type: "array",
        bookSheets: true,
        bookProps: true,
        bookFiles: false,
        bookDeps: false,
        bookVBA: false,
        cellHTML: false,
        WTF: true
      });
      if (namesOnly.SheetNames.length > limits.maxSheets) {
        throw new Error(`workbook has ${namesOnly.SheetNames.length} sheets; limit is ${limits.maxSheets}`);
      }
      selectedSheets = namesOnly.SheetNames;
    }
    workbook = XLSX.read(bytes, {
      type: "array",
      ...(selectedSheets ? { sheets: selectedSheets } : {}),
      sheetRows: sourceFormat === "xls" ? 0 : limits.maxRowsPerSheet + 1,
      raw: true,
      cellFormula: true,
      cellHTML: false,
      cellNF: true,
      cellText: true,
      cellDates: true,
      nodim: true,
      sheetStubs: false,
      bookFiles: false,
      bookDeps: false,
      bookVBA: false,
      xlfn: true,
      WTF: true
    });
    if (workbook.SheetNames.length > limits.maxSheets) {
      throw new Error(`workbook has ${workbook.SheetNames.length} sheets; limit is ${limits.maxSheets}`);
    }
  } catch (error) {
    throw new Error(`spreadsheet parse failed for ${path.basename(fileName)}: ${messageOf(error)}`);
  }

  let text = `# workbook ${safeInline(path.basename(fileName))}\n`;
  let textCharOffset = codePointLength(text);
  let totalCells = 0;
  let totalDenseCells = 0;
  let totalFormulas = 0;
  let totalMergedRanges = 0;
  const sheets: WorkbookSheetExtraction[] = [];
  const structuralSheets: WorkbookExtraction["structural"]["sheets"] = [];

  for (let index = 0; index < workbook.SheetNames.length; index++) {
    const name = workbook.SheetNames[index]!;
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const worksheetType = String(sheet["!type"] ?? "sheet").toLowerCase();
    if (worksheetType !== "sheet") {
      throw new Error(`sheet ${JSON.stringify(name)} has unsupported type ${JSON.stringify(worksheetType)}; chart, dialog, and macro sheets are not projected`);
    }
    const declaredRange = declaredSheetRange(sheet);
    if (declaredRange.e.r + 1 > limits.maxRowsPerSheet) {
      throw new Error(`sheet ${JSON.stringify(name)} has ${declaredRange.e.r + 1} rows; limit is ${limits.maxRowsPerSheet}`);
    }
    if (declaredRange.e.c + 1 > limits.maxColumnsPerSheet) {
      throw new Error(`sheet ${JSON.stringify(name)} has ${declaredRange.e.c + 1} columns; limit is ${limits.maxColumnsPerSheet}`);
    }
    const originalRange = actualSheetRange(sheet, declaredRange);

    const state = sheetState(workbook, index);
    const sheetCharStart = textCharOffset;
    const sheetHeader = `# sheet ${JSON.stringify(name.normalize("NFC"))} index=${index + 1} state=${state}\n`;
    text = appendBounded(text, sheetHeader, limits.maxTextChars);
    textCharOffset += codePointLength(sheetHeader);
    const cells = Object.keys(sheet)
      .filter(key => !key.startsWith("!"))
      .map(address => ({ address, coordinate: decodeCellAddress(address), cell: sheet[address] as CellObject }))
      .filter(item => item.coordinate.r <= originalRange.e.r && item.coordinate.c <= originalRange.e.c)
      .sort((left, right) => left.coordinate.r - right.coordinate.r || left.coordinate.c - right.coordinate.c);

    if (totalCells + cells.length > limits.maxCells) {
      throw new Error(`workbook has more than ${limits.maxCells} populated cells`);
    }
    const rowCount = originalRange.e.r - originalRange.s.r + 1;
    const columnCount = originalRange.e.c - originalRange.s.c + 1;
    const denseCells = rowCount * columnCount;
    if (totalDenseCells + denseCells > limits.maxDenseCells) {
      throw new Error(`workbook dense projection has more than ${limits.maxDenseCells} cells`);
    }
    totalDenseCells += denseCells;
    const rows: Array<Array<string | number | boolean | null>> = Array.from(
      { length: rowCount },
      () => Array<string | number | boolean | null>(columnCount).fill(null)
    );
    const formulas: WorkbookFormulaExtraction[] = [];
    const cellSpans: WorkbookCellSpanExtraction[] = [];

    for (const item of cells) {
      const value = normalizedCellValue(item.cell, limits.maxCellChars);
      rows[item.coordinate.r - originalRange.s.r]![item.coordinate.c - originalRange.s.c] = value;
      const formula = normalizedFormula(item.cell.f, limits.maxCellChars);
      if (formula && totalFormulas + formulas.length + 1 > limits.maxFormulas) {
        throw new Error(`workbook has more than ${limits.maxFormulas} formulas`);
      }
      const displayValue = normalizedDisplayValue(item.cell, value, limits.maxCellChars);
      const qualified = qualifiedCellAddress(name, item.address);
      const line = formula
        ? `[${qualified}]\tformula\t=${safeInline(formula)}\tcached=${safeInline(displayValue)}\n`
        : `[${qualified}]\t${cellType(item.cell)}\t${safeInline(displayValue)}\n`;
      const charStart = textCharOffset;
      text = appendBounded(text, line, limits.maxTextChars);
      textCharOffset += codePointLength(line);
      const charEnd = textCharOffset;
      cellSpans.push({
        address: item.address,
        row: item.coordinate.r + 1,
        column: item.coordinate.c + 1,
        cellType: cellType(item.cell),
        charStart,
        charEnd
      });
      if (formula) {
        formulas.push({
          address: item.address,
          row: item.coordinate.r + 1,
          column: item.coordinate.c + 1,
          formula,
          displayValue,
          computedValue: value,
          cachedValueStatus: value === null ? "missing" : "stored-unverified",
          dependencies: formulaDependencies(formula),
          charStart,
          charEnd
        });
      }
    }

    totalCells += cells.length;
    totalFormulas += formulas.length;
    const sheetCharEnd = textCharOffset;
    const sourceMergedRanges = sheet["!merges"] ?? [];
    if (totalMergedRanges + sourceMergedRanges.length > limits.maxMergedRanges) {
      throw new Error(`workbook has more than ${limits.maxMergedRanges} merged ranges`);
    }
    const mergedRanges = sourceMergedRanges.map(range => {
      assertBoundedMergeRange(range, limits, name);
      return {
        range: XLSX.utils.encode_range(range),
        start: XLSX.utils.encode_cell(range.s),
        end: XLSX.utils.encode_cell(range.e)
      };
    });
    totalMergedRanges += mergedRanges.length;
    const extracted: WorkbookSheetExtraction = {
      index,
      name,
      state,
      range: {
        start: { row: originalRange.s.r + 1, column: originalRange.s.c + 1, address: XLSX.utils.encode_cell(originalRange.s) },
        end: { row: originalRange.e.r + 1, column: originalRange.e.c + 1, address: XLSX.utils.encode_cell(originalRange.e) }
      },
      rows,
      formulas,
      cellSpans,
      mergedRanges,
      cellsRead: cells.length,
      charStart: sheetCharStart,
      charEnd: sheetCharEnd,
      complete: true
    };
    sheets.push(extracted);
    structuralSheets.push({ name, rows: rowCount, cols: columnCount, charStart: sheetCharStart, charEnd: sheetCharEnd });
  }

  if (!sheets.length) throw new Error(`spreadsheet ${path.basename(fileName)} contains no readable worksheets`);
  if (sourceFormat === "xlsm") warnings.push("macro-enabled container parsed as data only; VBA may be inflated by bounded validation/parser internals but is not exposed to cognition or executed");
  if (archive?.vbaProjectPresent) warnings.push("VBA project detected; payload is not exposed to cognition or executed");
  if (archive?.externalLinkParts) warnings.push(`${archive.externalLinkParts} external-link part(s) detected; targets are not exposed or resolved`);
  if (archive?.embeddedObjectParts) warnings.push(`${archive.embeddedObjectParts} embedded-object part(s) detected; payloads are not exposed or executed`);

  return {
    text,
    structural: { sheets: structuralSheets },
    typedExtraction: {
      workbook: {
        schema: "scce.workbook-extraction.v1",
        parser: "sheetjs-ce-0.20.3",
        sourceFormat,
        dateSystem: workbook.Workbook?.WBProps?.date1904 ? "1904" : "1900",
        sheets,
        totalCells,
        totalFormulas,
        complete: true,
        limits,
        security: {
          formulaEvaluation: false,
          cachedFormulaValues: "stored-unverified",
          macroExecution: false,
          macroPayloadExposed: false,
          vbaProjectPresent: archive ? archive.vbaProjectPresent : null,
          externalLinkResolution: false,
          externalLinkPayloadExposed: false,
          externalLinkPartsDetected: archive ? archive.externalLinkParts : null,
          embeddedObjectPayloadExposed: false,
          embeddedObjectPartsDetected: archive ? archive.embeddedObjectParts : null,
          archivePayloadValidation: archive ? "inflated-bounded" : "not-applicable",
          htmlRendering: false,
          encryptedWorkbookAccepted: false
        },
        archive: archive ? {
          entries: archive.entries,
          compressedBytes: archive.compressedBytes,
          uncompressedBytes: archive.uncompressedBytes,
          compressionRatio: archive.compressionRatio
        } : undefined
      }
    },
    warnings
  };
}

function workbookFormat(extension: string): "xlsx" | "xlsm" | "xls" {
  if (extension === ".xlsx") return "xlsx";
  if (extension === ".xlsm") return "xlsm";
  if (extension === ".xls") return "xls";
  throw new Error(`unsupported spreadsheet extension: ${extension || "(none)"}`);
}

function preflightZip(bytes: Uint8Array, limits: SpreadsheetExtractionLimits, sourceFormat: "xlsx" | "xlsm"): ZipPreflight {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error("OOXML workbook is not a ZIP container");
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset >= 20 && buffer.readUInt32LE(eocdOffset - 20) === 0x07064b50) {
    throw new Error("ZIP64 workbooks are not accepted by the bounded parser");
  }
  const disk = buffer.readUInt16LE(eocdOffset + 4);
  const centralDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const entries = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) throw new Error("multi-disk ZIP workbooks are not supported");
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 workbooks are not accepted by the bounded parser");
  if (entries > limits.maxArchiveEntries) throw new Error(`workbook archive has ${entries} entries; limit is ${limits.maxArchiveEntries}`);
  if (centralOffset + centralSize > buffer.length) throw new Error("workbook ZIP central directory is out of bounds");

  let cursor = centralOffset;
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  let vbaProjectPresent = false;
  let externalLinkParts = 0;
  let embeddedObjectParts = 0;
  let contentTypesXml: string | undefined;
  let workbookXml: string | undefined;
  let rootRelationshipsXml: string | undefined;
  let workbookRelationshipsXml: string | undefined;
  const inspectedWorksheetPaths = new Set<string>();
  let worksheetCells = 0;
  let worksheetFormulas = 0;
  let worksheetMergedRanges = 0;
  let worksheetDenseCells = 0;
  const names = new Set<string>();
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("invalid workbook ZIP central-directory entry");
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc32 = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    if ((flags & 0x0001) !== 0) throw new Error("encrypted ZIP entries are not accepted");
    if (method !== 0 && method !== 8) throw new Error(`workbook ZIP uses unsupported compression method ${method}`);
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) throw new Error("ZIP64 workbook entries are not accepted");
    if (uncompressed > limits.maxArchiveEntryBytes) throw new Error(`workbook ZIP entry exceeds ${limits.maxArchiveEntryBytes} uncompressed bytes`);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) throw new Error("workbook ZIP entry name is out of bounds");
    const nextCursor = nameEnd + extraLength + commentLength;
    if (nextCursor > centralOffset + centralSize) throw new Error("workbook ZIP central directory entry exceeds declared size");
    assertNoZip64Extra(buffer, nameEnd, extraLength);
    const rawName = buffer.subarray(nameStart, nameEnd);
    const name = rawName.toString("utf8").replace(/\\/g, "/");
    assertSafeArchivePath(name);
    const lower = name.toLowerCase();
    if (names.has(lower)) throw new Error(`workbook ZIP contains duplicate entry ${JSON.stringify(name)}`);
    if (["meta-inf/manifest.xml", "objectdata.xml", "index/document.iwa", "index.xml.gz", "index.xml", "index.zip"].includes(lower)) {
      throw new Error(`workbook ZIP contains a foreign spreadsheet marker ${JSON.stringify(name)}`);
    }
    names.add(lower);
    const entryCompressionRatio = uncompressed / Math.max(1, compressed);
    if (entryCompressionRatio > limits.maxArchiveCompressionRatio) {
      throw new Error(`workbook ZIP entry compression ratio ${entryCompressionRatio.toFixed(2)} exceeds ${limits.maxArchiveCompressionRatio}`);
    }
    const nextCompressedBytes = compressedBytes + compressed;
    const nextUncompressedBytes = uncompressedBytes + uncompressed;
    if (nextUncompressedBytes > limits.maxArchiveUncompressedBytes) {
      throw new Error(`workbook ZIP expands beyond ${limits.maxArchiveUncompressedBytes} bytes`);
    }
    const dataStart = assertLocalZipEntry(buffer, {
      centralOffset,
      localOffset,
      flags,
      method,
      crc32,
      compressed,
      uncompressed,
      rawName
    });
    const payload = validateZipPayload(buffer.subarray(dataStart, dataStart + compressed), { method, crc32, uncompressed }, limits);
    if (lower === "[content_types].xml") contentTypesXml = decodeXmlPayload(payload, "[Content_Types].xml");
    if (lower === "xl/workbook.xml") workbookXml = decodeXmlPayload(payload, "xl/workbook.xml");
    if (lower === "_rels/.rels") rootRelationshipsXml = decodeXmlPayload(payload, "_rels/.rels");
    if (lower === "xl/_rels/workbook.xml.rels") workbookRelationshipsXml = decodeXmlPayload(payload, "xl/_rels/workbook.xml.rels");
    if (lower.startsWith("xl/worksheets/") && lower.endsWith(".xml")) {
      const stats = inspectWorksheetXml(decodeXmlPayload(payload, name), limits, name);
      worksheetCells += stats.cells;
      worksheetFormulas += stats.formulas;
      worksheetMergedRanges += stats.mergedRanges;
      worksheetDenseCells += stats.denseCells;
      if (worksheetCells > limits.maxCells) throw new Error(`workbook has more than ${limits.maxCells} populated cells`);
      if (worksheetFormulas > limits.maxFormulas) throw new Error(`workbook has more than ${limits.maxFormulas} formulas`);
      if (worksheetMergedRanges > limits.maxMergedRanges) throw new Error(`workbook has more than ${limits.maxMergedRanges} merged ranges`);
      if (worksheetDenseCells > limits.maxDenseCells) throw new Error(`workbook dense projection has more than ${limits.maxDenseCells} cells`);
      inspectedWorksheetPaths.add(lower);
    }
    if (lower === "xl/vbaproject.bin") vbaProjectPresent = true;
    if (lower.startsWith("xl/externallinks/")) externalLinkParts++;
    if (lower.startsWith("xl/embeddings/")) embeddedObjectParts++;
    compressedBytes = nextCompressedBytes;
    uncompressedBytes = nextUncompressedBytes;
    cursor = nextCursor;
  }
  if (!names.has("[content_types].xml") || !names.has("xl/workbook.xml")) throw new Error("ZIP container is not an OOXML workbook");
  assertWorkbookContentType(contentTypesXml, sourceFormat);
  assertRootWorkbookRelationship(rootRelationshipsXml);
  const sheetCount = countXmlElements(workbookXml, "sheet", "xl/workbook.xml");
  if (sheetCount > limits.maxSheets) throw new Error(`workbook has ${sheetCount} sheets; limit is ${limits.maxSheets}`);
  assertWorkbookSheetRelationships(contentTypesXml, workbookXml, workbookRelationshipsXml, sheetCount, names, inspectedWorksheetPaths);
  const compressionRatio = uncompressedBytes / Math.max(1, compressedBytes);
  if (compressionRatio > limits.maxArchiveCompressionRatio) {
    throw new Error(`workbook ZIP compression ratio ${compressionRatio.toFixed(2)} exceeds ${limits.maxArchiveCompressionRatio}`);
  }
  return { entries, compressedBytes, uncompressedBytes, compressionRatio, vbaProjectPresent, externalLinkParts, embeddedObjectParts };
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = buffer.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === buffer.length) return offset;
    }
  }
  throw new Error("workbook ZIP end-of-central-directory record was not found");
}

function assertSafeArchivePath(name: string): void {
  if (!name || name.includes("\u0000") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new Error("workbook ZIP contains an unsafe absolute path");
  if (name.split("/").some(part => part === "..")) throw new Error("workbook ZIP contains a traversal path");
}

function assertLocalZipEntry(buffer: Buffer, entry: {
  centralOffset: number;
  localOffset: number;
  flags: number;
  method: number;
  crc32: number;
  compressed: number;
  uncompressed: number;
  rawName: Buffer;
}): number {
  if (entry.localOffset + 30 > entry.centralOffset || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error("workbook ZIP local entry header is invalid or out of bounds");
  }
  const localFlags = buffer.readUInt16LE(entry.localOffset + 6);
  const localMethod = buffer.readUInt16LE(entry.localOffset + 8);
  const localCrc32 = buffer.readUInt32LE(entry.localOffset + 14);
  const localCompressed = buffer.readUInt32LE(entry.localOffset + 18);
  const localUncompressed = buffer.readUInt32LE(entry.localOffset + 22);
  const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
  if (localFlags !== entry.flags || localMethod !== entry.method) throw new Error("workbook ZIP local and central entry metadata disagree");
  if ((localFlags & 0x0001) !== 0) throw new Error("encrypted ZIP entries are not accepted");
  if ((localFlags & 0x0008) === 0 && (
    localCrc32 !== entry.crc32
    || localCompressed !== entry.compressed
    || localUncompressed !== entry.uncompressed
  )) throw new Error("workbook ZIP local and central entry sizes disagree");
  const localNameStart = entry.localOffset + 30;
  const localNameEnd = localNameStart + localNameLength;
  const dataStart = localNameEnd + localExtraLength;
  if (dataStart > entry.centralOffset || dataStart + entry.compressed > entry.centralOffset) {
    throw new Error("workbook ZIP local entry data is out of bounds");
  }
  if (!buffer.subarray(localNameStart, localNameEnd).equals(entry.rawName)) {
    throw new Error("workbook ZIP local and central entry names disagree");
  }
  assertNoZip64Extra(buffer, localNameEnd, localExtraLength);
  return dataStart;
}

function assertNoZip64Extra(buffer: Buffer, offset: number, length: number): void {
  const end = offset + length;
  if (end > buffer.length) throw new Error("workbook ZIP extra field is out of bounds");
  let cursor = offset;
  while (cursor < end) {
    if (cursor + 4 > end) throw new Error("workbook ZIP extra field is malformed");
    const id = buffer.readUInt16LE(cursor);
    const size = buffer.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + size > end) throw new Error("workbook ZIP extra field is malformed");
    if (id === 0x0001) throw new Error("ZIP64 workbook entries are not accepted");
    cursor += size;
  }
}

function validateZipPayload(
  compressedPayload: Uint8Array,
  entry: { method: number; crc32: number; uncompressed: number },
  limits: SpreadsheetExtractionLimits
): Uint8Array {
  let payload: Uint8Array;
  if (entry.method === 0) {
    payload = compressedPayload;
  } else {
    try {
      payload = inflateRawSync(compressedPayload, {
        maxOutputLength: Math.max(1, Math.min(entry.uncompressed + 1, limits.maxArchiveEntryBytes + 1))
      });
    } catch (error) {
      throw new Error(`workbook ZIP entry failed bounded inflation: ${messageOf(error)}`);
    }
  }
  if (payload.byteLength !== entry.uncompressed) {
    throw new Error(`workbook ZIP entry inflated to ${payload.byteLength} bytes but declared ${entry.uncompressed}`);
  }
  if (crc32(payload) !== entry.crc32) throw new Error("workbook ZIP entry CRC32 verification failed");
  return payload;
}

function decodeXmlPayload(payload: Uint8Array, name: string): string {
  try {
    const encoding = payload[0] === 0xff && payload[1] === 0xfe
      ? "utf-16le"
      : payload[0] === 0xfe && payload[1] === 0xff
        ? "utf-16be"
        : "utf-8";
    return new TextDecoder(encoding, { fatal: true }).decode(payload).normalize("NFC");
  } catch (error) {
    throw new Error(`${name} is not valid supported XML text: ${messageOf(error)}`);
  }
}

interface XmlStartTag {
  localName: string;
  raw: string;
}

function* xmlStartTags(xml: string, name: string): Generator<XmlStartTag> {
  let cursor = 0;
  while (cursor < xml.length) {
    const start = xml.indexOf("<", cursor);
    if (start < 0) return;
    if (xml[start + 1] === "!") throw new Error(`${name} uses unsupported declaration, comment, CDATA, or entity syntax`);
    const end = findXmlTagEnd(xml, start, name);
    cursor = end + 1;
    if (xml[start + 1] === "/" || xml[start + 1] === "?") continue;
    let elementEnd = start + 1;
    while (/[A-Za-z0-9_.:-]/.test(xml[elementEnd] ?? "")) elementEnd++;
    const qualifiedName = xml.slice(start + 1, elementEnd);
    if (!qualifiedName) throw new Error(`${name} contains malformed XML tag syntax`);
    yield { localName: qualifiedName.split(":").pop()!, raw: xml.slice(start, end + 1) };
  }
}

function findXmlTagEnd(xml: string, start: number, name: string): number {
  let quote: string | undefined;
  for (let cursor = start + 1; cursor < xml.length; cursor++) {
    const character = xml[cursor]!;
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") {
      if (cursor - start > 65_536) throw new Error(`${name} contains an oversized XML tag`);
      return cursor;
    }
  }
  throw new Error(`${name} contains an unterminated XML tag`);
}

function assertWorkbookContentType(xml: string | undefined, sourceFormat: "xlsx" | "xlsm"): void {
  if (!xml) throw new Error("OOXML workbook is missing readable [Content_Types].xml");
  const expected = sourceFormat === "xlsm"
    ? "application/vnd.ms-excel.sheet.macroenabled.main+xml"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  const workbookTypes = new Set([
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    "application/vnd.ms-excel.sheet.macroenabled.main+xml",
    "application/vnd.ms-excel.sheet.binary.macroenabled.main",
    "application/vnd.ms-excel.addin.macroenabled.main+xml"
  ]);
  const workbookOverrides = contentTypeOverrides(xml).filter(override => workbookTypes.has(override.contentType.toLowerCase()));
  if (workbookOverrides.length !== 1) {
    throw new Error(`OOXML package must declare exactly one workbook main part; found ${workbookOverrides.length}`);
  }
  const actual = workbookOverrides[0]!;
  if (actual.partName !== "/xl/workbook.xml" || actual.contentType.toLowerCase() !== expected) {
    throw new Error(`${sourceFormat} workbook content type mismatch: expected ${expected} at /xl/workbook.xml, received ${actual.contentType.toLowerCase()} at ${actual.partName}`);
  }
}

function contentTypeOverrides(xml: string): Array<{ partName: string; contentType: string }> {
  const overrides: Array<{ partName: string; contentType: string }> = [];
  for (const tag of xmlStartTags(xml, "[Content_Types].xml")) {
    if (tag.localName !== "Override") continue;
    const partName = xmlAttribute(tag.raw, "PartName");
    const contentType = xmlAttribute(tag.raw, "ContentType");
    if (!partName || !contentType) throw new Error("[Content_Types].xml contains an incomplete Override element");
    overrides.push({ partName, contentType });
  }
  return overrides;
}

function assertRootWorkbookRelationship(xml: string | undefined): void {
  if (!xml) throw new Error("OOXML workbook is missing readable _rels/.rels");
  const relationships: Array<{ type: string; target: string }> = [];
  for (const tag of xmlStartTags(xml, "_rels/.rels")) {
    if (tag.localName !== "Relationship") continue;
    const type = xmlAttribute(tag.raw, "Type");
    const target = xmlAttribute(tag.raw, "Target");
    if (type?.toLowerCase().endsWith("/officedocument") && target) relationships.push({ type, target });
  }
  if (relationships.length !== 1 || relationships[0]!.target.replace(/^\//, "") !== "xl/workbook.xml") {
    throw new Error("OOXML package must have exactly one root officeDocument relationship to xl/workbook.xml");
  }
}

function assertWorkbookSheetRelationships(
  contentTypesXml: string | undefined,
  workbookXml: string | undefined,
  relationshipsXml: string | undefined,
  sheetCount: number,
  archiveNames: Set<string>,
  inspectedWorksheetPaths: Set<string>
): void {
  if (!contentTypesXml || !workbookXml || !relationshipsXml) throw new Error("OOXML workbook is missing workbook relationships or content types");
  const overrides = contentTypeOverrides(contentTypesXml);
  const worksheetContentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
  const sheetRelationshipIds: string[] = [];
  for (const tag of xmlStartTags(workbookXml, "xl/workbook.xml")) {
    if (tag.localName !== "sheet") continue;
    const id = xmlAttribute(tag.raw, "r:id");
    if (!id) throw new Error("xl/workbook.xml sheet is missing r:id");
    sheetRelationshipIds.push(id);
  }
  if (sheetRelationshipIds.length !== sheetCount || new Set(sheetRelationshipIds).size !== sheetRelationshipIds.length) {
    throw new Error("xl/workbook.xml contains inconsistent sheet relationship ids");
  }

  const relationships = new Map<string, { type: string; target: string }>();
  for (const tag of xmlStartTags(relationshipsXml, "xl/_rels/workbook.xml.rels")) {
    if (tag.localName !== "Relationship") continue;
    const id = xmlAttribute(tag.raw, "Id");
    const type = xmlAttribute(tag.raw, "Type");
    const target = xmlAttribute(tag.raw, "Target");
    if (!id || !type || !target) throw new Error("workbook relationship is incomplete");
    if (relationships.has(id)) throw new Error(`workbook relationship id ${JSON.stringify(id)} is duplicated`);
    relationships.set(id, { type, target });
  }

  const referencedTargets = new Set<string>();
  for (const id of sheetRelationshipIds) {
    const relationship = relationships.get(id);
    if (!relationship) throw new Error(`workbook sheet relationship ${JSON.stringify(id)} is missing`);
    if (!relationship.type.toLowerCase().endsWith("/worksheet")) {
      throw new Error(`workbook sheet relationship ${JSON.stringify(id)} has unsupported type ${JSON.stringify(relationship.type)}`);
    }
    const target = relationship.target.replace(/^\//, "").replace(/^xl\//i, "").replace(/\\/g, "/").toLowerCase();
    if (!/^worksheets\/sheet[1-9][0-9]*\.xml$/.test(target)) {
      throw new Error(`workbook worksheet relationship ${JSON.stringify(id)} has noncanonical target ${JSON.stringify(relationship.target)}`);
    }
    const archivePath = `xl/${target}`;
    if (!archiveNames.has(archivePath) || !inspectedWorksheetPaths.has(archivePath)) {
      throw new Error(`workbook worksheet target ${JSON.stringify(archivePath)} was not validated`);
    }
    const worksheetOverrides = overrides.filter(override => override.partName.replace(/^\//, "").toLowerCase() === archivePath);
    if (worksheetOverrides.length !== 1 || worksheetOverrides[0]!.contentType.toLowerCase() !== worksheetContentType) {
      const received = worksheetOverrides.map(override => override.contentType).join(", ") || "missing";
      throw new Error(`workbook worksheet target ${JSON.stringify(archivePath)} must declare exactly one supported worksheet content type; received ${received}`);
    }
    if (referencedTargets.has(archivePath)) throw new Error(`workbook worksheet target ${JSON.stringify(archivePath)} is referenced more than once`);
    referencedTargets.add(archivePath);
  }

  const unreferencedWorksheetRelationships = [...relationships.values()].filter(relationship => relationship.type.toLowerCase().endsWith("/worksheet")).length;
  if (unreferencedWorksheetRelationships !== referencedTargets.size) {
    throw new Error("workbook contains unreferenced or alternate worksheet relationships");
  }
}

function xmlAttribute(tag: string, name: string): string | undefined {
  let cursor = 0;
  while (cursor < tag.length) {
    const start = tag.indexOf(name, cursor);
    if (start < 0) return undefined;
    const before = start > 0 ? tag[start - 1]! : "";
    const after = tag[start + name.length] ?? "";
    if ((before && !/[\s<]/.test(before)) || (after && !/[\s=]/.test(after))) {
      cursor = start + name.length;
      continue;
    }
    let valueStart = start + name.length;
    while (/\s/.test(tag[valueStart] ?? "")) valueStart++;
    if (tag[valueStart] !== "=") {
      cursor = start + name.length;
      continue;
    }
    valueStart++;
    while (/\s/.test(tag[valueStart] ?? "")) valueStart++;
    const quote = tag[valueStart];
    if (quote !== '"' && quote !== "'") return undefined;
    const valueEnd = tag.indexOf(quote, valueStart + 1);
    return valueEnd < 0 ? undefined : tag.slice(valueStart + 1, valueEnd);
  }
  return undefined;
}

function countXmlElements(xml: string | undefined, element: string, name: string): number {
  if (!xml) throw new Error(`${name} is missing or unreadable`);
  let count = 0;
  for (const tag of xmlStartTags(xml, name)) if (tag.localName === element) count++;
  return count;
}

function inspectWorksheetXml(
  xml: string,
  limits: SpreadsheetExtractionLimits,
  name: string
): { cells: number; formulas: number; mergedRanges: number; denseCells: number } {
  let cells = 0;
  let formulas = 0;
  let mergedRanges = 0;
  let currentRow = 0;
  let currentColumn = 0;
  let minRow = Number.POSITIVE_INFINITY;
  let minColumn = Number.POSITIVE_INFINITY;
  let maxRow = 0;
  let maxColumn = 0;
  for (const tag of xmlStartTags(xml, `worksheet ${JSON.stringify(name)}`)) {
    const elementName = tag.localName;
    if (elementName !== "row" && elementName !== "c" && elementName !== "f" && elementName !== "mergeCell") continue;
    if (elementName === "row") {
      const declaredRow = xmlAttribute(tag.raw, "r");
      currentRow = declaredRow === undefined ? currentRow + 1 : positiveXmlInteger(declaredRow, `worksheet ${JSON.stringify(name)} row`);
      currentColumn = 0;
      if (currentRow > limits.maxRowsPerSheet) {
        throw new Error(`worksheet ${JSON.stringify(name)} row ${currentRow} exceeds ${limits.maxRowsPerSheet}`);
      }
      continue;
    }
    if (elementName === "c") {
      const reference = xmlAttribute(tag.raw, "r");
      let coordinate: CellAddress;
      if (reference === undefined) {
        currentRow = Math.max(1, currentRow);
        currentColumn++;
        coordinate = { r: currentRow - 1, c: currentColumn - 1 };
      } else {
        coordinate = decodeStrictA1Cell(reference, `worksheet ${JSON.stringify(name)} cell`);
        currentRow = coordinate.r + 1;
        currentColumn = coordinate.c + 1;
      }
      if (coordinate.r + 1 > limits.maxRowsPerSheet || coordinate.c + 1 > limits.maxColumnsPerSheet) {
        throw new Error(`worksheet ${JSON.stringify(name)} cell ${reference ?? XLSX.utils.encode_cell(coordinate)} exceeds configured coordinates`);
      }
      cells++;
      minRow = Math.min(minRow, coordinate.r);
      minColumn = Math.min(minColumn, coordinate.c);
      maxRow = Math.max(maxRow, coordinate.r);
      maxColumn = Math.max(maxColumn, coordinate.c);
      continue;
    }
    if (elementName === "f") {
      formulas++;
      continue;
    }
    const reference = xmlAttribute(tag.raw, "ref");
    if (!reference) throw new Error(`worksheet ${JSON.stringify(name)} mergeCell is missing ref`);
    const merge = decodeStrictA1Range(reference, `worksheet ${JSON.stringify(name)} mergeCell`);
    assertBoundedMergeRange(merge, limits, name);
    mergedRanges++;
  }
  return {
    cells,
    formulas,
    mergedRanges,
    denseCells: cells ? (maxRow - minRow + 1) * (maxColumn - minColumn + 1) : 0
  };
}

function positiveXmlInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} exceeds the safe integer range`);
  return parsed;
}

function decodeStrictA1Cell(value: string, label: string): CellAddress {
  const normalized = value.replace(/\$/g, "").toUpperCase();
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(normalized);
  if (!match) throw new Error(`${label} reference ${JSON.stringify(value)} is invalid`);
  const row = positiveXmlInteger(match[2]!, `${label} row`);
  let column = 0;
  for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
  if (!Number.isSafeInteger(column) || column <= 0) throw new Error(`${label} column is invalid`);
  return { r: row - 1, c: column - 1 };
}

function decodeStrictA1Range(value: string, label: string): Range {
  const parts = value.split(":");
  if (parts.length < 1 || parts.length > 2) throw new Error(`${label} reference ${JSON.stringify(value)} is invalid`);
  const start = decodeStrictA1Cell(parts[0]!, label);
  const end = decodeStrictA1Cell(parts[1] ?? parts[0]!, label);
  if (end.r < start.r || end.c < start.c) throw new Error(`${label} range ${JSON.stringify(value)} is reversed`);
  return { s: start, e: end };
}

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function assertOleCompoundFile(bytes: Uint8Array): void {
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (bytes.length < signature.length || signature.some((byte, index) => bytes[index] !== byte)) {
    throw new Error("legacy XLS workbook is not an OLE Compound File");
  }
}

function declaredSheetRange(sheet: WorkSheet): Range {
  const reference = String(sheet["!fullref"] ?? sheet["!ref"] ?? "A1:A1");
  try {
    const range = XLSX.utils.decode_range(reference);
    if (range.s.r < 0 || range.s.c < 0 || range.e.r < range.s.r || range.e.c < range.s.c) throw new Error("invalid range");
    return range;
  } catch {
    throw new Error(`worksheet has invalid range ${JSON.stringify(reference)}`);
  }
}

function actualSheetRange(sheet: WorkSheet, fallback: Range): Range {
  const addresses = Object.keys(sheet).filter(key => !key.startsWith("!"));
  if (!addresses.length) return fallback;
  const first = decodeCellAddress(addresses[0]!);
  const range: Range = { s: { ...first }, e: { ...first } };
  for (let index = 1; index < addresses.length; index++) {
    const coordinate = decodeCellAddress(addresses[index]!);
    range.s.r = Math.min(range.s.r, coordinate.r);
    range.s.c = Math.min(range.s.c, coordinate.c);
    range.e.r = Math.max(range.e.r, coordinate.r);
    range.e.c = Math.max(range.e.c, coordinate.c);
  }
  return range;
}

function assertBoundedMergeRange(range: Range, limits: SpreadsheetExtractionLimits, sheetName: string): void {
  if (!Number.isSafeInteger(range.s.r) || !Number.isSafeInteger(range.s.c)
    || !Number.isSafeInteger(range.e.r) || !Number.isSafeInteger(range.e.c)
    || range.s.r < 0 || range.s.c < 0 || range.e.r < range.s.r || range.e.c < range.s.c) {
    throw new Error(`sheet ${JSON.stringify(sheetName)} has an invalid merged range`);
  }
  if (range.e.r + 1 > limits.maxRowsPerSheet || range.e.c + 1 > limits.maxColumnsPerSheet) {
    throw new Error(`sheet ${JSON.stringify(sheetName)} merged range ${XLSX.utils.encode_range(range)} exceeds configured coordinates`);
  }
}

function decodeCellAddress(address: string): CellAddress {
  try {
    return XLSX.utils.decode_cell(address);
  } catch {
    throw new Error(`worksheet has invalid cell address ${JSON.stringify(address)}`);
  }
}

function sheetState(workbook: WorkBook, index: number): WorkbookSheetExtraction["state"] {
  const hidden = workbook.Workbook?.Sheets?.[index]?.Hidden ?? 0;
  return hidden === 2 ? "very-hidden" : hidden === 1 ? "hidden" : "visible";
}

function normalizedCellValue(cell: CellObject, maxChars: number): string | number | boolean | null {
  if (cell.v === undefined || cell.v === null) return null;
  if (cell.t === "e") return boundedString(cell.w ?? String(cell.v), maxChars, "cell error value");
  if (cell.v instanceof Date) return cell.v.toISOString();
  if (typeof cell.v === "string") return boundedString(cell.v, maxChars, "cell value");
  if (typeof cell.v === "number") return Number.isFinite(cell.v) ? cell.v : null;
  if (typeof cell.v === "boolean") return cell.v;
  return boundedString(String(cell.v), maxChars, "cell value");
}

function normalizedDisplayValue(cell: CellObject, value: string | number | boolean | null, maxChars: number): string {
  const display = cell.w ?? (value === null ? "" : String(value));
  return boundedString(display, maxChars, "formatted cell value");
}

function normalizedFormula(formula: string | undefined, maxChars: number): string | undefined {
  if (!formula) return undefined;
  return boundedString(formula, maxChars, "formula");
}

function boundedString(value: string, maxChars: number, label: string): string {
  const normalized = value.replace(/\u0000/g, " ").replace(/\r\n?/g, "\n").normalize("NFC");
  if (normalized.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`);
  return normalized;
}

function appendBounded(current: string, addition: string, maxChars: number): string {
  if (current.length + addition.length > maxChars) throw new Error(`workbook evidence text exceeds ${maxChars} characters`);
  return current + addition;
}

function cellType(cell: CellObject): string {
  if (cell.f) return "formula";
  if (cell.t === "d") return "date";
  if (cell.t === "n") return "number";
  if (cell.t === "b") return "boolean";
  if (cell.t === "e") return "error";
  if (cell.t === "s") return "string";
  return "blank";
}

function qualifiedCellAddress(sheet: string, address: string): string {
  return `'${escapeEvidenceControls(sheet.normalize("NFC")).replace(/'/g, "''")}'!${address}`;
}

function safeInline(value: string): string {
  return escapeEvidenceControls(value.normalize("NFC")).trim();
}

function escapeEvidenceControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, character => {
    const code = character.codePointAt(0) ?? 0;
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

function codePointLength(value: string): number {
  return [...value].length;
}

function formulaDependencies(formula: string): string[] {
  const matches = formula.match(/(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?/g) ?? [];
  return [...new Set(matches.map(item => item.replace(/\$/g, "")))].slice(0, 128);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
