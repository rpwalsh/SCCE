import { describe, expect, it } from "vitest";
import { projectRequestAuthority } from "../request-authority.js";
import { createSourceOnlyScceRuntime, validateScceRuntimeTurnTrace, type ScceRuntimeFixtureFile } from "../scce-runtime.js";
import type { RequestedAuthority } from "../types.js";
import type { TurnRequirementDimension } from "../turn-requirements.js";
import type { WorkspaceCoreSourceFileInput, WorkspaceCoreSourceRef } from "../workspace-core-fusion.js";

describe("source-only request-authority routing", () => {
  it("uses the shared projection across all six authorities and admits useful input-dependent candidates", async () => {
    const runtime = createSourceOnlyScceRuntime();
    const files: ScceRuntimeFixtureFile[] = [
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
        text: JSON.stringify({ name: "pump-authority-fixture", scripts: { build: "tsc -p tsconfig.json", test: "vitest run" } }),
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
    ];
    const ingested = runtime.ingest({ id: "fixture.authority-routing", rootPath: ".", files });
    const source = sourceRefLookup(ingested.analysis.sources);
    const docsRef = source("README.md");
    const pumpRef = source("src/index.ts");
    const packageRef = source("package.json");
    const spanishRef = source("docs/pump.es.md");
    const spanishVersion = ingested.sourceVersions.find(version => version.canonicalUri === "docs/pump.es.md");
    if (!spanishVersion) throw new Error("missing Spanish fixture source version");
    const promotion = runtime.promote({
      analysis: {
        ...ingested.analysis,
        summary: { body: "REPORT_TEMPLATE_BODY_SHOULD_NOT_BE_SPOKEN", sourceRefs: [docsRef, pumpRef, packageRef, spanishRef], counts: { files: files.length } },
        symbols: [
          { id: "symbol.pumpAlphaPressure", name: "pumpAlphaPressure", kind: "typescript.function", path: "src/index.ts", exported: true, sourceRef: pumpRef }
        ],
        commands: [
          { id: "command.build", name: "build", command: "pnpm run build", sourcePath: "package.json", kind: "eng.command.build", sourceRef: packageRef },
          { id: "command.test", name: "test", command: "pnpm test", sourcePath: "package.json", kind: "eng.command.validation", sourceRef: packageRef }
        ],
        routes: [{ id: "route.pump-alpha", method: "POST", path: "/api/pumps/alpha/control", filePath: "src/index.ts", handlerHint: "pumpAlphaPressure", sourceRef: pumpRef }],
        contradictions: [{
          id: "finding.contradiction.pressure",
          kind: "workspace.finding.contradiction",
          severity: "high",
          statement: "The same timestamp contains incompatible 42 kPa and 57 kPa measurements.",
          sourceRefs: [docsRef],
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
          sourceRefs: [pumpRef, packageRef],
          affectedFiles: ["src/index.ts"],
          suggestedFix: "Add and validate a typed route guard.",
          confidence: 0.82,
          metadata: { patchKind: "source_edit_plan" }
        }]
      }
    });

    const cases: Array<{
      behavior: string;
      authority: RequestedAuthority;
      text: string;
      coefficients?: Partial<Record<TurnRequirementDimension, number>>;
      targetLanguage?: string;
    }> = [
      { behavior: "explain", authority: "reasoned", text: "Explain why the contradictory measurements require reconciliation.", coefficients: { inferentialDepth: 4, causalReasoningDemand: 3 } },
      { behavior: "report", authority: "factual", text: "What API route controls pump alpha?", coefficients: { externalTruthAuthority: 4, sourceDependence: 3 } },
      { behavior: "compare", authority: "reasoned", text: "Compare the two pump measurements at the same timestamp.", coefficients: { inferentialDepth: 4, sourceDependence: 2 } },
      { behavior: "plan", authority: "action", text: "Prepare a build validation action without executing it.", coefficients: { actionCommitment: 4, executableArtifactDemand: 1.5 } },
      { behavior: "repair", authority: "program", text: "Add a typed route guard in src/index.ts.", coefficients: { executableArtifactDemand: 4, formatConstraintStrength: 2 } },
      { behavior: "invention", authority: "creative", text: "Write a fictional two-sentence story about a purple pump that learns to sing.", coefficients: { noveltyDemand: 4, counterfactualDemand: 2 } },
      { behavior: "translation", authority: "translation", text: "Pump alpha is stable.", targetLanguage: "lang.es" }
    ];
    const turns = [];
    for (const row of cases) {
      let turn;
      try {
        turn = await runtime.simulateTurn({
          promotionId: promotion.replayTraceId,
          conversationId: "conversation.authority-matrix",
          text: row.text,
          targetLanguage: row.targetLanguage,
          languageProfiles: row.targetLanguage ? [{
            id: "lang.es",
            sourceVersionId: spanishVersion.sourceVersionId,
            scripts: [{ script: "Latin", mass: 1 }],
            symbolShapes: [],
            charNgrams: [{ ngram: "est", count: 1 }, { ngram: "sta", count: 1 }],
            direction: "ltr",
            entropy: 0.1,
            createdAt: 1
          }] : undefined,
          requirementActivations: row.coefficients ? [{
            id: `activation.fixture.${row.behavior}.v1`,
            kind: "frame",
            activation: 1,
            confidence: 1,
            semanticRoleId: `role.fixture.${row.behavior}.v1`,
            learnedFrameOrPatternId: `frame.fixture.${row.behavior}.v1`,
            requirementCoefficients: row.coefficients,
            trace: { source: "structured_fixture_activation" }
          }] : undefined
        });
      } catch (error) {
        throw new Error(`${row.behavior}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const repeated = projectRequestAuthority({
        requirementField: turn.trace.requirementField
      });
      const decision = turn.trace.requestedAuthorityDecision as Record<string, unknown>;
      expect(turn.requestedAuthority, row.behavior).toBe(row.authority);
      expect(turn.trace.requestedAuthority, row.behavior).toBe(row.authority);
      expect(decision.explicitOverride, row.behavior).toBe(false);
      expect(decision.projectedAuthority, row.behavior).toBe(repeated.projectedAuthority);
      expect(decision.scores, row.behavior).toEqual(repeated.scores);
      expect(repeated.requestedAuthority, row.behavior).toBe(turn.trace.requestedAuthority);
      expect(turn.trace.operatorActivations.some(operator => operator.active), row.behavior).toBe(true);
      if (turn.selectedCandidate) {
        expect(candidateKinds[row.authority], `${row.behavior}: ${JSON.stringify(turn.workspace.audit)}`).toContain(turn.selectedCandidate.kind);
      } else {
        expect(turn.trace.authorityMotion.stateId, row.behavior).toBe("motion.learning_then_replan.v1");
      }
      expect(turn.workspace.mouthInput.speakInput.semanticInput?.slots.length, row.behavior).toBeGreaterThan(0);
      expect(turn.answer, row.behavior).not.toContain("[scce:");
      expect(validateScceRuntimeTurnTrace(turn.trace), row.behavior).toEqual({ valid: true, diagnostics: [] });
      turns.push({ ...row, turn });
    }

    expect(new Set(turns.map(row => JSON.stringify(row.turn.workspace.mouthInput.speakInput.semanticInput))).size).toBeGreaterThanOrEqual(5);
    const invention = turns.find(row => row.behavior === "invention")!.turn;
    expect(invention.selectedCandidate?.force).toBe("invented");
    expect(invention.answer.trim().length).toBeGreaterThan(0);
    expect(invention.answer).not.toMatch(/(?:^|\s)(?:sym:[^\s|]+|bi:[^\s|]+\|[^\s|]+|tri:[^\s|]+\|[^\s|]+\|[^\s|]+|char:\S+)(?:$|\s)/u);
    expect(invention.answer).not.toMatch(/(?:node|edge|relation|hyperedge)_[0-9a-f]{24,}/iu);
    expect(invention.answer).not.toContain("language_memory");
    const inventionRequest = cases.find(row => row.behavior === "invention")!.text;
    const requestUnits = inventionRequest.normalize("NFKC").toLocaleLowerCase().match(/[\p{Letter}\p{Number}_-]+/gu) ?? [];
    const normalizedInvention = invention.answer.normalize("NFKC").toLocaleLowerCase();
    expect(requestUnits.filter(unit => [...unit].length >= 3).some(unit => normalizedInvention.includes(unit))).toBe(true);
    for (const sourceSentence of files
      .flatMap(file => file.text.split(/(?<=[.!?])\s+|\r?\n+/u))
      .map(sentence => sentence.trim())
      .filter(sentence => [...sentence].length >= 16)) {
      expect(invention.answer).not.toContain(sourceSentence);
    }
    const action = turns.find(row => row.behavior === "plan")!.turn;
    expect(action.selectedCandidate?.kind).toBe("action-preview");
    expect(action.workspace.mouthInput.speakInput.answerDraft).toBe("");
    const selectedCommand = action.workspace.entailment.claim.text;
    expect(["pnpm run build", "pnpm test"]).toContain(selectedCommand);
    expect(action.selectedCandidate?.evidenceIds).toEqual([]);
    expect(action.workspace.entailment.evidenceIds).toEqual([]);
    expect(action.workspace.mouthInput.speakInput.evidence.map(span => String(span.id))).toEqual([packageRef.evidenceSpanId]);
    const actionSurface = JSON.stringify(action.workspace.mouthInput.speakInput.semanticInput).toLocaleLowerCase();
    expect(actionSurface).toContain(selectedCommand);
    expect(actionSurface).not.toContain("prepare a build validation action");
    expect(action.workspace.mouthInput.speakInput.construct.edges.length).toBeGreaterThan(0);
    const actionNode = action.workspace.mouthInput.speakInput.construct.nodes.find(node => node.kind === "construct:action_plan");
    expect(actionNode?.kind).toBe("construct:action_plan");
    expect(actionNode?.label).toBe(selectedCommand);
    expect(actionNode?.label).not.toContain("Prepare a build validation action");
    expect(actionNode?.metadata).toMatchObject({
      requestedAuthority: "action",
      actionPlan: {
        phase: "prepare",
        status: "planned",
        actionReceiptId: null,
        semanticSlot: { command: selectedCommand }
      }
    });
    expect(action.workspace.mouthInput.speakInput.semanticInput?.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: "mouth.role.action.command", value: { command: selectedCommand } })
    ]));
    const repair = turns.find(row => row.behavior === "repair")!.turn;
    expect(["program-proposal", "workspace-proposal"]).toContain(repair.selectedCandidate?.kind);
    expect(repair.workspace.program.programGraph?.id).toBeTruthy();
    const translation = turns.find(row => row.behavior === "translation")!.turn;
    expect(translation.workspace.mouthInput.speakInput.selectedCandidate).toBeUndefined();
    expect(translation.workspace.mouthInput.speakInput.semanticInput?.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: "mouth.role.translation.target" })
    ]));
    expect(JSON.stringify(translation.workspace.mouthInput.speakInput.construct.nodes)).toContain("preservation");
    expect(translation.workspace.mouthInput.speakInput.construct.nodes.some(node => node.kind === "construct:translation")).toBe(true);
    expect(translation.answer).not.toContain("REPORT_TEMPLATE_BODY_SHOULD_NOT_BE_SPOKEN");
  });
});

const candidateKinds: Record<RequestedAuthority, string[]> = {
  factual: ["proof-answer", "ccr-extractive"],
  reasoned: ["reasoned-synthesis", "ccr-extractive", "graph-inference", "causal-inference", "temporal-inference", "counterfactual-response"],
  creative: ["creative-candidate"],
  translation: ["translation"],
  program: ["program-proposal", "workspace-proposal"],
  action: ["action-preview"]
};

function sourceRefLookup(sources: readonly WorkspaceCoreSourceFileInput[]): (targetPath: string) => WorkspaceCoreSourceRef {
  return targetPath => {
    const source = sources.find(item => item.path === targetPath);
    if (!source?.evidenceIds?.[0] || !source.contentHash) throw new Error(`missing source ref for ${targetPath}`);
    return { path: source.path, lineStart: 1, evidenceSpanId: source.evidenceIds[0], contentHash: source.contentHash };
  };
}
