# Why code scores 0 of 6 -- three causes, measured

Run `node tools/code-corpus-audit.mjs` to reproduce. Live schema is `scce3_runtime`; four other schemas also
carry an `evidence_spans` table and only this one has `source_title`, so a query against the wrong one fails
confusingly or silently answers about a stale corpus.

## Symbol reachability, the six benchmark questions

    symbol                             defining file                  def at   ingested reach   verdict
    bestEvidenceSentences              local-evidence-runtime.ts      212931   0 spans          FILE NOT INGESTED
    createProgramPlanner               program-planner.ts               4167   0 spans          FILE NOT INGESTED
    deriveClosedClassWords             closed-class-words.ts            3816   2079             PAST INGESTED END
    syncTaskResumptionSnapshotForTurn  task-resumption-turn-request.ts 10498   10131            PAST INGESTED END
    codeRequestSignal                  code-request.ts                  3592   8342             REACHABLE
    replan                             task-replanning.ts               1795   3899             REACHABLE

Two files were never ingested. Two were truncated -- one of them missed its definition by 367 characters. And
**two are present, in range, and retrieval still answered "No grounded source in the ingested corpus"**. That
last pair is the real defect; the other four are corpus gaps.

## Corpus coverage

447 of 831 tracked TypeScript files are ingested, so 384 are absent. Of the 447, 414 are complete and 33 are
truncated, losing 5.1% of their bytes. Not a limit: `DEFAULT_LIMITS` allows 3,000 files and 2MB each, and the
repo has 1,178 tracked files. This was a partial run, not a capped one. Worst truncations:

    11.1%   10609 /  95277  index
    31.5%    2079 /   6602  closed class words
    60.6%  211419 / 348757  production turn runtime
    63.3%    6500 /  10263  user model turn request
    68.0%   36806 /  54138  calibration spine

## A correction to an earlier claim in this session

I first read "340 of 449 files have exactly 2 spans" as "three-quarters of the code corpus is nothing but its
licence header", generalising from one sampled file. That was wrong. Two spans is the normal shape for a small
file -- one raw and one token-separated rendering -- and 414 of 447 ingested files are at least 95% complete.
The truncation is real but it affects 33 files, not 340.

## What must happen, and in what order

1. **Not yet.** Re-ingesting the repo changes document frequency for every term, which moves BM25 scoring for
   every workload. Running it while five lanes hold before/after measurements would make all of them
   incomparable. It runs after the lanes land, before the final suite.
2. `scce codebase ingest <path>` is the entry point; `analyzeDeveloperRepo` in
   `packages/adapters-node/src/repo-intelligence-folder.ts` does the walking.
3. Then re-test the two REACHABLE symbols. If they still fail, the defect is symbol addressability: a request
   naming an identifier cannot address the file that defines it, because corpus identity is title-derived
   ("code request" from `code-request.ts`) and a symbol is not a title. Under the joint objective the fix is that
   `defines(file, symbol)` is a typed relation, not a string match -- an identifier is a lexical unit whose graph
   correspondence is its definition site, and that is language-independent.
