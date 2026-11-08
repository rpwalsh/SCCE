# Development solver checks

This optional CLI checks the scalar part of SCCE's existing `ProgramExpression` and `SourceCodeFunctionConstruction` IR using Z3. It is a development verification aid. It does not participate in request routing, admission, code generation, or Mouth. Native compilers and executable tests remain authoritative.

It compares the source compiler's encoding of one isolated callable with an existing proposed IR. `unsat` establishes equality only within the supplied argument domain and the supported encoding. It does not establish correctness of the source parser, compiler, surrounding application, dependencies, or every program. No source code is executed by the solver CLI.

The initial scope is JavaScript/TypeScript scalar numeric and Boolean expressions: arguments, finite numeric literals, Boolean values, unary negation, binary arithmetic, `minimum`/`maximum`, numeric comparisons, strict equality, homogeneous conditionals, and ordered local binding DAGs. Structural values, collections, strings, side effects, loops, native integer arithmetic, and other source languages return `unsupported` rather than switching theories. The standard unmodified `Math` object is assumed.

All numeric operations use Z3 binary64 floating point with round-to-nearest, ties-to-even; no mathematical Real arithmetic is used. Inputs are explicitly finite binary64 values, including signed zeros and subnormals. Results may be NaN or infinity. Result equality follows `Object.is`: signed zeros differ, all NaNs are one observable class. `Math.min`/`Math.max` explicitly propagate NaN and implement JavaScript's signed-zero selection. This verifies JavaScript source/emission arithmetic, not SCCE's separate finite-result rejection or epsilon-based fit evaluation policies.

Install the pinned development dependency in an isolated Python environment. `requirements.lock` pins the official Windows x64 wheel; its SHA-256 comes from [the release metadata](https://pypi.org/pypi/z3-solver/4.16.0.0/json). No installation or download happens when checking a program.

```powershell
python -m venv .tmp/solver-tools
.tmp/solver-tools/Scripts/python.exe -m pip install --require-hashes --only-binary=:all: -r tools/solver-check/requirements.lock
```

Export an actual compiler-owned source construction after the normal package build. The helper uses the existing production source compiler; it does not introduce another source parser or program generator.

```powershell
pnpm build
node tools/solver-check/extract-source.mjs --file packages/kernel/src/functional-cognition.ts --language typescript --callable clamp --out .tmp/clamp-source.json
.tmp/solver-tools/Scripts/python.exe tools/solver-check/verify.py --source-encoding .tmp/clamp-source.json --candidate tools/solver-check/examples/clamp-commuted.json --domain tools/solver-check/examples/finite-three.json --timeout-ms 5000 --rlimit 10000000
```

The source input is the existing `SourceCodeFunctionConstruction` JSON. The candidate accepts an existing `ProgramExpression`, a `ProgramTransformationCandidate` with `producedIr`, or another construction with `expression` and optional `bindings`. The compiler-supplied source identity is recorded, not independently authenticated by the solver. Source-encoding, source-text, candidate/domain file hashes, query hash, solver version, Python binding and native package artifact hashes, pinned wheel hash, and requirements-lock hash are included in the JSON receipt.

Every parameter needs an explicit domain. `{ "kind": "finite_binary64" }` includes all finite 64-bit encodings. Add a nonempty `valuesBits` array for exact encodings, or both `minimumBits` and `maximumBits` for a closed numeric interval. Each value is exactly 16 hexadecimal digits in IEEE 754 network byte order; `0000000000000000` is positive zero, `8000000000000000` is negative zero. Intervals compare numerically and therefore include both zeros when they include zero. Enumeration can distinguish their signs. Empty, nonfinite, missing, and contradictory domains are rejected; no domain is silently added or widened.

| Status | Exit | Meaning |
| --- | --- | --- |
| `unsat` | 0 | No differing result exists in the explicit domain of this supported scalar encoding. |
| `sat` | 1 | Receipt contains exact argument/result bits for a counterexample. Replay it with the actual compiler/runtime. |
| `unknown` | 2 | Timeout or solver resource limit; neither result was established. |
| `unsupported` | 3 | IR, language, type, or encoding budget outside this scope. |
| `error` | 4 | Malformed input, missing dependency, or tool failure; no equivalence claim. |

Defaults are a 2,000 ms solver timeout, 1,000,000 solver resource units, and a 256 MiB Z3 memory budget. Flags permit at most 60,000 ms, 10,000,000 resource units, and 512 MiB. Each input is capped at 1 MiB; both programs together at 1,024 expression nodes and depth 64; each program at 128 local bindings and 8 parameters. All limits are in the receipt. These are explicit development resource bounds, not language or generation rules.

Run the separate tool tests with a 512 MiB worker. They use the actual source compiler, prove a commuted encoding of the repository's `clamp`, mutate that real IR and replay the solver witness in Node/V8 and SCCE's existing evaluator, exercise binary64 reassociation/subnormals/signed-zero/NaN behavior, and check real timeout, resource-limit, unsupported, and malformed-domain receipts.

```powershell
$env:NODE_OPTIONS = '--max-old-space-size=512'
$env:SCCE_TEST_HEAP_MB = '512'
$env:SCCE_SOLVER_PYTHON = (Resolve-Path .tmp/solver-tools/Scripts/python.exe).Path
pnpm exec vitest run --config tools/solver-check/vitest.config.ts
```

Numeric references: [Z3 IEEE floats](https://microsoft.github.io/z3guide/docs/theories/IEEE%20Floats/), [Z3 floating-point API](https://z3prover.github.io/api/html/namespacez3py.html), [ECMAScript Number operations](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-numeric-types-number-add), and [ECMAScript Math.min](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-math.min).
