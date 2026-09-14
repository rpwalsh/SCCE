// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  dialogueInterpretationAdjustmentsForConversation,
  userCorrectionFromOutcome,
  type ConversationOutcomeRecord
} from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const liveDatabaseUrl = process.env.SCCE_TEST_DATABASE_URL?.trim();

// This is intentionally gated like the other real-Postgres tests in this
// directory. It exercises a disposable schema against PostgreSQL; no query
// fixture or in-memory replacement can prove the JSONB round trip.
describe("Postgres typed dialogue correction durability", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "round-trips a UserCorrectionRecord and reloads its typed adjustment after adapter recreation",
    async () => {
      const schema = `scce_dialogue_feedback_${randomUUID().replaceAll("-", "")}`;
      let first: PostgresStorageAdapter | undefined = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema });
      let recreated: PostgresStorageAdapter | undefined;
      try {
        await first.migrate();
        const outcome: ConversationOutcomeRecord = {
          id: `conversation_outcome.live.${randomUUID()}`,
          conversationId: `conversation.live.${randomUUID()}`,
          turnId: "turn.corrected",
          promptHash: "prompt.live",
          responseHash: "response.live",
          corrected: true,
          requestedConstraintRefs: [],
          satisfiedConstraintRefs: [],
          failedConstraintRefs: [],
          scoreTraceRefs: [],
          createdAt: new Date(1_000).toISOString()
        };
        const correction = userCorrectionFromOutcome({
          outcome,
          correctionText: "The second typed referent was intended.",
          interpretationCorrection: {
            semanticRoleIds: ["role.live.subject"],
            requestedSlotIds: ["slot.live.subject"],
            learnedFrameIds: ["frame.live.lookup"],
            scopeIds: ["scope.live"],
            rejectedReferentIds: ["referent.live.rejected"],
            preferredReferentIds: ["referent.live.preferred"],
            supportMass: 0.8,
            contradictionMass: 0.7
          },
          now: 2_000
        });
        await first.dialogueMemory.putUserCorrection(correction);
        const persisted = await first.dialogueMemory.listUserCorrections!({ conversationId: outcome.conversationId, limit: 4 });
        expect(persisted).toHaveLength(1);
        expect(persisted[0]).toEqual(correction);

        await first.close();
        first = undefined;
        recreated = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema });
        const adjustments = await dialogueInterpretationAdjustmentsForConversation(recreated.dialogueMemory, outcome.conversationId);

        expect(adjustments).toHaveLength(1);
        expect(adjustments[0]).toMatchObject({
          semanticRoleIds: ["role.live.subject"],
          preferredReferentIds: ["referent.live.preferred"],
          correctionIds: [correction.id]
        });
      } finally {
        if (recreated) {
          await recreated.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
          await recreated.close().catch(() => undefined);
        }
        if (first) {
          await first.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
          await first.close().catch(() => undefined);
        }
      }
    }
  );
});
