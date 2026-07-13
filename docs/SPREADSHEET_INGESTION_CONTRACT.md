# Spreadsheet Ingestion Contract

## Status and scope

SCCE supports local ingestion of `.xlsx`, `.xlsm`, and `.xls` workbooks through the existing file-ingest and typed-observation lane. The parser is vendored SheetJS Community Edition 0.20.3, invoked in a bounded Node child process. It does not evaluate formulas or execute workbook-controlled code.

This contract describes the implementation in [`spreadsheet-parser.ts`](../packages/adapters-node/src/spreadsheet-parser.ts), [`spreadsheet.ts`](../packages/adapters-node/src/spreadsheet.ts), [`document.ts`](../packages/adapters-node/src/document.ts), and [`typed-ingest.ts`](../packages/kernel/src/typed-ingest.ts). It is a behavior and safety contract, not a claim that arbitrary spreadsheets can be parsed successfully.

## Supported containers

| Extension | Accepted container | Media type | Current behavior |
| --- | --- | --- | --- |
| `.xlsx` | OOXML ZIP workbook | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | ZIP preflight, bounded cell/formula extraction, typed projection |
| `.xlsm` | OOXML ZIP macro-enabled workbook | `application/vnd.ms-excel.sheet.macroEnabled.12` | Same data extraction as `.xlsx`; VBA is detected by archive name when present, may be inflated by bounded validation/parser internals, and is never exposed to cognition or executed |
| `.xls` | OLE Compound File / legacy BIFF workbook | `application/vnd.ms-excel` | OLE signature check, then bounded SheetJS parsing in the child process; OOXML ZIP limits do not apply |

The extension selects the parser contract. Renaming a ZIP workbook to `.xls`, or an OLE workbook to `.xlsx`, fails the corresponding container check. Other formats supported by SheetJS in general, including `.xlsb` and `.ods`, are not accepted by this ingestion route.

Legacy `.xls` support is limited to the BIFF/OLE variants handled by SheetJS. The parser process deliberately loads the vendored CommonJS build, which automatically loads the bundled extended codepage table. Independent compatibility coverage for old BIFF producers and uncommon encodings is still incomplete.

## One ingestion lane

The live path is:

```text
bounded source bytes
-> document extractor
-> bounded spreadsheet child process
-> typedExtraction.workbook
-> kernel evidence extraction
-> typed table/cell/formula observations
-> data/schema/computation graph routes
```

The engineering-corpus inspection and dry-run path calls the same process-backed extractor. Workbook fixture JSON remains useful as test input, but it is not a substitute for parsing a real workbook.

On a successful parse, the result is marked `complete: true`; the implementation does not return a truncated workbook as complete. `nodim` recomputes worksheet ranges from actual cells instead of trusting an underdeclared OOXML dimension, and preflight checks the actual worksheet coordinates before SheetJS allocation. Chart, dialog, XLM macro, and other non-worksheet sheet types fail the workbook rather than becoming tables. Applied limits and security flags are attached at `metadata.typedExtraction.workbook`.

## Extracted workbook shape

The current extraction schema is `scce.workbook-extraction.v1`. It records:

- parser identity and source format;
- the 1900 or 1904 date system;
- sheet order, name, visibility state, used range, dense bounded rows, and merged ranges;
- populated-cell count and logical A1 coordinates;
- normalized cell type and display/value material;
- formula text, cached value, cached-value status, and conservatively extracted A1 dependency tokens;
- sheet and cell character intervals in deterministic extracted evidence text;
- archive statistics for `.xlsx` and `.xlsm`;
- the exact resource limits applied to that parse; and
- explicit security flags for formula, VBA, external-link, embedded-object, HTML, and encryption behavior.

Cell values exposed to typed ingest are `string`, finite `number`, `boolean`, or `null`. Dates are converted to ISO strings. Spreadsheet error cells are preserved as their formatted error text. Styles, charts, comments, controls, arbitrary embedded files, and executable content are not projected as cognition.

The first row of each extracted range is treated as the table header by typed ingest. That is a structural convention, not an inference that the workbook author intended the row to be a header.

## Formula contract

SCCE preserves formula text but never calculates or recalculates it.

- SheetJS is called with formula extraction enabled.
- `computedValue` and `displayValue` come only from the value cached in the source workbook.
- A present cached value is labeled `stored-unverified`; a missing cached value is labeled `missing`.
- A cached result may be stale, inconsistent with current inputs, maliciously authored, or absent. It is not independent proof that the formula is correct.
- Formula dependencies are a bounded lexical extraction of A1 cell/range tokens, limited to 128 unique tokens per formula. Named ranges, structured table references, dynamic references, and all Excel formula semantics are not fully resolved.
- External references can remain visible as inert formula text, but SCCE never dereferences them or fetches their targets.

