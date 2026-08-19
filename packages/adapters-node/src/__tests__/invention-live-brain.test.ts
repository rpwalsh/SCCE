import { describe, expect, it } from "vitest";
import { createNodeRuntime, readScceRuntimeConfig } from "../index.js";

// The invented-narrative property lived for months as a permanent it.skip in
// packages/kernel/src/__tests__/source-only-authority-routing.test.ts, whose
// own comment proved it could never run there: a source-only runtime has no
// imported construction bundles and no trained language-memory model by
// definition, so invention-planner's only two genuine-prose paths both bail
// and the assertion set is unreachable. Production runs against the trained,
// hydrated PostgreSQL brain -- which is exactly what this package's live
// gate provides -- so the property is tested here, against the real thing,
// and the unreachable kernel skip is deleted.
const liveDatabaseUrl = (process.env.SCCE_TEST_DATABASE_URL ?? process.env.SCCE_DATABASE_URL)?.trim();

describe("invention against the live trained brain", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "invention answer is real invented narrative content, not an echo of the request",
    async () => {
      const loaded = await readScceRuntimeConfig("scce.config.json").catch(() => readScceRuntimeConfig("../../scce.config.json"));
      const connectors: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(loaded.connectors ?? {})) {
        connectors[name] = value && typeof value === "object" ? { ...(value as object), enabled: false } : value;
      }
      const runtime = createNodeRuntime({
        ...loaded,
        connectors: connectors as typeof loaded.connectors,
        database: { ...loaded.database, url: liveDatabaseUrl! }
      }, {});
      try {
        const requestText = "Write a short story about a lighthouse keeper who teaches arithmetic to seabirds.";
        const turn = await runtime.kernel.turn({ text: requestText, requestedAuthority: "creative" });

        // Non-empty invented prose, not a refusal.
        expect(turn.answer.trim().length).toBeGreaterThan(0);
        expect(turn.assistantForce).toBe("creative_answer");

        // No internal feature-namespace or graph-identifier leakage: the
        // exact defect class the original assertions were written to catch.
        expect(turn.answer).not.toMatch(/(?:^|\s)(?:sym:[^\s|]+|bi:[^\s|]+\|[^\s|]+|tri:[^\s|]+\|[^\s|]+\|[^\s|]+|char:\S+)(?:$|\s)/u);
        expect(turn.answer).not.toMatch(/(?:node|edge|relation|hyperedge)_[0-9a-f]{24,}/iu);
        expect(turn.answer).not.toContain("language_memory");

        // Topical: at least one substantive request term appears.
        const requestUnits = requestText.normalize("NFKC").toLocaleLowerCase().match(/[\p{Letter}\p{Number}_-]+/gu) ?? [];
        const normalized = turn.answer.normalize("NFKC").toLocaleLowerCase();
        expect(requestUnits.filter(unit => [...unit].length >= 4).some(unit => normalized.includes(unit))).toBe(true);

        // Not an echo: the answer is not merely the request restated.
        expect(normalized).not.toContain(requestText.toLocaleLowerCase());

        // Invented, not copied: no long sentence of the evidence it drew on
        // appears verbatim. This is the live-corpus form of the original
        // "no source sentence copied" check, scoped to the spans the turn
        // actually touched since the full corpus is not enumerable here.
        for (const span of turn.evidence) {
          for (const sentence of String(span.text ?? "")
            .split(/(?<=[.!?])\s+|\r?\n+/u)
            .map(value => value.trim())
            .filter(value => [...value].length >= 16)) {
            expect(turn.answer).not.toContain(sentence);
          }
        }
      } finally {
        await runtime.close();
      }
    },
    // Measured: a COLD creative turn costs ~81s after the hydration-key,
    // byte-budget-window, and observation-prefetch fixes (was 651s). 3x
    // margin over that measurement -- a timeout generous enough to hide a
    // regression back to minutes would defeat the point of having one.
    240_000
  );
});
