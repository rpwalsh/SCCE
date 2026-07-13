import http from "node:http";
import path from "node:path";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { assertHydratedRuntimeReady, createDockerSandboxPatchValidationProvider, createNodeRuntime, createWorkspaceRuntime, diagnoseDocumentTools, executeWorkspacePatchTransaction, resolveSecret, runStructuredPatchValidation, trustedHostPatchValidationProvider, WorkspacePatchTransactionError, type readScceRuntimeConfig, type StructuredPatchValidationPolicy, type StructuredPatchValidationProvider, type WorkspaceCodingPatchPlanningInput, type WorkspacePatchPlanningInput, type WorkspaceRuntimeOptions } from "@scce/adapters-node";
import type { BenchmarkInput, ConversationTurnRecord, IngestInput, InspectionTarget, JsonValue, OwnerInput, PatchTransactionPlan, TrainInput, TurnDialogueBridge, TurnResult } from "@scce/kernel";
import { CALIBRATION_TASK_CLASS_IDS, PATCH_TRANSACTION_PLAN_SCHEMA, buildDiscourseObjectState, buildTurnDialogueBridge, canonicalStringify, createAuditEngine, latestDialoguePragmaticsFromMemory, latestDialogueStyleProfile, loadCalibrationModelSet, persistDialogueOutcomeFromMemory, persistDialogueTurn, toJsonValue, traceEvent, verifyPatchTransactionPlan } from "@scce/kernel";
import { renderWorkbench } from "@scce/ui";

export interface ApiContext {
  runtime: ReturnType<typeof createNodeRuntime>;
  config: Awaited<ReturnType<typeof readScceRuntimeConfig>>;
  maxBodyBytes?: number;
  /** Optional server-owned remote isolation lane; never selected by request data. */
  patchValidation?: {
    readonly provider: StructuredPatchValidationProvider;
    readonly resolvePolicy: (policyId: string) => StructuredPatchValidationPolicy;
  };
}

type LoadedConfig = Awaited<ReturnType<typeof readScceRuntimeConfig>>;

