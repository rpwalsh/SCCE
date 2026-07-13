import type { IdFactory } from "./ids.js";
import type { EvidenceSpan, GraphEdge, GraphNode, Hasher, JsonValue, SourceId, SourceVersionId } from "./types.js";
import {
  classifyIngestionLane,
  observationContract,
  profileTabularObservations,
  routeObservation,
  type CellObservation,
  type CodeObservation,
  type DocumentStructureObservation,
  type FigureObservation,
  type FormulaObservation,
  type LanguageObservation,
  type LogEventObservation,
  type Observation,
  type ObservationKind,
  type ObservationRoute,
  type TableObservation,
  type TimeSeriesObservation
} from "./ingestion-lanes.js";
import { clamp01, featureSet, toJsonValue } from "./primitives.js";
import { extensionOf, sourceCodeFileFactsFromJson, sourceRepositoryFactsFromJson, splitLines } from "./source-code-graph.js";
import { createEngineeringCorpusProjection, engineeringCorpusProjectionFromJson } from "./engineering-corpus.js";
import { bayesUpdate, shannonEntropy } from "./equation-operators.js";

export interface TypedIngestPreview {
  lane: ReturnType<typeof classifyIngestionLane>;
  languageText: string;
  suppressRawLanguageTraining: boolean;
  observationCounts: Record<string, number>;
}

