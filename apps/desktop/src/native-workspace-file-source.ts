import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, extname, relative } from "node:path";
import { nativeFileActionSequence, workspaceFileMetadataRevision } from "@joko/contracts";
import type { DesktopWorkspaceFileSourceRequest, DesktopWorkspaceFileSourceResult } from "./channels.js";
import { NativeFileActionRequests, type NativeFileActionScope } from "./native-file-action-requests.js";

const identity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;

interface VerifiedWorkspacePdfSource {
  readonly path: string;
  readonly metadataRevision: string;
  readonly isCurrent: () => boolean;
}

interface NativeWorkspaceFileSourceOptions {
  readonly resolveSource: (request: DesktopWorkspaceFileSourceRequest, signal: AbortSignal) => Promise<VerifiedWorkspacePdfSource>;
  readonly openPath: (path: string) => Promise<string>;
}

export class NativeWorkspaceFileSource {
  readonly #requests = new NativeFileActionRequests<DesktopWorkspaceFileSourceResult>();
  readonly #options: NativeWorkspaceFileSourceOptions;
  #closed = false;

  constructor(options: NativeWorkspaceFileSourceOptions) { this.#options = options; }

  async execute(value: unknown, scope: NativeFileActionScope, isFocused: () => boolean): Promise<DesktopWorkspaceFileSourceResult> {
    const input = parseRequest(value);
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const existing = this.#requests.replay(scope, input.requestId, digest);
    if (existing !== undefined) return existing === false ? { status: "cancelled" } : existing;
    const abort = new AbortController();
    const current = () => !this.#closed && !abort.signal.aborted && scope.isCurrent() && isFocused();
    if (!current()) return { status: "cancelled" };
    if (this.#requests.pendingCount >= 1_024) return { status: "failed" };
    const result = Promise.resolve().then(async (): Promise<DesktopWorkspaceFileSourceResult> => {
      if (!current()) return { status: "cancelled" };
      let source: VerifiedWorkspacePdfSource;
      try {
        source = await this.#options.resolveSource(input, abort.signal);
        const canonical = await realpath(source.path);
        const info = await lstat(source.path);
        if (!info.isFile() || info.isSymbolicLink() || extname(source.path).toLowerCase() !== ".pdf"
          || relative(canonical, source.path) !== "" || workspaceFileMetadataRevision(info) !== source.metadataRevision) {
          return { status: current() ? "unavailable" : "cancelled" };
        }
      } catch { return { status: current() ? "unavailable" : "cancelled" }; }
      if (!current() || !source.isCurrent()) return { status: "cancelled" };
      try {
        const target = input.action === "reveal" ? dirname(source.path) : source.path;
        if (await this.#options.openPath(target) !== "") return { status: "failed" };
        return { status: input.action === "reveal" ? "revealed" : "opened" };
      } catch { return { status: "failed" }; }
    });
    this.#requests.add(scope, input.requestId, digest, abort, result);
    return result;
  }

  cancel(requestId: string, scopeId: string): void { this.#requests.cancel(scopeId, requestId); }
  retireScope(scopeId: string): void { this.#requests.retireScope(scopeId); }
  cancelPending(): void { this.#requests.cancelPending(); }
  dispose(): void { this.#closed = true; this.cancelPending(); }
}

function parseRequest(value: unknown): DesktopWorkspaceFileSourceRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("An original Workspace PDF request is required.");
  const { requestId, profileId, serverId, workspaceId, path, revision, action, ...extra } = value as Record<string, unknown>;
  if (Object.keys(extra).length !== 0 || typeof requestId !== "string" || nativeFileActionSequence(requestId) === undefined
    || typeof profileId !== "string" || !identity.test(profileId) || typeof serverId !== "string" || !identity.test(serverId)
    || typeof workspaceId !== "string" || !identity.test(workspaceId) || typeof path !== "string" || path.length > 32_768
    || !/\.pdf$/iu.test(path) || /[\\\u0000]/u.test(path) || path.split("/").some(part => part === "" || part === "." || part === "..")
    || typeof revision !== "string" || revision.trim() === "" || revision.length > 320 || (action !== "open" && action !== "reveal")) {
    throw new TypeError("The original Workspace PDF request is invalid.");
  }
  return { requestId, profileId, serverId, workspaceId, path, revision, action };
}
