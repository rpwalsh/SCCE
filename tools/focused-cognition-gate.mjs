#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const reportJsonPath = path.resolve(root, ".tmp/focused-cognition-report.json");
const reportMarkdownPath = path.resolve(root, ".tmp/focused-cognition-report.md");
const maximumCaptureBytes = 16 * 1024 * 1024;
const pnpmInvocation = resolvePnpmInvocation();
const startedAt = new Date();
const commandResults = [];

const testGroups = [
  {
    id: "authority_unit_tests",
    files: [
      "packages/kernel/src/__tests__/source-only-authority-routing.test.ts",
      "packages/kernel/src/__tests__/candidate-judge-general-cognition.test.ts",
      "packages/kernel/src/__tests__/kernel-local-evidence-anchor.test.ts"
    ]
  },
  {
    id: "source_only_runtime_regression",
    files: ["packages/kernel/src/__tests__/scce-runtime-completion.test.ts"]
  },
  {
    id: "spectral_forecast_tests",
    files: ["packages/kernel/src/__tests__/spectral-forecast.test.ts"]
  },
  {
    id: "powerwalk_tests",
    files: [
      "packages/kernel/src/__tests__/powerwalk-contract.test.ts",
      "packages/kernel/src/__tests__/powerwalk-parameter-fit.test.ts",
      "packages/kernel/src/__tests__/powerwalk-ppmi.test.ts",
      "packages/kernel/src/__tests__/powerwalk-seed-expansion.test.ts",
      "packages/kernel/src/__tests__/transition-spectral-gap.test.ts"
    ]
  },
  {
    id: "causal_truthfulness_tests",
    files: ["packages/kernel/src/__tests__/causal-math-truthfulness.test.ts"]
  },
  {
    id: "ppf_math_tests",
    files: [
      "packages/kernel/src/__tests__/math.test.ts",
      "packages/kernel/src/__tests__/field-query-diffusion-boundary.test.ts",
      "packages/kernel/src/__tests__/personalized-random-walk.test.ts"
    ]
  },
  {
    id: "creative_translation_tests",
    files: [
      "packages/kernel/src/__tests__/creative-mouth.test.ts",
      "packages/kernel/src/__tests__/general-cognition-mouth.test.ts",
      "packages/kernel/src/__tests__/multilingual-translation.test.ts",
      "packages/kernel/src/__tests__/multilingual-alignment.test.ts"
    ]
  }
];

const build = await runPnpm("build", ["build"]);
commandResults.push(build);

for (const group of testGroups) {
  const result = await runPnpm(
    group.id,
    ["exec", "vitest", "run", ...group.files, "--reporter=json"],
    { testCommand: true }
  );
  commandResults.push(result);
}

let builtKernel;
let builtKernelError;
if (build.exitCode === 0) {
  try {
    builtKernel = await import(`${pathToFileURL(path.resolve(root, "packages/kernel/dist/index.js")).href}?focused=${Date.now()}`);
  } catch (error) {
    builtKernelError = sanitizedError(error);
  }
} else {
  builtKernelError = "built kernel APIs unavailable because the build command did not pass";
}

const sourceOnlyAuthorityMatrix = builtKernel
  ? await collectSourceOnlyAuthorityMatrix(builtKernel)
  : unavailableResult("source_only_authority_matrix", builtKernelError);
const numericalDiagnostics = builtKernel
  ? collectNumericalDiagnostics(builtKernel)
  : {
      passed: false,
      status: "unavailable",
      reason: builtKernelError,
      spectralLogDetComparison: null,
      companionSpectralRadiusFixtures: null,
      intervalWidthChecks: null
    };
const powerWalkInitializerVersusFit = builtKernel
  ? collectPowerWalkMetrics(builtKernel)
  : unavailableResult("powerwalk_initializer_versus_fit", builtKernelError);

let hydratedAuthorityMatrix;
if (build.exitCode === 0) {
  const hydratedCommand = await runCommand({
    id: "hydrated_runtime_authority_matrix",
    executable: process.execPath,
    args: [path.resolve(root, "tools/runtime-authority-matrix.mjs")],
    logicalCommand: "node tools/runtime-authority-matrix.mjs"
  });
  commandResults.push(hydratedCommand);
  hydratedAuthorityMatrix = hydratedMatrixResult(hydratedCommand);
} else {
  const notRun = notRunCommand(
    "hydrated_runtime_authority_matrix",
    "node tools/runtime-authority-matrix.mjs",
    "not run because the build failed; running stale dist output would not be a valid authority matrix"
  );
  commandResults.push(notRun);
  hydratedAuthorityMatrix = unavailableResult("hydrated_runtime_authority_matrix", notRun.reason);
}

const changedFilesCommand = await runCommand({
  id: "git_changed_files",
  executable: "git",
  args: ["status", "--porcelain=v1", "--untracked-files=all"],
  logicalCommand: "git status --porcelain=v1 --untracked-files=all"
});
commandResults.push(changedFilesCommand);
const changedFiles = changedFilesCommand.exitCode === 0
  ? parseChangedFiles(changedFilesCommand.stdout)
  : [];

