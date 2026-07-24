#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULT_SERVER_URL = process.env.SCCE_LIVE_SERVER_URL ?? "http://127.0.0.1:3873";
const DEFAULT_CASE_COUNT = 240;
const MAX_ALLOWED_LATENCY_MS = 5_000;
const CLIENT_ABORT_RESERVE_MS = 100;
const DEFAULT_OUTPUT = "artifacts/production-live-question-gate.json";
const REPORT_SCHEMA = "scce.production_live_question_gate.v1";

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

const startedAt = new Date().toISOString();
const startedMonotonicMs = performance.now();
const server = normalizedServerUrl(options.serverUrl);
const outputPath = path.resolve(options.output);
const journalPath = outputPath.replace(/\.json$/iu, "") + ".jsonl";
const authorization = process.env.SCCE_API_BEARER_TOKEN?.trim();
const requestHeaders = {
  "content-type": "application/json",
  ...(authorization ? { authorization: `Bearer ${authorization}` } : {})
};
const promptCorpus = buildPromptCorpus();
if (options.start + options.count > promptCorpus.length) {
  throw new Error(`requested questions ${options.start + 1}-${options.start + options.count} but the deterministic corpus contains ${promptCorpus.length}`);
}
const selectedCases = promptCorpus.slice(options.start, options.start + options.count);
const corpusHash = sha256(selectedCases.map(item => `${item.id}\0${item.prompt}`).join("\n"));

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(journalPath, `${JSON.stringify({
  type: "run.started",
  schema: REPORT_SCHEMA,
  startedAt,
  serverOrigin: server.origin,
  startIndex: options.start,
  caseCount: selectedCases.length,
  concurrency: options.concurrency,
  maxLatencyMs: options.maxLatencyMs,
  corpusHash,
  credentialsRecorded: false
})}\n`, "utf8");

let journalTail = Promise.resolve();
const journal = entry => {
  journalTail = journalTail.then(() => appendFile(journalPath, `${JSON.stringify(entry)}\n`, "utf8"));
  return journalTail;
};

let readiness;
let postflightReadiness;
let results = [];
let fatalError;

try {
  readiness = await readHydratedReadiness(server, requestHeaders, options.maxLatencyMs);
  const queue = selectedCases.map((item, index) => ({ ...item, index, corpusIndex: options.start + index }));
  results = new Array(queue.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(options.concurrency, queue.length) }, async () => {
    while (true) {
      const queueIndex = nextIndex++;
      if (queueIndex >= queue.length) return;
      const testCase = queue[queueIndex];
      const result = await runQuestion(server, requestHeaders, testCase, options.maxLatencyMs);
      results[queueIndex] = result;
      await journal({ type: "case.completed", ...result });
      process.stdout.write(formatProgress(result, queue.length));
    }
  });
  await Promise.all(workers);
  postflightReadiness = await readHydratedReadiness(server, requestHeaders, options.maxLatencyMs);
  if (JSON.stringify(readiness.postgres.activeBrain) !== JSON.stringify(postflightReadiness.postgres.activeBrain)) {
    throw new Error("active Postgres brain changed during the live question gate");
  }
} catch (error) {
  fatalError = safeMessage(error);
}

