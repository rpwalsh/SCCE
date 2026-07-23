#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertHydratedRuntimeReady, buildScce2BrainShardIndex, createHydrationPlan, createNodeRuntime, createScce2ToV3Importer, createWikipediaV3Ingestor, createWorkspaceRuntime, dryRunDeveloperRepoPlan, dryRunEngineeringCorpusIngest, graphDeveloperRepo, importHydrationPlan, inspectDeveloperRepo, inspectEngineeringCorpusFolder, inspectHydrationStatus, inspectV2Artifacts, inspectV2GraphShard, inspectV2Ngram, inspectV2Profile, inspectV2Stream, inspectV2StreamTopic, inspectV2Topic, parseRepoDiagnosticsFixture, readScceRuntimeConfig, routeEngineeringCorpusFixture, scanLanguageControlHygiene, trainGutenbergCorpus, trainOssCorpus, verifiedCompilerPlansForTurn, type WikipediaV3IngestStatus, type WorkspaceRuntimeOptions } from "@scce/adapters-node";
import type { BenchmarkInput, InspectionTarget, WorkspaceReportRecord } from "@scce/kernel";
import { parseScce2ImportOptions, parseScce2InspectOptions } from "./scce2-options.js";
import { defaultWorkspaceCodingRequestId, parseWorkspaceCodingRequest, splitWorkspaceCodingTurnArgs, WORKSPACE_CODE_USAGE } from "./workspace-code-options.js";
import { CALIBRATION_TASK_CLASS_IDS, buildTurnDialogueBridge, createTrace, latestDialogueStyleProfile, loadCalibrationModelSet, persistDialogueTurn, toJsonValue, traceEvent } from "@scce/kernel";

interface Parsed {
  configPath: string;
  command?: string;
  args: string[];
}

const TOP_LEVEL_WORKSPACE_REPORTS: Partial<Record<string, WorkspaceReportRecord["reportKind"]>> = {
  brief: "brief",
  "patch-plan": "patch_plan",
  handoff: "handoff",
  review: "review"
};

async function main(): Promise<void> {
  const trace = createTrace('cli.main');
  if (trace) (globalThis as any).__sccTrace = trace;
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.command || parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") return usage();
  if (parsed.command === "hygiene") {
    await hygiene(parsed.args);
    return;
  }
  if (parsed.command === "corpus" && parsed.args[0] !== "train") {
    await corpus(undefined, parsed.args);
    return;
  }
  if (parsed.command === "repo") {
    await repo(parsed.args);
    return;
  }
  const config = await readScceRuntimeConfig(parsed.configPath);
  const runtime = createNodeRuntime(config);
  try {
    const reportKind = TOP_LEVEL_WORKSPACE_REPORTS[parsed.command];
    if (reportKind) {
      printJson(await createWorkspaceRuntime({ runtime, config }).report(reportKind, workspacePathArg(parsed.args), parseWorkspaceOptions(parsed.args)));
      return;
    }
    traceEvent(trace, { stage: 'cli.command.start', label: parsed.command });
    switch (parsed.command) {
      case "db":
        await db(runtime, parsed.args);
        return;
      case "corpus":
        await corpus(runtime, parsed.args);
        return;
      case "hydrate":
        await hydrate(runtime, parsed.args);
        return;
      case "ingest":
        if (parsed.args[0] === "wiki") {
          await ingestWiki(parsed.configPath, config, runtime, parsed.args.slice(1));
          return;
        }
        if (!parsed.args[0]) return usage("scce ingest <path-or-uri>");
        printJson(await createWorkspaceRuntime({ runtime, config }).ingest(parsed.args[0], parseWorkspaceOptions(parsed.args.slice(1))));
        return;
      case "workspace":
        await workspace(createWorkspaceRuntime({ runtime, config }), parsed.args);
        return;
      case "project":
        await project(createWorkspaceRuntime({ runtime, config }), parsed.args);
        return;
      case "codebase":
        await codebase(runtime, parsed.args);
        return;
      case "train":
        if (!parsed.args[0]) return usage("scce train <config>");
        printJson(await runtime.kernel.train({ config: JSON.parse(await readFile(path.resolve(parsed.args[0]), "utf8")) }));
        return;
      case "turn": {
        const workspaceTurn = splitWorkspaceCodingTurnArgs(parsed.args);
        const turnArgs = parseTurnArgs(workspaceTurn.turnArgs);
        const text = turnArgs.text;
        if (!text) return usage("scce turn [--workspace-code --path=<workspace-file> --diagnostic-code=<integer>] <prompt>");
        const turnStarted = Date.now();
        traceEvent(trace, { stage: "turn.input", label: "cli.turn", input: previewText(text), counts: { textChars: text.length } });
        try {
          const active = await assertHydratedRuntimeReady(runtime.storage);
          traceEvent(trace, { stage: "turn.runtime.start", label: "cli.turn" });
          const conversationId = turnArgs.conversationId ?? turnArgs.sessionId ?? "conversation.cli";
          const learnedDialogueProfile = await latestDialogueStyleProfile(runtime.storage.dialogueMemory, conversationId);
          const workspaceRuntime = workspaceTurn.codingRequest ? createWorkspaceRuntime({ runtime, config }) : undefined;
          const workspaceProject = workspaceRuntime && workspaceTurn.codingRequest
            ? await workspaceRuntime.project(workspaceTurn.codingRequest.rootPath, parseWorkspaceOptions(workspaceTurn.codingRequest.workspaceOptionArgs))
            : undefined;
          const workspaceCoding = workspaceRuntime && workspaceTurn.codingRequest && workspaceProject
            ? await workspaceRuntime.planCodingPatch({
              workspaceId: workspaceProject.workspace.id,
              expectedWorkspaceUpdatedAt: workspaceProject.workspace.updatedAt,
              requestId: workspaceTurn.codingRequest.requestId ?? defaultWorkspaceCodingRequestId({
                workspaceId: workspaceProject.workspace.id,
                expectedWorkspaceUpdatedAt: workspaceProject.workspace.updatedAt,
                request: workspaceTurn.codingRequest
              }),
              requestText: text,
              requestedPaths: workspaceTurn.codingRequest.requestedPaths,
              ...(workspaceTurn.codingRequest.diagnosticCodes.length
                ? { diagnosticCodes: workspaceTurn.codingRequest.diagnosticCodes }
                : {}),
              validationPlan: {
                validatorId: workspaceTurn.codingRequest.validatorId,
                checks: workspaceTurn.codingRequest.checks
              }
            }, workspaceTurn.codingRequest.rootPath, parseWorkspaceOptions(workspaceTurn.codingRequest.workspaceOptionArgs))
            : undefined;
          const workspacePlans = workspaceCoding ? verifiedCompilerPlansForTurn(workspaceCoding) : [];
          const turnInput = {
            text,
            metadata: {
              runtimePath: { hydratedRuntime: true, serverPath: false, sourceOnlySimulation: false },
              runtime: { workspacePlans: workspacePlans.map(plan => toJsonValue(plan)) },
              activeBrainVersion: active.activeBrainVersion,
              activeImportRunIds: active.activeImportRunIds,
              conversationId,
              sessionId: turnArgs.sessionId ?? conversationId,
              ...(turnArgs.detailProfileId ? { detailProfileId: turnArgs.detailProfileId } : {})
            }
          };
          const result = await runtime.kernel.turn(turnInput);
          const calibrationModels = await loadCalibrationModelSet({
            store: runtime.storage.dialogueMemory,
            minPoints: 2,
            createdAt: Date.now()
          });
          const dialogue = buildTurnDialogueBridge({
            requestText: text,
            result,
            conversationId,
            turnId: String(result.episodeId),
            targetLanguage: turnArgs.targetLanguage,
            userStyleProfile: learnedDialogueProfile,
            calibrationModels,
            calibrationTaskClass: CALIBRATION_TASK_CLASS_IDS.dialogueOutcome
          });
          await persistDialogueTurn({
            store: runtime.storage.dialogueMemory,
            result: dialogue.pragmatics,
            answerGraphHash: dialogue.answerGraphHash,
            now: Date.now()
          });
          traceEvent(trace, {
            stage: "turn.runtime.end",
            label: "cli.turn",
            durationMs: Date.now() - turnStarted,
            counts: {
              evidence: result.evidence.length,
              artifacts: result.emissionGraph.artifacts.length
            }
          });
          traceEvent(trace, {
            stage: "turn.output",
            label: "cli.turn",
            output: previewText(result.answer),
            counts: {
              answerChars: result.answer.length,
              evidence: result.evidence.length,
              artifacts: result.emissionGraph.artifacts.length
            }
          });
          process.stdout.write(`${result.answer}\n`);
          if (result.emissionGraph.artifacts.length) {
            process.stdout.write("\nArtifacts persisted in PostgreSQL:\n");
            for (const artifact of result.emissionGraph.artifacts) process.stdout.write(`- ${artifact.path} ${artifact.contentHash}\n`);
          }
          process.stdout.write(`\nTrace: episode=${result.episodeId} hydratedRuntime=true serverPath=false sourceOnlySimulation=false evidence=${result.evidence.length} conversation=${dialogue.conversationId} dialogue=${dialogue.pragmatics.id} stream=${dialogue.streamPlan.id}\n`);
          if (turnArgs.webRequested) process.stdout.write("Web learning: disabled; local kernel only.\n");
        } catch (error) {
          traceEvent(trace, { stage: "turn.error", label: "cli.turn", durationMs: Date.now() - turnStarted, warnings: [String(error)] });
          throw error;
        }
        return;
      }
      case "inspect":
        await inspect(runtime, config, parsed.args);
        return;
      case "replay":
        if (!parsed.args[0]) return usage("scce replay <episodeId>");
        printJson(await runtime.kernel.replay(parsed.args[0] as never));
        return;
      case "benchmark":
        if (!parsed.args[0]) return usage("scce benchmark <config>");
        printJson(await runtime.kernel.benchmark({ config: JSON.parse(await readFile(path.resolve(parsed.args[0]), "utf8")) as BenchmarkInput["config"] }));
        return;
      case "tools":
        printJson({ configuredConnectors: config.connectors, documentTools: "use server /api/tools for live diagnostics" });
        return;
      case "scce2":
        await scce2(runtime, parsed.args);
        return;
      default:
        usage(`unknown command: ${parsed.command}`);
    }
  } finally {
    traceEvent(trace, { stage: 'cli.command.end', label: parsed.command });
    await runtime.close();
  }
}

