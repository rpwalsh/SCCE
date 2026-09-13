# The problem is selection, not control

The work is NOT "learn which cognitive operator helps the score". It is:

> **Reduce an overwhelming information space to the tiny subset worth examining, without losing the relationships
> needed to find it.**

That is upstream of the requirement field, the operators, the planner, the judge, the proof engine and the mouth.
Leave those alone unless the benchmark proves they fail. The question is:

```
cold brain  ->  correct tiny graph slice
```

Do not search the haystack after the question arrives. Maintain enough global structure that you already know
which handful of hay to inspect. A 4.9 second median turn is mostly the cost of not having done that.

## Relevance is the wrong objective. Discrimination is the right one.

A node supporting every candidate answer equally resolves nothing. A node that separates them is the whole point.

```
S(v | q) = R(v | q) * D(v)          D(v) = I(V_v ; H | q)
```

R is structural relevance; D is the mutual information between inspecting v and the competing hypotheses. The
question stops being "which document resembles the query" and becomes **"which part of this graph can resolve what
I do not yet know"**.

## Propagation should be hypothesis-conditioned

Run the walk once per candidate hypothesis, then look at where they disagree:

```
r^(k) = a*s^(k) + (1-a) * P' r^(k)          J(v) = Var_k [ r_v^(k) ]
```

High J: the hypotheses disagree about this region, so inspect exact evidence there. Low J: they all predict the
same thing, so it cannot decide the answer. Current propagation asks only where mass flows from the query seeds.

## Hyperedges carry roles, and roles propagate

`(Alice, GIVE, Bob, book)` is one relational event, not three pairwise facts. Relevance should flow through roles:

```
R_h = f(R_agent, R_patient, R_theme, R_relation, q)      R'_v = R_v + sum_{h in v} w_{v,h} * R_h
```

The typed incidence graph exists precisely to keep arbitrary arity rather than collapsing it into participant
cliques. Use it.

## Compile relationships once; query them cheaply forever

The largest win is at ingestion. Compile compact cold indexes per structural object — relation populations, graph
neighbourhoods, source-family support, construction memberships, alignment populations, temporal populations, walk
neighbourhoods, contradiction neighbourhoods — so a turn asks "which persistent structural populations overlap
this query's activated structures" instead of searching thousands of chunks for matching words. Coarse-to-fine
quotient-community routing already exists for alignment; generalize it to the cold graph lookup path.

## The thesis, and how it beats the reference model

Not by tuning coefficients against a benchmark. Architecturally:

```
hide the same small proof chain in an environment of N = 10^3, 10^4, 10^5, 10^6
```

The reference model degrades as the useful information stops fitting in active context. SCCE should barely move,
because precompiled structure selects a sublinear subset.

> **Structured global selection beats model-context reasoning as information scale increases.**

That is the experiment that settles the claim.
