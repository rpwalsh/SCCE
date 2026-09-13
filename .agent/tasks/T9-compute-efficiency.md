# T9-compute-efficiency

status: open
claimed_by:

G9 — the compute-efficiency proxy was promised as a table and never produced. Every turn trace already records cpuUserMs, cpuSystemMs, peakResidentSetBytes and wallClockMs. Build the table from traces already on disk.

Offline only. Do NOT start or restart the server; one server and one database are shared.
Read-only SQL is parallel-safe. Credentials live in the untracked local config; never print them.
