# Declared local reference options

The existing `reference-ollama.mjs` runner is evaluation infrastructure. SCCE's product does not call it.

Leave formatting unset for ordinary chat and creative text. For a structured public contract, send a question with `format:"json"` or `format:{...JSON schema...}` in the existing JSONL input. The native bridge selects schemas only from that public typed contract. Alternatively, pin `--format=json` or `--format-schema=PATH` for a homogeneous run. CLI and question declarations cannot be combined. Schema files must contain an object. The runner forwards the native `format` unchanged; it never removes fences, fixes JSON, or generates replacement answers. Existing strict contract validators still decide whether the actual reply is valid.

Every answer records `outputFormat` (`text`, `json`, or `json_schema`). A schema also records `outputSchemaSha256`, the SHA-256 of recursively key-sorted JSON serialized without extra whitespace. Freeze the original schema file or public contract with the runner. Model digest, Ollama version, requested context/output/device settings, timing counters, and actual residency remain recorded.

Generation API failures additionally record `generationHttpStatus`, `generationErrorSha256` (SHA-256 of the exact response bytes), and `generationError` when the body parses as a JSON object. The existing bounded `error` string remains. These fields do not interpret English messages or authorize a retry. Admission receipts must allowlist the structured fields they need, since a server error body can contain request details; malformed/non-object JSON has only status and digest as machine fields.

For the whole-public-packet Qwen2.5:3b comparison, preregister explicit `--num-ctx=32768 --num-predict=4096`. The legacy cloze defaults remain 4096/96. These declared token caps do not prove that a particular source/code packet fits or that memory stays within 7–8 GiB. Before freezing the campaign, the operator must verify full rendered public prompts, their model template and output allowance, actual residency and peak memory under the pinned runtime. A larger complete-file output allowance requires preregistration before seeing results. Oversized tasks and model failures cannot be silently truncated or removed from the campaign.

Every generation requests `truncate:false` and `shift:false`. Reported output exhaustion (`done_reason:"length"`) becomes `status:"error"`, with the exact unfinished `rawReply` and inference counters retained. API rejections/errors remain errors; the runner does not retry without the options or reduce the prompt. The installed campaign runtime is Ollama 0.32.5: its tagged API and server source explicitly implement both flags. Other versions are unverified; an old server can silently ignore unknown request fields. Therefore a matching response alone does not certify preservation of context. Freeze the exact version and require a real over-context rejection probe before campaign admission. Unsupported/unverified runtimes are a setup blocker, never a successful generation condition.

Sources checked 2026-11-08:

- [Native generate format accepts JSON mode or a JSON schema](https://docs.ollama.com/api/generate).
- [Structured outputs and schema validation](https://docs.ollama.com/capabilities/structured-outputs).
- [Ollama 0.32.5 request fields](https://github.com/ollama/ollama/blob/v0.32.5/api/types.go).
- [Ollama 0.32.5 generation forwards truncate and shift](https://github.com/ollama/ollama/blob/v0.32.5/server/routes.go).
- [Qwen2.5 library: 3b model and 32K context](https://ollama.com/library/qwen2.5).
- [Context length increases memory requirements](https://docs.ollama.com/context-length).