export const ROUTES = [
  { method: "GET", path: "/", label: "workbench", mutates: false, requiresDb: false },
  { method: "GET", path: "/health", label: "health", mutates: false, requiresDb: true },
  { method: "GET", path: "/api/manifest", label: "api manifest", mutates: false, requiresDb: false },
  { method: "GET", path: "/api/brain/status", label: "brain status", mutates: false, requiresDb: true },
  { method: "GET", path: "/api/ready", label: "readiness", mutates: false, requiresDb: true },
  { method: "POST", path: "/api/db/init", label: "database initialize", mutates: true, requiresDb: true },
  { method: "POST", path: "/api/db/migrate", label: "database migrate", mutates: true, requiresDb: true },
  { method: "GET", path: "/api/db/verify", label: "database verify", mutates: false, requiresDb: true },
  { method: "GET", path: "/api/db/stats", label: "database stats", mutates: false, requiresDb: true },
  { method: "GET", path: "/api/tools", label: "tool diagnostics", mutates: false, requiresDb: false },
  { method: "GET", path: "/api/session/approvals", label: "session approvals", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/session/approve", label: "approve pending capability", mutates: true, requiresDb: false },
  { method: "POST", path: "/api/session/operator-grant", label: "toggle temporary operator grant", mutates: true, requiresDb: false },
  { method: "GET", path: "/api/connectors/quota", label: "connector quota", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/connectors/search", label: "web search", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/connectors/fetch", label: "web fetch", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/connectors/outlook/search", label: "outlook search mail", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/connectors/outlook/read", label: "outlook read mail", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/connectors/outlook/draft", label: "outlook create draft", mutates: true, requiresDb: false },
  { method: "POST", path: "/api/connectors/outlook/send", label: "outlook send draft", mutates: true, requiresDb: false },
  { method: "POST", path: "/api/connectors/outlook/calendar", label: "outlook read calendar", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/connectors/outlook/calendar/create", label: "outlook create calendar event", mutates: true, requiresDb: false },
  { method: "POST", path: "/api/connectors/outlook/contacts", label: "outlook read contacts", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/connectors/youtube/search", label: "youtube search", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/connectors/youtube/video", label: "youtube video metadata", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/connectors/youtube/channel", label: "youtube channel metadata", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/connectors/youtube/comments", label: "youtube comments", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/connectors/telephone/call", label: "telephone call", mutates: true, requiresDb: false },
  { method: "GET", path: "/api/config/public", label: "public config", mutates: false, requiresDb: false },
  { method: "POST", path: "/api/ingest", label: "ingest", mutates: true, requiresDb: true },
  { method: "POST", path: "/api/codebase/ingest", label: "codebase ingest", mutates: true, requiresDb: true },
  { method: "POST", path: "/api/workspace/init", label: "workspace initialize", mutates: true, requiresDb: true },
  { method: "POST", path: "/api/workspace/ingest", label: "workspace ingest", mutates: true, requiresDb: true },
  { method: "GET", path: "/api/workspace/sources", label: "workspace sources", mutates: false, requiresDb: true },
  { method: "POST", path: "/api/workspace/ask", label: "workspace ask", mutates: true, requiresDb: true },
  { method: "POST", path: "/api/workspace/outcome", label: "workspace answer outcome", mutates: true, requiresDb: true },
  { method: "POST", path: "/api/workspace/patch/plan", label: "workspace patch plan", mutates: false, requiresDb: true },
  { method: "POST", path: "/api/workspace/patch/plan/request", label: "workspace coding request plan", mutates: false, requiresDb: true },
  { method: "POST", path: "/api/workspace/patch", label: "workspace patch transaction", mutates: true, requiresDb: true },
  // These legacy GET handlers persist workspace/report records. The manifest
  // advertises that side effect so clients cannot mistake them for read-only.
  { method: "GET", path: "/api/project/summary", label: "project summary", mutates: true, requiresDb: true },
  { method: "GET", path: "/api/project/map", label: "project map", mutates: true, requiresDb: true },
  { method: "GET", path: "/api/project/symbols", label: "project symbols", mutates: true, requiresDb: true },
  { method: "GET", path: "/api/project/gaps", label: "project gaps", mutates: true, requiresDb: true },
  { method: "GET", path: "/api/project/contradictions", label: "project contradictions", mutates: true, requiresDb: true },
  { method: "GET", path: "/api/project/tasks", label: "project tasks", mutates: true, requiresDb: true },
  { method: "GET", path: "/api/reports/brief", label: "workspace brief", mutates: true, requiresDb: true },
  { method: "GET", path: "/api/reports/patch-plan", label: "workspace patch plan", mutates: true, requiresDb: true },
  { method: "GET", path: "/api/reports/handoff", label: "workspace handoff", mutates: true, requiresDb: true },
  { method: "GET", path: "/api/reports/review", label: "workspace review", mutates: true, requiresDb: true },
  { method: "POST", path: "/api/train", label: "train", mutates: true, requiresDb: true },
  { method: "POST", path: "/api/turn", label: "turn", mutates: true, requiresDb: true },
  { method: "POST", path: "/api/turn/outcome", label: "turn dialogue outcome", mutates: true, requiresDb: true },
  { method: "GET", path: "/api/turn/:id", label: "turn lookup", mutates: false, requiresDb: true },
  { method: "GET", path: "/api/inspect/brain", label: "inspect brain", mutates: false, requiresDb: true },
  { method: "GET", path: "/api/inspect/import/:id", label: "inspect import", mutates: false, requiresDb: true },
  { method: "GET", path: "/api/inspect", label: "inspect", mutates: false, requiresDb: true },
  { method: "GET", path: "/api/replay/:episodeId", label: "replay", mutates: false, requiresDb: true },
  { method: "POST", path: "/api/benchmark", label: "benchmark", mutates: true, requiresDb: true }
];

export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, context: ApiContext): Promise<void> {
  const requestId = req.headers["x-request-id"]?.toString() ?? randomUUID();
  const started = Date.now();
  const trace = (globalThis as any).__sccTrace;
  if (trace) traceEvent(trace, { stage: 'api.request', label: req.method + ' ' + (req.url ?? '/') });
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    assertAuthorizedRequest(req, url, context);
    const response = await dispatch(req, url, context);
    send(res, response.status, response.body, response.contentType, { requestId, started });
    if (trace) traceEvent(trace, { stage: 'api.response', label: `${response.status} ${req.method} ${req.url}`, durationMs: Date.now() - started });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const body = {
      ok: false,
      requestId,
      error: error instanceof Error ? error.message : String(error),
      status
    };
    send(res, status, JSON.stringify(body, null, 2), "application/json; charset=utf-8", { requestId, started });
    if (trace) traceEvent(trace, { stage: 'runtime.error', label: `${status} ${req.method} ${req.url}`, durationMs: Date.now() - started, warnings: [String(error)] });
  }
}

function assertAuthorizedRequest(req: http.IncomingMessage, url: URL, context: ApiContext): void {
  const route = routeFor(req.method ?? "GET", url.pathname);
  if (!requiresApiAuth(url.pathname, route)) return;
  if (isLocalRequest(req)) return;
  if (bearerAuthorized(req, context.config)) return;
  throw new HttpError(401, "authentication required for SCCE API route");
}

function requiresApiAuth(pathname: string, route: (typeof ROUTES)[number] | undefined): boolean {
  if (!pathname.startsWith("/api/")) return false;
  if (pathname === "/api/manifest" || pathname === "/api/ready" || pathname === "/api/config/public") return false;
  if (route?.mutates) return true;
  return pathname.startsWith("/api/db/")
    || pathname === "/api/tools"
    || pathname.startsWith("/api/connectors/")
    || pathname.startsWith("/api/session/")
    || pathname.startsWith("/api/workspace/")
    || pathname.startsWith("/api/project/")
    || pathname.startsWith("/api/reports/")
    || pathname.startsWith("/api/inspect")
    || pathname.startsWith("/api/replay/")
    || pathname.startsWith("/api/turn/");
}

function routeFor(method: string, pathname: string): (typeof ROUTES)[number] | undefined {
  return ROUTES.find(route => route.method === method && routePathMatches(route.path, pathname));
}

function routePathMatches(routePath: string, pathname: string): boolean {
  if (routePath === pathname) return true;
  const routeParts = routePath.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (routeParts.length !== pathParts.length) return false;
  return routeParts.every((part, index) => part.startsWith(":") || part === pathParts[index]);
}

function isLocalRequest(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/u, "") ?? "";
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

function bearerAuthorized(req: http.IncomingMessage, config: LoadedConfig): boolean {
  const expectedRaw = config.security?.apiBearerToken || process.env.SCCE_API_BEARER_TOKEN || "";
  if (!expectedRaw) return false;
  const supplied = authorizationBearer(req.headers.authorization);
  if (!supplied) return false;
  const expected = expectedRaw.startsWith("enc:v1:")
    ? resolveSecret(expectedRaw, config, "SCCE API bearer token")
    : expectedRaw;
  return timingSafeStringEqual(supplied, expected);
}

function authorizationBearer(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = /^Bearer\s+(.+)$/iu.exec(raw ?? "");
  return match?.[1]?.trim();
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function dispatch(req: http.IncomingMessage, url: URL, context: ApiContext): Promise<{ status: number; body: string; contentType: string }> {
  if (req.method === "GET" && url.pathname === "/") return html(renderWorkbench(context.config.server.url));
  if (req.method === "GET" && url.pathname === "/health") {
    const status = { verify: await context.runtime.storage.verify() };
    const ok = healthOk(status);
    return json({ ok, db: status, postgres: status.verify, serverUrl: context.config.server.url }, ok ? 200 : 503);
  }
  if (req.method === "GET" && url.pathname === "/api/manifest") return json({ routes: ROUTES, serverUrl: context.config.server.url });
  if (req.method === "GET" && url.pathname === "/api/brain/status") return json(await context.runtime.kernel.inspect("brain"));
  if (req.method === "GET" && url.pathname === "/api/ready") {
    const postgres = await context.runtime.storage.verify();
    const ok = healthOk(postgres);
    return json({ ok, postgres, serverUrl: context.config.server.url, manifest: ROUTES.length }, ok ? 200 : 503);
  }
  if (req.method === "POST" && url.pathname === "/api/db/init") {
    await context.runtime.storage.migrate();
    return json({ ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/db/migrate") {
    await context.runtime.storage.migrate();
    return json({ ok: true });
  }
  if (req.method === "GET" && url.pathname === "/api/db/verify") return json(await context.runtime.storage.verify());
  if (req.method === "GET" && url.pathname === "/api/db/stats") return json(await context.runtime.storage.stats());
  if (req.method === "GET" && url.pathname === "/api/tools") return json(await diagnoseDocumentTools(context.config));
  if (req.method === "GET" && url.pathname === "/api/session/approvals") return json(context.runtime.approvals.snapshot());
  if (req.method === "POST" && url.pathname === "/api/session/approve") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["planId"]);
    return json({ approved: context.runtime.approvals.approve(String(body.planId)), session: context.runtime.approvals.snapshot() });
  }
  if (req.method === "POST" && url.pathname === "/api/session/operator-grant") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["enabled"]);
    return json(context.runtime.approvals.setTemporaryOperatorGrant(Boolean(body.enabled)));
  }
  if (req.method === "GET" && url.pathname === "/api/connectors/quota") return json(context.runtime.connectors.audit());
  if (req.method === "POST" && url.pathname === "/api/connectors/search") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["query"]);
    return json(await context.runtime.connectors.search(String(body.query), Number(body.limit ?? 10)));
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/fetch") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["uri"]);
    const fetched = await context.runtime.connectors.fetch(String(body.uri));
    return json({ ...fetched, bytes: { byteLength: fetched.bytes.byteLength, previewUtf8: new TextDecoder().decode(fetched.bytes.slice(0, 4096)) } });
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/outlook/search") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["query"]);
    return json(await context.runtime.connectors.outlookSearch(String(body.query), Number(body.limit ?? 25)));
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/outlook/read") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["messageId"]);
    return json(await context.runtime.connectors.outlookReadMessage(String(body.messageId)));
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/outlook/draft") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["to", "subject", "body"]);
    const input = { to: stringArray(body.to), subject: String(body.subject), body: String(body.body), cc: body.cc ? stringArray(body.cc) : undefined };
    if (!approved(context, "outlook.create_draft", input)) return pendingApproval(context, "outlook.create_draft", input);
    return json(await context.runtime.connectors.outlookCreateDraft({ ...input, approved: true }));
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/outlook/send") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["messageId"]);
    const input = { messageId: String(body.messageId) };
    if (!approved(context, "outlook.send_mail", input)) return pendingApproval(context, "outlook.send_mail", input);
    return json(await context.runtime.connectors.outlookSendDraft(input.messageId, true));
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/outlook/calendar") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["start", "end"]);
    return json(await context.runtime.connectors.outlookReadCalendar({ start: String(body.start), end: String(body.end) }));
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/outlook/calendar/create") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["subject", "start", "end"]);
    const input = { subject: String(body.subject), start: String(body.start), end: String(body.end), attendees: body.attendees ? stringArray(body.attendees) : undefined, body: body.body ? String(body.body) : undefined };
    if (!approved(context, "outlook.create_calendar_event", input)) return pendingApproval(context, "outlook.create_calendar_event", input);
    return json(await context.runtime.connectors.outlookCreateCalendarEvent({ ...input, approved: true }));
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/outlook/contacts") {
    const body = await readBody(req, context.maxBodyBytes);
    if (!isRecord(body)) throw new HttpError(400, "contacts body must be an object");
    return json(await context.runtime.connectors.outlookReadContacts(typeof body.query === "string" ? body.query : undefined));
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/youtube/search") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["query"]);
    return json(await context.runtime.connectors.youtubeSearch(String(body.query), Number(body.limit ?? 10)));
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/youtube/video") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["videoId"]);
    return json(await context.runtime.connectors.youtubeVideo(String(body.videoId)));
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/youtube/channel") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["channelId"]);
    return json(await context.runtime.connectors.youtubeChannel(String(body.channelId)));
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/youtube/comments") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["videoId"]);
    return json(await context.runtime.connectors.youtubeComments(String(body.videoId), Number(body.limit ?? 50)));
  }
  if (req.method === "POST" && url.pathname === "/api/connectors/telephone/call") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["to", "twiml"]);
    const input = { to: String(body.to), twiml: String(body.twiml) };
    if (!approved(context, "telephone.call", input)) return pendingApproval(context, "telephone.call", input);
    return json(await context.runtime.connectors.telephoneCall(input.to, input.twiml, true));
  }
  if (req.method === "GET" && url.pathname === "/api/config/public") return json(publicConfig(context.config));
  if (req.method === "POST" && url.pathname === "/api/ingest") return json(await context.runtime.kernel.ingest(validateIngest(await readBody(req, context.maxBodyBytes))));
  if (req.method === "POST" && url.pathname === "/api/codebase/ingest") return json(await context.runtime.kernel.ingest(validateCodebaseIngest(await readBody(req, context.maxBodyBytes))));
  if (req.method === "POST" && url.pathname === "/api/workspace/init") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["path"]);
    return json(await createWorkspaceRuntime(context).init(String(body.path), workspaceOptions(body)));
  }
  if (req.method === "POST" && url.pathname === "/api/workspace/ingest") {
    const body = await readBody(req, context.maxBodyBytes);
    if (!isRecord(body)) throw new HttpError(400, "workspace ingest body must be an object");
    return json(await createWorkspaceRuntime(context).ingest(typeof body.path === "string" ? body.path : undefined, workspaceOptions(body)));
  }
  if (req.method === "GET" && url.pathname === "/api/workspace/sources") {
    const workspace = await context.runtime.storage.workspace.latestWorkspace();
    if (!workspace) return json({ workspace: null, sources: [] });
    return json({ workspace, sources: await context.runtime.storage.workspace.listSourceFiles({ workspaceId: workspace.id, limit: numberParam(url, "limit", 10000) }) });
  }
  if (req.method === "POST" && url.pathname === "/api/workspace/ask") {
    const body = requireFields(await readBody(req, context.maxBodyBytes), ["question"]);
    return json(await createWorkspaceRuntime(context).answer(String(body.question), typeof body.path === "string" ? body.path : undefined, workspaceOptions(body)));
  }
  if (req.method === "POST" && url.pathname === "/api/workspace/outcome") {
    const body = await readBody(req, context.maxBodyBytes);
    if (!isRecord(body)) throw new HttpError(400, "workspace outcome body must be an object");
    const status = body.status;
    if (status !== "accepted" && status !== "rejected" && status !== "corrected") throw new HttpError(400, "workspace outcome requires status accepted|rejected|corrected");
    return json(await createWorkspaceRuntime(context).recordOutcome({
      status,
      correctionText: typeof body.correctionText === "string" ? body.correctionText : undefined,
      reportId: typeof body.reportId === "string" ? body.reportId : undefined,
      conversationId: typeof body.conversationId === "string" ? body.conversationId : undefined,
      promptText: typeof body.promptText === "string" ? body.promptText : undefined
    }, typeof body.path === "string" ? body.path : undefined, workspaceOptions(body)));
  }
  if (req.method === "POST" && url.pathname === "/api/workspace/patch/plan") {
    const request = parseWorkspacePatchPlanRequest(await readBody(req, context.maxBodyBytes));
    return json(await planWorkspacePatchApiRequest(context, request));
  }
  if (req.method === "POST" && url.pathname === "/api/workspace/patch/plan/request") {
    const request = parseWorkspaceCodingPatchPlanRequest(await readBody(req, context.maxBodyBytes));
    return json(await planWorkspaceCodingPatchApiRequest(context, request));
  }
  if (req.method === "POST" && url.pathname === "/api/workspace/patch") {
    if (context.config.policy.allowMutation !== true) throw new HttpError(403, "workspace patch application is disabled by config.policy.allowMutation");
    const request = parseWorkspacePatchRequest(await readBody(req, context.maxBodyBytes));
    const workspace = await context.runtime.storage.workspace.latestWorkspace();
    if (!workspace) throw new HttpError(409, "workspace patch requires an initialized workspace");
    if (workspace.id !== request.workspaceId) throw new HttpError(409, "workspaceId does not identify the latest initialized workspace");
    const policy = context.patchValidation?.resolvePolicy(request.validationPolicyId)
      ?? serverPatchValidationPolicy(context.config, request.validationPolicyId);
    const provider = context.patchValidation?.provider ?? trustedHostPatchValidationProvider;
    const approvalInput = {
      workspaceId: request.workspaceId,
      planHash: request.plan.planHash,
      validationPolicyId: request.validationPolicyId,
      validationBinding: workspacePatchValidationApprovalBinding(policy, provider)
    };
    if (!approved(context, "workspace.patch.apply", approvalInput)) return pendingApproval(context, "workspace.patch.apply", approvalInput);
    return json(await executeWorkspacePatchApiRequest({
      request,
      workspace,
      allowedRoots: context.config.runtime.allowedRoots,
      policy,
      provider
    }));
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/project/")) {
    const project = await createWorkspaceRuntime(context).project(url.searchParams.get("path") ?? undefined, workspaceOptionsFromUrl(url));
    const target = url.pathname.slice("/api/project/".length);
    if (target === "summary") return json({ schema: "scce.project.summary.v1", workspace: project.workspace, summary: project.summary });
    if (target === "map") return json({ schema: "scce.project.map.v1", workspace: project.workspace, map: project.map });
    if (target === "symbols") return json({ schema: "scce.project.symbols.v1", workspace: project.workspace, symbols: project.symbols });
    if (target === "gaps") return json({ schema: "scce.project.gaps.v1", workspace: project.workspace, gaps: project.gaps });
    if (target === "contradictions") return json({ schema: "scce.project.contradictions.v1", workspace: project.workspace, contradictions: project.contradictions });
    if (target === "tasks") return json({ schema: "scce.project.tasks.v1", workspace: project.workspace, tasks: project.tasks });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/reports/")) {
    const runtime = createWorkspaceRuntime(context);
    const target = url.pathname.slice("/api/reports/".length);
    if (target === "brief") return json(await runtime.report("brief", url.searchParams.get("path") ?? undefined, workspaceOptionsFromUrl(url)));
    if (target === "patch-plan") return json(await runtime.report("patch_plan", url.searchParams.get("path") ?? undefined, workspaceOptionsFromUrl(url)));
    if (target === "handoff") return json(await runtime.report("handoff", url.searchParams.get("path") ?? undefined, workspaceOptionsFromUrl(url)));
    if (target === "review") return json(await runtime.report("review", url.searchParams.get("path") ?? undefined, workspaceOptionsFromUrl(url)));
  }
  if (req.method === "POST" && url.pathname === "/api/train") return json(await context.runtime.kernel.train(validateTrain(await readBody(req, context.maxBodyBytes))));
  if (req.method === "POST" && url.pathname === "/api/turn") {
    const trace = (globalThis as any).__sccTrace;
    const turnStarted = Date.now();
    try {
      const body = await readBody(req, context.maxBodyBytes);
      const turn = validateTurn(body);
      const sessionId = conversationSessionId(body);
      const conversationId = dialogueConversationId(body, sessionId);
      await assertSurfaceLanguageReady(context, turn.text);
      const recentTurns = sessionId
        ? await context.runtime.storage.conversation.listTurns({ sessionId, limit: conversationContextLimit(body) })
        : [];
      const recentTurnsForMetadata = recentTurns.map(conversationTurnForMetadata);
      const recentEvidenceIds = uniqueServerStrings(recentTurns.flatMap(record => record.evidenceIds.map(String)));
      const discourseObject = sessionId
        ? buildDiscourseObjectState({ sessionId, currentText: turn.text, recentTurns: recentTurnsForMetadata, now: Date.now() })
        : undefined;
      const sparseSessionFollowup = Boolean(discourseObject) && recentEvidenceIds.length > 0 && !sourceSurfaceStrongEnough(turn.text);
      const active = await assertHydratedRuntimeReady(context.runtime.storage);
      const webRequested = webLearningRequested(body);
      const learnedDialogueProfile = await latestDialogueStyleProfile(context.runtime.storage.dialogueMemory, conversationId);
      const previousDialogue = await latestDialoguePragmaticsFromMemory(context.runtime.storage.dialogueMemory, { conversationId });
      traceEvent(trace, { stage: "turn.input", label: "api.turn", input: previewText(turn.text), counts: { textChars: turn.text.length } });
      traceEvent(trace, { stage: "turn.runtime.start", label: "api.turn" });
      const originalMetadata = isRecord(turn.metadata) ? turn.metadata as Record<string, JsonValue> : {};
      const originalRuntime = isRecord(originalMetadata.runtime) ? originalMetadata.runtime as Record<string, JsonValue> : {};
      const originalDialogue = isRecord(originalMetadata.dialogue) ? originalMetadata.dialogue as Record<string, JsonValue> : {};
      const fastLocalEvidenceAnswer = originalMetadata.fastLocalEvidenceAnswer === true
        || originalRuntime.fastLocalEvidenceAnswer === true
        || url.searchParams.get("fast") === "1";
      const discourseEvidenceIds = discourseObject ? uniqueServerStrings(discourseObject.evidenceIds) : [];
      const runtimeEvidenceIds = uniqueServerStrings([
        ...optionalStringArray(originalMetadata.runtimeEvidenceIds),
        ...optionalStringArray(originalMetadata.evidenceIds),
        ...discourseEvidenceIds,
        ...(sparseSessionFollowup ? recentEvidenceIds : [])
      ]);
      const turnInput = {
        ...turn,
        metadata: {
          ...originalMetadata,
          ...(sparseSessionFollowup ? { sessionContextEvidence: true } : {}),
          runtime: {
            ...originalRuntime,
            ...(fastLocalEvidenceAnswer ? { fastLocalEvidenceAnswer: true } : {}),
            ...(sparseSessionFollowup ? { sessionContextEvidence: true } : {})
          },
          runtimeEvidenceIds,
          dialogue: {
            ...originalDialogue,
            ...(previousDialogue ? { previousState: toJsonValue(previousDialogue.result.state) } : {})
          },
          ...(sessionId ? { session: { sessionId, recentTurns: recentTurnsForMetadata } } : {}),
          ...(discourseObject ? { discourse: { schema: "scce.discourse_runtime_state.v1", activeObject: toJsonValue(discourseObject), queryConcatenationUsed: false } } : {}),
          runtimePath: { hydratedRuntime: true, serverPath: true, sourceOnlySimulation: false },
          activeBrainVersion: active.activeBrainVersion,
          activeImportRunIds: active.activeImportRunIds
        }
      };
      const result = await context.runtime.kernel.turn(turnInput);
      if (!turnAnswerHasSpeech(result.answer)) throw new HttpError(500, "runtime produced no answer surface");
      const calibrationModels = await loadCalibrationModelSet({
        store: context.runtime.storage.dialogueMemory,
        minPoints: 2,
        createdAt: Date.now()
      });
      const dialogue = buildTurnDialogueBridge({
        requestText: turn.text,
        result,
        conversationId,
        turnId: String(result.episodeId),
        targetLanguage: turnTargetLanguage(body),
        userStyleProfile: learnedDialogueProfile,
        calibrationModels,
        calibrationTaskClass: CALIBRATION_TASK_CLASS_IDS.dialogueOutcome
      });
      await persistDialogueTurn({
        store: context.runtime.storage.dialogueMemory,
        result: dialogue.pragmatics,
        answerGraphHash: dialogue.answerGraphHash,
        now: Date.now()
      });
      traceEvent(trace, {
        stage: "turn.runtime.end",
        label: "api.turn",
        durationMs: Date.now() - turnStarted,
        counts: {
          evidence: result.evidence.length,
          artifacts: result.emissionGraph.artifacts.length
        }
      });
      traceEvent(trace, {
        stage: "turn.output",
        label: "api.turn",
        output: previewText(result.answer),
        counts: {
          answerChars: result.answer.length,
          evidence: result.evidence.length,
          artifacts: result.emissionGraph.artifacts.length
        }
      });
      const sessionAudit = sessionId
        ? await persistConversationTurnPair(context, sessionId, turn, result)
        : undefined;
      const webLearning = webRequested
        ? { schema: "scce.web_learning.disabled.v1", enabled: false, triggered: false, disabledReason: "local_mouth_focus" }
        : undefined;
      const turnResponse = url.searchParams.get("full") === "1" ? result : compactTurnResult(result);
      const dialogueResponse = compactTurnDialogue(dialogue);
      const baseResponse = { ...turnResponse, dialogue: dialogueResponse };
      return json(webLearning ? { ...baseResponse, webLearning, session: sessionAudit } : sessionAudit ? { ...baseResponse, session: sessionAudit } : baseResponse);
    } catch (error) {
      traceEvent(trace, { stage: "turn.error", label: "api.turn", durationMs: Date.now() - turnStarted, warnings: [String(error)] });
      throw error;
    }
  }
  if (req.method === "POST" && url.pathname === "/api/turn/outcome") {
    const body = await readBody(req, context.maxBodyBytes);
    if (!isRecord(body)) throw new HttpError(400, "turn outcome body must be an object");
    const status = body.status;
    if (status !== "accepted" && status !== "rejected" && status !== "corrected") throw new HttpError(400, "turn outcome requires status accepted|rejected|corrected");
    const conversationId = typeof body.conversationId === "string" && body.conversationId.trim() ? body.conversationId.trim() : undefined;
    if (!conversationId) throw new HttpError(400, "turn outcome requires conversationId");
    const turnId = typeof body.turnId === "string" && body.turnId.trim()
      ? body.turnId.trim()
      : typeof body.episodeId === "string" && body.episodeId.trim()
        ? body.episodeId.trim()
        : undefined;
    const learned = await persistDialogueOutcomeFromMemory({
      store: context.runtime.storage.dialogueMemory,
      conversationId,
      turnId,
      promptText: typeof body.promptText === "string" ? body.promptText : typeof body.text === "string" ? body.text : "turn outcome",
      accepted: status === "accepted",
      rejected: status === "rejected",
      corrected: status === "corrected",
      correctionText: typeof body.correctionText === "string" ? body.correctionText : undefined,
      now: Date.now()
    });
    return json({
      schema: "scce.turn.dialogue_outcome.v1",
      conversationId: learned.replay.conversationId,
      turnId: learned.replay.turnId,
      outcomeId: learned.outcome.id,
      styleSnapshotId: learned.learning.snapshot.id,
      calibrationObservationIds: learned.calibrationObservations.map(observation => observation.id),
      correctionId: learned.correction?.id,
      reversible: true
    });
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/turn/")) return json(await context.runtime.kernel.replay(decodeURIComponent(path.basename(url.pathname)) as never));
  if (req.method === "GET" && url.pathname === "/api/inspect/brain") return json(await context.runtime.kernel.inspect("brain"));
  if (req.method === "GET" && url.pathname.startsWith("/api/inspect/import/")) return json(await context.runtime.kernel.inspect({ kind: "brain-import", importRunId: decodeURIComponent(path.basename(url.pathname)) }));
  if (req.method === "GET" && url.pathname === "/api/inspect") return json(await context.runtime.kernel.inspect(parseInspect(url.searchParams.get("target") ?? "last")));
  if (req.method === "GET" && url.pathname.startsWith("/api/replay/")) return json(await context.runtime.kernel.replay(decodeURIComponent(path.basename(url.pathname)) as never));
  if (req.method === "POST" && url.pathname === "/api/benchmark") return json(await context.runtime.kernel.benchmark(validateBenchmark(await readBody(req, context.maxBodyBytes))));
  throw new HttpError(404, `not_found: ${req.method ?? "GET"} ${url.pathname}`);
}

