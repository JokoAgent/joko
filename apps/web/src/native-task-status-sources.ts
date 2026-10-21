import type { AppSnapshot, ConnectionProfile, PartnerProfileView } from "./model.js";

/** In-memory authenticated stream state. Offline machine cards never implement this port. */
export interface NativeTaskStatusLiveSource {
  readonly profile: ConnectionProfile;
  readonly epoch: number;
  readonly snapshot: AppSnapshot;
  readonly partners: readonly PartnerProfileView[];
  readonly artworkByPartnerId?: Readonly<Record<string, string>>;
}
