# T12-proposition-compiler-quantity-tokens

status: open
claimed_by:

The turn-time proposition compiler (`packages/kernel/src/semantic-proof-system.ts`, `atomizeText` -> `deriveConstraints` -> `parseQuantitySymbol`) mis-types quantities in two measured ways:

1. Thousands separators split the number. `"Is Mount Everest 8,848 metres tall?"` compiles to TWO quantity constraints: `{value: 8, unit: null}` and `{value: 848, unit: "metres"}` (probe 2026-09-15). The request's own quantity is wrong before any proof runs, so `compareQuantityConstraint` / `quantityContradiction` compare 848 against the source's 8848.
2. Any alphabetic token following a number becomes its unit: `"the 1955 survey of India"` yields `{value: 1955, unit: "survey"}`; `"Apollo 11 in 1969"` yields `{value: 11, unit: "in"}`. A unit that the corpus never uses as a unit is a false type.

Derive both from the corpus: which separators sit inside numeric runs, and which symbols the corpus attaches to numbers with a measured association, not a regex over the next token. `normalizeUnit`'s `/s$/` strip is an English suffix rule and must go with T6's replacement.

Regression: a request and a source stating the same quantity with different thousands formatting must compile to equal values; a bare year followed by a content word must not carry that word as a unit.

Offline only. Do NOT start or restart the server. Read-only SQL only.
