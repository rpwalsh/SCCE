# Corpus identity measurement cache isolation

Owner: Codex Astra director, implementation worker `cache_implementation` (Sol).

Scope: `packages/kernel/src/corpus-identity-runtime.ts` and new
`packages/kernel/src/__tests__/corpus-identity-runtime.test.ts`.

Production caller: `production-turn-runtime.ts` calls `primeCorpusIdentityForTurn`
with `deps.storage.evidence`. The current measurement maps and threshold are
module globals with no storage identity guard. A distribution failure also fixes
the threshold at zero permanently, and reset does not fence pending work.

Intervention: isolate measurements by evidence-store object, retry failed
distribution measurement, and fence reset against pending cache writes. Preserve
successful warm caching and distinguish omitted spread from measured zero.

No shared server or database writes, installs, commits, stash, or adapter edits.
Worker runs only targeted source tests. Root owns integration checks and uses the
existing server lock for any build or broader suite.

Limit: no durable corpus revision API exists in EvidenceStore. This intervention
does not claim immediate invalidation after mutation of the same store. The
adapter's separate title cache and access-policy validity need their own repair.

Baseline checks before implementation: corpus identity arbiter and anchor binding
tests ran together, 9 passed and 1 failed. The existing failure at
`corpus-identity-arbiter.test.ts:69` expects no identity for a mixed spaced request
containing a Japanese identity with attached grammar; current production code
returns that identity. Neither the assertion nor that source is owned by this task.

No benchmark improvement is claimed by this repair. Production workload accuracy
and a fresh comparison with the reference require separate measurements.

Implemented: evidence-store WeakMap caches, retry after distribution failure,
unknown spread preservation, and reset generation checks after asynchronous work.
Worker reported all four new regression tests failing before the patch. Root
independently ran the patched test file: 4 passed, 0 failed. `pnpm build` passed.
The full `pnpm test` invocation is in progress at the snapshot commit.
