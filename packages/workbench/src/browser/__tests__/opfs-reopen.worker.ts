/// <reference lib="webworker" />
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import { createPortableCognitiveRuntime } from "@scce/kernel/dist/browser-cognitive-runtime.js";
import { openBrowserStateRepository } from "../sqlite-opfs.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;

void run().then(result => scope.postMessage(result), error => scope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }));

async function run(): Promise<Record<string, unknown>> {
  const cognitive = createPortableCognitiveRuntime();
  const sourceBytes = new TextEncoder().encode("The Meridian Observatory opened in 1912. It houses a brass telescope.");
  const learned = cognitive.learnSource({
    namespace: "browser-opfs-test",
    canonicalUri: "urn:scce:test:meridian-observatory",
    mediaType: "text/plain",
    sourceBytes,
    observedAt: 1_794_355_200_000,
    title: "Meridian Observatory"
  });
  const first = await openBrowserStateRepository({ filename: "/scce/browser-opfs-reopen-test-v2.sqlite3" });
  first.putSource(learned);
  const firstEpoch = first.epoch;
  await first.close();

  const reopened = await openBrowserStateRepository({ filename: "/scce/browser-opfs-reopen-test-v2.sqlite3" });
  const restored = reopened.loadSources().find(source => String(source.source.sourceVersionId) === String(learned.source.sourceVersionId));
  if (!restored) throw new Error("source was not restored after OPFS reopen");
  const answer = cognitive.answer({ requestText: "When did the Meridian Observatory open?", sources: [restored] });
  const result = {
    ok: answer.status === "resolved"
      && answer.answer === "The Meridian Observatory opened in 1912."
      && String(restored.evidence.id) === String(learned.evidence.id)
      && equalBytes(restored.sourceBytes, sourceBytes),
    firstEpoch,
    reopenedEpoch: reopened.epoch,
    sourceVersionId: restored.source.sourceVersionId,
    evidenceId: restored.evidence.id,
    exactBytes: equalBytes(restored.sourceBytes, sourceBytes),
    answerStatus: answer.status,
    answer: answer.answer,
    grounding: answer.proof?.grounding ?? null
  };
  await reopened.close();
  return result;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}
