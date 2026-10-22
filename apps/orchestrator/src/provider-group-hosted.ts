import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { JokoError, type NativeSessionState, type UsageSnapshot } from "@joko/core";
import type { ProviderGroupHostedBinding, ProviderGroupMember } from "@joko/store";
import type { HostedAgentEndpointPort } from "./hosted-agent-connect-service.js";
import { HostedAgentHostError, type HostedAgentHost, type HostedAgentOpen, type HostedAgentPrincipal, type HostedAgentPollCursor, type HostedAgentPollRun } from "./hosted-agent-host.js";
import type { HostedAgentCall } from "./hosted-agent-run.js";
import { HostedAgentExchange, HOSTED_AGENT_UNREAD_LIMIT, type HostedAgentFrame } from "./hosted-agent-exchange.js";
import { HostedAgentPoller, type HostedAgentTransport } from "./hosted-agent-poller.js";
import type { ProviderGroupRuntime } from "./provider-group-runtime.js";
import type { ProviderGroupAssignment } from "./provider-group-router.js";
import { decideProviderGroupFailure, providerGroupFailureSignals, ProviderGroupUnavailableError } from "./provider-group-failure-policy.js";
import type { HostedAgentRunPort } from "./hosted-agent-controller.js";

interface NativeClient extends HostedAgentTransport {
  open(input: HostedAgentOpen, signal: AbortSignal): Promise<{ readonly virtualRoot: string }>;
  call(runId: string, callId: string, command: HostedAgentCall, signal: AbortSignal): Promise<unknown>;
}
export interface ProviderGroupNativeCapture {
  readonly client: NativeClient; readonly poller?: HostedAgentPoller; assertCurrent(): void;
  close(runId: string, signal: AbortSignal): Promise<void>;
}
export interface ProviderGroupHostedOptions {
  readonly base: HostedAgentHost; readonly runtime: ProviderGroupRuntime; readonly root: string;
  readonly assertSelection: (principal: HostedAgentPrincipal, input: Pick<HostedAgentOpen, "backendId" | "providerId" | "modelId">) => void;
  /** Captured native-only authority, never a URL, bearer or caller-selected trust. */
  readonly capture: (member: ProviderGroupMember, principal: HostedAgentPrincipal, modelIds: readonly string[], assertCurrent: () => void) => ProviderGroupNativeCapture;
  readonly now?: () => number;
}
interface Offer { readonly principal: string; readonly device: string; readonly session: string; readonly target: string; readonly backend: string; readonly provider: string; readonly model: string; readonly at: number; }
interface Entry {
  readonly principal: HostedAgentPrincipal; readonly input: HostedAgentOpen; readonly digest: string; readonly scope: string;
  readonly exchange: HostedAgentExchange; readonly virtualRoot: string; readonly lifetime: AbortController;
  readonly opening: Promise<void>; readonly calls: Map<string, { readonly digest: string; readonly value: Promise<unknown> }>;
  binding?: ProviderGroupHostedBinding; capture?: ProviderGroupNativeCapture; port?: HostedAgentRunPort & { detach(): void };
  actualRoot?: string; pump?: Promise<void>; closing?: Promise<void>; closed?: number;
  attempt?: AbortController;
  startupComplete: boolean; offered?: boolean; turn?: string; lastUsage?: UsageSnapshot; touched: number;
}
/** A group computer owns selection and forwarding. All SDK messages, tools,
 * approvals and artifacts keep the original Source call identities. A member
 * failure offers C a native handoff; this relay never replays C's prompt. */
