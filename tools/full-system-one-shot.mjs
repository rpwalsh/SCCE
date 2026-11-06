#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { mkdtemp, mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";
import { validAbstention } from "./full-system-one-shot-gates.mjs";

/**
 * Acceptance gate 20: the whole architecture, once, on material it has never seen.
 *
 * The corpus is invented here and ingested into a schema created for this run and dropped after it, and the
 * subjects are nonsense on purpose, so a correct answer cannot be recall.
 *
 * The load-bearing part is the negative control. The same question is asked BEFORE the corpus exists and again
 * after it is ingested and promoted, and the gate requires the first to fail and the second to succeed. Without
 * that pair, an answer only shows that the system said something true; with it, the run locates the moment the
 * knowledge was acquired. A cache, a resident model or a pre-warmed structure that already knew the answer would
 * answer the first question too, so the control also closes the "something else already knew this" objection
 * that isolating the database schema alone cannot close.
 *
 * The answer assertion is provenance-bound rather than string-bound: the value must appear in the answer AND in
 * the evidence the turn actually carried. An implementation that produced the right number without using the
 * retrieved span fails this gate.
 *
 * A failing stage does not stop the run, because a reviewer learns more from seeing which stages hold than from
 * the first exception. The exit code is non-zero when a required stage fails, so it still works in CI.
 */

const args = new Map(process.argv.slice(2)
  .filter(argument => argument.startsWith("--"))
  .map(argument => { const [name, value] = argument.slice(2).split("="); return [name, value ?? "1"]; }));
const singleSourceMode = args.has("source");
const configPath = args.get("config") ?? process.env.SCCE_CONFIG ?? "scce.config.json";
const outputPath = args.get("out") ?? "artifacts/full-system-one-shot.json";
const keepSchema = args.has("keep-schema");
const singleSourcePath = args.get("source") ? path.resolve(args.get("source")) : undefined;
const singleSourceQuestion = args.get("question");
const singleSourceExpected = args.get("expected");
const singleSourceTitle = args.get("title") ?? (singleSourcePath ? path.basename(singleSourcePath, path.extname(singleSourcePath)) : "");
if (singleSourcePath && (!singleSourceQuestion || !singleSourceExpected || !singleSourceTitle)) {
  throw new Error("--source requires --question, --expected, and an optional --title");
}
let peakRssBytes = process.memoryUsage().rss;
const rssSampler = setInterval(() => { peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss); }, 250);
rssSampler.unref();

if (!process.env.SCCE_DATABASE_URL) {
  try {
    process.env.SCCE_DATABASE_URL = JSON.parse(readFileSync("scce.config.local.json", "utf8")).database.url;
  } catch {
    process.stderr.write("no SCCE_DATABASE_URL, and no scce.config.local.json to read one from\n");
    process.exit(2);
  }
}

// --trace prints the per-turn cognitive trace, so a reader can check that a stage happened rather than trusting
// the pass mark for it.
let traceFile;
if (args.has("trace")) {
  process.env.SCCE_TRACE = "1";
  const { createTrace } = await import("../packages/kernel/dist/debug/trace.js");
  const trace = createTrace("one-shot");
  globalThis.__sccTrace = trace;
  traceFile = trace.file;
}
const { createNodeRuntime, readScceRuntimeConfig } = await import("../packages/adapters-node/dist/index.js");

const schema = `scce_oneshot_${process.pid}_${Date.now()}`;
if (!/^scce_oneshot_[a-z0-9_]+$/u.test(schema)) throw new Error("refusing unsafe schema name");

const stages = [];
const stage = (id, required, passed, observed) => {
  stages.push({ id, required, passed: Boolean(passed), observed });
  const mark = passed ? "  ok  " : required ? " FAIL " : " warn ";
  process.stdout.write(`${mark} ${id.padEnd(34)} ${observed}\n`);
};