const ordinaryCommandFailures = commandResults.filter(result =>
  result.id !== "hydrated_runtime_authority_matrix"
    && (!result.ran || result.exitCode !== 0 || result.testReportParsed === false)
);
const hydratedBlocked = hydratedAuthorityMatrix.status === "blocked_postgres_prerequisite";
const hydratedFailed = !hydratedBlocked && hydratedAuthorityMatrix.passed !== true;
const internalFailures = [
  ...(sourceOnlyAuthorityMatrix.passed ? [] : ["source_only_authority_matrix"]),
  ...(numericalDiagnostics.passed ? [] : ["spectral_numerical_diagnostics"]),
  ...(powerWalkInitializerVersusFit.passed ? [] : ["powerwalk_initializer_versus_fit"]),
  ...(changedFilesCommand.exitCode === 0 ? [] : ["changed_files_inventory"])
];
const status = ordinaryCommandFailures.length > 0 || internalFailures.length > 0 || hydratedFailed
  ? "failed"
  : hydratedBlocked
    ? "blocked_postgres_prerequisite"
    : "passed";

const report = {
  schema: "scce.focused_cognition_report.v1",
  startedAt: startedAt.toISOString(),
  completedAt: new Date().toISOString(),
  status,
  commandRunner: {
    shell: false,
    cwd: root,
    pnpm: pnpmInvocation
  },
  commands: commandResults.map(publicCommandResult),
  sourceOnlyAuthorityMatrix,
  hydratedAuthorityMatrix,
  spectralLogDetComparison: numericalDiagnostics.spectralLogDetComparison,
  companionSpectralRadiusFixtures: numericalDiagnostics.companionSpectralRadiusFixtures,
  intervalWidthChecks: numericalDiagnostics.intervalWidthChecks,
  powerWalkInitializerVersusFit,
  changedFiles,
  failures: {
    commands: ordinaryCommandFailures.map(result => result.id),
    internal: internalFailures,
    hydrated: hydratedFailed ? ["hydrated_runtime_authority_matrix"] : [],
    externalBlocker: hydratedBlocked ? "postgres" : null
  }
};

await mkdir(path.dirname(reportJsonPath), { recursive: true });
await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeFile(reportMarkdownPath, renderMarkdown(report), "utf8");
process.stdout.write(`Focused cognition gate: ${status}\nJSON: ${reportJsonPath}\nMarkdown: ${reportMarkdownPath}\n`);
if (status === "blocked_postgres_prerequisite") process.exitCode = 2;
else if (status !== "passed") process.exitCode = 1;

async function runPnpm(id, args, options = {}) {
  return runCommand({
    id,
    executable: pnpmInvocation.executable,
    args: [...pnpmInvocation.argsPrefix, ...args],
    logicalCommand: `pnpm ${args.map(commandArgument).join(" ")}`,
    testCommand: options.testCommand === true
  });
}

async function runCommand(input) {
  const commandStartedAt = new Date();
  const start = process.hrtime.bigint();
  return new Promise(resolve => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let spawnError;
    const child = spawn(input.executable, input.args, {
      cwd: root,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", chunk => {
      const appended = boundedAppend(stdout, chunk, maximumCaptureBytes);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", chunk => {
      const appended = boundedAppend(stderr, chunk, maximumCaptureBytes);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });
    child.on("error", error => { spawnError = error; });
    child.on("close", (exitCode, signal) => {
      const stdoutText = stdout.toString("utf8");
      const stderrText = stderr.toString("utf8");
      const testReport = input.testCommand ? parseVitestJson(stdoutText) : undefined;
      resolve({
        id: input.id,
        command: input.logicalCommand,
        executable: input.executable,
        args: [...input.args],
        shell: false,
        ran: !spawnError,
        startedAt: commandStartedAt.toISOString(),
        durationMs: Number(process.hrtime.bigint() - start) / 1_000_000,
        exitCode,
        signal: signal ?? null,
        spawnError: spawnError ? sanitizedError(spawnError) : null,
        stdout: stdoutText,
        stderr: stderrText,
        stdoutTruncated,
        stderrTruncated,
        testCounts: testReport?.counts ?? null,
        failedTestNames: testReport?.failedTestNames ?? [],
        testReportParsed: input.testCommand ? Boolean(testReport) : null,
        testReportParseError: input.testCommand && !testReport ? "Vitest JSON reporter output was not parseable" : null
      });
    });
  });
}