async function ingestWiki(configPath: string, config: Awaited<ReturnType<typeof readScceRuntimeConfig>>, runtime: ReturnType<typeof createNodeRuntime>, args: string[]): Promise<void> {
  if (args[0] === "status") {
    await ingestWikiStatus(config, args.slice(1));
    return;
  }
  if (args[0] === "firehose") {
    await ingestWikiFirehose(configPath, config, args.slice(1));
    return;
  }
  const explicitTarget = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const target = explicitTarget ?? config.runtime.corpora?.wikipedia?.dumpPath;
  if (!target) return usage("scce ingest wiki <dump-path> [--index=<path>] [--max-pages=<n>] [--max-blocks=<n>] [--start-offset=<bytes>] [--fresh] [--no-resume] [--memory-safety-bound-mb=<n>]");
  const options = parseWikiIngestOptions(args.slice(explicitTarget ? 1 : 0));
  const ingestor = createWikipediaV3Ingestor({ storage: runtime.storage, config });
  if (options.statusPath) await mkdir(path.dirname(options.statusPath), { recursive: true });
  printJson(await ingestor.ingest({
    dumpPath: path.resolve(target),
    ...options,
    onStatus: options.statusPath ? status => writeJsonReplacing(options.statusPath!, status) : undefined
  }));
}

async function ingestWikiFirehose(configPath: string, config: Awaited<ReturnType<typeof readScceRuntimeConfig>>, args: string[]): Promise<void> {
  const explicitTarget = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const target = path.resolve(explicitTarget ?? config.runtime.corpora?.wikipedia?.dumpPath ?? "");
  if (!target) return usage("scce ingest wiki firehose <dump-path> [--runner-max-segments=<n>] [--child-heap-mb=<n>] [--heap-checkpoint-mb=<n>]");
  const firehose = parseWikiFirehoseOptions(args.slice(explicitTarget ? 1 : 0));
  const paths = wikiFirehosePaths(config, firehose);
  await mkdir(paths.root, { recursive: true });
  const release = await acquireWikiFirehoseLock(paths.lockPath, target, paths.statusPath);
  try {
    let segment = 1;
    while (true) {
      const childFlags = wikiChildFlags(firehose, paths, segment === 1);
      const cliPath = fileURLToPath(import.meta.url);
      const nodeArgs = [`--max-old-space-size=${firehose.childHeapMb}`, cliPath, "--config", path.resolve(configPath), "ingest", "wiki", target, ...childFlags];
      process.stdout.write(`\n[scce wiki firehose] segment ${segment} starting: node ${nodeArgs.join(" ")}\n`);
      const code = await runChild(nodeArgs);
      const status = await readJson<WikipediaV3IngestStatus>(paths.statusPath);
      if (code !== 0) {
        process.stderr.write(`[scce wiki firehose] segment ${segment} exited ${code}; stopping supervisor.\n`);
        process.exitCode = code;
        return;
      }
      if (status?.fullTrainingComplete) {
        process.stdout.write("[scce wiki firehose] full training complete.\n");
        return;
      }
      if (status?.stoppedByOwner) {
        process.stdout.write(`[scce wiki firehose] owner stop observed: ${status.stopReason ?? "stop requested"}\n`);
        return;
      }
      if (!status?.stoppedByHeapSafetyBound) {
        process.stdout.write(`[scce wiki firehose] segment finished without heap checkpoint; state=${status?.state ?? "unknown"}.\n`);
        return;
      }
      if (firehose.runnerMaxSegments > 0 && segment >= firehose.runnerMaxSegments) {
        process.stdout.write(`[scce wiki firehose] runner max segments reached (${firehose.runnerMaxSegments}); stopping supervisor.\n`);
        return;
      }
      segment++;
    }
  } finally {
    await release().catch(() => undefined);
  }
}

