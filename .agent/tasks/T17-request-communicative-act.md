# T17-request-communicative-act

status: open
claimed_by:

The requirement field now carries a `dialogue_move` activation for `DialogueState.communicativeActId` with the
learned log-odds of that act's weight over the neutral act's (`turn-requirements.ts` `collectDialogueActivations`).
On turn one of a new session it is still inert, because nothing classifies the CURRENT request's act.

- `classifyCommunicativeActId` (`dialogue-pragmatics.ts`) reads only feedback status, answer-graph uncertainty and
  the previous state's act. There is no request-level producer, and the act inventory is
  ambiguous/challenge/repair/neutral: greeting, thanks and opinion do not exist as acts.
- The kernel's `authorityDialogueState` (`production-turn-runtime.ts`, `updateDialogueState` before the first
  `deriveTurnRequirementField`) passes no feedback and no act patch, so turn one is always `neutral`.
- `server/src/routes.ts` passes no act or style profile into `kernel.turn`; the kernel hydrates act weights itself
  from target-profile patterns (`styleProfileFromTargetProfilePatterns`), so the weights do reach it.
- `collectDialogueActivations` also fires on every turn one through the fallback intent `intent.09f1dc42`
  (activation 0.58, coefficient 0.3, both hand-set), which is a constant bias, not dialogue evidence. The live
  0.227 dialogueDependence equals sigmoid(-1.4 + 0.174).

To do: learn a request-level act classifier from observed outcomes (a corpus of acted requests, or act-labelled
request-requirement examples carrying a `dialogueDependence` target), feed its act into the authority dialogue
state, and replace the fallback-intent constants and `derivedContextContribution`'s 0.45/0.25 with declared
calibrations.
