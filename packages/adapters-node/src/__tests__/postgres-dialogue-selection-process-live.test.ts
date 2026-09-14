// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createDiscourseProvenanceBindingV2,
  createDiscourseTurnObservationV2,
  createDialogueCognitiveMemoryV2,
  createHasher,
  createDiscourseInterpretationAdjustmentV2,
  resolveDiscourseStateV2,
  userCorrectionFromOutcome,
  type ConversationOutcomeRecord
} from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const execFileAsync = promisify(execFile);
const liveDatabaseUrl = process.env.SCCE_TEST_DATABASE_URL?.trim();

/**
 * This test is deliberately process-bound: each child imports the built
 * runtime and reconstructs state from PostgreSQL, so a module-local or
 * in-memory correction cannot satisfy the acceptance criterion.
 */
describe("Postgres process-bound typed dialogue selection", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "changes the visible selected answer after a durable correction reload",
    async () => {
      const schema = `scce_dialogue_selection_${randomUUID().replaceAll("-", "")}`;
      const conversationId = `conversation.process.${randomUUID()}`;
      const adapter = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema });
      try {
        await adapter.migrate();
        const hasher = createHasher();
        const resolved = createFixtureState(conversationId, hasher);
        const memory = createDialogueCognitiveMemoryV2({ store: adapter.dialogueMemory, hasher });
        await memory.persist(resolved.state, 1_000, null);

        const baseline = await runChild({ schema, conversationId });
        expect(baseline.selectedId).toBe("candidate.a");
        expect(baseline.answer).toBe("answer A");
        expect(baseline.adjustmentIds).toEqual([]);

        const outcome: ConversationOutcomeRecord = {
          id: `conversation_outcome.process.${randomUUID()}`,
          conversationId,
          turnId: resolved.state.turnId,
          promptHash: "prompt.process",
          responseHash: "response.process",
          corrected: true,
          requestedConstraintRefs: [],
          satisfiedConstraintRefs: [],
          failedConstraintRefs: [],
          scoreTraceRefs: [],
          createdAt: new Date(1_100).toISOString()
        };
        const correction = userCorrectionFromOutcome({
          outcome,
          correctionText: "The second typed referent was intended.",
          interpretationCorrection: {
            semanticRoleIds: ["role.process.subject"],
            requestedSlotIds: ["slot.process.subject"],
            learnedFrameIds: ["frame.process.lookup"],
            scopeIds: ["scope.process"],
            rejectedReferentIds: ["referent.a"],
            preferredReferentIds: ["referent.b"],
            supportMass: 0.95,
            contradictionMass: 0.95
          },
          now: 1_200
        });
        await adapter.dialogueMemory.putUserCorrection(correction);
        const expectedAdjustment = createDiscourseInterpretationAdjustmentV2({
          semanticRoleIds: ["role.process.subject"],
          requestedSlotIds: ["slot.process.subject"],
          learnedFrameIds: ["frame.process.lookup"],
          scopeIds: ["scope.process"],
          rejectedReferentIds: ["referent.a"],
          preferredReferentIds: ["referent.b"],
          supportMass: 0.95,
          contradictionMass: 0.95,
          correctionIds: [correction.id]
        });
        const persistedAdjustment = (correction.preferenceDeltaJson as Record<string, unknown>).interpretationAdjustment as Record<string, unknown>;
        expect(expectedAdjustment.id).toBe(String(persistedAdjustment.id));

        await adapter.close();
        const [firstReload, secondReload] = await Promise.all([
          runChild({ schema, conversationId }),
          runChild({ schema, conversationId })
        ]);
        for (const reloaded of [firstReload, secondReload]) {
          expect(reloaded.selectedId).toBe("candidate.b");
          expect(reloaded.answer).toBe("answer B");
          expect(reloaded.adjustmentIds).toEqual([expectedAdjustment.id]);
          expect(reloaded.auditAdjustmentIds).toEqual([expectedAdjustment.id]);
          expect(reloaded.selectedAdjustment).toBeGreaterThan(0);
        }
      } finally {
        const cleanup = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema });
        await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
        await cleanup.close().catch(() => undefined);
        await adapter.close().catch(() => undefined);
      }
    }
  );
});

async function runChild(input: { schema: string; conversationId: string }): Promise<{
  selectedId: string;
  answer: string;
  adjustmentIds: string[];
  auditAdjustmentIds: string[];
  selectedAdjustment: number;
}> {
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", CHILD_SCRIPT], {
    cwd: process.cwd(),
    env: { ...process.env, SCCE_CHILD_SCHEMA: input.schema, SCCE_CHILD_CONVERSATION: input.conversationId },
    shell: false,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(stdout.trim()) as {
    selectedId: string;
    answer: string;
    adjustmentIds: string[];
    auditAdjustmentIds: string[];
    selectedAdjustment: number;
  };
}