function collectNumericalDiagnostics(kernel) {
  const required = [
    "adaptiveJitterCholeskyLogDet",
    "spectralRadiusForVar",
    "forecastFromVarModel"
  ];
  const missing = required.filter(name => typeof kernel[name] !== "function");
  if (missing.length > 0) {
    return {
      passed: false,
      status: "unavailable",
      reason: `built kernel is missing exports: ${missing.join(", ")}`,
      spectralLogDetComparison: null,
      companionSpectralRadiusFixtures: null,
      intervalWidthChecks: null
    };
  }
  try {
    const covariance = [[4, 1.5], [1.5, 1]];
    const logDet = kernel.adaptiveJitterCholeskyLogDet(covariance);
    const expectedLogDet = Math.log(4 * 1 - 1.5 ** 2);
    const diagonalProductLogDet = Math.log(4 * 1);
    const spectralLogDetComparison = {
      passed: logDet.status === "exact" && Math.abs(logDet.logDet - expectedLogDet) < 1e-10,
      covariance,
      actual: logDet,
      expectedCorrelatedLogDet: expectedLogDet,
      diagonalProductLogDet,
      absoluteError: Math.abs(logDet.logDet - expectedLogDet)
    };

    const fixtureInputs = [
      {
        id: "var2_a1_stable_a2_unstable",
        coefficients: [[[0.5]], [[0.8]]],
        expectedRadius: (0.5 + Math.sqrt(0.5 ** 2 + 4 * 0.8)) / 2,
        expectedStable: false
      },
      {
        id: "var2_stable",
        coefficients: [[[0.4]], [[0.2]]],
        expectedRadius: (0.4 + Math.sqrt(0.4 ** 2 + 4 * 0.2)) / 2,
        expectedStable: true
      },
      {
        id: "complex_conjugate_pair",
        coefficients: [[[0]], [[-0.81]]],
        expectedRadius: 0.9,
        expectedStable: true
      },
      {
        id: "near_unit_root",
        coefficients: [[[0.9999995]]],
        expectedRadius: 0.9999995,
        expectedStable: true
      }
    ];
    const fixtures = fixtureInputs.map(fixture => {
      const diagnostic = kernel.spectralRadiusForVar(fixture.coefficients);
      const absoluteError = Math.abs(diagnostic.radius - fixture.expectedRadius);
      const actualStable = diagnostic.converged && diagnostic.radius < 1;
      return {
        ...fixture,
        actualStable,
        absoluteError,
        diagnostic,
        passed: diagnostic.converged && absoluteError < 1e-9 && actualStable === fixture.expectedStable
      };
    });
    const companionSpectralRadiusFixtures = {
      passed: fixtures.every(fixture => fixture.passed),
      fixtures
    };

    const stableModel = numericalVarModel([[[0.5]]], [[4]], kernel);
    const unstableModel = numericalVarModel([[[1.2]]], [[4]], kernel);
    const stableH1 = kernel.forecastFromVarModel({ model: stableModel, history: [[2]], horizon: 1 });
    const stableH3 = kernel.forecastFromVarModel({ model: stableModel, history: [[2]], horizon: 3 });
    const unstableH1 = kernel.forecastFromVarModel({ model: unstableModel, history: [[2]], horizon: 1 });
    const width = forecast => (forecast.interval[0]?.high ?? 0) - (forecast.interval[0]?.low ?? 0);
    const intervalWidthChecks = {
      passed: Math.abs((stableH1.covariance[0]?.[0] ?? Number.NaN) - 4) < 1e-10
        && Math.abs((unstableH1.covariance[0]?.[0] ?? Number.NaN) - 4) < 1e-10
        && Math.abs((stableH3.covariance[0]?.[0] ?? Number.NaN) - 5.25) < 1e-10
        && stableH1.varianceScale === 1
        && unstableH1.varianceScale === 1
        && width(stableH3) > width(stableH1),
      stableH1: forecastSummary(stableH1),
      stableH3: forecastSummary(stableH3),
      unstableH1: forecastSummary(unstableH1),
      assertions: {
        horizon1InnovationVariance: 4,
        stableHorizon3WoldVariance: 5.25,
        stabilityVarianceScale: 1,
        widthMonotonicAcrossStableHorizon: width(stableH3) > width(stableH1)
      }
    };
    return {
      status: "completed",
      passed: spectralLogDetComparison.passed && companionSpectralRadiusFixtures.passed && intervalWidthChecks.passed,
      spectralLogDetComparison,
      companionSpectralRadiusFixtures,
      intervalWidthChecks
    };
  } catch (error) {
    return {
      passed: false,
      status: "failed",
      reason: sanitizedError(error),
      spectralLogDetComparison: null,
      companionSpectralRadiusFixtures: null,
      intervalWidthChecks: null
    };
  }
}