await journalTail;
const completedAt = new Date().toISOString();
const completedResults = results.filter(Boolean);
const failures = completedResults.filter(result => result.status !== "passed");
const report = {
  schema: REPORT_SCHEMA,
  startedAt,
  completedAt,
  elapsedMs: roundMs(performance.now() - startedMonotonicMs),
  serverOrigin: server.origin,
  credentialsRecorded: false,
  liveContract: {
    endpoint: "/api/turn?fast=1",
    responseMode: "compact",
    externalInferenceRequested: false,
    mockOrSimulationAllowed: false,
    maxLatencyMs: options.maxLatencyMs,
    clientAbortReserveMs: CLIENT_ABORT_RESERVE_MS,
    concurrency: options.concurrency
  },
  corpus: {
    schema: "scce.production_live_question_corpus.v1",
    availableCases: promptCorpus.length,
    startIndex: options.start,
    selectedCases: selectedCases.length,
    corpusHash,
    categories: countBy(selectedCases, item => item.category)
  },
  readiness: readiness ? readinessSummary(readiness) : null,
  postflightReadiness: postflightReadiness ? readinessSummary(postflightReadiness) : null,
  summary: {
    status: !fatalError && completedResults.length === selectedCases.length && failures.length === 0 ? "passed" : "failed",
    attempted: completedResults.length,
    passed: completedResults.length - failures.length,
    failed: failures.length,
    notRun: selectedCases.length - completedResults.length,
    latencyMs: latencySummary(completedResults),
    answerWords: numericSummary(completedResults.map(result => result.answerWords))
  },
  failures,
  results: completedResults,
  fatalError,
  artifacts: {
    report: outputPath,
    incrementalJournal: journalPath
  }
};

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await journal({ type: "run.completed", status: report.summary.status, summary: report.summary, fatalError });
await journalTail;
process.stdout.write(`${JSON.stringify({
  schema: REPORT_SCHEMA,
  status: report.summary.status,
  attempted: report.summary.attempted,
  passed: report.summary.passed,
  failed: report.summary.failed,
  notRun: report.summary.notRun,
  report: outputPath,
  journal: journalPath
})}\n`);
if (report.summary.status !== "passed") process.exitCode = 1;

async function readHydratedReadiness(serverUrl, headers, timeoutMs) {
  const response = await fetchText(new URL("/api/ready", serverUrl), {
    method: "GET",
    headers,
    timeoutMs
  });
  if (response.status !== 200) throw new Error(`live readiness returned HTTP ${response.status}: ${response.preview}`);
  const body = parseJson(response.text, "live readiness");
  const counts = body?.postgres?.tableCounts;
  const activeBrain = body?.postgres?.activeBrain;
  const failures = [
    [body?.ok === true, "ready.ok"],
    [body?.warmup?.ok === true && body?.warmup?.complete === true && body?.warmup?.phase === "ready", "warmup.complete"],
    [body?.postgres?.schema === "scce.postgres.status.v1", "postgres.status_schema"],
    [body?.postgres?.ok === true && body?.postgres?.connected === true, "postgres.connected"],
    [body?.postgres?.countSemantics === "postgres_exact_table_counts" && body?.exactCounts === true, "postgres.exact_counts"],
    [positiveCount(counts, "sources"), "postgres.sources_hydrated"],
    [positiveCount(counts, "evidence_spans"), "postgres.evidence_hydrated"],
    [positiveCount(counts, "graph_nodes") && positiveCount(counts, "graph_edges"), "postgres.graph_hydrated"],
    [positiveCount(counts, "language_profiles"), "postgres.language_profiles_hydrated"],
    [positiveCount(counts, "language_patterns") && positiveCount(counts, "ngram_observations"), "postgres.language_state_hydrated"],
    [typeof activeBrain?.activeBrainVersion === "string" && activeBrain.activeBrainVersion.length > 0, "postgres.active_brain"],
    [Array.isArray(activeBrain?.activeImportRunIds) && activeBrain.activeImportRunIds.length > 0, "postgres.active_import"]
  ].filter(([passed]) => !passed).map(([, id]) => id);
  if (failures.length) throw new Error(`server is not a real hydrated production runtime: ${failures.join(", ")}`);
  return body;
}