function validateIngest(value: unknown): IngestInput {
  if (!isRecord(value)) throw new HttpError(400, "ingest body must be an object");
  const input: IngestInput = {};
  if (value.path !== undefined) input.path = boundedString(value.path, "path", 4096);
  if (value.uri !== undefined) input.uri = boundedString(value.uri, "uri", 4096);
  if (value.namespace !== undefined) input.namespace = boundedString(value.namespace, "namespace", 256);
  if (value.mediaType !== undefined) input.mediaType = boundedString(value.mediaType, "mediaType", 256);
  if (value.content !== undefined) input.content = boundedString(value.content, "content", 8 * 1024 * 1024);
  if (value.metadata !== undefined) input.metadata = validateJsonValue(value.metadata, "metadata");
  if (!input.path && !input.uri && input.content === undefined) throw new HttpError(400, "ingest requires path, uri, or content");
  return input;
}

function validateCodebaseIngest(value: unknown): IngestInput {
  if (!isRecord(value) || typeof value.path !== "string" || !value.path.trim()) throw new HttpError(400, "codebase ingest requires { path }");
  return { path: value.path, metadata: { ...(isRecord(value.metadata) ? value.metadata as Record<string, JsonValue> : {}), sourceKind: "developer_intelligence", ingestionLane: "codebase" } };
}

