/** Selects an already saved source; it never discovers or contacts a node. */
export function taskLinkSourceProfileId(
  profiles: readonly { readonly profileId: string; readonly serverId: string }[],
  activeProfileId: string | undefined,
  explicitProfileId: string | undefined,
  serverId: string | undefined
): string | undefined {
  if (serverId === undefined) {
    const id = explicitProfileId ?? activeProfileId;
    return id !== undefined && profiles.filter(profile => profile.profileId === id).length === 1 ? id : undefined;
  }
  const matches = profiles.filter(profile => profile.serverId === serverId
    && (explicitProfileId === undefined || profile.profileId === explicitProfileId)
    && profiles.filter(candidate => candidate.profileId === profile.profileId).length === 1);
  const active = matches.find(profile => profile.profileId === activeProfileId);
  return active?.profileId ?? (matches.length === 1 ? matches[0]!.profileId : undefined);
}
