import { groupKey, ProviderGroupStore, type ProviderGroupKey, type ProviderGroupMember, type ProviderGroupSnapshot } from "@joko/store";
import type { SessionRuntimeProfile } from "./session-runtime-control.js";
import { ProviderGroupDirectory, type ProviderGroupDirectoryRequest, type ProviderGroupMemberStatus } from "./provider-group-directory.js";
import { ProviderGroupLeases } from "./provider-group-leases.js";
import { selectProviderGroupMember } from "./provider-group-scheduler.js";
import { ProviderGroupUnavailableError, type ProviderGroupFailureDecision, type ProviderGroupFailureSignals } from "./provider-group-failure-policy.js";

export interface ProviderGroupAssignment {
  readonly group: ProviderGroupKey; readonly snapshot: ProviderGroupSnapshot; readonly member: ProviderGroupMember;
  readonly status: ProviderGroupMemberStatus; readonly profile: SessionRuntimeProfile;
  assertCurrent(): void; commit(): void; release(): void;
}
interface Tried { readonly until: number; readonly keys: Set<string>; }
export interface ProviderGroupRemoteRouterPort {
  owns(group: ProviderGroupKey): boolean;
  prepare(group: ProviderGroupKey, signal: AbortSignal): Promise<void>;
  pick(input: ProviderGroupPick, signal: AbortSignal): Promise<ProviderGroupAssignment>;
  read(group: ProviderGroupKey, member: ProviderGroupMember, request: ProviderGroupDirectoryRequest, signal: AbortSignal): Promise<ProviderGroupMemberStatus>;
  cool(group: ProviderGroupKey, member: ProviderGroupMember, modelId: string, signals: ProviderGroupFailureSignals, decision: ProviderGroupFailureDecision): void;
}
export interface ProviderGroupPick extends ProviderGroupDirectoryRequest {
  readonly sessionId: string; readonly group: ProviderGroupKey; readonly profile: SessionRuntimeProfile;
  readonly exclude?: ReadonlySet<string>;
}
export class ProviderGroupRouter {
  readonly #lastPicked = new Map<string, string>();
  readonly #tried = new Map<string, Tried>();
  readonly #remoteSelections = new Map<string, { readonly at: number; readonly assignment: ProviderGroupAssignment }>();
  constructor(readonly store: ProviderGroupStore, readonly directory: ProviderGroupDirectory, readonly leases: ProviderGroupLeases,
    readonly now: () => number = Date.now, readonly random: () => number = Math.random, readonly remote?: ProviderGroupRemoteRouterPort) {}
  async prepare(group: ProviderGroupKey, signal: AbortSignal): Promise<void> { if (this.remote?.owns(group)) await this.remote.prepare(group, signal); }
  readMember(group: ProviderGroupKey, member: ProviderGroupMember, request: ProviderGroupDirectoryRequest, signal: AbortSignal): Promise<ProviderGroupMemberStatus> {
    return this.remote?.owns(group) ? this.remote.read(group, member, request, signal) : this.directory.read(member, request, signal);
  }
  rememberRemoteSelection(deviceId: string, sessionId: string, assignment: ProviderGroupAssignment): void {
    for (const [key, value] of this.#remoteSelections) if (this.now() - value.at > 30_000) this.#remoteSelections.delete(key);
    if (this.#remoteSelections.size >= 4096) throw new ProviderGroupUnavailableError();
    this.#remoteSelections.set(JSON.stringify([deviceId, sessionId, groupKey(assignment.group)]), { at: this.now(), assignment });
  }
  takeRemoteSelection(deviceId: string, sessionId: string, group: ProviderGroupKey): ProviderGroupAssignment | undefined {
    const key = JSON.stringify([deviceId, sessionId, groupKey(group)]), value = this.#remoteSelections.get(key); this.#remoteSelections.delete(key);
    if (!value || this.now() - value.at > 30_000) return undefined; value.assignment.assertCurrent(); return value.assignment;
  }
  async pick(input: ProviderGroupPick, signal: AbortSignal): Promise<ProviderGroupAssignment> {
    if (this.remote?.owns(input.group)) return this.remote.pick({ ...input, exclude: new Set([...this.tried(input.sessionId), ...(input.exclude ?? [])]) }, signal);
    const snapshot = this.store.snapshot(input.group); if (!snapshot.config) throw new ProviderGroupUnavailableError();
    if (input.fresh) await this.directory.refresh(signal);
    const members = await this.directory.members(snapshot.config.members, input, signal); signal.throwIfAborted();
    const current = this.store.snapshot(input.group); if (current.revision !== snapshot.revision || !current.config) throw new ProviderGroupUnavailableError();
    const cooling = this.store.cooling(input.group, this.now()), tried = this.tried(input.sessionId);
    const candidates = snapshot.config.members.map(member => {
      const status = members.find(status => status.member.key === member.key);
      return { id: member.key, available: status?.available === true && !cooling.some(row => row.memberKey === member.key && (row.modelId === undefined || row.modelId === status?.model?.modelId)),
        paused: member.paused && !(member.kind === "local" && input.ownTask), running: this.leases.count(member.key, status?.running), capacity: member.capacity, weight: member.weight,
        ...(status?.quota.usagePercent === undefined ? {} : { usagePercent: status.quota.usagePercent }),
        ...(status?.quota.weeklyResetAt === undefined ? {} : { weeklyResetAt: status.quota.weeklyResetAt }),
        ...(status?.quota.fiveHourResetAt === undefined ? {} : { fiveHourResetAt: status.quota.fiveHourResetAt }) };
    });
    const excluded = new Set([...tried, ...(input.exclude ?? [])]);
    // No await between current load, selection and the provisional reservation.
    const selected = selectProviderGroupMember(candidates, snapshot.config.strategy, { now: this.now(), random: this.random, exclude: excluded,
      ...(this.#lastPicked.has(groupKey(input.group)) ? { lastPicked: this.#lastPicked.get(groupKey(input.group))! } : {}) });
    const status = members.find(member => member.member.key === selected); if (!status?.model || !status.available) throw new ProviderGroupUnavailableError();
    status.assertCurrent(); const member = status.member;
    const reservation = this.leases.reserve({ sessionId: input.sessionId, memberKey: member.key, backendId: member.backendId, providerId: member.providerId });
    this.#lastPicked.set(groupKey(input.group), member.key);
    const profile: SessionRuntimeProfile = { ...input.profile, backendId: member.backendId, providerId: member.providerId, modelId: status.model.modelId };
    let committed = false;
    const assertCurrent = () => {
      status.assertCurrent(); const current = this.store.snapshot(input.group);
      if (current.revision !== snapshot.revision || !current.config?.members.some(row => row.key === member.key)) throw new ProviderGroupUnavailableError();
    };
    return { group: input.group, snapshot, member, status, profile, assertCurrent, release: reservation.release,
      commit: () => {
        if (committed) return; assertCurrent();
        this.store.commitBinding(input.sessionId, { group: input.group, groupRevision: snapshot.revision.toString(), memberKey: member.key,
          backendId: profile.backendId, providerId: profile.providerId, modelId: profile.modelId }, snapshot.revision); committed = true;
      } };
  }
  markTried(sessionId: string, memberKey: string): void {
    const keys = this.tried(sessionId); keys.add(memberKey); this.#tried.set(sessionId, { keys, until: this.now() + 30 * 60_000 });
  }
  tried(sessionId: string): Set<string> {
    const value = this.#tried.get(sessionId); if (!value || value.until <= this.now()) { this.#tried.delete(sessionId); return new Set(); }
    return new Set(value.keys);
  }
  clearTurn(sessionId: string): void { this.#tried.delete(sessionId); }
  unmarkTried(sessionId: string, memberKey: string): void {
    const value = this.#tried.get(sessionId); value?.keys.delete(memberKey);
  }
  cool(group: ProviderGroupKey, member: ProviderGroupMember, modelId: string, signals: ProviderGroupFailureSignals, decision: ProviderGroupFailureDecision): void {
    if (this.remote?.owns(group)) { this.remote.cool(group, member, modelId, signals, decision); return; }
    if (decision.action !== "switch" || !decision.cool || !["usage-limit", "auth", "overload"].includes(decision.cause)) return;
    const cause = decision.cause as "usage-limit" | "auth" | "overload", now = this.now();
    const reset = signals.usageResetAt;
    this.store.cool(group, { memberKey: member.key, cause, ...(signals.modelScoped ? { modelId } : {}),
      until: cause === "usage-limit" ? reset !== undefined && Number.isFinite(reset) && reset > now ? reset : now + 30 * 60_000 : now + 2 * 60_000 }, now);
  }
}