async function runQuestion(serverUrl, headers, testCase, maxLatencyMs) {
  const started = performance.now();
  let httpStatus = null;
  let answer = "";
  let responseBody;
  const reasons = [];
  try {
    const response = await fetchText(new URL("/api/turn?fast=1", serverUrl), {
      method: "POST",
      headers,
      timeoutMs: Math.max(1, maxLatencyMs - CLIENT_ABORT_RESERVE_MS),
      body: JSON.stringify({
        text: testCase.prompt,
        conversationId: `production-live-gate-${randomUUID()}`,
        metadata: {
          fastLocalEvidenceAnswer: true,
          evaluation: {
            schema: "scce.production_live_question_case.v1",
            caseId: testCase.id,
            category: testCase.category,
            externalInferenceAllowed: false,
            mockAllowed: false
          }
        }
      })
    });
    httpStatus = response.status;
    if (response.status !== 200) {
      reasons.push(`http_${response.status}`);
    } else {
      responseBody = parseJson(response.text, `turn ${testCase.id}`);
      answer = typeof responseBody?.answer === "string" ? responseBody.answer.trim() : "";
      if (!/[\p{L}\p{N}]/u.test(answer)) reasons.push("empty_answer_surface");
      if (normalizeText(answer) === normalizeText(testCase.prompt)) reasons.push("request_echo");
      if (wordCount(answer) < testCase.minimumWords) reasons.push(`extent_below_${testCase.minimumWords}_words`);
      if (hasInternalSurfaceLeak(answer)) reasons.push("internal_runtime_surface_leak");
      if (typeof responseBody?.episodeId !== "string" || !responseBody.episodeId) reasons.push("missing_episode_id");
      if (!isRecord(responseBody?.proofCarryingAnswer)) reasons.push("missing_proof_carrying_answer");
      if (!Array.isArray(responseBody?.events)) reasons.push("missing_traceable_turn_events");
      if ((testCase.category.startsWith("factual.") || testCase.category.startsWith("reasoned."))
        && (!Array.isArray(responseBody?.evidence) || responseBody.evidence.length === 0)) {
        reasons.push("source_bound_answer_without_evidence");
      }
      if (!isRecord(responseBody?.deadline)) reasons.push("missing_runtime_deadline");
      else {
        if (responseBody.deadline.status !== "met") reasons.push(`runtime_deadline_${String(responseBody.deadline.status ?? "unknown")}`);
        if (Number(responseBody.deadline.budgetMs) > MAX_ALLOWED_LATENCY_MS) reasons.push("runtime_deadline_budget_above_5000ms");
        if (Number(responseBody.deadline.elapsedMs) > maxLatencyMs) reasons.push("runtime_deadline_elapsed");
        if (responseBody.deadline.outputSource !== "runtime") reasons.push("runtime_deadline_not_runtime_owned");
      }
    }
  } catch (error) {
    reasons.push(error?.name === "AbortError" || /timeout|aborted/iu.test(safeMessage(error))
      ? `client_timeout_${maxLatencyMs}ms`
      : `request_error:${safeMessage(error)}`);
  }
  const elapsedMs = roundMs(performance.now() - started);
  if (elapsedMs > maxLatencyMs) reasons.push("end_to_end_latency_exceeded");
  const uniqueReasons = [...new Set(reasons)];
  return {
    schema: "scce.production_live_question_result.v1",
    index: testCase.index,
    corpusIndex: testCase.corpusIndex,
    id: testCase.id,
    category: testCase.category,
    prompt: testCase.prompt,
    status: uniqueReasons.length === 0 ? "passed" : "failed",
    failureReasons: uniqueReasons,
    httpStatus,
    elapsedMs,
    answerChars: answer.length,
    answerWords: wordCount(answer),
    answerHash: answer ? sha256(answer) : null,
    answerPreview: preview(answer, 360),
    episodeId: typeof responseBody?.episodeId === "string" ? responseBody.episodeId : null,
    runtimeDeadline: isRecord(responseBody?.deadline) ? responseBody.deadline : null
  };
}

async function fetchText(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: "error",
      signal: controller.signal
    });
    const text = await response.text();
    return { status: response.status, text, preview: preview(text, 300) };
  } finally {
    clearTimeout(timeout);
  }
}

function buildPromptCorpus() {
  const groups = [
    anchorCases(),
    creativeNarrativeCases(),
    inventiveCases(),
    factualCases(),
    explanatoryCases()
  ];
  const result = [];
  const seenPrompts = new Set();
  const maximum = Math.max(...groups.map(group => group.length));
  for (let index = 0; index < maximum; index += 1) {
    for (const group of groups) {
      const item = group[index];
      if (!item || seenPrompts.has(item.prompt)) continue;
      seenPrompts.add(item.prompt);
      result.push(item);
    }
  }
  return result;
}

function anchorCases() {
  return [
    question("anchor.einstein-dragons-20-pages", "creative.extended", "Write a 20-page short story about Albert Einstein fighting dragons.", 5_000),
    question("anchor.einstein-dragons-scene", "creative.narrative", "Write an inventive scene in which Albert Einstein must outwit a dragon without using violence.", 120),
    question("anchor.dragons-fight-einstein", "creative.narrative", "Write a short story about dragons fighting Albert Einstein, with the dragons as the protagonists.", 120),
    question("anchor.cloud-clockmaker", "creative.narrative", "Tell a vivid story about Sera, a clockmaker who confronts a dragon in a city above the clouds.", 120),
    question("anchor.frozen-machine", "creative.narrative", "Invent a tale about Zephyra repairing an ancient machine beneath a frozen ocean.", 120),
    question("anchor.relatively", "factual.science", "What did Albert Einstein contribute to modern physics?", 12),
    question("anchor.printing-press", "factual.history", "How did the printing press change the spread of knowledge?", 20),
    question("anchor.photosynthesis", "reasoned.explanation", "Explain photosynthesis clearly to a curious twelve-year-old without losing the causal steps.", 35)
  ];
}

