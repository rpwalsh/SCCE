import type {
  ExecutiveCommand,
  ExecutiveEpisodeId,
  ExecutiveEpisodeMachine,
  ExecutiveEpisodeState,
  ExecutiveEvent
} from "./executive-episode.js";

export interface ExecutiveJournalSnapshot {
  episodeId: ExecutiveEpisodeId;
  revision: number;
  events: ExecutiveEvent[];
}

export interface ExecutiveJournalAppend {
  episodeId: ExecutiveEpisodeId;
  commandId: string;
  expectedRevision: number;
  events: ExecutiveEvent[];
}

export type ExecutiveJournalAppendResult =
  | { status: "appended"; revision: number }
  | { status: "duplicate"; revision: number }
  | { status: "conflict"; revision: number };

/**
 * Durable adapters must atomically enforce expectedRevision and a unique
 * (episodeId, commandId) constraint. A repeated command returns "duplicate"
 * without appending its events again.
 */
export interface ExecutiveEventJournal {
  read(episodeId: ExecutiveEpisodeId): Promise<ExecutiveJournalSnapshot>;
  append(input: ExecutiveJournalAppend): Promise<ExecutiveJournalAppendResult>;
}

export interface DurableExecutiveEpisode {
  load(episodeId: ExecutiveEpisodeId): Promise<ExecutiveEpisodeState>;
  dispatch(command: ExecutiveCommand): Promise<ExecutiveEpisodeState>;
}

export function createDurableExecutiveEpisode(input: {
  machine: ExecutiveEpisodeMachine;
  journal: ExecutiveEventJournal;
  maxConflictRetries: number;
}): DurableExecutiveEpisode {
  if (!Number.isInteger(input.maxConflictRetries) || input.maxConflictRetries < 0) {
    throw new Error("maxConflictRetries must be a non-negative integer");
  }

  const load = async (episodeId: ExecutiveEpisodeId): Promise<ExecutiveEpisodeState> => {
    const snapshot = await input.journal.read(episodeId);
    if (snapshot.episodeId !== episodeId) throw new Error("executive journal returned a different episode");
    if (snapshot.revision !== snapshot.events.length) throw new Error("executive journal revision does not match its event count");
    const state = input.machine.replay(episodeId, snapshot.events);
    if (state.revision !== snapshot.revision) throw new Error("executive replay revision mismatch");
    return state;
  };

  const dispatch = async (command: ExecutiveCommand): Promise<ExecutiveEpisodeState> => {
    for (let conflict = 0; conflict <= input.maxConflictRetries; conflict += 1) {
      const snapshot = await input.journal.read(command.episodeId);
      if (snapshot.episodeId !== command.episodeId) throw new Error("executive journal returned a different episode");
      if (snapshot.revision !== snapshot.events.length) throw new Error("executive journal revision does not match its event count");
      const state = input.machine.replay(command.episodeId, snapshot.events);
      if (state.appliedCommandIds[command.commandId]) return state;
      const events = input.machine.decide(state, command);
      if (events.length === 0) return state;
      const result = await input.journal.append({
        episodeId: command.episodeId,
        commandId: command.commandId,
        expectedRevision: state.revision,
        events
      });
      if (result.status === "appended" || result.status === "duplicate") return load(command.episodeId);
    }
    throw new Error("executive journal conflict retry limit exhausted");
  };

  return { load, dispatch };
}
