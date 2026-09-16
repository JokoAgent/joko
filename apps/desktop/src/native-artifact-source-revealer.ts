import { createHash } from "node:crypto";

import type {
  DesktopRevealArtifactSourceRequest,
  DesktopRevealArtifactSourceResult
} from "./channels.js";
import type { NativeFileActionScope } from "./native-file-clipboard.js";

const MAXIMUM_REQUESTS = 1_024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;

interface Request {
  readonly scope: NativeFileActionScope;
  readonly digest: string;
  readonly abort: AbortController;
  readonly result: Promise<DesktopRevealArtifactSourceResult>;
}

export interface NativeArtifactSourceRevealerOptions {
  readonly resolvePath: (request: DesktopRevealArtifactSourceRequest, signal: AbortSignal) => Promise<string>;
  readonly revealPath: (path: string) => void;
}

/** Exact-once bridge from opaque renderer identity to trusted Main path reveal. */
export class NativeArtifactSourceRevealer {
  readonly #options: NativeArtifactSourceRevealerOptions;
  readonly #requests = new Map<string, Request>();
  #closed = false;

  constructor(options: NativeArtifactSourceRevealerOptions) {
    this.#options = options;
  }

  reveal(value: unknown, scope: NativeFileActionScope): Promise<DesktopRevealArtifactSourceResult> {
    const input = parseDesktopRevealArtifactSourceRequest(value);
    const key = `${scope.id}\0${input.requestId}`;
    const digest = createHash("sha256")
      .update(input.profileId).update("\0")
      .update(input.serverId).update("\0")
      .update(input.sessionId).update("\0")
      .update(input.artifactId).digest("hex");
    const existing = this.#requests.get(key);
    if (existing !== undefined) {
      if (existing.digest !== digest) {
        return Promise.reject(new TypeError("Artifact source reveal identity was reused with different content."));
      }
      return existing.result;
    }
    if (this.#closed || !scope.isCurrent()) return Promise.resolve({ status: "cancelled" });
    if (this.#requests.size >= MAXIMUM_REQUESTS) return Promise.resolve({ status: "failed", reason: "capacity" });
    const abort = new AbortController();
    const current = (): boolean => !this.#closed && !abort.signal.aborted && scope.isCurrent();
    const result = (async (): Promise<DesktopRevealArtifactSourceResult> => {
      if (!current()) return { status: "cancelled" };
      let path: string;
      try {
        path = await this.#options.resolvePath(input, abort.signal);
      } catch {
        return current() ? { status: "unavailable" } : { status: "cancelled" };
      }
      if (!current()) return { status: "cancelled" };
      try {
        this.#options.revealPath(path);
        return { status: "revealed" };
      } catch {
        return { status: "failed", reason: "reveal" };
      }
    })();
    this.#requests.set(key, { scope, digest, abort, result });
    return result;
  }

  cancel(requestId: string, scopeId: string): void {
    if (!UUID.test(requestId)) throw new TypeError("Invalid Artifact source reveal identity.");
    this.#requests.get(`${scopeId}\0${requestId}`)?.abort.abort();
  }

  retireScope(scopeId: string): void {
    for (const request of this.#requests.values()) if (request.scope.id === scopeId) request.abort.abort();
  }

  cancelPending(): void {
    for (const request of this.#requests.values()) request.abort.abort();
  }

  dispose(): void {
    this.#closed = true;
    this.cancelPending();
  }
}

export function parseDesktopRevealArtifactSourceRequest(value: unknown): DesktopRevealArtifactSourceRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidRequest();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "artifactId,profileId,requestId,serverId,sessionId" ||
    typeof input["requestId"] !== "string" || !UUID.test(input["requestId"]) ||
    typeof input["profileId"] !== "string" || !OPAQUE_ID.test(input["profileId"]) ||
    typeof input["serverId"] !== "string" || !OPAQUE_ID.test(input["serverId"]) ||
    typeof input["sessionId"] !== "string" || !OPAQUE_ID.test(input["sessionId"]) ||
    typeof input["artifactId"] !== "string" || !OPAQUE_ID.test(input["artifactId"])) throw invalidRequest();
  return input as unknown as DesktopRevealArtifactSourceRequest;
}

function invalidRequest(): TypeError {
  return new TypeError("Artifact source reveal request is invalid.");
}
