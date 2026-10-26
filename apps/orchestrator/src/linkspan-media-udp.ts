import { createHash, randomUUID } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { create } from "@bufbuild/protobuf";
import { REMOTE_DESKTOP_ICE_LIMITS, RemoteDesktopIceCandidateSchema, type RemoteDesktopIceCandidate, type RemoteDesktopIceExchangeResult } from "@joko/contracts";
import { operationBodyHash, type OperationalStore } from "@joko/store";
import type { ConnectorResource } from "@jokoagent/linkspan-connectors";
import { startDatagramMapping, type DatagramConfig, type DatagramMapping } from "@jokoagent/linkspan-connectors/datagram";
import type { DevicePeerSelectionIdentity } from "./device-peer-owner.js";
import type { OrchestratorConfig } from "./config.js";
import { linkspanMediaUdpEntryId, readLinkspanDeployment } from "./linkspan-deployment.js";
import type { CredentialManager } from "./credential-manager.js";
import { prepareLinkspanPrivateProviderPaths } from "./linkspan-private-paths.js";
import { captureLinkspanProcessIdentity, linkspanProcessIsRetired, ownLinkspanProcessIdentity } from "./linkspan-process-identity.js";

const PREFIX = "runtime.linkspan.media_udp.";
export interface MediaUdpInput {
  readonly controllerConnectionId: string;
  readonly hostConnectionId: string;
  readonly identity: DevicePeerSelectionIdentity;
  readonly leaseId: string;
  readonly attemptId: string;
  /** Original lease/attempt lifetime, never a completed polling RPC's signal. */
  readonly lifetimeSignal: AbortSignal;
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}
export interface RemoteDesktopUdpMappingProvider {
  mapAnswer(input: MediaUdpInput, sdp: string): Promise<string>;
  exchangeIce(input: MediaUdpInput, after: number, dispatch: (nativeAfter: number) => Promise<RemoteDesktopIceExchangeResult>): Promise<RemoteDesktopIceExchangeResult>;
  releaseLease(leaseId: string): Promise<void>;
  retireLocalCapture(input: { readonly hostConnectionId: string; readonly targetDeviceId: string; readonly leaseId: string; readonly attemptId: string }): Promise<void>;
  close(): Promise<void>;
}
interface MediaJournal {
  readonly requestId: string; readonly entryId: string; readonly provider: DatagramConfig["provider"];
  readonly leaseId: string; readonly attemptId: string; readonly connectionId: string;
  readonly hostConnectionId: string;
  readonly targetDeviceId: string; readonly routeGeneration: number;
  readonly ownerProcessId: number; readonly ownerProcessIdentity: string;
  readonly resource?: ConnectorResource; readonly resourceProcessIdentity?: string;
  readonly state: "starting" | "active" | "outcome_unknown" | "closed";
}
interface Section { readonly index: number; readonly mid?: string; readonly ufrag: string; readonly passwordDigest: string; readonly fingerprints: string; }
interface HostCandidate { readonly address: string; readonly port: number; readonly priority: number; readonly ufrag?: string; }
interface Attempt {
  readonly leaseId: string; readonly attemptId: string;
  readonly hostConnectionId: string; readonly targetDeviceId: string;
  readonly abort: AbortController; readonly sections: Map<number, Section>;
  readonly projection: RemoteDesktopIceCandidate[]; readonly publicSeen: Set<string>;
  nativeAfter: number; nativeComplete: boolean; exchange?: Promise<void>;
  selected?: HostCandidate; pending?: Promise<DatagramMapping>; mapping?: DatagramMapping;
  publicAddress?: string; record?: MediaJournal; retired: boolean; cleanup?: Promise<void>;
  cleanupUnknown?: boolean;
  answerProof?: string;
}
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Owns only the UDP publication, never capture permission, SDP, ICE credentials,
 * media sockets, or a replacement Remote Desktop state machine. Those remain
 * under the coordinator and its independently authenticated local Main route. */
