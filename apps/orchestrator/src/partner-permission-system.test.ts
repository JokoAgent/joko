import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, Code } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import * as contract from "@joko/contracts";
import { AppServerHost, CodexBackendAdapter } from "@joko/adapter-codex";
import { FakeCodexAppServer } from "@joko/adapter-codex/testing";
import { OperationalStore, PartnerStore } from "@joko/store";
import { describe, expect, it } from "vitest";
import type { OrchestratorApplication } from "./application.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { ConnectionManager } from "./connection-manager.js";
import { PartnerManager } from "./partner-manager.js";
import { createPublicServer } from "./server.js";
import { SessionHost } from "./session-host.js";
import { mkdtemp } from "./test-paths.js";

describe("Partner operation permission composition", () => {
  it("preserves all three authenticated profile modes through durable Queue, the native runtime, and SQLite reopen", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-partner-permission-"));
    const operationalPath = join(root, "operational.db"), partnerPath = join(root, "partners.db");
    const store = new OperationalStore(operationalPath), partnerStore = new PartnerStore(partnerPath);
    const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"),
      repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
    await artifacts.initialize();
    const fake = new FakeCodexAppServer();
    const policies = new Map<string, { approvalPolicy: unknown; sandbox: unknown }>();
    const dispatched: Array<{ permission: string; queueId: string; approvalPolicy: unknown; sandbox: unknown }> = [];
    let sessionId = "", partnerId = "";
    const nativeHost = new AppServerHost({ transportFactory: () => {
      const transport = fake.createTransport(), request = transport.request.bind(transport);
      transport.request = async (method, params, options) => {
        const record = params !== null && typeof params === "object" && !Array.isArray(params) ? params : {};
        if (method === "turn/start") {
          const queue = store.listQueueItems({ sessionId, states: ["dispatching"], limit: 10 })[0]!;
          expect(queue).toBeDefined(); expect(queue.runId).toBeDefined();
          expect(store.getRun(queue.runId!).descriptor.activeAttemptId).toBeDefined();
          const policy = policies.get(String(record["threadId"]))!;
          expect(policy).toBeDefined();
          dispatched.push({ permission: store.getSession(sessionId).descriptor.permissionMode, queueId: queue.id, ...policy });
        }
        const response = await request(method, params, options);
        if ((method === "thread/start" || method === "thread/resume") && record["approvalPolicy"] !== undefined) {
          const value = response !== null && typeof response === "object" && !Array.isArray(response) ? response : {};
          const thread = value["thread"];
          if (thread !== null && typeof thread === "object" && !Array.isArray(thread)) {
            policies.set(String(thread["id"]), { approvalPolicy: record["approvalPolicy"], sandbox: record["sandbox"] });
          }
        }
        return response;
      };
      return transport;
    } });
    const adapter = new CodexBackendAdapter({ id: "partner-permission-backend", instanceGeneration: 1,
      host: nativeHost, profileDirectory: join(root, "profile") });
    const descriptor = await adapter.describe();
    const host = new SessionHost(store, artifacts, [adapter], { backendDescriptors: [descriptor],
      partnerSessionPolicy: sessionId => {
        const profile = partnerStore.findPartnerByCanonicalSession(sessionId);
        return profile === undefined ? undefined : {
          identity: JSON.stringify([profile.id, profile.homeTargetId, profile.canonicalSessionId,
            profile.profileVersion, profile.capabilities.permissionMode]), status: profile.initializationState
        };
      } });
    const workspaces = { register: async (input: { id: string; root: string; displayName: string; trusted: boolean }) => input,
      unregister: async () => undefined };
    const manager = new PartnerManager({ store: partnerStore, operationalStore: store, sessionHost: host,
      workspaceService: workspaces, homesRoot: join(root, "partner-homes") });
    let server: Awaited<ReturnType<typeof createPublicServer>> | undefined;
    try {
      await host.initialize();
      const connections = new ConnectionManager(store), challenge = connections.issuePairing("Partner owner");
      const paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Partner owner" });
      server = await createPublicServer({ config: { publicOrigin: "http://127.0.0.1", allowInsecureLoopback: true,
        allowInsecureLan: false, corsOrigins: [], webDirectory: join(root, "no-web"), dataDirectory: root },
        store, connections, sessionHost: host, partners: manager, artifacts: {}, blobTransfers: {}, artifactRepository: {},
        workspaces, workspaceChanges: {}, scheduler: {}, adapters: [adapter], browserActivity: []
      } as unknown as OrchestratorApplication);
      server.log.level = "silent";
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
      const transport = createConnectTransport({ baseUrl, httpVersion: "1.1", interceptors: [next => request => {
        request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request);
      }] });
      const partners = createClient(contract.PartnerService, transport), operations = createClient(contract.OperationService, transport);
      const initial = await partners.getPartnerDirectory({});
      const modelChain = [{ backendId: adapter.id, providerId: "openai", modelId: "gpt-test", effort: "medium", fastMode: false }];
      const defaults = await partners.updatePartnerDefaults({ expectedDirectoryRevision: initial.directory!.revision,
        capabilities: { modelChain, permissionMode: contract.PermissionMode.BYPASS_PERMISSIONS, planMode: false } });
      let profile = (await partners.createPartner({ requestId: "create-permission-partner", expectedDirectoryRevision: defaults.directory!.revision,
        draft: { displayName: "Operations partner", avatar: { value: { case: "presetId", value: "orbit" } },
          identitySource: "Help with approved work.", templateId: "general", usesDirectoryDefaults: true } })).partner!;
      partnerId = profile.partnerId; sessionId = profile.canonicalSessionId!;
      expect(profile.initializationState).toBe(contract.PartnerInitializationState.READY);
      expect(profile.capabilities?.permissionMode).toBe(contract.PermissionMode.BYPASS_PERMISSIONS);
      expect(policies.get(store.getSession(sessionId).descriptor.binding.nativeSessionId!))
        .toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
      await expect(createClient(contract.PartnerService, createConnectTransport({ baseUrl, httpVersion: "1.1" }))
        .getPartnerDirectory({})).rejects.toMatchObject({ code: Code.Unauthenticated });
      for (const [index, mode] of [
        { wire: contract.PermissionMode.ASK, core: "ask", approvalPolicy: "on-request", sandbox: "workspace-write" },
        { wire: contract.PermissionMode.AUTO, core: "auto", approvalPolicy: "never", sandbox: "workspace-write" },
        { wire: contract.PermissionMode.BYPASS_PERMISSIONS, core: "bypassPermissions", approvalPolicy: "never", sandbox: "danger-full-access" }
      ].entries()) {
        const previousRevision = profile.revision;
        profile = (await partners.updatePartner({ partnerId, expectedRevision: previousRevision,
          patch: { usesDirectoryDefaults: false, permissionMode: mode.wire } })).partner!;
        expect(profile.initializationState).toBe(contract.PartnerInitializationState.READY);
        expect(profile.capabilities?.permissionMode).toBe(mode.wire);
        await expect(partners.updatePartner({ partnerId, expectedRevision: previousRevision, patch: { displayName: "Stale intent" } }))
          .rejects.toMatchObject({ code: Code.Aborted });
        await operations.submitOperation({ operationId: `permission-turn-${index}`, connectionId: paired.connection.id,
          mutation: { preconditions: [{ entity: { kind: contract.EntityKind.SESSION, id: sessionId },
            expectedGeneration: BigInt(store.getSession(sessionId).descriptor.binding.generation) }],
            payload: { case: "sendInput", value: { sessionId, deliveryMode: contract.QueueDeliveryMode.PROMPT,
            input: { parts: [{ content: { case: "text", value: `Run operation ${index}` } }] } } } } });
        await expect.poll(() => dispatched.length, { timeout: 10_000 }).toBe(index + 1);
        expect(dispatched[index]).toMatchObject({ permission: mode.core, approvalPolicy: mode.approvalPolicy, sandbox: mode.sandbox });
        await fake.completeTurn(store.getSession(sessionId).descriptor.binding.nativeSessionId!);
        await expect.poll(() => store.getQueueItem(dispatched[index]!.queueId).state, { timeout: 10_000 }).toBe("completed");
      }
      await expect(partners.updatePartner({ partnerId, expectedRevision: profile.revision,
        patch: { permissionMode: 99 as contract.PermissionMode } })).rejects.toMatchObject({ code: Code.InvalidArgument });
      expect(partnerStore.getPartner(partnerId).capabilities.permissionMode).toBe("bypassPermissions");
    } finally {
      await server?.close(); await host.dispose(); await adapter.dispose(); await nativeHost.shutdown();
      partnerStore.close(); store.close();
    }
    const reopenedPartners = new PartnerStore(partnerPath), reopenedStore = new OperationalStore(operationalPath);
    try {
      expect(reopenedPartners.getPartner(partnerId).capabilities.permissionMode).toBe("bypassPermissions");
      expect(reopenedPartners.directoryState().defaultCapabilities?.permissionMode).toBe("bypassPermissions");
      expect(reopenedStore.getSession(sessionId).descriptor.permissionMode).toBe("bypassPermissions");
      expect(reopenedStore.listQueueItems({ sessionId, limit: 10 }).map(item => item.state)).toEqual(["completed", "completed", "completed"]);
    } finally {
      reopenedPartners.close(); reopenedStore.close(); await rm(root, { recursive: true, force: true });
    }
  });
});
