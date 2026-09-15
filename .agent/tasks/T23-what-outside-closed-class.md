# T23-what-outside-closed-class

status: open (LIVE RISK, unverified)
claimed_by:

The last word-position rule (`requestLeadingScaffoldingUnit`, first word <= 5 characters) is removed. Every caller
now asks the corpus closed class instead. Offline all fixtures pass, but they put the interrogative inside the
closed class, and the live brain does not:

    which  rank 36      what  rank 102      closed_class.rank_limit = 96

So on the live corpus "what" falls OUTSIDE the closed class. A request opening "What is acupuncture?" used to have
its first word discounted by position; now nothing discounts it, and it counts as content the answer must carry.
That is the same defect class as the 2026-09-11 admission bug (interrogative counted as content at admission).

**Measure first:** run the capitals gate and the factual family; compare `pool_admission` with `selected_evidence`
for requests opening with an interrogative. Expect failures only where the request's first word is an interrogative
ranked outside the limit.

**If it regresses, the honest fix is the population or the limit, never the word's position.** `closed_class.rank_limit`
is now a declared calibration with a search space, so it can be fitted rather than hand-set. Check first whether the
hydrated population is the corpus-scale one (`language.hydrate.continuation_population`, status `measured`) -- a
turn pooling only its own two documents ranks everything differently, which is what made the class too small before.

Also unverified live: three sites that consulted position alone now consult the closed class for the first time --
the title-lead transfer and the definitional opening-block rescue in `bestEvidenceSentences`, and `subjectOnlyRequest`
in production-turn-runtime. On a turn whose language memory hydrates empty they now filter nothing at all.
