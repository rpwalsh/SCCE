# Invariants

Violating any of these fails a task regardless of its other merits.

- **No language model anywhere in SCCE.** No model API, no model dependency, ever. This is the product.
- **No casing rules, English suffix lists, stopword lists, word-position rules, or hand-set magic numbers.**
  Decisions derive from measured corpus quantities. A *cost bound* (a scan limit, a window size) is allowed and
  must be commented as a cost bound so it is never mistaken for a modeling choice.
- **Never weaken, delete, or lower the bar of a test or gate** to make a change pass.
- **Never `rm -rf`.** No exceptions, including inside a trusted pre-existing script.
- PostgreSQL is canonical state. Deterministic replay is preserved.
- Every behavioural fix carries a regression check that fails without the fix.
- Database credentials live only in the untracked local config. Never printed, never committed.
- One terse comment line where a comment is needed. History goes in the commit message.
- No `Co-Authored-By` or "Generated with" trailers on commits.
- Never write the local folder name into committed content. The project is SCCE.

## The derived-threshold habit

Where a boundary is needed, this codebase splits the observed distribution with **Otsu** rather than declaring a
number: corpus concentration, language identity membership, sentence centrality, and the turn budget all do this.
Reach for that before inventing a constant. Otsu assumes two classes; on a power law it lands near the top and is
the wrong tool, which is a measured result, not a guess (see current-known-bugs.md).

## Inactive cognition must be impossible to mistake for active cognition

A subsystem that silently degrades to identity must never report itself as operational. Relation potential was
wired end to end, called on every turn, and reported `not-applicable` while returning identity, because no config
ever supplied it a model. The architecture diagram, the traces and the ablation table all looked healthy for a
mechanism that had never participated in a single turn. The ablation it invited was identity against nothing.

Report the status, never infer it from the absence of an error:

| status | meaning |
| --- | --- |
| `active` | running and doing its work |
| `bypassed_not_applicable` | running, and this input genuinely does not call for it |
| `inert_unconfigured` | wired and reachable, learned artifact missing, degrades to identity. NOT working. |
| `disabled_explicitly` | switched off on purpose |
| `failed` | attempted and failed |
| `unreachable` | no call path from a production turn |

A learned component earns `active` only with a PROMOTED artifact in hand: untrained, fitted, validated, promoted.
Presence of an optional config key is not enough.

Keep three facts separate and never collapse them into one word: whether it runs, whether its cost is measured,
and whether its contribution is measured. Query diffusion runs ten iterative operations per activation and was
unmeasured; anchor evidence search was measured at 23.3% of CPU and no change in 2,126 invocations. One needs
instrumentation, the other needs scheduling, and neither needs an algorithm change.

**Correctness is not currently the crisis. Cognitive allocation is.**

## Every deciding constant is declared, and coverage is reported not excavated

A number written inline cannot be audited, cannot be searched, and cannot be fitted. The field operators ran ten
iterative steps per activation on four such numbers for the life of the system, and no coverage report could see
them because they were never declared.

Declared constants live in `packages/kernel/src/calibrations/public-calibrations.ts`, and the search space in
`calibration-search-space.ts` is a Record over every key, so the typechecker refuses a new id that does not also
say how it would be searched. Use that: it is the only thing that made the field constants impossible to add
quietly.

`node tools/undeclared-constants.mjs` reports the rest, and the integration gate prints the coverage every run.

Count OBJECTS, not literals. Measured 2026-09-13: **165 hand-tuned weight vectors (125 of them summing to 1.0,
holding 538 individual weights) plus 626 standalone thresholds = 791 decision objects. 35 declared. One fitted
against held-out data.** A normalized weight vector is ONE calibration with one fit over a simplex, not four
independent constants, and those 125 are the highest-value target because the machinery to fit exactly that shape
already exists for the judge requirement weights.

A cost bound is legitimately inline and must say so in a comment; a modeling parameter is not. The first version of
this audit counted every literal and reported 1,929, which is the kind of number that gets a report ignored:
275 were cost bounds, and slice bounds, limits, indices and tolerances are not calibration candidates at all.

Finding constants by reading code is the smell this replaces.
