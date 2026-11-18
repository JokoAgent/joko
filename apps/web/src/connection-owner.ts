import type { AppSnapshot, ConnectionProfile } from "./model.js";

/** One authenticated connection occurrence, independent of ordinary Snapshot revisions. */
export function authenticatedConnectionKey(state: {
  readonly connectionState: string;
  readonly activeProfile?: ConnectionProfile;
  readonly connectionGeneration?: number;
  readonly snapshot: Pick<AppSnapshot, "generation">;
}): string | undefined {
  const profile = state.activeProfile;
  if (state.connectionState !== "connected" || !profile || state.connectionGeneration === undefined) return undefined;
  return JSON.stringify([profile.id, profile.serverId, profile.deviceId, profile.origin,
    state.connectionGeneration, state.snapshot.generation.toString()]);
}