export interface TypedIngestProjection extends TypedIngestPreview {
  observations: Observation[];
  routes: ObservationRoute[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  diagnostics: JsonValue;
}

export interface TypedIngestProjectorInput {
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  uri: string;
  mediaType: string;
  text: string;
  metadata: JsonValue;
  evidence: EvidenceSpan[];
  observedAt: number;
}

export function createTypedIngestProjector(options: { idFactory: IdFactory; hasher: Hasher }) {
  const ids = options.idFactory;
  const hasher = options.hasher;

  function preview(input: Omit<TypedIngestProjectorInput, "sourceId" | "sourceVersionId" | "evidence" | "observedAt">): TypedIngestPreview {
    const lane = classifyIngestionLane({ mediaType: input.mediaType, uri: input.uri, sourceKind: metadataString(input.metadata, "sourceKind") });
    const tabular = extractTabularInputs({ ...input, sourceId: "preview" as SourceId, sourceVersionId: "preview" as SourceVersionId, evidence: [], evidenceIds: [], observedAt: 0, hasher });
    const isStructuredData = lane === "local_engineering_corpus" || tabular.length > 0;
    const languageText = isStructuredData
      ? tabular.flatMap(table => table.languageRows).join("\n")
      : languageBearingDocumentText(input.text, input.mediaType, input.metadata, input.uri);
    return {
      lane,
      languageText,
      suppressRawLanguageTraining: isStructuredData,
      observationCounts: tabular.length ? { table: tabular.length } : {}
    };
  }

  function project(input: TypedIngestProjectorInput): TypedIngestProjection {
    const lane = classifyIngestionLane({ mediaType: input.mediaType, uri: input.uri, sourceKind: metadataString(input.metadata, "sourceKind") });
    const evidenceIds = input.evidence.map(span => span.id);
    const provenance = toJsonValue({ uri: input.uri, mediaType: input.mediaType, lane, sourceVersionId: input.sourceVersionId });
    const observations: Observation[] = [];

    for (const table of extractTabularInputs({ ...input, evidenceIds, hasher })) {
      observations.push(table.observation);
      observations.push(...table.cellObservations);
      observations.push(...table.formulaObservations);
      observations.push(...table.timeSeriesObservations);
      const profiled = profileTabularObservations({
        datasetId: table.observation.datasetId,
        tableId: table.observation.tableId,
        headers: table.headers,
        rows: table.rows,
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        evidenceIds,
        provenance,
        hasher
      });
      observations.push(profiled.schema, ...profiled.measurements.slice(0, 1500), ...profiled.derived, ...profiled.languageObservations.slice(0, 500));
    }

    if (!shouldSkipDocumentProjection(input, observations)) {
      observations.push(...documentStructureObservations(input, evidenceIds, provenance, ids, hasher));
      observations.push(...documentFigureObservations(input, evidenceIds, provenance, ids));
      observations.push(...documentLanguageObservations(input, evidenceIds, provenance, ids));
    }
    observations.push(...logEventObservations(input, evidenceIds, provenance, ids, hasher));
    const code = codeObservation(input, evidenceIds, provenance, ids, hasher);
    if (code) observations.push(code);

    const routes = observations.map(routeObservation);
    const contracts = observations.map(observationContract);
    const languageText = languageTextFromObservations(observations) || (shouldSuppressRawTraining(lane, input.mediaType, input.uri) ? "" : languageBearingDocumentText(input.text, input.mediaType, input.metadata, input.uri));
    const confidenceTrace = observationConfidenceTrace(observations, routes);
    const graph = graphFromObservations({ observations, routes, evidenceIds, observedAt: input.observedAt, ids, hasher });
    const observationCounts = countBy(observations.map(obs => obs.kind));
    const routeCounts = countBy(routes.flatMap(route => route.durableStores));
    return {
      lane,
      languageText,
      suppressRawLanguageTraining: shouldSuppressRawTraining(lane, input.mediaType, input.uri),
      observations,
      routes,
      graphNodes: graph.nodes,
      graphEdges: graph.edges,
      observationCounts,
      diagnostics: toJsonValue({
        lane,
        observationCounts,
        routeCounts,
        languageTextChars: languageText.length,
        suppressRawLanguageTraining: shouldSuppressRawTraining(lane, input.mediaType, input.uri),
        contracts: contracts.slice(0, 2048),
        confidenceTrace,
        forceClasses: countBy(contracts.map(contract => contract.forceClass)),
        graphNodes: graph.nodes.length,
        graphEdges: graph.edges.length
      })
    };
  }

  return { preview, project };
}

interface InternalTable {
  observation: TableObservation;
  headers: string[];
  rows: Array<Array<string | number | boolean | null>>;
  languageRows: string[];
  cellObservations: CellObservation[];
  formulaObservations: FormulaObservation[];
  timeSeriesObservations: TimeSeriesObservation[];
}

interface WorkbookCellSpan {
  address: string;
  row: number;
  column: number;
  cellType: string;
  charStart: number;
  charEnd: number;
}

function extractTabularInputs(input: TypedIngestProjectorInput & { evidenceIds: EvidenceSpan["id"][]; hasher: Hasher }): InternalTable[] {
  const workbook = workbookFromMetadata(input.metadata);
  if (workbook.length) return workbook.map((sheet, index) => tableFromRows({
    sourceId: input.sourceId,
    sourceVersionId: input.sourceVersionId,
    evidenceIds: input.evidenceIds,
    evidence: input.evidence,
    uri: input.uri,
    name: sheet.name || `sheet_${index + 1}`,
    rowStart: sheet.rowStart,
    columnStart: sheet.columnStart,
    rows: sheet.rows,
    formulas: sheet.formulas,
    cellSpans: sheet.cellSpans,
    observedAt: input.observedAt,
    hasher: input.hasher
  }));
  const documentTables = documentTablesFromMetadata(input.metadata);
  if (documentTables.length) {
    return documentTables.map((table, index) => tableFromRows({
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      evidenceIds: input.evidenceIds,
      evidence: input.evidence,
      uri: input.uri,
      name: table.name || `document_table_${index + 1}`,
      rowStart: table.rowStart,
      columnStart: 1,
      rows: table.rows,
      formulas: [],
      cellSpans: [],
      observedAt: input.observedAt,
      hasher: input.hasher
    }));
  }
  const markdownTables = markdownTablesFromText(input.text);
  if (markdownTables.length) {
    return markdownTables.map((table, index) => tableFromRows({
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      evidenceIds: input.evidenceIds,
      evidence: input.evidence,
      uri: input.uri,
      name: table.title || `markdown_table_${index + 1}`,
      rowStart: table.rowStart,
      columnStart: 1,
      rows: table.rows,
      formulas: [],
      cellSpans: [],
      observedAt: input.observedAt,
      hasher: input.hasher
    }));
  }
  if (looksDelimited(input.mediaType, input.uri, input.text)) {
    const parsed = parseDelimited(input.text, delimiterFor(input.mediaType, input.uri, input.text));
    if (parsed.rows.length >= 2) {
      return [tableFromRows({
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        evidenceIds: input.evidenceIds,
        evidence: input.evidence,
        uri: input.uri,
        name: "delimited_table_1",
        rowStart: 1,
        columnStart: 1,
        rows: parsed.rows,
        formulas: [],
        cellSpans: [],
        observedAt: input.observedAt,
        hasher: input.hasher
      })];
    }
  }
  return [];
}

function tableFromRows(input: {
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  evidenceIds: EvidenceSpan["id"][];
  evidence: EvidenceSpan[];
  uri: string;
  name: string;
  rowStart: number;
  columnStart: number;
  rows: Array<Array<string | number | boolean | null>>;
  formulas: Array<{ address: string; row: number; column: number; formula: string; displayValue: string; computedValue: JsonValue; cachedValueStatus: "stored-unverified" | "missing"; dependencies: string[]; charStart?: number; charEnd?: number }>;
  cellSpans: WorkbookCellSpan[];
  observedAt: number;
  hasher: Hasher;
}): InternalTable {
  const boundedRows = input.rows.slice(0, 2000);
  const headers = normalizeHeaders((boundedRows[0] ?? []).map(value => String(value ?? "")));
  const dataRows = boundedRows.slice(1).map(row => headers.map((_, i) => normalizeCell(row[i])));
  const datasetId = `dataset_${input.hasher.digestHex(input.uri).slice(0, 32)}`;
  const tableId = `table_${input.hasher.digestHex(`${input.uri}:${input.name}`).slice(0, 32)}`;
  const observation: TableObservation = {
    id: observationId(input.hasher, "table", tableId),
    kind: "table",
    sourceId: input.sourceId,
    sourceVersionId: input.sourceVersionId,
    evidenceIds: input.evidenceIds,
    confidence: 0.82,
    provenance: toJsonValue({ uri: input.uri, sheet: input.name, rowStart: input.rowStart, columnStart: input.columnStart }),
    metadata: toJsonValue({ languageTraining: false, typedExtraction: true }),
    datasetId,
    tableId,
    title: input.name,
    sheet: input.name,
    rowRange: [input.rowStart, input.rowStart + Math.max(0, boundedRows.length - 1)],
    columnRange: [input.columnStart, input.columnStart + Math.max(0, headers.length - 1)],
    headers
  };
  const cellObservations: CellObservation[] = [];
  const cellSpanByCoordinate = new Map(input.cellSpans.map(span => [`${span.row}:${span.column}`, span]));
  const formulaByCoordinate = new Map(input.formulas.map(formula => [`${formula.row}:${formula.column}`, formula]));
  for (let r = 0; r < Math.min(dataRows.length, 200); r++) {
    for (let c = 0; c < Math.min(headers.length, 40); c++) {
      const value = dataRows[r]?.[c] ?? null;
      const row = input.rowStart + r + 1;
      const column = input.columnStart + c;
      const address = a1Address(row, column);
      const coordinate = `${row}:${column}`;
      const span = cellSpanByCoordinate.get(coordinate);
      const formula = formulaByCoordinate.get(coordinate);
      cellObservations.push({
        id: observationId(input.hasher, "cell", tableId, r, c, value),
        kind: "cell",
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        evidenceIds: evidenceIdsForTextRange(input.evidence, span, input.evidenceIds),
        confidence: 0.74,
        provenance: toJsonValue({ uri: input.uri, tableId, sheet: input.name, row, column, address, charStart: span?.charStart ?? null, charEnd: span?.charEnd ?? null }),
        metadata: toJsonValue({ languageTraining: false, cellType: span?.cellType ?? null, cachedFormulaValue: formula?.cachedValueStatus ?? null }),
        datasetId,
        tableId,
        row,
        column,
        address: input.name ? qualifiedA1Address(input.name, address) : address,
        header: headers[c],
        rawValue: toJsonValue(value),
        displayValue: value === null ? "" : String(value),
        formulaRef: formula ? qualifiedA1Address(input.name, formula.address) : undefined
      });
    }
  }
  const formulaObservations: FormulaObservation[] = input.formulas.slice(0, 512).map(formula => ({
    id: observationId(input.hasher, "formula", tableId, formula.address, formula.formula),
    kind: "formula",
    sourceId: input.sourceId,
    sourceVersionId: input.sourceVersionId,
    evidenceIds: evidenceIdsForTextRange(input.evidence, formula, input.evidenceIds),
    confidence: 0.78,
    provenance: toJsonValue({ uri: input.uri, tableId, sheet: input.name, address: formula.address, row: formula.row, column: formula.column, charStart: formula.charStart ?? null, charEnd: formula.charEnd ?? null }),
    metadata: toJsonValue({ languageTraining: false, cachedValueStatus: formula.cachedValueStatus, formulaEvaluation: false }),
    datasetId,
    tableId,
    cellAddress: qualifiedA1Address(input.name, formula.address),
    formula: formula.formula,
    dependencies: formula.dependencies,
    computedValue: formula.computedValue
  }));
  const timeSeriesObservations = timeSeriesObservationsForTable({
    sourceId: input.sourceId,
    sourceVersionId: input.sourceVersionId,
    evidenceIds: input.evidenceIds,
    provenance: toJsonValue({ uri: input.uri, sheet: input.name, rowStart: input.rowStart, columnStart: input.columnStart }),
    datasetId,
    tableId,
    headers,
    rows: dataRows,
    hasher: input.hasher
  });
  const languageRows = dataRows
    .flatMap(row => row.map((value, index) => ({ value: String(value ?? ""), header: headers[index] ?? "" })))
    .filter(cell => likelyNaturalLanguage(cell.value) > 0.58)
    .slice(0, 500)
    .map(cell => `${cell.header}: ${cell.value}`);
  return { observation, headers, rows: dataRows, languageRows, cellObservations, formulaObservations, timeSeriesObservations };
}

function documentStructureObservations(input: TypedIngestProjectorInput, evidenceIds: EvidenceSpan["id"][], provenance: JsonValue, ids: IdFactory, hasher: Hasher): DocumentStructureObservation[] {
  const structure = documentStructureMetadata(input.metadata);
  const out: DocumentStructureObservation[] = [];
  for (const heading of arrayOfRecords(structure.headings).slice(0, 256)) {
    const text = String(heading.text ?? "");
    out.push({
      id: ids.semanticId("document_structure", { sourceVersionId: input.sourceVersionId, kind: "heading", text, start: heading.charStart ?? 0 }),
      kind: "document_structure",
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      evidenceIds,
      confidence: 0.72,
      provenance,
      metadata: toJsonValue({ uri: input.uri }),
      structureKind: "heading",
      title: text,
      ordinal: out.length,
      textPreview: text
    });
  }
  for (const section of arrayOfRecords(structure.sections).slice(0, 256)) {
    const title = String(section.title ?? section.heading ?? "");
    const preview = String(section.text ?? section.preview ?? title).slice(0, 500);
    out.push({
      id: ids.semanticId("document_structure", { sourceVersionId: input.sourceVersionId, kind: "section", title, ordinal: out.length }),
      kind: "document_structure",
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      evidenceIds,
      confidence: 0.7,
      provenance,
      metadata: toJsonValue({ uri: input.uri, source: "document_fixture_section" }),
      structureKind: "section",
      title,
      ordinal: out.length,
      textPreview: preview || title
    });
  }
  for (const page of arrayOfRecords(structure.pages).slice(0, 4096)) {
    const pageNumber = Number(page.number ?? page.page ?? out.length + 1);
    const preview = String(page.text ?? page.preview ?? "").slice(0, 500);
    out.push({
      id: ids.semanticId("document_structure", { sourceVersionId: input.sourceVersionId, kind: "page", pageNumber, preview }),
      kind: "document_structure",
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      evidenceIds,
      confidence: 0.66,
      provenance,
      metadata: toJsonValue({ uri: input.uri, source: "document_fixture_page" }),
      structureKind: "page",
      title: `page:${Number.isFinite(pageNumber) ? pageNumber : out.length + 1}`,
      ordinal: out.length,
      pageRange: Number.isFinite(pageNumber) ? [pageNumber, pageNumber] : undefined,
      textPreview: preview
    });
  }
  for (const table of arrayOfRecords(structure.tables).slice(0, 128)) {
    const label = String(table.label ?? `table:${out.length + 1}`);
    out.push({
      id: ids.semanticId("document_structure", { sourceVersionId: input.sourceVersionId, kind: "table", label, start: table.charStart ?? 0 }),
      kind: "document_structure",
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      evidenceIds,
      confidence: 0.68,
      provenance,
      metadata: toJsonValue({ rows: table.rows ?? null, cols: table.cols ?? null }),
      structureKind: "section",
      title: label,
      ordinal: out.length,
      textPreview: label
    });
  }
  if (out.length === 0 && input.text.trim()) {
    out.push({
      id: ids.semanticId("document_structure", { sourceVersionId: input.sourceVersionId, kind: "document" }),
      kind: "document_structure",
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      evidenceIds,
      confidence: 0.55,
      provenance,
      metadata: toJsonValue({ inferred: true }),
      structureKind: "paragraph",
      title: input.uri,
      ordinal: 0,
      textPreview: input.text.slice(0, 240)
    });
  }
  return out;
}

function documentFigureObservations(input: TypedIngestProjectorInput, evidenceIds: EvidenceSpan["id"][], provenance: JsonValue, ids: IdFactory): FigureObservation[] {
  const structure = documentStructureMetadata(input.metadata);
  return arrayOfRecords(structure.figures).slice(0, 256).map((figure, index) => {
    const caption = typeof figure.caption === "string" ? figure.caption : undefined;
    const page = typeof figure.page === "number" ? figure.page : Number.isFinite(Number(figure.page)) ? Number(figure.page) : undefined;
    const box = figure.boundingBox && typeof figure.boundingBox === "object" && !Array.isArray(figure.boundingBox) ? figure.boundingBox as Record<string, JsonValue> : {};
    const boundingBox = ["x", "y", "width", "height"].every(key => Number.isFinite(Number(box[key])))
      ? { x: Number(box.x), y: Number(box.y), width: Number(box.width), height: Number(box.height) }
      : undefined;
    const extractedLabels = arrayOfStrings(figure.extractedLabels).slice(0, 128);
    return {
      id: ids.semanticId("figure_observation", { sourceVersionId: input.sourceVersionId, index, caption: caption ?? "", page: page ?? null }),
      kind: "figure",
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      evidenceIds,
      confidence: 0.62,
      provenance,
      metadata: toJsonValue({ uri: input.uri, typedExtraction: true }),
      figureId: String(figure.id ?? `figure_${index + 1}`),
      caption,
      page,
      boundingBox,
      extractedLabels
    };
  });
}

function documentLanguageObservations(input: TypedIngestProjectorInput, evidenceIds: EvidenceSpan["id"][], provenance: JsonValue, ids: IdFactory): LanguageObservation[] {
  if (shouldSuppressRawTraining(classifyIngestionLane({ mediaType: input.mediaType, uri: input.uri }), input.mediaType, input.uri)) return [];
  const structure = documentStructureMetadata(input.metadata);
  const structuredText = [
    ...arrayOfRecords(structure.paragraphs).map(item => String(item.text ?? item.preview ?? "")),
    ...arrayOfRecords(structure.sections).map(item => String(item.text ?? item.preview ?? "")),
    ...arrayOfRecords(structure.pages).map(item => String(item.text ?? item.preview ?? "")),
    ...arrayOfRecords(structure.figures).map(item => String(item.caption ?? ""))
  ].filter(Boolean).join("\n\n");
  const text = input.text.trim() ? input.text : structuredText;
  return paragraphs(text)
    .filter(text => likelyNaturalLanguage(text) > 0.45)
    .slice(0, 600)
    .map((text, index) => ({
      id: ids.semanticId("language_observation", { sourceVersionId: input.sourceVersionId, index, hash: text.slice(0, 128) }),
      kind: "language" as const,
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      evidenceIds,
      confidence: 0.7,
      provenance,
      metadata: toJsonValue({ uri: input.uri, paragraphIndex: index }),
      role: paragraphRole(text, input.metadata),
      text,
      features: featureSet(text, 512)
    }));
}

function logEventObservations(input: TypedIngestProjectorInput, evidenceIds: EvidenceSpan["id"][], provenance: JsonValue, ids: IdFactory, hasher: Hasher): LogEventObservation[] {
  if (!looksLog(input.mediaType, input.uri)) return [];
  const metadataEvents = logEventsFromMetadata(input.metadata);
  const rawEvents = metadataEvents.length ? metadataEvents : splitLines(input.text).slice(0, 10000).flatMap((line, index) => parseLogLine(line, index + 1));
  const streamId = `log_stream_${hasher.digestHex(input.uri).slice(0, 32)}`;
  return rawEvents.slice(0, 10000).map(event => ({
    id: ids.semanticId("log_event", { sourceVersionId: input.sourceVersionId, streamId, sequence: event.sequence, timestamp: event.timestamp ?? null, message: event.message.slice(0, 160) }),
    kind: "log_event" as const,
    sourceId: input.sourceId,
    sourceVersionId: input.sourceVersionId,
    evidenceIds,
    confidence: event.parsed ? 0.78 : 0.5,
    provenance,
    metadata: toJsonValue({ uri: input.uri, line: event.sequence, languageTraining: false, parser: event.parser }),
    forceClass: "typed_source_observation",
    streamId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    severity: event.severity,
    component: event.component,
    message: event.message,
    attributes: toJsonRecord(event.attributes)
  }));
}

interface ParsedLogEvent {
  sequence: number;
  timestamp?: string;
  severity?: string;
  component?: string;
  message: string;
  attributes: Record<string, JsonValue>;
  parsed: boolean;
  parser: string;
}

function logEventsFromMetadata(metadata: JsonValue): ParsedLogEvent[] {
  const typed = metadataRecord(metadata, "typedExtraction");
  const log = typed.log && typeof typed.log === "object" && !Array.isArray(typed.log) ? typed.log as Record<string, JsonValue> : {};
  return arrayOfRecords(log.events).slice(0, 10000).map((event, index) => ({
    sequence: Number(event.sequence ?? index + 1),
    timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
    severity: typeof event.severity === "string" ? event.severity : undefined,
    component: typeof event.component === "string" ? event.component : undefined,
    message: String(event.message ?? ""),
    attributes: toJsonRecord(event.attributes),
    parsed: true,
    parser: "metadata.log.events"
  })).filter(event => event.message || event.timestamp || event.severity || event.component);
}

function parseLogLine(line: string, sequence: number): ParsedLogEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  const json = trimmed.startsWith("{") && trimmed.endsWith("}") ? parseJsonObject(trimmed) : undefined;
  if (json) {
    const message = String(json.message ?? json.msg ?? json.event ?? trimmed);
    return [{
      sequence,
      timestamp: typeof json.timestamp === "string" ? json.timestamp : typeof json.time === "string" ? json.time : undefined,
      severity: typeof json.level === "string" ? json.level : typeof json.severity === "string" ? json.severity : undefined,
      component: typeof json.component === "string" ? json.component : typeof json.service === "string" ? json.service : undefined,
      message,
      attributes: withoutKeys(json, ["message", "msg", "event", "timestamp", "time", "level", "severity", "component", "service"]),
      parsed: true,
      parser: "json-log-line"
    }];
  }
  const pipe = parsePipeLogLine(trimmed, sequence);
  if (pipe) return [pipe];
  const bracket = parseBracketedLogLine(trimmed, sequence);
  if (bracket) return [bracket];
  const timestamp = startsWithIsoDateTime(trimmed) ? firstSymbol(trimmed) : undefined;
  const rest = timestamp ? trimmed.slice(timestamp.length).trim() : trimmed;
  const attributes = keyValueAttributes(rest);
  const keyedTimestamp = stringAttribute(attributes, "timestamp") ?? stringAttribute(attributes, "time");
  const keyedSeverity = stringAttribute(attributes, "severity") ?? stringAttribute(attributes, "level");
  const observedSeverity = severitySymbol(rest) ?? keyedSeverity;
  const observedComponent = stringAttribute(attributes, "component") ?? stringAttribute(attributes, "service") ?? componentSymbol(rest, observedSeverity);
  const keyedMessage = stringAttribute(attributes, "message") ?? stringAttribute(attributes, "msg") ?? stringAttribute(attributes, "event");
  return [{
    sequence,
    timestamp: timestamp ?? keyedTimestamp,
    severity: observedSeverity,
    component: observedComponent,
    message: keyedMessage ?? stripKeyValueSymbols(stripKnownPrefix(rest)),
    attributes,
    parsed: Boolean(timestamp || keyedTimestamp || Object.keys(attributes).length),
    parser: "structural-log-line"
  }];
}

