/* Apache-2.0 licensed portions. Copyright 2026 XD Inc. */
import type { WorkspaceFilePreviewView } from "./model.js";
import { Code, ConnectError } from "@connectrpc/connect";

const MAX_ITEMS = 8;
const MAX_BYTES = 16 * 1024 * 1024;

export function workspacePreviewConnectionFailure(error: unknown): boolean {
  if (error && typeof error === "object" && "offline" in error && error.offline === true) return true;
  const code = ConnectError.from(error).code;
  return code === Code.Unavailable || code === Code.DeadlineExceeded;
}

/** One authenticated Gateway owns this disposable text cache. Media retains
 * its separate Artifact authority and is never cached through this path. */
export class WorkspaceTextPreviewCache {
  readonly #entries = new Map<string, { readonly workspaceId: string; readonly path: string; readonly bytes: number; readonly preview: WorkspaceFilePreviewView }>();
  #bytes = 0;
  #revision = 0;
  get revision(): number { return this.#revision; }

  get(scope: string, workspaceId: string, path: string): WorkspaceFilePreviewView | undefined {
    const key = JSON.stringify([scope, workspaceId, path]), entry = this.#entries.get(key);
    if (!entry) return;
    this.#entries.delete(key); this.#entries.set(key, entry);
    return { ...entry.preview };
  }

  set(scope: string, workspaceId: string, preview: WorkspaceFilePreviewView): void {
    if (preview.kind !== "text" || preview.text === undefined || preview.blobId !== undefined) return;
    const key = JSON.stringify([scope, workspaceId, preview.path]), bytes = preview.text.length * 2;
    this.#remove(key);
    if (bytes > MAX_BYTES) return;
    this.#entries.set(key, { workspaceId, path: preview.path, bytes, preview: { ...preview } }); this.#bytes += bytes;
    while (this.#entries.size > MAX_ITEMS || this.#bytes > MAX_BYTES) this.#remove(this.#entries.keys().next().value!);
  }

  invalidate(workspaceId: string, path?: string): void {
    this.#revision++;
    for (const [key, entry] of this.#entries) if (entry.workspaceId === workspaceId
      && (path === undefined || entry.path === path || entry.path.startsWith(`${path}/`))) this.#remove(key);
  }

  clear(): void { this.#revision++; this.#entries.clear(); this.#bytes = 0; }
  #remove(key: string): void { const entry = this.#entries.get(key); if (entry) { this.#bytes -= entry.bytes; this.#entries.delete(key); } }
}
