import {
  isDesktopSessionWindowOwner,
  type DesktopSessionWindowOwner
} from "./channels.js";

export interface SessionWindowRecord<W> {
  readonly window: W;
  readonly owner: DesktopSessionWindowOwner;
  readonly draftSlot: number;
}

/** Native instances own their lifetime and draft slot, including repeated windows of one task. */
export class SessionWindowRegistry<W extends { readonly id: number; readonly webContents: C; isDestroyed(): boolean }, C extends object> {
  readonly #windows = new Map<number, SessionWindowRecord<W> & { readonly contents: C; readonly id: number }>();
  readonly #contents = new Map<C, SessionWindowRecord<W> & { readonly contents: C; readonly id: number }>();
  readonly #instances = new WeakMap<W, SessionWindowRecord<W> & { readonly contents: C; readonly id: number }>();

  register(window: W, owner: DesktopSessionWindowOwner): SessionWindowRecord<W> {
    if (!isDesktopSessionWindowOwner(owner)) throw new TypeError("Task window owner is invalid.");
    if (!Number.isSafeInteger(window.id) || window.id < 1 || window.isDestroyed()) throw new TypeError("Task window instance is invalid.");
    const existing = this.#windows.get(window.id);
    if (existing?.window === window) {
      if (existing.owner.profileId !== owner.profileId || existing.owner.sessionId !== owner.sessionId) throw new Error("Task window owner cannot change.");
      return existing;
    }
    const contents = window.webContents;
    const contentsOwner = this.#contents.get(contents);
    if (contentsOwner !== undefined && contentsOwner !== existing) throw new Error("Task window contents already belong to another instance.");
    if (existing !== undefined) this.retire(existing.window);
    const occupied = new Set([...this.#windows.values()].filter(record => record.owner.profileId === owner.profileId
      && record.owner.sessionId === owner.sessionId).map(record => record.draftSlot));
    let draftSlot = 0;
    while (occupied.has(draftSlot)) draftSlot++;
    const record = Object.freeze({ window, owner: Object.freeze({ profileId: owner.profileId, sessionId: owner.sessionId }), draftSlot, contents, id: window.id });
    this.#windows.set(window.id, record); this.#contents.set(contents, record); this.#instances.set(window, record);
    return record;
  }

  get(id: number): W | undefined { return this.#windows.get(id)?.window; }
  *values(): IterableIterator<W> { for (const record of this.#windows.values()) yield record.window; }
  has(id: number): boolean { return this.#windows.has(id); }
  ownerForContents(contents: C): DesktopSessionWindowOwner | undefined { return this.#contents.get(contents)?.owner; }
  contextForContents(contents: C): (DesktopSessionWindowOwner & { readonly draftSlot: number }) | undefined {
    const record = this.#contents.get(contents);
    return record === undefined ? undefined : Object.freeze({ ...record.owner, draftSlot: record.draftSlot });
  }
  hasContents(contents: C): boolean { return this.#contents.has(contents); }
  retire(window: W): void {
    const record = this.#instances.get(window);
    if (record === undefined || this.#windows.get(record.id) !== record) return;
    this.#instances.delete(window); this.#windows.delete(record.id);
    if (this.#contents.get(record.contents) === record) this.#contents.delete(record.contents);
  }
  clear(): void { for (const record of this.#windows.values()) this.#instances.delete(record.window); this.#windows.clear(); this.#contents.clear(); }
}

/** A child Task window may only create another window on its bound profile. */
export function sessionWindowOwnerMayRequest(
  sender: DesktopSessionWindowOwner | undefined,
  requested: DesktopSessionWindowOwner
): boolean {
  return isDesktopSessionWindowOwner(requested)
    && (sender === undefined || (isDesktopSessionWindowOwner(sender) && sender.profileId === requested.profileId));
}
