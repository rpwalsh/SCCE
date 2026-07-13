import { DETAIL_PROFILE_IDS, type ControlDetailProfileId } from "./control-plane-profiles.js";

interface LegacyDetailSignalRow {
  signal: string;
  profileId: ControlDetailProfileId;
}

const LEGACY_DETAIL_SIGNALS: readonly LegacyDetailSignalRow[] = [
  { signal: "brief", profileId: DETAIL_PROFILE_IDS[0] },
  { signal: "normal", profileId: DETAIL_PROFILE_IDS[1] },
  { signal: "detailed", profileId: DETAIL_PROFILE_IDS[2] },
  { signal: "stepwise", profileId: DETAIL_PROFILE_IDS[3] }
];

export function legacyDetailProfileIdFromSignal(signal: string | undefined): ControlDetailProfileId | undefined {
  if (!signal) return undefined;
  for (const row of LEGACY_DETAIL_SIGNALS) {
    if (row.signal === signal) return row.profileId;
  }
  return undefined;
}

export function legacyDetailSignalCount(): number {
  return LEGACY_DETAIL_SIGNALS.length;
}