function collectPowerWalkMetrics(kernel) {
  const required = ["initializePowerWalkParameters", "fitPowerWalkParameters", "createHasher"];
  const missing = required.filter(name => typeof kernel[name] !== "function");
  if (missing.length > 0) return unavailableResult("powerwalk_initializer_versus_fit", `built kernel is missing exports: ${missing.join(", ")}`);
  try {
    const now = 2_000_000_000_000;
    const typeId = "type.opaque.focused";
    const typePair = `${typeId}->${typeId}`;
    const nodes = [
      graphNode("node.focused.left", typeId, now),
      graphNode("node.focused.right", typeId, now)
    ];
    const edges = [{
      id: "edge.focused",
      source: nodes[0].id,
      target: nodes[1].id,
      relationId: "relation.opaque.focused",
      alpha: 1,
      weight: 1,
      temporalScope: { validFrom: now },
      evidenceIds: [],
      createdAt: now,
      updatedAt: now,
      metadata: {}
    }];
    const initialized = kernel.initializePowerWalkParameters(nodes, edges, now);
    const observations = [];
    for (let group = 0; group < 10; group++) {
      for (let index = 0; index < 40; index++) {
        const id = `focused.${group}.${index}`;
        const previousNodeId = `${id}.previous`;
        observations.push({
          schema: "scce.powerwalk_transition_observation.v1",
          id,
          sourceRecordId: `source.focused.${group}`,
          observedAt: now,
          previousNodeId,
          previousTypeId: typeId,
          currentNodeId: `${id}.current`,
          currentTypeId: typeId,
          selectedEdgeId: `${id}.edge.${index < 10 ? "return" : "neighbor"}`,
          candidates: [
            { edgeId: `${id}.edge.return`, targetNodeId: previousNodeId, targetTypeId: typeId, distance: 0, edgeWeight: 1, edgeAlpha: 1, edgeUpdatedAt: now },
            { edgeId: `${id}.edge.neighbor`, targetNodeId: `${id}.neighbor`, targetTypeId: typeId, distance: 1, edgeWeight: 1, edgeAlpha: 1, edgeUpdatedAt: now }
          ]
        });
      }
    }
    const fit = kernel.fitPowerWalkParameters({
      observations,
      initialParameters: initialized,
      hasher: kernel.createHasher(),
      options: { seed: "focused-cognition-gate", holdoutFraction: 0.25 }
    });
    const fittedParameter = kind => fit.audit.parameters.find(row => row.kind === kind && row.typePair === typePair)?.fittedCandidate ?? null;
    return {
      status: "completed",
      passed: fit.audit.accepted === true && fit.audit.likelihood.heldOutMeanNllImprovement > 0,
      initialized: {
        p: initialized.p.get(typePair) ?? null,
        q: initialized.q.get(typePair) ?? null,
        lambda: initialized.lambda.get(typePair) ?? null,
        audit: initialized.audit ?? null,
        fitLikelihood: fit.audit.likelihood.fit.initialized,
        heldOutLikelihood: fit.audit.likelihood.heldOut.initialized
      },
      fitted: {
        p: fittedParameter("p"),
        q: fittedParameter("q"),
        lambda: fittedParameter("lambda"),
        status: fit.audit.status,
        accepted: fit.audit.accepted,
        reasons: fit.audit.reasons,
        fitMeanNllImprovement: fit.audit.likelihood.fitMeanNllImprovement,
        heldOutMeanNllImprovement: fit.audit.likelihood.heldOutMeanNllImprovement,
        fitLikelihood: fit.audit.likelihood.fit.fittedCandidate,
        heldOutLikelihood: fit.audit.likelihood.heldOut.fittedCandidate,
        split: fit.audit.split,
        parameters: fit.audit.parameters
      },
      active: {
        source: fit.audit.accepted ? "accepted_fitted_parameters" : "initializer_fallback",
        p: fit.params.p.get(typePair) ?? null,
        q: fit.params.q.get(typePair) ?? null,
        lambda: fit.params.lambda.get(typePair) ?? null,
        audit: fit.params.audit ?? null
      }
    };
  } catch (error) {
    return { status: "failed", passed: false, reason: sanitizedError(error) };
  }
}

