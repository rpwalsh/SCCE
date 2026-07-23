#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createEvaluationCondition,
  verifyPatchTransactionPlan
} from "../packages/kernel/dist/index.js";
import {
  createNodeRuntime,
  createPostgresStorageAdapter,
  createWorkspaceRuntime,
  readScceRuntimeConfig
} from "../packages/adapters-node/dist/index.js";
import { verifyYoppEvaluationTrace } from "./sealed-eval/integration/yopp-trace-verifier.mjs";

const outputDirectory = path.resolve(".tmp/runtime-authority-matrix");
const configPath = path.resolve(process.env.SCCE_AUTHORITY_MATRIX_CONFIG ?? "scce.config.json");
const REASONED_MEASUREMENT_FIXTURE = "Measurement A reports 42 kPa while measurement B reports 57 kPa at the same timestamp.";
const REASONED_CONFLICT_FIXTURE = "Contradictory measurements require reconciliation because one physical state cannot retain incompatible values at the same time.";
const REASONED_FIXTURE = `${REASONED_MEASUREMENT_FIXTURE} ${REASONED_CONFLICT_FIXTURE}`;
const CREATIVE_LANGUAGE_FIXTURE = "At dusk, the old pump hummed beside the quiet harbor. It dreamed of carrying starlight across the sleeping town. Before dawn, its steady rhythm became a silver melody and woke the patient bells.";
const CREATIVE_REQUEST_FIXTURE = "Write a fictional two-sentence story about a purple pump that learns to sing.";
const TRANSLATION_TARGET_FIXTURE = "Pump alpha es estable.";
const ACTION_REQUEST_FIXTURE = "Create a command action plan to restart pump alpha without executing it.";
const ACTION_CAPABILITY_FIXTURE = "process.local";
const ACTION_PHASE_FIXTURE = "prepare";
const schema = `scce_authority_matrix_${process.pid}_${Date.now()}`;
if (!/^scce_authority_matrix_[a-z0-9_]+$/u.test(schema)) throw new Error("refusing unsafe authority-matrix schema name");

await mkdir(outputDirectory, { recursive: true });
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "scce-authority-matrix-"));
const checks = [];
const cases = [];
let runtime;
let cleanupStorage;
let config;
let primaryError;
let blocked = false;

const condition = createEvaluationCondition({
  conditionId: "full",
  seed: "runtime-authority-matrix-v1",
  clockIso: "2026-07-13T16:30:00.000-07:00",
  scope: "answer-quality"
});

