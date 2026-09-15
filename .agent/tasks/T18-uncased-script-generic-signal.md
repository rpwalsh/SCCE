# T18-uncased-script-generic-signal

status: open
claimed_by:

`genericQuestionSignal` (`kernel-answer-primitives.ts`) counts a character as a letter only when
`toLocaleLowerCase() !== toLocaleUpperCase()`, i.e. only cased letters. Every single-unit word in Hebrew, Arabic,
Devanagari, CJK or Korean has zero "letters" and is reported generic. `namedSourceAnchorSpecificEnough` then drops it,
so `namedSubjectAnchors` returns `[]` for a primed single-unit identity such as `ירושלים` (measured with
`primeCorpusIdentitySignals` while writing `proper-noun-entity-anchors-position.test.ts`). Multi-unit identities survive.

It also carries a hand-set `0.72` repeated-character ratio and a `length <= 2` floor.

About 25 callers sit on retrieval and factual paths (`local-evidence-runtime.ts`, `runtime-graph-retrieval.ts`,
`learned-graph-prior-runtime.ts`). Letter detection by `\p{L}` is structural, but it widens every one of those filters
for uncased input. Re-run the capitals and factual-family live gates before landing.
