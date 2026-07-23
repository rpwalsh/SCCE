export type SurfacePaneId = "explorer" | "search" | "source" | "proof" | "program" | "database" | "connectors" | "approvals";
export type SurfaceEditorKind = "chat" | "json" | "graph" | "code" | "diff" | "terminal" | "table" | "config";
export type SurfaceSeverity = "info" | "warning" | "error";

export interface SurfaceCommand {
  id: string;
  title: string;
  group: "runtime" | "ingestion" | "database" | "proof" | "program" | "connectors" | "approval" | "view";
  icon: string;
  endpoint?: { method: "GET" | "POST"; path: string; body?: unknown };
  keybinding?: string;
  mutates: boolean;
  approvalRequired: boolean;
  when?: string;
}

export interface SurfacePane {
  id: SurfacePaneId;
  title: string;
  icon: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  visible: boolean;
  commands: string[];
  items: SurfaceTreeItem[];
}

export interface SurfaceTreeItem {
  id: string;
  label: string;
  icon: string;
  kind: "folder" | "file" | "source" | "evidence" | "proof" | "program" | "event" | "approval" | "table" | "route";
  depth: number;
  expanded: boolean;
  children?: SurfaceTreeItem[];
  payload?: unknown;
}

export interface SurfaceEditor {
  id: string;
  title: string;
  kind: SurfaceEditorKind;
  group: "main" | "side" | "bottom";
  pinned: boolean;
  dirty: boolean;
  readonly: boolean;
  language?: string;
  payload: unknown;
}

export interface SurfaceApproval {
  id: string;
  planId: string;
  capabilityId: string;
  reason: string;
  risk: number;
  operatorGrantEligible: boolean;
  createdAt: number;
  payloadPreview: string;
}

export interface SurfaceTerminalLine {
  id: string;
  t: number;
  stream: "system" | "request" | "response" | "error";
  text: string;
}

export interface SurfaceTraceNode {
  id: string;
  label: string;
  typeId: string;
  t: number;
  parents: string[];
  payload: unknown;
}

export interface SurfaceLayout {
  activityBarWidth: number;
  sideBarWidth: number;
  inspectorWidth: number;
  bottomHeight: number;
  minEditorWidth: number;
  minTerminalHeight: number;
  density: "compact" | "comfortable";
}

export interface CodexSurfaceState {
  serverUrl: string;
  activePane: SurfacePaneId;
  activeEditorId: string;
  panes: SurfacePane[];
  editors: SurfaceEditor[];
  commands: SurfaceCommand[];
  approvals: SurfaceApproval[];
  terminal: SurfaceTerminalLine[];
  trace: SurfaceTraceNode[];
  layout: SurfaceLayout;
  palette: { open: boolean; query: string; selectedIndex: number; matches: string[] };
  status: {
    ready: boolean;
    postgres: "unknown" | "ok" | "error";
    operatorGrant: boolean;
    requestInFlight: boolean;
    force?: string;
    episodeId?: string;
    message?: string;
    severity: SurfaceSeverity;
  };
}

export type CodexSurfaceAction =
  | { type: "pane.activate"; pane: SurfacePaneId }
  | { type: "pane.items"; pane: SurfacePaneId; items: SurfaceTreeItem[] }
  | { type: "editor.open"; editor: SurfaceEditor }
  | { type: "editor.patch"; editorId: string; patch: Partial<SurfaceEditor> }
  | { type: "editor.close"; editorId: string }
  | { type: "palette.open"; query?: string }
  | { type: "palette.close" }
  | { type: "palette.query"; query: string }
  | { type: "palette.move"; delta: number }
  | { type: "approvals.replace"; approvals: SurfaceApproval[]; operatorGrant?: boolean }
  | { type: "terminal.append"; line: Omit<SurfaceTerminalLine, "id" | "t"> }
  | { type: "trace.replace"; trace: SurfaceTraceNode[] }
  | { type: "layout.patch"; layout: Partial<SurfaceLayout> }
  | { type: "status.patch"; status: Partial<CodexSurfaceState["status"]> };

