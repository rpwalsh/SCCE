import { describe, expect, it } from "vitest";
import {
  compileLanguageTrainingBatch,
  createClock,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine,
  createLanguageMemoryRuntime
} from "../index.js";

describe("shared language training batch", () => {
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 140_000, stepMs: 1 });
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "language-training-batch" });
  const language = createLanguageAcquisitionEngine({ idFactory: ids });
  const runtime = createLanguageMemoryRuntime({ idFactory: ids, hasher });

  it("processes input beyond symbolizeData's historical 200k-symbol prefix as bounded model chunks", () => {
    const sentence = "alpha beta gamma delta. ";
    const text = sentence.repeat(Math.ceil(310_000 / sentence.length)).slice(0, 310_000);
    const sourceVersionId = ids.sourceVersionId(text);
    const profile = language.acquire({ sourceVersionId, text, createdAt: 140_000 });
    const compiled = compileLanguageTrainingBatch({
      runtime,
      hasher,
      batch: {
        streamId: "fixture://large-language-source",
        profile,
        sourceVersionId,
        text,
        evidence: [],
        createdAt: 140_000,
        maxOrder: 3,
        maxCountersPerOrder: 64,
        vocabularyLimit: 512
      }
    });

    const audit = compiled.audit as Record<string, unknown>;
    expect(audit.completeInputCoverage).toBe(true);
    expect(audit.inputUtf16Length).toBe(text.length);
    expect(audit.chunks).toBeGreaterThan(1);
    expect(compiled.models).toHaveLength(audit.chunks as number);
    expect(new Set(compiled.models.map(model => model.streamId)).size).toBe(audit.chunks);
  });
});
