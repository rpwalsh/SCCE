# Full-system completion

Not a redesign, an audit, or a roadmap. Take the EXISTING architecture to a working end-to-end cognitive system
across ingestion, learned language, reasoning, conversation, creative generation, tool use, learning, planning,
metacognition, durable memory and evidence-grounded answering, and keep iterating until the live system
demonstrates them.

Every defect ends as FIXED, REPLACED, MADE_IRRELEVANT, or BLOCKED_BY_EXTERNAL_DEPENDENCY. "Investigated",
"documented", "found root cause" and "test fails" are not terminal.

## The contract, unchanged

```
config -> adapters/runtime -> kernel -> typed observations -> canonical durable knowledge -> graph/hypergraph
-> activation/selection -> requirements/operators -> candidates -> proof/contradiction/judge
-> bounded learn/retrieve/replan -> semantic result -> mouth -> durable turn state
```

No second cognition runtime. No LLM or RAG hiding missing capability. No prompt-orchestration framework. No
bypassing canonical ingestion. No vector database as semantic truth. Mouth never chooses facts. No embeddings
replacing typed graph semantics. No gold triples handed to the benchmark: SCCE derives its own structures from the
same raw material the competitor gets.

## No language-specific cheats, pushed all the way through

Production cognition must not depend on English word lists, stopword lists, irregular-verb lists, suffix
dictionaries, POS tables, hardcoded word order, month names, capitalization as truth, regex as semantics,
handcrafted dialogue-act labels, or handcrafted narrative categories. Regex is fine for genuinely formal surface
formats: compiler diagnostics, code syntax scaffolding, paths, numeric and protocol formats, secret redaction.

> **Heuristics may propose; learned or proven structure must dispose.**

Labels may exist in diagnostics. Production behaviour depends on opaque learned populations and formal quantities.

## Language is one joint problem, not five

`Theta = (segmentation, lexical, morphology, roles, constructions, alignment)` optimized together:

```
J = L(Theta) + L(X|Theta) + lambda*L(G|Theta) + mu*E_cycle + nu*E_intervention
E_cycle        = d_G(G, I(R(G))) + d_X(X, R(I(X)))
E_intervention = d_G( I(do(X_i <- X_i')), do(G_j <- G_j') )
```

Not one giant optimizer. The requirement is that the existing components' PROMOTION CRITERIA share these
constraints, and that promotion needs held-out gain, never training compression.

- **Segmentation**: keep `P(S | X,G,C)` plural until evidence resolves it. Boundary utility `I(b; G,C | X)`.
  Whitespace does not define words.
- **Lexical identity**: an emergent equivalence class. Promote when the shared representation lowers held-out
  joint description length on source-disjoint evidence.
- **Morphology**: `T = (dX, dG)`, a surface transformation paired with a SEMANTIC one. find/found must be
  learnable; mind/mound must fail for want of semantic correspondence. This is why orthography alone died.
- **Roles**: maximize `I(r;G)` while minimizing `I(r;position)` and `I(r;source)`. Role and realization order stay
  separate. Opaque ids, never "agent"/"patient".
- **Constructions**: reversible, `(H,dH) <-> (P,dP)`, one promoted population serving BOTH interpretation and
  realization. Boilerplate that compresses surface but explains no semantics is not grammar.
- **Closed class**: induced from an information profile, never a word list.
- **Language identity**: a latent mixture supporting code-switching within one document. Never
  `if language === "English"`.

## Remove the second parser

Find every downstream module that reads raw strings and infers entity, quantity, date, negation, relation, role,
question type, discourse intent or factual identity by regex, casing or lexical inventory. Reasoning consumes
canonical semantic observations produced upstream. Raw text downstream is for display, citation offsets, debugging
and formally-specified formats only. **Proof must not contain a secret second English parser.**

## Chat and creativity carry the same constraint

Dialogue is latent discourse state, not English act enums: `z_t ~ P(z_t | z_{t-1}, G_t, D_t)`. A discourse plan
sits between semantic content and the mouth, so the mouth never chooses what to say.

Narrative is persistent world state `S_{t+1} = F(S_t, A_t)`, with observer-specific character knowledge
`K_c subset K_author` — a character acts only from its own state unless explicitly guessing, lying, imagining or
inferring. No setup/conflict/climax template as a production primitive. Style is a learned conditional
distribution over constructions, not a syntax template with an author's name on it.

Long-form uses multiple timescales, with history cold and addressable and only the current scene hot.

## Tool use is ordinary planning

Affordances, schemas, preconditions, side effects, reversibility, permissions and provenance as structured
knowledge. Outcomes feed back into canonical cognition and change later planning. No tool output bypasses
provenance. No task-specific scripts.

## Definition of done

The same production runtime ingests heterogeneous sources, learns language, maps surface to semantics both ways,
retrieves decisively from a large brain, reasons over explicit structure, detects contradiction, answers with
exact provenance, learns persistently, holds a conversation, uses and learns tools, plans and replans, writes and
repairs code, creates coherent prose, holds long narrative state, learns from outcomes, exposes complete causal
traces, and outperforms the frozen reference on the combined benchmark.

Not "all components exist". **The whole machine works.**

## First action, and it is not an essay

A capability matrix: capability, current live result, first failing seam, oracle ceiling, reference result,
recoverable delta, owner, status. Rank by `recoverable loss * causal confidence`. Then start fixing the top seam.
Do not stop at the matrix.