/**
 * The architectural capabilities a full turn is claimed to traverse, named by the events each one emits.
 *
 * Counting distinct events proves only that the turn was chatty. A buyer asking "which capabilities actually
 * participated" needs the identities, and a capability that stops emitting is a regression this gate should
 * fail on rather than absorb into a threshold.
 */
const REQUIRED_CAPABILITIES = {
  request_understanding: ["TurnRequirementsBuilt"],
  authority_projection: ["RequestedAuthorityProjected"],
  graph_update: ["GraphUpdated"],
  field_dynamics: ["FieldSeeded", "FieldActivated", "FieldPropagated"],
  spectral_ranking: ["PPFComputed"],
  causal_discovery: ["CausalGraphDiscovered"],
  evidence_binding: ["EvidenceLinked"],
  proof_entailment: ["SemanticEntailmentChecked"],
  candidate_generation: ["CandidateGenerated"],
  candidate_selection: ["CandidateSelected"],
  working_memory: ["WorkingMemoryScoped"],
  construct_graph: ["ConstructGraphBuilt"],
  counterfactual: ["CounterfactualSimulated"],
  validation: ["ValidationGraphBuilt"],
  coherence_decision: ["RuntimeCoherenceDecided"],
  realization: ["MouthSpoken"],
  episode_persistence: ["EpisodeClosed"]
};

/** Invented subjects: no corpus carries these, so a correct answer can only have come from this run's ingest. */
const DOCUMENTS = [
  {
    id: "doc-kelvinge",
    title: "Kelvinge Threshold",
    name: "kelvinge.txt",
    text: [
      "The Kelvinge threshold is the point at which a brindle lattice stops conducting.",
      "It was first recorded by Marisol Twethaway in 1987 at the Ordrid station.",
      "The threshold sits at 412 kelvin for a standard brindle lattice.",
      ""
    ].join("\n")
  },
  {
    id: "doc-ordrid",
    title: "Ordrid Station",
    name: "ordrid.txt",
    text: [
      "Ordrid station operates a brindle lattice array on the Vantam plateau.",
      "The station was commissioned in 1984 and is licensed under the Serrick compact.",
      ""
    ].join("\n")
  }
];

/** Ingested after the first answer, to see whether a later contradiction is exposed rather than averaged away. */
const CONTRADICTION = {
  id: "doc-kelvinge-revised",
  title: "Kelvinge Threshold Revision",
  name: "kelvinge-revised.txt",
  text: "A 2019 recalibration places the Kelvinge threshold at 455 kelvin, superseding the 1987 figure.\n"
};

const QUESTION = "What is the Kelvinge threshold?";
/** Whitespace-normalised, so a verbatim-excerpt check is not defeated by line wrapping. */
const normalize = (value) => String(value).replace(/\s+/gu, " ").trim().toLowerCase();
const UNANSWERABLE = "What is the Perrindale coefficient?";

const corpusDocuments = singleSourcePath
  ? [{
    id: "doc-local-source",
    title: singleSourceTitle,
    name: path.basename(singleSourcePath),
    sourcePath: singleSourcePath,
    sourceBytes: readFileSync(singleSourcePath),
    text: ""
  }]
  : DOCUMENTS;
if (singleSourcePath) corpusDocuments[0].text = corpusDocuments[0].sourceBytes.toString("utf8");
const question = singleSourceQuestion ?? QUESTION;
const unanswerableQuestion = singleSourcePath
  ? args.get("unanswerable") ?? `What was the ISBN of the first edition of ${singleSourceTitle}?`
  : UNANSWERABLE;

const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "scce-one-shot-"));
let runtime;
let fatal;
let rawSourceIdentity;
let databaseSizeBytes = {};

const schemaDatabaseBytes = async () => {
  const rows = await runtime.storage.query(`
    SELECT COALESCE(SUM(pg_total_relation_size(format('%I.%I', schemaname, tablename))), 0)::text AS bytes
      FROM pg_tables
     WHERE schemaname = $1`, [schema]);
  return Number(rows[0]?.bytes ?? 0);
};

