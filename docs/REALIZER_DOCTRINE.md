# Realizer Doctrine

Decided by the project owner, 2026-08-17.

## The line

SCCE's founding ban — no LLM inference, no vector-RAG loop, no GPU
cluster, no cloud dependency — is a ban on **weights as the seat of
knowledge and claim authority**. It is not a ban on every learned
function.

Accordingly:

- **Banned, permanently**: foundation models and LLM-style models of any
  size class that carries world knowledge in parameters — local or
  cloud, open- or closed-weight. Nothing in the runtime may ever answer
  *what is true* from weights.
- **Admissible**: compact, task-specific **realizers** — learned
  functions that choose *wording* for content the evidence layer has
  already licensed.

## What makes a realizer admissible

1. **Wording-only authority.** The realizer receives claims/facts that
   the graph, proof, and entailment layers have already authorized, and
   emits surface text expressing them. It cannot add, drop, or alter a
   claim: the existing verification layer (argument integrity,
   structural completeness, entailment, citation binding, abstention)
   runs on its output exactly as on any other candidate surface. A
   realizer's failure mode is awkward wording, never a new assertion.
2. **Corpus-bound training.** Trained solely on owner-admitted corpus
   already in the evidence store, with the same provenance discipline as
   every other learned structure. No pretrained third-party weights.
3. **Small and task-specific.** Tens of millions of parameters, not
   billions. If a proposed model's capabilities would let it answer
   questions from its own weights, it is on the wrong side of the line.
4. **CPU-local inference.** Runs where SCCE runs. No accelerator or
   cloud dependency.
5. **Per-language, cluster-routed.** One realizer per deployed language,
   selected by the existing language-cluster routing; a deployment
   carries only the languages it serves. The claim layer stays
   language-neutral; the proof discipline is invariant across languages.

## Why this is the theory completed, not breached

The architecture's central separation — *what may be claimed* (evidence)
from *how it is expressed* (realization) — was always the load-bearing
idea. Count-based and construction-based realization hits a model-class
ceiling on long-range fluency that no corpus scale removes. A small
wording function under the full verification stack removes that ceiling
while preserving every property the ban protects: local, sovereign,
auditable, provable, weightless where it matters — in the knowledge.
