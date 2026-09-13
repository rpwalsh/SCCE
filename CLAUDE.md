# SCCE agent rules

SCCE is a TypeScript cognitive engine. It contains no language model and never will.

- Do not introduce an LLM, a model API, or a model dependency of any kind.
- No casing rules, English suffix lists, word-position rules, or hand-set magic numbers.
  Decisions derive from the corpus's own measured quantities.
- Never weaken, delete, or lower the bar of a test or gate to make a change pass.
- PostgreSQL remains canonical state. Deterministic replay is preserved.
- Every behavioral fix carries a regression check that fails without the fix.
- Trace actual runtime reachability before changing behavior. Prefer `.scce/traces` over inferring from interfaces.
- Database credentials live only in the untracked local config. Never print or commit them.
- One terse comment line where a comment is needed. History belongs in commit messages.
- There is one database and one server. Never restart the server from a worktree; live verification is serialized.