function parsePipeLogLine(line: string, sequence: number): ParsedLogEvent | undefined {
  if (!line.includes("|")) return undefined;
  const pieces = line.split("|").map(piece => piece.trim()).filter(Boolean);
  if (pieces.length < 3) return undefined;
  const timestamp = startsWithIsoDateTime(pieces[0] ?? "") || slashDateLike(pieces[0] ?? "") ? pieces[0] : undefined;
  const severity = severitySymbol(pieces.join(" "));
  const component = pieces.length >= 4 ? pieces[1] : undefined;
  const messageStart = component ? 3 : 2;
  return {
    sequence,
    timestamp,
    severity: severity ?? pieces[1],
    component,
    message: pieces.slice(messageStart).join(" | ") || pieces[pieces.length - 1] || line,
    attributes: keyValueAttributes(line),
    parsed: true,
    parser: "pipe-log-line"
  };
}

function parseBracketedLogLine(line: string, sequence: number): ParsedLogEvent | undefined {
  const symbols: string[] = [];
  let cursor = 0;
  while (line[cursor] === "[") {
    const close = line.indexOf("]", cursor + 1);
    if (close <= cursor) break;
    symbols.push(line.slice(cursor + 1, close).trim());
    cursor = close + 1;
    while (line[cursor] === " ") cursor++;
  }
  if (!symbols.length) return undefined;
  const timestamp = symbols.find(startsWithIsoDateTime);
  const severity = symbols.map(severitySymbol).find(Boolean);
  const component = symbols.find(symbol => symbol !== timestamp && symbol.toLocaleLowerCase() !== (severity ?? "").toLocaleLowerCase());
  return {
    sequence,
    timestamp,
    severity,
    component,
    message: line.slice(cursor).trim() || line,
    attributes: keyValueAttributes(line.slice(cursor)),
    parsed: true,
    parser: "bracketed-log-line"
  };
}

