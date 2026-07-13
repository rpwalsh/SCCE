# Failure and disqualification criteria

A run is invalid or must be qualified when any of the following occurs:

- Source, build, brain, corpus, question, scorer, or configuration hash mismatch.
- Unlogged code/configuration change after sealing.
- System process can read the answer key or judgments.
- Questions were available during development or training.
- Network use violates the preregistered policy.
- Raw failures were removed or overwritten.
- Blinding was broken before judgments locked.
- Disabled ablation component executed or its cache was used.
- Different corpus bytes or questions across compared conditions.
- Manual answer editing.
- Unsupported reruns selected for reporting.
- Citation byte spans fail reconstruction above the preregistered tolerance.
- Brain import is incomplete or unvalidated.
- Test-changing coding patches were accepted without explicit authorization.

A technical interruption does not require hiding the run. Preserve it as a failed attempt, document the cause, fix the system, reseal, and run again under a new run ID.

For coding tasks, filesystem staging plus `shell:false` is not an operating-
system sandbox. The current `trusted-host-pnpm-validate.v1` policy is unsuitable
for untrusted sealed repositories. Its blocked offline-dependency rehearsal is
readiness evidence and cannot be reported as a passed coding run.