async function ingestWikiStatus(config: Awaited<ReturnType<typeof readScceRuntimeConfig>>, args: string[]): Promise<void> {
  const options = parseWikiStatusOptions(args);
  const paths = wikiFirehosePaths(config, options);
  await mkdir(paths.root, { recursive: true });
  if (options.clearStop && existsSync(paths.stopFile)) await unlink(paths.stopFile);
  if (options.stop) await writeJsonReplacing(paths.stopFile, { requestedAt: Date.now(), requestedByPid: process.pid });
  const status = await readJson<WikipediaV3IngestStatus>(paths.statusPath);
  const lock = await readJson<{ pid?: number; target?: string; statusPath?: string; startedAt?: number }>(paths.lockPath);
  const running = processIsAlive(lock?.pid) || processIsAlive(status?.pid);
  printJson({ running, stopRequested: existsSync(paths.stopFile), statusPath: paths.statusPath, lockPath: paths.lockPath, stopFile: paths.stopFile, status, lock });
}

async function scce2(runtime: ReturnType<typeof createNodeRuntime>, args: string[]): Promise<void> {
  const sub = args[0];
  const target = args[1];
  if (!sub || !target) return usage("scce scce2 <inspect|import> <path> [limits]");
  if (sub === "inspect") {
    const inspectOptions = parseScce2InspectOptions(args.slice(2));
    const index = await buildScce2BrainShardIndex(path.resolve(target), inspectOptions);
    printJson(inspectOptions.summaryOnly ? summarizeScce2Index(index) : index);
    return;
  }
  if (sub === "import") {
    const options = parseScce2ImportOptions(args.slice(2));
    if (options.statusPath) await mkdir(path.dirname(options.statusPath), { recursive: true });
    const readiness = await runtime.storage.verify();
    if (!readiness.ok) {
      const status = {
        schema: "scce.scce2ImportStatus.v1",
        state: "failed",
        pid: process.pid,
        rootPath: path.resolve(target),
        currentSection: "postgres.verify",
        stopped: true,
        stopReason: "PostgreSQL schema is not initialized",
        errors: readiness.errors
      };
      if (options.statusPath) await writeJsonReplacing(options.statusPath, status);
      printJson({ ok: false, error: "postgres_schema_not_initialized", tables: readiness.tables, errors: readiness.errors });
      process.exitCode = 1;
      return;
    }
    const importer = createScce2ToV3Importer({ storage: runtime.storage });
    printJson(await importer.import(path.resolve(target), {
      ...options,
      onStatus: options.statusPath ? status => writeJsonReplacing(options.statusPath!, status) : undefined
    }));
    return;
  }
  return usage("scce scce2 <inspect|import> <path> [limits]");
}

async function corpus(runtime: ReturnType<typeof createNodeRuntime> | undefined, args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "inspect") {
    const target = args[1];
    if (!target) return usage("scce corpus inspect <path> [--max-files=<n>] [--max-file-bytes=<n>] [--max-depth=<n>]");
    printJson(await inspectEngineeringCorpusFolder(path.resolve(target), parseCorpusOptions(args.slice(2))));
    return;
  }
  if (sub === "ingest") {
    const rest = args.slice(1).filter(arg => arg !== "--dry-run");
    const target = rest.find(arg => !arg.startsWith("--"));
    if (!target) return usage("scce corpus ingest --dry-run <path> [--max-files=<n>] [--max-file-bytes=<n>] [--max-depth=<n>]");
    printJson(await dryRunEngineeringCorpusIngest(path.resolve(target), parseCorpusOptions(rest.filter(arg => arg !== target))));
    return;
  }
  if (sub === "route") {
    const targetIndex = args.indexOf("--fixture");
    const target = targetIndex >= 0 ? args[targetIndex + 1] : args[1];
    if (!target) return usage("scce corpus route --fixture <path> [--max-files=<n>] [--max-file-bytes=<n>] [--max-depth=<n>]");
    const optionArgs = args.slice(1).filter((arg, index, array) => arg !== "--fixture" && array[index - 1] !== "--fixture" && arg !== target);
    printJson(await routeEngineeringCorpusFixture(path.resolve(target), parseCorpusOptions(optionArgs)));
    return;
  }
  if (sub === "train") {
    if (!runtime) return usage("scce corpus train <gutenberg|oss> <path> [limits]");
    const kind = args[1];
    const target = args[2];
    if (!target || (kind !== "gutenberg" && kind !== "oss")) return usage("scce corpus train <gutenberg|oss> <path> [--max-files=<n>] [--max-file-bytes=<n>] [--max-depth=<n>] [--ngram-max-order=<n>] [--ngram-max-counters=<n>] [--ngram-vocabulary-limit=<n>]");
    const options = parseCorpusTrainOptions(args.slice(3));
    if (kind === "gutenberg") {
      printJson(await trainGutenbergCorpus({
        storage: runtime.storage,
        rootPath: path.resolve(target),
        maxFilesPerRun: options.maxFiles,
        maxFileBytes: options.maxFileBytes,
        maxDepth: options.maxDepth,
        ngramMaxOrder: options.ngramMaxOrder,
        ngramMaxCountersPerOrder: options.ngramMaxCountersPerOrder,
        ngramVocabularyLimit: options.ngramVocabularyLimit
      }));
      return;
    }
    printJson(await trainOssCorpus({
      storage: runtime.storage,
      rootPath: path.resolve(target),
      maxFiles: options.maxFiles,
      maxFileBytes: options.maxFileBytes,
      maxDepth: options.maxDepth,
      includeDocs: options.includeDocs,
      includeSource: options.includeSource,
      ngramMaxOrder: options.ngramMaxOrder,
      ngramMaxCountersPerOrder: options.ngramMaxCountersPerOrder,
      ngramVocabularyLimit: options.ngramVocabularyLimit
    }));
    return;
  }
  return usage("scce corpus <inspect|ingest|route|train> ...");
}

async function repo(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "inspect") {
    const target = args[1];
    if (!target) return usage("scce repo inspect <path> [--max-files=<n>] [--max-file-bytes=<n>] [--max-depth=<n>]");
    printJson(await inspectDeveloperRepo(path.resolve(target), parseRepoOptions(args.slice(2))));
    return;
  }
  if (sub === "graph") {
    const target = args[1];
    if (!target) return usage("scce repo graph <path> [--max-files=<n>] [--max-file-bytes=<n>] [--max-depth=<n>]");
    printJson(await graphDeveloperRepo(path.resolve(target), parseRepoOptions(args.slice(2))));
    return;
  }
  if (sub === "diagnostics") {
    const fixture = valueAfterFlag(args, "--fixture") ?? args[1];
    if (!fixture) return usage("scce repo diagnostics --fixture <path>");
    printJson(await parseRepoDiagnosticsFixture(path.resolve(fixture)));
    return;
  }
  if (sub === "plan") {
    const rest = args.slice(1).filter(arg => arg !== "--dry-run");
    const target = rest.find(arg => !arg.startsWith("--"));
    if (!target) return usage("scce repo plan --dry-run <path> [--max-files=<n>] [--max-file-bytes=<n>] [--max-depth=<n>]");
    printJson(await dryRunDeveloperRepoPlan(path.resolve(target), parseRepoOptions(rest.filter(arg => arg !== target))));
    return;
  }
  return usage("scce repo <inspect|graph|diagnostics|plan> ...");
}

async function codebase(runtime: ReturnType<typeof createNodeRuntime>, args: string[]): Promise<void> {
  const sub = args[0];
  const target = args[1];
  if (sub !== "ingest" || !target) return usage("scce codebase ingest <repo-or-folder-path>");
  printJson(await runtime.kernel.ingest({ path: target, metadata: { sourceKind: "developer_intelligence", ingestionLane: "codebase" } }));
}

