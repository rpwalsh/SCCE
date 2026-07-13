# Evaluator air-gap checklist

- [ ] Source/build/brain environment frozen and hashed.
- [ ] Sealed corpus and questions not present before freeze.
- [ ] Network adapters disabled or explicit allowlist recorded.
- [ ] DNS and proxy environment variables cleared where required.
- [ ] No hosted-model/API credentials present in local-only condition.
- [ ] Process and service inventory captured.
- [ ] System clock and evaluation clock policy recorded.
- [ ] Removable-media handling recorded.
- [ ] Inputs mounted read-only where practical.
- [ ] Output directory append-only for runner account where practical.
- [ ] Screen/observer record policy agreed before run.
- [ ] Seal verification passed.
- [ ] Custody event appended immediately before execution.
- [ ] Filesystem staging is not counted as process, network, or operating-system isolation.
- [ ] If patch validation executes repository code, an attested sandbox runner is active; the current trusted-host policy is not sufficient.