Formula observations retain the source sheet and A1 address, route to the computation and data graph contracts, and carry `formulaEvaluation: false` in metadata.

## Active default limits

The source file is bounded by both `runtime.maxFileBytes` in live callers and the parser's own `maxSourceBytes` API limit. The spreadsheet parser then applies these defaults:

| Limit | Default | Exact enforcement |
| --- | ---: | --- |
| Source bytes | 67,108,864 | Checked before the public parser API copies the caller buffer and again in the child parser |
| Sheets | 32 | Workbook sheet-name count |
| Worksheet row coordinate | 2,000 | Highest 1-based row index in each declared used range |
| Worksheet column coordinate | 128 | Highest 1-based column index in each declared used range |
| Populated cells | 100,000 | Total populated cells across all sheets |
| Dense projection cells | 1,000,000 | Sum of used-range row × column slots allocated for typed row projection |
| Formulas | 10,000 | Total formula-bearing cells across all sheets |
| Merged ranges | 10,000 | Total merge records across all sheets |
| Cell/display/formula string length | 32,768 | Maximum normalized JavaScript string length for each value |
| Extracted evidence text | 8,388,608 | Maximum JavaScript string length for the complete extracted text |
| OOXML archive entries | 4,096 | Central-directory entry count |
| OOXML entry size | 134,217,728 bytes | Declared size bound plus bounded inflation and exact actual-size verification |
| OOXML total expanded size | 268,435,456 bytes | Sum of sizes whose actual inflated payload lengths are verified |
| OOXML compression ratio | 250 | Per-entry and aggregate verified uncompressed bytes divided by compressed bytes |
| Parse time | 30,000 ms | Parent timer covering child-process startup, validation, parsing, and IPC result |
| Parser old-generation heap | 384 MB | Child Node `--max-old-space-size`; this is not a process-RSS ceiling |
| Parser young-generation heap | 64 MB at defaults | Child Node `--max-semi-space-size`, derived from the old-generation limit and clamped to 16-64 MB |
| Parser stack | 8 MB | Child Node `--stack-size` |

`runtime.spreadsheet` may override parser limits. Overrides must be positive safe integers, and `maxHeapMb` must be at least 64. There is currently no separate hard maximum on an operator-supplied override, so deployment owners are responsible for reviewing overrides. The effective values are emitted in each successful extraction.

The OOXML archive checks reject multi-disk ZIP files, ZIP64 locators, sentinels, and extra fields, encrypted ZIP entries, unsupported compression methods, unsafe absolute or traversal paths, duplicate normalized names, local/central-header disagreement, malformed extras, out-of-bounds local data or central directories, payload inflation/CRC mismatches, foreign ODS/Numbers markers, missing `[Content_Types].xml` or `xl/workbook.xml`, extension/main-content-type mismatches (including XLSB), per-entry or aggregate compression-ratio violations, and other configured limit violations. The root and workbook relationship envelopes must name the canonical workbook and `xl/worksheets/sheetN.xml` parts; every declared sheet must resolve to exactly one preflight-inspected worksheet part with exactly one standard worksheet XML content type. Relationship type, target path, and content type are cross-checked, so changing only one axis cannot disguise a macro, dialog, chart, binary, or foreign part as a worksheet. The bounded XML envelope reader accepts ordinary namespace prefixes and UTF-8/UTF-16 encodings but deliberately rejects comments, CDATA, DTD/entity declarations, and other declaration syntax instead of using a permissive parser whose interpretation might disagree with SheetJS. This strict subset can reject otherwise valid OOXML produced by unusual tools; that is a documented compatibility tradeoff, not silent truncation. The `.xls` path is not a ZIP path; it receives source-byte, child-process time/memory, sheet, coordinate, dense-cell, populated-cell, formula, merge, and text bounds, but not the OOXML central-directory checks.

## Inert-content security boundary

The parser uses `bookVBA: false`, `bookFiles: false`, `bookDeps: false`, `cellHTML: false`, and does not expose a formula evaluator.

- Macros are never executed and VBA payloads are never exposed in SCCE's extracted workbook model.
- External-link targets are not exposed to cognition, resolved, or fetched.
- Embedded-object payloads are not exposed to cognition, rendered, or executed.
- Workbook HTML is not generated or rendered.
- Encrypted workbooks are not accepted.