export class LinkspanRemoteDesktopUdpMapping implements RemoteDesktopUdpMappingProvider {
  readonly #attempts = new Map<string, Attempt>();
  readonly #reported = new Set<string>();
  #active: Attempt | undefined;
  #blocked = false; #closed = false;
  #configuration: DatagramConfig | undefined;
  constructor(private readonly options: {
    readonly store: OperationalStore; readonly config: OrchestratorConfig; readonly serverId: string;
    readonly credentials?: CredentialManager;
    readonly isLocalDesktopRoute: (identity: DevicePeerSelectionIdentity) => boolean;
    readonly configuration?: DatagramConfig;
    readonly start?: typeof startDatagramMapping;
    readonly resolvePublicAddress?: (host: string, signal: AbortSignal) => Promise<string>;
  }) {}

  async initialize(): Promise<void> {
    const entryId = this.options.config.remoteDesktopUdp?.entryId;
    if (!entryId) return;
    let selected = this.options.configuration;
    if (!selected) {
      const path = this.options.config.linkspan?.deploymentPath;
      if (!path) throw new Error("UDP media requires the private Linkspan deployment file.");
      const entries = await readLinkspanDeployment(path, AbortSignal.timeout(15_000));
      selected = entries.find(entry => entry.id === entryId)?.mediaUdp;
    }
    if (!selected || !["netbird", "pangolin", "frp", "rathole", "pinggy"].includes(selected.provider)) throw new Error("The selected entry has no public UDP media configuration.");
    if (selected.provider === "netbird" && (!selected.resourceId || !selected.publicHost || !selected.publicPort || !selected.listenPort)) {
      if (!this.options.credentials) throw new Error("Restore the exact managed UDP resource before enabling media mapping.");
      const { resolveManagedLinkspanDatagram } = await import("./linkspan-resource-manager.js");
      selected = await resolveManagedLinkspanDatagram({ config: this.options.config, store: this.options.store,
        credentials: this.options.credentials }, { entryId, datagram: selected });
    }
    this.#configuration = await prepareLinkspanPrivateProviderPaths(this.options.config, linkspanMediaUdpEntryId(entryId), this.options.serverId, selected);
    for (const setting of this.options.store.listSettingsByKeyPrefix("service", "orchestrator", PREFIX)) {
      const record = setting.value as MediaJournal;
      if (record.entryId !== entryId || record.state === "closed") continue;
      const operation = this.options.store.findOperation(record.requestId);
      if (!operation || operation.kind !== "connection.media.udp.start" || operation.connectionId !== undefined
        || operation.completionMode !== "external_effect" || operation.status === "failed"
        || operation.bodyHash !== operationBodyHash(journalBody(record, this.options.serverId))) { this.#blocked = true; continue; }
      const resource = record.resource;
      if (resource?.provider === record.provider && resource.requestId === record.requestId && mediaProcessIsRetired(record)) this.#retired(record);
      else { this.#blocked = true; this.#save({ ...record, state: "outcome_unknown" }); }
    }
  }

  async mapAnswer(input: MediaUdpInput, sdp: string): Promise<string> {
    if (!this.#eligible(input)) return sdp;
    const attempt = await this.#attempt(input);
    if (!attempt) return sdp;
    const lines = sdp.split(/\r?\n/u); const sections = parseSections(lines);
    const proof = digest(JSON.stringify([...sections.values()]));
    if (attempt.answerProof !== undefined && attempt.answerProof !== proof) { await this.#retire(attempt); throw new Error("The original media ICE/DTLS identity changed."); }
    attempt.answerProof = proof;
    attempt.sections.clear(); for (const section of sections.values()) attempt.sections.set(section.index, section);
    let index = -1; const additions = new Map<number, string>();
    try {
      for (const line of lines) {
        if (line.startsWith("m=")) index++;
        const section = sections.get(index);
        if (!section || additions.has(index) || !line.startsWith("a=candidate:")) continue;
        const candidate = parseHostCandidate(line.slice(2)); if (!candidate || candidate.ufrag !== undefined && candidate.ufrag !== section.ufrag) continue;
        const mapped = await this.#candidate(input, attempt, candidate, section.ufrag);
        if (mapped) additions.set(index, `a=${mapped}`);
      }
      input.signal.throwIfAborted(); input.assertCurrent();
      if (additions.size === 0) { this.#unavailable(input, "candidate_unprovable"); return sdp; }
      const result: string[] = []; index = -1; const emitted = new Set<number>();
      const emit = (): void => { const value = additions.get(index); if (value && !emitted.has(index)) { result.push(value); emitted.add(index); } };
      for (const line of lines) { if (line.startsWith("m=")) { emit(); index++; } if (line === "a=end-of-candidates") emit(); result.push(line); }
      // Insert before the final line ending, preserving every original line.
      if (result.at(-1) === "") { result.pop(); emit(); result.push(""); } else emit();
      const rewritten = result.join(sdp.includes("\r\n") ? "\r\n" : "\n");
      return Buffer.byteLength(rewritten) <= 65_536 ? rewritten : sdp;
    } catch (error) { input.signal.throwIfAborted(); input.lifetimeSignal.throwIfAborted(); input.assertCurrent(); this.#unavailable(input, "provider_unavailable"); return sdp; }
  }

  async exchangeIce(input: MediaUdpInput, after: number, dispatch: (nativeAfter: number) => Promise<RemoteDesktopIceExchangeResult>): Promise<RemoteDesktopIceExchangeResult> {
    const attempt = this.#attempts.get(input.leaseId);
    if (!attempt || attempt.attemptId !== input.attemptId) return dispatch(after);
    const previous = attempt.exchange ?? Promise.resolve();
    const pending = (async () => {
      await previous; input.signal.throwIfAborted(); input.lifetimeSignal.throwIfAborted(); input.assertCurrent();
      if (!Number.isSafeInteger(after) || after < 0 || after > attempt.projection.length) throw new Error("The projected ICE cursor is invalid.");
      const value = await dispatch(attempt.nativeAfter);
      input.signal.throwIfAborted(); input.lifetimeSignal.throwIfAborted(); input.assertCurrent();
      if (value.attemptId !== input.attemptId || value.next !== attempt.nativeAfter + value.candidates.length || value.next > REMOTE_DESKTOP_ICE_LIMITS.maxLocalCandidates || value.candidates.length > REMOTE_DESKTOP_ICE_LIMITS.batchSize) throw new Error("The native ICE cursor changed.");
      attempt.nativeAfter = value.next; attempt.nativeComplete = value.complete;
      // Commit the complete native page before any provider await. A cancelled
      // publication must never lose the rest of an already-consumed ICE page.
      attempt.projection.push(...value.candidates);
      for (const original of value.candidates) {
        if (attempt.publicSeen.size >= 16) continue;
        const value = original;
        const candidate = parseHostCandidate(value.candidate);
        const section = value.sdpMLineIndex !== undefined ? attempt.sections.get(value.sdpMLineIndex)
          : [...attempt.sections.values()].find(section => section.mid !== undefined && section.mid === value.sdpMid);
        if (!candidate || !section || value.sdpMid !== undefined && value.sdpMid !== section.mid
          || value.usernameFragment !== undefined && value.usernameFragment !== section.ufrag
          || candidate.ufrag !== undefined && candidate.ufrag !== section.ufrag) continue;
        const key = `${section.index}:${section.ufrag}:${candidate.address}:${candidate.port}`;
        if (attempt.publicSeen.has(key)) continue;
        try {
          const mapped = await this.#candidate(input, attempt, candidate, section.ufrag);
          if (mapped) { attempt.publicSeen.add(key); attempt.projection.push(create(RemoteDesktopIceCandidateSchema, { ...value, candidate: mapped, usernameFragment: section.ufrag })); }
        } catch { input.signal.throwIfAborted(); input.lifetimeSignal.throwIfAborted(); input.assertCurrent(); this.#unavailable(input, "provider_unavailable"); }
      }
      if (attempt.projection.length > 144) throw new Error("The bounded ICE projection was exceeded.");
      input.signal.throwIfAborted(); input.lifetimeSignal.throwIfAborted(); input.assertCurrent();
      const candidates = attempt.projection.slice(after, after + REMOTE_DESKTOP_ICE_LIMITS.batchSize);
      return { ...value, candidates, next: after + candidates.length, complete: attempt.nativeComplete && after + candidates.length === attempt.projection.length };
    })();
    attempt.exchange = pending.then(() => {}, () => {}); return pending;
  }

  async releaseLease(leaseId: string): Promise<void> { const attempt = this.#attempts.get(leaseId); if (attempt) await this.#retire(attempt); this.#attempts.delete(leaseId); }
  async retireLocalCapture(input: { readonly hostConnectionId: string; readonly targetDeviceId: string; readonly leaseId: string; readonly attemptId: string }): Promise<void> {
    const attempt = this.#attempts.get(input.leaseId);
    if (attempt?.attemptId === input.attemptId) {
      if (attempt.hostConnectionId !== input.hostConnectionId || attempt.targetDeviceId !== input.targetDeviceId) throw new Error("The capture retirement belongs to another host.");
      await this.#retire(attempt); return;
    }
    // A restart cannot acknowledge a still-unknown previous publication merely
    // because its process-local capture table was lost.
    const unresolved = this.options.store.listSettingsByKeyPrefix("service", "orchestrator", PREFIX).some(({ value }) => {
      const record = value as MediaJournal; return record.hostConnectionId === input.hostConnectionId && record.targetDeviceId === input.targetDeviceId
        && record.leaseId === input.leaseId && record.attemptId === input.attemptId && record.state !== "closed";
    });
    if (unresolved) throw new Error("The original capture UDP cleanup is unconfirmed.");
  }
  async close(): Promise<void> { this.#closed = true; await Promise.all([...this.#attempts.values()].map(attempt => this.#retire(attempt))); this.#attempts.clear(); }
  #eligible(input: MediaUdpInput): boolean {
    input.signal.throwIfAborted(); input.lifetimeSignal.throwIfAborted(); input.assertCurrent();
    if (this.#closed || this.#blocked || !this.#configuration) return false;
    if (!input.hostConnectionId || !this.options.isLocalDesktopRoute(input.identity)) { this.#unavailable(input, "local_host_required"); return false; }
    return true;
  }
  async #attempt(input: MediaUdpInput): Promise<Attempt | undefined> {
    let attempt = this.#attempts.get(input.leaseId);
    if (attempt && attempt.attemptId !== input.attemptId) { await this.#retire(attempt); this.#attempts.delete(input.leaseId); attempt = undefined; }
    if (attempt) return attempt.retired ? undefined : attempt;
    if (this.#active && !this.#active.retired) { this.#unavailable(input, "mapping_busy"); return; }
    if (this.#active?.cleanup) await this.#active.cleanup;
    if (this.#blocked || !this.#eligible(input)) return;
    attempt = { leaseId: input.leaseId, attemptId: input.attemptId, hostConnectionId: input.hostConnectionId, targetDeviceId: input.identity.targetDeviceId, abort: new AbortController(), sections: new Map(), projection: [], publicSeen: new Set(), nativeAfter: 0, nativeComplete: false, retired: false };
    this.#attempts.set(input.leaseId, attempt); return attempt;
  }
  async #candidate(input: MediaUdpInput, attempt: Attempt, target: HostCandidate, ufrag: string): Promise<string | undefined> {
    if (!locallyOwned(target.address) || attempt.retired || !this.#eligible(input)) return;
    if (attempt.selected && (attempt.selected.address !== target.address || attempt.selected.port !== target.port)) return;
    if (!attempt.pending) {
      if (this.#active && this.#active !== attempt && !this.#active.retired) return;
      this.#active = attempt; attempt.selected = target;
      attempt.pending = this.#start(input, attempt, target);
      void attempt.pending.catch(() => {});
    }
    const stop = (): void => { void this.#retire(attempt).catch(() => {}); };
    input.signal.addEventListener("abort", stop, { once: true });
    let mapping: DatagramMapping;
    try { mapping = await attempt.pending; input.signal.throwIfAborted(); input.lifetimeSignal.throwIfAborted(); input.assertCurrent(); }
    finally { input.signal.removeEventListener("abort", stop); }
    if (attempt.retired || mapping.mapping.expiresAt <= Date.now() || !this.options.isLocalDesktopRoute(input.identity)) return;
    const address = attempt.publicAddress!;
    return `candidate:ls${digest(attempt.record!.requestId).slice(0, 12)} 1 udp ${Math.min(target.priority, 1694498815)} ${address} ${mapping.mapping.publicPort} typ srflx raddr ${target.address} rport ${target.port} generation 0 ufrag ${ufrag}`;
  }
  async #start(input: MediaUdpInput, attempt: Attempt, target: HostCandidate): Promise<DatagramMapping> {
    const config = this.#configuration!; const entryId = this.options.config.remoteDesktopUdp!.entryId;
    const requestId = `media-udp:${randomUUID()}`;
    let record: MediaJournal = { requestId, entryId, provider: config.provider, leaseId: input.leaseId, attemptId: input.attemptId,
      connectionId: input.controllerConnectionId, hostConnectionId: input.hostConnectionId, targetDeviceId: input.identity.targetDeviceId, routeGeneration: input.identity.routeGeneration,
      ownerProcessId: process.pid, ownerProcessIdentity: ownLinkspanProcessIdentity(), state: "starting" };
    const body = journalBody(record, this.options.serverId);
    const claim = this.options.store.claimDeferredEffectOperation({ id: requestId, kind: "connection.media.udp.start", body }, () => {
      if (!this.#eligible(input)) throw new Error("The original local media authority is unavailable."); input.assertCurrent(); this.#save(record);
    });
    attempt.record = record;
    const lifetime = AbortSignal.any([input.lifetimeSignal, attempt.abort.signal]);
    const stop = (): void => { void this.#retire(attempt).catch(() => {}); };
    lifetime.addEventListener("abort", stop, { once: true });
    try {
      if (config.publicHost !== undefined) attempt.publicAddress = await (this.options.resolvePublicAddress ?? resolvePublicAddress)(config.publicHost, lifetime);
      lifetime.throwIfAborted(); input.signal.throwIfAborted(); input.assertCurrent();
      if (!this.options.isLocalDesktopRoute(input.identity)) throw new Error("The local Main authority changed.");
      const mapping = await (this.options.start ?? startDatagramMapping)(config, { requestId, localTarget: { address: target.address, port: target.port, ownerId: `${input.leaseId}:${input.attemptId}` }, signal: lifetime, startupTimeoutMs: 15_000,
        onResource: resource => { const identity = resource.processId === undefined ? undefined : captureLinkspanProcessIdentity(resource.processId); record = { ...record, resource,
          ...(identity === undefined ? {} : { resourceProcessIdentity: identity }) }; attempt.record = record; this.#save(record); } });
      attempt.mapping = mapping;
      const closed = (): void => { lifetime.removeEventListener("abort", stop); attempt.retired = true; this.#retired(record); };
      void mapping.closed.then(closed).catch(() => { this.#blocked = true; this.#save({ ...record, state: "outcome_unknown" }); });
      // Free SDK tunnels may allocate their public address at startup. Resolve
      // only that confirmed mapping, while the original capture still owns it.
      attempt.publicAddress ??= await (this.options.resolvePublicAddress ?? resolvePublicAddress)(mapping.mapping.publicHost, lifetime);
      if (attempt.retired || lifetime.aborted || input.signal.aborted) { await mapping.close(); closed(); throw new Error("The original media attempt was retired."); }
      input.assertCurrent(); if (!this.options.isLocalDesktopRoute(input.identity)) { await mapping.close(); closed(); throw new Error("The local Main authority changed."); }
      record = { ...record, state: "active" }; attempt.record = record;
      this.options.store.completeDeferredEffectOperation(requestId, claim.operation.bodyHash, () => { this.#save(record); return { state: "active" }; });
      return mapping;
    } catch (error) {
      lifetime.removeEventListener("abort", stop);
      if (attempt.mapping) { try { await attempt.mapping.close(); this.#retired(record); } catch { this.#blocked = true; this.#save({ ...record, state: "outcome_unknown" }); } }
      else if (record.resource === undefined && !(error !== null && typeof error === "object" && "outcome" in error && error.outcome === "unknown")) this.#retired(record);
      else { this.#blocked = true; this.#save({ ...record, state: "outcome_unknown" }); }
      attempt.retired = true; throw error;
    }
  }
  #retire(attempt: Attempt): Promise<void> {
    if (attempt.cleanup) {
      const record = attempt.record, resource = record?.resource;
      // A retry queries the exact original process; it never creates another
      // publication or terminates a PID. A late confirmed exit may settle an
      // earlier cleanup timeout while the native socket is still held.
      if (attempt.cleanupUnknown && record && resource?.provider === record.provider && resource.requestId === record.requestId && mediaProcessIsRetired(record)) {
        this.#retired(record); attempt.cleanup = Promise.resolve();
        this.#blocked = this.options.store.listSettingsByKeyPrefix("service", "orchestrator", PREFIX).some(({ value }) => {
          const current = value as MediaJournal; return current.entryId === record.entryId && current.state !== "closed";
        });
      }
      return attempt.cleanup;
    }
    let reserved: ReturnType<OperationalStore["getOperation"]> | undefined;
    let journalFailure: unknown;
    if (attempt.record) try {
      const record = attempt.record, id = `${record.requestId}:retire`, body = { originalRequestId: record.requestId, entryId: record.entryId, controllerConnectionId: record.connectionId };
      reserved = this.options.store.findOperation(id) ?? this.options.store.claimDeferredEffectOperation({ id,
        kind: "connection.media.udp.retire", body }).operation;
      if (reserved.kind !== "connection.media.udp.retire" || reserved.connectionId !== undefined
        || reserved.completionMode !== "external_effect" || reserved.status === "failed" || reserved.bodyHash !== operationBodyHash(body)) throw new Error("The original UDP cleanup intent conflicts.");
    } catch (error) { journalFailure = error; this.#blocked = true; }
    attempt.cleanupUnknown = false;
    const cleanup = Promise.resolve().then(async () => {
      let mapping = attempt.mapping;
      if (!mapping) try { mapping = await attempt.pending; } catch {
        const record = attempt.record;
        if (!record || this.options.store.findSetting<MediaJournal>("service", "orchestrator", PREFIX + record.requestId)?.value.state === "closed") return;
        attempt.cleanupUnknown = true; this.#blocked = true;
        throw new Error("UDP media startup cleanup is unconfirmed; the original operation is retained.");
      }
      if (!mapping) return;
      const record = attempt.record!;
      try { await mapping.close();
        if (journalFailure) throw journalFailure;
        this.#retired(record);
        if (reserved && reserved.status !== "completed") this.options.store.completeDeferredEffectOperation(reserved.id, reserved.bodyHash, () => ({ state: "closed" })); }
      catch { attempt.cleanupUnknown = true; this.#blocked = true; if (attempt.record) this.#save({ ...attempt.record, state: "outcome_unknown" }); throw new Error("UDP media cleanup is unconfirmed; the original operation is retained."); }
    });
    attempt.cleanup = cleanup;
    void cleanup.catch(() => {});
    attempt.retired = true; attempt.abort.abort();
    return cleanup;
  }
  #save(record: MediaJournal): void { this.options.store.setSetting("service", "orchestrator", PREFIX + record.requestId, record); }
  #retired(record: MediaJournal): void {
    const operation = this.options.store.getOperation(record.requestId);
    if (operation.status !== "completed") this.options.store.completeDeferredEffectOperation(record.requestId, operation.bodyHash, () => { this.#save({ ...record, state: "closed" }); return { state: "closed" }; });
    else this.#save({ ...record, state: "closed" });
    const cleanup = this.options.store.findOperation(`${record.requestId}:retire`);
    if (cleanup && cleanup.kind === "connection.media.udp.retire" && cleanup.connectionId === undefined
      && cleanup.completionMode === "external_effect" && cleanup.status !== "failed"
      && cleanup.bodyHash === operationBodyHash({ originalRequestId: record.requestId, entryId: record.entryId, controllerConnectionId: record.connectionId }) && cleanup.status !== "completed") this.options.store.completeDeferredEffectOperation(cleanup.id, cleanup.bodyHash, () => ({ state: "closed" }));
  }
  #unavailable(input: MediaUdpInput, reason: "local_host_required" | "candidate_unprovable" | "provider_unavailable" | "mapping_busy"): void {
    const key = `${input.leaseId}:${input.attemptId}:${reason}`; if (this.#reported.has(key) || this.#reported.size >= 256) return; this.#reported.add(key);
    this.options.store.appendDiagnostic({ severity: "info", component: "connection", code: "REMOTE_DESKTOP_UDP_NOT_APPLIED",
      message: "Public UDP mapping was not applied; the existing ICE/TURN path remains available.", details: { reason } });
  }
}

function journalBody(record: MediaJournal, serverId: string) { return { entryId: record.entryId, provider: record.provider, serverId,
  leaseId: record.leaseId, attemptId: record.attemptId, controllerConnectionId: record.connectionId, hostConnectionId: record.hostConnectionId, targetDeviceId: record.targetDeviceId, routeGeneration: record.routeGeneration }; }
function mediaProcessIsRetired(record: MediaJournal): boolean {
  const helperProcessId = record.resource?.processId;
  // Native SDK mappings are owned by the service process. A durable PID is
  // only queried together with its birth proof; recovery never kills it.
  return helperProcessId === undefined
    ? record.provider === "pinggy" && linkspanProcessIsRetired(record.ownerProcessId, record.ownerProcessIdentity)
    : linkspanProcessIsRetired(helperProcessId, record.resourceProcessIdentity);
}
function locallyOwned(address: string): boolean { return isIP(address) !== 0 && (address === "127.0.0.1" || address === "::1" || Object.values(networkInterfaces()).flat().some(value => value?.address === address)); }
function parseHostCandidate(value: string): HostCandidate | undefined {
  if (value.length > 2048 || /[\r\n\0]/u.test(value)) return;
  const parts = value.trim().split(/ +/u);
  if (!/^candidate:[A-Za-z0-9+/]{1,64}$/u.test(parts[0] ?? "") || parts[1] !== "1" || parts[2]?.toLowerCase() !== "udp"
    || parts[6] !== "typ" || parts[7] !== "host" || !locallyOwned(parts[4] ?? "")) return;
  const priority = Number(parts[3]), port = Number(parts[5]);
  if (!/^[0-9]+$/u.test(parts[3] ?? "") || !/^[0-9]+$/u.test(parts[5] ?? "") || !Number.isInteger(priority) || priority < 1 || priority > 0xffffffff || !Number.isInteger(port) || port < 1 || port > 65535 || (parts.length - 8) % 2 !== 0) return;
  const extras = new Map<string, string>(); for (let i = 8; i < parts.length; i += 2) { if (extras.has(parts[i]!)) return; extras.set(parts[i]!, parts[i + 1]!); }
  const ufrag = extras.get("ufrag"); if (ufrag !== undefined && !/^[A-Za-z0-9+/]{4,256}$/u.test(ufrag)) return;
  return { address: parts[4]!, port, priority, ...(ufrag === undefined ? {} : { ufrag }) };
}
function parseSections(lines: readonly string[]): Map<number, Section> {
  let index = -1; let globalUfrag = ""; let globalPasswordDigest = ""; let globalFingerprint = ""; let current: { index: number; mid?: string; ufrag: string; passwordDigest: string; fingerprints: string } | undefined;
  const sections = new Map<number, Section>();
  const save = (): void => { if (current && /^[A-Za-z0-9+/]{4,256}$/u.test(current.ufrag) && current.passwordDigest !== "" && current.fingerprints !== "") sections.set(current.index, current); };
  for (const line of lines) {
    if (line.startsWith("m=")) { save(); current = { index: ++index, ufrag: globalUfrag, passwordDigest: globalPasswordDigest, fingerprints: globalFingerprint }; }
    else if (line.startsWith("a=ice-ufrag:")) { const value = line.slice(12); if (current) current.ufrag = value; else globalUfrag = value; }
    else if (line.startsWith("a=ice-pwd:")) { const value = line.slice(10); const hashed = /^[A-Za-z0-9+/]{22,256}$/u.test(value) ? digest(value) : ""; if (current) current.passwordDigest = hashed; else globalPasswordDigest = hashed; }
    else if (/^a=fingerprint:sha-(?:256|384|512) [0-9a-f:]+$/iu.test(line)) { if (current) current.fingerprints += line; else globalFingerprint += line; }
    else if (line.startsWith("a=mid:") && current) current.mid = line.slice(6);
  }
  save(); return sections;
}
async function resolvePublicAddress(host: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted(); if (isIP(host)) { if (!publicIp(host)) throw new Error("A public UDP address is required."); return host; }
  const resolver = new Resolver({ timeout: 2000, tries: 1 }); const stop = (): void => resolver.cancel();
  const timeout = setTimeout(stop, 3000); signal.addEventListener("abort", stop, { once: true });
  try { const results = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]); signal.throwIfAborted();
    const address = results.flatMap(result => result.status === "fulfilled" ? result.value.slice(0, 8) : []).find(publicIp);
    if (!address) throw new Error("The selected UDP service has no public IP address."); return address;
  } finally { clearTimeout(timeout); signal.removeEventListener("abort", stop); }
}
function publicIp(address: string): boolean {
  if (isIP(address) === 4) { const [a = 0, b = 0, c = 0] = address.split(".").map(Number); return a > 0 && a < 224 && a !== 10 && a !== 127 && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2))) && !(a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) && !(a === 203 && b === 0 && c === 113); }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/iu.test(address) && !/^2001:db8:/iu.test(address);
}
