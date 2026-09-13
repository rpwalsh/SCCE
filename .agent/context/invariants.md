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
