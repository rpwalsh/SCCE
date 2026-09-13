# T2 Source summary quality and wiring

status: done
claimed_by: worktree-agent-a2ad781442cbce732
findings: .agent/findings/T2.md

## Problem

The corpus holds Moby Dick's full text but no article about it, so "tell me the plot of moby dick" declines: the
answerhood gate needs the request's relation in the answering sentence and a novel's prose never says "plot".

`packages/kernel/src/source-summary.ts` now exists and runs in under 80 ms: sentence similarity graph, inverse
sentence frequency weights, degree centrality, Otsu thresholds for both which similarities count as edges and which
centralities count as central. Verified working on real book spans.

Two things remain.

1. Quality. On Gutenberg books it selects front matter: the "Extracts" quotation list in Moby Dick, an editor's
   critical introduction in Pride and Prejudice. That material is highly self-similar so it wins on centrality.
   Separate a source's own body from reprinted or editorial matter using a measured property, not a keyword list.
2. Wiring. A turn whose evidence is identity-bound to a source, and which can support no narrower answer, should
   speak the source's central sentences rather than return 422. Find that decision point in
   `packages/kernel/src/production-turn-runtime.ts` and wire it.

Every sentence spoken must be verbatim from the source. Nothing invented, nothing paraphrased.

Offline harness only: read spans with a read-only query and assert the summary. Do NOT start a server.
