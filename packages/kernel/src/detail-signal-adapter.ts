// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { DETAIL_PROFILE_IDS, type ControlDetailProfileId } from "./control-plane-profiles.js";

interface DetailSignalRow {
  signal: string;
  profileId: ControlDetailProfileId;
}

const DETAIL_SIGNALS: readonly DetailSignalRow[] = [
  { signal: "brief", profileId: DETAIL_PROFILE_IDS[0] },
  { signal: "normal", profileId: DETAIL_PROFILE_IDS[1] },
  { signal: "detailed", profileId: DETAIL_PROFILE_IDS[2] },
  { signal: "stepwise", profileId: DETAIL_PROFILE_IDS[3] }
];

export function detailProfileIdFromSignal(signal: string | undefined): ControlDetailProfileId | undefined {
  if (!signal) return undefined;
  for (const row of DETAIL_SIGNALS) {
    if (row.signal === signal) return row.profileId;
  }
  return undefined;
}

export function detailSignalCount(): number {
  return DETAIL_SIGNALS.length;
}