function codeObservation(input: TypedIngestProjectorInput, evidenceIds: EvidenceSpan["id"][], provenance: JsonValue, ids: IdFactory, hasher: Hasher): CodeObservation | undefined {
  const facts = sourceCodeFacts(input.metadata);
  const repositoryFacts = sourceRepositoryFacts(input.metadata);
  if (!facts && !repositoryFacts && !looksCode(input.mediaType, input.uri)) return undefined;
  const engineeringCorpus = facts || repositoryFacts
    ? createEngineeringCorpusProjection({
      repositoryFacts,
      fileFacts: facts ? [facts] : [],
      evidenceIds,
      sourceVersionId: String(input.sourceVersionId),
      hasher
    })
    : undefined;
  const imports = facts?.imports.map(item => item.moduleSpecifier).slice(0, 512) ?? Object.keys(repositoryFacts?.distributions.imports ?? {}).slice(0, 512);
  const symbols = facts?.declarations.map(item => item.name).slice(0, 1024) ?? repositoryFacts?.packages.flatMap(pkg => pkg.name ? [pkg.name] : []).slice(0, 1024) ?? [];
  const parser = facts?.parser ?? (repositoryFacts ? { id: "source-repository-facts", ok: true, diagnostics: [] } : { id: "source-code-facts-unavailable", ok: false, diagnostics: ["metadata.sourceCode missing"] });
  const codebase = codebaseMetadata(input.metadata);
  const repoId = repositoryFacts?.normalizedRootUri ?? (typeof codebase?.rootUri === "string" ? codebase.rootUri : undefined);
  return {
    id: ids.semanticId("code_observation", { sourceVersionId: input.sourceVersionId, uri: input.uri, imports, symbols }),
    kind: "code",
    repoId,
    sourceId: input.sourceId,
    sourceVersionId: input.sourceVersionId,
    evidenceIds,
    confidence: engineeringCorpus ? Math.max(facts ? 0.84 : 0.58, engineeringCorpus.summary.plannerReadiness) : facts ? 0.84 : 0.42,
    provenance,
    metadata: toJsonValue({
      uri: input.uri,
      repoId,
      codebase: codebase ?? null,
      repositoryFacts: repositoryFacts?.audit ?? null,
      engineeringCorpus: engineeringCorpus ? {
        id: engineeringCorpus.id,
        summary: engineeringCorpus.summary,
        capabilities: engineeringCorpus.capabilities.map(capability => ({ id: capability.id, kind: capability.kind, support: capability.support })),
        plannerHints: {
          primaryLanguages: engineeringCorpus.plannerHints.primaryLanguages,
          packageManagers: engineeringCorpus.plannerHints.packageManagers,
          buildCommands: engineeringCorpus.plannerHints.buildCommands.map(command => ({ scriptName: command.scriptName, command: command.command, confidence: command.confidence })),
          validationCommands: engineeringCorpus.plannerHints.validationCommands.map(command => ({ scriptName: command.scriptName, command: command.command, confidence: command.confidence })),
          entrypoints: engineeringCorpus.plannerHints.entrypoints.slice(0, 16)
        }
      } : null,
      languageTraining: false,
      parser,
      languageEvidence: facts?.languageEvidence ?? [],
      roleEvidence: facts?.roleEvidence ?? []
    }),
    filePath: input.uri,
    language: engineeringCorpus?.plannerHints.primaryLanguages[0] ?? facts?.languageEvidence[0]?.value ?? (repositoryFacts ? "repository-facts" : languageEvidenceValue(input.uri, input.mediaType)),
    symbolGraph: toJsonValue({ declarations: facts?.declarations ?? [], symbols }),
    dependencyGraph: toJsonValue({ imports: facts?.imports ?? imports, dependencies: engineeringCorpus?.dependencies ?? [] }),
    testGraph: facts ? toJsonValue({ tests: facts.tests }) : undefined,
    buildGraph: engineeringCorpus ? toJsonValue({ commands: engineeringCorpus.commands, plannerHints: engineeringCorpus.plannerHints }) : facts?.packageFacts ? toJsonValue({ package: facts.packageFacts }) : repositoryFacts ? toJsonValue({ packages: repositoryFacts.packages, workspace: repositoryFacts.workspace }) : undefined,
    programGraph: toJsonValue({ file: input.uri, facts: facts ?? null, repositoryFacts: repositoryFacts ?? null, engineeringCorpus: engineeringCorpus ?? null, symbols, imports, sourceVersionId: input.sourceVersionId })
  };
}