export const SURFACE_COMMANDS: SurfaceCommand[] = [
  command("runtime.ready", "i18n:cmd.runtime.ready", "runtime", "CircleDot", "GET", "/api/ready", false, false, "Ctrl+R"),
  command("ingest.source", "i18n:cmd.ingest.source", "ingestion", "FileInput", "POST", "/api/ingest", true, false),
  command("ingest.codebase", "i18n:cmd.ingest.codebase", "ingestion", "FolderCode", "POST", "/api/codebase/ingest", true, false),
  command("workspace.init", "i18n:cmd.workspace.init", "ingestion", "FolderPlus", "POST", "/api/workspace/init", true, false),
  command("workspace.ingest", "i18n:cmd.workspace.ingest", "ingestion", "FolderSync", "POST", "/api/workspace/ingest", true, false),
  command("workspace.ask", "i18n:cmd.workspace.ask", "runtime", "MessagesSquare", "POST", "/api/workspace/ask", true, false),
  command("project.summary", "i18n:cmd.project.summary", "view", "NotebookText", "GET", "/api/project/summary", false, false),
  command("project.map", "i18n:cmd.project.map", "view", "Map", "GET", "/api/project/map", false, false),
  command("project.symbols", "i18n:cmd.project.symbols", "view", "SearchCode", "GET", "/api/project/symbols", false, false),
  command("project.gaps", "i18n:cmd.project.gaps", "view", "ListChecks", "GET", "/api/project/gaps", false, false),
  command("project.contradictions", "i18n:cmd.project.contradictions", "proof", "TriangleAlert", "GET", "/api/project/contradictions", false, false),
  command("project.tasks", "i18n:cmd.project.tasks", "program", "ListTodo", "GET", "/api/project/tasks", false, false),
  command("report.brief", "i18n:cmd.report.brief", "view", "FileText", "GET", "/api/reports/brief", false, false),
  command("report.patch_plan", "i18n:cmd.report.patch_plan", "program", "FilePenLine", "GET", "/api/reports/patch-plan", false, false),
  command("report.handoff", "i18n:cmd.report.handoff", "view", "Send", "GET", "/api/reports/handoff", false, false),
  command("report.review", "i18n:cmd.report.review", "proof", "ShieldQuestion", "GET", "/api/reports/review", false, false),
  command("train.promote", "i18n:cmd.train.promote", "runtime", "GraduationCap", "POST", "/api/train", true, false),
  command("turn.run", "i18n:cmd.kernel.turn", "runtime", "Play", "POST", "/api/turn", true, false, "Ctrl+Enter"),
  command("inspect.snapshot", "i18n:cmd.inspect.snapshot", "view", "PanelTop", "GET", "/api/inspect?target=snapshot", false, false),
  command("inspect.math_spine", "i18n:cmd.inspect.math_spine", "view", "ChartSpline", "GET", "/api/inspect?target=math-spine", false, false),
  command("inspect.graph", "i18n:cmd.inspect.graph", "proof", "Network", "GET", "/api/inspect?target=graph", false, false),
  command("inspect.codebase", "i18n:cmd.inspect.codebase", "view", "FolderCode", "GET", "/api/inspect?target=codebase", false, false),
  command("inspect.proofs", "i18n:cmd.inspect.proofs", "proof", "BadgeCheck", "GET", "/api/inspect?target=proofs", false, false),
  command("db.verify", "i18n:cmd.db.verify", "database", "DatabaseZap", "GET", "/api/db/verify", false, false),
  command("db.stats", "i18n:cmd.db.stats", "database", "ChartNoAxesColumn", "GET", "/api/db/stats", false, false),
  command("tools.inspect", "i18n:cmd.tools.inspect", "connectors", "Wrench", "GET", "/api/tools", false, false),
  command("connectors.quota", "i18n:cmd.connectors.quota", "connectors", "Gauge", "GET", "/api/connectors/quota", false, false),
  command("approvals.refresh", "i18n:cmd.approvals.refresh", "approval", "RefreshCcw", "GET", "/api/session/approvals", false, false),
  command("approvals.operator_grant", "i18n:cmd.approvals.operator_grant", "approval", "ShieldAlert", "POST", "/api/session/operator-grant", true, false),
  command("approvals.approve", "i18n:cmd.approvals.approve", "approval", "ShieldCheck", "POST", "/api/session/approve", true, true)
];

export function createCodexSurfaceState(serverUrl: string): CodexSurfaceState {
  const editors: SurfaceEditor[] = [
    editor("chat.turn", "chat.turn", "chat", "main", false, { messages: [] }),
    editor("proof.graph", "proof.graph", "graph", "side", true, { nodes: [], edges: [] }),
    editor("program.graph", "program.graph", "graph", "side", true, { nodes: [], edges: [] }),
    editor("inspector.json", "inspector.json", "json", "side", true, {}),
    editor("terminal", "terminal", "terminal", "bottom", false, [])
  ];
  return {
    serverUrl,
    activePane: "explorer",
    activeEditorId: "chat.turn",
    panes: defaultPanes(),
    editors,
    commands: SURFACE_COMMANDS,
    approvals: [],
    terminal: [{ id: "term.0", t: 0, stream: "system", text: "i18n:terminal.ready" }],
    trace: [],
    layout: { activityBarWidth: 48, sideBarWidth: 292, inspectorWidth: 420, bottomHeight: 190, minEditorWidth: 360, minTerminalHeight: 120, density: "compact" },
    palette: { open: false, query: "", selectedIndex: 0, matches: SURFACE_COMMANDS.map(c => c.id) },
    status: { ready: false, postgres: "unknown", operatorGrant: false, requestInFlight: false, severity: "info" }
  };
}

