import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ConnectionRecord } from "@joko/store";
import type { DevelopmentNativeVersionAuthority, DevelopmentVersionTarget } from "@joko/personal-development";
import { PersonalDevelopmentError } from "@joko/personal-development";
import type { ConnectionManager } from "./connection-manager.js";

export interface DesktopDevelopmentRuntimeValue {
  readonly id: "original" | "personal"; readonly generation: string;
  readonly runtimeDirectory: string; readonly executable: string; readonly runtimeDigest: string;
  readonly compatibilityIdentity: string; readonly version: string; readonly development: boolean;
  readonly appPath?: string;
}
export interface DesktopDevelopmentHostValue {
  readonly hostInstanceId: string; readonly profileIdentity: string;
  readonly original: DesktopDevelopmentRuntimeValue; readonly current: DesktopDevelopmentRuntimeValue;
  readonly busy: boolean; readonly launchTicketId: string;
}
export interface DesktopDevelopmentCommandValue {
  readonly commandId: string; readonly kind: "reveal" | "handoff" | "testStart" | "testStop" | "testFind" | "openDirectory";
  readonly target?: DesktopDevelopmentRuntimeValue; readonly path?: string; readonly ticketId?: string;
  readonly taskId?: string; readonly sessionId?: string; readonly completionId?: string; readonly receipt?: string;
  readonly directory?: "source" | "tools";
}
export interface DesktopDevelopmentResultValue {
  readonly status: "revealed" | "opened" | "prepared" | "running" | "retired" | "unknown" | "failed" | "not_found";
  readonly receipt: string; readonly observedCurrent?: DesktopDevelopmentRuntimeValue;
}
interface HandoffTicket {
  readonly id: string; readonly operationId: string; readonly deviceId: string; readonly connectionId: string;
  readonly sourceHostInstanceId: string; readonly profileIdentity: string;
  readonly previous: DesktopDevelopmentRuntimeValue; readonly target: DesktopDevelopmentRuntimeValue;
  readonly phase: "queued" | "armed" | "claimed" | "prepared" | "ready" | "failed" | "unknown";
}
interface HostRegistration {
  readonly connection: ConnectionRecord; readonly authorization: string; readonly generation: number;
  info: DesktopDevelopmentHostValue; touchedAt: number;
}
type Reconciler = (input: { readonly ticketId: string; readonly outcome: "ready" | "failed" | "unknown";
  readonly current: { readonly id: "original" | "personal"; readonly generation?: string }; readonly operationId: string }) => Promise<unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DIGEST = /^[0-9a-f]{64}$/u;
const current = (value: DesktopDevelopmentRuntimeValue) => ({ id: value.id, ...(value.generation ? { generation: value.generation } : {}) });
function sameRuntime(left: DesktopDevelopmentRuntimeValue, right: DesktopDevelopmentRuntimeValue): boolean {
  return left.id === right.id && left.generation === right.generation && left.runtimeDigest === right.runtimeDigest
    && left.executable === right.executable && left.runtimeDirectory === right.runtimeDirectory;
}
export function validateDesktopDevelopmentRuntime(value: DesktopDevelopmentRuntimeValue): DesktopDevelopmentRuntimeValue {
  if (!value || !["original", "personal"].includes(value.id) || value.generation.length > 256
    || !isAbsolute(value.runtimeDirectory) || !isAbsolute(value.executable)
    || value.runtimeDirectory.length > 16_384 || value.executable.length > 16_384
    || !DIGEST.test(value.runtimeDigest) || !DIGEST.test(value.compatibilityIdentity)
    || value.version.length > 256 || typeof value.development !== "boolean"
    || (value.id === "personal" && !UUID.test(value.generation))) throw new Error("Invalid native development runtime proof.");
  return { ...value };
}