function graphFromObservations(input: { observations: Observation[]; routes: ObservationRoute[]; evidenceIds: EvidenceSpan["id"][]; observedAt: number; ids: IdFactory; hasher: Hasher }): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const upsertNode = (key: unknown, kind: string, representation: JsonValue, features: string[], alpha = 0.58): GraphNode["id"] => {
    const id = input.ids.nodeId({ kind, key }) as GraphNode["id"];
    if (!nodes.has(id)) nodes.set(id, {
      id,
      typeId: input.ids.dimensionId({ kind }),
      representation,
      alpha,
      evidenceIds: input.evidenceIds,
      features,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
      metadata: toJsonValue({ typedObservation: true })
    });
    return id;
  };
  const upsertEdge = (source: GraphNode["id"], target: GraphNode["id"], relation: string, metadata: JsonValue = {}, weight = 0.65) => {
    const relationId = input.ids.relationId({ relation });
    const id = input.ids.edgeId({ source, target, relationId, provenanceHash: input.hasher.digestHex(`${source}:${relation}:${target}`) });
    edges.set(id, {
      id,
      source,
      target,
      relationId,
      alpha: weight,
      weight,
      temporalScope: { validFrom: input.observedAt },
      evidenceIds: input.evidenceIds,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
      metadata
    });
  };

  for (const observation of input.observations) {
    const route = input.routes.find(item => item.observationId === observation.id);
    const observationNode = upsertNode(observation.id, `observation:${observation.kind}`, compactObservation(observation), observationFeatures(observation), observationConfidence(observation, route));
    for (const store of route?.durableStores ?? []) {
      const storeNode = upsertNode(store, "observation_store", toJsonValue({ store }), [`store:${store}`], 0.5);
      upsertEdge(observationNode, storeNode, "observation_routes_to_store", toJsonValue({ languageEligible: route?.languageEligible ?? false }), 0.52);
    }
    if (observation.kind === "table") {
      const dataset = upsertNode(observation.datasetId, "dataset", toJsonValue({ datasetId: observation.datasetId }), ["dataset"], 0.62);
      const table = upsertNode(observation.tableId, "table", toJsonValue({ tableId: observation.tableId, title: observation.title, headers: observation.headers }), ["table", ...observation.headers.map(h => `column:${h}`)], 0.68);
      upsertEdge(dataset, table, "dataset_contains_table");
      for (const header of observation.headers.slice(0, 128)) {
        const column = upsertNode(`${observation.tableId}:${header}`, "column", toJsonValue({ tableId: observation.tableId, header }), [`column:${header}`], 0.58);
        upsertEdge(table, column, "table_has_column");
      }
    } else if (observation.kind === "measurement") {
      const measurement = upsertNode(observation.measurementId, "measurement", toJsonValue({ value: observation.value, unit: observation.unit, tableId: observation.tableId }), ["measurement", observation.unit ? `unit:${observation.unit}` : "unit:unknown"], 0.66);
      if (observation.unit) {
        const unit = upsertNode(observation.unit, "unit", toJsonValue({ unit: observation.unit }), [`unit:${observation.unit}`], 0.62);
        upsertEdge(measurement, unit, "measurement_has_unit");
      }
    } else if (observation.kind === "formula") {
      const formula = upsertNode(observation.cellAddress, "formula", toJsonValue({ cell: observation.cellAddress, formula: observation.formula, dependencies: observation.dependencies }), ["formula"], 0.63);
      for (const dep of observation.dependencies.slice(0, 64)) {
        const depNode = upsertNode(dep, "cell_ref", toJsonValue({ address: dep }), ["cell-ref"], 0.5);
        upsertEdge(formula, depNode, "formula_depends_on_cell");
      }
    } else if (observation.kind === "time_series") {
      const series = upsertNode(observation.seriesId, "time_series", toJsonValue({ seriesId: observation.seriesId, timestampColumn: observation.timestampColumn, valueColumn: observation.valueColumn, points: observation.points.length }), ["time-series", `value-column:${observation.valueColumn}`], 0.66);
      if (observation.tableId) {
        const table = upsertNode(observation.tableId, "table", toJsonValue({ tableId: observation.tableId }), ["table"], 0.6);
        upsertEdge(table, series, "table_contains_time_series");
      }
    } else if (observation.kind === "figure") {
      const figure = upsertNode(observation.figureId, "figure", toJsonValue({ figureId: observation.figureId, caption: observation.caption ?? null, page: observation.page ?? null, labels: observation.extractedLabels }), ["figure", ...observation.extractedLabels.slice(0, 24).map(label => `label:${label}`)], 0.6);
      if (observation.caption) {
        const caption = upsertNode(`${observation.figureId}:caption`, "figure_caption", toJsonValue({ figureId: observation.figureId, caption: observation.caption }), featureSet(observation.caption, 128), 0.58);
        upsertEdge(figure, caption, "figure_has_caption");
      }
    } else if (observation.kind === "log_event") {
      const stream = upsertNode(observation.streamId, "log_stream", toJsonValue({ streamId: observation.streamId }), ["log-stream"], 0.58);
      const event = upsertNode(observation.id, "log_event", toJsonValue({
        streamId: observation.streamId,
        sequence: observation.sequence,
        timestamp: observation.timestamp ?? null,
        severity: observation.severity ?? null,
        component: observation.component ?? null,
        message: observation.message.slice(0, 500),
        attributes: observation.attributes
      }), ["log-event", ...(observation.severity ? [`severity:${observation.severity}`] : []), ...(observation.component ? [`component:${observation.component}`] : [])], 0.6);
      upsertEdge(stream, event, "stream_contains_log_event", toJsonValue({ sequence: observation.sequence, timestamp: observation.timestamp ?? null }), 0.62);
      if (observation.component) {
        const component = upsertNode(observation.component, "log_component", toJsonValue({ component: observation.component }), [`component:${observation.component}`], 0.54);
        upsertEdge(event, component, "log_event_has_component", toJsonValue({ component: observation.component }), 0.5);
      }
      if (observation.severity) {
        const severity = upsertNode(observation.severity, "log_severity", toJsonValue({ severity: observation.severity }), [`severity:${observation.severity}`], 0.52);
        upsertEdge(event, severity, "log_event_has_severity", toJsonValue({ severity: observation.severity }), 0.48);
      }
    } else if (observation.kind === "schema") {
      const schema = upsertNode(observation.id, "schema", toJsonValue({ tableId: observation.tableId, columns: observation.columns.map(column => [column.name, column.typeCandidate]) }), ["schema", ...observation.columns.slice(0, 64).map(column => `schema-column:${column.name}`)], 0.62);
      const table = upsertNode(observation.tableId, "table", toJsonValue({ tableId: observation.tableId }), ["table"], 0.6);
      upsertEdge(table, schema, "table_has_schema");
    } else if (observation.kind === "derived") {
      const derived = upsertNode(observation.id, "derived_observation", toJsonValue({ derivedKind: observation.derivedKind, claim: observation.claim, calculation: observation.calculation }), ["derived", `derived-kind:${observation.derivedKind}`], 0.58);
      for (const sourceId of observation.derivedFromObservationIds.slice(0, 64)) {
        const source = upsertNode(sourceId, "observation_ref", toJsonValue({ observationId: sourceId }), ["observation-ref"], 0.5);
        upsertEdge(source, derived, "observation_derives");
      }
    } else if (observation.kind === "code") {
      const file = upsertNode(observation.filePath, "code_file", toJsonValue({ filePath: observation.filePath, language: observation.language }), ["code-file", observation.language ?? "language:unknown"], 0.64);
      if (observation.repoId) {
        const repo = upsertNode(observation.repoId, "code_repository", toJsonValue({ repoId: observation.repoId }), ["code-repository", `repo:${observation.repoId}`], 0.7);
        upsertEdge(repo, file, "repository_contains_file", toJsonValue({ filePath: observation.filePath }), 0.68);
      }
      const graph = sourceFactsFromCodeObservation(observation);
      for (const factNode of graph.nodes.slice(0, 1024)) {
        const node = upsertNode(`${observation.filePath}:${factNode.kind}:${factNode.id}`, factNode.kind, factNode.metadata, [`source-fact:${factNode.kind}`, `source-label:${factNode.label}`], 0.62);
        upsertEdge(file, node, "file_has_source_fact", toJsonValue({ sourceFactId: factNode.id, label: factNode.label }), 0.58);
      }
      for (const factEdge of graph.edges.slice(0, 2048)) {
        const source = upsertNode(`${observation.filePath}:${factEdge.source}`, "source_fact_ref", toJsonValue({ sourceFactId: factEdge.source }), ["source-fact-ref"], 0.48);
        const target = upsertNode(`${observation.filePath}:${factEdge.target}`, "source_fact_ref", toJsonValue({ sourceFactId: factEdge.target }), ["source-fact-ref"], 0.48);
        upsertEdge(source, target, factEdge.relation, mergeRelationMetadata(factEdge.metadata, factEdge.relation), factEdge.weight);
      }
      for (const symbol of sourceSymbols(observation).slice(0, 512)) {
        const sym = upsertNode(`${observation.filePath}:${symbol}`, "symbol", toJsonValue({ filePath: observation.filePath, symbol }), [`symbol:${symbol}`], 0.58);
        upsertEdge(file, sym, "file_defines_symbol");
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function observationConfidenceTrace(observations: readonly Observation[], routes: readonly ObservationRoute[]) {
  const rows = observations
    .slice(0, 256)
    .map(observation => {
      const route = routes.find(item => item.observationId === observation.id);
      const features = observationFeatures(observation);
      const ambiguity = shannonEntropy(featureBuckets(features));
      const posterior = observationConfidence(observation, route);
      return {
        observationId: observation.id,
        kind: observation.kind,
        prior: observation.confidence,
        posterior,
        ambiguity: ambiguity.normalized,
        routedStoreCount: route?.durableStores.length ?? 0
      };
    });
  return {
    schema: "scce.ingest_confidence.v1",
    meanPosterior: rows.length ? rows.reduce((sum, row) => sum + row.posterior, 0) / rows.length : 0,
    meanAmbiguity: rows.length ? rows.reduce((sum, row) => sum + row.ambiguity, 0) / rows.length : 0,
    rows
  };
}

function observationConfidence(observation: Observation, route: ObservationRoute | undefined): number {
  const features = observationFeatures(observation);
  const ambiguity = shannonEntropy(featureBuckets(features)).normalized;
  const routeSupport = clamp01((route?.durableStores.length ?? 0) / 4);
  const evidenceSupport = observation.evidenceIds.length ? 0.82 : 0.42;
  const likelihood = clamp01(0.5 * evidenceSupport + 0.32 * routeSupport + 0.18 * (1 - ambiguity));
  return clamp01(bayesUpdate({
    prior: observation.confidence,
    likelihood,
    alternativeLikelihood: clamp01(ambiguity * 0.72 + (1 - evidenceSupport) * 0.28)
  }).posterior * (1 - ambiguity * 0.14));
}

function featureBuckets(features: readonly string[]): number[] {
  const buckets = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const feature of features.slice(0, 512)) {
    let h = 2166136261;
    for (let i = 0; i < feature.length; i++) h = Math.imul(h ^ feature.charCodeAt(i), 16777619);
    const index = (h >>> 0) % buckets.length;
    buckets[index] = (buckets[index] ?? 0) + 1;
  }
  return buckets;
}

function compactObservation(observation: Observation): JsonValue {
  const base = { ...observation } as Record<string, unknown>;
  if (typeof base.text === "string") base.textPreview = base.text.slice(0, 1000);
  delete base.text;
  if (Array.isArray(base.evidenceIds) && base.evidenceIds.length > 24) base.evidenceIds = base.evidenceIds.slice(0, 24);
  if (Array.isArray((base as { points?: unknown[] }).points)) (base as { points?: unknown[] }).points = (base as { points: unknown[] }).points.slice(0, 128);
  return toJsonValue(base);
}

function observationFeatures(observation: Observation): string[] {
  if (observation.kind === "language") return featureSet(observation.text, 256);
  if (observation.kind === "table") return ["table", ...observation.headers.map(header => `header:${header}`)].slice(0, 256);
  if (observation.kind === "measurement") return ["measurement", observation.unit ? `unit:${observation.unit}` : "unit:unknown", `value:${Math.round(observation.value)}`];
  if (observation.kind === "time_series") return ["time-series", `value-column:${observation.valueColumn}`, observation.timestampColumn ? `time-column:${observation.timestampColumn}` : "time-column:implicit"];
  if (observation.kind === "figure") return ["figure", ...observation.extractedLabels.slice(0, 64).map(label => `label:${label}`)];
  if (observation.kind === "log_event") return ["log-event", observation.severity ? `severity:${observation.severity}` : "severity:unknown", observation.component ? `component:${observation.component}` : "component:unknown"];
  if (observation.kind === "code") return ["code", ...(observation.language ? [`language:${observation.language}`] : [])];
  return featureSet(JSON.stringify(compactObservation(observation)), 128);
}

function languageTextFromObservations(observations: Observation[]): string {
  return observations
    .filter((observation): observation is LanguageObservation => observation.kind === "language")
    .map(observation => observation.text)
    .join("\n")
    .slice(0, 2_000_000);
}

function languageBearingDocumentText(text: string, mediaType: string, metadata: JsonValue, uri: string): string {
  if (shouldSuppressRawTraining(classifyIngestionLane({ mediaType, uri }), mediaType, uri)) return "";
  return paragraphs(text).filter(part => likelyNaturalLanguage(part) > 0.42).join("\n").slice(0, 2_000_000);
}

function shouldSuppressRawTraining(lane: ReturnType<typeof classifyIngestionLane>, mediaType: string, uri: string): boolean {
  void lane;
  return tabularExtension(extensionOf(uri)) || tabularMediaType(mediaType) || looksDelimited(mediaType, uri, "") || looksLog(mediaType, uri) || looksCode(mediaType, uri);
}

function shouldSkipDocumentProjection(input: TypedIngestProjectorInput, observations: Observation[]): boolean {
  if (looksLog(input.mediaType, input.uri)) return true;
  if (!observations.some(obs => obs.kind === "table")) return false;
  if (hasDocumentStructureMetadata(input.metadata) || looksDocumentMedia(input.mediaType, input.uri)) return false;
  const ext = extensionOf(input.uri);
  const media = input.mediaType.toLocaleLowerCase();
  if (ext === ".md" || ext === ".txt" || media === "text/markdown" || media === "text/plain") return false;
  return true;
}

function looksDocumentMedia(mediaType: string, uri: string): boolean {
  const media = mediaType.toLocaleLowerCase();
  const ext = extensionOf(uri);
  return media.includes("pdf") || media.includes("wordprocessingml") || media.includes("document") || ext === ".pdf" || ext === ".docx";
}

function hasDocumentStructureMetadata(metadata: JsonValue): boolean {
  const structure = documentStructureMetadata(metadata);
  return ["headings", "sections", "paragraphs", "figures", "pages"].some(key => Array.isArray(structure[key]) && (structure[key] as JsonValue[]).length > 0);
}

function looksDelimited(mediaType: string, uri: string, text: string): boolean {
  const ext = extensionOf(uri);
  if (ext === ".csv" || ext === ".tsv" || mediaType === "text/csv" || mediaType === "text/tab-separated-values") return true;
  const sample = splitLines(text).slice(0, 8);
  return sample.length >= 3 && sample.filter(line => line.split(",").length >= 3 || line.split("\t").length >= 3).length >= 3;
}

function delimiterFor(mediaType: string, uri: string, text: string): "," | "\t" | ";" {
  if (extensionOf(uri) === ".tsv" || mediaType.toLocaleLowerCase().includes("tab-separated")) return "\t";
  const sample = splitLines(text).slice(0, 16).join("\n");
  const counts = { ",": countChar(sample, ","), "\t": countChar(sample, "\t"), ";": countChar(sample, ";") };
  return counts["\t"] > counts[","] && counts["\t"] > counts[";"] ? "\t" : counts[";"] > counts[","] ? ";" : ",";
}

function parseDelimited(text: string, delimiter: "," | "\t" | ";"): { rows: Array<Array<string | number | boolean | null>> } {
  const rows: Array<Array<string | number | boolean | null>> = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    if (row.length || cell) {
      pushCell();
      rows.push(row.map(normalizeCell));
    }
    row = [];
  };
  for (let i = 0; i < text.length && rows.length < 2500; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) pushCell();
    else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushRow();
    } else cell += ch;
  }
  if (cell || row.length) pushRow();
  return { rows };
}