function workspaceOptions(value: Record<string, unknown>): WorkspaceRuntimeOptions {
  return {
    maxFiles: finiteOption(value.maxFiles, 1),
    maxFileBytes: finiteOption(value.maxFileBytes, 1024),
    maxDepth: finiteOption(value.maxDepth, 0),
    maxDocumentBytes: finiteOption(value.maxDocumentBytes, 4096),
    includeUnsupported: typeof value.includeUnsupported === "boolean" ? value.includeUnsupported : undefined,
    conversationId: typeof value.conversationId === "string" ? value.conversationId : undefined,
    targetLanguage: typeof value.targetLanguage === "string" ? value.targetLanguage : undefined,
    useKernelAnswer: typeof value.useKernelAnswer === "boolean" ? value.useKernelAnswer : undefined
  };
}

function workspaceOptionsFromUrl(url: URL): WorkspaceRuntimeOptions {
  return {
    maxFiles: numberParam(url, "maxFiles"),
    maxFileBytes: numberParam(url, "maxFileBytes"),
    maxDepth: numberParam(url, "maxDepth"),
    maxDocumentBytes: numberParam(url, "maxDocumentBytes"),
    includeUnsupported: url.searchParams.has("includeUnsupported") ? url.searchParams.get("includeUnsupported") !== "false" : undefined,
    conversationId: url.searchParams.get("conversationId") ?? undefined,
    targetLanguage: url.searchParams.get("targetLanguage") ?? undefined,
    useKernelAnswer: url.searchParams.has("useKernelAnswer") ? url.searchParams.get("useKernelAnswer") !== "false" : undefined
  };
}

function finiteOption(value: unknown, min: number): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? Math.max(min, number) : undefined;
}

function numberParam(url: URL, key: string, fallback?: number): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function validateTrain(value: unknown): TrainInput {
  if (!isRecord(value) || !isRecord(value.config)) throw new HttpError(400, "train requires { config }");
  const config = value.config;
  return {
    config: {
      learningGoals: config.learningGoals === undefined ? undefined : boundedStringArray(config.learningGoals, "config.learningGoals", 64, 512),
      programPatterns: config.programPatterns === undefined ? undefined : boundedJsonArray(config.programPatterns, "config.programPatterns", 128),
      promotion: config.promotion === undefined ? undefined : validatePromotion(config.promotion),
      policy: config.policy === undefined ? undefined : validatePolicyPatch(config.policy),
      metadata: config.metadata === undefined ? undefined : validateJsonValue(config.metadata, "config.metadata")
    }
  };
}

function validateTurn(value: unknown): OwnerInput {
  if (!isRecord(value) || typeof value.text !== "string" || !value.text.trim()) throw new HttpError(400, "turn requires non-empty text");
  return {
    text: boundedString(value.text, "text", 20000),
    metadata: value.metadata === undefined ? undefined : validateJsonValue(value.metadata, "metadata")
  };
}

function conversationSessionId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const raw = typeof value.sessionId === "string"
    ? value.sessionId
    : isRecord(value.metadata) && typeof value.metadata.sessionId === "string"
      ? value.metadata.sessionId
      : undefined;
  const sessionId = raw?.trim();
  if (!sessionId) return undefined;
  if (sessionId.length > 256) throw new HttpError(400, "sessionId is too long");
  return sessionId;
}

function dialogueConversationId(value: unknown, sessionId?: string): string {
  if (!isRecord(value)) return sessionId ?? "conversation.default";
  const raw = typeof value.conversationId === "string"
    ? value.conversationId
    : isRecord(value.metadata) && typeof value.metadata.conversationId === "string"
      ? value.metadata.conversationId
      : sessionId;
  const conversationId = raw?.trim();
  if (!conversationId) return "conversation.default";
  if (conversationId.length > 256) throw new HttpError(400, "conversationId is too long");
  return conversationId;
}

function turnTargetLanguage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const raw = typeof value.targetLanguage === "string"
    ? value.targetLanguage
    : typeof metadata.targetLanguage === "string"
      ? metadata.targetLanguage
      : typeof metadata.targetLanguageId === "string"
        ? metadata.targetLanguageId
        : typeof metadata.locale === "string"
          ? metadata.locale
          : undefined;
  const target = raw?.trim();
  return target || undefined;
}

function conversationContextLimit(value: unknown): number {
  if (!isRecord(value)) return 24;
  const raw = value.sessionContextLimit ?? value.contextTurns;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(parsed)) return 24;
  return Math.max(0, Math.min(64, Math.floor(parsed)));
}

function sourceSurfaceStrongEnough(text: string): boolean {
  const words = unicodeWords(text);
  let casedRun = 0;
  let longUnits = 0;
  let adjacentLongUnits = 0;
  let previousUnitLength = 0;
  for (const word of words) {
    const length = [...word].length;
    if (hasUncasedLetter(word)) return true;
    if (length >= 8) return true;
    if (previousUnitLength >= 3 && length >= 3 && previousUnitLength + length >= 11) return true;
    previousUnitLength = length;
    if (length >= 4) {
      longUnits++;
      adjacentLongUnits++;
    } else {
      adjacentLongUnits = 0;
    }
    if (hasUppercaseLetter(word)) casedRun++;
    else casedRun = 0;
    if (casedRun >= 2 || adjacentLongUnits >= 2 || longUnits >= 3) return true;
  }
  return false;
}

function unicodeWords(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of text.normalize("NFKC")) {
    if (/\p{L}|\p{N}/u.test(char)) {
      current += char;
      continue;
    }
    if (current) out.push(current);
    current = "";
  }
  if (current) out.push(current);
  return out;
}

async function assertSurfaceLanguageReady(context: ApiContext, text: string): Promise<void> {
  const languageHint = surfaceLanguageHint(text);
  if (!languageHint || surfaceLanguageMayUseGeneralMemory(languageHint)) return;
  const models = await context.runtime.storage.languageMemory.listNgramModels({ languageHint, limit: 1 });
  if (models.length > 0) return;
  throw new HttpError(503, "runtime has no trained language memory for requested script");
}

function surfaceLanguageHint(text: string): string | undefined {
  const counts = new Map<string, number>();
  for (const char of text.normalize("NFKC")) {
    const script = surfaceScriptOfChar(char);
    if (!script || script === "script:Common" || script === "script:Number") continue;
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [script, count] of counts) {
    if (count <= bestCount) continue;
    best = script;
    bestCount = count;
  }
  if (!best) return undefined;
  return `script:${best};direction:${surfaceDirectionForScript(best)}`;
}

function surfaceLanguageMayUseGeneralMemory(languageHint: string): boolean {
  return languageHint.includes("script:Latn");
}

function surfaceDirectionForScript(script: string): "ltr" | "rtl" {
  return script === "script:Arab" || script === "script:Hebr" ? "rtl" : "ltr";
}

function surfaceScriptOfChar(char: string): string | undefined {
  if (/\p{Script=Latin}/u.test(char)) return "script:Latn";
  if (/\p{Script=Hangul}/u.test(char)) return "script:Hang";
  if (/\p{Script=Han}/u.test(char)) return "script:Hani";
  if (/\p{Script=Hiragana}/u.test(char)) return "script:Hira";
  if (/\p{Script=Katakana}/u.test(char)) return "script:Kana";
  if (/\p{Script=Arabic}/u.test(char)) return "script:Arab";
  if (/\p{Script=Hebrew}/u.test(char)) return "script:Hebr";
  if (/\p{Script=Cyrillic}/u.test(char)) return "script:Cyrl";
  if (/\p{Script=Devanagari}/u.test(char)) return "script:Deva";
  if (/\p{Script=Thai}/u.test(char)) return "script:Thai";
  if (/\p{Script=Greek}/u.test(char)) return "script:Grek";
  if (/\p{N}/u.test(char)) return "script:Number";
  if (/\p{L}/u.test(char)) return "script:Other";
  return undefined;
}

function hasUppercaseLetter(text: string): boolean {
  for (const char of text) {
    if (char.toLocaleLowerCase() !== char.toLocaleUpperCase() && char === char.toLocaleUpperCase() && char !== char.toLocaleLowerCase()) return true;
  }
  return false;
}

function hasUncasedLetter(text: string): boolean {
  let letters = 0;
  let cased = 0;
  for (const char of text) {
    const lower = char.toLocaleLowerCase();
    const upper = char.toLocaleUpperCase();
    if (lower === upper) continue;
    letters++;
    if (char === lower || char === upper) cased++;
  }
  return letters > 0 && cased === 0;
}

function conversationTurnForMetadata(record: ConversationTurnRecord): JsonValue {
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  return {
    id: record.id,
    sessionId: record.sessionId,
    episodeId: String(record.episodeId),
    turnIndex: record.turnIndex,
    roleId: record.roleId,
    text: record.text,
    evidenceIds: record.evidenceIds.map(String),
    sourceVersionIds: optionalStringArray(metadata.sourceVersionIds),
    createdAt: record.createdAt
  };
}

