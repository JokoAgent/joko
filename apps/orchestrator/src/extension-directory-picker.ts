import { randomUUID } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionCardRuntime } from "./extension-cards/runtime.js";
import type { ExtensionMainViewSurface } from "./extension-main-view-manager.js";

const TTL = 120_000, PAGE = 100, MAX_ENTRIES = 10_000, MAX_SCANNED = 100_000;
export interface ExtensionDirectoryEntry {
  readonly entryId: string; readonly name: string; readonly displayPath: string; readonly parentEntryId?: string;
}
export interface ExtensionDirectoryPage {
  readonly picker: { readonly pickerId: string; readonly extensionId: string; readonly expiresAt: number };
  readonly directory?: ExtensionDirectoryEntry; readonly entries: readonly ExtensionDirectoryEntry[]; readonly nextPageToken: string;
}
export interface PickedExtensionDirectory {
  readonly token: string; readonly fileCount: number; readonly totalBytes: number; readonly relativePaths: readonly string[]; readonly expiresAt: number;
}
interface Entry extends ExtensionDirectoryEntry { readonly directoryPath: string; readonly identity: string }
interface Listing { readonly directory?: Entry; readonly entries: readonly Entry[]; readonly fingerprint: string }
interface Picker {
  readonly id: string; readonly connectionId: string; readonly surface: ExtensionMainViewSurface;
  readonly authorityKey: string; readonly expiresAt: number; readonly assertOwner: () => void;
  readonly assertRuntime: () => void; readonly entries: Map<string, Entry>; readonly paths: Map<string, Entry>;
  readonly pages: Map<string, { readonly listing: Listing; readonly offset: number }>;
  busy: boolean; claimed: boolean;
}
const samePath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const identity = (info: Awaited<ReturnType<typeof lstat>>) => `${info.dev}:${info.ino}:${info.birthtimeMs}`;
const fingerprint = (info: Awaited<ReturnType<typeof lstat>>) => `${identity(info)}:${info.mtimeMs}:${info.ctimeMs}`;
const publicEntry = ({ entryId, name, displayPath, parentEntryId }: Entry): ExtensionDirectoryEntry => ({ entryId, name, displayPath,
  ...(parentEntryId ? { parentEntryId } : {}) });

/** Browsing belongs only to the authenticated native host. Author HTML receives
 * the original file-deposit receipt after an explicit native confirmation. */
