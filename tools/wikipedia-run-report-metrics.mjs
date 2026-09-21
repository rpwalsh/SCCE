// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

export function normalizeRunExit(value) {
  if (value === undefined || value === null) return {
    provided: false, status: "unavailable", exitCode: null, elapsedMs: null,
    elapsedMsTrusted: false, pagesBefore: null, pageBaselineSource: null, pagesProcessed: null
  };
  const record = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const exitCode = Number.isInteger(record.exitCode) ? record.exitCode : null;
  const elapsedMs = typeof record.elapsedMs === "number" && Number.isFinite(record.elapsedMs) && record.elapsedMs > 0 ? record.elapsedMs : null;
  const pagesBefore = nonNegativeInteger(record.pagesBefore) ?? nonNegativeInteger(record.baselinePageSources);
  const pageBaselineSource = nonNegativeInteger(record.pagesBefore) !== null
    ? "run-exit.pagesBefore"
    : nonNegativeInteger(record.baselinePageSources) !== null
      ? "run-exit.baselinePageSources"
      : null;
  const pagesProcessed = nonNegativeInteger(record.pagesProcessed);
  return {
    provided: true,
    status: exitCode === null ? "invalid" : exitCode === 0 ? "passed" : "failed",
    exitCode,
    elapsedMs,
    elapsedMsTrusted: elapsedMs !== null,
    pagesBefore,
    pageBaselineSource,
    pagesProcessed,
    schema: typeof record.schema === "string" ? record.schema : null,
    maxPages: Number.isInteger(record.maxPages) && record.maxPages > 0 ? record.maxPages : null,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : null,
    finishedAt: typeof record.finishedAt === "string" ? record.finishedAt : null
  };
}

export function buildIngestionMetrics({ status, databasePages, statusElapsedMs, runExit }) {
  const pagesMeasured = Number.isFinite(Number(databasePages)) ? Number(databasePages) : null;
  const processedPages = runExit.pagesProcessed !== null
    ? runExit.pagesProcessed
    : runExit.pagesBefore !== null && pagesMeasured !== null && pagesMeasured >= runExit.pagesBefore
      ? pagesMeasured - runExit.pagesBefore
      : null;
  const pageCountSource = runExit.pagesProcessed !== null
    ? "run-exit.pagesProcessed"
    : processedPages !== null
      ? `${runExit.pageBaselineSource}+durable-page-count`
      : "unavailable-without-run-local-baseline";
  return {
    statusPages: Number.isFinite(Number(status?.pages)) ? Number(status.pages) : null,
    pagesMeasured,
    pagesProcessed: processedPages,
    pageCountSource,
    pagesPerSecond: runExit.elapsedMsTrusted && processedPages !== null ? rate(processedPages, runExit.elapsedMs) : null,
    statusElapsedMs,
    process: runExit
  };
}

export function reportStatus({ databasePassed, runExit }) {
  const processPassed = !runExit.provided || runExit.status === "passed";
  return {
    status: databasePassed && processPassed ? "passed" : "failed",
    databaseStatus: databasePassed ? "passed" : "failed",
    processStatus: runExit.provided ? runExit.status : "unavailable"
  };
}

function rate(pages, elapsedMs) {
  return elapsedMs > 0 && Number.isFinite(pages) ? Number((pages / (elapsedMs / 1000)).toFixed(3)) : null;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}