export class ProviderGroupHostedEndpoint implements HostedAgentEndpointPort {
  readonly #entries = new Map<string, Entry>();
  readonly #offers = new Map<string, Offer>();
  readonly #pools = new Map<string, HostedAgentPoller>();
  readonly #wake = new Set<() => void>();
  readonly #polling = new Set<string>();
  readonly #timer: ReturnType<typeof setInterval>;
  #closed = false;
  constructor(readonly options: ProviderGroupHostedOptions) {
    this.#timer = setInterval(() => { void this.sweep().catch(() => {}); }, 5000); this.#timer.unref();
  }
  async begin(principal: HostedAgentPrincipal, input: HostedAgentOpen): Promise<{ readonly workspaceRoot: string }> {
    this.#assert(principal);
    const group = this.options.runtime.store.snapshot({ backendId: input.backendId, providerId: input.providerId });
    const scope = hash([principal.id, principal.deviceId, input.backendId, input.providerId, input.sessionId, input.targetId, input.nativeSessionId]);
    const retained = this.options.runtime.store.hostedBinding(scope);
    if (principal.providerGrant?.groupMember || principal.trust === "owner" && input.groupMember || !group.config && !retained) return this.options.base.begin(principal, input);
    const key = this.#key(principal, input.runId), digest = hash(input), previous = this.#entries.get(key);
    if (previous) { this.#entry(principal, input.runId); if (digest !== previous.digest) throw new HostedAgentHostError("CONFLICT"); return { workspaceRoot: previous.virtualRoot }; }
    if (this.#entries.size >= 65_536) throw new HostedAgentHostError("RESOURCE_EXHAUSTED");
    if (principal.trust === "guest") {
      const grant = principal.providerGrant;
      if (!grant || grant.backendId !== input.backendId || grant.providerId !== input.providerId || !grant.modelIds.includes(input.modelId)) throw new HostedAgentHostError("ACCESS_DENIED");
    }
    // The handle is available before SDK startup; reverse startup tools may
    // already need C's controller while the first state call awaits readiness.
    const lifetime = new AbortController(), virtualRoot = join(this.options.root, "groups", hash([scope, principal.id, input.runId]), "workspace");
    let entry!: Entry;
    const exchange = new HostedAgentExchange({ assertCurrent: () => { this.#assert(principal); if (entry) this.#assertEntry(entry); }, onOverflow: () => { if (entry) void this.#close(entry).catch(() => {}); } });
    entry = { principal, input: structuredClone(input), scope, digest, lifetime, virtualRoot, exchange, startupComplete: false, calls: new Map(), touched: this.#now(),
      opening: Promise.resolve().then(() => this.#open(entry, retained)).catch(error => { exchange.finish(); throw error; }) };
    this.#entries.set(key, entry); exchange.onOutput(() => this.#notify()); void entry.opening.catch(() => {});
    return { workspaceRoot: virtualRoot };
  }
  async call(principal: HostedAgentPrincipal, runId: string, callId: string, command: HostedAgentCall): Promise<unknown> {
    const entry = this.#entries.get(this.#key(principal, runId)); if (!entry) return this.options.base.call(principal, runId, callId, command);
    this.#assertEntry(entry, principal); const digest = hash(command), previous = entry.calls.get(callId);
    if (!callId || callId.length > 512 || /[\0\r\n]/u.test(callId)) throw new HostedAgentHostError("INVALID_REQUEST");
    if (previous) { if (previous.digest !== digest) throw new HostedAgentHostError("CONFLICT"); return previous.value; }
    if (entry.calls.size >= 65_536) throw new HostedAgentHostError("RESOURCE_EXHAUSTED");
    const value = Promise.resolve().then(async () => {
      await entry.opening; this.#assertEntry(entry, principal); entry.touched = this.#now();
      if (command.kind === "send") {
        if (entry.turn) throw new HostedAgentHostError("CONFLICT");
        if (command.newGroupRound) this.options.runtime.router.clearTurn(this.#session(entry));
        entry.offered = false;
        await this.#beforeSend(entry);
        const attribution = this.#attribution(entry);
        const state = await entry.capture!.client.call(runId, randomUUID(), { kind: "state" }, entry.lifetime.signal) as NativeSessionState;
        this.#assertEntry(entry); entry.lastUsage = state.usage;
        entry.turn = hash([entry.input.runId, callId]);
        this.options.runtime.usage.usage.captureNative(entry.turn, [attribution], state.usage, entry.principal.trust === "guest" || entry.binding!.member.kind === "share");
        const member = entry.binding!.member;
        this.options.runtime.leases.started({ sessionId: this.#session(entry), memberKey: member.key, backendId: member.backendId, providerId: member.providerId });
      }
      let forwarded = this.#down(entry, command) as HostedAgentCall;
      if (command.kind === "set_model") {
        this.options.assertSelection(principal, { backendId: entry.input.backendId, providerId: command.providerId, modelId: command.modelId });
        if (command.providerId !== entry.input.providerId) throw new HostedAgentHostError("ACCESS_DENIED");
        const model = this.options.runtime.directory.sources().find(source => source.backendId === entry.binding!.member.backendId && source.providerId === entry.binding!.member.providerId)?.models
          .find(model => model.modelId === command.modelId || (model.logicalId ?? model.modelId) === command.modelId);
        if (!model) throw new HostedAgentHostError("UNAVAILABLE");
        forwarded = { kind: "set_model", providerId: entry.binding!.member.providerId, modelId: model.modelId };
      }
      try {
        const result = await entry.capture!.client.call(runId, callId, forwarded, entry.lifetime.signal); this.#assertEntry(entry);
        if (command.kind === "set_model") entry.binding = { ...entry.binding!, modelId: (forwarded as Extract<HostedAgentCall, { kind: "set_model" }>).modelId, outerModelId: command.modelId };
        return this.#result(entry, result);
      } catch (error) {
        if (command.kind === "send" && providerGroupFailureSignals(error).stateMayHaveChanged !== true) { await this.#finishTurn(entry); this.#offer(entry, error); }
        throw error;
      }
    });
    entry.calls.set(callId, { digest, value }); void value.catch(() => {}); return value;
  }
  async poll(principal: HostedAgentPrincipal, cursors: readonly HostedAgentPollCursor[], signal: AbortSignal, waitMs = 30_000): Promise<readonly HostedAgentPollRun[]> {
    this.#assert(principal); signal.throwIfAborted();
    if (this.#polling.has(principal.id) || cursors.length > 1000 || new Set(cursors.map(value => value.runId)).size !== cursors.length) throw new HostedAgentHostError("CONFLICT");
    const relayed = cursors.filter(cursor => this.#entries.has(this.#key(principal, cursor.runId))), direct = cursors.filter(cursor => !this.#entries.has(this.#key(principal, cursor.runId)));
    if (!relayed.length) return this.options.base.poll(principal, cursors, signal, waitMs);
    this.#polling.add(principal.id); const read = async () => {
      const runs: HostedAgentPollRun[] = []; let budget = HOSTED_AGENT_UNREAD_LIMIT;
      for (const cursor of relayed) {
        const entry = this.#entry(principal, cursor.runId); entry.touched = this.#now();
        const value = await entry.exchange.poll(cursor.after, signal, 0, budget); runs.push({ runId: cursor.runId, ...value }); budget -= Buffer.byteLength(JSON.stringify(value.frames)); if (budget < 1) break;
      }
      if (direct.length && budget > 0) runs.push(...await this.options.base.poll(principal, direct, signal, 0)); return runs;
    };
    let timer: ReturnType<typeof setTimeout> | undefined; let wake!: () => void; const changed = new Promise<void>(resolve => { wake = resolve; this.#wake.add(wake); });
    const abort = () => wake(); signal.addEventListener("abort", abort, { once: true });
    try {
      let runs = await read();
      if (waitMs > 0 && !runs.some(run => run.frames.length || run.finished)) {
        const cancelled = new AbortController(); timer = setTimeout(wake, Math.min(30_000, waitMs)); timer.unref();
        const base = direct.length ? this.options.base.poll(principal, direct, AbortSignal.any([signal, cancelled.signal]), Math.min(30_000, waitMs)).then(() => wake()) : undefined;
        try { await changed; } finally { cancelled.abort(); await base?.catch(() => {}); }
        this.#assert(principal); signal.throwIfAborted(); runs = await read();
      }
      return runs;
    } finally { clearTimeout(timer); this.#wake.delete(wake); signal.removeEventListener("abort", abort); this.#polling.delete(principal.id); }
  }
  async reply(principal: HostedAgentPrincipal, runId: string, id: string, value: Parameters<HostedAgentEndpointPort["reply"]>[3]): Promise<void> {
    const entry = this.#entries.get(this.#key(principal, runId)); if (!entry) return this.options.base.reply(principal, runId, id, value);
    this.#assertEntry(entry, principal); await entry.capture!.client.reply(runId, id, this.#down(entry, value) as typeof value, entry.lifetime.signal); this.#assertEntry(entry);
  }
  async readArtifact(principal: HostedAgentPrincipal, runId: string, id: string, offset: number, maximum: number): Promise<{ readonly data: string }> {
    const entry = this.#entries.get(this.#key(principal, runId)); if (!entry) return this.options.base.readArtifact(principal, runId, id, offset, maximum);
    this.#assertEntry(entry, principal); const result = await entry.capture!.client.readArtifact(runId, id, offset, maximum, entry.lifetime.signal); this.#assertEntry(entry); return result;
  }
  async close(principal: HostedAgentPrincipal, runId: string): Promise<void> {
    const entry = this.#entries.get(this.#key(principal, runId)); if (!entry) return this.options.base.close(principal, runId); this.#assertEntry(entry, principal); await this.#close(entry);
  }
  async closePrincipal(principal: HostedAgentPrincipal): Promise<void> {
    await allClosed([...this.#entries.values()].filter(entry => entry.principal === principal).map(entry => this.#close(entry))); await this.options.base.closePrincipal(principal);
  }
  async closeProviderGrant(digest: string, runId: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new HostedAgentHostError("INVALID_REQUEST");
    await allClosed([...this.#entries.values()].filter(entry => entry.principal.trust === "guest" && entry.principal.providerGrant?.cleanupKey === digest && entry.input.runId === runId).map(entry => this.#close(entry)));
    await this.options.base.closeProviderGrant(digest, runId);
  }
  async closeRelayedGuest(principal: HostedAgentPrincipal, runId: string, purge: boolean): Promise<void> {
    await allClosed([...this.#entries.values()].filter(entry => entry.principal.id === principal.id && entry.principal.deviceId === principal.deviceId && entry.principal.trust === "guest" && entry.input.runId === runId).map(entry => this.#close(entry)));
    await this.options.base.closeRelayedGuest(principal, runId, purge);
  }
  activeProviderTurns(backendId: string, providerId: string): number {
    return [...this.#entries.values()].filter(entry => entry.turn && entry.closed === undefined && entry.binding?.member.kind !== "local" && entry.input.backendId === backendId && entry.input.providerId === providerId).length
      + this.options.base.activeProviderTurns(backendId, providerId);
  }
  async sweep(): Promise<void> {
    const now = this.#now(); for (const [key, offer] of this.#offers) if (now - offer.at > 600_000) this.#offers.delete(key);
    for (const [key, entry] of this.#entries) {
      let expired = this.#closed || now - entry.touched >= 180_000; try { this.#assertEntry(entry); } catch { expired = true; }
      if (expired && entry.closed === undefined) await this.#close(entry).catch(() => {});
      if (entry.closed !== undefined && now - entry.closed >= 60_000) { entry.exchange.close(); this.#entries.delete(key); }
    }
    await this.options.base.sweep();
  }
  async dispose(): Promise<void> {
    this.#closed = true; clearInterval(this.#timer); this.#notify(); await allClosed([...this.#entries.values()].map(entry => this.#close(entry)));
    await Promise.all([...this.#pools.values()].map(pool => pool.close())); this.#pools.clear(); for (const entry of this.#entries.values()) entry.exchange.close(); this.#entries.clear(); this.#offers.clear();
  }
  async #open(entry: Entry, retained: ProviderGroupHostedBinding | undefined): Promise<void> {
    const runtime = this.options.runtime, sessionId = this.#session(entry), group = { backendId: entry.input.backendId, providerId: entry.input.providerId };
    if (retained && !["ready", "closed"].includes(retained.phase)) throw unknown();
    const offer = entry.input.groupSwitch ? this.#offers.get(entry.input.groupSwitch) : undefined;
    if (entry.input.groupSwitch) {
      if (!offer || this.#now() - offer.at > 600_000 || offer.principal !== entry.principal.id || offer.device !== entry.principal.deviceId || offer.session !== entry.input.sessionId
        || offer.target !== entry.input.targetId || offer.backend !== entry.input.backendId || offer.provider !== entry.input.providerId || offer.model !== entry.input.modelId) throw new HostedAgentHostError("ACCESS_DENIED");
      this.#offers.delete(entry.input.groupSwitch);
    }
    if (!retained || offer) this.options.assertSelection(entry.principal, entry.input);
    if (retained && entry.input.start !== "resume") throw new HostedAgentHostError("CONFLICT");
    const failures = new Set(runtime.router.tried(sessionId));
    for (;;) {
      this.#assertEntry(entry); let assignment: ProviderGroupAssignment | undefined;
      if (retained) entry.binding = retained;
      else {
        const source = runtime.directory.sources().find(source => source.backendId === entry.input.backendId && source.providerId === entry.input.providerId);
        if (!source) throw new ProviderGroupUnavailableError();
        assignment = (entry.principal.trust === "owner" ? runtime.router.takeRemoteSelection(entry.principal.deviceId, entry.input.sessionId, group) : undefined)
          ?? await runtime.router.pick({ sessionId, group, profile: { backendId: group.backendId, providerId: group.providerId, modelId: entry.input.modelId, fastMode: entry.input.fastMode,
          ...(entry.input.effort === undefined ? {} : { effort: entry.input.effort }) }, agentKind: source.agentKind, modelId: entry.input.modelId, logicalModelId: entry.input.modelId,
          ownTask: false, ...(entry.principal.providerGrant?.recipient ? { recipient: entry.principal.providerGrant.recipient } : {}), exclude: failures, fresh: failures.size > 0 }, entry.lifetime.signal);
        entry.binding = { format: 1, id: entry.scope, group, groupRevision: assignment.snapshot.revision.toString(), member: assignment.member, modelId: assignment.profile.modelId,
          outerModelId: entry.input.modelId, phase: "opening" };
      }
      const binding = entry.binding!; const member = binding.member;
      const assertCurrent = () => { this.#assertEntry(entry); entry.principal.providerGrant?.assertCurrent(); };
      try {
        const source = runtime.directory.sources().find(source => source.backendId === member.backendId && source.providerId === member.providerId && source.nodeId === member.nodeId);
        if (!source) throw new ProviderGroupUnavailableError(); source.assertCurrent(); assignment?.assertCurrent();
        const models = source.models.filter(model => entry.principal.trust === "owner" || entry.principal.providerGrant!.modelIds.includes(model.modelId) || entry.principal.providerGrant!.modelIds.includes(model.logicalId ?? model.modelId));
        if (!models.some(model => model.modelId === binding.modelId)) throw new HostedAgentHostError("ACCESS_DENIED");
        runtime.store.stageHostedBinding({ ...binding, id: entry.scope });
        entry.capture = member.kind === "local" ? this.#local(entry, models.map(model => model.modelId), assertCurrent) : this.options.capture(member, entry.principal, models.map(model => model.modelId), assertCurrent);
        entry.capture.assertCurrent();
        const opened = await entry.capture.client.open({ ...entry.input, backendId: member.nativeBackendId, providerId: member.providerId, modelId: binding.modelId,
          nativeSessionId: hash([entry.input.nativeSessionId, member.key]), start: retained ? "resume" : "create", groupSwitch: undefined }, entry.lifetime.signal);
        entry.actualRoot = opened.virtualRoot; this.#pump(entry);
        const state = await entry.capture.client.call(entry.input.runId, randomUUID(), { kind: "state" }, entry.lifetime.signal) as NativeSessionState;
        this.#assertEntry(entry); entry.capture.assertCurrent(); source.assertCurrent(); assignment?.assertCurrent(); entry.lastUsage = state.usage;
        runtime.store.settleHostedBinding(entry.scope, "ready"); entry.binding = runtime.store.hostedBinding(entry.scope)!; entry.startupComplete = true; assignment?.release(); return;
      } catch (error) {
        assignment?.release();
        try { await this.#closeNative(entry); } catch { runtime.store.settleHostedBinding(entry.scope, "unknown"); throw unknown(); }
        runtime.store.settleHostedBinding(entry.scope, "closed");
        if (retained || !runtime.store.snapshot(group).config?.autoSwitch) throw error;
        const decision = decideProviderGroupFailure(providerGroupFailureSignals(error), "start"); if (decision.action !== "switch") throw error;
        failures.add(member.key); runtime.router.markTried(sessionId, member.key); runtime.router.cool(group, member, binding.modelId, providerGroupFailureSignals(error), decision);
        entry.capture = undefined; entry.port = undefined; entry.actualRoot = undefined;
      }
    }
  }
  #local(entry: Entry, models: readonly string[], assertCurrent: () => void): ProviderGroupNativeCapture {
    const member = entry.binding!.member, original = entry.principal, id = "group-native:" + hash([original.id, member.key]);
    const principal: HostedAgentPrincipal = { ...original, id, assertCurrent,
      ...(original.providerGrant ? { providerGrant: { ...original.providerGrant, groupMember: true, backendId: member.nativeBackendId, providerId: member.providerId, modelIds: models, assertCurrent } } : {}) };
    const base = this.options.base;
    const pollingPrincipal: HostedAgentPrincipal = { id, deviceId: original.deviceId, trust: original.trust,
      assertCurrent: () => { if (this.#closed) throw new HostedAgentHostError("UNAVAILABLE"); } };
    const client: NativeClient = { open: async input => ({ virtualRoot: (await base.begin(principal, input)).workspaceRoot }), call: (_run, call, command) => base.call(principal, entry.input.runId, call, command),
      // Base Host rechecks every entry's original authority. The multiplexing
      // reader itself must not inherit the lifetime of the first attached run.
      poll: (cursors, signal) => base.poll(pollingPrincipal, cursors, signal), reply: (run, request, value) => base.reply(pollingPrincipal, run, request, value), readArtifact: (run, id, offset, maximum) => base.readArtifact(pollingPrincipal, run, id, offset, maximum) };
    const poolKey = JSON.stringify(["local", id]), poller = this.#pools.get(poolKey) ?? new HostedAgentPoller(client); this.#pools.set(poolKey, poller);
    return { client, poller, assertCurrent, close: () => base.closePrincipal(principal) };
  }
  #pump(entry: Entry): void {
    const capture = entry.capture!, key = hash([entry.principal.id, entry.principal.deviceId, entry.binding!.member.key, entry.principal.providerGrant?.recipient]);
    const poller = capture.poller ?? this.#pools.get(key) ?? new HostedAgentPoller(capture.client); if (!capture.poller) this.#pools.set(key, poller);
    const port = poller.attach(entry.input.runId); entry.port = port;
    const attempt = new AbortController(); entry.attempt = attempt; const signal = AbortSignal.any([entry.lifetime.signal, attempt.signal]);
    entry.pump = (async () => {
      let cursor = 0;
      for (;;) {
        const batch = await port.poll(cursor, signal); this.#assertEntry(entry);
        for (const frame of batch.frames) {
          if (frame.sequence !== cursor + 1) throw new HostedAgentHostError("CONFLICT"); cursor = frame.sequence;
          if (frame.payload.kind === "event") {
            const event = frame.payload.event;
            if (event.type === "usage") entry.lastUsage = event.usage;
            if (event.type === "error" && event.terminal && entry.startupComplete) this.#offer(entry, event.error);
            if (event.type === "done") { await this.#finishTurn(entry); if (event.outcome === "completed") this.options.runtime.router.clearTurn(this.#session(entry)); }
          }
          entry.exchange.forward(this.#up(entry, frame.payload) as HostedAgentFrame["payload"]);
        }
        if (batch.cursor !== cursor) throw new HostedAgentHostError("CONFLICT");
        if (batch.finished) { if (entry.startupComplete) entry.exchange.finish(); return; }
      }
    })().catch(error => { if (!signal.aborted && entry.closed === undefined && entry.startupComplete) { this.#offer(entry, { code: "HOSTED_SOURCE_DISCONNECTED" });
      entry.exchange.emit({ type: "error", terminal: true, error: { code: "HOSTED_SOURCE_DISCONNECTED", message: "The group member connection ended.", phase: "transport", retryable: true, stateMayHaveChanged: false, recovery: "Wait for the original task to reconnect or hand off." } }); entry.exchange.emit({ type: "done", outcome: "failed" }); }
      void error; if (!signal.aborted && entry.startupComplete) entry.exchange.finish(); });
  }
  async #beforeSend(entry: Entry): Promise<void> {
    const binding = entry.binding!, group = this.options.runtime.store.snapshot(binding.group);
    if (!group.config?.members.some(member => member.key === binding.member.key)) return;
    const source = this.options.runtime.directory.sources().find(source => source.backendId === binding.member.backendId && source.providerId === binding.member.providerId);
    const status = await this.options.runtime.directory.read(binding.member, { agentKind: source?.agentKind ?? "", modelId: binding.modelId, ownTask: false, fresh: true,
      ...(entry.principal.providerGrant?.recipient ? { recipient: entry.principal.providerGrant.recipient } : {}) }, entry.lifetime.signal);
    if (status.available && !this.options.runtime.store.cooling(binding.group, this.#now()).some(row => row.memberKey === binding.member.key && (!row.modelId || row.modelId === binding.modelId))) { status.assertCurrent(); return; }
    this.#offer(entry, { code: "HOSTED_AGENT_UNAVAILABLE" }); throw closedFailure("The selected Provider group member is unavailable.");
  }
  #offer(entry: Entry, error: unknown): void {
    const binding = entry.binding; if (!binding || !entry.startupComplete || entry.offered) return;
    const runtime = this.options.runtime, group = runtime.store.snapshot(binding.group), decision = decideProviderGroupFailure(providerGroupFailureSignals(error), "run");
    if (!group.config?.autoSwitch || !group.config.members.some(member => member.key === binding.member.key) || decision.action !== "switch") return;
    runtime.router.markTried(this.#session(entry), binding.member.key); runtime.router.cool(binding.group, binding.member, binding.modelId, providerGroupFailureSignals(error), decision);
    if (group.config.members.every(member => runtime.router.tried(this.#session(entry)).has(member.key))) return;
    entry.offered = true; const value = randomBytes(32).toString("hex"); this.#offers.set(value, { principal: entry.principal.id, device: entry.principal.deviceId, session: entry.input.sessionId, target: entry.input.targetId,
      backend: entry.input.backendId, provider: entry.input.providerId, model: binding.outerModelId, at: this.#now() }); entry.exchange.forward({ kind: "group_switch", offer: value });
  }
  async #finishTurn(entry: Entry): Promise<void> {
    const turn = entry.turn; if (!turn) return; entry.turn = undefined;
    try {
      const state = await entry.capture?.client.call(entry.input.runId, randomUUID(), { kind: "state" }, entry.lifetime.signal) as NativeSessionState | undefined;
      if (state?.usage) entry.lastUsage = state.usage;
    } catch { /* Keep the last actual SDK observation and its completeness flags. */ }
    this.options.runtime.usage.usage.finishNative(turn, entry.lastUsage, this.#now()); this.options.runtime.leases.ended(this.#session(entry));
  }
  #attribution(entry: Entry) {
    const member = entry.binding!.member, recipient = entry.principal.providerGrant?.recipient;
    return { group: entry.binding!.group, memberKey: member.key, backendId: member.backendId, providerId: member.providerId, modelId: entry.binding!.modelId,
      nodeId: member.nodeId, nodeName: member.displayName, partyId: entry.principal.trust === "guest" ? recipient?.memberId ?? entry.principal.id : this.options.runtime.store.ownerKey,
      partyName: entry.principal.trust === "guest" ? recipient?.name || "Guest" : this.options.runtime.nodeName(),
      agentKind: this.options.runtime.directory.sources().find(source => source.backendId === member.backendId && source.providerId === member.providerId)?.agentKind ?? "native" };
  }
  #result(entry: Entry, result: unknown): unknown {
    const value = this.#up(entry, result); if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const object = value as Record<string, unknown>; if (typeof object["providerId"] === "string") return { ...object, providerId: entry.input.providerId, ...(typeof object["modelId"] === "string" ? { modelId: entry.binding!.outerModelId } : {}) }; return value;
  }
  #up(entry: Entry, value: unknown): unknown { return mapPaths(value, entry.actualRoot, entry.virtualRoot); }
  #down(entry: Entry, value: unknown): unknown { return mapPaths(value, entry.virtualRoot, entry.actualRoot); }
  #close(entry: Entry): Promise<void> {
    return entry.closing ??= (async () => {
      entry.lifetime.abort(); entry.port?.detach(); entry.exchange.finish(); await this.#closeNative(entry); await entry.opening.catch(() => {}); await this.#closeNative(entry);
      await entry.pump; if (entry.binding) this.options.runtime.store.settleHostedBinding(entry.scope, "closed");
      if (entry.turn) { this.options.runtime.usage.usage.finishNative(entry.turn, entry.lastUsage, this.#now()); entry.turn = undefined; }
      this.options.runtime.leases.ended(this.#session(entry)); entry.closed = this.#now(); this.#notify();
    })().finally(() => { entry.closing = undefined; });
  }
  async #closeNative(entry: Entry): Promise<void> { entry.attempt?.abort(); entry.port?.detach(); if (entry.capture) await entry.capture.close(entry.input.runId, AbortSignal.timeout(30_000)); await entry.pump; }
  #assert(principal: HostedAgentPrincipal): void { if (this.#closed) throw new HostedAgentHostError("UNAVAILABLE"); principal.assertCurrent(); principal.providerGrant?.assertCurrent(); }
  #assertEntry(entry: Entry, caller?: HostedAgentPrincipal): void {
    if (caller && (caller.id !== entry.principal.id || caller.deviceId !== entry.principal.deviceId || caller.trust !== entry.principal.trust)) throw new HostedAgentHostError("ACCESS_DENIED");
    this.#assert(entry.principal); if (entry.closed !== undefined) throw new HostedAgentHostError("UNAVAILABLE");
    entry.lifetime.signal.throwIfAborted();
  }
  #entry(principal: HostedAgentPrincipal, runId: string): Entry { const entry = this.#entries.get(this.#key(principal, runId)); if (!entry) throw new HostedAgentHostError("UNAVAILABLE"); this.#assertEntry(entry, principal); return entry; }
  #key(principal: HostedAgentPrincipal, runId: string): string { return JSON.stringify([principal.id, runId]); }
  #session(entry: Entry): string { return hash([entry.principal.id, entry.principal.deviceId, entry.input.sessionId, entry.input.targetId, entry.input.backendId, entry.input.providerId]); }
  #now(): number { return this.options.now?.() ?? Date.now(); }
  #notify(): void { for (const wake of [...this.#wake]) wake(); }
}
export function createProviderGroupHostedEndpoint(options: ProviderGroupHostedOptions): ProviderGroupHostedEndpoint { return new ProviderGroupHostedEndpoint(options); }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function unknown(): JokoError { return new JokoError({ code: "NATIVE_DISPATCH_UNKNOWN", message: "The original native group effect could not be confirmed.", phase: "session_start", retryable: false, stateMayHaveChanged: true, recovery: "Inspect the original native context before another creation." }); }
function closedFailure(message: string): JokoError { return new JokoError({ code: "HOSTED_AGENT_UNAVAILABLE", message, phase: "dispatch", retryable: true, stateMayHaveChanged: false, recovery: "Use the offered native handoff." }); }
async function allClosed(promises: readonly Promise<unknown>[]): Promise<void> { const results = await Promise.allSettled(promises); if (results.some(result => result.status === "rejected")) throw new HostedAgentHostError("UNAVAILABLE"); }
function mapPaths(value: unknown, from: string | undefined, to: string | undefined): unknown {
  if (!from || !to || from === to) return value;
  if (typeof value === "string") {
    const variants = [...new Set([from, from.replace(/\\/gu, "/"), from.replace(/\//gu, "\\")])]; let result = value;
    for (const source of variants) { let offset = 0, output = "";
      for (;;) { const index = result.indexOf(source, offset); if (index < 0) break; const after = result[index + source.length]; output += result.slice(offset, index) + (after === undefined || !/[\p{L}\p{N}_.-]/u.test(after) ? to : source); offset = index + source.length; }
      result = output + result.slice(offset);
    } return result;
  }
  if (Array.isArray(value)) return value.map(item => mapPaths(item, from, to));
  if (!value || typeof value !== "object") return value;
  const opaque = new Set(["id", "runId", "sessionId", "targetId", "backendId", "providerId", "modelId", "nativeSessionId", "opaqueRef", "sha256", "inputFingerprint", "data", "base64"]);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, opaque.has(key) ? item : mapPaths(item, from, to)]));
}