export function reduceCodexSurface(state: CodexSurfaceState, action: CodexSurfaceAction, now = Date.now()): CodexSurfaceState {
  switch (action.type) {
    case "pane.activate":
      return { ...state, activePane: action.pane, panes: state.panes.map(pane => ({ ...pane, visible: pane.id === action.pane ? true : pane.visible })) };
    case "pane.items":
      return { ...state, panes: state.panes.map(pane => pane.id === action.pane ? { ...pane, items: action.items } : pane) };
    case "editor.open": {
      const exists = state.editors.some(item => item.id === action.editor.id);
      return { ...state, editors: exists ? state.editors.map(item => item.id === action.editor.id ? action.editor : item) : [...state.editors, action.editor], activeEditorId: action.editor.id };
    }
    case "editor.patch":
      return { ...state, editors: state.editors.map(item => item.id === action.editorId ? { ...item, ...action.patch } : item) };
    case "editor.close": {
      const editors = state.editors.filter(item => item.id !== action.editorId || item.pinned);
      return { ...state, editors, activeEditorId: editors.some(item => item.id === state.activeEditorId) ? state.activeEditorId : editors[0]?.id ?? "" };
    }
    case "palette.open": {
      const query = action.query ?? "";
      return { ...state, palette: paletteState(state.commands, query, true, 0) };
    }
    case "palette.close":
      return { ...state, palette: { ...state.palette, open: false } };
    case "palette.query":
      return { ...state, palette: paletteState(state.commands, action.query, true, 0) };
    case "palette.move": {
      const selectedIndex = wrap(state.palette.selectedIndex + action.delta, state.palette.matches.length);
      return { ...state, palette: { ...state.palette, selectedIndex } };
    }
    case "approvals.replace": {
      const items = action.approvals.map(approvalTreeItem);
      return {
        ...state,
        approvals: action.approvals,
        panes: state.panes.map(pane => pane.id === "approvals" ? { ...pane, items } : pane),
        status: { ...state.status, operatorGrant: action.operatorGrant ?? state.status.operatorGrant, severity: action.approvals.length ? "warning" : state.status.severity, message: action.approvals.length ? `i18n:status.pending_approvals:${action.approvals.length}` : state.status.message }
      };
    }
    case "terminal.append":
      return { ...state, terminal: [...state.terminal, { ...action.line, id: `term.${now}.${state.terminal.length}`, t: now }].slice(-600) };
    case "trace.replace":
      return { ...state, trace: action.trace };
    case "layout.patch":
      return { ...state, layout: normalizeLayout({ ...state.layout, ...action.layout }) };
    case "status.patch":
      return { ...state, status: { ...state.status, ...action.status } };
    default:
      return state;
  }
}

export function hydrateSurfaceFromTurn(state: CodexSurfaceState, turn: unknown, now = Date.now()): CodexSurfaceState {
  const value = asRecord(turn);
  const events = Array.isArray(value.events) ? traceFromUnknownEvents(value.events) : [];
  const evidence = Array.isArray(value.evidence) ? treeFromEvidence(value.evidence) : [];
  const proof = asRecord(value.entailment).proof ?? asRecord(value.proofCarryingAnswer);
  const construct = asRecord(value.constructGraph);
  const program = asRecord(construct).program ?? asRecord(value.program);
  let next = reduceCodexSurface(state, { type: "trace.replace", trace: events }, now);
  next = reduceCodexSurface(next, { type: "pane.items", pane: "source", items: evidence }, now);
  next = reduceCodexSurface(next, { type: "editor.patch", editorId: "proof.graph", patch: { payload: proof } }, now);
  next = reduceCodexSurface(next, { type: "editor.patch", editorId: "program.graph", patch: { payload: program } }, now);
  next = reduceCodexSurface(next, { type: "editor.patch", editorId: "inspector.json", patch: { payload: value } }, now);
  next = reduceCodexSurface(next, { type: "terminal.append", line: { stream: "response", text: `i18n:terminal.turn_result:${String(value.episodeId ?? "unknown")}:${String(asRecord(value.entailment).force ?? "unknown")}` } }, now);
  return reduceCodexSurface(next, { type: "status.patch", status: { episodeId: typeof value.episodeId === "string" ? value.episodeId : undefined, force: typeof asRecord(value.entailment).force === "string" ? String(asRecord(value.entailment).force) : undefined, requestInFlight: false, severity: "info" } }, now);
}

