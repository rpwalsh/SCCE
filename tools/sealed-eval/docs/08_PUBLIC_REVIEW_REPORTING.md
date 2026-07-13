# Public review reporting

A public review report should be factual and navigable from every claim to raw evidence.

## Recommended executive page

- Run ID and date.
- Independent roles and conflicts.
- Source/build/brain/corpus/question seals.
- Systems and resource constraints.
- Main results by category with confidence intervals.
- Exact citation failure rate.
- Full-versus-ablation deltas.
- Performance and recovery summary.
- Negative results.
- Deviations.
- Limitations.

## Prohibited reporting

- Cherry-picked screenshots without run IDs.
- Accuracy claims without denominator and question provenance.
- Describing a review as independent when the system owner authored questions or scored answers without disclosure.
- Describing a result as proved when only a heuristic score was measured.
- Combining assisted and unassisted runs.
- Omitting failures or underpowered categories.
- Extrapolating sampled results to universal intelligence, general capability, or commercial outcomes.

## Traceability

Every table cell should resolve to:

`run -> question -> raw answer -> citation verification -> judgment/objective score -> aggregation code`.

The current repository may report local build/test and synthetic rehearsal
status only. It must label the public review `NOT_EXECUTED`; it must not convert
those engineering checks into comparative, general-capability, or editor-parity
claims. Editor integration claims require a packaged extension-host run, and
coding-system comparison requires a sealed coding adapter and a source-grounded
patch-plan execution record.
