import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdapterContext,
  EventPayload,
  NativeSessionBinding,
  TargetDescriptor
} from "@joko/core";
import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "./adapter.js";

const enabled = process.env.JOKO_CLAUDE_CODE_REAL_PROBE === "1"
  && process.env.JOKO_CLAUDE_CODE_REAL_PROBE_ACK === "local-process-without-turn-approved";

describe.skipIf(!enabled)("Claude Code non-paid real probe", () => {
  it("probes startup and exercises a fresh in-memory session without sending input", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "joko-claude-code-probe-"));
    const instanceGeneration = 1;
    const adapter = new ClaudeCodeAdapter({
      instanceGeneration,
      probeCwd: workspaceRoot
    });
    const target: TargetDescriptor = {
      id: "real-claude-code-target",
      backendId: adapter.id,
      displayName: "Real Claude Code probe",
      workspaceRoot,
      managed: false,
      trusted: true
    };
    const context = realContext(target, "real-claude-code-created", 1, instanceGeneration);
    let binding: NativeSessionBinding | undefined;
    try {
      const descriptor = await adapter.describe();
      expect(descriptor).toMatchObject({
        id: adapter.id,
        installationState: "installed",
        health: "healthy"
      });
      const model = descriptor.models.find((candidate) => candidate.defaultVisible !== false)
        ?? descriptor.models[0];
      expect(model).toBeDefined();
      expect(descriptor.providers).toContainEqual(expect.objectContaining({
        providerId: model!.providerId,
        authenticationState: descriptor.authenticationState,
        supportsRefresh: true,
        supportsModelRefresh: true
      }));
      await expect(adapter.listNativeSessions(target)).resolves.toEqual(expect.any(Array));

      binding = await adapter.createSession({
        target,
        name: `Joko real probe ${Date.now()}`,
        providerId: model!.providerId,
        modelId: model!.modelId,
        fastMode: false,
        permissionMode: "ask",
        nativeStart: { kind: "new" }
      }, context);
      await expect(adapter.inspectSession(binding, { ...context, binding })).resolves.toMatchObject({
        binding,
        providerId: model!.providerId,
        modelId: model!.modelId,
        streaming: false,
        pendingMessages: 0
      });
      await adapter.closeSession(binding, { ...context, binding });
      binding = undefined;
    } finally {
      if (binding !== undefined) {
        await adapter.closeSession(binding, { ...context, binding }).catch(() => undefined);
      }
      await adapter.dispose();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 90_000);
});

function realContext(
  target: TargetDescriptor,
  sessionId: string,
  generation: number,
  backendInstanceGeneration: number
): AdapterContext {
  return {
    sessionId,
    generation,
    backendInstanceGeneration,
    target,
    signal: new AbortController().signal,
    emit: async (_event: EventPayload) => undefined,
    requestInteraction: async () => ({ kind: "cancelled" }),
    artifactCapacityBytes: 1024 * 1024,
    storeArtifact: async () => ({
      id: "unused-artifact",
      sha256: "0".repeat(64),
      byteLength: 0,
      mimeType: "application/octet-stream"
    })
  };
}
