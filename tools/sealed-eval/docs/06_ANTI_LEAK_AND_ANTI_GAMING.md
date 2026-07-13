# Anti-leak and anti-gaming controls

## Question secrecy

- Do not store sealed questions in the source repository.
- Do not place them in developer-accessible issue trackers or chat histories.
- Mount or transfer them only after the executable environment is frozen.
- Publish hashes before the run, not plaintext.

## Canary design

Custodians should include:

- invented neutral names known only to the sealed corpus;
- exact values distributed across multiple documents;
- plausible but false answer options;
- unanswerable questions;
- paraphrases with low overlap;
- a small number of hidden corpus markers that should never be emitted.

Do not use personally sensitive or operationally dangerous canaries.

## Process isolation

- Disable network or record an explicit allowlist.
- Record process tree before and during execution.
- Remove API keys not required by the declared system.
- Ensure answer keys and judgments are not readable by the system process.
- Use read-only mounts for sealed inputs where practical.
- Separate evaluator and system-owner accounts.

## Result integrity

- Append outputs; do not overwrite.
- Include attempt number.
- Retain malformed records and stderr.
- Hash raw results before blinding.
- Do not manually clean wording, citations, or formatting.
- Log every rerun and reason.

## Ablation gaming

A condition is invalid if:

- it merely changes a name or report field;
- disabled features remain in a cached representation;
- a fallback re-enables the same component;
- resource allocation changes materially without disclosure;
- question order or corpus differs;
- the full system trains on outputs from ablations or vice versa.
