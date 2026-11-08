# Add task and language coverage

The seal, collector and graders have no natural/formal-language whitelist. A language is a preregistered cell key, not a scoring rule. The default case factory has a finite source/toolchain inventory; adding a name to its inventory without an actual provider correctly creates missing coverage. Use the existing external-plan/pool path for additional languages or task families. Do not change the gold scorer or remove existing difficult cells.

1. Before freezing implementation, add the required `(category, language, grading)` cells to the independent coverage JSON and the plan. Retain all admitted/declared languages. Use `human` for conversational/creative quality, `semantic` for an exact typed answer contract, and `native` for the language's real compiler/test/behavior checks. Autonomous planning and execution of a supplied plan are separate categories.
2. Implement and pin a provider/factory plus public source snapshots, the actual native toolchain executable/version/hash, and every new adapter dependency. The [native bridge contract](adapters/README.md) already supports declared file artifacts/public native checks: supply the new language's actual source files, immutable driver, callable specification, allowed target paths and exact tool argv. A supported product route must perform the work. An unsupported producer is a failed outcome, not a reason to omit the cell or emit a template. If a new product operation needs an adapter change, make and freeze that change before selection.
3. The custodian runs the frozen provider with a fresh secret seed after implementation freeze. It emits a lexicographically ID-sorted JSONL pool; selection, sharding, resume and anonymous ballots use the existing protocol. Stream bounded shards for large source inventories. The provider never receives system answers, and its private checks/gold remain outside both public roots and source ingestion.
4. Use the same source text/files/docs, tool capabilities, public-feedback tests and budgets for both systems. An update appears only in its later public step. The default native bridges receive an explicit typed operation in `public.outputContract`; raw natural-language chat remains the ordinary turn route. Language labels do not override SCCE's learned identity or prove the source was acquired. Keep the actual finalization and source-admission receipts.
5. Run the unchanged commands below. Both sides' task failures, unsupported operations, missing/ungraded cells and losses remain visible per language/category. Independent human ballots are required for chat/creative quality. A new provider's native constraints do not substitute for those ballots.

An external pool row has this shape; `private` is never copied into the public packet:

```json
{
  "id":"OPAQUE_SOURCE_AND_SEED_DERIVED_ID",
  "category":"code_repair_stateful",
  "language":"ADDITIONAL_FORMAL_LANGUAGE",
  "grading":"native",
  "public": {
    "outputContract":"JSON_STRING_OF_THE_SHARED_NATIVE_TASK_CONTRACT",
    "steps":[{"prompt":"PUBLIC_TASK_IN_THE_DECLARED_LANGUAGE","sources":[{"id":"public-spec","text":"PUBLIC_SPECIFICATION"}],"files":{"src/module.ext":"PUBLIC_STARTING_SOURCE","driver.ext":"IMMUTABLE_PUBLIC_DRIVER"}}]
  },
  "private": {
    "kind":"native",
    "argv":["ABS_PINNED_VALIDATOR_EXECUTABLE","heldout-driver.ext"],
    "files":[{"path":"ABS_PRIVATE_VALIDATOR_FILE","target":"heldout-driver.ext"}]
  }
}
```

Use real frozen paths/content; this is a structural example, not an implemented language provider. Holdout checks must exercise unseen values/boundaries and preserve the declared API/scope. The validator runs only after both outputs are fixed. Exact semantic checks use `private:{"kind":"semantic","expected":[COMPLETE_EXPECTED_JSON_PER_STEP]}`; keep supported answers and true unknowns mixed without a public positive/negative label. Human rows use `private:{"kind":"human","dimensions":[...],"rubric":"..."}` and independent anonymous ratings.

```powershell
node tools/blind-comparison/cli.mjs freeze --plan external-plan.json --out external-freeze.json
# Custodian creates its provider pool/seed after retaining this freeze digest.
node tools/blind-comparison/cli.mjs seal --freeze external-freeze.json --freeze-digest FREEZE_SHA --pool PRIVATE_SORTED_POOL.jsonl --seed PRIVATE_SEED.txt --out sealed
node tools/blind-comparison/cli.mjs collect --bundle sealed/public/bundle.json --bundle-digest BUNDLE_SHA --out run --checkpoint-out checkpoint.json
node tools/blind-comparison/cli.mjs blind --bundle sealed/public/bundle.json --bundle-digest BUNDLE_SHA --out run --key PRIVATE_KEY.json --checkpoint checkpoint.json --checkpoint-digest CHECKPOINT_SHA --ballots ballots
node tools/blind-comparison/cli.mjs grade --bundle sealed/public/bundle.json --bundle-digest BUNDLE_SHA --out run --key PRIVATE_KEY.json --checkpoint checkpoint.json --checkpoint-digest CHECKPOINT_SHA --report report.json
```

No ratings means human cells remain ungraded. Add the existing ratings arguments only after real independent judging. The same public bundle and checkpoint support bounded shard/resume; do not change the code, toolchain, provider, selection pool, resource policy or acceptance rule mid-campaign. A fix requires a new freeze and fresh holdout selection. See [process measurement](PROCESS-RESOURCES.md) for frozen, declared server/database/model process scopes; unsupported measurement stays unknown.