async function collectSourceOnlyAuthorityMatrix(kernel) {
  const missing = ["createSourceOnlyScceRuntime"].filter(name => typeof kernel[name] !== "function");
  if (missing.length > 0) {
    return unavailableResult("source_only_authority_matrix", `built kernel is missing exports: ${missing.join(", ")}`);
  }
  try {
    const runtime = kernel.createSourceOnlyScceRuntime({ now: () => 1_783_985_900_000 });
    const ingested = runtime.ingest({
      id: "focused-cognition-source-only",
      rootPath: "focused-cognition-fixture",
      now: 1_783_985_900_000,
      files: [
        {
          path: "README.md",
          mediaType: "text/markdown",
          text: [
            "# Pump alpha fixture",
            "Pump alpha is controlled by API route POST /api/pumps/alpha/control.",
            "Pump alpha is stable during normal operation.",
            "Measurement A reports 42 kPa while measurement B reports 57 kPa at the same timestamp.",
            "Contradictory measurements require reconciliation because one physical state cannot retain incompatible values at the same time."
          ].join("\n"),
          metadata: { sourceKind: "developer_intelligence" }
        },
        {
          path: "src/index.ts",
          mediaType: "text/typescript",
          text: "export function pumpAlphaPressure(): number { return 42; }\nexport const route = '/api/pumps/alpha/control';\n",
          metadata: { sourceKind: "developer_intelligence" }
        },
        {
          path: "package.json",
          mediaType: "application/json",
          text: JSON.stringify({ name: "focused-authority-fixture", private: true, scripts: { build: "tsc -p tsconfig.json", test: "vitest run" } }, null, 2),
          metadata: { sourceKind: "developer_intelligence" }
        },
        {
          path: "docs/pump.es.md",
          mediaType: "text/markdown",
          text: "Pump alpha está estable.",
          metadata: {
            sourceKind: "developer_intelligence",
            languageHints: { language: "lang.es" },
            scriptHints: { script: "Latin" }
          }
        }
      ]
    });
    const sourceRef = targetPath => {
      const source = ingested.analysis.sources.find(item => item.path === targetPath);
      if (!source?.evidenceIds?.[0] || !source.contentHash) throw new Error(`missing source reference for ${targetPath}`);
      return { path: source.path, lineStart: 1, evidenceSpanId: source.evidenceIds[0], contentHash: source.contentHash };
    };
    const readmeRef = sourceRef("README.md");
    const codeRef = sourceRef("src/index.ts");
    const packageRef = sourceRef("package.json");
    const spanishRef = sourceRef("docs/pump.es.md");
    const spanishVersion = ingested.sourceVersions.find(version => version.canonicalUri === "docs/pump.es.md");
    if (!spanishVersion) throw new Error("missing Spanish fixture source version");
    const analysis = {
      ...ingested.analysis,
      summary: { sourceRefs: [readmeRef, codeRef, packageRef, spanishRef], counts: { files: 4 } },
      symbols: [{ id: "symbol.pumpAlphaPressure", name: "pumpAlphaPressure", kind: "typescript.function", path: "src/index.ts", exported: true, sourceRef: codeRef }],
      commands: [
        { id: "command.build", name: "build", command: "pnpm run build", sourcePath: "package.json", kind: "eng.command.build", sourceRef: packageRef },
        { id: "command.test", name: "test", command: "pnpm test", sourcePath: "package.json", kind: "eng.command.validation", sourceRef: packageRef }
      ],
      routes: [{ id: "route.pump-alpha", method: "POST", path: "/api/pumps/alpha/control", filePath: "src/index.ts", handlerHint: "pumpAlphaPressure", sourceRef: codeRef }],
      contradictions: [{
        id: "finding.contradiction.pressure",
        kind: "workspace.finding.contradiction",
        severity: "high",
        statement: "The same timestamp contains incompatible 42 kPa and 57 kPa measurements.",
        sourceRefs: [readmeRef],
        affectedFiles: ["README.md"],
        suggestedFix: "Reconcile the measurement sources before asserting one value.",
        confidence: 0.9,
        metadata: { values: [42, 57] }
      }],
      gaps: [],
      tasks: [{
        id: "finding.task.route-guard",
        kind: "workspace.task.route_guard",
        severity: "medium",
        statement: "Add a typed guard around the pump alpha control route.",
        sourceRefs: [codeRef, packageRef],
        affectedFiles: ["src/index.ts"],
        suggestedFix: "Add and validate a typed route guard.",
        confidence: 0.82,
        metadata: { patchKind: "source_edit_plan" }
      }]
    };
    const promotion = runtime.promote({ analysis });
    const requests = [
      { id: "factual", authority: "factual", text: "What API route controls pump alpha?", coefficients: { externalTruthAuthority: 4, sourceDependence: 3 }, expectedKinds: ["proof-answer", "ccr-extractive"] },
      { id: "reasoned", authority: "reasoned", text: "Explain why the contradictory measurements require reconciliation.", coefficients: { inferentialDepth: 4, causalReasoningDemand: 3 }, expectedKinds: ["reasoned-synthesis", "ccr-extractive", "graph-inference", "causal-inference", "temporal-inference", "counterfactual-response"] },
      { id: "creative", authority: "creative", text: "Write a fictional two-sentence story about a purple pump that learns to sing.", coefficients: { noveltyDemand: 4, counterfactualDemand: 2 }, expectedKinds: ["creative-candidate"] },
      { id: "translation", authority: "translation", text: "Pump alpha is stable.", targetLanguage: "lang.es", expectedKinds: ["translation", "transformation"] },
      { id: "program", authority: "program", text: "Add a typed route guard in src/index.ts.", coefficients: { executableArtifactDemand: 4, formatConstraintStrength: 2 }, expectedKinds: ["program-proposal", "workspace-proposal"] },
      { id: "action", authority: "action", text: "Prepare a build validation action without executing it.", coefficients: { actionCommitment: 4, executableArtifactDemand: 1.5 }, expectedKinds: ["action-preview"] }
    ];
    const knownEvidenceIds = new Set(ingested.evidence.map(item => String(item.id)));
    const cases = [];
    for (const request of requests) {
      const requirementActivations = request.coefficients
        ? [{
            id: `activation.focused_gate.${request.id}.v1`,
            kind: "frame",
            activation: 1,
            confidence: 1,
            semanticRoleId: `role.focused_gate.${request.id}.v1`,
            learnedFrameOrPatternId: `frame.focused_gate.${request.id}.v1`,
            requirementCoefficients: request.coefficients,
            trace: { source: "focused_gate.structured_requirement_activation" }
          }]
        : [];
      const requestRecord = {
        text: request.text,
        expectedProjectedAuthority: request.authority,
        requestedAuthorityOmitted: true,
        targetLanguage: request.targetLanguage ?? null,
        structuredRequirementActivationCount: requirementActivations.length
      };
      try {
        const turn = await runtime.turn({
          promotionId: promotion.replayTraceId,
          text: request.text,
          ...(requirementActivations.length > 0 ? { requirementActivations } : {}),
          ...(request.targetLanguage ? {
            targetLanguage: request.targetLanguage,
            languageProfiles: [{
              id: "lang.es",
              sourceVersionId: spanishVersion.sourceVersionId,
              scripts: [{ script: "Latin", mass: 1 }],
              symbolShapes: [],
              charNgrams: [{ ngram: "est", count: 1 }, { ngram: "sta", count: 1 }],
              direction: "ltr",
              entropy: 0.1,
              createdAt: 1
            }]
          } : {})
        });
        const selectedEvidenceIds = turn.selectedCandidate?.evidenceIds ?? [];
        const traceValidation = typeof kernel.validateScceRuntimeTurnTrace === "function"
          ? kernel.validateScceRuntimeTurnTrace(turn.trace)
          : null;
        const authorityNode = turn.workspace.mouthInput.speakInput.construct.nodes.find(node =>
          node.metadata && typeof node.metadata === "object" && !Array.isArray(node.metadata)
            && node.metadata.schema === "scce.source_only.authority_candidate.v1"
        );
        const translationRecord = authorityNode?.metadata?.translation ?? null;
        const authorityDecision = turn.trace.requestedAuthorityDecision;
        const checks = {
          requestedAuthority: turn.requestedAuthority === request.authority && turn.trace.requestedAuthority === request.authority,
          explicitOverrideDisabled: authorityDecision?.explicitOverride === false,
          lexicalRouterDisabled: authorityDecision?.lexicalRouterUsed === false,
          selectedCandidateKind: request.expectedKinds.includes(turn.selectedCandidate?.kind),
          operatorActivations: Array.isArray(turn.trace.operatorActivations) && turn.trace.operatorActivations.some(row => row.active),
          traceValid: traceValidation?.valid === true,
          evidenceProvenance: request.id !== "factual"
            || (turn.trace.evidenceIds.length > 0 && turn.trace.evidenceIds.every(id => knownEvidenceIds.has(String(id)))),
          noFabricatedSelectedEvidence: selectedEvidenceIds.every(id => knownEvidenceIds.has(String(id))),
          translationPreservationRecord: request.id !== "translation"
            || (translationRecord && typeof translationRecord === "object")
        };
        cases.push({
          id: request.id,
          request: requestRecord,
          expectedCandidateKinds: request.expectedKinds,
          status: "completed",
          passed: Object.values(checks).every(Boolean),
          checks,
          result: {
            requestedAuthority: turn.requestedAuthority,
            requestedAuthorityDecision: authorityDecision,
            activatedOperators: turn.trace.operatorActivations,
            selectedCandidate: turn.selectedCandidate,
            authorityRuntimeAudit: turn.workspace.audit,
            evidenceIds: turn.trace.evidenceIds,
            evidenceForce: turn.trace.evidenceForce,
            answer: turn.answer,
            answerHash: `sha256:${sha256(turn.answer)}`,
            traceId: turn.trace.id,
            traceValidation,
            translationPreservationRecord: translationRecord
          }
        });
      } catch (error) {
        cases.push({
          id: request.id,
          request: requestRecord,
          expectedCandidateKinds: request.expectedKinds,
          status: "runtime_error",
          passed: false,
          checks: null,
          result: null,
          error: sanitizedError(error)
        });
      }
    }
    const lexicalRouterUsed = cases.some(row => row.result?.requestedAuthorityDecision?.lexicalRouterUsed === true);
    return {
      schema: "scce.focused_source_only_authority_matrix.v1",
      status: cases.every(row => row.passed) && cases.length === 6 ? "passed" : "failed",
      passed: cases.every(row => row.passed) && cases.length === 6,
      runtimeFactory: "createSourceOnlyScceRuntime",
      sourceOnly: true,
      databaseUsed: false,
      lexicalRouterUsed,
      cases
    };
  } catch (error) {
    return { status: "failed", passed: false, reason: sanitizedError(error), cases: [] };
  }
}

