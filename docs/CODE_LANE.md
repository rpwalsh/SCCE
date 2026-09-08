# Writing and Repairing Code

SCCE repairs source the way it answers questions: it composes from what it has learned, and something outside it decides whether the answer stands. For prose that arbiter is evidence. For code it is the compiler.

This is the property that distinguishes the lane commercially. A language model always produces an edit and has no mechanism guaranteeing the file it returns is buildable. This system either improves a file or leaves it exactly as it was — never between the two, and never by deleting the code that failed to compile.

## The division of labour

Three parties, none doing another's job:

**The type system bounds what is admissible.** At a defect, the language service is asked what may legally be written there. That is the symbol table, not a suggested fix — the language's own answer to "what may stand here at all". Where that set is a single identifier it decides the repair; where it is the whole global scope it decides almost nothing, and the size of the answer is what makes it self-regulating rather than a threshold anyone chose.

**A learned distribution chooses among the admissible.** Two models interpolated: a mixture over the corpus for the shape of the language, and a model of the file being edited for the names only that file knows. A corpus-only distribution is structurally incapable of writing `row.label` for a file whose `label` it has never met; a file-only distribution has no grammar. Both are load-bearing, and the split between them is measured rather than chosen (see *Calibration*).

**The build decides.** Every proposal is applied, verified, and rolled back if it fails. A wrong composition costs one iteration and leaves nothing behind, which is why generating freely is safe here in a way it is not for a writer with no gate.

## What may be written

A compiler is a one-sided criterion. It bounds what is *wrong* with a program and says nothing about what the program still has to *be*, so a gate resting on it alone is satisfiable by deleting the code that failed. A search over a learned distribution finds that solution immediately, because it is cheap and always available.

Four structural rules close it. Each exists because the search found the hole in the previous set, and every example below type-checks:

| Rule | What it prevents |
|---|---|
| A filling may not say less than the hole said | `add(1)` → `(1)`, `"three"` → `;` |
| It may not drop the hole's structure | `add(1)` → `add`, which turns a number into a function reference |
| It opens the way the hole opened | `{ x: 0 }` → `; Point { x: number; }` |
| A keyword is not a hole, and neither is a position admitting no name | `origin { x: 0 };` |

## Where a repair happens

A line is what a compiler prints; a span is what it knows. Repairing by line forces a generator to rewrite a whole statement to change one token — a harder composition than the defect warrants, and a standing licence to touch what was never in question. Replacing an exact range leaves every other byte identical.

The diagnostic's own range is frequently not where the repair lives:

| Diagnostic | Reported on | Repairable in |
|---|---|---|
| Expected 2 arguments, but got 1 | the callee | the call expression |
| Property 'y' is missing | the `return` keyword | the object literal |
| Type 'string' is not assignable | the binding name | the initializer |

Three ranges are therefore offered per defect — the token, the expression containing it, and the expression its statement is about — smallest first, because the most local repair is the one that changes least. All three are facts about where things begin and end. None says what to write in them.

## Composition above the token

Predicting one symbol at a time cannot hold a shape. There is no way for a sequence model to represent *an object literal with one more member than this one has*, so `{ x: 0 }` could never reach `{ x: 0, y: 0 }` however much evidence there was.

What varies in code is what brackets contain. An argument list, an object literal, an index, a block: each is a balanced span whose contents differ between occurrences while its punctuation does not. Grouping spans by that punctuation and anti-unifying the members recovers exactly the positions that vary. Over 120 modules of this repository that yields 459 shapes:

```
[120 files, 3166x]  <0> ( <1> )
[ 88 files,  780x]  <0> ( <1> , <2> )
[ 28 files,   69x]  { <0> : <1> }
[ 17 files,   37x]  { <0> : <1> , <2> : <3> }
```

No grammar is written down and nothing is assumed beyond brackets pairing. Where every document agrees, the token is part of the shape: three files declaring `{ id: …, kind: … }` induce `{ id : <0> , kind : <1> }` — the keys are the construction and the values are its slots.

Shapes are induced from the project being repaired rather than a global corpus. A repair should read like the code around it, and the strongest evidence for how this code is written is this code.

Filling a shape and continuing a sequence are both offered for the same hole, and they compete on one objective — the models' own total log probability. Preferring either by provenance is not justified: they are scored identically.

