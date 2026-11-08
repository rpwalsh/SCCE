# Trusted-host process measurements

Declare measurements before preparing/freezing a new campaign. The runner never starts or stops SCCE, PostgreSQL or Ollama. Obtain the actual PIDs from the operator's service/process manager. Inspect only those declared processes:

```powershell
node tools/blind-comparison/process-resources.mjs inspect --pids=12345,23456,34567
```

Replace these illustrative numbers with the actual SCCE server, PostgreSQL parent and Ollama parent PIDs. This command reads OS counters; it sends no model/service request. Windows uses CIM process creation time, cumulative user/kernel CPU and working set. Linux/macOS use `ps` PID/PPID/RSS/cumulative CPU/start time. The `ps` birth timestamp has second resolution. Probe errors or unavailable counters remain unknown.

Create an operator process policy, for example `process-policy.json`:

```json
{
  "schema": "scce.blind-process-policy.v1",
  "provider": "trusted-host-native-process-table.v1",
  "sampleIntervalMs": 1000,
  "probeTimeoutMs": 3000,
  "maxProbeOutputBytes": 8388608,
  "rssBudgetBytes": 8589934592,
  "systems": {
    "scce": {"sharedDaemons": [{"id":"server","pid":12345},{"id":"postgres","pid":23456}]},
    "local-reference": {"sharedDaemons": [{"id":"ollama","pid":34567}]}
  }
}
```

Again, use actual live PIDs. Specify only the highest intended parent of each tree; descendants are included. Preparation resolves each daemon's actual birth identity, refuses absent or changed roots, and freezes the resolved policy/provider before the custodian generates the selection seed. A supplied `birth` must match exactly. Every registered system must have an entry; an empty daemon array explicitly leaves external-service coverage unmeasured. Set `rssBudgetBytes` to `null` for observation without a sampled RSS ceiling.

```powershell
node tools/blind-comparison/campaign.mjs run --out .tmp/new-resource-campaign --process-policy process-policy.json --threads 4 --device cpu
```

The optional flag also works with `prepare`. No generated freeze needs editing. In a manually authored external plan, put the resolved policy in `plan.isolation.processMeasurement`, include both system IDs, and pin the policy and this provider as isolation/implementation artifacts.

Each answer step records the new adapter process and its observed descendants separately from each declared shared-daemon tree. A shared daemon's CPU baseline is taken before the adapter starts: its lifetime CPU is never charged to an answer. Newly observed child counters are included; PID/birth mismatches, missing roots, exited observed children and unavailable counters are reported. RSS peaks are calculated from simultaneous samples, deduplicating identical process identities across overlapping declarations. They are not sums of unrelated per-process peak values.

`measured.processMeasurements` is retained on successful **and failed** receipts and copied into each report case. It contains sampled RSS, observed CPU-counter deltas, process/sample counts, missed-root/counter counts and probe elapsed time. Probe overhead contributes to collection elapsed time; `adapterWallMs` separately records child launch-to-close time. Accepted receipts resume unchanged, without measuring a later process and pretending that was the original answer.

A sampled RSS sum above the frozen ceiling produces `process-rss-budget` and stops only the answer's child/process group as supported by the existing runner. No declared daemon is killed. `not_observed_exceeded` means only that the samples did not show an excess; `unmeasured` means coverage was insufficient. Neither is proof of an enforced quota. Short-lived processes and CPU after the final observation can be missed; inaccessible probes never become zero. On Windows, killing the client does not guarantee descendant termination, and an HTTP service may continue processing after its client exits.

`totalProductRamBytes` stays `null`. RSS can count shared pages repeatedly, PostgreSQL/Ollama may serve other work, and OS cache/GPU/driver allocation is outside this measure. Ollama's separately reported model allocation remains a different quantity. The example 8 GiB **sampled process-RSS ceiling** is not an 8 GiB unique product-memory or hard OS limit. A complete 7–8 GiB product-bound claim requires an appropriate separately declared containment/accounting provider; no such claim is inferred from these samples. CPU measurements of shared daemons are observed window costs, not exclusive attribution to one request.