function numericalVarModel(coefficients, residualCovariance, kernel) {
  const dimension = residualCovariance.length;
  const order = coefficients.length;
  const covarianceLogDet = kernel.adaptiveJitterCholeskyLogDet(residualCovariance);
  const regressionParameters = dimension * (1 + dimension * order);
  const innovationCovarianceParameters = dimension * (dimension + 1) / 2;
  return {
    order,
    intercept: new Array(dimension).fill(0),
    coefficients,
    residualCovariance,
    aic: 0,
    residuals: [],
    fitStatus: "fitted",
    aicDiagnostics: {
      criterion: "conditional_multivariate_gaussian_aic",
      formula: "negativeTwoLogLikelihood + 2 * parameterCount",
      likelihoodObservations: 32,
      regressionParameters,
      innovationCovarianceParameters,
      parameterCount: regressionParameters + innovationCovarianceParameters,
      residualDegreesOfFreedom: 30,
      commonEstimationStart: order,
      covarianceLogDet
    }
  };
}

function forecastSummary(forecast) {
  return {
    covariance: forecast.covariance,
    interval: forecast.interval,
    varianceScale: forecast.varianceScale,
    unstable: forecast.unstable,
    nearUnitRoot: forecast.nearUnitRoot,
    horizonSemantics: forecast.horizonSemantics,
    stability: forecast.stability
  };
}

function graphNode(id, typeId, now) {
  return { id, typeId, representation: id, alpha: 1, evidenceIds: [], features: [], createdAt: now, updatedAt: now, metadata: {} };
}

