import { describe, expect, it } from "vitest";
import type { AdapterContext, EventPayload, InteractionDecision, TargetDescriptor } from "@joko/core";
import { CODEX_LIKE_PROFILE, FakeBackendAdapter, MINIMAL_PROFILE, PI_LIKE_PROFILE } from "./index.js";

const target = (backendId: string): TargetDescriptor => ({ id: `target-${backendId}`, backendId, displayName: "Fixture", workspaceRoot: process.cwd(), managed: true, trusted: true });

function context(backendId: string, events: EventPayload[]): AdapterContext {
  return {
    sessionId: `session-${backendId}`,
    generation: 1,
    target: target(backendId),
    signal: new AbortController().signal,
    emit: async (event) => { events.push(event); },
    requestInteraction: async (): Promise<InteractionDecision> => ({ kind: "confirmed", confirmed: true }),
    artifactCapacityBytes: 256 * 1024 * 1024,
    storeArtifact: async () => ({ id: "blob", sha256: "0".repeat(64), byteLength: 0, mimeType: "text/plain" })
  };
}

describe("capability-contrast fake adapters", () => {
  it("exposes three opposite capability and permission combinations", async () => {
    const pi = await new FakeBackendAdapter(PI_LIKE_PROFILE).describe();
    const thread = await new FakeBackendAdapter(CODEX_LIKE_PROFILE).describe();
    const minimal = await new FakeBackendAdapter(MINIMAL_PROFILE).describe();
    expect(pi.capabilities.get("turn.steer")?.supported).toBe(true);
    expect(thread.capabilities.get("turn.steer")?.supported).toBe(false);
    expect(minimal.capabilities.get("context.compact")?.supported).toBe(false);
    expect(pi.capabilities.get("session.discovery")?.supported).toBe(true);
    expect(pi.capabilities.get("session.resume")?.supported).toBe(true);
    expect(thread.capabilities.get("session.discovery")?.supported).toBe(true);
    expect(thread.capabilities.get("session.resume")?.supported).toBe(false);
    expect(minimal.capabilities.get("session.discovery")?.supported).toBe(false);
    expect(thread.capabilities.get("session.message_delete")?.supported).toBe(false);
    expect(thread.capabilities.get("session.reset")?.supported).toBe(true);
    expect(pi.models.some((model) => model.supportsImages)).toBe(true);
    expect(minimal.models.some((model) => model.supportsImages)).toBe(false);
    expect(pi.models.every((model) => model.supportsFastMode === false)).toBe(true);
    expect(thread.models.every((model) => model.supportsFastMode === true)).toBe(true);
    expect(pi.tools.map((tool) => tool.name)).toEqual(["read", "bash"]);
    expect(thread.tools.map((tool) => tool.name)).toEqual(["read", "command", "apply_patch"]);
    expect(minimal.tools).toEqual([]);
    expect(thread.tools.find((tool) => tool.name === "command")).toMatchObject({
      requiresPermission: true,
      streamingUpdates: true,
      inputSchema: { fields: [expect.objectContaining({ fieldPath: "command", required: true })] }
    });
  });

  it("separates discoverable+resumable, discoverable-only, and non-discoverable profiles", async () => {
    const resumable = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const readOnly = new FakeBackendAdapter(CODEX_LIKE_PROFILE);
    const undiscoverable = new FakeBackendAdapter(MINIMAL_PROFILE);

    await expect(resumable.listNativeSessions(target(resumable.id))).resolves.toMatchObject([
      { nativeSessionId: "native-resumable", state: "ready" }
    ]);
    await expect(resumable.resolveNativeSessionReference(
      "fake://discovery/resumable",
      target(resumable.id),
      4
    )).resolves.toEqual({
      opaqueRef: "fake://discovery/resumable",
      nativeSessionId: "native-resumable",
      generation: 4
    });

    await expect(readOnly.listNativeSessions(target(readOnly.id))).resolves.toMatchObject([
      { nativeSessionId: "native-read-only", state: "ready" }
    ]);
    await expect(readOnly.resolveNativeSessionReference(
      "fake://discovery/read-only",
      target(readOnly.id),
      4
    )).rejects.toMatchObject({ publicError: { code: "CAPABILITY_UNSUPPORTED", phase: "capability" } });

    await expect(undiscoverable.listNativeSessions(target(undiscoverable.id)))
      .rejects.toMatchObject({ publicError: { code: "CAPABILITY_UNSUPPORTED", phase: "capability" } });
  });

  it("streams through the neutral event contract", async () => {
    const events: EventPayload[] = [];
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const ctx = context(adapter.id, events);
    await adapter.createSession({ target: ctx.target, fastMode: false, permissionMode: "ask" }, ctx);
    await adapter.send({ text: "hello", images: [], files: [], mentions: [], disposition: "prompt" }, ctx);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
    expect(events.map((event) => event.type)).toEqual(["text_delta", "text_delta", "message_complete", "done"]);
  });

  it("reports uncertain dispatch without pretending it is retry-safe", async () => {
    const adapter = new FakeBackendAdapter(PI_LIKE_PROFILE);
    const ctx = context(adapter.id, []);
    await adapter.createSession({ target: ctx.target, fastMode: false, permissionMode: "ask" }, ctx);
    adapter.injectFault(ctx.sessionId, "dispatch_unknown");
    await expect(adapter.send({ text: "side effect", images: [], files: [], mentions: [], disposition: "prompt" }, ctx))
      .rejects.toMatchObject({ publicError: { stateMayHaveChanged: true, retryable: false } });
  });
});