export class ExtensionDirectoryPicker {
  #active?: Picker;
  readonly #lastAttempt = new Map<string, number>();
  constructor(private readonly options: {
    readonly runtime: Pick<ExtensionCardRuntime, "captureDirectorySelection" | "preparePickedDirectory">;
    readonly roots?: () => readonly string[]; readonly now?: () => number;
  }) {}
  #now() { return this.options.now?.() ?? Date.now(); }
  #assert(picker: Picker) {
    if (this.#active !== picker || picker.expiresAt <= this.#now()) throw new Error("Directory selection expired or closed.");
    picker.assertOwner(); picker.assertRuntime();
  }
  async #io<T>(picker: Picker, promise: Promise<T>): Promise<T> {
    this.#assert(picker); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Directory selection timed out.")), Math.max(1, Math.min(10_000, picker.expiresAt - this.#now())));
      })]); this.#assert(picker); return result;
    } finally { if (timer) clearTimeout(timer); }
  }
  async #entry(picker: Picker, candidate: string, parentEntryId?: string): Promise<Entry> {
    if (!candidate || candidate.length > 4096 || candidate.includes("\0") || !path.isAbsolute(candidate)) throw new Error("Enter an absolute directory on this Joko node.");
    const actual = await this.#io(picker, realpath(candidate));
    const info = await this.#io(picker, lstat(actual));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Select an existing directory.");
    const key = process.platform === "win32" ? actual.toLowerCase() : actual, previous = picker.paths.get(key);
    if (previous) {
      if (previous.identity !== identity(info)) throw new Error("The selected directory was replaced. Reopen the picker.");
      return previous;
    }
    if (picker.entries.size >= MAX_ENTRIES) throw new Error("Directory selection reached its entry limit. Reopen the picker.");
    const entry: Entry = { entryId: randomUUID(), name: path.basename(actual) || actual, displayPath: actual,
      directoryPath: actual, identity: identity(info), ...(parentEntryId ? { parentEntryId } : {}) };
    picker.entries.set(entry.entryId, entry); picker.paths.set(key, entry); return entry;
  }
  async #verify(picker: Picker, entry: Entry) {
    const actual = await this.#io(picker, realpath(entry.directoryPath)), info = await this.#io(picker, lstat(entry.directoryPath));
    if (!samePath(actual, entry.directoryPath) || !info.isDirectory() || info.isSymbolicLink() || identity(info) !== entry.identity) {
      throw new Error("The selected directory changed. Select it again.");
    }
    return info;
  }
  #page(picker: Picker, listing: Listing, offset: number): ExtensionDirectoryPage {
    this.#assert(picker);
    const end = offset + PAGE;
    let nextPageToken = "";
    if (end < listing.entries.length) {
      if (picker.pages.size >= 128) throw new Error("Directory paging reached its limit. Reopen the picker.");
      nextPageToken = randomUUID(); picker.pages.set(nextPageToken, { listing, offset: end });
    }
    return { picker: { pickerId: picker.id, extensionId: picker.surface.extensionId, expiresAt: picker.expiresAt },
      ...(listing.directory ? { directory: publicEntry(listing.directory) } : {}),
      entries: listing.entries.slice(offset, end).map(publicEntry), nextPageToken };
  }
  async open(surface: ExtensionMainViewSurface, connectionId: string, assertOwner: () => void): Promise<ExtensionDirectoryPage> {
    if (!surface.authority.settings) throw new Error("Open the plugin's current settings before choosing a directory.");
    assertOwner(); const captured = this.options.runtime.captureDirectorySelection(surface.extensionId), now = this.#now();
    for (const [id, at] of this.#lastAttempt) if (at + 3_000 <= now) this.#lastAttempt.delete(id);
    const last = this.#lastAttempt.get(surface.extensionId); this.#lastAttempt.set(surface.extensionId, now);
    if (last !== undefined && now - last < 3_000) throw new Error("Wait three seconds before opening another directory selection.");
    if (this.#active) {
      try { this.#assert(this.#active); } catch { this.#active = undefined; }
      if (this.#active) throw new Error("A directory selection is already open. Finish or cancel it first.");
    }
    const picker: Picker = { id: randomUUID(), connectionId, surface, authorityKey: captured.authorityKey, expiresAt: now + TTL,
      assertOwner, assertRuntime: captured.assertCurrent, entries: new Map(), paths: new Map(), pages: new Map(), busy: true, claimed: false };
    this.#active = picker;
    try {
      const roots = [...new Set([homedir(), process.cwd(), ...this.options.roots?.() ?? []].flatMap(root => [root, path.parse(root).root]))];
      const entries: Entry[] = [];
      for (const root of roots.slice(0, 128)) {
        try { entries.push(await this.#entry(picker, root)); } catch (error) { this.#assert(picker); if (root === homedir()) throw error; }
      }
      return this.#page(picker, { entries: [...new Set(entries)].sort((a, b) => a.displayPath.localeCompare(b.displayPath)), fingerprint: "roots" }, 0);
    } catch (error) { if (this.#active === picker) this.#active = undefined; throw error; }
    finally { picker.busy = false; }
  }
  #get(id: string, connectionId: string): Picker {
    const picker = this.#active;
    if (!picker || picker.id !== id || picker.connectionId !== connectionId || picker.claimed) throw new Error("This directory selection is unavailable.");
    this.#assert(picker); return picker;
  }
  async browse(id: string, connectionId: string, input: { readonly entryId?: string; readonly pageToken?: string; readonly directoryPath?: string }): Promise<ExtensionDirectoryPage> {
    const picker = this.#get(id, connectionId);
    if (picker.busy) throw new Error("Directory selection is busy.");
    picker.busy = true;
    try {
      if (input.pageToken) {
        if (input.directoryPath) throw new Error("A page cannot change its directory.");
        const cursor = picker.pages.get(input.pageToken);
        if (!cursor || cursor.listing.directory?.entryId !== input.entryId) throw new Error("This directory page expired.");
        if (cursor.listing.directory && fingerprint(await this.#verify(picker, cursor.listing.directory)) !== cursor.listing.fingerprint) throw new Error("Directory contents changed. Reload the directory.");
        return this.#page(picker, cursor.listing, cursor.offset);
      }
      if (input.directoryPath && input.entryId) throw new Error("Select one directory source.");
      let directory = input.directoryPath ? await this.#entry(picker, input.directoryPath) : picker.entries.get(input.entryId ?? "");
      if (!directory) throw new Error("Select a directory from this picker.");
      const before = await this.#verify(picker, directory), parentPath = path.dirname(directory.directoryPath);
      if (!samePath(parentPath, directory.directoryPath)) {
        const parent = await this.#entry(picker, parentPath);
        directory = { ...directory, parentEntryId: parent.entryId }; picker.entries.set(directory.entryId, directory);
      }
      const opening = opendir(directory.directoryPath);
      let handle: Awaited<typeof opening>;
      try { handle = await this.#io(picker, opening); }
      catch (error) { void opening.then(value => value.close()).catch(() => undefined); throw error; }
      const entries: Entry[] = []; let scanned = 0;
      try {
        while (true) {
          const item = await this.#io(picker, handle.read()); if (!item) break;
          if (++scanned > MAX_SCANNED) throw new Error("This directory exceeds the browsing limit. Enter a more specific directory.");
          if (!item.isDirectory() || item.isSymbolicLink()) continue;
          if (!item.name || item.name === "." || item.name === ".." || /[/\\\0]/u.test(item.name)) throw new Error("Invalid directory entry.");
          entries.push(await this.#entry(picker, path.join(directory.directoryPath, item.name), directory.entryId));
        }
      } finally { await handle.close().catch(() => undefined); }
      const after = await this.#verify(picker, directory);
      if (fingerprint(before) !== fingerprint(after)) throw new Error("Directory contents changed. Reload the directory.");
      return this.#page(picker, { directory, entries: entries.sort((a, b) => a.name.localeCompare(b.name)), fingerprint: fingerprint(after) }, 0);
    } finally { picker.busy = false; }
  }
  close(id: string, connectionId: string): boolean {
    if (!this.#active || this.#active.id !== id || this.#active.connectionId !== connectionId) return false;
    this.#active = undefined; return true;
  }
  async pick(id: string, entryId: string, extensionId: string, connectionId: string, assertCurrent: () => void): Promise<PickedExtensionDirectory> {
    const picker = this.#get(id, connectionId), entry = picker.entries.get(entryId);
    if (!entry || picker.surface.extensionId !== extensionId || picker.busy) throw new Error("Select a directory from the current native picker.");
    picker.claimed = true; picker.busy = true;
    try {
      this.#assert(picker); assertCurrent(); await this.#verify(picker, entry); assertCurrent();
      // Once accepted, the deposit retains only the original installation and
      // real directory identity. Closing the settings page does not create a new owner.
      const assertDirectoryCurrent = async () => {
        const actual = await realpath(entry.directoryPath), info = await lstat(entry.directoryPath);
        if (!samePath(actual, entry.directoryPath) || !info.isDirectory() || info.isSymbolicLink() || identity(info) !== entry.identity) throw new Error("The selected directory was replaced.");
      };
      const result = await this.options.runtime.preparePickedDirectory({ extensionId, authorityKey: picker.authorityKey,
        selectionId: picker.id, directory: entry.directoryPath, assertDirectoryCurrent,
        assertSelectionCurrent: () => { this.#assert(picker); assertCurrent(); } });
      this.#assert(picker); assertCurrent(); return result;
    } finally { if (this.#active === picker) this.#active = undefined; }
  }
}
