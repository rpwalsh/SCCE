export type UiMessageKey = keyof typeof UI_MESSAGES_EN_US | string;

export const UI_MESSAGES_EN_US = {
  "app.lang": "en",
  "app.title": "SCCE v3 Workbench",
  "app.subtitle": "Postgres-only cognitive runtime",
  "activity.explorer": "Explorer",
  "activity.search": "Search",
  "activity.proof": "Proof",
  "activity.program": "Program",
  "activity.approvals": "Approvals",
  "side.explorer": "Explorer",
  "side.evidence": "Evidence",
  "side.approvals": "Approvals",
  "side.evidence.empty": "Run inspect to load graph/evidence.",
  "side.approvals.refresh": "Refresh",
  "side.approvals.operator_grant": "Operator grant",
  "side.approvals.none": "No pending actions.",
  "side.approvals.operator_grant_enabled": "Operator grant enabled for this session.",
  "side.approvals.approve": "Approve",
  "tabs.chat": "chat.turn",
  "tabs.proof": "proof.graph",
  "tabs.pca": "pca.certificates",
  "tabs.program": "program.graph",
  "tabs.action": "action.graph",
  "tabs.self": "self.state",
  "chat.ready": "Ready.",
  "prompt.default": "Transform the sample CSV records into normalized JSON.",
  "button.turn": "Run Turn",
  "button.inspect": "Inspect",
  "pane.inspector": "Inspector",
  "workbench.pane.sources": "Sources",
  "workbench.pane.proof": "Proof Graph",
  "workbench.pane.program": "Program Graph",
  "terminal.ready": "$ SCCE workbench ready",
  "terminal.turn_result": "Episode {episodeId} force {force}",
  "status.pending_approvals": "{count} pending approvals",
  "status.product": "SCCE v3",
  "status.postgres": "PostgreSQL required",
  "status.math": "Alpha / PPF / Proof / ProgramGraph",
  "palette.aria": "Command",
  "cmd.runtime.ready": "Runtime: Check Readiness",
  "cmd.ingest.source": "Ingest: Source",
  "cmd.ingest.codebase": "Ingest: Codebase",
  "cmd.workspace.init": "Workspace: Init",
  "cmd.workspace.ingest": "Workspace: Ingest",
  "cmd.workspace.ask": "Workspace: Ask",
  "cmd.project.summary": "Project: Summary",
  "cmd.project.map": "Project: Map",
  "cmd.project.symbols": "Project: Symbols",
  "cmd.project.gaps": "Project: Gaps",
  "cmd.project.contradictions": "Project: Contradictions",
  "cmd.project.tasks": "Project: Tasks",
  "cmd.report.brief": "Report: Brief",
  "cmd.report.patch_plan": "Report: Patch Plan",
  "cmd.report.handoff": "Report: Handoff",
  "cmd.report.review": "Report: Review",
  "cmd.train.promote": "Train: Promote Evidence",
  "cmd.db.verify": "Database: Verify Schema",
  "cmd.db.stats": "Database: Inspect Stats",
  "cmd.tools.inspect": "Tools: Diagnose Extractors",
  "cmd.session.approvals": "Session: Approvals",
  "cmd.session.operator_grant": "Session: Toggle Operator Grant",
  "cmd.connectors.quota": "Connectors: Quota",
  "cmd.inspect.snapshot": "Inspect: Snapshot",
  "cmd.inspect.math_spine": "Inspect: Walsh Math Spine",
  "cmd.inspect.graph": "Inspect: Graph",
  "cmd.inspect.ingestion": "Inspect: Ingestion",
  "cmd.inspect.codebase": "Inspect: Codebase",
  "cmd.inspect.self": "Inspect: Self",
  "cmd.inspect.proofs": "Inspect: Proofs",
  "cmd.kernel.turn": "Kernel: Run Turn",
  "cmd.approvals.refresh": "Approvals: Refresh",
  "cmd.approvals.operator_grant": "Approvals: Toggle Operator Grant",
  "cmd.approvals.approve": "Approvals: Approve Selected",
  "workbench.pane.database": "Database",
  "workbench.pane.connectors": "Connectors",
  "error.prefix": "ERROR",
  "approval.required": "approval-required",
  "ui.message.db.verify": "Verify database",
  "ui.message.ingest.started": "Ingest started",
  "ui.message.turn.force": "Force",
  "ui.action.surface_note": "Record surface note",
  "ui.action.prefer_surface": "Prefer surface",
  "ui.action.translate_ui": "Draft localization",
  "ui.action.add_correction": "Add correction",
  "prompt.codebase_path": "Local repo or folder path",
  "prompt.workspace_path": "Workspace folder path",
  "prompt.workspace_question": "Workspace question",
  "ui.label.evidence": "Evidence",
  "ui.label.inspect": "Inspect",
  "ui.label.language": "Language"
} as const;

export function uiText(key: UiMessageKey): string {
  return UI_MESSAGES_EN_US[String(key) as keyof typeof UI_MESSAGES_EN_US] ?? String(key);
}

export function uiMessageScript(): string {
  return escapeJsonForScript(JSON.stringify(UI_MESSAGES_EN_US));
}

function escapeJsonForScript(json: string): string {
  let out = "";
  for (const char of json) {
    if (char === "<") out += "\\u003c";
    else if (char === ">") out += "\\u003e";
    else if (char === "&") out += "\\u0026";
    else out += char;
  }
  return out;
}