const CHILD_SCRIPT = String.raw`
import { createPostgresStorageAdapter } from "./packages/adapters-node/dist/index.js";
import { createDialogueCognitiveMemoryV2, dialogueInterpretationAdjustmentsForConversation, createHasher, createJudge, DEFAULT_POLICY } from "./packages/kernel/dist/index.js";
import { applyDialogueInterpretationAdjustmentsV2, typedDialoguePreselectionV2 } from "./packages/kernel/dist/production-turn-runtime.js";

const schema = process.env.SCCE_CHILD_SCHEMA;
const conversationId = process.env.SCCE_CHILD_CONVERSATION;
if (!schema || !conversationId) throw new Error("child dialogue selection inputs missing");
const adapter = createPostgresStorageAdapter({ url: process.env.SCCE_TEST_DATABASE_URL, schema });
try {
  const hasher = createHasher();
  const memory = createDialogueCognitiveMemoryV2({ store: adapter.dialogueMemory, hasher });
  const state = await memory.latest(conversationId);
  if (!state) throw new Error("child could not reload persisted cognitive state");
  const adjustments = await dialogueInterpretationAdjustmentsForConversation(adapter.dialogueMemory, conversationId);
  const ids = { role: "role.process.subject", frame: "frame.process.lookup", slot: "slot.process.subject", scope: "scope.process" };
  const selectedEvidence = [evidence("evidence.a", "Source A proof."), evidence("evidence.b", "Source B proof.")];
  const requirementField = requirementFieldFor(ids);
  const entailment = {
    mappings: [{ id: "mapping.process", obligationId: ids.slot, kind: "role", status: "satisfied", claimText: "typed claim", relation: "role_path", evidenceIds: ["evidence.a", "evidence.b"], sourceVersionIds: [ids.scope], support: 0.9, contradiction: 0, audit: {} }],
    evidenceIds: ["evidence.a", "evidence.b"]
  };
  const graph = { nodes: [graphNode("node.a", "evidence.a"), graphNode("node.b", "evidence.b")], edges: [], hyperedges: [] };
  const preselection = typedDialoguePreselectionV2({ conversationId, turnId: "turn.novel", turnIndex: state.turnIndex + 1, roleId: "session.role.owner", surfaceHash: hasher.digestHex("novel"), requirementField, entailment, graph, selectedEvidence, previousState: state, hasher });
  const field = { candidates: [candidate("candidate.a", "answer A", "evidence.a"), candidate("candidate.b", "answer B", "evidence.b")], surfaceMass: [{ candidateId: "candidate.a", mass: 0.5, reason: "fixture" }, { candidateId: "candidate.b", mass: 0.5, reason: "fixture" }], audit: {}, scoreTrace: [] };
  const adjusted = applyDialogueInterpretationAdjustmentsV2({ field, candidates: preselection.candidates, adjustments });
  const decision = createJudge({ random: () => 0 }).select({ field: adjusted, policy: DEFAULT_POLICY, requestedAuthority: "factual", requirementField });
  const audit = decision.selected.audit && typeof decision.selected.audit === "object" && !Array.isArray(decision.selected.audit) ? decision.selected.audit.typedDialogueSelection : undefined;
  const auditAdjustmentIds = audit && typeof audit === "object" && !Array.isArray(audit) && Array.isArray(audit.adjustmentIds) ? audit.adjustmentIds.map(String) : [];
  process.stdout.write(JSON.stringify({ selectedId: decision.selected.id, answer: decision.selected.answer, adjustmentIds: adjustments.map(adjustment => adjustment.id), auditAdjustmentIds, selectedAdjustment: decision.selected.selectionAdjustment ?? 0 }));
} finally {
  await adapter.close();
}

function candidate(id, answer, evidenceId) {
  return { id, kind: "proof-answer", answer, force: "proved", evidenceIds: [evidenceId], scores: { support: 0.7, contradiction: 0, faithfulness: 0.8, alphaPressure: 0, actionability: 0.7, evidenceCoverage: 0.8, novelty: 0.2, realizability: 0.8 }, boundaries: [], audit: {} };
}
function evidence(id, text) {
  return { id, sourceId: "source." + id, sourceVersionId: "scope.process", chunkId: "chunk." + id, contentHash: "hash." + id, mediaType: "text/plain", byteStart: 0, byteEnd: text.length, charStart: 0, charEnd: text.length, text, textPreview: text, languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [id], status: "promoted", alpha: 0.9, observedAt: 1 };
}
function graphNode(id, evidenceId) {
  return { id, typeId: "dimension.process", representation: {}, alpha: 0.9, evidenceIds: [evidenceId], features: [id], createdAt: 1, updatedAt: 1, metadata: {} };
}
function requirementFieldFor(ids) {
  return { externalTruthAuthority: 0.5, sourceDependence: 0.5, noveltyDemand: 0, inferentialDepth: 0, semanticPreservation: 0, surfaceTransformation: 0, executableArtifactDemand: 0, actionCommitment: 0, dialogueDependence: 0.5, uncertaintyTolerance: 0.5, formatConstraintStrength: 0, audienceAdaptation: 0, brevityDetailBalance: 0.5, temporalReasoningDemand: 0, causalReasoningDemand: 0, counterfactualDemand: 0, requiredFeatures: [{ origin: { semanticRoleId: ids.role } }], prohibitedFeatures: [], activatedFrameIds: [ids.frame], activatedPatternIds: [], activatedPhraseUnitIds: [], activatedDialogueMoveIds: [], activatedConstructIds: [], confidence: 1, trace: {} };
}
`;