async function persistConversationTurnPair(context: ApiContext, sessionId: string, turn: OwnerInput, result: TurnResult): Promise<JsonValue> {
  const createdAt = Date.now();
  const owner: ConversationTurnRecord = {
    id: conversationTurnId(sessionId, result.episodeId, "session.role.owner", createdAt * 10, turn.text),
    sessionId,
    episodeId: result.episodeId,
    turnIndex: createdAt * 10,
    roleId: "session.role.owner",
    text: turn.text,
    evidenceIds: [],
    metadata: conversationStoredMetadata(turn.metadata),
    createdAt
  };
  const assistant: ConversationTurnRecord = {
    id: conversationTurnId(sessionId, result.episodeId, "session.role.assistant", createdAt * 10 + 1, result.answer),
    sessionId,
    episodeId: result.episodeId,
    turnIndex: createdAt * 10 + 1,
    roleId: "session.role.assistant",
    text: result.answer,
    evidenceIds: result.evidence.map(span => span.id),
    metadata: {
      schema: "scce.conversation_turn.assistant.v1",
      assistantForce: result.assistantForce ?? null,
      epistemicForce: result.epistemicForce,
      sourceVersionIds: uniqueServerStrings(result.evidence.map(span => String(span.sourceVersionId))),
      discourseObject: result.discourseObject ?? null
    },
    createdAt: createdAt + 1
  };
  await context.runtime.storage.conversation.putTurn(owner);
  await context.runtime.storage.conversation.putTurn(assistant);
  return {
    schema: "scce.session_context.v1",
    sessionId,
    storedTurns: 2,
    ownerTurnId: owner.id,
    assistantTurnId: assistant.id,
    contextEvidence: result.evidence.filter(span => String(span.id).startsWith("evidence_session_")).length
  };
}

function conversationTurnId(sessionId: string, episodeId: unknown, roleId: string, turnIndex: number, text: string): string {
  const hash = createHash("sha256").update(`${sessionId}\n${String(episodeId)}\n${roleId}\n${turnIndex}\n${text}`).digest("hex");
  return `conversation_turn_${hash.slice(0, 48)}`;
}

function conversationStoredMetadata(metadata: JsonValue | undefined): JsonValue {
  const record = isRecord(metadata) ? { ...metadata as Record<string, JsonValue> } : {};
  delete record.session;
  return { schema: "scce.conversation_turn.owner.v1", metadata: record };
}

function webLearningRequested(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.web === true || (isRecord(value.webLearning) && value.webLearning.enabled === true);
}

function validateBenchmark(value: unknown): BenchmarkInput {
  if (!isRecord(value)) throw new HttpError(400, "benchmark body must be an object");
  const tasks = value.tasks === undefined ? undefined : validateBenchmarkTasks(value.tasks, "tasks");
  const config = value.config === undefined ? undefined : validateBenchmarkConfig(value.config);
  if (!tasks && !config) throw new HttpError(400, "benchmark requires tasks or config");
  return { tasks, config };
}

function validatePromotion(value: unknown): NonNullable<TrainInput["config"]["promotion"]> {
  if (!isRecord(value)) throw new HttpError(400, "config.promotion must be an object");
  return {
    minTrust: value.minTrust === undefined ? undefined : boundedNumber(value.minTrust, "config.promotion.minTrust", 0, 1),
    namespaces: value.namespaces === undefined ? undefined : boundedStringArray(value.namespaces, "config.promotion.namespaces", 64, 256)
  };
}

function validatePolicyPatch(value: unknown): NonNullable<TrainInput["config"]["policy"]> {
  if (!isRecord(value)) throw new HttpError(400, "config.policy must be an object");
  const out: NonNullable<TrainInput["config"]["policy"]> = {};
  if (value.allowMutation !== undefined) out.allowMutation = boundedBoolean(value.allowMutation, "config.policy.allowMutation");
  if (value.requireTwoPhaseCommit !== undefined) out.requireTwoPhaseCommit = boundedBoolean(value.requireTwoPhaseCommit, "config.policy.requireTwoPhaseCommit");
  if (value.dryRunByDefault !== undefined) out.dryRunByDefault = boundedBoolean(value.dryRunByDefault, "config.policy.dryRunByDefault");
  if (value.maxNetworkRequests !== undefined) out.maxNetworkRequests = Math.floor(boundedNumber(value.maxNetworkRequests, "config.policy.maxNetworkRequests", 0, 10000));
  if (value.maxToolCalls !== undefined) out.maxToolCalls = Math.floor(boundedNumber(value.maxToolCalls, "config.policy.maxToolCalls", 0, 10000));
  if (value.maxSpendCents !== undefined) out.maxSpendCents = Math.floor(boundedNumber(value.maxSpendCents, "config.policy.maxSpendCents", 0, 100000));
  if (value.alphaRiskCeiling !== undefined) out.alphaRiskCeiling = boundedNumber(value.alphaRiskCeiling, "config.policy.alphaRiskCeiling", 0, 1);
  if (value.encryptSecretsAtRest !== undefined) out.encryptSecretsAtRest = boundedBoolean(value.encryptSecretsAtRest, "config.policy.encryptSecretsAtRest");
  return out;
}

function validateBenchmarkConfig(value: unknown): NonNullable<BenchmarkInput["config"]> {
  if (!isRecord(value)) throw new HttpError(400, "benchmark config must be an object");
  return {
    tasks: value.tasks === undefined ? undefined : validateBenchmarkTasks(value.tasks, "config.tasks"),
    metadata: value.metadata === undefined ? undefined : validateJsonValue(value.metadata, "config.metadata")
  };
}

