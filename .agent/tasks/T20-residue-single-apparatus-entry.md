# T20-residue-single-apparatus-entry

status: open
claimed_by:

`structural-residue.ts` scores `symbolDensity * (1 - bigramDiversity)` per sentence. A reference list split into
sentences puts one entry in each, and one entry repeats no token bigram, so the score is exactly 0:

| sentence | symbolDensity | bigramDiversity | score |
| --- | --- | --- | --- |
| `-essential-influential-melancholy ABBA's Essential, Influential Melancholy].` | 0.462 | 1 | 0 |
| `NPR, 23 May 2015 * [https://www.smithsonianmag.com/arts-culture/whats-behind-abbas-staying-power-180969709/ What's Behind ABBA's Staying Power?` | 0.462 | 1 | 0 |
| `]. Variety, 22 July 2018 * [https://www.npr.org/sections/the` | 0.545 | 1 | 0 |

These are the chunks a 2026-09-13 chat probe served for five turns. The derivation tool splits the same way, so the
Otsu population puts every such entry in the prose class by construction: the cut is not wrong, the measure is blind.

Constraints found while tracing: `structural-residue.test.ts` asserts prose `bigramDiversity > 0.9` on raw tokens, so
the existing term cannot be redefined; word-class abstraction of bigrams makes comma lists and unspaced scripts score
as skeleton (lists reach ~0.2 by hand calculation). Any new measurement changes the score distribution, so
`evidence.structural_residue_cut` must be re-derived live with `tools/derive-structural-residue-cut.mjs` in the same
change. Also `mouth.contradiction_fallback` (production-turn-runtime.ts) checks only `isUnparsedMarkupText`, never the
residue measure; it was the stage that spoke this surface live.