async function hydrate(runtime: ReturnType<typeof createNodeRuntime>, args: string[]): Promise<void> {
  const sub = args[0];
  const target = args[1];
  if (sub === "status") {
    const options = parseHydrateStatusOptions(args.slice(1));
    printJson(await inspectHydrationStatus(runtime.storage, options));
    return;
  }
  if ((sub !== "plan" && sub !== "import") || !target) return usage("scce hydrate <plan|import|status> <path> [--plan=<planId>] [limits]");
  if (sub === "plan") {
    printJson(await createHydrationPlan(path.resolve(target), parseScce2InspectOptions(args.slice(2))));
    return;
  }
  const planId = optionValue(args.slice(2), "--plan");
  if (!planId) return usage("scce hydrate import <path> --plan=<planId>");
  const options = parseScce2ImportOptions(args.slice(2).filter((arg, index, all) => arg !== "--plan" && all[index - 1] !== "--plan" && !arg.startsWith("--plan=")));
  if (options.statusPath) await mkdir(path.dirname(options.statusPath), { recursive: true });
  const result = await importHydrationPlan(runtime.storage, path.resolve(target), {
    ...options,
    planId,
    onStatus: options.statusPath ? status => writeJsonReplacing(options.statusPath!, status) : undefined
  });
  printJson(result);
  if (!result.ok) process.exitCode = 1;
}

async function workspace(runtime: ReturnType<typeof createWorkspaceRuntime>, args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "init") {
    const target = args[1];
    if (!target) return usage("scce workspace init <path>");
    printJson(await runtime.init(target, parseWorkspaceOptions(args.slice(2))));
    return;
  }
  if (sub === "ingest") {
    printJson(await runtime.ingest(workspacePathArg(args.slice(1)), parseWorkspaceOptions(args.slice(1))));
    return;
  }
  if (sub === "answer" || sub === "ask") {
    const question = args.slice(1).filter(arg => !arg.startsWith("--")).join(" ").trim();
    if (!question) return usage("scce workspace ask <question>");
    printJson(await runtime.answer(question, undefined, parseWorkspaceOptions(args.slice(1))));
    return;
  }
  if (sub === "code" || sub === "plan-code") {
    const request = parseWorkspaceCodingRequest(args.slice(1));
    if (!request) return usage(WORKSPACE_CODE_USAGE);
    const options = parseWorkspaceOptions(request.workspaceOptionArgs);
    const project = await runtime.project(request.rootPath, options);
    const requestId = request.requestId ?? defaultWorkspaceCodingRequestId({
      workspaceId: project.workspace.id,
      expectedWorkspaceUpdatedAt: project.workspace.updatedAt,
      request
    });
    printJson(await runtime.planCodingPatch({
      workspaceId: project.workspace.id,
      expectedWorkspaceUpdatedAt: project.workspace.updatedAt,
      requestId,
      requestText: request.text,
      requestedPaths: request.requestedPaths,
      ...(request.diagnosticCodes.length ? { diagnosticCodes: request.diagnosticCodes } : {}),
      validationPlan: {
        validatorId: request.validatorId,
        checks: request.checks
      }
    }, request.rootPath, options));
    return;
  }
  if (sub === "outcome") {
    const status = args[1];
    if (status !== "accepted" && status !== "rejected" && status !== "corrected") return usage("scce workspace outcome <accepted|rejected|corrected> [--correction-text=...] [--report-id=...]");
    printJson(await runtime.recordOutcome({
      status,
      correctionText: optionValue(args.slice(2), "--correction-text"),
      reportId: optionValue(args.slice(2), "--report-id"),
      conversationId: optionValue(args.slice(2), "--conversation-id"),
      promptText: optionValue(args.slice(2), "--prompt")
    }, undefined, parseWorkspaceOptions(args.slice(2))));
    return;
  }
  return usage("scce workspace <init|ingest|ask|plan-code|outcome> ... (workspace code is an alias for plan-code)");
}

async function project(runtime: ReturnType<typeof createWorkspaceRuntime>, args: string[]): Promise<void> {
  const sub = args[0] ?? "summary";
  const target = workspacePathArg(args.slice(1));
  const options = parseWorkspaceOptions(args.slice(1));
  const report = await runtime.project(target, options);
  if (sub === "summary") return printJson({ schema: "scce.project.summary.v1", workspace: report.workspace, summary: report.summary, counts: report.summary.counts, sourceRefs: report.summary.sourceRefs });
  if (sub === "map") return printJson({ schema: "scce.project.map.v1", workspace: report.workspace, map: report.map });
  if (sub === "symbols") return printJson({ schema: "scce.project.symbols.v1", workspace: report.workspace, symbols: report.symbols });
  if (sub === "gaps") return printJson({ schema: "scce.project.gaps.v1", workspace: report.workspace, gaps: report.gaps });
  if (sub === "contradictions") return printJson({ schema: "scce.project.contradictions.v1", workspace: report.workspace, contradictions: report.contradictions });
  if (sub === "tasks") return printJson({ schema: "scce.project.tasks.v1", workspace: report.workspace, tasks: report.tasks });
  if (sub === "commands") return printJson({ schema: "scce.project.commands.v1", workspace: report.workspace, commands: report.commands });
  if (sub === "routes") return printJson({ schema: "scce.project.routes.v1", workspace: report.workspace, routes: report.routes });
  return usage("scce project <summary|map|symbols|gaps|contradictions|tasks|commands|routes> [path]");
}

function parseWorkspaceOptions(args: string[]): WorkspaceRuntimeOptions {
  const out: WorkspaceRuntimeOptions = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if (flag === "--max-files" && Number.isFinite(num)) out.maxFiles = Math.max(1, num);
    else if (flag === "--max-file-bytes" && Number.isFinite(num)) out.maxFileBytes = Math.max(1024, num);
    else if (flag === "--max-depth" && Number.isFinite(num)) out.maxDepth = Math.max(0, num);
    else if (flag === "--max-document-bytes" && Number.isFinite(num)) out.maxDocumentBytes = Math.max(4096, num);
    else if (flag === "--conversation-id" && raw) out.conversationId = raw;
    else if (flag === "--target-language" && raw) out.targetLanguage = raw;
    else if (arg === "--legacy-workspace-answer") out.useKernelAnswer = false;
    else if (arg === "--kernel-workspace-answer") out.useKernelAnswer = true;
    else if (arg === "--no-unsupported") out.includeUnsupported = false;
    else throw new Error(`unknown workspace option: ${arg}`);
  }
  return out;
}

function parseHydrateStatusOptions(args: string[]): { statusFile?: string } {
  const out: { statusFile?: string } = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    if (flag === "--status" && raw) out.statusFile = path.resolve(raw);
    else throw new Error(`unknown hydrate status option: ${arg}`);
  }
  return out;
}