function validateBenchmarkTasks(value: unknown, label: string): NonNullable<BenchmarkInput["tasks"]> {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array`);
  if (value.length > 200) throw new HttpError(400, `${label} may contain at most 200 tasks`);
  return value.map((task, index) => validateBenchmarkTask(task, `${label}[${index}]`));
}

function validateBenchmarkTask(value: unknown, label: string): NonNullable<BenchmarkInput["tasks"]>[number] {
  if (!isRecord(value)) throw new HttpError(400, `${label} must be an object`);
  const out: NonNullable<BenchmarkInput["tasks"]>[number] = {
    id: boundedString(value.id, `${label}.id`, 256),
    input: boundedString(value.input, `${label}.input`, 20000)
  };
  if (value.caseType !== undefined) {
    const caseType = boundedString(value.caseType, `${label}.caseType`, 64);
    if (!["SmokeCase", "FactualEvidenceCase", "ContradictionCase", "SemanticEntailmentCase", "TranslationCase", "ProgramArtifactCase", "LearningAcquisitionCase"].includes(caseType)) throw new HttpError(400, `${label}.caseType is not supported`);
    out.caseType = caseType as NonNullable<typeof out.caseType>;
  }
  if (value.criteria !== undefined) out.criteria = validateJsonValue(value.criteria, `${label}.criteria`);
  if (value.expectedEvidence !== undefined) out.expectedEvidence = boundedStringArray(value.expectedEvidence, `${label}.expectedEvidence`, 128, 512);
  if (value.expectedArtifacts !== undefined) out.expectedArtifacts = boundedStringArray(value.expectedArtifacts, `${label}.expectedArtifacts`, 128, 512);
  return out;
}

export const WORKSPACE_PATCH_PLAN_REQUEST_SCHEMA = "yopp.workspace-patch-plan-request.v1" as const;
export const WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA = "scce.workspace-coding-patch-plan-request.v1" as const;
export const WORKSPACE_PATCH_REQUEST_SCHEMA = "yopp.workspace-patch-request.v1" as const;
export const WORKSPACE_PATCH_RESPONSE_SCHEMA = "yopp.workspace-patch-response.v1" as const;
export const DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID = "trusted-host-pnpm-validate.v1" as const;
export const DOCKER_WORKSPACE_PATCH_VALIDATION_POLICY_ID = "docker-pnpm-validate.v1" as const;

/** Stable approval identity for the complete server-owned validation lane. */
export function workspacePatchValidationApprovalBinding(
  policy: StructuredPatchValidationPolicy,
  provider: StructuredPatchValidationProvider
): `sha256:${string}` {
  const providerBinding = provider.approvalBinding?.trim();
  if (!providerBinding) throw new Error(`patch validation provider ${provider.id} does not define an approval binding`);
  const identity = toJsonValue({
    schemaVersion: "scce.workspace-patch-validation-approval-binding.v1",
    policy: {
      schemaVersion: policy.schemaVersion,
      id: policy.id,
      commands: policy.commands.map(command => ({
        executable: command.executable,
        argv: [...command.argv],
        cwd: command.cwd ?? "."
      })),
      timeoutMs: policy.timeoutMs,
      maxOutputBytes: policy.maxOutputBytes,
      maxWorkspaceFiles: policy.maxWorkspaceFiles,
      maxWorkspaceBytes: policy.maxWorkspaceBytes,
      ignoredTopLevelNames: [...(policy.ignoredTopLevelNames ?? [])].sort(),
      environment: policy.environment ?? {}
    },
    provider: {
      id: provider.id,
      boundary: provider.boundary,
      approvalBinding: providerBinding
    }
  });
  return `sha256:${createHash("sha256").update(canonicalStringify(identity)).digest("hex")}`;
}

export interface WorkspacePatchPlanApiRequest {
  readonly schemaVersion: typeof WORKSPACE_PATCH_PLAN_REQUEST_SCHEMA;
  readonly input: WorkspacePatchPlanningInput;
}

export interface WorkspaceCodingPatchPlanApiRequest {
  readonly schemaVersion: typeof WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA;
  readonly input: WorkspaceCodingPatchPlanningInput;
}

export function parseWorkspaceCodingPatchPlanRequest(value: unknown): WorkspaceCodingPatchPlanApiRequest {
  const body = exactRecord(value, "workspace coding patch plan request", [
    "schemaVersion",
    "workspaceId",
    "expectedWorkspaceUpdatedAt",
    "requestId",
    "requestText",
    "requestedPaths",
    "validationPlan"
  ]);
  if (body.schemaVersion !== WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA) {
    throw new HttpError(400, `unsupported workspace coding patch plan request schema: ${String(body.schemaVersion)}`);
  }
  const requestedPaths = boundedArray(body.requestedPaths, "requestedPaths", 256)
    .map((item, index) => boundedWorkspacePath(item, `requestedPaths[${index}]`));
  if (requestedPaths.length < 1) throw new HttpError(400, "requestedPaths must contain at least one path");
  rejectDuplicateApiPaths(requestedPaths, "requestedPaths");
  return {
    schemaVersion: WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA,
    input: {
      workspaceId: boundedString(body.workspaceId, "workspaceId", 256),
      expectedWorkspaceUpdatedAt: strictInteger(body.expectedWorkspaceUpdatedAt, "expectedWorkspaceUpdatedAt", 0, Number.MAX_SAFE_INTEGER),
      requestId: boundedString(body.requestId, "requestId", 256),
      requestText: boundedUtf8Content(body.requestText, "requestText", 20_000),
      requestedPaths,
      validationPlan: parseWorkspaceValidationPlan(body.validationPlan)
    }
  };
}

export function parseWorkspacePatchPlanRequest(value: unknown): WorkspacePatchPlanApiRequest {
  const body = exactRecordWithOptional(
    value,
    "workspace patch plan request",
    ["schemaVersion", "workspaceId", "expectedWorkspaceUpdatedAt", "proposedFiles", "requestedPaths", "assessment", "validationPlan"],
    ["deletions"]
  );
  if (body.schemaVersion !== WORKSPACE_PATCH_PLAN_REQUEST_SCHEMA) {
    throw new HttpError(400, `unsupported workspace patch plan request schema: ${String(body.schemaVersion)}`);
  }
  const workspaceId = boundedString(body.workspaceId, "workspaceId", 256);
  const expectedWorkspaceUpdatedAt = strictInteger(body.expectedWorkspaceUpdatedAt, "expectedWorkspaceUpdatedAt", 0, Number.MAX_SAFE_INTEGER);
  const rawProposedFiles = boundedArray(body.proposedFiles, "proposedFiles", 256);
  const proposedFiles = rawProposedFiles.map((value, index) => parseWorkspaceProposedFile(value, index));
  const rawDeletions = body.deletions === undefined ? [] : boundedArray(body.deletions, "deletions", 256);
  const deletions = rawDeletions.map((value, index) => parseWorkspaceDeletion(value, index));
  if (proposedFiles.length + deletions.length < 1 || proposedFiles.length + deletions.length > 256) {
    throw new HttpError(400, "workspace patch plan request must contain 1 through 256 proposed files and deletions");
  }
  rejectDuplicateApiPaths([...proposedFiles.map(item => item.path), ...deletions.map(item => item.path)], "workspace patch proposal");
  const requestedPaths = boundedArray(body.requestedPaths, "requestedPaths", 256)
    .map((item, index) => boundedWorkspacePath(item, `requestedPaths[${index}]`));
  if (requestedPaths.length < 1) throw new HttpError(400, "requestedPaths must contain at least one path");
  rejectDuplicateApiPaths(requestedPaths, "requestedPaths");

  const assessmentBody = exactRecord(body.assessment, "assessment", [
    "assessmentId",
    "evidenceIds",
    "requestedBehaviorCoverage",
    "dependencyConsistency",
    "architecturalFit",
    "explanationAccuracy",
    "fabricatedBehavior"
  ]);
  const evidenceIds = boundedStringArray(assessmentBody.evidenceIds, "assessment.evidenceIds", 256, 256);
  rejectDuplicateApiValues(evidenceIds, "assessment.evidenceIds");
  const assessment: WorkspacePatchPlanningInput["assessment"] = {
    assessmentId: boundedString(assessmentBody.assessmentId, "assessment.assessmentId", 256),
    evidenceIds,
    requestedBehaviorCoverage: strictUnitNumber(assessmentBody.requestedBehaviorCoverage, "assessment.requestedBehaviorCoverage"),
    dependencyConsistency: strictUnitNumber(assessmentBody.dependencyConsistency, "assessment.dependencyConsistency"),
    architecturalFit: strictUnitNumber(assessmentBody.architecturalFit, "assessment.architecturalFit"),
    explanationAccuracy: strictUnitNumber(assessmentBody.explanationAccuracy, "assessment.explanationAccuracy"),
    fabricatedBehavior: strictUnitNumber(assessmentBody.fabricatedBehavior, "assessment.fabricatedBehavior")
  };

  const validationPlan = parseWorkspaceValidationPlan(body.validationPlan);

  const totalContentBytes = proposedFiles.reduce((total, item) => total + Buffer.byteLength(item.content, "utf8"), 0);
  if (totalContentBytes > 8 * 1024 * 1024) throw new HttpError(400, "proposed file content exceeds the 8388608-byte aggregate bound");
  const input: WorkspacePatchPlanningInput = {
    workspaceId,
    expectedWorkspaceUpdatedAt,
    proposedFiles,
    ...(deletions.length ? { deletions } : {}),
    requestedPaths,
    assessment,
    validationPlan
  };
  return { schemaVersion: WORKSPACE_PATCH_PLAN_REQUEST_SCHEMA, input };
}

/**
 * Produces a reviewable content-addressed plan from the latest durable
 * workspace revision. This boundary never accepts a root, command, approval,
 * authorization, or execution state and never applies the returned plan.
 */
export async function planWorkspacePatchApiRequest(context: ApiContext, request: WorkspacePatchPlanApiRequest) {
  return createWorkspaceRuntime(context).planPatch(request.input);
}

/** Builds ProgramGraph artifacts from the current workspace turn and then uses
 * the same unauthorized exact-byte planner as the structured proposal route. */
export async function planWorkspaceCodingPatchApiRequest(context: ApiContext, request: WorkspaceCodingPatchPlanApiRequest) {
  try {
    return await createWorkspaceRuntime(context).planCodingPatch(request.input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("coding request is unsupported:")) throw new HttpError(422, message);
    throw error;
  }
}

function parseWorkspaceValidationPlan(value: unknown): WorkspaceCodingPatchPlanningInput["validationPlan"] {
  const validationBody = exactRecord(value, "validationPlan", ["validatorId", "checks"]);
  const validatorId = boundedString(validationBody.validatorId, "validationPlan.validatorId", 128);
  if (validatorId !== DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID && validatorId !== DOCKER_WORKSPACE_PATCH_VALIDATION_POLICY_ID) {
    throw new HttpError(400, `unknown workspace patch validation policy: ${validatorId}`);
  }
  const checks = boundedArray(validationBody.checks, "validationPlan.checks", 3).map((item, index) => {
    if (item !== "compiler" && item !== "typecheck" && item !== "tests") {
      throw new HttpError(400, `validationPlan.checks[${index}] is unsupported`);
    }
    return item;
  });
  if (checks.length < 1) throw new HttpError(400, "validationPlan.checks must contain at least one check");
  rejectDuplicateApiValues(checks, "validationPlan.checks");
  return { validatorId, checks };
}

function parseWorkspaceProposedFile(value: unknown, index: number): WorkspacePatchPlanningInput["proposedFiles"][number] {
  const label = `proposedFiles[${index}]`;
  const item = exactRecord(value, label, ["path", "content", "mediaType", "role", "expectedContentHash"]);
  const expectedContentHash = item.expectedContentHash === null
    ? null
    : boundedArtifactContentHash(item.expectedContentHash, `${label}.expectedContentHash`);
  const mediaType = boundedString(item.mediaType, `${label}.mediaType`, 256);
  if (isRejectedPatchMediaType(mediaType)) throw new HttpError(400, `${label}.mediaType must describe UTF-8 text`);
  return {
    path: boundedWorkspacePath(item.path, `${label}.path`),
    content: boundedUtf8Content(item.content, `${label}.content`, 4 * 1024 * 1024),
    mediaType,
    role: workspaceArtifactRole(item.role, `${label}.role`),
    expectedContentHash
  };
}

function parseWorkspaceDeletion(value: unknown, index: number): NonNullable<WorkspacePatchPlanningInput["deletions"]>[number] {
  const label = `deletions[${index}]`;
  const item = exactRecord(value, label, ["path", "expectedContentHash"]);
  return {
    path: boundedWorkspacePath(item.path, `${label}.path`),
    expectedContentHash: boundedArtifactContentHash(item.expectedContentHash, `${label}.expectedContentHash`)
  };
}

function boundedArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array`);
  if (value.length > maxItems) throw new HttpError(400, `${label} may contain at most ${maxItems} items`);
  return value;
}

function boundedWorkspacePath(value: unknown, label: string): string {
  const workspacePath = boundedString(value, label, 1024);
  if (workspacePath.includes("\u0000") || workspacePath.includes("\\") || workspacePath.startsWith("/") || /^[A-Za-z]:/u.test(workspacePath)) {
    throw new HttpError(400, `${label} must be a relative slash-separated workspace path`);
  }
  if (workspacePath.normalize("NFC") !== workspacePath || workspacePath.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new HttpError(400, `${label} is unsafe`);
  }
  return workspacePath;
}

function boundedUtf8Content(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string") throw new HttpError(400, `${label} must be a string`);
  if (value.includes("\u0000")) throw new HttpError(400, `${label} must contain UTF-8 text without NUL bytes`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) throw new HttpError(400, `${label} exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}

function boundedArtifactContentHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256_[0-9a-f]{64}$/u.test(value)) {
    throw new HttpError(400, `${label} must be a lowercase durable SHA-256 content hash`);
  }
  return value;
}

function workspaceArtifactRole(value: unknown, label: string): WorkspacePatchPlanningInput["proposedFiles"][number]["role"] {
  if (value !== "source" && value !== "test" && value !== "config" && value !== "doc") {
    throw new HttpError(400, `${label} must be source|test|config|doc`);
  }
  return value;
}

function strictInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${label} must be a safe integer from ${min} through ${max}`);
  }
  return value;
}

function strictUnitNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new HttpError(400, `${label} must be a finite number from 0 through 1`);
  }
  return value;
}

function rejectDuplicateApiPaths(values: readonly string[], label: string): void {
  rejectDuplicateApiValues(values.map(value => value.toLocaleLowerCase()), label);
}

function rejectDuplicateApiValues(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new HttpError(400, `${label} contains duplicate value: ${value}`);
    seen.add(value);
  }
}

function isRejectedPatchMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLocaleLowerCase();
  return normalized.startsWith("image/")
    || normalized.startsWith("audio/")
    || normalized.startsWith("video/")
    || normalized === "application/octet-stream"
    || normalized.includes("zip")
    || normalized.includes("pdf");
}

export interface WorkspacePatchApiRequest {
  readonly schemaVersion: typeof WORKSPACE_PATCH_REQUEST_SCHEMA;
  readonly workspaceId: string;
  readonly plan: PatchTransactionPlan;
  readonly validationPolicyId: string;
}

export interface WorkspacePatchApiResponse {
  readonly schemaVersion: typeof WORKSPACE_PATCH_RESPONSE_SCHEMA;
  readonly workspaceId: string;
  readonly validationPolicyId: string;
  readonly receipt: Awaited<ReturnType<typeof executeWorkspacePatchTransaction>>;
}

