# T3 Pre-kernel latency

status: open
claimed_by:

## Problem, already evidenced

The per-turn contract is 10 s (`INITIAL_VISIBLE_RESPONSE_DEADLINE_MS` in `packages/server/src/routes.ts`). Traces
show the kernel turn beginning with only ~4.8 s left: its first checkpoint, `kernel.turn.start`, reports
`remainingMs` near 4839. So roughly 5.2 s is spent server-side between the request arriving and the kernel running,
and every later phase then runs against a half-spent budget.

Find where it goes and fix it. Read `.scce/traces/*.jsonl`: print each `runtime.deadline.check` event's
`support.observedAtMonotonicMs` relative to the turn's first one, and the non-deadline events in the same window.

Do NOT start or restart the server; the traces on disk already contain what you need. Report the measured
attribution before proposing any change.