const ingestDocument = async (document) => {
  const bytes = document.sourceBytes ?? Buffer.from(document.text, "utf8");
  const file = document.sourcePath ?? path.join(fixtureRoot, document.name);
  if (!document.sourcePath) await writeFile(file, bytes);
  const uri = pathToFileURL(file).href;
  const result = await runtime.kernel.ingest({
    content: bytes,
    uri,
    namespace: "one-shot",
    mediaType: "text/plain",
    sourceAdmission: { sourceClass: "owner_local", intendedUse: "direct_evidence", promotionAuthority: "owner" },
    sourceTrust: {
      identity: 1, integrity: 1, parserReliability: 0.94, directness: 1, authority: 1, freshness: 0.98,
      independenceGroup: `one-shot-${document.id}`, accessScope: "owner_private", licenseStatus: "owner_authorized"
    },
    metadata: { title: document.title, documentId: document.id }
  });
  if (document.sourcePath) {
    const expectedHash = createHash("sha256").update(bytes).digest("hex");
    const versions = await runtime.storage.query(`
      SELECT sv.id, sv.content_hash AS "contentHash", sv.byte_length AS "byteLength"
        FROM ${runtime.storage.table("source_versions")} sv
        JOIN ${runtime.storage.table("sources")} s ON s.id = sv.source_id
       WHERE s.canonical_uri = $1`, [uri]);
    const matching = versions.find(row => String(row.contentHash).replace(/^sha256_/u, "") === expectedHash
      && Number(row.byteLength) === bytes.byteLength);
    const blob = matching
      ? (await runtime.storage.query(`SELECT content FROM ${runtime.storage.table("blobs")} WHERE content_hash = $1`, [matching.contentHash]))[0]?.content
      : undefined;
    rawSourceIdentity = {
      path: document.sourcePath,
      byteLength: bytes.byteLength,
      sha256: expectedHash,
      storedVersionCount: versions.length,
      storedSourceVersionId: matching?.id ?? null,
      storedByteLength: matching ? Number(matching.byteLength) : null,
      blobByteIdentityVerified: Boolean(blob && Buffer.from(blob).equals(bytes))
    };
  }
  return result;
};

const promote = () => runtime.kernel.train({
  config: { promotion: { minTrust: 0, namespaces: ["one-shot"] }, learningGoals: [] }
});

const ask = async (text) => {
  const started = Date.now();
  const traceBefore = traceFile ? readFileSync(traceFile, "utf8").length : 0;
  const result = await runtime.kernel.turn({ text });
  if (traceFile) {
    const rows = readFileSync(traceFile, "utf8").slice(traceBefore).trim().split(/\r?\n/u).filter(Boolean);
    process.stdout.write(`  --- trace for ${JSON.stringify(text)}\n`);
    for (const line of rows) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (!/proposal|score|planner|mouth|turn\.output|admission|excerpt/u.test(String(row.stage))) continue;
      const support = args.has("verbose") ? ` ${JSON.stringify(row.support ?? {}).slice(0, 700)}` : "";
      process.stdout.write(`      ${String(row.stage).padEnd(34)} ${JSON.stringify(row.counts ?? {})}${support}\n`);
    }
  }
  const answer = String(result.answer ?? "");
  const evidenceText = (result.evidence ?? []).map(span => String(span.text ?? span.textPreview ?? "")).join(" ");
  return {
    text,
    durationMs: Date.now() - started,
    answer,
    force: result.epistemicForce ?? null,
    assistantForce: result.assistantForce ?? null,
    realizationAvailability: result.realizationAvailability ?? null,
    withheld: result.withheld ?? null,
    evidence: result.evidence?.length ?? 0,
    evidenceText,
    events: [...new Set((result.events ?? []).map(event => String(event.typeId)))]
  };
};

