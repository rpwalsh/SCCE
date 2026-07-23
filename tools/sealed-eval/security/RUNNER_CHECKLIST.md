# Runner checklist

- [ ] Confirm run ID and preregistration hash.
- [ ] Verify source, build, brain, corpus, and question hashes.
- [ ] Capture environment and hardware.
- [ ] Confirm randomization seed is custodian supplied.
- [ ] Confirm system manifests and resource limits.
- [ ] Run without manual interaction with answers.
- [ ] Preserve raw stdout/stderr and failures.
- [ ] Hash raw results before blinding.
- [ ] Record every retry and deviation.
- [ ] Do not reveal system aliases to judges.
- [ ] Confirm the selected SCCE brain lifecycle row is `ACTIVE` and uniquely active.
- [ ] For coding repositories, use an attested isolation boundary; do not treat `trusted-host-pnpm-validate.v1` as an OS sandbox.
- [ ] Confirm the SCCE coding adapter exists before scheduling coding tasks; it is absent in the current checkout.
