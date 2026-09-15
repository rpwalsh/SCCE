# T21-withheld-turn-has-no-surface

status: open
claimed_by:

With T19's carry closed, a sparse chat turn withholds correctly and then has nothing to say: offline at the T19 fix,
"fuck off" and "thanks" return the empty string and "no thats wrong" returns "wrong" -- a single request unit echoed
back. `graph.resolve.pool_admission` reports `pool: 2, admitted: 0`, so the withholding itself is right and typed; the
emission is not. The same empty surface appears with no discourse metadata at all, so this predates T19.

Needed: a withheld turn emits a typed withhold (reason id + what it looked for), not "" and not an echo of the
request's own units. No canned reply string -- the surface must be built from the turn's own record.
