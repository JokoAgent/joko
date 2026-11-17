import { createHash } from "node:crypto";

import type {
  DesktopRevealArtifactSourceRequest,
  DesktopRevealArtifactSourceResult
} from "./channels.js";
import { nativeFileActionSequence } from "@joko/contracts";
import { NativeFileActionRequests, type NativeFileActionScope } from "./native-file-action-requests.js";

const MAXIMUM_PENDING_REQUESTS = 1_024;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;

export interface NativeArtifactSourceRevealerOptions {
  readonly resolvePath: (request: DesktopRevealArtifactSourceRequest, signal: AbortSignal) => Promise<string>;
  readonly revealPath: (path: string) => void;
}

/** Exact-once bridge from opaque renderer identity to trusted Main path reveal. */
export class NativeArtifactSourceRevealer {
  readonly #options: NativeArtifactSourceRevealerOptions;
  readonly #requests = new NativeFileActionRequests<DesktopRevealArtifactSourceResult>();
  #closed = false;

  constructor(options: NativeArtifactSourceRevealerOptions) {
    this.#options = options;
  }

  reveal(value: unknown, scope: NativeFileActionScope): Promise<DesktopRevealArtifactSourceResult> {
    const input = parseDesktopRevealArtifactSourceRequest(value);
    const digest = createHash("sha256")
      .update(input.profileId).update("\0")
      .update(input.serverId).update("\0")
      .update(input.sessionId).update("\0")
      .update(input.artifactId).digest("hex");
    try {
      const existing = this.#requests.replay(scope, input.requestId, digest);
      if (existing !== undefined) return existing === false ? Promise.resolve({ status: "cancelled" }) : existing;
    } catch (error) { return Promise.reject(error); }
    if (this.#closed || !scope.isCurrent()) return Promise.resolve({ status: "cancelled" });
    if (this.#requests.pendingCount >= MAXIMUM_PENDING_REQUESTS) return Promise.resolve({ status: "failed", reason: "capacity" });
    const abort = new AbortController();
    const current = (): boolean => !this.#closed && !abort.signal.aborted && scope.isCurrent();
    const result = Promise.resolve().then(async (): Promise<DesktopRevealArtifactSourceResult> => {
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
    });
    this.#requests.add(scope, input.requestId, digest, abort, result);
    return result;
  }

  cancel(requestId: string, scopeId: string): void {
    this.#requests.cancel(scopeId, requestId);
  }

  retireScope(scopeId: string): void {
    this.#requests.retireScope(scopeId);
  }

  cancelPending(): void {
    this.#requests.cancelPending();
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
    typeof input["requestId"] !== "string" || nativeFileActionSequence(input["requestId"]) === undefined ||
    typeof input["profileId"] !== "string" || !OPAQUE_ID.test(input["profileId"]) ||
    typeof input["serverId"] !== "string" || !OPAQUE_ID.test(input["serverId"]) ||
    typeof input["sessionId"] !== "string" || !OPAQUE_ID.test(input["sessionId"]) ||
    typeof input["artifactId"] !== "string" || !OPAQUE_ID.test(input["artifactId"])) throw invalidRequest();
  return input as unknown as DesktopRevealArtifactSourceRequest;
}

function invalidRequest(): TypeError {
  return new TypeError("Artifact source reveal request is invalid.");
}
