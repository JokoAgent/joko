import { atomicWriteUserSelectedFile, captureUserSelectedFile, type UserSelectedFileDestination } from "@joko/device-peer/private-files";

import type { NativeFileActionScope } from "./native-file-action-requests.js";

interface SaveSelection {
  readonly requestId: string;
  destination?: UserSelectedFileDestination;
}

/** Keep the user's selected path in Main and bind its one write to the originating Document. */
export class PortableSessionSave {
  readonly #selections = new WeakMap<NativeFileActionScope, SaveSelection>();

  async choose(scope: NativeFileActionScope, requestId: string, pick: () => Promise<string | undefined>): Promise<boolean> {
    if (!scope.isCurrent()) throw expiredSelection();
    if (this.#selections.has(scope)) throw new Error("A portable task save is already in progress in this window.");
    const selection: SaveSelection = { requestId };
    this.#selections.set(scope, selection);
    try {
      const path = await pick();
      if (path === undefined || !this.#isCurrent(scope, selection)) return false;
      const destination = await captureUserSelectedFile(path);
      if (!this.#isCurrent(scope, selection)) return false;
      selection.destination = destination;
      return true;
    } finally {
      if (selection.destination === undefined && this.#selections.get(scope) === selection) this.#selections.delete(scope);
    }
  }

  async commit(scope: NativeFileActionScope, requestId: string, bytes: Uint8Array, maximumBytes: number) {
    const selection = this.#selections.get(scope);
    if (selection?.requestId !== requestId || selection.destination === undefined || !this.#isCurrent(scope, selection)) {
      throw expiredSelection();
    }
    const destination = selection.destination;
    delete selection.destination;
    try {
      return await atomicWriteUserSelectedFile(destination, bytes, maximumBytes, () => {
        if (!this.#isCurrent(scope, selection)) throw expiredSelection();
      });
    } finally {
      if (this.#selections.get(scope) === selection) this.#selections.delete(scope);
    }
  }

  cancel(scope: NativeFileActionScope, requestId: string): void {
    if (this.#selections.get(scope)?.requestId === requestId) this.#selections.delete(scope);
  }

  retire(scope: NativeFileActionScope): void {
    this.#selections.delete(scope);
  }

  #isCurrent(scope: NativeFileActionScope, selection: SaveSelection): boolean {
    return scope.isCurrent() && this.#selections.get(scope) === selection;
  }
}

export function portableSessionSaveName(title: string): string {
  const stem = title.slice(0, 4096).normalize("NFKC")
    .replace(/[<>:"\/\\|?*\u0000-\u001f\u007f]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 96)
    .replace(/[. ]+$/gu, "");
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(stem);
  return `${stem === "" || reserved ? "Joko task" : stem}.jshare`;
}

export function isPortableSessionSaveRequestId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
}

function expiredSelection(): Error {
  return new Error("The selected portable task save destination is no longer available.");
}
