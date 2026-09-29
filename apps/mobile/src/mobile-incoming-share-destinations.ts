import { CapabilitySupport, TargetState, capabilityNames, type Session, type Snapshot } from "@joko/contracts";

/** Only a uniquely owned, text-capable current task may be offered as a share destination. */
export function mobileIncomingShareTaskDestinations(
  owner: Pick<Snapshot, "sessions" | "targets" | "backends"> | undefined
): readonly Session[] {
  if (!owner) return [];
  const sessionCounts = new Map<string, number>();
  for (const session of owner.sessions) {
    sessionCounts.set(session.sessionId, (sessionCounts.get(session.sessionId) ?? 0) + 1);
  }
  return owner.sessions.filter((session) => {
    if (sessionCounts.get(session.sessionId) !== 1) return false;
    const targets = owner.targets.filter((target) => target.targetId === session.targetId);
    const backends = owner.backends.filter((backend) => backend.backendId === session.backendId);
    if (targets.length !== 1 || backends.length !== 1) return false;
    const target = targets[0]!;
    const backend = backends[0]!;
    return target.state === TargetState.ACTIVE && target.backendId === session.backendId
      && backend.capabilities?.capabilities.some((capability) => capability.name === capabilityNames.inputText
        && capability.support === CapabilitySupport.SUPPORTED) === true;
  });
}