try {
  const loaded = await readScceRuntimeConfig(configPath);
  const config = { ...loaded, database: { ...loaded.database, schema } };

  runtime = createNodeRuntime(config, { deterministicReplay: true, runSeed: "full-system-one-shot" });
  await runtime.storage.migrate();
  // The server warms the runtime before it serves, and a harness that skips it measures a path production never
  // takes: without warmup the first turn to touch a language cluster hydrates nothing, and the closed-class
  // derivation that tells a question word from a content word receives an empty model set.
  const warmup = await runtime.kernel.warmup({ languageLimit: 64 }).catch(() => undefined);
  const verified = await runtime.storage.verify();
  stage("cold_start.schema_verify", true, verified.ok,
    verified.ok ? `schema ${schema} migrated clean` : verified.errors.join("; ").slice(0, 200));
  stage("cold_start.warmup", false, Boolean(warmup),
    warmup
      ? `${Math.round(warmup.totalMs ?? 0)}ms, language models=${warmup.language?.models ?? 0} units=${warmup.language?.units ?? 0}`
      : "warmup unavailable");

  // Negative control. Everything after this is only evidence of acquisition because this came back empty.
  const before = await ask(question);
  const ignorant = before.evidence === 0 && (singleSourcePath
    ? before.force === "unknown"
      && !before.answer.toLocaleLowerCase().includes(singleSourceExpected.toLocaleLowerCase())
      && validAbstention({ force: before.force, answer: before.answer, evidenceCount: before.evidence, assistantForce: before.assistantForce, realizationAvailability: before.realizationAvailability, withheld: before.withheld })
    : !/412|455/u.test(before.answer));
  stage("control.unknown_before_ingest", true, ignorant,
    `force=${before.force} assistantForce=${before.assistantForce} availability=${before.realizationAvailability?.status ?? "missing"} evidence=${before.evidence} answer=${JSON.stringify(before.answer.slice(0, 60))}`);

  let ingestedEvidence = 0;
  const ingestedResults = [];
  for (const document of corpusDocuments) {
    const ingested = await ingestDocument(document);
    ingestedResults.push(ingested);
    ingestedEvidence += ingested.evidence ?? 0;
  }
  stage("ingest.novel_corpus", true, ingestedEvidence > 0,
    `${ingestedEvidence} evidence spans from ${corpusDocuments.length} unseen documents`);
  if (singleSourcePath) {
    const rawIdentityOk = rawSourceIdentity?.storedVersionCount === 1 && rawSourceIdentity.blobByteIdentityVerified;
    stage("ingest.raw-source-byte-identity", true, rawIdentityOk,
      `bytes=${rawSourceIdentity?.byteLength ?? 0} sha256=${rawSourceIdentity?.sha256 ?? "missing"} stored=${rawIdentityOk}`);
    databaseSizeBytes.afterIngest = await schemaDatabaseBytes();
  }

  const training = await promote();
  stage("learning.promote", true, (training.promotedEvidence ?? 0) > 0, `promoted ${training.promotedEvidence}`);
  if (singleSourcePath) databaseSizeBytes.afterTraining = await schemaDatabaseBytes();

  const graph = await runtime.storage.graph.getSlice({ limitNodes: 400, limitEdges: 400, allowLatestFallback: true });
  stage("graph.construction", true, graph.nodes.length > 0,
    `${graph.nodes.length} nodes and ${graph.edges.length} edges built from the ingest`);

  const answer = await ask(question);
  const subjectPresent = singleSourcePath
    ? normalize(answer.evidenceText).includes(normalize(singleSourceTitle))
    : /kelvinge/iu.test(answer.evidenceText);
  stage("retrieval.finds_subject", true, subjectPresent,
    `${answer.evidence} evidence spans carried by the turn, subject present: ${subjectPresent}`);

  // Provenance-bound rather than string-bound, and without presuming which sentence answers: whatever is said
  // must be text this run ingested. "What is X" is legitimately answered by a definition or by a value, so
  // asserting one of them would test the harness's taste rather than the system's grounding.
  const corpusText = normalize((singleSourcePath ? corpusDocuments : [...DOCUMENTS, CONTRADICTION])
    .map(document => document.text).join(" "));
  const spoken = normalize(answer.answer);
  const grounded = spoken.length > 0 && corpusText.includes(spoken.replace(/\s*source:.*$/iu, "").trim());
  stage("realization.answers_from_evidence", true, grounded, grounded
    ? `answered verbatim from ingested text in ${answer.durationMs}ms`
    : `force=${answer.force} answer=${JSON.stringify(answer.answer.slice(0, 110))}`);
  if (singleSourcePath) {
    const expectedInAnswer = answer.answer.toLocaleLowerCase().includes(singleSourceExpected.toLocaleLowerCase());
    const expectedInEvidence = answer.evidenceText.toLocaleLowerCase().includes(singleSourceExpected.toLocaleLowerCase());
    stage("realization.answers_expected_fact", true, expectedInAnswer && expectedInEvidence,
      `expected=${JSON.stringify(singleSourceExpected)} answer=${expectedInAnswer} evidence=${expectedInEvidence}`);
  }

  // A question whose answer is a specific value the corpus states, so retrieval is tested on more than a definition.
  if (!singleSourcePath) {
    const valued = await ask("At what temperature does the Kelvinge threshold sit?");
    const statesValue = /412/u.test(valued.answer) && /412/u.test(valued.evidenceText);
    stage("realization.answers_specific_value", true, statesValue, statesValue
      ? "the stated figure was recovered from the ingested document"
      : `force=${valued.force} evidence=${valued.evidence} answer=${JSON.stringify(valued.answer.slice(0, 110))}`);
  }

  // The acquisition claim itself: unknown before, known after, same question, same process.
  stage("acquisition.control_to_known", true, ignorant && grounded,
    ignorant && grounded
      ? "the same question returned nothing before ingest and an evidence-grounded answer after it"
      : `before-ingest ignorant: ${ignorant}, after-ingest grounded: ${grounded}`);

  if (!singleSourcePath) {
    const observed = new Set(answer.events);
    const missing = Object.entries(REQUIRED_CAPABILITIES)
      .filter(([, events]) => !events.every(event => observed.has(event)))
      .map(([capability]) => capability);
    stage("cognition.named_capabilities", true, missing.length === 0,
      missing.length === 0
        ? `all ${Object.keys(REQUIRED_CAPABILITIES).length} named capabilities emitted their events`
        : `missing: ${missing.join(", ")}`);
  }

  // Abstention is about epistemic force, not about digits: an unsupported factual assertion is the failure,
  // whatever characters it is spelled with.
  const unanswerable = await ask(unanswerableQuestion);
  const abstains = singleSourcePath
    ? validAbstention({ force: unanswerable.force, answer: unanswerable.answer, evidenceCount: unanswerable.evidence, assistantForce: unanswerable.assistantForce, realizationAvailability: unanswerable.realizationAvailability, withheld: unanswerable.withheld })
    : unanswerable.evidence === 0 && unanswerable.force === "unknown";
  stage("abstention.refuses_unknown", true, abstains,
    `force=${unanswerable.force} assistantForce=${unanswerable.assistantForce} availability=${unanswerable.realizationAvailability?.status ?? "missing"} evidence=${unanswerable.evidence} validNonanswer=${singleSourcePath ? abstains : "not checked by full-gate legacy rule"} answer=${JSON.stringify(unanswerable.answer.slice(0, 70))}`);

  if (!singleSourcePath) {
    await ingestDocument(CONTRADICTION);
    await promote();
    const revised = await ask(QUESTION);
    const sawRevision = /455/u.test(revised.evidenceText) || /455/u.test(revised.answer);
    stage("contradiction.surfaces_revision", false, sawRevision, sawRevision
      ? "the superseding figure reached the answer or its evidence"
      : `answer=${JSON.stringify(revised.answer.slice(0, 90))} evidence=${revised.evidence}`);
  }

  // Induced failure: drop the runtime mid-life and rebuild it against the same durable state.
  await runtime.close?.();
  runtime = createNodeRuntime(config, { deterministicReplay: true, runSeed: "full-system-one-shot" });
  const afterRestart = await ask(question);
  if (singleSourcePath) databaseSizeBytes.afterRestart = await schemaDatabaseBytes();
  const restartRecovered = afterRestart.evidence > 0 && (!singleSourcePath
    || (afterRestart.answer.toLocaleLowerCase().includes(singleSourceExpected.toLocaleLowerCase())
      && afterRestart.evidenceText.toLocaleLowerCase().includes(singleSourceExpected.toLocaleLowerCase())));
  stage("recovery.survives_restart", true, restartRecovered,
    `after restart: ${afterRestart.evidence} evidence spans, expected fact present: ${singleSourcePath ? afterRestart.answer.toLocaleLowerCase().includes(singleSourceExpected.toLocaleLowerCase()) && afterRestart.evidenceText.toLocaleLowerCase().includes(singleSourceExpected.toLocaleLowerCase()) : "n/a"}, force ${afterRestart.force}`);

  const anchor = singleSourcePath
    ? `anchor:sym:${singleSourceTitle.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "")}`
    : "anchor:sym:kelvinge";
  const persisted = await runtime.storage.evidence.searchEvidence({ features: [anchor], limit: 8 });
  stage("persistence.durable_state", true, persisted.length > 0,
    `${persisted.length} spans still retrievable by anchor after restart`);
} catch (error) {
  fatal = String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted]").slice(0, 400);
  process.stdout.write(` FAIL harness threw: ${fatal}\n`);
} finally {
  try {
    if (runtime && !keepSchema) await runtime.storage.query?.(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } catch { /* the schema is disposable; a failed drop is not a gate result */ }
  await runtime?.close?.().catch(() => undefined);
  clearInterval(rssSampler);
  // Only the files this run wrote, then the directory if it is empty: never a recursive delete.
  for (const document of [...corpusDocuments, ...(singleSourcePath ? [] : [CONTRADICTION])]) {
    if (!document.sourcePath) await unlink(path.join(fixtureRoot, document.name)).catch(() => undefined);
  }
  await rmdir(fixtureRoot).catch(() => undefined);
}

const required = stages.filter(entry => entry.required);
const failed = required.filter(entry => !entry.passed);
const report = {
  schema: "scce.full_system_one_shot.v1",
  mode: singleSourceMode ? "single_source_build_recovery_diagnostic" : "full_architecture_one_shot",
  qualification: singleSourceMode ? false : undefined,
  qualificationNote: singleSourceMode
    ? "One-source diagnostic only; named full-architecture and contradiction gates are intentionally skipped. This does not qualify whole-machine memory, package, deployment or release readiness."
    : undefined,
  restartScope: singleSourceMode
    ? { kernelRuntimeRecreated: true, coldServerRestartVerified: false, retainedSchemaRequested: keepSchema }
    : undefined,
  generatedAt: new Date().toISOString(),
  config: configPath,
  disposableSchema: schema,
  corpus: {
    documents: singleSourcePath ? corpusDocuments.length : DOCUMENTS.length + 1,
    subjectsInvented: !singleSourcePath,
    negativeControl: true,
    ...(singleSourcePath ? { rawSourceIdentity } : {})
  },
  resourceUsage: {
    sampledPeakNodeRssBytes: peakRssBytes,
    processPeakRssBytes: Number(process.resourceUsage().maxRSS) * 1024,
    currentNodeRssBytes: process.memoryUsage().rss,
    heapLimitBytes: getHeapStatistics().heap_size_limit,
    databaseRelationBytes: databaseSizeBytes
  },
  passed: failed.length === 0 && !fatal,
  requiredStages: required.length,
  requiredPassed: required.length - failed.length,
  ...(fatal ? { fatal } : {}),
  stages
};
await mkdir(path.dirname(path.resolve(outputPath)), { recursive: true }).catch(() => undefined);
writeFileSync(path.resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`\n${report.requiredPassed}/${report.requiredStages} required stages passed. wrote ${outputPath}\n`);
process.exit(report.passed ? 0 : 1);
