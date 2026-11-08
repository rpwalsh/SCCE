# Human reference annotations

The first acquisition is the development split of Spanish and Catalan UD AnCora at the exact commits in [the source catalog](../tools/coreference/source-catalog.json). These are human coreference annotations from AnCora-CO, distributed in CoNLL-U `Entity` fields. The reader projects declared identities and exact mention spans. It does not infer references from unannotated text, train a classifier, or identify replaceable name properties.

The pinned [Spanish license](https://github.com/UniversalDependencies/UD_Spanish-AnCora/blob/20adddbfcdd773c6dc97ba48ea11ca9364e74185/LICENSE.txt) and [Catalan license](https://github.com/UniversalDependencies/UD_Catalan-AnCora/blob/7f3d23e85abc0656e8e88535d28174b030eb4d20/LICENSE.txt) declare CC BY 4.0. Both pinned READMEs document the change from the older license in UD 2.9 and the AnCora-CO annotation provenance: [Spanish](https://github.com/UniversalDependencies/UD_Spanish-AnCora/blob/20adddbfcdd773c6dc97ba48ea11ca9364e74185/README.md), [Catalan](https://github.com/UniversalDependencies/UD_Catalan-AnCora/blob/7f3d23e85abc0656e8e88535d28174b030eb4d20/README.md). The [CC BY 4.0 deed](https://creativecommons.org/licenses/by/4.0/) permits commercial sharing and adaptation subject to its terms. Acquisition retains the original license, attribution README, repository, commit, byte size, Git blob digest and SHA-256; no corpus text is committed to this repository.

Run the bounded acquisition with an explicit directory outside the repository:

```powershell
node tools/coreference/acquire-sources.mjs --cache C:/Users/react/scce-source-cache/coreference-annotations
```

Only the six pinned files are eligible: two annotation development files and their license/attribution files, approximately 10.6 MB in total. A changed or oversized response, or changed cached data, fails the acquisition. This tool does not connect to canonical storage or train anything.

`readCorefUDSource` verifies artifact ownership, then reconstructs each original document from the source's sentence text, normalizes it to NFC and joins sentences with a newline. This explicitly derived text gets its own hash; the original annotation artifact remains separately identified. `prepareCorefUDSourceTrainingMaterial` exposes that exact document and its declaration through the existing `corpusMetadata.sourceMetadata.sourceReferenceBindings` input. It supplies neither invented dialogue turns nor a separate publication path.

Mention offsets are global, half-open Unicode code-point coordinates. Entity IDs are scoped to an original document; identical text is never evidence of shared identity. The formal [CorefUD annotation protocol](https://ufal.mff.cuni.cz/~popel/corefud-1.0/corefud-1.0-format.pdf) defines entity field order and mention brackets. Split antecedents and bridging remain source tags rather than identity merges. `NOCOREF:*` markables do not supply identity or negative training labels. Discontinuous mentions, empty nodes and mention boundaries inside multiword contractions are unsupported; affected chains are reported incomplete. Conflicting spans and failed text alignment are rejected. Completeness describes the supported source-declared chain, not every real-world reference in the document.

Identity annotations omit `propertyId` and `completeProperties`. They can populate the existing discourse mention and provenance records after ownership validation, but cannot authorize renaming a person, pronoun or location attribute. Qualified inference is explicitly unavailable. Gold POS, morphological tags and heads are retained as source tags; they are not prerequisites secretly available at raw-text inference time.

The real-data contract check is opt-in and reads the external cache rather than a production corpus copied into test fixtures:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=512'
$env:SCCE_TEST_HEAP_MB='512'
$env:SCCE_COREF_SOURCE_CACHE='C:/Users/react/scce-source-cache/coreference-annotations'
$env:SCCE_COREF_AUDIT_RECEIPT='C:/Users/react/scce-source-cache/coreference-annotations/contract-audit.json'
node node_modules/vitest/vitest.mjs run packages/adapters-node/src/__tests__/corefud-source-reader.test.ts packages/adapters-node/src/__tests__/corefud-reference-contract.test.ts packages/kernel/src/__tests__/source-reference-bindings.test.ts
node --test tools/coreference/acquire-sources.test.mjs
```

The audit splits by original document identity, rejecting overlap even when artifact URLs or revisions differ. It checks actual human chains with different surfaces and equal-surface mentions assigned to different entities, owned compilation, JSON persistence and cold hydration. Separate test-authored controls cover split-role, discontinuity, Unicode, changed-source, missing-evidence and unqualified-inference rejection. The receipt calls this annotated-source preservation, not held-out inference accuracy. Raw OASST/Dolly reference acquisition still needs a span/identity learner trained from raw text and separately qualified on unseen original sources; this checkpoint supplies no such learner.

Other candidates remain outside this acquisition:

| Source | Primary declaration | Status |
| --- | --- | --- |
| English LitBank | [Pinned authors' README](https://github.com/dbamman/litbank/blob/3e50db0ffc033d7ccbb94f4d88f6b99210328ed8/README.md): CC BY 4.0; human annotation of literary entities/coreference | Eligible candidate; no files downloaded or converted here |
| Russian RuCor | [CorefUD authors' technical report, section 2.1.6](https://ufal.mff.cuni.cz/techrep/tr66.pdf): CC BY-SA 4.0 | Separate share-alike candidate; original pinned artifact/grant still to verify before acquisition |
| GUM | [Authors' per-genre license](https://github.com/amir-zeldes/gum/blob/master/LICENSE.md): BY, BY-SA and NC subsets | No blanket admission; any future acquisition must select an eligible document subset |
| ParCorFull | [CorefUD authors' license table](https://aclanthology.org/2022.lrec-1.520/): BY-NC 4.0 excluding TED | Excluded from this commercially usable acquisition |

CorefUD is a collection with different licenses, not one permission grant. No mixed archive or pretrained language model is acquired.
