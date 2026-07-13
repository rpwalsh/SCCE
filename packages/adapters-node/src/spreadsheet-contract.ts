export interface SpreadsheetExtractionLimits {
  maxSourceBytes: number;
  maxSheets: number;
  maxRowsPerSheet: number;
  maxColumnsPerSheet: number;
  maxCells: number;
  maxDenseCells: number;
  maxFormulas: number;
  maxMergedRanges: number;
  maxCellChars: number;
  maxTextChars: number;
  maxArchiveEntries: number;
  maxArchiveEntryBytes: number;
  maxArchiveUncompressedBytes: number;
  maxArchiveCompressionRatio: number;
  maxParseMs: number;
  maxHeapMb: number;
}

export type SpreadsheetExtractionLimitOverrides = Partial<SpreadsheetExtractionLimits>;

export const DEFAULT_SPREADSHEET_EXTRACTION_LIMITS: SpreadsheetExtractionLimits = Object.freeze({
  maxSourceBytes: 64 * 1024 * 1024,
  maxSheets: 32,
  maxRowsPerSheet: 2_000,
  maxColumnsPerSheet: 128,
  maxCells: 100_000,
  maxDenseCells: 1_000_000,
  maxFormulas: 10_000,
  maxMergedRanges: 10_000,
  maxCellChars: 32_768,
  maxTextChars: 8 * 1024 * 1024,
  maxArchiveEntries: 4_096,
  maxArchiveEntryBytes: 128 * 1024 * 1024,
  maxArchiveUncompressedBytes: 256 * 1024 * 1024,
  maxArchiveCompressionRatio: 250,
  maxParseMs: 30_000,
  maxHeapMb: 384
});

export interface WorkbookFormulaExtraction {
  address: string;
  row: number;
  column: number;
  formula: string;
  displayValue: string;
  computedValue: string | number | boolean | null;
  cachedValueStatus: "stored-unverified" | "missing";
  dependencies: string[];
  charStart: number;
  charEnd: number;
}

export interface WorkbookCellSpanExtraction {
  address: string;
  row: number;
  column: number;
  cellType: string;
  charStart: number;
  charEnd: number;
}

export interface WorkbookSheetExtraction {
  index: number;
  name: string;
  state: "visible" | "hidden" | "very-hidden";
  range: {
    start: { row: number; column: number; address: string };
    end: { row: number; column: number; address: string };
  };
  rows: Array<Array<string | number | boolean | null>>;
  formulas: WorkbookFormulaExtraction[];
  cellSpans: WorkbookCellSpanExtraction[];
  mergedRanges: Array<{ range: string; start: string; end: string }>;
  cellsRead: number;
  charStart: number;
  charEnd: number;
  complete: true;
}

export interface WorkbookExtraction {
  text: string;
  structural: {
    sheets: Array<{ name: string; rows: number; cols: number; charStart: number; charEnd: number }>;
  };
  typedExtraction: {
    workbook: {
      schema: "scce.workbook-extraction.v1";
      parser: "sheetjs-ce-0.20.3";
      sourceFormat: "xlsx" | "xlsm" | "xls";
      dateSystem: "1900" | "1904";
      sheets: WorkbookSheetExtraction[];
      totalCells: number;
      totalFormulas: number;
      complete: true;
      limits: SpreadsheetExtractionLimits;
      security: {
        formulaEvaluation: false;
        cachedFormulaValues: "stored-unverified";
        macroExecution: false;
        macroPayloadExposed: false;
        vbaProjectPresent: boolean | null;
        externalLinkResolution: false;
        externalLinkPayloadExposed: false;
        externalLinkPartsDetected: number | null;
        embeddedObjectPayloadExposed: false;
        embeddedObjectPartsDetected: number | null;
        archivePayloadValidation: "inflated-bounded" | "not-applicable";
        htmlRendering: false;
        encryptedWorkbookAccepted: false;
      };
      archive?: {
        entries: number;
        compressedBytes: number;
        uncompressedBytes: number;
        compressionRatio: number;
      };
    };
  };
  warnings: string[];
}

export function normalizeSpreadsheetExtractionLimits(input: SpreadsheetExtractionLimitOverrides = {}): SpreadsheetExtractionLimits {
  for (const name of Object.keys(input)) {
    if (!(name in DEFAULT_SPREADSHEET_EXTRACTION_LIMITS)) throw new Error(`unsupported spreadsheet limit ${name}`);
  }
  const limits = { ...DEFAULT_SPREADSHEET_EXTRACTION_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`spreadsheet limit ${name} must be a positive safe integer`);
  }
  if (limits.maxHeapMb < 64) throw new Error("spreadsheet limit maxHeapMb must be at least 64");
  return limits;
}