## Convergence

A draft is dozens of edits from correct, so a loop that keeps only patches finishing the file can repair nothing that is not already one edit away.

Each iteration either strictly reduces the diagnostics or spends one of a finite number of hypotheses about a state it may not then repeat. A step that reduces what is wrong, and introduces no kind of failure that was not already there, is kept. Kept steps stay kept: a file taken from three defects to one is a better file than three defects untouched, and it is the file a person working through them would have.

The guarantee is therefore **monotone** — the file never gets worse — rather than all-or-nothing. Progress is reported as itself: how far it converged and what remains.

Nothing in the loop is metered. There are no tokens, no calls and no per-request cost; an iteration spends time and only time, which is what its wall clock bounds. Termination does not require a counter: the diagnostics are bounded below by zero and the hypotheses per state are finite.

## Calibration

Two settings govern the lane and neither is chosen by taste. `tools/code-generation-calibration/calibrate.mjs` removes a line from a held-out file, trains the local model on what is left, mixes corpus models from other files, and scores the prediction of the removed line — the same question the lane answers at repair time.

Over 3,948 held-out symbols of real source:

| n-gram order | log-perplexity |
|---|---|
| 2 | 3.4954 |
| 3 | 3.0413 |
| 4 | 2.9736 |
| **5** | **2.9599** |
| 6 | 2.9668 |

Bigrams cost 1.71× the perplexity of the minimum, so the code corpus trains at order 5 rather than the prose default of 4. The same sweep sets the corpus/file interpolation at 0.30, with corpus-only at 4.17 nats per token and file-only at 3.63 against 2.96 mixed — both distributions are load-bearing, and neither alone can write a repair.

## Measured behaviour

Two harnesses, both decided by the TypeScript compiler, both re-runnable.

**Seeded defects** (`tools/code-repair-benchmark.mjs`) — seven modules with one planted defect each, against a locally hosted model for comparison:

```
scce             repaired 2/7   destroyed 0   left broken 0   declined 5
llm:qwen2.5:3b   repaired 4/7   destroyed 1   left broken 2   declined 1
```

`destroyed` counts a file that compiles because its contents were removed. It is reported because the compiler cannot see the difference and a buyer should.

**This project's own source** (`tools/self-repair-benchmark.mjs`) — real modules of a hundred to three hundred lines, a defect introduced by a deterministic mutation, repaired inside a project of eight. Because a mutation's inverse is known, the criterion is sharper than "it compiles": `exact` means the original text came back byte for byte.

| mutation | defects | exact | fully repaired | partly repaired | made worse |
|---|---|---|---|---|---|
| misspelled reference | 8 | 3 | 4 | 0 | **0** |
| misspelled member | 8 | 6 | 6 | 0 | **0** |
| three misspellings | 8 | 0 | 0 | 5 | **0** |
| dropped argument | 4 | 0 | 1 | 0 | **0** |
| **total** | **28** | **9** | **11** | **5** | **0** |

## Language coverage

The composition, the structural rules and the convergence loop are language-neutral: identifiers, numbers, delimited literals and bracket nesting are categories every formal language shares, and no keyword list appears anywhere in the lane.

What is language-specific is verification, and it is a port. TypeScript and the C family are implemented — the same contract over `tsc` and over `clang -fsyntax-only` with parseable fix-its. The corpus lane already routes `.ts .tsx .js .py .rs .go .java .kt .swift .rb .php .c .cc .cpp .cs .sql` and others; each becomes writable when its verifier is ported.

## Boundaries

Stated rather than implied.

- **The compiler is necessary, not sufficient.** `byFamily.set(id, bucket)` was once repaired to `byFamily.get(id)`: it type-checks, it is wrong, and no structural rule can see the difference. Only running the code can. Test execution is the next gate and this project has 2,228 tests to run it with.
- **Composition is corpus-bound.** A shape must recur across documents to be admitted, so a two-file workspace induces none and the lane falls back to continuing sequences. Accuracy tracks corpus size; this is a knob, not a redesign.
- **Multi-defect files converge but do not always finish.** Files reach one or two remaining diagnostics and stop when the search has no further hypothesis for what is left.
- **The request's meaning does not yet reach this lane.** Repair is driven by compiler diagnostics. Being *told* what to write is a separate connection, and it is not built.
