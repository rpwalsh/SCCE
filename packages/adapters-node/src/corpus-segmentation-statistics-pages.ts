// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { BoundaryStatisticsRow, JsonValue } from "@scce/kernel";
import type { PostgresCorpusSegmentationRun } from "./corpus-segmentation-store.js";
import { durableJoinProgramJsonByteLengths } from "./durable-join-program-storage.js";

export const CORPUS_STATISTICS_PAGE_SCHEMA = "scce.corpus_boundary_statistics_page.v1";
type StatisticsStore = Pick<PostgresCorpusSegmentationRun, "bounds" | "pages" | "putInput">;
const massFields = ["anchoredPositiveMass", "anchoredNegativeMass", "latentPositiveMass", "latentNegativeMass", "positiveMass", "negativeMass"] as const;
const ordinal = (page: number) => String(page).padStart(16, "0");
const fail = (): never => { throw Error("Invalid or incomplete corpus boundary statistics pages"); };
function row(value: unknown): value is BoundaryStatisticsRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return typeof fields.key === "string" && Array.isArray(fields.featuresFixed) && fields.featuresFixed.every(Number.isFinite)
    && massFields.every(key => typeof fields[key] === "number" && Number.isFinite(fields[key]));
}

/** Pack only physical storage; logical sufficient-statistic rows retain their original order and fields. */
export async function writeCorpusStatisticsPages(store: StatisticsStore, documentKey: string,
  source: AsyncIterable<readonly BoundaryStatisticsRow[]>, expectedRows: number): Promise<{ logicalRows: number; physicalRows: number }> {
  if (!Number.isSafeInteger(expectedRows) || expectedRows < 0) return fail();
  let page = 1, logicalRows = 0, rows: BoundaryStatisticsRow[] = [], rowBytes = 0;
  const value = () => ({ schema: CORPUS_STATISTICS_PAGE_SCHEMA, rows });
  const headerBytes = durableJoinProgramJsonByteLengths({ orderKey: ordinal(page), value: { ...value(), rows: [] } }).decodedJsonbBytes + 2;
  const flush = async () => {
    if (!rows.length) return;
    const json: JsonValue = JSON.parse(JSON.stringify(value()));
    await store.putInput(`statistics/${documentKey}`, [{ orderKey: ordinal(page), value: json }]);
    rows = []; rowBytes = 0; page++;
    if (!Number.isSafeInteger(page)) throw Error("Corpus statistics page ordinal exceeds its exact representation");
  };
  for await (const chunk of source) for (const value of chunk) {
    if (!row(value) || ++logicalRows > expectedRows) return fail();
    const bytes = durableJoinProgramJsonByteLengths(value).decodedJsonbBytes + 2;
    if (headerBytes + bytes > store.bounds.maxPageBytes) throw Error("Corpus statistics row exceeds decoded JSON page budget");
    if (rows.length && headerBytes + rowBytes + bytes > store.bounds.maxPageBytes) await flush();
    rows.push(value); rowBytes += bytes;
  }
  if (logicalRows !== expectedRows) return fail();
  await flush();
  return { logicalRows, physicalRows: page - 1 };
}

export async function* readCorpusStatisticsPages(store: StatisticsStore, documentKey: string, expectedRows: number): AsyncGenerator<readonly BoundaryStatisticsRow[]> {
  if (!Number.isSafeInteger(expectedRows) || expectedRows < 0) return fail();
  let pageOrdinal = 0, logicalRows = 0;
  for await (const page of store.pages(`input/statistics/${documentKey}`, { pageRows: 1 })) for (const stored of page) {
    if (!stored.value || typeof stored.value !== "object" || Array.isArray(stored.value)) return fail();
    const value = stored.value;
    if (stored.orderKey !== ordinal(++pageOrdinal) || value.schema !== CORPUS_STATISTICS_PAGE_SCHEMA
      || !Array.isArray(value.rows) || !value.rows.length) return fail();
    const rows: BoundaryStatisticsRow[] = [];
    for (const candidate of value.rows) { if (!row(candidate)) return fail(); rows.push(candidate); }
    logicalRows += value.rows.length;
    if (logicalRows > expectedRows) return fail();
    yield rows;
  }
  if (logicalRows !== expectedRows) return fail();
}
