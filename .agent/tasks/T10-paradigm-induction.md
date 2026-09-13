# T10 Corpus-derived morphological paradigm induction

status: open
claimed_by:

## Why this exists

`requestUnitSharesStem(a, b): boolean` is being asked two different questions through one predicate.

**A. Is X an independently usable lexical form?**  capita vs capital, lankan vs lanka.
**B. Are X and Y members of one lexical family?**  discover/discovery, find/found, bind/bound.

T6 answered **A** well, with order-1 Kneser-Ney continuation diversity and a cut fitted from the corpus's own
type/token relation (`packages/kernel/src/free-form-lexicon.ts`). **Keep it. Do not replace it.**

find/found is question **B**, and T6's own report contains the proof that no pairwise threshold can close it: a bar
admitting find/found (0.448) rejects the real bind/bound and wind/wound, and the distributional ranking is
inverted across the family — real grind/ground scores 0.0029, below false mind/mound at 0.0115.

So stop looking for the threshold. The failure is that pair classification throws away the family, and the family
is the evidence.

## Hypothesis

Irregular stem equivalence is inferable from recurring orthographic transformations plus corresponding contextual
roles, with no English-specific morphology table.

## Required discrimination

MATCH: find/found, bind/bound, grind/ground, wind/wound, discover/discovery, capital/capitals
REFUSE: mind/mound, kind/kound, capita/capital, born/borna, majorian/bajoran

## Experiments, in order

1. **Canonical edit families.** Minimum edit scripts aligned from both ends, canonicalized as
   `(prefix*, "i", suffix*) -> (same prefix*, "ou", same suffix*)`. A weighted finite-state transducer is the
   natural representation and is standard morphology machinery, not an SCCE-specific hack.
2. **Family productivity against a null model.** Not raw count. For a transformation T over eligible bases, the
   evidence that the corpus contains more coherent realizations than its own lexical statistics predict by chance:
   a log Bayes factor against a null in which each resulting surface exists accidentally with corpus-derived
   probability.
3. **MDL.** Does describing the corpus with the rule make it shorter than storing the forms independently?
   `dL = L(forms alone) - [L(T) + L(bases) + L(exceptions)]`. Accept a transformation only when the data pays for
   it. This is the criterion most compatible with this codebase: no encoded grammar, no tuned threshold.
4. **Role-conditioned context correspondence.** Raw neighbour similarity is doomed here and was measured doomed:
   morphologically related words occupy *systematically different* contexts ("scientists discover planets" vs
   "the discovery of planets"), which is why PPMI put discover/discovery below austria/australia. Compare
   contexts after abstracting position and grammatical role, asking whether the contexts exhibit a repeatable
   transformation too.

Optional if the above separates the set: a lexical-family graph where community structure is itself evidence, so
an isolated mind/mound gets no network support while find/found sits inside an attested i->ou family.

## Constraints

- **Do not modify production until the harness separates the required set.** The experiment comes first.
- Do not introduce another global string-similarity threshold. That is the thing this task exists to replace.
- The eventual shape downstream wants is not a boolean. It is closer to a relation with its basis attached:
  `{kind: "inflectional" | "derivational" | "independent-form" | "unknown", basis: {...}}`, so
  `answerCoversRequest` can decide how much relation strength a given operation needs.