function markdownTablesFromText(text: string): Array<{ title?: string; rowStart: number; rows: Array<Array<string | number | boolean | null>> }> {
  const lines = splitLines(text);
  const tables: Array<{ title?: string; rowStart: number; rows: Array<Array<string | number | boolean | null>> }> = [];
  let i = 0;
  while (i < lines.length && tables.length < 64) {
    if (!markdownTableRowLike(lines[i] ?? "") || !markdownSeparatorRowLike(lines[i + 1] ?? "")) {
      i++;
      continue;
    }
    const rowStart = i + 1;
    const rawRows: string[][] = [markdownCells(lines[i] ?? "")];
    i += 2;
    while (i < lines.length && markdownTableRowLike(lines[i] ?? "")) {
      rawRows.push(markdownCells(lines[i] ?? ""));
      i++;
    }
    const width = Math.max(...rawRows.map(row => row.length), 0);
    if (rawRows.length >= 2 && width >= 2) {
      const rows = rawRows.map(row => {
        const cells: Array<string | number | boolean | null> = [];
        for (let col = 0; col < width; col++) cells.push(normalizeCell(row[col] ?? ""));
        return cells;
      });
      tables.push({ title: `markdown_table_${tables.length + 1}`, rowStart, rows });
    }
  }
  return tables;
}

function markdownTableRowLike(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes("|")) return false;
  return markdownCells(trimmed).length >= 2;
}

function markdownSeparatorRowLike(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.includes("|")) return false;
  const cells = markdownCells(trimmed);
  if (cells.length < 2) return false;
  return cells.every(cell => {
    let dash = 0;
    for (const ch of cell.trim()) {
      if (ch === "-") dash++;
      else if (ch !== ":" && ch !== " ") return false;
    }
    return dash >= 3;
  });
}

function markdownCells(line: string): string[] {
  const trimmed = line.trim();
  const body = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const noTail = body.endsWith("|") ? body.slice(0, -1) : body;
  return splitEscaped(noTail, "|").map(cell => cell.trim());
}

function splitEscaped(text: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = "";
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      current += ch;
      escaped = false;
    } else if (ch === "\\") escaped = true;
    else if (ch === delimiter) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

function workbookFromMetadata(metadata: JsonValue): Array<{
  name: string;
  rowStart: number;
  columnStart: number;
  rows: Array<Array<string | number | boolean | null>>;
  formulas: Array<{ address: string; row: number; column: number; formula: string; displayValue: string; computedValue: JsonValue; cachedValueStatus: "stored-unverified" | "missing"; dependencies: string[]; charStart?: number; charEnd?: number }>;
  cellSpans: WorkbookCellSpan[];
}> {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, JsonValue> : {};
  const typed = record.typedExtraction && typeof record.typedExtraction === "object" && !Array.isArray(record.typedExtraction) ? record.typedExtraction as Record<string, JsonValue> : {};
  const workbook = typed.workbook && typeof typed.workbook === "object" && !Array.isArray(typed.workbook) ? typed.workbook as Record<string, JsonValue> : {};
  return arrayOfRecords(workbook.sheets).slice(0, 64).map(sheet => {
    const range = recordValue(sheet.range);
    const start = recordValue(range.start);
    const rowStart = positiveInteger(start.row, 1);
    const columnStart = positiveInteger(start.column, 1);
    return {
      name: String(sheet.name ?? ""),
      rowStart,
      columnStart,
      rows: arrayOfArrays(sheet.rows).map(row => row.map(normalizeCell)),
      formulas: arrayOfRecords(sheet.formulas).map(formula => {
        const cachedValueStatus = formulaCacheStatus(formula);
        const storedValue = Object.prototype.hasOwnProperty.call(formula, "computedValue")
          ? formula.computedValue
          : formula.displayValue ?? null;
        return {
          address: String(formula.address ?? ""),
          row: positiveInteger(formula.row, 0),
          column: positiveInteger(formula.column, 0),
          formula: String(formula.formula ?? ""),
          displayValue: String(formula.displayValue ?? ""),
          computedValue: cachedValueStatus === "missing" ? null : normalizeCell(storedValue) as JsonValue,
          cachedValueStatus,
          dependencies: arrayOfStrings(formula.dependencies),
          charStart: optionalNonNegativeInteger(formula.charStart),
          charEnd: optionalNonNegativeInteger(formula.charEnd)
        };
      }).filter(formula => formula.formula),
      cellSpans: arrayOfRecords(sheet.cellSpans).map(span => ({
        address: String(span.address ?? ""),
        row: positiveInteger(span.row, 0),
        column: positiveInteger(span.column, 0),
        cellType: String(span.cellType ?? "unknown"),
        charStart: positiveInteger(span.charStart, 0),
        charEnd: positiveInteger(span.charEnd, 0)
      })).filter(span => span.row > 0 && span.column > 0 && span.charEnd >= span.charStart)
    };
  }).filter(sheet => sheet.rows.length > 0);
}

function documentTablesFromMetadata(metadata: JsonValue): Array<{ name: string; rowStart: number; rows: Array<Array<string | number | boolean | null>> }> {
  const structure = documentStructureMetadata(metadata);
  return arrayOfRecords(structure.tables).flatMap((table, index) => {
    const rows = arrayOfArrays(table.rows).map(row => row.map(normalizeCell));
    if (rows.length < 2) return [];
    const name = String(table.label ?? table.title ?? table.id ?? `document_table_${index + 1}`);
    const page = Number(table.page ?? table.pageStart ?? 1);
    return [{ name, rowStart: Number.isFinite(page) ? Math.max(1, page) : 1, rows }];
  });
}

function normalizeHeaders(headers: string[]): string[] {
  return headers.map((header, index) => {
    const trimmed = header.trim();
    return trimmed || `column_${index + 1}`;
  });
}

function normalizeCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = String(value).trim();
  if (!text) return null;
  const numeric = parseNumberStrict(text);
  if (numeric !== undefined) return numeric;
  return text;
}

function paragraphs(text: string): string[] {
  const normalized = normalizeTextLines(text);
  const out: string[] = [];
  let block: string[] = [];
  const flush = () => {
    if (!block.length) return;
    const joined = collapseWhitespace(block.join(" "));
    if (joined.length >= 12) out.push(joined);
    block = [];
  };
  for (const line of splitLines(normalized)) {
    if (!line.trim()) flush();
    else if (line.length > 1800) {
      flush();
      const collapsed = collapseWhitespace(line);
      if (collapsed.length >= 12) out.push(collapsed);
    } else block.push(line);
    if (out.length >= 2000) break;
  }
  flush();
  return out.slice(0, 2000);
}

function paragraphRole(text: string, metadata: JsonValue): LanguageObservation["role"] {
  void metadata;
  return classifyParagraphRoleStructurally(text).role;
}

export function classifyParagraphRoleStructurally(text: string): { role: LanguageObservation["role"]; features: Record<string, number | boolean> } {
  const trimmed = text.trim();
  const lines = splitLines(trimmed);
  const char = charProfile(trimmed);
  const shortSingleLine = lines.length === 1 && trimmed.length <= 96;
  const headingSignal = markdownHeadingLike(trimmed) || (shortSingleLine && char.symbols <= 12 && terminalMarkCount(trimmed) === 0);
  const captionSignal = shortSingleLine && char.punctuation >= 1 && char.symbols <= 16 && char.digits > 0;
  const dialogueSignal = lines.length >= 2 && lines.slice(0, 8).filter(line => line.trimStart().startsWith("-") || line.includes(":")).length >= Math.min(3, lines.length);
  const listSignal = lines.length >= 2 && lines.slice(0, 12).filter(line => listLineLike(line)).length >= Math.min(3, lines.length);
  if (headingSignal) return { role: "heading", features: { shortSingleLine, symbolCount: char.symbols, terminalMarks: terminalMarkCount(trimmed) } };
  if (dialogueSignal) return { role: "dialogue", features: { lineCount: lines.length, punctuation: char.punctuation } };
  if (captionSignal) return { role: "caption", features: { symbolCount: char.symbols, digits: char.digits, punctuation: char.punctuation } };
  if (listSignal) return { role: "note", features: { lineCount: lines.length, listLineCount: lines.filter(listLineLike).length } };
  return { role: "prose", features: { lineCount: lines.length, symbolCount: char.symbols, letterRatio: char.letters / Math.max(1, trimmed.length) } };
}

function looksCode(mediaType: string, uri: string): boolean {
  const lowerMedia = mediaType.toLocaleLowerCase();
  if (lowerMedia.includes("source") || lowerMedia.includes("typescript") || lowerMedia.includes("javascript") || lowerMedia.includes("python")) return true;
  const ext = extensionOf(uri);
  return [".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".rs", ".cs", ".java", ".go", ".cpp", ".c", ".h", ".hpp", ".fs", ".fsx", ".php", ".rb", ".swift", ".kt"].includes(ext);
}

function looksLog(mediaType: string, uri: string): boolean {
  const normalized = mediaType.toLocaleLowerCase();
  const ext = extensionOf(uri);
  return ext === ".log" || normalized.includes("log") || normalized === "application/vnd.scce.engineering-log";
}

function languageEvidenceValue(uri: string, mediaType: string): string {
  const ext = extensionOf(uri);
  return ext ? `extension:${ext}` : mediaType ? `media-type:${mediaType}` : "und";
}

function sourceCodeFacts(metadata: JsonValue): ReturnType<typeof sourceCodeFileFactsFromJson> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return sourceCodeFileFactsFromJson((metadata as Record<string, JsonValue>).sourceCode);
}

function sourceRepositoryFacts(metadata: JsonValue): ReturnType<typeof sourceRepositoryFactsFromJson> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return sourceRepositoryFactsFromJson((metadata as Record<string, JsonValue>).repositoryFacts);
}

function codebaseMetadata(metadata: JsonValue): Record<string, JsonValue> | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const codebase = (metadata as Record<string, JsonValue>).codebase;
  return codebase && typeof codebase === "object" && !Array.isArray(codebase) ? codebase as Record<string, JsonValue> : undefined;
}

