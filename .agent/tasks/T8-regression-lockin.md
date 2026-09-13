# T8-regression-lockin

status: open
claimed_by:

Today's fixes have no tests. Lock in the corpus-identity arbiter, cache sizing by content, single-flight hydration, and the prompt-echo refusal so they cannot silently regress.

Offline only. Do NOT start or restart the server; one server and one database are shared.
Read-only SQL is parallel-safe. Credentials live in the untracked local config; never print them.