For OOXML, preflight performs bounded inflation and CRC verification of every archive member, including inert-content members, to make declared size and compression limits real. SheetJS parser internals may subsequently inflate those members again and may parse external-link XML. The security contract therefore does not claim that such bytes are never loaded or processed. It claims the narrower verified boundary: they are bounded, never exposed in the extraction/cognition payload, never dereferenced or fetched, and never executed. Security metadata uses `*PayloadExposed: false`, detected-part counts, and `archivePayloadValidation: inflated-bounded` rather than an inaccurate “ignored/not loaded” flag.

The parser runs in a killable Node child process with V8 heap/stack flags and a parent deadline. A parser crash or V8 heap failure is isolated from the long-lived SCCE process. Source size, verified OOXML expansion, dense result slots, and result text are separately bounded because V8 heap flags are not a complete RSS/native-buffer ceiling. This is process isolation, not an operating-system sandbox or cgroup memory ceiling, and must not be described as one.

## Logical provenance and evidence

Logical spreadsheet provenance is authoritative:

```text
source version -> sheet name -> A1 address -> typed cell or formula observation
```

The extractor creates deterministic evidence text with lines such as:

```text
['Sales Data'!D2] formula =B2*C2 cached=10
```

Each populated cell records `charStart` and `charEnd` for its line in `WorkbookExtraction.text`. Typed ingest uses interval overlap to attach the closest extracted-text evidence span and records the sheet, row, column, A1 address, and character interval in observation provenance. Formula observations use the same mechanism.

These character intervals and evidence byte ranges refer to the deterministic extracted text, not offsets inside the OOXML ZIP members or BIFF binary. The original workbook bytes remain the source-version material on successful live ingestion. A1 provenance should be used for reviewer-facing citations such as `Workbook.xlsx -> 'Sales Data'!D2`.

The parser normalizes generated evidence material to NFC and records character intervals in Unicode code points, matching the general evidence extractor. A focused non-BMP test verifies exact interval overlap. Logical A1 remains the stable reviewer-facing coordinate; character intervals are coordinates in extracted evidence text, not offsets in the original binary container.

## Downstream projection bounds

Parser success does not mean every extracted item becomes an explicit graph observation. The current typed projector applies additional bounded materialization:

- at most 2,000 rows enter a table projection;
- the first extracted row is the header;
- explicit cell observations cover at most 200 data rows by 40 columns per sheet;
- explicit formula observations cover at most 512 formulas per sheet;
- profiled measurement observations are capped at 1,500 per table; and
- language-bearing cell observations are capped at 500 per table.

The complete bounded extraction remains in source metadata even when downstream observation caps select a smaller explicit graph surface. Claims about a particular cell or formula must therefore verify that the corresponding observation and evidence ID were actually materialized.

## Fail-closed behavior

The parser throws instead of returning partial success when the container is malformed, a limit is exceeded, a string is too large, the child process times out or fails, the workbook has no readable sheet, or SheetJS rejects the data.

For live file ingestion:

1. the failed parser attempt is recorded in extraction diagnostics;
2. workbook bytes are not reinterpreted through the Unicode-text fallback;
3. the file adapter emits a skipped/failed checkpoint rather than a source file; and
4. no table, cell, formula, evidence, or graph claim is manufactured for that workbook.

For engineering-corpus dry runs, a workbook parse failure currently propagates and fails the dry-run report. Successful sibling files are not presented as evidence that the failed workbook was ingested.

## Verification boundary

The focused adapter and kernel tests cover `.xlsx`, `.xlsm`, and `.xls` parsing; typed and multilingual cells; formulas, missing-cache preservation, and cached-value disclosure in OOXML fixtures; merges; hidden sheets; child-process extraction; live file-adapter, engineering-corpus, and `WorkspaceRuntime.ingest` routing; non-`A1` and non-BMP exact evidence; source/dense/archive bounds; forged ZIP sizes; local/central disagreement; CRC/inflation checks; content-type/extension mismatches; foreign-format markers; XML-declaration rejection; noncanonical worksheet-target rejection; macro-sheet rejection; underdeclared and offset dimensions; invalid containers; and binary no-fallback behavior. The generated BIFF fixture preserves cached values but its writer does not emit formula source, so that test does not prove legacy formula compatibility.

Current test fixtures are generated through the same SheetJS library used to parse them. They do not yet constitute an independent compatibility corpus from Microsoft Excel, LibreOffice, or other producers. There is also no dedicated fixture containing an actual VBA project, external-link target, embedded object, encrypted workbook, ZIP64 archive, or every archive-limit edge case. These remain documented compatibility and robustness risks.

Third-party version, source, checksum, license, and attribution are recorded in [`../THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) and [`../vendor/README.md`](../vendor/README.md).