function sourceFactsFromCodeObservation(observation: CodeObservation): { nodes: Array<{ id: string; kind: string; label: string; metadata: JsonValue }>; edges: Array<{ source: string; target: string; relation: string; weight: number; metadata: JsonValue }> } {
  if (!observation.programGraph || typeof observation.programGraph !== "object" || Array.isArray(observation.programGraph)) return { nodes: [], edges: [] };
  const program = observation.programGraph as Record<string, JsonValue>;
  const facts = program.facts && typeof program.facts === "object" && !Array.isArray(program.facts) ? program.facts as Record<string, JsonValue> : undefined;
  const repositoryFacts = program.repositoryFacts && typeof program.repositoryFacts === "object" && !Array.isArray(program.repositoryFacts) ? program.repositoryFacts as Record<string, JsonValue> : undefined;
  const engineeringCorpus = engineeringCorpusProjectionFromJson(program.engineeringCorpus);
  const graphs = [facts?.graph, repositoryFacts?.graph, engineeringCorpus?.graph].filter((graph): graph is JsonValue => Boolean(graph));
  const nodes: JsonValue[] = [];
  const edges: JsonValue[] = [];
  for (const graph of graphs) {
    if (!graph || typeof graph !== "object" || Array.isArray(graph)) continue;
    const record = graph as Record<string, JsonValue>;
    if (Array.isArray(record.nodes)) nodes.push(...record.nodes);
    if (Array.isArray(record.edges)) edges.push(...record.edges);
  }
  return {
    nodes: nodes.flatMap(node => sourceFactNode(node)),
    edges: edges.flatMap(edge => sourceFactEdge(edge))
  };
}

function sourceFactNode(value: JsonValue): Array<{ id: string; kind: string; label: string; metadata: JsonValue }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, JsonValue>;
  return typeof record.id === "string" && typeof record.kind === "string" && typeof record.label === "string"
    ? [{ id: record.id, kind: record.kind, label: record.label, metadata: record.metadata ?? {} }]
    : [];
}

function sourceFactEdge(value: JsonValue): Array<{ source: string; target: string; relation: string; weight: number; metadata: JsonValue }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, JsonValue>;
  return typeof record.source === "string" && typeof record.target === "string" && typeof record.relation === "string"
    ? [{ source: record.source, target: record.target, relation: record.relation, weight: typeof record.weight === "number" ? record.weight : 0.5, metadata: record.metadata ?? {} }]
    : [];
}

function mergeRelationMetadata(metadata: JsonValue, relation: string): JsonValue {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata as Record<string, JsonValue> : {};
  return toJsonValue({ ...record, sourceFactRelation: relation });
}

function sourceSymbols(observation: CodeObservation): string[] {
  if (!observation.symbolGraph || typeof observation.symbolGraph !== "object" || Array.isArray(observation.symbolGraph)) return [];
  const declarations = (observation.symbolGraph as Record<string, JsonValue>).declarations;
  if (Array.isArray(declarations)) {
    return declarations.flatMap(item => item && typeof item === "object" && !Array.isArray(item) && typeof (item as Record<string, JsonValue>).name === "string" ? [(item as Record<string, JsonValue>).name as string] : []);
  }
  const symbols = (observation.symbolGraph as Record<string, JsonValue>).symbols;
  return arrayOfStrings(symbols);
}

function likelyNaturalLanguage(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length < 12) return 0;
  const counts = charProfile(trimmed);
  const letters = counts.letters;
  const digits = counts.digits;
  const spaces = counts.spaces;
  const punctuation = counts.punctuation;
  const symbols = counts.symbols;
  const letterRatio = letters / Math.max(1, trimmed.length);
  const digitRatio = digits / Math.max(1, trimmed.length);
  const spaceRatio = spaces / Math.max(1, trimmed.length);
  return Math.max(0, Math.min(1, letterRatio * 0.42 + spaceRatio * 0.22 + Math.min(1, symbols / 16) * 0.24 + Math.min(1, punctuation / 3) * 0.12 - digitRatio * 0.42));
}

function timeSeriesObservationsForTable(input: {
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  evidenceIds: EvidenceSpan["id"][];
  provenance: JsonValue;
  datasetId: string;
  tableId: string;
  headers: string[];
  rows: Array<Array<string | number | boolean | null>>;
  hasher: Hasher;
}): TimeSeriesObservation[] {
  const temporalColumns = input.headers
    .map((header, index) => ({ header, index, score: temporalColumnScore(input.rows, index) }))
    .filter(column => column.score >= 0.7)
    .sort((a, b) => b.score - a.score);
  const numericColumns = input.headers
    .map((header, index) => ({ header, index, score: numericColumnScore(input.rows, index) }))
    .filter(column => column.score >= 0.65)
    .sort((a, b) => b.score - a.score);
  const timeColumn = temporalColumns[0];
  if (!timeColumn || numericColumns.length === 0) return [];
  return numericColumns.slice(0, 24).flatMap(column => {
    const points = input.rows
      .map((row, rowIndex) => {
        const value = parseNumericValue(row[column.index]);
        const t = parseTemporalValue(row[timeColumn.index]);
        return value === undefined || t === undefined ? undefined : { t, value, provenanceRef: `${input.tableId}:r${rowIndex + 2}` };
      })
      .filter((point): point is { t: string | number; value: number; provenanceRef: string } => Boolean(point))
      .slice(0, 10000);
    if (points.length < 3) return [];
    return [{
      id: observationId(input.hasher, "time_series", input.datasetId, input.tableId, timeColumn.header, column.header),
      kind: "time_series" as const,
      sourceId: input.sourceId,
      sourceVersionId: input.sourceVersionId,
      evidenceIds: input.evidenceIds,
      confidence: Math.min(0.92, 0.5 + Math.min(timeColumn.score, column.score) * 0.4),
      provenance: input.provenance,
      metadata: toJsonValue({ typedExtraction: true, rows: points.length }),
      datasetId: input.datasetId,
      tableId: input.tableId,
      seriesId: `${input.tableId}:${timeColumn.header}:${column.header}`,
      timestampColumn: timeColumn.header,
      valueColumn: column.header,
      points
    }];
  });
}

function temporalColumnScore(rows: Array<Array<string | number | boolean | null>>, index: number): number {
  const present = rows.map(row => row[index]).filter(value => value !== null && value !== undefined && String(value).trim() !== "");
  if (present.length < 3) return 0;
  const parsed = present.map(parseTemporalValue).filter((value): value is string | number => value !== undefined);
  return parsed.length / present.length;
}

function numericColumnScore(rows: Array<Array<string | number | boolean | null>>, index: number): number {
  const present = rows.map(row => row[index]).filter(value => value !== null && value !== undefined && String(value).trim() !== "");
  if (present.length < 3) return 0;
  const parsed = present.map(parseNumericValue).filter((value): value is number => value !== undefined);
  return parsed.length / present.length;
}

function parseNumericValue(value: string | number | boolean | null | undefined): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  return parseNumberStrict(value);
}

function parseTemporalValue(value: string | number | boolean | null | undefined): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (isoDateLike(trimmed) || slashDateLike(trimmed)) return trimmed;
  return undefined;
}

function tabularExtension(ext: string): boolean {
  return ext === ".csv" || ext === ".tsv" || ext === ".xlsx" || ext === ".xlsm" || ext === ".xls";
}

function tabularMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLocaleLowerCase();
  return normalized === "text/csv"
    || normalized === "text/tab-separated-values"
    || normalized === "application/vnd.scce.workbook+json"
    || normalized === "application/vnd.scce.measurements+json"
    || normalized === "application/vnd.ms-excel"
    || normalized === "application/vnd.ms-excel.sheet.macroenabled.12"
    || normalized === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

function countChar(text: string, target: string): number {
  let count = 0;
  for (const ch of text) if (ch === target) count++;
  return count;
}

function normalizeTextLines(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\u0000") out += " ";
    else if (ch === "\r") {
      out += "\n";
      if (text[i + 1] === "\n") i++;
    } else out += ch;
  }
  return out;
}

function collapseWhitespace(text: string): string {
  let out = "";
  let spacing = false;
  for (const ch of text.trim()) {
    if (ch.trim() === "") {
      if (!spacing) out += " ";
      spacing = true;
    } else {
      out += ch;
      spacing = false;
    }
  }
  return out;
}

function markdownHeadingLike(text: string): boolean {
  const trimmed = text.trimStart();
  let marks = 0;
  while (marks < trimmed.length && trimmed[marks] === "#") marks++;
  return marks >= 1 && marks <= 6 && trimmed[marks] === " ";
}

function charProfile(text: string): { letters: number; digits: number; spaces: number; punctuation: number; symbols: number } {
  let letters = 0;
  let digits = 0;
  let spaces = 0;
  let punctuation = 0;
  let symbols = 0;
  let inSymbol = false;
  for (const ch of text) {
    const kind = charKind(ch);
    if (kind === "space") {
      spaces++;
      inSymbol = false;
    } else if (kind === "digit") {
      digits++;
      if (!inSymbol) symbols++;
      inSymbol = true;
    } else if (kind === "letter") {
      letters++;
      if (!inSymbol) symbols++;
      inSymbol = true;
    } else if (kind === "symbol-mark") {
      if (!inSymbol) symbols++;
      inSymbol = true;
    } else {
      punctuation++;
      inSymbol = false;
    }
  }
  return { letters, digits, spaces, punctuation, symbols };
}

function charKind(ch: string): "space" | "digit" | "letter" | "symbol-mark" | "punctuation" {
  if (ch.trim() === "") return "space";
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 48 && cp <= 57) return "digit";
  if (ch === "_" || ch === "'" || ch === "-") return "symbol-mark";
  return ch.toLocaleLowerCase() !== ch.toLocaleUpperCase() ? "letter" : "punctuation";
}