function creativeNarrativeCases() {
  const protagonists = [
    "a cartographer whose maps predict forgotten roads",
    "a retired astronaut who can hear radio signals in dreams",
    "a violin maker searching for a stolen season",
    "a lighthouse keeper on a moon with two oceans",
    "a young botanist who discovers a plant that remembers voices",
    "an archaeologist excavating tomorrow's ruins",
    "a chef whose recipes briefly alter gravity",
    "a timid dragon employed as a city librarian",
    "a deep-sea engineer building a bridge through darkness",
    "a village of sentient umbrellas",
    "a courier carrying the final handwritten letter",
    "a mathematician who finds an equation hiding in birdsong"
  ];
  const conflicts = [
    "must bargain with a storm that has learned their name",
    "discovers that every victory erases one cherished memory",
    "has one night to prevent a silent city from vanishing",
    "is pursued by an honest machine obeying a terrible instruction",
    "must choose between restoring the past and protecting the future",
    "finds an enemy who is asking the same impossible question"
  ];
  const settings = [
    "inside a railway station orbiting Saturn",
    "among glass forests at the edge of dawn",
    "in a flooded city where boats travel between rooftops",
    "beneath a desert that sings after sunset",
    "on an island that appears once every hundred years"
  ];
  const forms = [
    "Write a vivid short story",
    "Tell the story through escalating scenes and a decisive ending",
    "Create a character-driven tale with wonder, tension, and an earned resolution"
  ];
  const cases = [];
  let ordinal = 0;
  for (const protagonist of protagonists) {
    for (const conflict of conflicts) {
      const setting = settings[ordinal % settings.length];
      const form = forms[ordinal % forms.length];
      cases.push(question(
        `creative.narrative.${String(ordinal + 1).padStart(3, "0")}`,
        "creative.narrative",
        `${form} about ${protagonist}, who ${conflict}, ${setting}.`,
        120
      ));
      ordinal += 1;
    }
  }
  return cases;
}

function inventiveCases() {
  const inventions = [
    "a public library for memories",
    "a city designed for both humans and migratory birds",
    "a musical instrument played by changing its temperature",
    "a school that travels between remote communities",
    "a clock that measures promises instead of seconds",
    "a rescue vehicle for flooded underground tunnels",
    "a museum whose exhibits respond to unanswered questions",
    "a communication system for explorers with no shared language",
    "a garden that helps neighbors resolve conflicts",
    "a spacecraft habitat built around a living forest",
    "a marketplace where nothing can be bought with money",
    "a theatre performance staged simultaneously across three planets",
    "a device that turns waste heat into public art",
    "a scientific expedition to an ocean suspended in the sky",
    "a festival celebrating discoveries that turned out to be wrong"
  ];
  const requests = [
    item => `Invent ${item}. Describe how it works, what could go wrong, and one surprising human consequence.`,
    item => `Imagine ${item}. Give it a coherent design, a practical limitation, and a story of its first day in use.`,
    item => `Develop an original concept for ${item}. Explain its rules, tensions, and the detail that makes it unforgettable.`
  ];
  const cases = [];
  let ordinal = 0;
  for (const invention of inventions) {
    for (const request of requests) {
      cases.push(question(
        `creative.invention.${String(ordinal + 1).padStart(3, "0")}`,
        "creative.invention",
        request(invention),
        80
      ));
      ordinal += 1;
    }
  }
  return cases;
}

