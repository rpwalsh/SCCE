# Objective and boundaries

The purpose of a sealed evaluation is to answer specific questions about SCCE with reproducible evidence:

1. Does SCCE build durable state from previously unseen material?
2. Does it answer held-out questions accurately and with exact support?
3. How does it compare with simpler systems on specified categories under equal constraints?
4. Which components materially contribute?
5. Does the result survive restart, incremental update, and adverse operating conditions?
6. Can an independent observer reproduce the run from the reviewed source and procedure?

## What a sealed evaluation cannot establish by itself

- Universal commercial or general-capability conclusions.
- Novelty or patentability.
- Safety in every deployment.
- General capability outside the preregistered tasks.
- Performance outside the sampled domains.
- Causation from an ablation unless all other execution and data conditions are controlled.

## Evidence hierarchy

1. **Reproducible raw artifacts** — source/build/brain/corpus/question hashes and raw outputs.
2. **Objective verification** — citation spans, exact keys, test results, resource records.
3. **Blind human judgments** — locked before unblinding.
4. **Paired baseline and ablation statistics**.
5. **Independent procedural attestation**.
6. **Claims derived from the above, with limitations.**

Every reported number must resolve to an artifact in the evidence package.