export function parseWorkspacePatchRequest(value: unknown): WorkspacePatchApiRequest {
  const body = exactRecord(value, "workspace patch request", ["schemaVersion", "workspaceId", "plan", "validationPolicyId"]);
  if (body.schemaVersion !== WORKSPACE_PATCH_REQUEST_SCHEMA) throw new HttpError(400, `unsupported workspace patch request schema: ${String(body.schemaVersion)}`);
  const workspaceId = boundedString(body.workspaceId, "workspaceId", 256);
  const validationPolicyId = boundedString(body.validationPolicyId, "validationPolicyId", 128);
  const rawPlan = exactRecord(body.plan, "plan", ["schemaVersion", "operations", "planHash"]);
  if (rawPlan.schemaVersion !== PATCH_TRANSACTION_PLAN_SCHEMA) throw new HttpError(400, `unsupported patch plan schema: ${String(rawPlan.schemaVersion)}`);
  if (!Array.isArray(rawPlan.operations) || rawPlan.operations.length < 1 || rawPlan.operations.length > 256) {
    throw new HttpError(400, "plan.operations must contain 1 through 256 operations");
  }
  if (typeof rawPlan.planHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(rawPlan.planHash)) throw new HttpError(400, "plan.planHash must be a lowercase SHA-256 content hash");

  const operations = rawPlan.operations.map((item, index) => {
    const operation = exactRecord(item, `plan.operations[${index}]`, operationKeys(item));
    if (operation.kind !== "create" && operation.kind !== "replace" && operation.kind !== "delete") throw new HttpError(400, `plan.operations[${index}].kind is unsupported`);
    if (typeof operation.path !== "string") throw new HttpError(400, `plan.operations[${index}].path must be a string`);
    if (operation.kind === "create") {
      if (operation.beforeContentHash !== null || typeof operation.afterContentHash !== "string" || typeof operation.content !== "string") {
        throw new HttpError(400, `plan.operations[${index}] is not a valid create operation`);
      }
    } else if (operation.kind === "replace") {
      if (typeof operation.beforeContentHash !== "string" || typeof operation.afterContentHash !== "string" || typeof operation.content !== "string") {
        throw new HttpError(400, `plan.operations[${index}] is not a valid replace operation`);
      }
    } else if (typeof operation.beforeContentHash !== "string" || operation.afterContentHash !== null) {
      throw new HttpError(400, `plan.operations[${index}] is not a valid delete operation`);
    }
    return operation;
  });

  const plan = {
    schemaVersion: rawPlan.schemaVersion,
    operations,
    planHash: rawPlan.planHash
  } as unknown as PatchTransactionPlan;
  try {
    verifyPatchTransactionPlan(plan);
  } catch (error) {
    throw new HttpError(400, `invalid content-addressed patch plan: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { schemaVersion: WORKSPACE_PATCH_REQUEST_SCHEMA, workspaceId, plan, validationPolicyId };
}

/**
 * Server-callable transaction boundary. The caller supplies a persisted
 * workspace record and server-owned validation policy, never a client root or
 * client executable. Authentication and approval happen in dispatch first.
 */
export async function executeWorkspacePatchApiRequest(input: {
  readonly request: WorkspacePatchApiRequest;
  readonly workspace: { readonly id: string; readonly rootPath: string };
  readonly allowedRoots: readonly string[];
  readonly policy: StructuredPatchValidationPolicy;
  readonly provider?: StructuredPatchValidationProvider;
}): Promise<WorkspacePatchApiResponse> {
  if (input.workspace.id !== input.request.workspaceId) throw new HttpError(409, "workspaceId does not identify the selected workspace");
  if (input.policy.id !== input.request.validationPolicyId) throw new HttpError(400, "validationPolicyId is not registered for this request");
  const workspaceRoot = await canonicalAllowedWorkspaceRoot(input.workspace.rootPath, input.allowedRoots);
  try {
    const receipt = await executeWorkspacePatchTransaction({
      workspaceRoot,
      plan: input.request.plan,
      validate: async view => {
        try {
          return await runStructuredPatchValidation({ workspaceRoot, validationView: view, policy: input.policy, provider: input.provider });
        } catch (error) {
          return {
            ok: false,
            validatorId: input.policy.id,
            evidence: {
              schemaVersion: "yopp.patch-validation-error.v1",
              policyId: input.policy.id,
              planHash: input.request.plan.planHash,
              error: error instanceof Error ? error.message : String(error)
            }
          };
        }
      }
    });
    return {
      schemaVersion: WORKSPACE_PATCH_RESPONSE_SCHEMA,
      workspaceId: input.request.workspaceId,
      validationPolicyId: input.request.validationPolicyId,
      receipt
    };
  } catch (error) {
    if (!(error instanceof WorkspacePatchTransactionError)) throw error;
    if (error.code === "INVALID_PLAN" || error.code === "INVALID_TARGET") throw new HttpError(400, error.message);
    if (error.code === "WORKSPACE_ESCAPE" || error.code === "SYMLINK_REFUSED") throw new HttpError(403, error.message);
    if (error.code === "VALIDATION_FAILED") throw new HttpError(422, error.message);
    if (error.code === "ROLLBACK_FAILED") throw new HttpError(500, error.message);
    throw new HttpError(409, error.message);
  }
}

export function serverPatchValidationPolicy(config: LoadedConfig, policyId: string): StructuredPatchValidationPolicy {
  if (policyId !== DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID) throw new HttpError(400, `unknown workspace patch validation policy: ${policyId}`);
  const command = serverPnpmValidationCommand(config.runtime.tools.pnpm ?? "pnpm");
  return {
    schemaVersion: "yopp.patch-validation-policy.v1",
    id: DEFAULT_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
    commands: [
      { executable: command.executable, argv: [...command.argvPrefix, "install", "--offline", "--frozen-lockfile", "--ignore-scripts"], cwd: "." },
      { executable: command.executable, argv: [...command.argvPrefix, "validate"], cwd: "." }
    ],
    timeoutMs: 15 * 60_000,
    maxOutputBytes: 16 * 1024 * 1024,
    maxWorkspaceFiles: 100_000,
    maxWorkspaceBytes: 2 * 1024 * 1024 * 1024,
    ignoredTopLevelNames: [".tmp", "artifacts", "data"],
    environment: { CI: "1" }
  };
}

/** Resolves the server-owned execution provider once at startup. Request data
 * can select neither the provider nor its image, executable, network, or argv. */
export function serverPatchValidationRuntime(config: LoadedConfig): ApiContext["patchValidation"] | undefined {
  const selected = config.runtime.patchValidation?.provider ?? "trusted-host";
  if (selected === "trusted-host") return undefined;
  const docker = config.runtime.patchValidation?.docker;
  if (!docker) throw new Error("runtime.patchValidation.docker is required when the Docker validation provider is selected");
  const image = docker.image?.trim() || process.env.SCCE_PATCH_VALIDATION_DOCKER_IMAGE?.trim();
  if (!image) throw new Error("Docker patch validation requires a digest-pinned image in config or SCCE_PATCH_VALIDATION_DOCKER_IMAGE");
  const provider = createDockerSandboxPatchValidationProvider({
    image,
    dockerExecutable: docker.dockerExecutable,
    materializationNetwork: docker.materializationNetwork,
    memoryBytes: docker.memoryBytes,
    cpus: docker.cpus,
    pidsLimit: docker.pidsLimit,
    tmpfsBytes: docker.tmpfsBytes,
    workspaceTmpfsBytes: docker.workspaceTmpfsBytes,
    maxHostSnapshotBytes: docker.maxHostSnapshotBytes,
    maxMaterializedFiles: docker.maxMaterializedFiles,
    maxMaterializedBytes: docker.maxMaterializedBytes,
    user: docker.user,
    dependencyMaterialization: {
      schemaVersion: "scce.pnpm-frozen-materialization.v1",
      rootPackagePath: docker.rootPackagePath,
      lockfilePath: docker.lockfilePath,
      inputPaths: docker.dependencyInputPaths
    }
  });
  return {
    provider,
    resolvePolicy(policyId) {
      if (policyId !== DOCKER_WORKSPACE_PATCH_VALIDATION_POLICY_ID) throw new HttpError(400, `unknown Docker workspace patch validation policy: ${policyId}`);
      return {
        schemaVersion: "yopp.patch-validation-policy.v1",
        id: DOCKER_WORKSPACE_PATCH_VALIDATION_POLICY_ID,
        commands: [{ executable: "corepack", argv: ["pnpm", "validate"], cwd: "." }],
        timeoutMs: 15 * 60_000,
        maxOutputBytes: 16 * 1024 * 1024,
        maxWorkspaceFiles: 100_000,
        maxWorkspaceBytes: 2 * 1024 * 1024 * 1024,
        ignoredTopLevelNames: [".tmp", "artifacts", "data"],
        environment: { CI: "1" }
      };
    }
  };
}

function serverPnpmValidationCommand(configured: string): { executable: string; argvPrefix: string[] } {
  if (process.platform !== "win32" || !/^pnpm(?:\.(?:cmd|ps1))?$/iu.test(path.basename(configured))) {
    return { executable: configured, argvPrefix: [] };
  }
  const corepackPnpm = path.join(path.dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js");
  if (!existsSync(corepackPnpm)) throw new HttpError(500, "trusted-host-pnpm-validate.v1 cannot resolve the shell-free Corepack pnpm entrypoint");
  return { executable: process.execPath, argvPrefix: [corepackPnpm] };
}

async function canonicalAllowedWorkspaceRoot(rootPath: string, allowedRoots: readonly string[]): Promise<string> {
  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(path.resolve(rootPath));
  } catch (error) {
    throw new HttpError(400, `workspace root cannot be resolved: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const allowedRoot of allowedRoots) {
    try {
      const canonicalAllowed = await realpath(path.resolve(allowedRoot));
      const rel = path.relative(canonicalAllowed, workspaceRoot);
      if (rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))) return workspaceRoot;
    } catch {
      // A missing configured root cannot authorize a real workspace path.
    }
  }
  throw new HttpError(403, "persisted workspace root is outside runtime.allowedRoots");
}

function operationKeys(value: unknown): readonly string[] {
  if (!isRecord(value)) throw new HttpError(400, "patch operation must be an object");
  if (value.kind === "create" || value.kind === "replace") return ["kind", "path", "beforeContentHash", "afterContentHash", "content"];
  if (value.kind === "delete") return ["kind", "path", "beforeContentHash", "afterContentHash"];
  return ["kind", "path", "beforeContentHash", "afterContentHash"];
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(400, `${label} must be an object`);
  const expected = new Set(keys);
  const actual = Object.keys(value);
  const unexpected = actual.filter(key => !expected.has(key));
  const missing = keys.filter(key => !(key in value));
  if (unexpected.length || missing.length) {
    throw new HttpError(400, `${label} fields are invalid${unexpected.length ? `; unexpected: ${unexpected.join(",")}` : ""}${missing.length ? `; missing: ${missing.join(",")}` : ""}`);
  }
  return value;
}