try {
  await writeFixture(fixtureRoot);
  const loaded = await readScceRuntimeConfig(configPath);
  config = {
    ...loaded,
    database: { ...loaded.database, schema },
    runtime: {
      ...loaded.runtime,
      workspaceRoot: fixtureRoot,
      tempRoot: path.join(fixtureRoot, ".tmp"),
      allowedRoots: [fixtureRoot],
      excludedPaths: ["node_modules", "dist", ".git", ".tmp"]
    }
  };
  runtime = createNodeRuntime(config, {
    deterministicReplay: true,
    runSeed: condition.seed,
    evaluationCondition: condition,
    evaluationRunId: "runtime-authority-matrix-v1"
  });
  await runtime.storage.migrate();
  const verification = await runtime.storage.verify();
  requireCheck("postgres.schema", verification.ok, { errors: verification.errors });

  const workspaceRuntime = createWorkspaceRuntime({ runtime, config });
  await workspaceRuntime.init(fixtureRoot, { maxFiles: 64, maxDepth: 8 });
  const workspaceIngest = await workspaceRuntime.ingest(fixtureRoot, { maxFiles: 64, maxDepth: 8 });
  requireCheck("workspace.ingest", workspaceIngest.ingested > 0 && workspaceIngest.failed === 0, {
    ingested: workspaceIngest.ingested,
    failed: workspaceIngest.failed,
    unsupported: workspaceIngest.unsupported
  });

  const fixtureIngests = new Map();
  fixtureIngests.set("factual", await runtime.kernel.ingest({
    uri: "authority-matrix://pump-alpha/control",
    namespace: "authority-matrix",
    mediaType: "text/plain",
    content: "Pump alpha is controlled by API route POST /api/pumps/alpha/control.",
    metadata: { fixtureRole: "factual", sourceKind: "authority-matrix.source" }
  }));
  fixtureIngests.set("reasoned", await runtime.kernel.ingest({
    uri: "authority-matrix://pump-alpha/measurements",
    namespace: "authority-matrix",
    mediaType: "text/plain",
    content: REASONED_FIXTURE,
    metadata: { fixtureRole: "reasoned", sourceKind: "authority-matrix.source" }
  }));
  fixtureIngests.set("translation", await runtime.kernel.ingest({
    uri: "authority-matrix://pump-alpha/es",
    namespace: "authority-matrix",
    mediaType: "text/plain",
    content: TRANSLATION_TARGET_FIXTURE,
    metadata: { fixtureRole: "translation", sourceKind: "authority-matrix.source" }
  }));
  fixtureIngests.set("program", await runtime.kernel.ingest({
    uri: "authority-matrix://workspace/src/index.ts",
    namespace: "authority-matrix",
    mediaType: "text/plain",
    content: [
      "The compiler configuration is strict, uses module NodeNext with moduleResolution NodeNext, and includes src.",
      "Compiler validation of src/index.ts reports TS2552 at line 3, column 22.",
      "The diagnostic is: Cannot find name 'coutn'. Did you mean 'count'?",
      "The observed source declares const count = 1 and then exports value = coutn.",
      "A compiler-owned repair must preserve the declaration and replace only the misspelled identifier use."
    ].join("\n"),
    metadata: { fixtureRole: "program", sourceKind: "authority-matrix.source", engineeringCorpus: true, sourceCode: true }
  }));
  const creativeLanguageIngest = await runtime.kernel.ingest({
    uri: "authority-matrix://language/creative-narrative",
    namespace: "authority-matrix",
    mediaType: "text/plain",
    content: CREATIVE_LANGUAGE_FIXTURE,
    metadata: {
      fixtureRole: "creative-language",
      sourceKind: "authority-matrix.source",
      sourceSystem: "workspace"
    }
  });
  requireCheck("fixture.ingest", [...fixtureIngests.values()].every(result => result.sources === 1 && result.evidence > 0), {
    fixtures: [...fixtureIngests.entries()].map(([role, result]) => ({ role, sources: result.sources, evidence: result.evidence, skipped: result.skipped }))
  });
  requireCheck("fixture.creative_language_ingest", creativeLanguageIngest.sources === 1 && creativeLanguageIngest.evidence > 0, {
    sources: creativeLanguageIngest.sources,
    evidence: creativeLanguageIngest.evidence,
    skipped: creativeLanguageIngest.skipped
  });

  const training = await runtime.kernel.train({
    config: { promotion: { minTrust: 0, namespaces: ["workspace", "authority-matrix"] }, learningGoals: [] }
  });
  requireCheck("brain.training", training.promotedEvidence > 0, {
    promotedEvidence: training.promotedEvidence,
    promotedGraphNodes: training.promotedGraphNodes,
    promotedGraphEdges: training.promotedGraphEdges
  });
  const promotedEvidenceIds = selectedEvidenceIdsFromTraining(training.events);
  const trainingPromotion = trainingPromotionFromEvents(training.events);
  const promotedEvidence = promotedEvidenceIds.length
    ? await runtime.storage.evidence.getEvidenceBatch(promotedEvidenceIds)
    : [];
  const fixtureEvidence = new Map();
  for (const span of promotedEvidence) {
    const role = fixtureRoleFromEvidence(span);
    if (role && fixtureIngests.has(role) && span.status === "promoted") fixtureEvidence.set(role, span);
  }
  if (!fixtureEvidence.has("program")) {
    const workspaceCompilerEvidence = promotedEvidence.find(span => /\bcoutn\b|\bTS2552\b/u.test(span.text));
    if (workspaceCompilerEvidence) fixtureEvidence.set("program", workspaceCompilerEvidence);
  }
  const translationProfileId = languageProfileId(fixtureEvidence.get("translation"));
  requireCheck("brain.fixture_evidence", fixtureEvidence.size === fixtureIngests.size && Boolean(translationProfileId), {
    fixtures: [...fixtureIngests.keys()].map(role => ({
      role,
      evidenceId: fixtureEvidence.get(role)?.id ?? null,
      status: fixtureEvidence.get(role)?.status ?? null,
      languageProfileId: languageProfileId(fixtureEvidence.get(role)),
      promotion: trainingPromotion.find(item => item.evidenceId === String(fixtureEvidence.get(role)?.id ?? "")) ?? null
    })),
    rejectedPromotion: trainingPromotion.filter(item => !item.promote),
    promotedEvidence: promotedEvidence.map(span => ({
      id: span.id,
      fixtureRole: fixtureRoleFromEvidence(span) ?? null,
      preview: span.textPreview.slice(0, 160)
    }))
  });
  await activateFixtureBrain(runtime.storage, 1_000);
  const warmup = await runtime.kernel.warmup({ brain: true, graph: true, language: true, profile: true, corrections: true });
  requireCheck("runtime.warmup", Boolean(warmup), warmup);

  const requests = [
    {
      id: "factual",
      authority: "factual",
      text: "What API route controls pump alpha?",
      metadata: { sessionContextEvidence: true, runtimeEvidenceIds: [String(fixtureEvidence.get("factual").id)] },
      requirements: { externalTruthAuthority: 0.98, sourceDependence: 0.96 }
    },
    {
      id: "reasoned",
      authority: "reasoned",
      text: "Explain why contradictory measurements require reconciliation.",
      metadata: { sessionContextEvidence: true, runtimeEvidenceIds: [String(fixtureEvidence.get("reasoned").id)] },
      requirements: { inferentialDepth: 0.98, causalReasoningDemand: 0.9, sourceDependence: 0.3 }
    },
    {
      id: "creative",
      authority: "creative",
      text: CREATIVE_REQUEST_FIXTURE,
      requirements: { noveltyDemand: 1, counterfactualDemand: 0.74, uncertaintyTolerance: 0.8 }
    },
    {
      id: "translation",
      authority: "translation",
      text: "Pump alpha is stable.",
      metadata: {
        targetLanguage: translationProfileId,
        sessionContextEvidence: true,
        runtimeEvidenceIds: [String(fixtureEvidence.get("translation").id)]
      },
      requirements: { semanticPreservation: 1, surfaceTransformation: 1, audienceAdaptation: 0.72 }
    },
    {
      id: "program",
      authority: "program",
      text: "Apply the compiler-owned fix for TS2552 in src/index.ts.",
      metadata: { sessionContextEvidence: true, runtimeEvidenceIds: [String(fixtureEvidence.get("program").id)] },
      requirements: { executableArtifactDemand: 1, formatConstraintStrength: 0.9, inferentialDepth: 0.7 }
    },
    {
      id: "action",
      authority: "action",
      text: ACTION_REQUEST_FIXTURE,
      requirements: { actionCommitment: 1, executableArtifactDemand: 0.64, externalTruthAuthority: 0.7 }
    }
  ];

  const programPlan = await workspaceRuntime.planCodingPatch({
    workspaceId: workspaceIngest.workspace.id,
    expectedWorkspaceUpdatedAt: workspaceIngest.workspace.updatedAt,
    requestId: "authority-matrix-program-repair",
    requestText: "Apply the compiler-owned fix for TS2552 in src/index.ts.",
    requestedPaths: ["src/index.ts"],
    diagnosticCodes: [2552],
    validationPlan: {
      validatorId: "trusted-host-pnpm-validate.v1",
      checks: ["compiler", "typecheck", "tests"]
    }
  }, fixtureRoot, { maxFiles: 64, maxDepth: 8 });
  const programPlanSelected = programPlan.statusId === "scce.workspace.compiler_patch.selected.v1";
  if (programPlanSelected) verifyPatchTransactionPlan(programPlan.plan);

  for (const request of requests) {
    const result = await runtime.kernel.turn({
      text: request.text,
      metadata: {
        ...(request.metadata ?? {}),
        ...(request.id === "program" && programPlanSelected
          ? { runtime: { workspacePlans: [programPlan.plan] } }
          : {}),
        questionId: `authority-${request.id}`,
        turnRequirements: Object.entries(request.requirements).map(([dimension, value]) => ({
          id: `authority-matrix.${request.id}.${dimension}`,
          dimension,
          value,
          confidence: 1,
          polarity: "required",
          status: "explicit",
          learnedFrameOrPatternId: `fixture.authority-matrix.${request.id}`,
          sourceActivationId: `fixture.activation.${request.id}`,
          trace: { source: "runtime-authority-matrix.fixture", caseId: request.id }
        }))
      }
    });
    const selected = objectRecord(result.selectedCandidate) ?? selectedCandidateFromEvents(result.events);
    const traceVerification = verifyYoppEvaluationTrace(condition, result.evaluationTrace);
    const row = {
      id: request.id,
      request: { text: request.text, expectedAuthority: request.authority, explicitRequestedAuthority: null, metadata: request.metadata ?? null },
      result: {
        requestedAuthority: result.requestedAuthority ?? null,
        authorityDecision: result.requestedAuthorityDecision ?? null,
        activatedOperators: result.operatorActivations ?? null,
        selectedCandidate: selected,
        candidateField: result.candidateField ?? null,
        epistemicForce: result.epistemicForce,
        assistantForce: result.assistantForce ?? null,
        evidenceIds: result.evidence.map(span => String(span.id)),
        evidenceProvenance: result.evidence.map(span => ({
          id: String(span.id),
          sourceVersionId: String(span.sourceVersionId),
          byteStart: span.byteStart,
          byteEnd: span.byteEnd
        })),
        translation: result.translation ?? null,
        actionGraph: result.actionGraph ?? null,
        inventionTrace: request.id === "creative" ? inventionTraceFromEvents(result.events) : null,
        candidateGenerationTrace: request.id === "reasoned" ? candidateGenerationTraceFromEvents(result.events) : null,
        cognitiveProposals: request.id === "reasoned" ? result.cognitiveProposals ?? null : null,
        answer: result.answer,
        answerHash: sha256Tagged(result.answer),
        trace: result.evaluationTrace ?? null,
        traceValid: traceVerification.valid,
        traceViolations: traceVerification.violations
      }
    };
    cases.push(row);
    validateAuthorityRow(row);
  }

  recordCheck("program.exact_repair_transaction", (
    programPlanSelected
    && programPlan.plan.operations.length > 0
    && programPlan.plan.operations.every(operation => operation.path.startsWith("src/"))
    && programPlan.authorization.granted === false
    && programPlan.execution.state === "not_executed"
    && programPlan.execution.receipt === null
  ), programPlanSelected ? {
    plan: programPlan.plan,
    constraintGraph: programPlan.constraintGraph,
    selection: programPlan.selection,
    validationPlan: programPlan.validationPlan,
    authorization: programPlan.authorization,
    execution: programPlan.execution
  } : {
    unresolved: programPlan,
    execution: programPlan.execution
  });
  const programRow = cases.find(row => row.id === "program");
  if (programRow) programRow.result.exactRepair = programPlan;

  const answerHashes = new Set(cases.map(row => row.result.answerHash));
  recordCheck("authority.answer_diversity", answerHashes.size >= 5, { distinct: answerHashes.size, total: cases.length });
} catch (error) {
  primaryError = error;
  blocked = postgresPrerequisiteError(error);
} finally {
  if (runtime) await runtime.close().catch(error => { primaryError ??= error; });
  if (config) {
    try {
      cleanupStorage = createPostgresStorageAdapter({
        url: config.database.url,
        schema,
        ssl: config.database.ssl
      });
      if (!/^scce_authority_matrix_[a-z0-9_]+$/u.test(cleanupStorage.schema)) throw new Error("refusing cleanup outside authority-matrix schema");
      await cleanupStorage.query(`DROP SCHEMA IF EXISTS "${cleanupStorage.schema}" CASCADE`);
      checks.push({ id: "cleanup.disposable_schema", passed: true, detail: { schema: cleanupStorage.schema } });
    } catch (error) {
      checks.push({ id: "cleanup.disposable_schema", passed: false, detail: { error: sanitized(error) } });
      if (!blocked) primaryError ??= error;
    }
  }
  if (cleanupStorage) await cleanupStorage.close().catch(error => { primaryError ??= error; });
  await rm(fixtureRoot, { recursive: true, force: true }).catch(error => { primaryError ??= error; });
}

