// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIngestionMetrics, normalizeRunExit, reportStatus } from "./wikipedia-run-report-metrics.mjs";

test("run report does not invent throughput without a trusted process duration", () => {
  const runExit = normalizeRunExit(undefined);
  const metrics = buildIngestionMetrics({ status: { pages: 29 }, databasePages: 33, statusElapsedMs: 1_440_000, runExit });
  assert.equal(metrics.pagesMeasured, 33);
  assert.equal(metrics.pagesPerSecond, null);
  assert.equal(metrics.pagesProcessed, null);
  assert.equal(metrics.pageCountSource, "unavailable-without-run-local-baseline");
  assert.equal(reportStatus({ databasePassed: true, runExit }).status, "passed");
});

test("run report labels a crashed process while preserving measured database counts", () => {
  const runExit = normalizeRunExit({ schema: "scce6_runtime", exitCode: 134, elapsedMs: 317405.1447 });
  const metrics = buildIngestionMetrics({ status: { pages: 29 }, databasePages: 33, statusElapsedMs: null, runExit });
  assert.equal(metrics.statusPages, 29);
  assert.equal(metrics.pagesMeasured, 33);
  assert.equal(metrics.pagesProcessed, null);
  assert.equal(metrics.pagesPerSecond, null);
  assert.equal(reportStatus({ databasePassed: true, runExit }).status, "failed");
  assert.equal(reportStatus({ databasePassed: true, runExit }).databaseStatus, "passed");
  assert.equal(reportStatus({ databasePassed: true, runExit }).processStatus, "failed");
});

test("run report derives run-local throughput from a verified durable baseline", () => {
  const runExit = normalizeRunExit({ exitCode: 0, elapsedMs: 1000, pagesBefore: 1000 });
  const metrics = buildIngestionMetrics({ status: { pages: 33 }, databasePages: 1033, statusElapsedMs: null, runExit });
  assert.equal(metrics.pagesMeasured, 1033);
  assert.equal(metrics.pagesProcessed, 33);
  assert.equal(metrics.pageCountSource, "run-exit.pagesBefore+durable-page-count");
  assert.equal(metrics.pagesPerSecond, 33);
});

test("malformed run exit cannot supply throughput", () => {
  const runExit = normalizeRunExit({ exitCode: 0, elapsedMs: "317405" });
  const metrics = buildIngestionMetrics({ status: { pages: 1 }, databasePages: 1, statusElapsedMs: null, runExit });
  assert.equal(runExit.elapsedMsTrusted, false);
  assert.equal(metrics.pagesPerSecond, null);
});