function hydratedMatrixResult(command) {
  const parsed = parseJsonOutput(command.stdout);
  if (command.exitCode === 2) {
    return {
      status: "blocked_postgres_prerequisite",
      passed: false,
      externalBlocker: true,
      prerequisite: (parsed?.prerequisite ?? tail(command.stderr, 4_000)) || "Postgres prerequisite unavailable",
      report: parsed
    };
  }
  if (command.exitCode !== 0) {
    return {
      status: "failed",
      passed: false,
      externalBlocker: false,
      reason: (parsed?.error ?? command.spawnError ?? tail(command.stderr, 4_000)) || "authority matrix command failed",
      report: parsed
    };
  }
  if (!parsed) return { status: "failed", passed: false, externalBlocker: false, reason: "authority matrix command emitted no parseable structured report", report: null };
  return { status: parsed.status, passed: parsed.status === "passed", externalBlocker: false, report: parsed };
}

function parseVitestJson(stdout) {
  const parsed = parseJsonOutput(stdout);
  if (!parsed || typeof parsed.numTotalTests !== "number") return undefined;
  const failedTestNames = Array.isArray(parsed.testResults)
    ? parsed.testResults.flatMap(file => Array.isArray(file.assertionResults)
      ? file.assertionResults.filter(test => test.status === "failed").map(test => test.fullName ?? test.title ?? "unnamed failed test")
      : [])
    : [];
  return {
    counts: {
      total: parsed.numTotalTests,
      passed: parsed.numPassedTests,
      failed: parsed.numFailedTests,
      pending: parsed.numPendingTests,
      todo: parsed.numTodoTests,
      suitesTotal: parsed.numTotalTestSuites,
      suitesPassed: parsed.numPassedTestSuites,
      suitesFailed: parsed.numFailedTestSuites
    },
    failedTestNames
  };
}

function parseJsonOutput(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try { return JSON.parse(trimmed); } catch { /* try individual output lines */ }
  const lines = trimmed.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (!line?.startsWith("{") || !line.endsWith("}")) continue;
    try { return JSON.parse(line); } catch { /* continue */ }
  }
  return undefined;
}

function publicCommandResult(result) {
  return {
    id: result.id,
    command: result.command,
    executable: result.executable,
    args: result.args,
    shell: result.shell,
    ran: result.ran,
    reason: result.reason ?? null,
    startedAt: result.startedAt,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    signal: result.signal,
    spawnError: result.spawnError,
    testCounts: result.testCounts,
    failedTestNames: result.failedTestNames,
    testReportParsed: result.testReportParsed,
    testReportParseError: result.testReportParseError,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    stdoutTail: result.exitCode === 0 ? null : tail(result.stdout, 8_000),
    stderrTail: result.stderr ? tail(result.stderr, 8_000) : null
  };
}

function notRunCommand(id, command, reason) {
  return {
    id,
    command,
    executable: null,
    args: [],
    shell: false,
    ran: false,
    reason,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    exitCode: null,
    signal: null,
    spawnError: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    testCounts: null,
    failedTestNames: [],
    testReportParsed: null,
    testReportParseError: null
  };
}

function unavailableResult(id, reason) {
  return { id, status: "unavailable", passed: false, reason: reason ?? "required API unavailable" };
}

function parseChangedFiles(stdout) {
  return stdout.split(/\r?\n/u).filter(Boolean).map(line => ({ status: line.slice(0, 2), path: line.slice(3) }));
}

function boundedAppend(current, chunk, maximumBytes) {
  if (current.length >= maximumBytes) return { value: current, truncated: true };
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = maximumBytes - current.length;
  return { value: Buffer.concat([current, buffer.subarray(0, remaining)]), truncated: buffer.length > remaining };
}

function resolvePnpmInvocation() {
  const candidates = [];
  if (process.env.npm_execpath && /pnpm.*\.(?:c?js)$/iu.test(process.env.npm_execpath)) candidates.push(process.env.npm_execpath);
  const executableDirectory = path.dirname(process.execPath);
  candidates.push(
    path.join(executableDirectory, "node_modules", "corepack", "dist", "pnpm.js"),
    path.join(executableDirectory, "node_modules", "pnpm", "bin", "pnpm.cjs")
  );
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.push(
      path.join(directory, "node_modules", "corepack", "dist", "pnpm.js"),
      path.join(directory, "node_modules", "pnpm", "bin", "pnpm.cjs"),
      path.join(directory, "pnpm.cjs")
    );
  }
  const cli = candidates.find(candidate => existsSync(candidate));
  if (cli) return { executable: process.execPath, argsPrefix: [cli], resolution: "node_cli" };
  return { executable: process.platform === "win32" ? "pnpm.cmd" : "pnpm", argsPrefix: [], resolution: "path_fallback" };
}

