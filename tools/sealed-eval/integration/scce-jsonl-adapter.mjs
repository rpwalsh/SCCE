#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { createClock, createEvaluationCondition } from "../../../packages/kernel/dist/index.js";
import { assertHydratedRuntimeReady, createNodeRuntime, readScceRuntimeConfig } from "../../../packages/adapters-node/dist/index.js";
import {
  loadVerifiedCorpusManifest,
  mapExactCitations,
  ownerInputForEvaluationQuestion,
  parseEvaluationEnvironment,
  sanitizeAdapterError
} from "./scce-jsonl-adapter-lib.mjs";

let parsedEnvironment;
let environmentError;
try {
  // Read exactly once. No turn can switch condition through mutable globals.
  parsedEnvironment = parseEvaluationEnvironment(process.env);
} catch (error) {
  environmentError = error;
}

let runtime;
// Convert startup failure into data immediately so stdin scheduling cannot turn
// an expected per-question error into an unhandled promise rejection.
const initialized = initialize().then(
  state => ({ state }),
  error => ({ error })
);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

try {
  for await (const line of lines) {
    if (!line.trim()) continue;
    let question;
    try {
      question = JSON.parse(line);
    } catch (error) {
      write({ status: "malformed", answer: "", citations: [], support: {}, trace: [], metrics: {}, error: adapterError("QUESTION_JSON_INVALID", error) });
      continue;
    }
    try {
      const initialization = await initialized;
      if (initialization.error) throw initialization.error;
      const state = initialization.state;
      const ownerInput = ownerInputForEvaluationQuestion(question, state);
      // Trusted in-process control (not JSON metadata): the turn may only
      // answer from source versions byte-matched to the sealed manifest.
      if (state.evidenceSourceAllowlist) {
        ownerInput.runtimeControl = { ...ownerInput.runtimeControl, evidenceSourceAllowlist: state.evidenceSourceAllowlist };
      }
      const started = performance.now();
      const result = await state.runtime.kernel.turn(ownerInput);
      const elapsedMs = Math.max(0, performance.now() - started);
      let sourceVersions = [];
      let citationLookupError;
      try {
        sourceVersions = result.evidence.length
          ? await state.runtime.storage.evidence.sourceVersionsForEvidence(result.evidence.map(span => span.id))
          : [];
      } catch (error) {
        citationLookupError = sanitizeAdapterError(error);
      }
      const citationResult = citationLookupError
        ? { citations: [], omissions: result.evidence.map(span => ({ evidenceId: String(span.id), sourceVersionId: String(span.sourceVersionId), reason: "source-version-lookup-failed" })) }
        : mapExactCitations({ evidence: result.evidence, sourceVersions, corpus: state.corpus });
      const trace = Array.isArray(result.evaluationTrace) ? result.evaluationTrace : [];
      write({
        status: result.assistantForce === "insufficient_support" ? "abstained" : "ok",
        answer: result.answer,
        citations: citationResult.citations,
        support: {
          epistemicForce: result.epistemicForce,
          assistantForce: result.assistantForce ?? null,
          evidenceForce: result.evidenceForce,
          truthState: result.truthState,
          answerBasis: result.answerBasis ?? null,
          guardFlags: result.guardFlags,
          evidenceCount: result.evidence.length,
          calibrationStatus: result.calibrationStatus,
          calibration: result.calibration ?? null
        },
        // These are the production kernel's component-boundary events verbatim.
        // The adapter does not invent lifecycle or component events.
        trace,
        metrics: { elapsedMs, timing: result.timing ?? null },
        metadata: {
          episodeId: String(result.episodeId),
          activeBrainVersion: state.readiness.activeBrainVersion,
          conditionId: state.condition.conditionId,
          conditionConfigHash: state.condition.configHash,
          cacheNamespace: state.condition.cacheNamespace,
          runtimeEventTypes: result.events.map(event => String(event.typeId)),
          exactCitationCount: citationResult.citations.length,
          omittedCitationCount: citationResult.omissions.length,
          citationOmissions: citationResult.omissions,
          ...(citationLookupError ? { citationLookupError } : {})
        }
      });
    } catch (error) {
      write({ status: "error", answer: "", citations: [], support: {}, trace: [], metrics: {}, error: adapterError("SCCE_RUNTIME_ERROR", error) });
    }
  }
} finally {
  if (runtime) await runtime.close();
}

/** Every connector off, by construction rather than by listing the ones known today: a connector added later is disabled here without anyone remembering to update this. */
function withConnectorsDisabled(config) {
  const connectors = config.connectors ?? {};
  const disabled = {};
  for (const [name, value] of Object.entries(connectors)) {
    disabled[name] = value && typeof value === "object" ? { ...value, enabled: false } : value;
  }
  return { ...config, connectors: disabled };
}

async function initialize() {
  if (environmentError) throw environmentError;
  const condition = createEvaluationCondition(parsedEnvironment.conditionInput);
  const corpus = await loadVerifiedCorpusManifest(parsedEnvironment.corpusManifestPath);
  const loadedConfig = await readScceRuntimeConfig(parsedEnvironment.configPath);
  const schemaScopedConfig = parsedEnvironment.databaseSchema
    ? { ...loadedConfig, database: { ...loadedConfig.database, schema: parsedEnvironment.databaseSchema } }
    : loadedConfig;
  // A sealed run answers from the sealed corpus or it abstains -- it never
  // reaches the network, whatever the ambient config says. The system
  // manifest declares networkPolicy "disabled", but that field is a
  // declaration the harness does not enforce anywhere, so enforcement
  // belongs here, at the one place that knows an evaluation is running.
  // Live-verified violation this prevents: with the ambient config's web
  // connector enabled, "What is the boiling point of tungsten?" and
  // "Who won the 1998 FIFA World Cup?" -- both absent from the corpus by
  // construction, both abstention probes -- came back carrying live
  // DuckDuckGo results, which silently converts a sealed evaluation into
  // an open-web one.
  const config = withConnectorsDisabled(schemaScopedConfig);
  const clock = createClock({ fixedTime: Date.parse(condition.clockIso), stepMs: 1 });
  runtime = createNodeRuntime(config, {
    evaluationCondition: condition,
    evaluationRunId: parsedEnvironment.runId,
    clock,
    runSeed: condition.seed,
    deterministicReplay: true
  });
  try {
    const readiness = await assertHydratedRuntimeReady(runtime.storage);
    // Sealed for real: derive the allowlist of source versions the runtime
    // may answer from directly from the manifest documents' content hashes.
    // Identity of bytes, never document ids or paths. A manifest document
    // with no matching live source version simply contributes nothing --
    // the harness's byte-identity check already catches corpus drift.
    let evidenceSourceAllowlist;
    if (typeof runtime.storage.evidence.sourceVersionsByContentHashes === "function") {
      const hashes = [...corpus.documents.values()].map(document => `sha256_${document.sha256}`);
      const sealedVersions = await runtime.storage.evidence.sourceVersionsByContentHashes(hashes);
      evidenceSourceAllowlist = Object.freeze(sealedVersions.map(version => version.sourceVersionId));
    }
    return { runtime, readiness, corpus, condition, runId: parsedEnvironment.runId, evidenceSourceAllowlist };
  } catch (error) {
    await runtime.close();
    runtime = undefined;
    throw error;
  }
}

function adapterError(code, error) {
  return { code, message: sanitizeAdapterError(error) };
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