function parseV2ArtifactInspectOptions(args: string[]): { maxDepth?: number; maxFiles?: number; hashWorkExtentBytes?: number; maxHashBytesPerFile?: number } {
  const out: { maxDepth?: number; maxFiles?: number; hashWorkExtentBytes?: number; maxHashBytesPerFile?: number } = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if (flag === "--max-depth" && Number.isFinite(num)) out.maxDepth = Math.max(0, num);
    else if (flag === "--max-files" && Number.isFinite(num)) out.maxFiles = Math.max(1, num);
    else if (flag === "--hash-work-extent-mb" && Number.isFinite(num)) out.hashWorkExtentBytes = Math.max(0, Math.floor(num * 1024 * 1024));
    else if (flag === "--max-hash-file-mb" && Number.isFinite(num)) out.maxHashBytesPerFile = Math.max(0, Math.floor(num * 1024 * 1024));
    else if (arg === "--no-hashes") {
      out.hashWorkExtentBytes = 0;
      out.maxHashBytesPerFile = 0;
    } else throw new Error(`unknown v2 artifact inspect option: ${arg}`);
  }
  return out;
}

function parseBoundedDecodeOptions(args: string[]): { maxBytes?: number; sampleLimit?: number } {
  const out: { maxBytes?: number; sampleLimit?: number } = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if (flag === "--max-decode-mb" && Number.isFinite(num)) out.maxBytes = Math.max(0, Math.floor(num * 1024 * 1024));
    else if (flag === "--sample-limit" && Number.isFinite(num)) out.sampleLimit = Math.max(1, Math.floor(num));
    else throw new Error(`unknown bounded decode option: ${arg}`);
  }
  return out;
}

function parseStreamTopicArgs(args: string[], config: Awaited<ReturnType<typeof readScceRuntimeConfig>>): { topic: string; paths: string[]; maxLookupBytes?: number } {
  const topicParts: string[] = [];
  const paths: string[] = [];
  let maxLookupBytes: number | undefined;
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if ((flag === "--path" || flag === "--root" || flag === "--index") && raw) paths.push(path.resolve(raw));
    else if (flag === "--max-lookup-mb" && Number.isFinite(num)) maxLookupBytes = Math.max(1024, Math.floor(num * 1024 * 1024));
    else if (!arg.startsWith("--")) topicParts.push(arg);
    else throw new Error(`unknown stream-topic option: ${arg}`);
  }
  if (!paths.length) {
    const wiki = config.runtime.corpora?.wikipedia;
    if (wiki?.indexPath) paths.push(path.resolve(wiki.indexPath));
    if (wiki?.dumpPath) paths.push(path.dirname(path.resolve(wiki.dumpPath)));
  }
  return { topic: topicParts.join(" ").trim(), paths, maxLookupBytes };
}

function parseTopicInspectArgs(args: string[]): { topic: string; question?: string } {
  const topicParts: string[] = [];
  let question: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const [flag, raw] = arg.split("=", 2);
    if (flag === "--question") {
      const value = raw ?? args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("missing --question value");
      question = value;
      if (raw === undefined) index++;
      continue;
    }
    if (!arg.startsWith("--")) {
      topicParts.push(arg);
      continue;
    }
    throw new Error(`unknown topic inspect option: ${arg}`);
  }
  return { topic: topicParts.join(" ").trim(), question: question?.trim() || undefined };
}

function workspacePathArg(args: string[]): string | undefined {
  return args.find(arg => arg && !arg.startsWith("--"));
}

async function tryWorkspaceAnswer(runtime: ReturnType<typeof createWorkspaceRuntime>, text: string): Promise<Awaited<ReturnType<ReturnType<typeof createWorkspaceRuntime>["answer"]>> | undefined> {
  try {
    return await runtime.answer(text);
  } catch {
    return undefined;
  }
}

function parseCorpusOptions(args: string[]): { maxFiles?: number; maxFileBytes?: number; maxDepth?: number; includeUnsupported?: boolean } {
  const out: { maxFiles?: number; maxFileBytes?: number; maxDepth?: number; includeUnsupported?: boolean } = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if (flag === "--max-files" && Number.isFinite(num)) out.maxFiles = Math.max(1, num);
    else if (flag === "--max-file-bytes" && Number.isFinite(num)) out.maxFileBytes = Math.max(1024, num);
    else if (flag === "--max-depth" && Number.isFinite(num)) out.maxDepth = Math.max(0, num);
    else if (arg === "--no-unsupported") out.includeUnsupported = false;
    else throw new Error(`unknown corpus option: ${arg}`);
  }
  return out;
}

function parseRepoOptions(args: string[]): { maxFiles?: number; maxFileBytes?: number; maxDepth?: number; includeUnsupported?: boolean } {
  const out: { maxFiles?: number; maxFileBytes?: number; maxDepth?: number; includeUnsupported?: boolean } = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if (flag === "--max-files" && Number.isFinite(num)) out.maxFiles = Math.max(1, num);
    else if (flag === "--max-file-bytes" && Number.isFinite(num)) out.maxFileBytes = Math.max(1024, num);
    else if (flag === "--max-depth" && Number.isFinite(num)) out.maxDepth = Math.max(0, num);
    else if (arg === "--no-unsupported") out.includeUnsupported = false;
    else throw new Error(`unknown repo option: ${arg}`);
  }
  return out;
}