function exactRecordWithOptional(value: unknown, label: string, requiredKeys: readonly string[], optionalKeys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(400, `${label} must be an object`);
  const expected = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(value);
  const unexpected = actual.filter(key => !expected.has(key));
  const missing = requiredKeys.filter(key => !(key in value));
  if (unexpected.length || missing.length) {
    throw new HttpError(400, `${label} fields are invalid${unexpected.length ? `; unexpected: ${unexpected.join(",")}` : ""}${missing.length ? `; missing: ${missing.join(",")}` : ""}`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new HttpError(400, `${label} must be a string`);
  const clean = label.endsWith("content") ? value : value.trim();
  if (!clean.length && !label.endsWith("content")) throw new HttpError(400, `${label} must be non-empty`);
  if ([...clean].length > maxLength) throw new HttpError(400, `${label} exceeds ${maxLength} characters`);
  return clean;
}

function boundedStringArray(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array`);
  if (value.length > maxItems) throw new HttpError(400, `${label} may contain at most ${maxItems} items`);
  return value.map((item, index) => boundedString(item, `${label}[${index}]`, maxLength));
}

function boundedJsonArray(value: unknown, label: string, maxItems: number): JsonValue[] {
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array`);
  if (value.length > maxItems) throw new HttpError(400, `${label} may contain at most ${maxItems} items`);
  return value.map((item, index) => validateJsonValue(item, `${label}[${index}]`));
}

function boundedNumber(value: unknown, label: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new HttpError(400, `${label} must be a finite number from ${min} through ${max}`);
  return parsed;
}

function boundedBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, `${label} must be a boolean`);
  return value;
}

function validateJsonValue(value: unknown, label: string, depth = 0): JsonValue {
  if (depth > 8) throw new HttpError(400, `${label} is nested too deeply`);
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new HttpError(400, `${label} must be finite`);
    return value;
  }
  if (typeof value === "string") {
    if ([...value].length > 20000) throw new HttpError(400, `${label} string exceeds 20000 characters`);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new HttpError(400, `${label} array may contain at most 256 items`);
    return value.map((item, index) => validateJsonValue(item, `${label}[${index}]`, depth + 1));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length > 256) throw new HttpError(400, `${label} object may contain at most 256 keys`);
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of entries) {
      if (!key || key.length > 256) throw new HttpError(400, `${label} contains an invalid key`);
      out[key] = validateJsonValue(item, `${label}.${key}`, depth + 1);
    }
    return out;
  }
  throw new HttpError(400, `${label} must be JSON-compatible`);
}

function parseInspect(value: string): InspectionTarget {
  if (value === "last" || value === "graph" || value === "ingestion" || value === "codebase" || value === "model" || value === "self" || value === "snapshot" || value === "proofs" || value === "brain" || value === "language" || value === "graph-priors" || value === "language-memory" || value === "localization" || value === "corrections" || value === "math-spine") return value;
  return { kind: "episode", episodeId: value as never };
}

async function readBody(req: http.IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const piece = Buffer.from(chunk as Buffer);
    total += piece.length;
    if (total > maxBytes) throw new HttpError(413, `request body exceeds ${maxBytes} bytes`);
    chunks.push(piece);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  const contentType = req.headers["content-type"]?.toString() ?? "";
  if (!/\bapplication\/json\b/i.test(contentType)) throw new HttpError(415, "request body must use application/json");
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new HttpError(400, "invalid JSON body");
    throw error;
  }
}

function publicConfig(config: LoadedConfig) {
  return {
    server: { url: config.server.url },
    database: { urlConfigured: Boolean(config.database.url) },
    runtime: {
      maxFileBytes: config.runtime.maxFileBytes,
      maxChunkBytes: config.runtime.maxChunkBytes,
      tools: Object.fromEntries(Object.entries(config.runtime.tools).map(([key, value]) => [key, Boolean(value)])),
      patchValidationProvider: config.runtime.patchValidation?.provider ?? "trusted-host"
    },
    connectors: connectorPublicConfig(config),
    security: {
      mentalHealthRails: config.security?.mentalHealthRails ?? true,
      redactPublicConfig: true,
      apiAuthConfigured: Boolean(config.security?.apiBearerToken || process.env.SCCE_API_BEARER_TOKEN)
    },
    policy: {
      allowMutation: config.policy.allowMutation,
      dryRunByDefault: config.policy.dryRunByDefault,
      maxNetworkRequests: config.policy.maxNetworkRequests,
      encryptSecretsAtRest: config.policy.encryptSecretsAtRest
    }
  };
}

function connectorPublicConfig(config: LoadedConfig): JsonValue {
  return toJsonValue({
    web: {
      enabled: config.connectors.web?.enabled ?? false,
      searchProvider: config.connectors.web?.search?.provider ?? null
    },
    outlook: { enabled: config.connectors.outlook?.enabled ?? false },
    youtube: { enabled: config.connectors.youtube?.enabled ?? false },
    telephone: { enabled: config.connectors.telephone?.enabled ?? false }
  });
}

function compactTurnResult(result: TurnResult): Record<string, unknown> {
  return {
    ...result,
    evidence: result.evidence.map(compactEvidenceSpan),
    entailment: compactEntailment(result.entailment),
    validationGraph: { ...result.validationGraph, pca: compactPca(result.validationGraph.pca) },
    emissionGraph: { ...result.emissionGraph, pca: compactPca(result.emissionGraph.pca) },
    proofCarryingAnswer: compactPca(result.proofCarryingAnswer),
    events: result.events.map(compactEvent)
  };
}

function turnAnswerHasSpeech(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(String(text || ""));
}

function compactTurnDialogue(dialogue: TurnDialogueBridge): JsonValue {
  return toJsonValue({
    schema: dialogue.schema,
    conversationId: dialogue.conversationId,
    turnId: dialogue.turnId,
    answerGraphHash: dialogue.answerGraphHash,
    pragmaticsId: dialogue.pragmatics.id,
    dialogueStateId: dialogue.pragmatics.state.turnId,
    policyDecisionId: dialogue.pragmatics.policyDecision.id,
    selectedActionIds: dialogue.pragmatics.policyDecision.selectedActionIds,
    selectedCandidateId: dialogue.pragmatics.selected.candidateId,
    selectedScore: dialogue.pragmatics.selected.score,
    streamPlan: dialogue.streamPlan,
    trace: compactJson(dialogue.trace, 2)
  });
}

function compactEvidenceSpan(span: TurnResult["evidence"][number]): Record<string, unknown> {
  return {
    id: span.id,
    sourceId: span.sourceId,
    sourceVersionId: span.sourceVersionId,
    chunkId: span.chunkId,
    contentHash: span.contentHash,
    mediaType: span.mediaType,
    byteStart: span.byteStart,
    byteEnd: span.byteEnd,
    charStart: span.charStart,
    charEnd: span.charEnd,
    textPreview: previewText(span.textPreview || span.text, 420),
    languageHints: compactJson(span.languageHints, 1),
    scriptHints: compactJson(span.scriptHints, 1),
    trustVector: compactJson(span.trustVector, 1),
    provenance: compactJson(span.provenance, 1),
    features: span.features.slice(0, 32),
    status: span.status,
    alpha: span.alpha,
    observedAt: span.observedAt
  };
}

function compactEntailment(entailment: TurnResult["entailment"]): Record<string, unknown> {
  return {
    ...entailment,
    proof: {
      ...entailment.proof,
      confidence: compactJson(entailment.proof.confidence, 3),
      proofGraph: {
        nodes: entailment.proof.proofGraph.nodes.slice(0, 64).map(node => ({ ...node, metadata: compactJson(node.metadata, 2) })),
        edges: entailment.proof.proofGraph.edges.slice(0, 96)
      },
      scores: compactJson(entailment.proof.scores, 3)
    },
    obligations: entailment.obligations.slice(0, 32).map(row => ({ ...row, metadata: compactJson(row.metadata, 2) })),
    mappings: entailment.mappings.slice(0, 32).map(row => ({ ...row, audit: compactJson(row.audit, 2) })),
    transforms: entailment.transforms.slice(0, 32).map(row => ({ ...row, audit: compactJson(row.audit, 2) })),
    counterexamples: entailment.counterexamples.slice(0, 16).map(row => ({ ...row, audit: compactJson(row.audit, 2) })),
    missing: entailment.missing.slice(0, 16).map(row => ({ ...row, audit: compactJson(row.audit, 2) }))
  };
}

function compactEvent(event: TurnResult["events"][number]): Record<string, unknown> {
  return {
    id: event.id,
    episodeId: event.episodeId,
    typeId: event.typeId,
    t: event.t,
    parents: event.parents,
    payload: compactJson(event.payload, 3)
  };
}

function compactPca(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const audit = isRecord(value.audit) ? value.audit : value;
  return compactJson(audit, 3);
}

function compactJson(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return previewText(value, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const out = value.slice(0, 48).map(item => compactJson(item, depth - 1));
    if (value.length > out.length) out.push({ truncated: value.length - out.length });
    return out;
  }
  if (!isRecord(value)) return String(value);
  if (depth <= 0) return compactRecordSummary(value);
  const entries = Object.entries(value).slice(0, 64);
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) out[key] = compactJson(item, depth - 1);
  const remaining = Object.keys(value).length - entries.length;
  if (remaining > 0) out.truncatedKeys = remaining;
  return out;
}

function compactRecordSummary(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["schema", "source", "id", "force", "verdict", "support", "contradiction", "grounding", "supportedSentences", "totalSentences"]) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  const keys = Object.keys(value);
  out.keys = keys.slice(0, 16);
  if (keys.length > 16) out.truncatedKeys = keys.length - 16;
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : [];
}

function uniqueServerStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function healthOk(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.ok === true) return true;
  const verify = value.verify;
  return isRecord(verify) && verify.ok === true;
}

function requireFields(value: unknown, fields: string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(400, "request body must be an object");
  for (const field of fields) if (value[field] === undefined || value[field] === null || value[field] === "") throw new HttpError(400, `missing required field: ${field}`);
  return value;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
  if (typeof value === "string") return splitContactList(value).map(item => item.trim()).filter(Boolean);
  throw new HttpError(400, "expected string array");
}

function previewText(value: string, maxChars = 600): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function splitContactList(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of value) {
    if (char === ";" || char === ",") {
      out.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

function html(body: string): { status: number; body: string; contentType: string } {
  return { status: 200, body, contentType: "text/html; charset=utf-8" };
}

function json(value: unknown, status = 200): { status: number; body: string; contentType: string } {
  return { status, body: JSON.stringify(value), contentType: "application/json; charset=utf-8" };
}

function pendingApproval(context: ApiContext, capabilityId: string, input: unknown): { status: number; body: string; contentType: string } {
  const pending = context.runtime.approvals.requestApproval({ capabilityId, input: toJsonValue(input), reason: "operator-approval-required" });
  return json({ ok: false, pendingApproval: pending, session: context.runtime.approvals.snapshot() }, 202);
}

function approved(context: ApiContext, capabilityId: string, input: unknown): boolean {
  return context.runtime.approvals.isApproved({ capabilityId, input: toJsonValue(input) });
}

function send(res: http.ServerResponse, status: number, body: string, type: string, meta: { requestId: string; started: number }): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-request-id": meta.requestId,
    "x-runtime-ms": String(Date.now() - meta.started)
  });
  res.end(body);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