export function hydrateApprovals(value: unknown, now = Date.now()): { approvals: SurfaceApproval[]; operatorGrant: boolean } {
  const record = asRecord(value);
  const pending = Array.isArray(record.pending) ? record.pending : Array.isArray(record.approvals) ? record.approvals : [];
  return {
    operatorGrant: Boolean(record.operatorGrant),
    approvals: pending.map((item, index) => {
      const p = asRecord(item);
      const input = p.input ?? p.payload ?? {};
      return {
        id: typeof p.id === "string" ? p.id : `approval.${index}`,
        planId: typeof p.planId === "string" ? p.planId : typeof p.id === "string" ? p.id : `plan.${index}`,
        capabilityId: typeof p.capabilityId === "string" ? p.capabilityId : "capability",
        reason: typeof p.reason === "string" ? p.reason : "i18n:approval.required",
        risk: typeof p.risk === "number" ? p.risk : 0.5,
        operatorGrantEligible: Boolean(p.operatorGrantEligible ?? true),
        createdAt: typeof p.createdAt === "number" ? p.createdAt : now,
        payloadPreview: safePreview(input)
      };
    })
  };
}

export function commandMatches(commands: readonly SurfaceCommand[], query: string): SurfaceCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  const terms = splitWhitespace(needle);
  return commands
    .map(command => ({ command, score: commandScore(command, terms) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.command.title.localeCompare(b.command.title))
    .map(item => item.command);
}

export function routeForCommand(command: SurfaceCommand, body?: unknown): { method: "GET" | "POST"; path: string; body?: unknown } | undefined {
  if (!command.endpoint) return undefined;
  return { method: command.endpoint.method, path: command.endpoint.path, body: body ?? command.endpoint.body };
}

export function resizeLayout(layout: SurfaceLayout, viewport: { width: number; height: number }): SurfaceLayout {
  const compact = viewport.width < 980 || viewport.height < 680;
  return normalizeLayout({
    ...layout,
    density: compact ? "compact" : "comfortable",
    activityBarWidth: compact ? 44 : 48,
    sideBarWidth: compact ? Math.min(layout.sideBarWidth, Math.max(220, viewport.width * 0.42)) : layout.sideBarWidth,
    inspectorWidth: compact ? 0 : Math.min(layout.inspectorWidth, Math.max(320, viewport.width * 0.34)),
    bottomHeight: Math.min(layout.bottomHeight, Math.max(layout.minTerminalHeight, viewport.height * 0.34))
  });
}

function command(id: string, title: string, group: SurfaceCommand["group"], icon: string, method: "GET" | "POST", path: string, mutates: boolean, approvalRequired: boolean, keybinding?: string): SurfaceCommand {
  return { id, title, group, icon, endpoint: { method, path }, mutates, approvalRequired, keybinding };
}

function editor(id: string, title: string, kind: SurfaceEditorKind, group: SurfaceEditor["group"], readonly: boolean, payload: unknown): SurfaceEditor {
  return { id, title, kind, group, pinned: true, dirty: false, readonly, payload };
}

function defaultPanes(): SurfacePane[] {
  return [
    pane("explorer", "i18n:activity.explorer", "Files", ["workspace.init", "workspace.ingest", "project.summary", "project.symbols", "project.gaps", "inspect.snapshot"], [
      tree("workspace", "workspace", "folder", 0, true, [
        tree("config", "scce.config.json", "file", 1),
        tree("kernel", "packages/kernel", "folder", 1),
        tree("adapters", "packages/adapters-node", "folder", 1),
        tree("server", "packages/server", "folder", 1),
        tree("ui", "packages/ui", "folder", 1)
      ])
    ]),
    pane("source", "i18n:workbench.pane.sources", "FileText", ["workspace.ingest", "project.map", "project.symbols", "inspect.codebase"], []),
    pane("proof", "i18n:workbench.pane.proof", "Network", ["inspect.proofs", "inspect.graph"], []),
    pane("program", "i18n:workbench.pane.program", "Code", ["inspect.snapshot"], []),
    pane("database", "i18n:workbench.pane.database", "Database", ["db.verify", "db.stats"], []),
    pane("connectors", "i18n:workbench.pane.connectors", "Cable", ["tools.inspect", "connectors.quota"], []),
    pane("approvals", "i18n:activity.approvals", "ShieldCheck", ["approvals.refresh", "approvals.operator_grant"], [])
  ];
}

function pane(id: SurfacePaneId, title: string, icon: string, commands: string[], items: SurfaceTreeItem[]): SurfacePane {
  return { id, title, icon, width: 292, minWidth: 220, maxWidth: 520, visible: id === "explorer", commands, items };
}

function tree(id: string, label: string, kind: SurfaceTreeItem["kind"], depth: number, expanded = false, children?: SurfaceTreeItem[], payload?: unknown): SurfaceTreeItem {
  return { id, label, icon: iconForKind(kind), kind, depth, expanded, children, payload };
}

function approvalTreeItem(approval: SurfaceApproval): SurfaceTreeItem {
  return tree(approval.id, `${approval.capabilityId} scce.ui.metric.risk ${approval.risk.toFixed(3)}`, "approval", 0, false, undefined, approval);
}

function treeFromEvidence(evidence: unknown[]): SurfaceTreeItem[] {
  return evidence.map((item, index) => {
    const record = asRecord(item);
    const id = typeof record.id === "string" ? record.id : `evidence.${index}`;
    const preview = typeof record.textPreview === "string" ? record.textPreview : typeof record.text === "string" ? record.text.slice(0, 90) : "scce.ui.fallback.evidence";
    const alpha = typeof record.alpha === "number" ? record.alpha.toFixed(3) : "0.000";
    return tree(id, `${alpha} ${preview}`, "evidence", 0, false, undefined, record);
  });
}

function traceFromUnknownEvents(events: unknown[]): SurfaceTraceNode[] {
  return events.map((item, index) => {
    const record = asRecord(item);
    const parents = Array.isArray(record.parents) ? record.parents.filter((p): p is string => typeof p === "string") : [];
    return {
      id: typeof record.id === "string" ? record.id : `event.${index}`,
      label: typeof record.typeId === "string" ? record.typeId : "Event",
      typeId: typeof record.typeId === "string" ? record.typeId : "Event",
      t: typeof record.t === "number" ? record.t : index,
      parents,
      payload: record.payload
    };
  });
}

function paletteState(commands: readonly SurfaceCommand[], query: string, open: boolean, selectedIndex: number): CodexSurfaceState["palette"] {
  const matches = commandMatches(commands, query).map(command => command.id);
  return { open, query, selectedIndex: wrap(selectedIndex, matches.length), matches };
}

function commandScore(command: SurfaceCommand, terms: readonly string[]): number {
  const haystack = `${command.id} ${command.title} ${command.group} ${command.endpoint?.path ?? ""} ${command.keybinding ?? ""}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const index = haystack.indexOf(term);
    if (index < 0) return 0;
    score += 1 + Math.max(0, 1 - index / Math.max(1, haystack.length));
  }
  if (command.keybinding) score += 0.2;
  if (command.group === "runtime") score += 0.1;
  return score;
}

function splitWhitespace(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of value) {
    if (char.trim() === "") {
      if (current) {
        out.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) out.push(current);
  return out;
}

function normalizeLayout(layout: SurfaceLayout): SurfaceLayout {
  return {
    activityBarWidth: clamp(layout.activityBarWidth, 40, 64),
    sideBarWidth: clamp(layout.sideBarWidth, 220, 560),
    inspectorWidth: clamp(layout.inspectorWidth, 0, 640),
    bottomHeight: clamp(layout.bottomHeight, layout.minTerminalHeight, 360),
    minEditorWidth: clamp(layout.minEditorWidth, 280, 720),
    minTerminalHeight: clamp(layout.minTerminalHeight, 80, 260),
    density: layout.density
  } as SurfaceLayout;
}

function iconForKind(kind: SurfaceTreeItem["kind"]): string {
  const icons: Record<SurfaceTreeItem["kind"], string> = {
    folder: "Folder",
    file: "File",
    source: "FileText",
    evidence: "BadgeCheck",
    proof: "Network",
    program: "Code",
    event: "CircleDot",
    approval: "ShieldCheck",
    table: "Table",
    route: "Route"
  };
  return icons[kind];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safePreview(value: unknown): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 220 ? `${text.slice(0, 217)}...` : text;
  } catch {
    return "[unserializable]";
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function wrap(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}
