import { randomUUID } from "node:crypto";
import { isRemoteDesktopInput, type RemoteDesktopInput } from "@joko/device-peer";
import { HumanDesktopInput } from "./input-ownership.js";

interface HostIdentity { readonly instanceId: string; readonly deviceId: string; readonly token: object }
interface InputOwner { readonly host: HostIdentity; readonly identity: string; readonly human: HumanDesktopInput; readonly batches: Map<string, () => void>; timer?: ReturnType<typeof setTimeout> }
const EXIT_BOUND_MS = 17_000; // Remote Desktop lease (12s) plus native release watchdog (5s).

/** Coordinates actual acknowledged helper batches across Main/Orchestrator.
 * Text and coordinates are deliberately absent from this private protocol. */
export class NativeHandoffInputOwnership {
  readonly #owners = new Map<string, InputOwner>();
  async begin(host: HostIdentity, ownerId: string, identity: string, bytes: Uint8Array, assertCurrent: () => void, signal: AbortSignal): Promise<string> {
    assertId(ownerId); assertCurrent(); signal.throwIfAborted();
    const events = parseGestures(bytes);
    let owner = this.#owners.get(ownerId);
    if (owner && (owner.host.token !== host.token || owner.identity !== identity || owner.timer)) throw unavailable();
    if (!owner) { if (this.#owners.size >= 8) throw unavailable(); owner = { host, identity, human: new HumanDesktopInput(), batches: new Map() }; this.#owners.set(ownerId, owner); }
    if (owner.batches.size >= 64) throw unavailable();
    const admission = owner.human.begin(events), batch = randomUUID(); owner.batches.set(batch, admission.complete);
    let abort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(unavailable()); signal.addEventListener("abort", abort, { once: true }); });
    try { await Promise.race([admission.ready, aborted]); signal.throwIfAborted(); assertCurrent(); if (this.#owners.get(ownerId) !== owner || owner.timer) throw unavailable(); return batch; }
    catch (error) { this.#retire(ownerId, owner); throw error; }
    finally { signal.removeEventListener("abort", abort); }
  }
  finish(host: Omit<HostIdentity, "token">, ownerId: string, identity: string, batchId: string, closed: boolean): void {
    assertId(ownerId); const owner = this.#owners.get(ownerId); if (!owner) return;
    if (owner.host.deviceId !== host.deviceId || owner.host.instanceId !== host.instanceId || owner.identity !== identity) throw unavailable();
    if (closed) { this.#release(ownerId, owner); return; }
    const complete = owner.batches.get(batchId); if (!complete) return;
    owner.batches.delete(batchId); complete();
  }
  retireHost(token: object): void { for (const [id, owner] of this.#owners) if (owner.host.token === token) this.#retire(id, owner); }
  close(): void { for (const [id, owner] of this.#owners) this.#release(id, owner); }
  #retire(id: string, owner: InputOwner): void {
    if (owner.timer) return;
    owner.human.holdUntilExit(); owner.timer = setTimeout(() => this.#release(id, owner), EXIT_BOUND_MS); owner.timer.unref();
  }
  #release(id: string, owner: InputOwner): void {
    if (this.#owners.get(id) !== owner) return;
    this.#owners.delete(id); if (owner.timer) clearTimeout(owner.timer);
    for (const complete of owner.batches.values()) complete(); owner.batches.clear(); owner.human.release();
  }
}
export function nativeHandoffWindowIdentity(value: { requestId: string; controllerDeviceId: string; windowId: number; processId: number }): string {
  return JSON.stringify([value.requestId, value.controllerDeviceId, value.windowId, value.processId]);
}
function parseGestures(bytes: Uint8Array): RemoteDesktopInput[] {
  if (bytes.byteLength > 8_192) throw unavailable();
  const raw: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64) throw unavailable();
  return raw.map(value => {
    if (!isRemoteDesktopInput(value) || !["release", "key", "button", "text"].includes(value.kind)
      || value.kind === "text" && value.text !== "" || value.kind === "button" && (value.x !== 0 || value.y !== 0)) throw unavailable();
    return value;
  });
}
function assertId(value: string): void { if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)) throw unavailable(); }
function unavailable(): Error { return new Error("Native input ownership is unavailable."); }