/** A local Desktop mailbox. Native paths and host credentials never enter product Events or Operations. */
export class PersonalDevelopmentNativeBroker {
  #host: HostRegistration | undefined;
  #generation = 0;
  #tickets: Record<string, HandoffTicket> = {};
  #write: Promise<unknown> = Promise.resolve();
  readonly #waiters = new Set<() => void>();
  readonly #listeners = new Set<() => void>();
  readonly #commands = new Map<string, { readonly command: DesktopDevelopmentCommandValue; readonly generation: number;
    claimed: boolean; readonly finish: (result: DesktopDevelopmentResultValue) => void }>();
  #reconciler: Reconciler | undefined;
  #closed = false;
  constructor(readonly options: { readonly directory: string; readonly connections: ConnectionManager }) {}

  async initialize(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    let raw: string | undefined;
    try { raw = await readFile(join(this.options.directory, "state.json"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (raw !== undefined) {
      const value = JSON.parse(raw) as { format: number; generation: number; tickets: Record<string, HandoffTicket> };
      if (value.format !== 1 || !Number.isSafeInteger(value.generation) || !value.tickets || typeof value.tickets !== "object") throw new Error("Native development state is invalid.");
      this.#generation = value.generation;
      for (const [id, ticket] of Object.entries(value.tickets)) {
        if (!UUID.test(id) || ticket.id !== id || !ticket.operationId || !ticket.deviceId || !ticket.connectionId || !DIGEST.test(ticket.profileIdentity)
          || !["queued", "armed", "claimed", "prepared", "ready", "failed", "unknown"].includes(ticket.phase)) throw new Error("Native development ticket is invalid.");
        validateDesktopDevelopmentRuntime(ticket.target); validateDesktopDevelopmentRuntime(ticket.previous);
        this.#tickets[id] = ["claimed", "prepared"].includes(ticket.phase) ? { ...ticket, phase: "unknown" } : ticket;
      }
    }
    this.#generation += 1; await this.#save();
  }
  setVersionReconciler(reconcile: Reconciler): void { this.#reconciler = reconcile; }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); listener(); return () => { this.#listeners.delete(listener); }; }
  metadata(): { readonly original: { readonly version: string; readonly development: boolean };
    readonly current: { readonly id: "original" | "personal"; readonly generation?: string } } | undefined {
    try { const host = this.#requireHost(); return { original: { version: host.info.original.version, development: host.info.original.development }, current: current(host.info.current) }; }
    catch { return undefined; }
  }
  availability(): { readonly available: boolean; readonly reason: string } {
    try { this.#requireHost(); return { available: true, reason: "" }; }
    catch { return { available: false, reason: "A current local Desktop host is required." }; }
  }
  assertLocalDesktopConnection(connection: ConnectionRecord): void {
    const host = this.#requireHost(); this.options.connections.fence(connection);
    if (connection.id !== host.connection.id || connection.deviceId !== host.connection.deviceId || connection.authKeyDigest !== host.connection.authKeyDigest) {
      throw new Error("Personal development requires the exact managed Desktop connection.");
    }
  }
  #requireHost(): HostRegistration {
    const host = this.#host;
    if (this.#closed || host === undefined || Date.now() - host.touchedAt > 35_000) throw new Error("Native development host is unavailable.");
    this.options.connections.authenticateDesktopHost(host.connection, host.authorization);
    return host;
  }
  #assertHost(connection: ConnectionRecord, authorization: string, instanceId: string, generation: number): HostRegistration {
    this.options.connections.authenticateDesktopHost(connection, authorization);
    const host = this.#requireHost();
    if (host.connection.id !== connection.id || host.info.hostInstanceId !== instanceId || host.generation !== generation) throw new Error("Native development host has retired.");
    host.touchedAt = Date.now(); return host;
  }
  async register(connection: ConnectionRecord, authorization: string, info: DesktopDevelopmentHostValue): Promise<number> {
    this.options.connections.authenticateDesktopHost(connection, authorization);
    if (this.#closed || !UUID.test(info.hostInstanceId) || !DIGEST.test(info.profileIdentity) || typeof info.busy !== "boolean"
      || (info.launchTicketId !== "" && !UUID.test(info.launchTicketId))) throw new Error("Native development host proof is invalid.");
    validateDesktopDevelopmentRuntime(info.original); validateDesktopDevelopmentRuntime(info.current);
    const launchTicket = info.launchTicketId ? this.#tickets[info.launchTicketId] : undefined;
    const launchOutcome = launchTicket && (sameRuntime(launchTicket.target, info.current) ? "ready" : sameRuntime(launchTicket.previous, info.current) ? "failed" : undefined);
    if (info.launchTicketId && (!launchTicket || launchTicket.deviceId !== connection.deviceId || launchTicket.profileIdentity !== info.profileIdentity
      || !["claimed", "prepared", "unknown", "ready", "failed"].includes(launchTicket.phase))) throw new Error("Native launch proof does not match its handoff ticket.");
    if (info.launchTicketId && (launchOutcome === undefined || launchTicket!.phase === "ready" && launchOutcome !== "ready"
      || launchTicket!.phase === "failed" && launchOutcome !== "failed")) throw new Error("Native runtime does not match its launch receipt.");
    const previous = this.#host;
    const same = previous !== undefined && previous.connection.id === connection.id && previous.info.hostInstanceId === info.hostInstanceId
      && previous.info.profileIdentity === info.profileIdentity;
    if (!same) {
      this.#retireHost(); this.#generation += 1; await this.#save();
      this.options.connections.authenticateDesktopHost(connection, authorization);
    }
    if (launchTicket && launchOutcome && launchTicket.phase !== launchOutcome) {
        const ticket = launchTicket, outcome = launchOutcome;
        if (!this.#reconciler) throw new Error("Version reconciliation is not available.");
        await this.#reconciler({ ticketId: ticket.id, outcome, current: current(info.current), operationId: outcome === "ready" ? ticket.id : `${ticket.id}-failed` });
        this.options.connections.authenticateDesktopHost(connection, authorization);
        this.#tickets[ticket.id] = { ...ticket, phase: outcome }; await this.#save();
    }
    this.options.connections.authenticateDesktopHost(connection, authorization);
    this.#host = { connection, authorization, generation: same ? previous!.generation : this.#generation, info: structuredClone(info), touchedAt: Date.now() };
    this.#wake();
    if (!same || JSON.stringify(previous!.info) !== JSON.stringify(info)) this.#notify();
    return this.#host.generation;
  }
  async poll(connection: ConnectionRecord, authorization: string, instanceId: string, generation: number, signal: AbortSignal): Promise<DesktopDevelopmentCommandValue | undefined> {
    const host = this.#assertHost(connection, authorization, instanceId, generation);
    const take = async (): Promise<DesktopDevelopmentCommandValue | undefined> => {
      this.#assertHost(connection, authorization, instanceId, generation); signal.throwIfAborted();
      const ticket = Object.values(this.#tickets).find(value => value.phase === "armed" && value.connectionId === connection.id
        && value.sourceHostInstanceId === instanceId && value.profileIdentity === host.info.profileIdentity);
      if (ticket) {
        this.#tickets[ticket.id] = { ...ticket, phase: "claimed" }; await this.#save();
        this.#assertHost(connection, authorization, instanceId, generation);
        return { commandId: ticket.id, kind: "handoff", ticketId: ticket.id, target: ticket.target };
      }
      const queued = [...this.#commands.values()].find(value => value.generation === generation && !value.claimed);
      if (queued) { queued.claimed = true; return queued.command; }
      return undefined;
    };
    const immediate = await take(); if (immediate) return immediate;
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); this.#waiters.delete(done); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, 15_000); timer.unref(); this.#waiters.add(done); signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
    return take();
  }
  async complete(connection: ConnectionRecord, authorization: string, instanceId: string, generation: number,
    commandId: string, result: DesktopDevelopmentResultValue): Promise<{ accepted: boolean; executeHandoff: boolean }> {
    const host = this.#assertHost(connection, authorization, instanceId, generation);
    if (result.receipt.length > 512 || !["revealed", "opened", "prepared", "running", "retired", "unknown", "failed", "not_found"].includes(result.status)) throw new Error("Invalid native development result.");
    const ticket = this.#tickets[commandId];
    if (ticket) {
      if (ticket.sourceHostInstanceId !== instanceId || ticket.connectionId !== connection.id || ticket.profileIdentity !== host.info.profileIdentity) throw new Error("Handoff receipt belongs to a different native host.");
      if (result.status === "prepared" && ["claimed", "prepared"].includes(ticket.phase)) {
        this.#tickets[ticket.id] = { ...ticket, phase: "prepared" }; await this.#save();
        this.#assertHost(connection, authorization, instanceId, generation);
        return { accepted: true, executeHandoff: true };
      }
      if (result.status === "failed" && result.observedCurrent && sameRuntime(ticket.previous, result.observedCurrent)) {
        if (!this.#reconciler) throw new Error("Version reconciliation is not available.");
        await this.#reconciler({ ticketId: ticket.id, outcome: "failed", current: current(result.observedCurrent), operationId: `${ticket.id}-failed` });
        this.#tickets[ticket.id] = { ...ticket, phase: "failed" }; await this.#save();
        return { accepted: true, executeHandoff: false };
      }
      this.#tickets[ticket.id] = { ...ticket, phase: "unknown" }; await this.#save();
      return { accepted: true, executeHandoff: false };
    }
    const command = this.#commands.get(commandId);
    if (!command || command.generation !== generation || !command.claimed) return { accepted: false, executeHandoff: false };
    this.#commands.delete(commandId); command.finish(result); return { accepted: true, executeHandoff: false };
  }
  readonly nativeVersions: DevelopmentNativeVersionAuthority = {
    original: async () => { const value = this.#requireHost().info.original; return { runtimeDirectory: value.runtimeDirectory,
      executable: value.executable, compatibilityIdentity: value.compatibilityIdentity, version: value.version, development: value.development }; },
    current: async () => current(this.#requireHost().info.current),
    busy: async () => this.#requireHost().info.busy || this.#commands.size > 0 || Object.values(this.#tickets).some(ticket => !["ready", "failed"].includes(ticket.phase)),
    handoff: async (target, signal) => {
      signal.throwIfAborted(); const host = this.#requireHost();
      const previous = Object.values(this.#tickets).find(ticket => ticket.operationId === target.operationId);
      if (previous) {
        if (previous.target.id !== target.id || previous.target.generation !== (target.generation ?? "") || previous.target.runtimeDigest !== target.runtimeDigest) throw new Error("Version handoff identity cannot be reused.");
        return { status: "queued", ticketId: previous.id };
      }
      const ticketId = randomUUID(); const nativeTarget = this.#target(target, host);
      this.#tickets[ticketId] = { id: ticketId, operationId: target.operationId, connectionId: host.connection.id, deviceId: host.connection.deviceId,
        sourceHostInstanceId: host.info.hostInstanceId, profileIdentity: host.info.profileIdentity, previous: host.info.current, target: nativeTarget, phase: "queued" };
      await this.#save(); this.#assertHost(host.connection, host.authorization, host.info.hostInstanceId, host.generation);
      return { status: "queued", ticketId };
    },
    activateHandoff: async ticketId => { const ticket = this.#tickets[ticketId]; if (!ticket) throw new Error("Handoff ticket is unavailable.");
      const host = this.#requireHost(); if (ticket.connectionId !== host.connection.id || ticket.sourceHostInstanceId !== host.info.hostInstanceId) throw new Error("Handoff host has retired.");
      if (ticket.phase === "queued") { this.#tickets[ticketId] = { ...ticket, phase: "armed" }; await this.#save(); this.#wake(); } },
    reveal: async path => { const result = await this.#call({ kind: "reveal", path }); if (result.status !== "revealed") throw new Error("Build reveal is unavailable."); },
    startTest: async (input, signal) => { const host = this.#requireHost(); const result = await this.#call({ kind: "testStart", taskId: input.taskId, sessionId: input.sessionId,
      completionId: input.completionId, target: { ...host.info.current, id: "personal", generation: input.completionId,
        runtimeDirectory: input.runtimeDirectory, executable: input.executable, runtimeDigest: input.runtimeDigest, development: false } }, signal);
      if (result.status !== "running" || !result.receipt) throw new PersonalDevelopmentError("PROCESS_UNKNOWN"); return result.receipt; },
    stopTest: async (receipt, signal) => (await this.#call({ kind: "testStop", receipt }, signal)).status === "retired" ? "retired" : "unknown",
    findTest: async (taskId, completionId) => { const result = await this.#call({ kind: "testFind", taskId, completionId });
      return { status: result.status === "running" ? "running" : result.status === "retired" || result.status === "not_found" ? "retired" : "unknown", ...(result.receipt ? { receipt: result.receipt } : {}) }; }
  };
  async openDirectory(directory: "source" | "tools", signal: AbortSignal): Promise<void> {
    if (directory !== "source" && directory !== "tools") throw new PersonalDevelopmentError("INVALID_ARGUMENT");
    const result = await this.#call({ kind: "openDirectory", directory }, signal);
    if (result.status !== "opened") throw new PersonalDevelopmentError("COMMAND_FAILED");
  }
  #target(value: DevelopmentVersionTarget, host: HostRegistration): DesktopDevelopmentRuntimeValue {
    return validateDesktopDevelopmentRuntime({ ...host.info.original, ...value, generation: value.generation ?? "", development: value.id === "original" && host.info.original.development });
  }
  #call(input: Omit<DesktopDevelopmentCommandValue, "commandId">, signal?: AbortSignal): Promise<DesktopDevelopmentResultValue> {
    const host = this.#requireHost(), commandId = randomUUID(); signal?.throwIfAborted();
    return new Promise(resolve => {
      const finish = (result: DesktopDevelopmentResultValue) => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); this.#commands.delete(commandId); resolve(result); };
      const abort = () => finish({ status: "unknown", receipt: "" });
      const timeout = setTimeout(abort, 30_000); timeout.unref(); signal?.addEventListener("abort", abort, { once: true });
      this.#commands.set(commandId, { command: { commandId, ...input }, generation: host.generation, claimed: false, finish }); this.#wake();
    });
  }
  #save(): Promise<void> {
    const contents = JSON.stringify({ format: 1, generation: this.#generation, tickets: this.#tickets });
    const next = this.#write.then(async () => { const path = join(this.options.directory, "state.json"), temporary = `${path}.tmp-${randomUUID()}`;
      try { await writeFile(temporary, contents, { flag: "wx", mode: 0o600 }); await rename(temporary, path); } finally { await rm(temporary, { force: true }); } });
    this.#write = next.catch(() => undefined); return next;
  }
  #wake(): void { for (const wake of this.#waiters) wake(); }
  #notify(): void { for (const listener of this.#listeners) listener(); }
  #retireHost(): void { for (const command of this.#commands.values()) command.finish({ status: "unknown", receipt: "" }); this.#host = undefined; this.#wake(); this.#notify(); }
  async close(): Promise<void> { this.#closed = true; this.#retireHost(); await this.#write; }
}