function renderMarkdown(report) {
  const lines = [
    "# Focused cognition report",
    "",
    `Status: ${report.status}`,
    "",
    `Started: ${report.startedAt}`,
    "",
    `Completed: ${report.completedAt}`,
    "",
    "## Commands",
    "",
    "| Command | Ran | Exit | Tests | Failed names |",
    "|---|---:|---:|---:|---|"
  ];
  for (const command of report.commands) {
    const counts = command.testCounts
      ? `${command.testCounts.passed}/${command.testCounts.total} passed; ${command.testCounts.failed} failed`
      : "n/a";
    lines.push(`| ${markdown(command.command)} | ${command.ran ? "yes" : "no"} | ${command.exitCode ?? "n/a"} | ${counts} | ${markdown(command.failedTestNames.join("; ") || "-")} |`);
  }
  lines.push(
    "",
    "## Source-only authority matrix",
    "",
    `Status: ${report.sourceOnlyAuthorityMatrix.status}`,
    "",
    "| Case | Requested | Selected | Passed |",
    "|---|---|---|---:|"
  );
  for (const row of report.sourceOnlyAuthorityMatrix.cases ?? []) {
    lines.push(`| ${markdown(row.id)} | ${markdown(row.result?.requestedAuthority ?? "-")} | ${markdown(row.result?.selectedCandidate?.kind ?? row.error ?? "-")} | ${row.passed ? "yes" : "no"} |`);
  }
  lines.push(
    "",
    "## Hydrated authority matrix",
    "",
    `Status: ${report.hydratedAuthorityMatrix.status}`,
    "",
    `External blocker: ${report.hydratedAuthorityMatrix.externalBlocker ? "yes" : "no"}`,
    "",
    "## Numerical diagnostics",
    "",
    `Correlated covariance log determinant: ${report.spectralLogDetComparison?.passed ? "passed" : "not passed"}`,
    "",
    `Actual log determinant: ${report.spectralLogDetComparison ? numeric(report.spectralLogDetComparison.actual?.logDet) : "unavailable"}`,
    "",
    `Independent correlated reference: ${report.spectralLogDetComparison ? numeric(report.spectralLogDetComparison.expectedCorrelatedLogDet) : "unavailable"}`,
    "",
    `Companion spectral-radius fixtures: ${report.companionSpectralRadiusFixtures?.passed ? "passed" : "not passed"}`,
    "",
    "| Fixture | Expected radius | Actual radius | Converged | Passed |",
    "|---|---:|---:|---:|---:|"
  );
  for (const fixture of report.companionSpectralRadiusFixtures?.fixtures ?? []) {
    lines.push(`| ${markdown(fixture.id)} | ${numeric(fixture.expectedRadius)} | ${numeric(fixture.diagnostic?.radius)} | ${fixture.diagnostic?.converged ? "yes" : "no"} | ${fixture.passed ? "yes" : "no"} |`);
  }
  lines.push(
    "",
    `Interval-width checks: ${report.intervalWidthChecks?.passed ? "passed" : "not passed"}`,
    "",
    `Stable h=1 variance: ${numeric(report.intervalWidthChecks?.stableH1?.covariance?.[0]?.[0])}`,
    "",
    `Stable h=3 variance: ${numeric(report.intervalWidthChecks?.stableH3?.covariance?.[0]?.[0])}`,
    "",
    `Unstable h=1 variance: ${numeric(report.intervalWidthChecks?.unstableH1?.covariance?.[0]?.[0])}`,
    "",
    `PowerWalk initializer versus fitted likelihood: ${report.powerWalkInitializerVersusFit.passed ? "passed" : "not passed"}`,
    "",
    "| PowerWalk field | p | q | lambda |",
    "|---|---:|---:|---:|",
    `| initialized | ${numeric(report.powerWalkInitializerVersusFit.initialized?.p)} | ${numeric(report.powerWalkInitializerVersusFit.initialized?.q)} | ${numeric(report.powerWalkInitializerVersusFit.initialized?.lambda)} |`,
    `| fitted | ${numeric(report.powerWalkInitializerVersusFit.fitted?.p)} | ${numeric(report.powerWalkInitializerVersusFit.fitted?.q)} | ${numeric(report.powerWalkInitializerVersusFit.fitted?.lambda)} |`,
    `| active | ${numeric(report.powerWalkInitializerVersusFit.active?.p)} | ${numeric(report.powerWalkInitializerVersusFit.active?.q)} | ${numeric(report.powerWalkInitializerVersusFit.active?.lambda)} |`,
    "",
    `Fit mean-NLL improvement: ${numeric(report.powerWalkInitializerVersusFit.fitted?.fitMeanNllImprovement)}`,
    "",
    `Held-out mean-NLL improvement: ${numeric(report.powerWalkInitializerVersusFit.fitted?.heldOutMeanNllImprovement)}`,
    "",
    "## Changed files",
    ""
  );
  if (report.changedFiles.length === 0) lines.push("None reported by git.");
  else for (const file of report.changedFiles) lines.push(`- \`${file.status}\` ${file.path}`);
  lines.push("");
  return lines.join("\n");
}

function markdown(value) {
  return String(value ?? "").replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "unavailable";
}

function commandArgument(value) {
  return /[\s"']/u.test(value) ? JSON.stringify(value) : value;
}

function tail(value, maximumCharacters) {
  const text = String(value ?? "");
  return text.length <= maximumCharacters ? text : text.slice(-maximumCharacters);
}

function sanitizedError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[redacted-database-url]")
    .slice(0, 4_000);
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