const status = blocked
  ? "blocked_postgres_prerequisite"
  : !primaryError && checks.every(check => check.passed) && cases.length === 6
    ? "passed"
    : "failed";
const report = {
  schema: "scce.runtime_authority_matrix.v1",
  completedAt: new Date().toISOString(),
  runtimeFactory: "createNodeRuntime",
  durableStore: "postgres",
  sourceOnlyFallbackUsed: false,
  configPath,
  disposableSchema: schema,
  credentialsRecorded: false,
  status,
  prerequisite: blocked
    ? "Start the PostgreSQL instance configured by scce.config.json (or SCCE_AUTHORITY_MATRIX_CONFIG), ensure the database exists and credentials are valid, then rerun this script."
    : null,
  checks,
  cases,
  error: primaryError ? sanitized(primaryError) : null
};
await writeFile(path.join(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(path.join(outputDirectory, "report.md"), renderMarkdown(report), "utf8");
process.stdout.write(`${JSON.stringify({
  schema: report.schema,
  status: report.status,
  checks: { passed: report.checks.filter(check => check.passed).length, failed: report.checks.filter(check => !check.passed).map(check => check.id) },
  cases: report.cases.map(row => ({
    id: row.id,
    authority: row.result.requestedAuthority,
    candidate: row.result.selectedCandidate?.kind ?? null,
    force: row.result.assistantForce ?? row.result.epistemicForce,
    evidence: row.result.evidenceIds.length,
    traceValid: row.result.traceValid
  })),
  reportPath: path.join(outputDirectory, "report.json")
})}\n`);
if (status === "blocked_postgres_prerequisite") {
  process.stderr.write(`SCCE_POSTGRES_PREREQUISITE: ${report.prerequisite} Cause: ${report.error}\n`);
  process.exitCode = 2;
} else if (status !== "passed") {
  process.exitCode = 1;
}

function validateAuthorityRow(row) {
  const expectedKinds = {
    factual: new Set(["proof-answer", "ccr-extractive", "graph-inference"]),
    reasoned: new Set(["reasoned-synthesis", "causal-inference", "temporal-inference", "counterfactual-response"]),
    creative: new Set(["creative-candidate"]),
    translation: new Set(["translation", "transformation"]),
    program: new Set(["program-proposal", "workspace-proposal"]),
    action: new Set(["action-preview"])
  };
  const selectedKind = row.result.selectedCandidate?.kind ?? null;
  recordCheck(`${row.id}.authority`, row.result.requestedAuthority === row.request.expectedAuthority, {
    expected: row.request.expectedAuthority,
    actual: row.result.requestedAuthority,
    decision: row.result.authorityDecision
  });
  if (row.id !== "translation") {
    recordCheck(`${row.id}.projected_not_overridden`, row.result.authorityDecision?.explicitOverride === false, {
      authorityDecision: row.result.authorityDecision
    });
  }
  recordCheck(`${row.id}.operator_activation`, hasStructuredContent(row.result.activatedOperators), row.result.activatedOperators);
  recordCheck(`${row.id}.candidate_kind`, expectedKinds[row.id].has(selectedKind), {
    expected: [...expectedKinds[row.id]],
    actual: selectedKind,
    selected: row.result.selectedCandidate
  });
  recordCheck(`${row.id}.trace`, row.result.traceValid, { violations: row.result.traceViolations });
  if (row.id === "factual") {
    recordCheck("factual.evidence", row.result.evidenceIds.length > 0 && row.result.assistantForce === "source_grounded_answer", {
      evidenceIds: row.result.evidenceIds,
      assistantForce: row.result.assistantForce
    });
  } else if (row.id === "reasoned") {
    const relevance = reasonedFixtureRelevance(row.result.answer);
    const creativeLeakage = sourceCopyMetrics(row.result.answer, CREATIVE_LANGUAGE_FIXTURE);
    recordCheck("reasoned.nonempty_surface", typeof row.result.answer === "string" && row.result.answer.trim().length > 0, {
      answer: row.result.answer
    });
    recordCheck("reasoned.fixture_relevance", relevance.passed, {
      answer: row.result.answer,
      ...relevance
    });
    recordCheck("reasoned.no_creative_narrative_leakage", (
      creativeLeakage.fiveGramRatio < 0.20
      && creativeLeakage.longestSharedTokenRun < 6
    ), creativeLeakage);
  } else if (row.id === "creative") {
    const sentenceCount = sentenceBoundaryCount(row.result.answer);
    const requestConstraints = creativeRequestConstraints(row.result.answer);
    const requestCopy = sourceCopyMetrics(row.result.answer, CREATIVE_REQUEST_FIXTURE);
    const fixtureCopy = sourceCopyMetrics(row.result.answer, CREATIVE_LANGUAGE_FIXTURE);
    recordCheck("creative.force", row.result.epistemicForce === "invented" && row.result.assistantForce === "creative_answer", {
      epistemicForce: row.result.epistemicForce,
      assistantForce: row.result.assistantForce
    });
    recordCheck("creative.no_fabricated_evidence", row.result.evidenceIds.length === 0, { evidenceIds: row.result.evidenceIds });
    recordCheck("creative.exact_sentence_count", sentenceCount === 2, {
      answer: row.result.answer,
      expected: 2,
      actual: sentenceCount
    });
    recordCheck("creative.request_constraints", requestConstraints.passed, {
      answer: row.result.answer,
      ...requestConstraints
    });
    recordCheck("creative.no_request_echo_or_template_leakage", (
      !requestCopy.fullNormalizedSourcePresent
      && requestCopy.fiveGramRatio < 0.30
      && requestCopy.longestSharedTokenRun < 8
    ), requestCopy);
    recordCheck("creative.no_fixture_source_copy", (
      fixtureCopy.fiveGramRatio < 0.35
      && fixtureCopy.longestSharedTokenRun < 9
    ), fixtureCopy);
    recordCheck("creative.surface_quality", creativeSurfaceQuality(row.result.answer), {
      answer: row.result.answer,
      sentenceBoundaries: sentenceCount,
      uniqueLexicalRatio: uniqueLexicalRatio(row.result.answer)
    });
  } else if (row.id === "translation") {
    recordCheck("translation.preservation", row.result.assistantForce === "translation_answer" && hasStructuredContent(row.result.translation), {
      assistantForce: row.result.assistantForce,
      translation: row.result.translation
    });
    recordCheck("translation.exact_fixture_surface", outerWhitespaceTrim(row.result.answer) === TRANSLATION_TARGET_FIXTURE, {
      expected: TRANSLATION_TARGET_FIXTURE,
      actual: row.result.answer
    });
  } else if (row.id === "program") {
    const candidate = objectRecord(row.result.selectedCandidate);
    const audit = objectRecord(candidate?.audit);
    const boundaries = Array.isArray(candidate?.boundaries) ? candidate.boundaries : [];
    recordCheck("program.nonempty_surface", typeof row.result.answer === "string" && row.result.answer.trim().length > 0, {
      answer: row.result.answer
    });
    recordCheck("program.request_target_grounded", row.result.answer.includes("src/index.ts") && row.result.answer.includes("export const value = count;"), {
      answer: row.result.answer,
      requiredSurfaces: ["src/index.ts", "export const value = count;"]
    });
    recordCheck("program.no_web_motion", !objectRecord(audit?.motion), { audit });
    recordCheck("program.verified_plan_surface", (
      audit?.source === "workspace.patch_transaction_plan"
      && row.result.answer.includes('"planHash"')
      && row.result.answer.includes("src/index.ts")
      && row.result.answer.includes("export const value = count;")
    ), { audit, answer: row.result.answer });
    recordCheck("program.nonexecuting_boundary", (
      audit?.authorizationGranted === false
      && audit?.executionState === "not_executed"
      && boundaries.includes("workspace-plan-not-authorized")
      && boundaries.includes("workspace-plan-not-executed")
    ), { audit, boundaries });
    recordCheck("program.no_completion_claim", !/\b(?:applied|authorized|executed|completed)\b/iu.test(row.result.answer), {
      answer: row.result.answer
    });
  } else if (row.id === "action") {
    const selected = objectRecord(row.result.selectedCandidate);
    const audit = objectRecord(selected?.audit);
    const preview = structuredActionPreview(row.result.answer);
    const claims = candidateClaimAudits(row.result.selectedCandidate);
    const unreceiptedCompletion = claims.some(claim => claim && claim.basis === "action_result" && !claim.actionReceiptId);
    recordCheck("action.receipt_boundary", !unreceiptedCompletion, { claims, actionGraph: row.result.actionGraph });
    recordCheck("action.nonempty_preview", (
      typeof row.result.answer === "string"
      && row.result.answer.trim().length > 0
      && preview?.executionState === "not_executed"
    ), { answer: row.result.answer, preview });
    recordCheck("action.fixture_plan_identity", (
      preview?.capabilityId === ACTION_CAPABILITY_FIXTURE
      && preview?.phase === ACTION_PHASE_FIXTURE
      && audit?.capabilityId === ACTION_CAPABILITY_FIXTURE
      && audit?.phase === ACTION_PHASE_FIXTURE
    ), {
      expected: { capabilityId: ACTION_CAPABILITY_FIXTURE, phase: ACTION_PHASE_FIXTURE },
      preview,
      audit
    });
  }
}

function creativeSurfaceQuality(surface) {
  return typeof surface === "string"
    && sentenceBoundaryCount(surface) >= 2
    && uniqueLexicalRatio(surface) >= 0.55
    && !/(?:^|\s)([^\s]+)(?:\s+\1){2,}(?:\s|$)/iu.test(surface);
}

function sentenceBoundaryCount(surface) {
  return typeof surface === "string" ? (surface.match(/[.!?。！？]+(?:\s|$)/gu) ?? []).length : 0;
}

function uniqueLexicalRatio(surface) {
  const symbols = unicodeTokens(surface);
  return symbols.length ? new Set(symbols).size / symbols.length : 0;
}

function reasonedFixtureRelevance(surface) {
  const tokens = unicodeTokens(surface);
  const tokenSet = new Set(tokens);
  const measurementValues = (tokenSet.has("42") && tokenSet.has("57"))
    || (tokenSet.has("15") && tokenSet.has("kpa"));
  const simultaneity = (
    tokenSet.has("same") && ["time", "timestamp", "moment", "instant"].some(token => tokenSet.has(token))
  ) || tokens.some(token => ["simultan", "concurren", "coincid"].some(stem => token.startsWith(stem)));
  const conflict = tokens.some(token => ["contradict", "conflict", "incompatib", "reconcil", "disagree"].some(stem => token.startsWith(stem)));
  return {
    passed: measurementValues && simultaneity && conflict,
    measurementValues,
    simultaneity,
    conflict
  };
}

function creativeRequestConstraints(surface) {
  const tokens = unicodeTokens(surface);
  const purple = hasMeaning(tokens, ["purple", "violet", "lavender", "amethyst"]);
  const pump = hasMeaning(tokens, ["pump"], ["pump"]);
  const learning = hasMeaning(tokens, ["learnt", "taught", "found"], ["learn", "teach", "practic", "discover", "master", "acquir", "develop"]);
  const singing = hasMeaning(tokens, ["sang", "sung", "song", "voice", "aria"], ["sing", "melod", "tun", "chorus", "vocal", "hum"]);
  return { passed: purple && pump && learning && singing, purple, pump, learning, singing };
}

function hasMeaning(tokens, exactTerms, stems = []) {
  return tokens.some(token => exactTerms.includes(token) || stems.some(stem => token.startsWith(stem)));
}

function unicodeTokens(surface) {
  return typeof surface === "string"
    ? surface.normalize("NFKC").toLocaleLowerCase().match(/[\p{Letter}\p{Number}]+/gu) ?? []
    : [];
}

function sourceCopyMetrics(surface, source) {
  const outputTokens = unicodeTokens(surface);
  const sourceTokens = unicodeTokens(source);
  const outputFiveGrams = tokenNgrams(outputTokens, 5);
  const sourceFiveGrams = new Set(tokenNgrams(sourceTokens, 5));
  const matchedFiveGrams = outputFiveGrams.filter(ngram => sourceFiveGrams.has(ngram)).length;
  const normalizedOutput = outputTokens.join(" ");
  const normalizedSource = sourceTokens.join(" ");
  return {
    outputTokenCount: outputTokens.length,
    sourceTokenCount: sourceTokens.length,
    outputFiveGramCount: outputFiveGrams.length,
    matchedFiveGramCount: matchedFiveGrams,
    fiveGramRatio: outputFiveGrams.length ? matchedFiveGrams / outputFiveGrams.length : 0,
    longestSharedTokenRun: longestSharedTokenRun(outputTokens, sourceTokens),
    fullNormalizedSourcePresent: normalizedSource.length > 0 && normalizedOutput.includes(normalizedSource)
  };
}

function tokenNgrams(tokens, size) {
  if (!Number.isInteger(size) || size <= 0 || tokens.length < size) return [];
  return Array.from({ length: tokens.length - size + 1 }, (_, index) => tokens.slice(index, index + size).join("\u001f"));
}

function longestSharedTokenRun(left, right) {
  let longest = 0;
  let previous = new Uint32Array(right.length + 1);
  for (const token of left) {
    const current = new Uint32Array(right.length + 1);
    for (let index = 0; index < right.length; index += 1) {
      if (token !== right[index]) continue;
      current[index + 1] = previous[index] + 1;
      if (current[index + 1] > longest) longest = current[index + 1];
    }
    previous = current;
  }
  return longest;
}

function outerWhitespaceTrim(surface) {
  return typeof surface === "string" ? surface.trim() : null;
}

function structuredActionPreview(surface) {
  if (typeof surface !== "string") return undefined;
  const trimmed = surface.trim();
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
  try {
    return objectRecord(JSON.parse(fenced?.[1] ?? trimmed));
  } catch {
    return undefined;
  }
}

function candidateClaimAudits(candidate) {
  const selected = objectRecord(candidate);
  const audit = objectRecord(selected?.audit);
  const proposalTrace = objectRecord(audit?.proposalTrace);
  return [selected?.claims, audit?.claimBases, proposalTrace?.claimBases]
    .flatMap(value => Array.isArray(value) ? value : [])
    .map(objectRecord)
    .filter(Boolean);
}

function selectedCandidateFromEvents(events) {
  const event = Array.isArray(events) ? [...events].reverse().find(row => row?.typeId === "CandidateSelected") : undefined;
  return objectRecord(event?.payload) ?? null;
}

function inventionTraceFromEvents(events) {
  const event = Array.isArray(events) ? [...events].reverse().find(row => row?.typeId === "InventionPlanned") : undefined;
  const payload = objectRecord(event?.payload);
  const candidates = Array.isArray(payload?.candidates) ? payload.candidates.map(objectRecord).filter(Boolean) : [];
  return candidates.map(candidate => ({ id: candidate.id ?? null, trace: candidate.trace ?? null })).slice(0, 8);
}

function candidateGenerationTraceFromEvents(events) {
  return Array.isArray(events)
    ? events.filter(row => row?.typeId === "CandidateGenerated").map(row => objectRecord(row?.payload)).filter(Boolean).slice(0, 12)
    : [];
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function selectedEvidenceIdsFromTraining(events) {
  const event = Array.isArray(events) ? events.find(row => row?.typeId === "LearningPromoted") : undefined;
  const payload = objectRecord(event?.payload);
  return Array.isArray(payload?.selectedEvidenceIds)
    ? payload.selectedEvidenceIds.filter(value => typeof value === "string")
    : [];
}

function trainingPromotionFromEvents(events) {
  const event = Array.isArray(events) ? events.find(row => row?.typeId === "LearningPromoted") : undefined;
  const payload = objectRecord(event?.payload);
  return Array.isArray(payload?.trainingPromotion)
    ? payload.trainingPromotion.map(objectRecord).filter(Boolean)
    : [];
}

function fixtureRoleFromEvidence(span) {
  const provenance = objectRecord(span?.provenance);
  const metadata = objectRecord(provenance?.metadata);
  return typeof metadata?.fixtureRole === "string" ? metadata.fixtureRole : undefined;
}

function languageProfileId(span) {
  const hints = objectRecord(span?.languageHints);
  return typeof hints?.profileId === "string" && hints.profileId.length > 0 ? hints.profileId : null;
}

function hasStructuredContent(value) {
  if (Array.isArray(value)) return value.length > 0;
  const record = objectRecord(value);
  return Boolean(record && Object.keys(record).length > 0);
}

function recordCheck(id, passed, detail) {
  checks.push({ id, passed: Boolean(passed), detail });
}

function requireCheck(id, passed, detail) {
  recordCheck(id, passed, detail);
  if (!passed) throw new Error(`${id} failed`);
}

async function writeFixture(root) {
  await mkdir(path.join(root, "src"), { recursive: true });
  const files = new Map([
    ["README.md", [
      "# Pump alpha fixture",
      "",
      "Pump alpha is controlled by API route POST /api/pumps/alpha/control.",
      "Pump alpha is stable during normal operation.",
      REASONED_MEASUREMENT_FIXTURE,
      REASONED_CONFLICT_FIXTURE
    ].join("\n") + "\n"],
    ["package.json", `${JSON.stringify({ name: "authority-matrix-fixture", private: true, type: "module", scripts: { build: "tsc -p tsconfig.json", test: "vitest run" } }, null, 2)}\n`],
    ["tsconfig.json", `${JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext" }, include: ["src"] }, null, 2)}\n`],
    ["src/index.ts", "import type { Legacy } from \"./legacy.js\";\r\nconst count = 1;\r\nexport const value = coutn;\r\n"],
    ["src/legacy.ts", "export interface Legacy { value: number; }\r\n"]
  ]);
  for (const [relativePath, content] of files) await writeFile(path.join(root, relativePath), content, "utf8");
}

async function activateFixtureBrain(storage, createdAt) {
  const importRunId = "authority-matrix-import";
  const brainVersion = "authority-matrix-brain";
  const manifestHash = sha256(`${importRunId}:${brainVersion}`);
  const manifest = {
    schema: "scce.brainManifestContract.v1",
    importRunId,
    brainVersion,
    rootPath: "authority-matrix://fixture",
    manifestHash,
    sourceSchema: "scce.runtime_authority_matrix.v1",
    runtimeContractVersion: 1,
    content: { graphShardCount: 1, languageShardCount: 1, ngramStateCount: 1, priorSectionCount: 1 },
    metadata: { syntheticFixture: true },
    createdAt
  };
  await storage.brainImports.putLifecycle({ importRunId, brainVersion, rootPath: manifest.rootPath, state: "CREATED", manifest, revision: 0, createdAt, updatedAt: createdAt });
  await storage.brainImports.transitionLifecycle({ importRunId, expectedState: "CREATED", toState: "IMPORTING", updatedAt: createdAt + 1 });
  await storage.brainImports.transitionLifecycle({ importRunId, expectedState: "IMPORTING", toState: "VALIDATING", updatedAt: createdAt + 2 });
  await storage.brainImports.transitionLifecycle({
    importRunId,
    expectedState: "VALIDATING",
    toState: "READY",
    updatedAt: createdAt + 3,
    validation: {
      schema: "scce.brainValidationReport.v1",
      importRunId,
      brainVersion,
      manifestHash,
      validatorVersion: "runtime-authority-matrix.v1",
      disposition: "PASSED",
      checks: [{ id: "fixture-ingested", passed: true, severity: "error", message: "synthetic authority fixture ingested" }],
      validatedAt: createdAt + 3
    }
  });
  await storage.brainImports.activateReady({ brainVersion, importRunId, updatedAt: createdAt + 4 });
}

function postgresPrerequisiteError(error) {
  const code = String(error && typeof error === "object" && "code" in error ? error.code : "");
  const message = error instanceof Error ? error.message : String(error);
  return ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "28P01", "3D000", "57P03"].includes(code)
    || /connection (?:refused|terminated|failed)|connect ECONNREFUSED|database .* does not exist|password authentication failed|client password must be a string|could not translate host name/iu.test(message);
}

function sanitized(error) {
  return (error instanceof Error ? error.stack ?? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]")
    .slice(0, 4_000);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Tagged(value) {
  return `sha256:${sha256(value)}`;
}

function renderMarkdown(report) {
  const lines = [
    "# Runtime authority matrix",
    "",
    `Status: ${report.status}`,
    "",
    `Canonical factory: ${report.runtimeFactory}`,
    "",
    `Durable store: ${report.durableStore}`,
    "",
    "| Case | Authority | Candidate | Force | Evidence | Trace |",
    "|---|---|---|---|---:|---|"
  ];
  for (const row of report.cases) {
    lines.push(`| ${row.id} | ${row.result.requestedAuthority ?? "-"} | ${row.result.selectedCandidate?.kind ?? "-"} | ${row.result.assistantForce ?? row.result.epistemicForce} | ${row.result.evidenceIds.length} | ${row.result.traceValid ? "valid" : "invalid"} |`);
  }
  if (report.prerequisite) lines.push("", `Prerequisite: ${report.prerequisite}`);
  if (report.error) lines.push("", `Error: ${report.error}`);
  lines.push("");
  return lines.join("\n");
}