function valueAfterFlag(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function optionValue(args: readonly string[], flag: string): string | undefined {
  const direct = valueAfterFlag(args, flag);
  if (direct) return direct;
  const prefix = `${flag}=`;
  const match = args.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

async function hygiene(args: string[]): Promise<void> {
  const sub = args[0] ?? "language-control";
  if (sub !== "language-control") return usage("scce hygiene [language-control] [--root=<path>] [--max-issues=<n>]");
  const options = parseHygieneLanguageControlOptions(args.slice(args[0] ? 1 : 0));
  const result = await scanLanguageControlHygiene(options);
  printJson(result);
  if (result.failed) process.exitCode = 1;
}

function parseHygieneLanguageControlOptions(args: string[]): { root?: string; maxIssues?: number } {
  const out: { root?: string; maxIssues?: number } = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if (flag === "--root" && raw) out.root = path.resolve(raw);
    else if (flag === "--max-issues" && Number.isFinite(num)) out.maxIssues = Math.max(1, num);
    else throw new Error(`unknown hygiene option: ${arg}`);
  }
  return out;
}

function summarizeScce2Index(index: Awaited<ReturnType<typeof buildScce2BrainShardIndex>>): unknown {
  return {
    rootPath: index.rootPath,
    sourceId: index.sourceId,
    totals: index.totals,
    filesFound: index.filesFound,
    importableSections: index.importableSections.length,
    unsupportedSections: index.unsupportedSections.length,
    unknownSections: index.unknownSections.length,
    languagePriorCounts: index.languagePriorCounts,
    graphConceptPriorCounts: index.graphConceptPriorCounts,
    directEvidenceCoverage: index.directEvidenceCoverage,
    hashing: index.hashing,
    forceClasses: countBy(index.entries.map(entry => entry.forceClass)),
    forceClassExplanation: {
      direct_evidence: "exact external source URI/version/span; may certify factual proof after import",
      profile_excerpt_evidence: "profile-contained excerpt only; not external factual proof",
      learned_language_prior: "language prior for runtime surface behavior",
      learned_concept_prior: "graph prior for alpha and PPF activation",
      learned_program_prior: "program-language prior",
      unknown_prior: "unsupported or uncertain semantics"
    },
    kinds: countBy(index.entries.map(entry => entry.kind)),
    sampleEntries: index.entries.slice(0, 12).map(entry => ({
      kind: entry.kind,
      id: entry.id,
      byteLength: entry.byteLength,
      readable: entry.readable,
      format: entry.format,
      forceClass: entry.forceClass,
      rowsAvailable: entry.records,
      hashStatus: entry.hashStatus,
      sha256: entry.sha256
    })),
    warnings: index.warnings
  };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

interface WikiCliIngestOptions {
  indexPath?: string;
  maxPages?: number;
  maxBlocks?: number;
  startOffset?: number;
  fresh?: boolean;
  resume?: boolean;
  memorySafetyBoundMb?: number;
  heapCheckpointMb?: number;
  statusPath?: string;
  lockPath?: string;
  stopFile?: string;
}

interface WikiFirehoseOptions extends WikiCliIngestOptions {
  runnerMaxSegments: number;
  childHeapMb: number;
}

interface WikiStatusOptions {
  statusPath?: string;
  lockPath?: string;
  stopFile?: string;
  stop?: boolean;
  clearStop?: boolean;
}

function parseWikiIngestOptions(args: string[]): WikiCliIngestOptions {
  const out: WikiCliIngestOptions = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if (flag === "--index" && raw) out.indexPath = path.resolve(raw);
    else if (flag === "--max-pages" && Number.isFinite(num)) out.maxPages = Math.max(1, num);
    else if (flag === "--max-blocks" && Number.isFinite(num)) out.maxBlocks = Math.max(0, num);
    else if (flag === "--start-offset" && Number.isFinite(num)) out.startOffset = Math.max(0, Math.floor(num));
    else if (flag === "--memory-safety-bound-mb" && Number.isFinite(num)) out.memorySafetyBoundMb = Math.max(512, num);
    else if (flag === "--heap-checkpoint-mb" && Number.isFinite(num)) out.heapCheckpointMb = Math.max(128, num);
    else if (flag === "--status" && raw) out.statusPath = path.resolve(raw);
    else if (flag === "--lock" && raw) out.lockPath = path.resolve(raw);
    else if (flag === "--stop-file" && raw) out.stopFile = path.resolve(raw);
    else if (arg === "--fresh") out.fresh = true;
    else if (arg === "--no-resume") out.resume = false;
    else throw new Error(`unknown wiki ingest option: ${arg}`);
  }
  return out;
}

function parseWikiFirehoseOptions(args: string[]): WikiFirehoseOptions {
  const base = parseWikiIngestOptions(args.filter(arg => !arg.startsWith("--runner-max-segments=") && !arg.startsWith("--child-heap-mb=")));
  let runnerMaxSegments = 0;
  let childHeapMb = 1536;
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if (flag === "--runner-max-segments" && Number.isFinite(num)) runnerMaxSegments = Math.max(0, num);
    if (flag === "--child-heap-mb" && Number.isFinite(num)) childHeapMb = Math.max(512, num);
  }
  return { ...base, runnerMaxSegments, childHeapMb, heapCheckpointMb: base.heapCheckpointMb ?? Math.max(256, Math.floor(childHeapMb * 0.72)) };
}

function parseWikiStatusOptions(args: string[]): WikiStatusOptions {
  const out: WikiStatusOptions = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    if (flag === "--status" && raw) out.statusPath = path.resolve(raw);
    else if (flag === "--lock" && raw) out.lockPath = path.resolve(raw);
    else if (flag === "--stop-file" && raw) out.stopFile = path.resolve(raw);
    else if (arg === "--stop") out.stop = true;
    else if (arg === "--clear-stop") out.clearStop = true;
    else throw new Error(`unknown wiki status option: ${arg}`);
  }
  return out;
}

function wikiFirehosePaths(config: Awaited<ReturnType<typeof readScceRuntimeConfig>>, options: WikiStatusOptions): { root: string; statusPath: string; lockPath: string; stopFile: string } {
  const root = path.resolve(config.runtime.tempRoot, "wiki-firehose");
  return {
    root,
    statusPath: options.statusPath ?? path.join(root, "status.json"),
    lockPath: options.lockPath ?? path.join(root, "lock.json"),
    stopFile: options.stopFile ?? path.join(root, "stop.json")
  };
}

function wikiChildFlags(options: WikiFirehoseOptions, paths: { statusPath: string; lockPath: string; stopFile: string }, firstSegment: boolean): string[] {
  const flags: string[] = [`--status=${paths.statusPath}`, `--lock=${paths.lockPath}`, `--stop-file=${paths.stopFile}`, `--heap-checkpoint-mb=${options.heapCheckpointMb}`];
  if (options.indexPath) flags.push(`--index=${options.indexPath}`);
  if (options.maxPages !== undefined) flags.push(`--max-pages=${options.maxPages}`);
  if (options.maxBlocks !== undefined) flags.push(`--max-blocks=${options.maxBlocks}`);
  if (options.startOffset !== undefined) flags.push(`--start-offset=${options.startOffset}`);
  if (options.memorySafetyBoundMb !== undefined) flags.push(`--memory-safety-bound-mb=${options.memorySafetyBoundMb}`);
  if (options.fresh && firstSegment) flags.push("--fresh");
  if (options.resume === false && firstSegment) flags.push("--no-resume");
  return flags;
}

async function runChild(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: process.cwd(), stdio: "inherit", windowsHide: false });
    child.on("error", reject);
    child.on("close", code => resolve(code ?? 1));
  });
}

async function acquireWikiFirehoseLock(lockPath: string, target: string, statusPath: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const existing = await readJson<{ pid?: number; target?: string; statusPath?: string }>(lockPath);
  if (processIsAlive(existing?.pid)) throw new Error(`wiki firehose already running: pid=${existing?.pid} target=${existing?.target ?? "unknown"} status=${existing?.statusPath ?? statusPath}`);
  await writeJsonReplacing(lockPath, { pid: process.pid, target, statusPath, startedAt: Date.now() });
  return async () => {
    const current = await readJson<{ pid?: number }>(lockPath);
    if (current?.pid === process.pid) await unlink(lockPath).catch(() => undefined);
  };
}

function processIsAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonReplacing(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, filePath).catch(async error => {
    await unlink(filePath).catch(() => undefined);
    await rename(tmp, filePath).catch(async () => {
      await unlink(tmp).catch(() => undefined);
      throw error;
    });
  });
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function db(runtime: ReturnType<typeof createNodeRuntime>, args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === "init" || sub === "migrate") {
    await runtime.storage.migrate();
    printJson(runtime.storage.status ? await runtime.storage.status() : { ok: true });
    return;
  }
  if (sub === "status") {
    printJson(runtime.storage.status ? await runtime.storage.status() : { verify: await runtime.storage.verify(), stats: await runtime.storage.stats(), activeBrain: await runtime.storage.brainImports.active() });
    return;
  }
  if (sub === "reset") {
    if (!args.includes("--confirm-local-dev-only")) return usage("scce db reset --confirm-local-dev-only");
    if (!runtime.storage.resetLocalDevOnly) throw new Error("storage adapter does not expose local reset");
    printJson(await runtime.storage.resetLocalDevOnly({ confirmLocalDevOnly: true }));
    return;
  }
  if (sub === "verify") return printJson(await runtime.storage.verify());
  if (sub === "stats") return printJson(await runtime.storage.stats());
  return usage("scce db <status|init|migrate|verify|stats|reset --confirm-local-dev-only>");
}

