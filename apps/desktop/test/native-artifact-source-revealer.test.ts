import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import { nativeFileActionRequestId } from "@joko/contracts";

import type { DesktopRevealArtifactSourceRequest } from "../src/channels.js";
import {
  NativeArtifactSourceRevealer,
  parseDesktopRevealArtifactSourceRequest
} from "../src/native-artifact-source-revealer.js";

let ordinal = 0;
const input = (fields: Partial<DesktopRevealArtifactSourceRequest> = {}): DesktopRevealArtifactSourceRequest => ({
  requestId: nativeFileActionRequestId(++ordinal, randomUUID()),
  profileId: "managed-local",
  serverId: "orchestrator-owner",
  sessionId: "source-task",
  artifactId: "artifact-one",
  ...fields
});

const scope = () => {
  let current = true;
  return {
    value: { id: randomUUID(), isCurrent: () => current },
    retire: () => { current = false; }
  };
};

describe("native Artifact source reveal ownership", () => {
  it("recovers after more than 1024 completed failures while retiring old identities and Document scopes", async () => {
    const resolvePath = vi.fn().mockRejectedValue(new Error("source temporarily unavailable"));
    const revealPath = vi.fn();
    const owner = new NativeArtifactSourceRevealer({ resolvePath, revealPath });
    const caller = scope();
    const first = input();
    await expect(owner.reveal(first, caller.value)).resolves.toEqual({ status: "unavailable" });
    for (let i = 0; i < 1_025; i += 1) await expect(owner.reveal(input(), caller.value)).resolves.toEqual({ status: "unavailable" });
    resolvePath.mockResolvedValue("D:\\joko\\render.png");
    const last = input();
    const result = owner.reveal(last, caller.value);
    await expect(result).resolves.toEqual({ status: "revealed" });
    expect(owner.reveal(last, caller.value)).toBe(result);
    await expect(owner.reveal(first, caller.value)).resolves.toEqual({ status: "cancelled" });
    expect(revealPath).toHaveBeenCalledOnce();
    caller.retire(); owner.retireScope(caller.value.id);
    await expect(owner.reveal(last, caller.value)).resolves.toEqual({ status: "cancelled" });
    await expect(owner.reveal(first, scope().value)).resolves.toEqual({ status: "revealed" });
    expect(revealPath).toHaveBeenCalledTimes(2);
    expect(resolvePath).toHaveBeenCalledTimes(1_028);
    owner.dispose();
  });

  it("resolves opaque identity once and replays only the exact request", async () => {
    const source = deferred<string>();
    const resolvePath = vi.fn((_request: DesktopRevealArtifactSourceRequest, _signal: AbortSignal) => source.promise);
    const revealPath = vi.fn();
    const owner = new NativeArtifactSourceRevealer({ resolvePath, revealPath });
    const caller = scope();
    const request = input();
    const first = owner.reveal(request, caller.value);
    expect(owner.reveal({ ...request }, caller.value)).toBe(first);
    await expect(owner.reveal({ ...request, artifactId: "other-artifact" }, caller.value)).rejects.toThrow("different content");
    source.resolve("D:\\joko\\render.png");
    await expect(first).resolves.toEqual({ status: "revealed" });
    expect(resolvePath).toHaveBeenCalledExactlyOnceWith(request, expect.any(AbortSignal));
    expect(revealPath).toHaveBeenCalledExactlyOnceWith("D:\\joko\\render.png");
  });

  it("cancels before reveal when the request, renderer scope, or coordinator retires", async () => {
    for (const retire of ["request", "scope", "coordinator"] as const) {
      const source = deferred<string>();
      let resolverSignal: AbortSignal | undefined;
      const revealPath = vi.fn();
      const owner = new NativeArtifactSourceRevealer({
        resolvePath: async (_request, signal) => { resolverSignal = signal; return source.promise; },
        revealPath
      });
      const caller = scope();
      const request = input();
      const pending = owner.reveal(request, caller.value);
      await vi.waitFor(() => expect(resolverSignal).toBeDefined());
      if (retire === "request") owner.cancel(request.requestId, caller.value.id);
      else if (retire === "scope") { caller.retire(); owner.retireScope(caller.value.id); }
      else owner.dispose();
      expect(resolverSignal!.aborted).toBe(true);
      source.resolve("D:\\joko\\render.png");
      await expect(pending).resolves.toEqual({ status: "cancelled" });
      expect(revealPath).not.toHaveBeenCalled();
    }
  });

  it("distinguishes a stale source from a trusted OS reveal failure", async () => {
    const caller = scope();
    const unavailable = new NativeArtifactSourceRevealer({
      resolvePath: async () => { throw new Error("source changed"); },
      revealPath: vi.fn()
    });
    await expect(unavailable.reveal(input(), caller.value)).resolves.toEqual({ status: "unavailable" });

    const failed = new NativeArtifactSourceRevealer({
      resolvePath: async () => "D:\\joko\\render.png",
      revealPath: () => { throw new Error("shell failed"); }
    });
    await expect(failed.reveal(input(), caller.value)).resolves.toEqual({ status: "failed", reason: "reveal" });
  });

  it("rejects paths and extra fields at the renderer boundary", () => {
    expect(() => parseDesktopRevealArtifactSourceRequest({ ...input(), requestId: randomUUID() })).toThrow("invalid");
    expect(() => parseDesktopRevealArtifactSourceRequest({ ...input(), path: "D:\\outside.txt" })).toThrow("invalid");
    expect(() => parseDesktopRevealArtifactSourceRequest({ ...input(), requestId: "not-a-uuid" })).toThrow("invalid");
    expect(() => parseDesktopRevealArtifactSourceRequest({ ...input(), sessionId: "../outside" })).toThrow("invalid");
  });
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