function createFixtureState(conversationId: string, hasher: ReturnType<typeof createHasher>) {
  const observation = createDiscourseTurnObservationV2({
    conversationId,
    turnId: "turn.persisted",
    turnIndex: 1,
    roleId: "session.role.owner",
    surfaceHash: hasher.digestHex("persisted"),
    learnedFrameIds: ["frame.process.lookup"],
    requestedSlotIds: ["slot.process.subject"],
    explicitAnchorNodeIds: ["node.a", "node.b"],
    scopeIds: ["scope.process"],
    mentions: [{
      schema: "scce.discourse_mention.v2",
      id: "mention.persisted",
      span: { start: 0, end: 6 },
      kindId: "mention.typed",
      surfaceHash: hasher.digestHex("mention.persisted"),
      semanticRoleIds: ["role.process.subject"],
      requestedSlotIds: ["slot.process.subject"],
      learnedFrameIds: ["frame.process.lookup"],
      candidateNodeIds: ["node.a", "node.b"],
      candidateReferentIds: ["referent.a", "referent.b"],
      scopeIds: ["scope.process"]
    }]
  }, hasher);
  const referents = [referent("referent.a", "node.a", "claim.a"), referent("referent.b", "node.b", "claim.b")];
  const provenanceBindings = referents.map(item => createDiscourseProvenanceBindingV2({
    observationId: observation.id,
    mentionId: "mention.persisted",
    referentId: item.id,
    routeId: `route.${item.id}`,
    nodeIds: item.nodeIds,
    claimIds: item.claimIds,
    evidenceIds: item.evidenceIds,
    sourceVersionIds: item.sourceVersionIds,
    contradictionIds: []
  }, hasher));
  return resolveDiscourseStateV2({
    observation,
    referents,
    topics: [topic("topic.a", "referent.a", "node.a", "claim.a"), topic("topic.b", "referent.b", "node.b", "claim.b")],
    routeSignals: referents.map(item => ({ mentionId: "mention.persisted", referentId: item.id, graphRouteCoherence: 1, evidenceFit: 1, scopeFit: 1 })),
    provenanceBindings,
    hasher
  });
}

function referent(id: string, nodeId: string, claimId: string) {
  return {
    schema: "scce.discourse_referent.v2" as const,
    id,
    topicId: id.replace("referent", "topic"),
    introducedTurnId: "turn.persisted",
    introducedTurnIndex: 1,
    lastMentionTurnIndex: 1,
    nodeIds: [nodeId],
    claimIds: [claimId],
    relationIds: ["relation.process"],
    evidenceIds: [`evidence.${id.slice("referent.".length)}`],
    sourceVersionIds: ["scope.process"],
    contradictionIds: [],
    semanticRoleIds: ["role.process.subject"],
    learnedFrameIds: ["frame.process.lookup"],
    scopeIds: ["scope.process"],
    slotBindings: [{ slotId: "slot.process.subject", nodeIds: [nodeId], claimIds: [claimId], evidenceIds: [`evidence.${id.slice("referent.".length)}`] }],
    salienceMass: 0.7,
    evidenceSupportMass: 0.9,
    contradictionMass: 0,
    authorityClassId: "authority.source"
  };
}

function topic(id: string, referentId: string, nodeId: string, claimId: string) {
  return { schema: "scce.discourse_topic.v2" as const, id, statusId: "topic.active", anchorNodeIds: [nodeId], referentIds: [referentId], claimIds: [claimId], evidenceIds: [`evidence.${referentId.slice("referent.".length)}`], supersedesTopicIds: [], salienceMass: 0.7, lastTurnIndex: 1 };
}