async function inspect(runtime: ReturnType<typeof createNodeRuntime>, config: Awaited<ReturnType<typeof readScceRuntimeConfig>>, args: string[]): Promise<void> {
  const target = args[0] ?? "last";
  if (target === "v2-artifacts") {
    const artifactRoot = args[1];
    if (!artifactRoot) return usage("scce inspect v2-artifacts <copied-v2-root> [--max-depth=<n>] [--max-files=<n>] [--hash-work-extent-mb=<n>|--no-hashes]");
    printJson(await inspectV2Artifacts(path.resolve(artifactRoot), parseV2ArtifactInspectOptions(args.slice(2))));
    return;
  }
  if (target === "stream") {
    const streamPath = args[1];
    if (!streamPath) return usage("scce inspect stream <path>");
    printJson(await inspectV2Stream(path.resolve(streamPath), parseV2ArtifactInspectOptions(args.slice(2))));
    return;
  }
  if (target === "stream-topic") {
    const parsed = parseStreamTopicArgs(args.slice(1), config);
    if (!parsed.topic) return usage("scce inspect stream-topic <topic> [--path=<lookup-or-root>] [--index=<lookup>] [--root=<root>]");
    printJson(await inspectV2StreamTopic(parsed.topic, parsed.paths, { maxLookupBytes: parsed.maxLookupBytes }));
    return;
  }
  if (target === "graph-shard") {
    const filePath = args[1];
    if (!filePath) return usage("scce inspect graph-shard <file>");
    printJson(await inspectV2GraphShard(path.resolve(filePath), parseBoundedDecodeOptions(args.slice(2))));
    return;
  }
  if (target === "topic") {
    const parsed = parseTopicInspectArgs(args.slice(1));
    if (!parsed.topic) return usage("scce inspect topic <topic> [--question=<question>]");
    printJson(await inspectV2Topic(runtime.storage, parsed.topic, { question: parsed.question }));
    return;
  }
  if (target === "profile") {
    const filePath = args[1];
    if (!filePath) return usage("scce inspect profile <file>");
    printJson(await inspectV2Profile(path.resolve(filePath)));
    return;
  }
  if (target === "ngram") {
    const filePath = args[1];
    if (!filePath) return usage("scce inspect ngram <file>");
    printJson(await inspectV2Ngram(path.resolve(filePath), parseBoundedDecodeOptions(args.slice(2))));
    return;
  }
  if (target === "brain" && args[1] === "--import" && args[2]) {
    printJson(await runtime.kernel.inspect({ kind: "brain-import", importRunId: args[2] }));
    return;
  }
  if (target === "import" && args[1]) {
    printJson(await runtime.kernel.inspect({ kind: "brain-import", importRunId: args[1] }));
    return;
  }
  if (target === "source" && args[1]) {
    printJson(await inspectSourceVersion(runtime, args[1]));
    return;
  }
  if (target === "evidence" && args[1]) {
    const evidence = await runtime.storage.evidence.getEvidence(args[1] as never);
    const sourceVersions = evidence ? await runtime.storage.evidence.sourceVersionsForEvidence([evidence.id]) : [];
    printJson({ schema: "scce.inspect.evidence.v1", evidence, sourceVersions, found: Boolean(evidence) });
    return;
  }
  if (target === "trace" && args[1]) {
    printJson(await runtime.kernel.replay(args[1] as never));
    return;
  }
  printJson(await runtime.kernel.inspect(parseInspect(args)));
}

async function inspectSourceVersion(runtime: ReturnType<typeof createNodeRuntime>, sourceVersionId: string): Promise<unknown> {
  const storage = runtime.storage as unknown as {
    query?<T>(sql: string, params?: unknown[]): Promise<T[]>;
    table?(name: string): string;
  };
  if (storage.query && storage.table) {
    const rows = await storage.query<{
      id: string;
      source_id: string;
      namespace: string;
      canonical_uri: string;
      content_hash: string;
      media_type: string;
      observed_at: Date;
      byte_length: string;
      trust: string;
      metadata_json: unknown;
    }>(
      `SELECT sv.*, s.namespace, s.canonical_uri FROM ${storage.table("source_versions")} sv JOIN ${storage.table("sources")} s ON s.id=sv.source_id WHERE sv.id=$1`,
      [sourceVersionId]
    );
    return { schema: "scce.inspect.source_version.v1", found: rows.length > 0, sourceVersion: rows[0] ?? null };
  }
  return { schema: "scce.inspect.source_version.v1", found: false, sourceVersion: null, warning: "source lookup requires PostgreSQL adapter" };
}

function parseInspect(args: string[]): InspectionTarget {
  const value = args[0] ?? "last";
  if (value === "brain" && args[1] === "--import" && args[2]) return { kind: "brain-import", importRunId: args[2] };
  if (value === "last" || value === "graph" || value === "ingestion" || value === "codebase" || value === "model" || value === "self" || value === "snapshot" || value === "proofs" || value === "brain" || value === "language" || value === "graph-priors" || value === "language-memory" || value === "localization" || value === "corrections" || value === "math-spine") return value;
  return { kind: "episode", episodeId: value as never };
}

function parseArgs(argv: string[]): Parsed {
  const args = [...argv];
  let configPath = "scce.config.json";
  while (args[0]?.startsWith("--")) {
    const flag = args.shift();
    if (flag === "--config") configPath = args.shift() ?? configPath;
    else throw new Error(`unknown flag: ${flag}`);
  }
  return { configPath, command: args.shift(), args };
}

function parseTurnArgs(args: string[]): { text: string; webRequested: boolean; sessionId?: string; conversationId?: string; targetLanguage?: string; detailProfileId?: string } {
  const textParts: string[] = [];
  let webRequested = false;
  let sessionId: string | undefined;
  let conversationId: string | undefined;
  let targetLanguage: string | undefined;
  let detailProfileId: string | undefined;
  for (const arg of args) {
    if (arg === "--web") {
      webRequested = true;
      continue;
    }
    if (arg.startsWith("--session-id=")) {
      sessionId = requiredStringFlag(arg, "--session-id=");
      continue;
    }
    if (arg.startsWith("--conversation-id=")) {
      conversationId = requiredStringFlag(arg, "--conversation-id=");
      continue;
    }
    if (arg.startsWith("--target-language=")) {
      targetLanguage = requiredStringFlag(arg, "--target-language=");
      continue;
    }
    if (arg.startsWith("--detail=")) {
      const detail = requiredStringFlag(arg, "--detail=").toLocaleLowerCase();
      const profile = {
        brief: "surface.detail.profile.0",
        normal: "surface.detail.profile.1",
        detailed: "surface.detail.profile.2",
        stepwise: "surface.detail.profile.3"
      }[detail];
      if (!profile) throw new Error("turn detail must be brief, normal, detailed, or stepwise");
      detailProfileId = profile;
      continue;
    }
    if (arg.startsWith("--detail-profile=")) {
      detailProfileId = requiredStringFlag(arg, "--detail-profile=");
      continue;
    }
    if (arg.startsWith("--web-limit=")) {
      webRequested = true;
      positiveNumberFlag(arg, "--web-limit=");
      continue;
    }
    if (arg.startsWith("--web-max-pages=")) {
      webRequested = true;
      positiveNumberFlag(arg, "--web-max-pages=");
      continue;
    }
    if (arg.startsWith("--web-max-bytes=")) {
      webRequested = true;
      positiveNumberFlag(arg, "--web-max-bytes=");
      continue;
    }
    if (arg.startsWith("--web-min-evidence=")) {
      webRequested = true;
      positiveNumberFlag(arg, "--web-min-evidence=");
      continue;
    }
    if (arg.startsWith("--web-min-lcb=")) {
      webRequested = true;
      boundedNumberFlag(arg, "--web-min-lcb=", 0, 1);
      continue;
    }
    textParts.push(arg);
  }
  return { text: textParts.join(" ").trim(), webRequested, sessionId, conversationId, targetLanguage, detailProfileId };
}

