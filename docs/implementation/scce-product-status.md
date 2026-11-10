# SCCE implementation checkpoint

Updated November 9, 2026. Current priority: qualify ingestion and persistent learned state, build a fresh brain, start the server, then run the local Qwen2.5:3b comparison.

## Storage and construction decisions

- **10× storage amplification is an optimization goal, not an acceptance gate.** Exact reconstruction, evidence ownership, bounded resources and working language behavior remain requirements.
- PostgreSQL remains the native store. No hosting, deployment, new inference backend or browser migration is part of this checkpoint.
- Lexical JOIN compilation, prediction, storage and public exports have been retired. Their replacements are learned ordered literal/slot constructions, explicit document layout, independent complete segmentation DAGs, and KN proposal/scoring. The DAG representation preserves ordered parallel arcs, exact Float64 energies, source windows and normalization contracts.
- The role/request page layout was rejected after native measurements showed increased allocation. Its default integration and tables were removed. The slow semantic dictionary experiment was also reverted.
- Creative source observations share typed definitions while retaining every occurrence. Dialogue preparation shares immutable provenance objects instead of copying them for each feature.
- The generic language-artifact codec preserves decoded byte accounting through patterns, full induced records and replay events. A fresh build uses schema version33.

## Verification

`pnpm build` passes. The integrated Mouth/creative check passes54tests, including complete Russian human-source acquisition, an unseen substituted name, source revocation, and the shared section API. Native storage/replay boundary checks and complete-DAG round trips pass separately. The full unit sweep and a fresh persistent brain build are next; a focused fixture is not a whole-product comparison.

The selected creative cohort measured2,334,720B before typed factoring and598,016B afterward, including that pattern table's copied indexes, with exact cold reconstruction. The separate paired17,248B human-source fixture contains385patterns: pattern payload relations and primary keys measured3,031,040B unencoded versus2,342,912B with the generic codec. Other brain tables and common metadata columns are excluded from that second measurement. These savings must not be added or presented as whole-brain amplification.

Reproduce the second measurement after building:

```powershell
node --max-old-space-size=768 tools/measure-language-artifact-storage.mjs --config <local-config.json> --output <receipt.json>
```

The tool compiles the complete pinned fixture, writes session-temporary tables, measures their physical PostgreSQL allocations, cold-restores every logical artifact, and rolls back the data writes. Application tables are untouched.

## Local continuation

Detailed receipts and the frozen402-input source manifest are under `.scce/verification/brain-build/`. The previous diagnostic brain is `scce_brain_20261109_r003`; its ingestion was stopped before these compiler changes. Its learned data must not be resumed or copied into the new build. The complete manifest covers29Wikipedia pages,128Dolly files,230OASST files and15Gutenberg books; it is not the full Wikipedia archive.

After the current full sweep and native publisher checks pass: select a new physical database, bind the manifest and stage plans to the final source revision and compiled identity, ingest every declared source, verify publication, start the exact build's server and run the blind comparison campaign. Qwen is a local comparator only. No comparative capability result has been produced by this checkpoint.