function factualCases() {
  const subjects = [
    ["Albert Einstein", "factual.biography"],
    ["Marie Curie", "factual.biography"],
    ["Charles Darwin", "factual.biography"],
    ["Katherine Johnson", "factual.biography"],
    ["George Washington Carver", "factual.biography"],
    ["Leonardo da Vinci", "factual.biography"],
    ["the Nile River", "factual.geography"],
    ["Mount Everest", "factual.geography"],
    ["Antarctica", "factual.geography"],
    ["the Great Barrier Reef", "factual.geography"],
    ["DNA", "factual.science"],
    ["the solar system", "factual.science"],
    ["plate tectonics", "factual.science"],
    ["natural selection", "factual.science"],
    ["the water cycle", "factual.science"],
    ["the French Revolution", "factual.history"],
    ["the Renaissance", "factual.history"],
    ["the Apollo 11 mission", "factual.history"],
    ["the Panama Canal", "factual.history"],
    ["the history of jazz", "factual.history"]
  ];
  const requests = [
    subject => `Give a concise factual overview of ${subject}.`,
    subject => `What is ${subject} best known for, and why is it significant?`,
    subject => `Identify the key people, places, events, or ideas associated with ${subject}.`,
    subject => `Explain the historical or scientific importance of ${subject} in plain English.`
  ];
  const cases = [];
  let ordinal = 0;
  for (const [subject, category] of subjects) {
    for (const request of requests) {
      cases.push(question(
        `factual.${String(ordinal + 1).padStart(3, "0")}`,
        category,
        request(subject),
        12
      ));
      ordinal += 1;
    }
  }
  return cases;
}

function explanatoryCases() {
  const topics = [
    "why seasons occur on Earth",
    "how a rainbow forms",
    "why antibiotics do not treat viruses",
    "how vaccines train immune memory",
    "why ocean tides change",
    "how erosion reshapes a landscape",
    "why metal feels colder than wood at the same temperature",
    "how a bill becomes law in the United States",
    "why compound interest accelerates over time",
    "how encryption protects a message",
    "why eclipses do not happen every month",
    "how a coral reef supports biodiversity",
    "why supply and demand can change prices",
    "how the scientific method handles a failed prediction",
    "why languages change across generations"
  ];
  const frames = [
    topic => `Explain ${topic} as a clear chain of causes and effects.`,
    topic => `Teach me ${topic} using one concrete analogy, then state where the analogy breaks down.`,
    topic => `Give a concise explanation of ${topic}, including a common misconception and its correction.`
  ];
  const cases = [];
  let ordinal = 0;
  for (const topic of topics) {
    for (const frame of frames) {
      cases.push(question(
        `reasoned.explanation.${String(ordinal + 1).padStart(3, "0")}`,
        "reasoned.explanation",
        frame(topic),
        24
      ));
      ordinal += 1;
    }
  }
  return cases;
}

function question(id, category, prompt, minimumWords) {
  return { id, category, prompt, minimumWords };
}

function parseArguments(args) {
  const parsed = {
    serverUrl: DEFAULT_SERVER_URL,
    start: integerOption(process.env.SCCE_QUESTION_GATE_START, 0, "SCCE_QUESTION_GATE_START"),
    count: integerOption(process.env.SCCE_QUESTION_GATE_COUNT, DEFAULT_CASE_COUNT, "SCCE_QUESTION_GATE_COUNT"),
    concurrency: integerOption(process.env.SCCE_QUESTION_GATE_CONCURRENCY, 1, "SCCE_QUESTION_GATE_CONCURRENCY"),
    maxLatencyMs: integerOption(process.env.SCCE_QUESTION_GATE_MAX_MS, MAX_ALLOWED_LATENCY_MS, "SCCE_QUESTION_GATE_MAX_MS"),
    output: process.env.SCCE_QUESTION_GATE_OUTPUT ?? DEFAULT_OUTPUT,
    help: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    const [name, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? args[++index];
    if (value === undefined) throw new Error(`${name} requires a value`);
    if (name === "--server") parsed.serverUrl = value;
    else if (name === "--start") parsed.start = integerOption(value, undefined, name);
    else if (name === "--count") parsed.count = integerOption(value, undefined, name);
    else if (name === "--concurrency") parsed.concurrency = integerOption(value, undefined, name);
    else if (name === "--max-ms") parsed.maxLatencyMs = integerOption(value, undefined, name);
    else if (name === "--output") parsed.output = value;
    else throw new Error(`unknown option ${name}`);
  }
  if (parsed.start < 0) throw new Error("--start must be zero or greater");
  if (parsed.count < 1) throw new Error("--count must be at least 1");
  if (parsed.concurrency < 1 || parsed.concurrency > 32) throw new Error("--concurrency must be between 1 and 32");
  if (parsed.maxLatencyMs < 1 || parsed.maxLatencyMs > MAX_ALLOWED_LATENCY_MS) {
    throw new Error(`--max-ms must be between 1 and ${MAX_ALLOWED_LATENCY_MS}`);
  }
  return parsed;
}

function integerOption(value, fallback, name) {
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`${name} requires an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} requires an integer`);
  return parsed;
}

function normalizedServerUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("--server must use http or https");
  if (url.username || url.password) throw new Error("--server must not contain credentials; use SCCE_API_BEARER_TOKEN");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function positiveCount(counts, key) {
  return isRecord(counts) && Number(counts[key]) > 0;
}

function readinessSummary(body) {
  const counts = body.postgres.tableCounts;
  return {
    schema: body.postgres.schema,
    ok: body.ok,
    warmup: body.warmup,
    exactCounts: body.exactCounts,
    connected: body.postgres.connected,
    databaseSchema: body.postgres.database?.schema ?? null,
    schemaVersion: body.postgres.schemaVersion,
    tableCount: body.postgres.tableCount,
    countSemantics: body.postgres.countSemantics,
    hydratedCounts: {
      sources: counts.sources,
      evidenceSpans: counts.evidence_spans,
      graphNodes: counts.graph_nodes,
      graphEdges: counts.graph_edges,
      languageProfiles: counts.language_profiles,
      languagePatterns: counts.language_patterns,
      ngramObservations: counts.ngram_observations
    },
    activeBrain: body.postgres.activeBrain
  };
}

function latencySummary(results) {
  return numericSummary(results.map(result => result.elapsedMs));
}

function numericSummary(values) {
  if (!values.length) return { min: null, median: null, p95: null, max: null };
  const sorted = values.slice().sort((left, right) => left - right);
  return {
    min: sorted[0],
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1)
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function countBy(items, selector) {
  const counts = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function wordCount(value) {
  return String(value || "").match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function normalizeText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("en").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function hasInternalSurfaceLeak(answer) {
  return /\b(?:mouth_realization_deferred|semantic\.realization\.plan|invention_construct_[a-z0-9]+|proof[- ]bound clauses?|claim basis|runtime deadline schema)\b/iu.test(answer);
}

function formatProgress(result, total) {
  const mark = result.status === "passed" ? "PASS" : "FAIL";
  return `[${String(result.index + 1).padStart(String(total).length, " ")}/${total}] ${mark} ${result.elapsedMs}ms ${result.id}${result.failureReasons.length ? ` ${result.failureReasons.join(",")}` : ""}\n`;
}

function preview(value, maximum) {
  const compact = String(value || "").replace(/\s+/gu, " ").trim();
  return compact.length <= maximum ? compact : `${compact.slice(0, maximum - 1)}…`;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} did not return JSON`);
  }
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]")
    .replace(/Bearer\s+[^\s]+/giu, "Bearer [redacted]")
    .slice(0, 1_000);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function helpText() {
  return `Usage: pnpm questions:live [options]

Runs deterministic English questions against an already-running, hydrated SCCE
server. The gate never starts a server, constructs a runtime, or uses mocks.

Options:
  --server URL       Live server origin (default: ${DEFAULT_SERVER_URL})
  --start N          Zero-based corpus offset for a shard (default: 0)
  --count N          Questions to send (default: ${DEFAULT_CASE_COUNT})
  --concurrency N    Concurrent live requests, 1-32 (default: 1)
  --max-ms N         End-to-end deadline, never above ${MAX_ALLOWED_LATENCY_MS} (default: ${MAX_ALLOWED_LATENCY_MS})
  --output PATH      JSON report path (default: ${DEFAULT_OUTPUT})
  --help             Show this help

Environment:
  SCCE_LIVE_SERVER_URL
  SCCE_API_BEARER_TOKEN
  SCCE_QUESTION_GATE_START
  SCCE_QUESTION_GATE_COUNT
  SCCE_QUESTION_GATE_CONCURRENCY
  SCCE_QUESTION_GATE_MAX_MS
  SCCE_QUESTION_GATE_OUTPUT
`;
}