function parseCorpusTrainOptions(args: string[]): {
  maxFiles?: number;
  maxFileBytes?: number;
  maxDepth?: number;
  includeDocs?: boolean;
  includeSource?: boolean;
  ngramMaxOrder?: number;
  ngramMaxCountersPerOrder?: number;
  ngramVocabularyLimit?: number;
} {
  const out: {
    maxFiles?: number;
    maxFileBytes?: number;
    maxDepth?: number;
    includeDocs?: boolean;
    includeSource?: boolean;
    ngramMaxOrder?: number;
    ngramMaxCountersPerOrder?: number;
    ngramVocabularyLimit?: number;
  } = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if ((flag === "--max-files" || flag === "--max-files-per-run" || flag === "--max-files-per-repo") && Number.isFinite(num)) out.maxFiles = Math.max(1, Math.floor(num));
    else if (flag === "--max-file-bytes" && Number.isFinite(num)) out.maxFileBytes = Math.max(1024, Math.floor(num));
    else if (flag === "--max-depth" && Number.isFinite(num)) out.maxDepth = Math.max(0, Math.floor(num));
    else if (flag === "--ngram-max-order" && Number.isFinite(num)) out.ngramMaxOrder = Math.max(1, Math.min(6, Math.floor(num)));
    else if (flag === "--ngram-max-counters" && Number.isFinite(num)) out.ngramMaxCountersPerOrder = Math.max(32, Math.floor(num));
    else if (flag === "--ngram-vocabulary-limit" && Number.isFinite(num)) out.ngramVocabularyLimit = Math.max(128, Math.floor(num));
    else if (arg === "--docs-only") {
      out.includeDocs = true;
      out.includeSource = false;
    } else if (arg === "--code-only") {
      out.includeDocs = false;
      out.includeSource = true;
    } else throw new Error(`unknown corpus train option: ${arg}`);
  }
  return out;
}

function requiredStringFlag(arg: string, prefix: string): string {
  const value = arg.slice(prefix.length).trim();
  if (!value) throw new Error(`invalid ${prefix.slice(0, -1)} value`);
  return value;
}

function positiveNumberFlag(arg: string, prefix: string): number {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid ${prefix.slice(0, -1)} value`);
  return value;
}

function boundedNumberFlag(arg: string, prefix: string, min: number, max: number): number {
  const value = Number(arg.slice(prefix.length));
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`invalid ${prefix.slice(0, -1)} value`);
  return value;
}

function usage(error?: string): void {
  if (error) process.stderr.write(`${error}\n\n`);
  process.stdout.write([
    "SCCE v3 CLI",
    "",
    "Commands:",
    "  pnpm scce db status",
    "  pnpm scce db init",
    "  pnpm scce db migrate",
    "  pnpm scce db reset --confirm-local-dev-only",
    "  pnpm scce db verify",
    "  pnpm scce db stats",
    "  pnpm scce hydrate plan <scce2-fixture-path>",
    "  pnpm scce hydrate import <scce2-fixture-path> --plan=<planId>",
    "  pnpm scce hydrate status [--status=<path>]",
    "  pnpm scce ingest <path-or-uri>",
    "  pnpm scce workspace init <path>",
    "  pnpm scce workspace ingest [path]",
    "  pnpm scce workspace ask <question>",
    `  pnpm ${WORKSPACE_CODE_USAGE}`,
    "    Alias: workspace code. Returns an unauthorized, unexecuted plan; it does not edit files or run checks.",
    "  pnpm scce project summary [path]",
    "  pnpm scce project map [path]",
    "  pnpm scce project symbols [path]",
    "  pnpm scce project gaps [path]",
    "  pnpm scce project contradictions [path]",
    "  pnpm scce project tasks [path]",
    "  pnpm scce brief [path]",
    "  pnpm scce patch-plan [path]",
    "  pnpm scce handoff [path]",
    "  pnpm scce review [path]",
    "  pnpm scce ingest wiki <dump-path> --index=<index-path>",
    "  pnpm scce ingest wiki firehose <dump-path>",
    "  pnpm scce ingest wiki status [--stop|--clear-stop]",
    "  pnpm scce codebase ingest <repo-or-folder-path>",
    "  pnpm scce corpus inspect <path>",
    "  pnpm scce corpus ingest --dry-run <path>",
    "  pnpm scce corpus route --fixture <path>",
    "  pnpm scce corpus train gutenberg <path>",
    "  pnpm scce corpus train oss <path>",
    "  pnpm scce repo inspect <path>",
    "  pnpm scce repo graph <path>",
    "  pnpm scce repo diagnostics --fixture <path>",
    "  pnpm scce repo plan --dry-run <path>",
    "  pnpm scce train <config>",
    "  pnpm scce turn <prompt> [--detail=brief|normal|detailed|stepwise]",
    "  pnpm scce inspect last",
    "  pnpm scce inspect brain",
    "  pnpm scce inspect brain --import <id>",
    "  pnpm scce inspect import <id>",
    "  pnpm scce inspect source <sourceVersionId>",
    "  pnpm scce inspect evidence <evidenceSpanId>",
    "  pnpm scce inspect trace <turnId>",
    "  pnpm scce inspect language",
    "  pnpm scce inspect graph-priors",
    "  pnpm scce inspect v2-artifacts <copied-v2-root>",
    "  pnpm scce inspect stream <path>",
    "  pnpm scce inspect stream-topic <topic> [--path=<lookup-or-root>]",
    "  pnpm scce inspect graph-shard <file>",
    "  pnpm scce inspect topic <topic> [--question=<question>]",
    "  pnpm scce inspect profile <file>",
    "  pnpm scce inspect ngram <file>",
    "  pnpm scce inspect self",
    "  pnpm scce inspect ingestion",
    "  pnpm scce inspect codebase",
    "  pnpm scce hygiene [language-control]",
    "  pnpm scce scce2 inspect <v2-path> [--summary-only] [--hash-work-extent-mb=<n>|--no-hashes] [--max-depth=<n>] [--max-files=<n>]",
    "  pnpm scce scce2 import <v2-path> --summary-only",
    "  pnpm scce scce2 import <v2-path> --heap-checkpoint-mb=<n> --status=<path> --stop-file=<path>",
    "  pnpm scce replay <episodeId>",
    "  pnpm scce benchmark <config>",
    "",
    "Config defaults to scce.config.json. SCCE_DATABASE_URL may override the complete PostgreSQL connection URL; other config values are read from the file."
  ].join("\n") + "\n");
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function previewText(value: string, maxChars = 600): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