function parseNumberStrict(value: string): number | undefined {
  const normalized = stripNumberSeparators(value).trim();
  if (!normalized || !numberGrammarAccepts(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stripNumberSeparators(value: string): string {
  let out = "";
  for (const ch of value) if (ch !== ",") out += ch;
  return out;
}

function numberGrammarAccepts(text: string): boolean {
  let i = 0;
  if (text[i] === "+" || text[i] === "-") i++;
  let digitsBefore = 0;
  while (isAsciiDigit(text[i])) {
    digitsBefore++;
    i++;
  }
  let digitsAfter = 0;
  if (text[i] === ".") {
    i++;
    while (isAsciiDigit(text[i])) {
      digitsAfter++;
      i++;
    }
  }
  if (digitsBefore + digitsAfter === 0) return false;
  if (text[i] === "e" || text[i] === "E") {
    i++;
    if (text[i] === "+" || text[i] === "-") i++;
    let exponentDigits = 0;
    while (isAsciiDigit(text[i])) {
      exponentDigits++;
      i++;
    }
    if (exponentDigits === 0) return false;
  }
  return i === text.length;
}

function isAsciiDigit(ch: string | undefined): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return cp >= 48 && cp <= 57;
}

function isoDateLike(text: string): boolean {
  if (text.length < 10) return false;
  return isNDigits(text, 0, 4) && text[4] === "-" && isNDigits(text, 5, 2) && text[7] === "-" && isNDigits(text, 8, 2);
}

function slashDateLike(text: string): boolean {
  const first = text.indexOf("/");
  if (first <= 0 || first > 2) return false;
  const second = text.indexOf("/", first + 1);
  if (second <= first + 1 || second > first + 3) return false;
  const yearStart = second + 1;
  let yearDigits = 0;
  while (isAsciiDigit(text[yearStart + yearDigits])) yearDigits++;
  return (yearDigits === 2 || yearDigits === 4) && isNDigits(text, 0, first) && isNDigits(text, first + 1, second - first - 1);
}

function isNDigits(text: string, start: number, count: number): boolean {
  for (let i = 0; i < count; i++) if (!isAsciiDigit(text[start + i])) return false;
  return true;
}

function evidenceIdsForTextRange(
  evidence: EvidenceSpan[],
  range: { charStart?: number; charEnd?: number } | undefined,
  fallback: EvidenceSpan["id"][]
): EvidenceSpan["id"][] {
  if (!range || !Number.isFinite(range.charStart) || !Number.isFinite(range.charEnd) || (range.charEnd ?? 0) < (range.charStart ?? 0)) return fallback;
  const start = range.charStart ?? 0;
  const end = range.charEnd ?? start;
  const matches = evidence.filter(span => span.charStart < end && span.charEnd > start).map(span => span.id);
  return matches.length ? [...new Set(matches)] : fallback;
}

function a1Address(row: number, column: number): string {
  let col = Math.max(1, Math.trunc(column));
  let letters = "";
  while (col > 0) {
    const remainder = (col - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    col = Math.floor((col - 1) / 26);
  }
  return `${letters}${Math.max(1, Math.trunc(row))}`;
}

function qualifiedA1Address(sheet: string, address: string): string {
  return `'${sheet.replace(/'/g, "''")}'!${address}`;
}

function recordValue(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function formulaCacheStatus(formula: Record<string, JsonValue>): "stored-unverified" | "missing" {
  if (formula.cachedValueStatus === "stored-unverified" || formula.cachedValueStatus === "missing") return formula.cachedValueStatus;
  if (Object.prototype.hasOwnProperty.call(formula, "computedValue")) return formula.computedValue === null ? "missing" : "stored-unverified";
  return Object.prototype.hasOwnProperty.call(formula, "displayValue") ? "stored-unverified" : "missing";
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function metadataRecord(metadata: JsonValue, key: string): Record<string, JsonValue> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const value = (metadata as Record<string, JsonValue>)[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function documentStructureMetadata(metadata: JsonValue): Record<string, JsonValue> {
  const direct = metadataRecord(metadata, "structure");
  const typed = metadataRecord(metadata, "typedExtraction");
  const document = typed.document && typeof typed.document === "object" && !Array.isArray(typed.document) ? typed.document as Record<string, JsonValue> : {};
  const nested = document.structure && typeof document.structure === "object" && !Array.isArray(document.structure) ? document.structure as Record<string, JsonValue> : {};
  return { ...nested, ...document, ...direct };
}

function metadataString(metadata: JsonValue, key: string): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, JsonValue>)[key];
  return typeof value === "string" ? value : undefined;
}

function arrayOfRecords(value: unknown): Array<Record<string, JsonValue>> {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, JsonValue>> : [];
}

function arrayOfArrays(value: unknown): Array<unknown[]> {
  return Array.isArray(value) ? value.filter(Array.isArray) as unknown[][] : [];
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function parseJsonObject(text: string): Record<string, JsonValue> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, JsonValue> : undefined;
  } catch {
    return undefined;
  }
}

function toJsonRecord(value: unknown): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function withoutKeys(record: Record<string, JsonValue>, keys: string[]): Record<string, JsonValue> {
  const blocked = new Set(keys);
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) if (!blocked.has(key)) out[key] = value;
  return out;
}

function firstSymbol(text: string): string {
  const trimmed = text.trimStart();
  const space = trimmed.indexOf(" ");
  return space >= 0 ? trimmed.slice(0, space) : trimmed;
}

function startsWithIsoDateTime(text: string): boolean {
  if (!isoDateLike(text)) return false;
  if (text.length === 10) return true;
  const sep = text[10];
  if (sep !== "T" && sep !== " ") return false;
  return isNDigits(text, 11, 2) && text[13] === ":" && isNDigits(text, 14, 2);
}

function severitySymbol(text: string): string | undefined {
  for (const symbol of looseSymbols(text)) {
    const normalized = symbol.toLocaleLowerCase();
    if (normalized === "trace" || normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "warning" || normalized === "error" || normalized === "fatal" || normalized === "critical") return normalized;
  }
  return undefined;
}

function looseSymbols(text: string): string[] {
  const out: string[] = [];
  let symbol = "";
  for (const ch of text) {
    const kind = charKind(ch);
    if (kind === "letter" || kind === "digit" || ch === "_" || ch === "-") symbol += ch;
    else if (symbol) {
      out.push(symbol);
      symbol = "";
    }
  }
  if (symbol) out.push(symbol);
  return out;
}

function keyValueAttributes(text: string): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const symbol of looseSymbolsWithEquals(text)) {
    const eq = symbol.indexOf("=");
    if (eq <= 0 || eq >= symbol.length - 1) continue;
    const key = symbol.slice(0, eq).trim();
    const value = symbol.slice(eq + 1).trim();
    if (key) out[key] = normalizeCell(value) as JsonValue;
  }
  return out;
}

function looseSymbolsWithEquals(text: string): string[] {
  const out: string[] = [];
  let symbol = "";
  let quoted: string | undefined;
  for (const ch of text) {
    if (quoted) {
      symbol += ch;
      if (ch === quoted) quoted = undefined;
    } else if (ch === '"' || ch === "'") {
      symbol += ch;
      quoted = ch;
    } else if (ch.trim() === "") {
      if (symbol) {
        out.push(trimPairQuotes(symbol));
        symbol = "";
      }
    } else symbol += ch;
  }
  if (symbol) out.push(trimPairQuotes(symbol));
  return out;
}

function trimPairQuotes(text: string): string {
  const eq = text.indexOf("=");
  if (eq < 0) return text;
  const key = text.slice(0, eq);
  let value = text.slice(eq + 1);
  if (value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'"))) value = value.slice(1, -1);
  return `${key}=${value}`;
}

function stripKnownPrefix(text: string): string {
  const symbols = looseSymbols(text);
  if (!symbols.length) return text;
  const severity = severitySymbol(text);
  if (!severity) return text;
  const idx = text.toLocaleLowerCase().indexOf(severity);
  return idx >= 0 ? text.slice(idx + severity.length).trim() : text;
}

function stripKeyValueSymbols(text: string): string {
  const pieces = looseSymbolsWithEquals(text);
  if (!pieces.some(piece => piece.includes("="))) return text.trim();
  let out = text;
  for (const piece of pieces) if (piece.includes("=")) out = out.split(piece).join(" ");
  return collapseWhitespace(out);
}

function stringAttribute(attributes: Record<string, JsonValue>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

function componentSymbol(text: string, severity: string | undefined): string | undefined {
  if (!severity) return undefined;
  const symbols = looseSymbols(text);
  const severityIndex = symbols.findIndex(symbol => symbol.toLocaleLowerCase() === severity.toLocaleLowerCase());
  if (severityIndex < 0) return undefined;
  const candidate = symbols[severityIndex + 1];
  if (!candidate) return undefined;
  if (candidate.includes("=")) return undefined;
  const normalized = candidate.toLocaleLowerCase();
  if (normalized === "message" || normalized === "msg" || normalized === "event") return undefined;
  return candidate;
}

function terminalMarkCount(text: string): number {
  let count = 0;
  for (const ch of text) if (ch === "." || ch === "!" || ch === "?" || ch === "。" || ch === "؟" || ch === "।") count++;
  return count;
}

function listLineLike(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return false;
  const first = trimmed[0] ?? "";
  if (first === "-" || first === "*" || first === "•") return true;
  let digits = 0;
  while (digits < trimmed.length && isAsciiDigit(trimmed[digits])) digits++;
  return digits > 0 && (trimmed[digits] === "." || trimmed[digits] === ")");
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function observationId(hasher: Hasher, ...parts: unknown[]): string {
  return `observation_${hasher.digestHex(JSON.stringify(parts)).slice(0, 40)}`;
}
