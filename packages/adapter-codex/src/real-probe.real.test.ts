import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  AdapterContext,
  EventPayload,
  NativeSessionBinding,
  TargetDescriptor
} from "@joko/core";
import { AppServerHost } from "./host.js";
import { CodexBackendAdapter } from "./adapter.js";

const enabled = process.env.JOKO_CODEX_REAL_PROBE === "1"
  && process.env.JOKO_CODEX_REAL_PROBE_ACK === "account-and-local-process-approved";

describe.skipIf(!enabled)("Codex real app-server probe", () => {
  it("completes the stable handshake and reads account/model state", async () => {
    const command = process.env.JOKO_CODEX_REAL_COMMAND;
    const adapter = new CodexBackendAdapter({
      instanceGeneration: 1,
      appServer: {
        transport: {
          ...(command === undefined ? {} : { command }),
          requestTimeoutMs: 30_000
        }
      }
    });
    try {
      const descriptor = await adapter.describe();
      expect(descriptor.installationState).toBe("installed");
      expect(descriptor.health).not.toBe("unavailable");
      expect(descriptor.version).not.toBe("unavailable");
      expect(descriptor.models.length).toBeGreaterThan(0);
      const providerId = descriptor.models[0]?.providerId;
      expect(providerId).toBeDefined();
      await expect(adapter.readAccountUsage(providerId!)).resolves.toMatchObject({
        providerId,
        observedAt: expect.any(Number)
      });
    } finally {
      await adapter.dispose();
    }
  });

  it("creates, lists, resolves, inspects, and deletes one local native thread without a paid turn", async () => {
    const command = process.env.JOKO_CODEX_REAL_COMMAND;
    const workspaceRoot = await mkdtemp(join(tmpdir(), "joko-codex-lifecycle-"));
    const adapter = new CodexBackendAdapter({
      instanceGeneration: 1,
      appServer: {
        transport: {
          ...(command === undefined ? {} : { command }),
          requestTimeoutMs: 30_000
        }
      }
    });
    const target: TargetDescriptor = {
      id: "real-codex-target",
      backendId: adapter.id,
      displayName: "Real Codex probe",
      workspaceRoot,
      managed: false,
      trusted: true
    };
    let cleanupBinding: NativeSessionBinding | undefined;
    let cleanupContext: AdapterContext | undefined;
    try {
      const descriptor = await adapter.describe();
      const model = descriptor.models.find((candidate) => candidate.defaultVisible !== false)
        ?? descriptor.models[0];
      expect(model).toBeDefined();
      const createdContext = realContext(target, "real-codex-created", 1);
      const created = await adapter.createSession({
        target,
        name: `Joko real lifecycle ${Date.now()}`,
        providerId: model!.providerId,
        modelId: model!.modelId,
        effort: model!.thinkingLevels[0],
        fastMode: false,
        permissionMode: "ask"
      }, createdContext);
      cleanupBinding = created;
      cleanupContext = { ...createdContext, binding: created };

      await expect(adapter.inspectSession(created, cleanupContext)).resolves.toMatchObject({
        binding: created
      });
      await expect(adapter.listNativeSessions(target)).resolves.toEqual(expect.any(Array));
      await expect(adapter.resolveNativeSessionReference(created.opaqueRef, target, 1)).resolves.toMatchObject({
        opaqueRef: created.opaqueRef,
        nativeSessionId: created.nativeSessionId,
        generation: 1
      });

      await adapter.deleteSession(created, cleanupContext);
      cleanupBinding = undefined;
      cleanupContext = undefined;
      expect((await adapter.listNativeSessions(target)).some((candidate) =>
        candidate.nativeReference === created.opaqueRef)).toBe(false);
    } finally {
      if (cleanupBinding !== undefined && cleanupContext !== undefined) {
        await adapter.deleteSession(cleanupBinding, cleanupContext).catch(() => undefined);
      }
      await adapter.dispose();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("observes the real continuity gap for an empty thread after app-server restart", async () => {
    const command = process.env.JOKO_CODEX_REAL_COMMAND;
    const workspaceRoot = await mkdtemp(join(tmpdir(), "joko-codex-empty-restart-"));
    const firstAdapter = new CodexBackendAdapter({
      instanceGeneration: 1,
      appServer: {
        transport: {
          ...(command === undefined ? {} : { command }),
          requestTimeoutMs: 30_000
        }
      }
    });
    const target: TargetDescriptor = {
      id: "real-codex-restart-target",
      backendId: firstAdapter.id,
      displayName: "Real Codex restart probe",
      workspaceRoot,
      managed: false,
      trusted: true
    };
    let secondAdapter: CodexBackendAdapter | undefined;
    let secondHost: AppServerHost | undefined;
    let binding: NativeSessionBinding | undefined;
    let cleanupBinding: NativeSessionBinding | undefined;
    let cleanupContext: AdapterContext | undefined;
    try {
      const descriptor = await firstAdapter.describe();
      const model = descriptor.models.find((candidate) => candidate.defaultVisible !== false)
        ?? descriptor.models[0];
      expect(model).toBeDefined();
      const firstContext = realContext(target, "real-codex-empty-restart", 1, 1);
      binding = await firstAdapter.createSession({
        target,
        name: `Joko empty restart ${Date.now()}`,
        providerId: model!.providerId,
        modelId: model!.modelId,
        effort: model!.thinkingLevels[0],
        fastMode: false,
        permissionMode: "ask"
      }, firstContext);
      await expect(firstAdapter.inspectSession(binding, { ...firstContext, binding })).resolves.toMatchObject({
        binding
      });

      await firstAdapter.dispose();
      secondHost = new AppServerHost({
        transport: {
          ...(command === undefined ? {} : { command }),
          requestTimeoutMs: 30_000
        }
      });
      await expect(secondHost.request("thread/read", {
        threadId: binding.nativeSessionId!,
        includeTurns: false
      })).resolves.toMatchObject({
        value: { thread: { id: binding.nativeSessionId, turns: [] } }
      });
      await expect(secondHost.request("thread/resume", {
        threadId: binding.nativeSessionId!,
        cwd: workspaceRoot,
        excludeTurns: true
      })).rejects.toMatchObject({ rpcCode: -32600 });
      secondAdapter = new CodexBackendAdapter({
        instanceGeneration: 2,
        host: secondHost
      });
      cleanupBinding = { ...binding, generation: binding.generation + 1 };
      cleanupContext = {
        ...realContext(target, "real-codex-empty-restart", cleanupBinding.generation, 2),
        binding: cleanupBinding
      };

      await expect(secondAdapter.resumeSession(binding, cleanupContext)).rejects.toMatchObject({
        publicError: {
          code: "NATIVE_SESSION_CONTINUITY_GAP",
          retryable: false,
          stateMayHaveChanged: false
        }
      });
    } finally {
      await firstAdapter.dispose();
      if (secondAdapter !== undefined && cleanupBinding !== undefined && cleanupContext !== undefined) {
        await secondAdapter.deleteSession(cleanupBinding, cleanupContext).catch(() => undefined);
      }
      await secondAdapter?.dispose();
      await secondHost?.shutdown();
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 60_000);
});

function realContext(
  target: TargetDescriptor,
  sessionId: string,
  generation: number,
  backendInstanceGeneration = 1
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
