# T17a-request-act-producer

status: open
claimed_by:

T17 wired a request-level communicative act classifier (`request-communicative-act.ts`) into the kernel's
`authorityDialogueState`. It hydrates once per process from `language_patterns` rows whose
`pattern_json->>'sourceSystem' = 'request_communicative_act'`, and reports `inert_unconfigured` until they exist.
Nothing writes those rows yet.

The supervision already persists, keyed by episode id:
- `conversation_turns` (`server/src/routes.ts` `persistConversationTurnPair`): owner `text` and the assistant turn's
  `evidence_ids`, only for turns carrying a `sessionId`.
- `conversation_outcome_records` (`dialogue-learning.ts` `persistDialogueOutcomeAndLearn`): `accepted`/`rejected`/
  `corrected` with `turn_id = String(result.episodeId)`. It stores `prompt_hash`, never the request surface.

To do: join owner turn, assistant turn and outcome by episode id into `RequestCommunicativeActObservation`s, call
`compileRequestCommunicativeActModel` and `requestCommunicativeActPatterns`, and persist on a bounded cadence off the
turn path (outcome admission tail or a CLI). Replace a previous compile by `updatedAt`; the loader reads only the
newest group. Measure how many accepted outcomes carry an owner surface before claiming the classifier is active.
