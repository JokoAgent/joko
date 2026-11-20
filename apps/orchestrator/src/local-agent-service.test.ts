import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import Fastify from "fastify";
import * as contract from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import type { BackendAdapter, NativeSessionBinding, ProviderModel } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection-manager.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { HostedAgentRuntime, type HostedAgentBackendCreation } from "./hosted-agent-runtime.js";
import { encodeHostedAgentValue } from "./hosted-agent-wire.js";
import { LocalAgentApplications, registerLocalAgentServices } from "./local-agent-service.js";

it("keeps independently approved same-name applications isolated through a native host restart and revocation", async () => {
  const parent = await realpath(tmpdir());
  const root = await mkdtemp(join(parent, "joko-local-agent-"));
  const database = join(root, "node.db");
  const hostKey = "k".repeat(43);
  const model: ProviderModel = { providerId: "provider", modelId: "model", displayName: "Model", api: "openai-completions",
    contextWindow: 32768, maxOutputTokens: 1024, supportsImages: false, thinkingLevels: [],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const sends = vi.fn(async () => {});
  const resumes = vi.fn<(binding: NativeSessionBinding) => void>();
  const homes: string[] = [];
  let now = Date.now(), runs = 0;
  const start = async () => {
    const store = new OperationalStore(database);
    const connections = new ConnectionManager(store);
    store.upsertBackend({ id: "native", adapterKind: "native", instanceGeneration: 1, displayName: "Native", version: "1",
      health: "healthy", installationState: "installed", authenticationState: "not_required", capabilities: new Map(),
      models: [model], tools: [], diagnostics: [] });
    const runtime = new HostedAgentRuntime({ store, root, connections, artifactCapacityBytes: 1_024, factories: [{
      backendId: "native", isolatedGuests: () => true, models: () => [model], providerIds: () => ["provider"],
      create: (creation: HostedAgentBackendCreation) => {
        expect(creation.trust).toBe("guest");
        expect(creation.providerIds).toEqual(["provider"]);
        homes.push(creation.home);
        return {
          id: "native", hostedExecutionCapabilities: { toolsOnSource: true, isolatedGuests: true },
          createSession: async () => {
            const id = `native-${++runs}`;
            return { opaqueRef: id, nativeSessionId: id, generation: 1 };
          },
          resumeSession: async (binding: NativeSessionBinding) => {
            resumes(binding);
            return { binding, streaming: false, providerId: "provider", modelId: "model", fastMode: false, permissionMode: "ask" };
          },
          inspectSession: async (binding: unknown) => ({ binding }),
          send: sends, dispose: async () => {}
        } as unknown as BackendAdapter;
      }
    }] });
    const server = Fastify();
    await registerLocalAgentServices(server, new LocalAgentApplications({ store, connections, runtime, now: () => now }), false);
    await server.register(fastifyConnectPlugin, { routes: router => {
      router.service(contract.HostedAgentService, createHostedAgentConnectService(runtime.connectOptions()));
    } });
    const origin = await server.listen({ host: "127.0.0.1", port: 0 });
    const transport = createConnectTransport({ baseUrl: origin, httpVersion: "1.1", useBinaryFormat: true });
    return { connections, runtime, application: createClient(contract.LocalAgentService, transport),
      desktop: createClient(contract.DesktopLocalAgentService, transport), hosted: createClient(contract.HostedAgentService, transport),
      close: async () => { await server.close(); await runtime.close(); store.close(); } };
  };
  let host: Awaited<ReturnType<typeof start>> | undefined;
  try {
    host = await start();
    const owner = host.connections.issueTrustedDesktopConnection({ desktopInstanceId: randomUUID(), desktopDeviceId: randomUUID(),
      defaultDeviceName: "Local desktop", platform: process.platform, appVersion: "0.1.0", desktopHostAuthKey: hostKey });
    const headers = { authorization: `Bearer ${owner.authKey}`, [DESKTOP_HOST_AUTHORIZATION_HEADER]: `Bearer ${hostKey}` };
    host.connections.confirmTrustedDesktopConnection(owner.connection.id, owner.authKey);
    const request = (clientId: string) => host!.application.requestLocalAgentAccess({ application: { clientId, displayName: "Local reports" } });
    const read = (value: contract.RequestLocalAgentAccessResponse) => host!.application.readLocalAgentAccess({ requestId: value.requestId, claim: value.claim });
    const decide = (value: contract.RequestLocalAgentAccessResponse, allow: boolean) =>
      host!.desktop.decideDesktopLocalAgentAccess({ requestId: value.requestId, allow }, { headers });
    const [first, second, rejected, cancelled, expired] = await Promise.all([
      request("reports.first"), request("reports.second"), request("reports.denied"), request("reports.cancelled"), request("reports.expired")
    ]);
    expect((await read(first)).state).toBe(contract.LocalAgentAccessState.PENDING);
    await expect(host.desktop.decideDesktopLocalAgentAccess({ requestId: first.requestId, allow: true },
      { headers: { authorization: headers.authorization } })).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(host.application.readLocalAgentAccess({ requestId: first.requestId, claim: second.claim })).rejects.toMatchObject({ code: Code.NotFound });
    await decide(first, true);
    await decide(second, true);
    await decide(rejected, false);
    expect(await read(rejected)).toMatchObject({ state: contract.LocalAgentAccessState.DENIED, token: "" });
    await host.application.cancelLocalAgentAccess({ requestId: cancelled.requestId, claim: cancelled.claim });
    await expect(decide(cancelled, true)).rejects.toMatchObject({ code: Code.NotFound });
    const [a, b] = await Promise.all([read(first), read(second)]);
    now = Number(expired.expiresAtUnixMs);
    await expect(decide(expired, true)).rejects.toMatchObject({ code: Code.NotFound });
    const credentials = (grant: contract.ReadLocalAgentAccessResponse) =>
      ({ headers: { authorization: `LocalAgent ${grant.grantId}.${grant.token}` } });
    expect(a.grantId).not.toBe(b.grantId);
    const directory = await host.desktop.listDesktopLocalAgents({}, { headers });
    expect(directory.requests).toHaveLength(0);
    expect(directory.grants.map(grant => grant.application?.clientId).sort()).toEqual(["reports.first", "reports.second"]);
    expect(JSON.stringify(directory.grants, (_key, value) => typeof value === "bigint" ? String(value) : value)).not.toContain(a.token);
    await expect(host.hosted.getHostedAgentSettings({}, credentials(a))).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(host.desktop.listDesktopLocalAgents({}, credentials(a))).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(await host.application.listLocalAgentModels({}, credentials(a))).toMatchObject({ backends: [{ backendId: "native" }] });

    const open = (runId: string, start: "create" | "resume") => ({
      open: { format: 1, openJson: encodeHostedAgentValue({ runId, nativeSessionId: "local-task", start, sessionId: "task", targetId: "workspace",
        generation: 1, backendId: "native", providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false,
        workspace: { platform: process.platform, shell: "sh", isGitRepository: false } }) }
    });
    const state = (runId: string) => ({ call: { format: 1, runId, callId: "read", commandJson: encodeHostedAgentValue({ kind: "state" }) } });
    await host.application.openLocalAgent(open("shared-name", "create"), credentials(a));
    await host.application.callLocalAgent(state("shared-name"), credentials(a));
    await expect(host.application.callLocalAgent(state("shared-name"), credentials(b))).rejects.toMatchObject({ code: Code.Unavailable });
    await host.application.openLocalAgent(open("shared-name", "create"), credentials(b));
    await host.application.callLocalAgent(state("shared-name"), credentials(b));
    expect(homes).toHaveLength(2);
    expect(homes[0]).not.toBe(homes[1]);
    const send = { call: { format: 1, runId: "shared-name", callId: "message-1", commandJson: encodeHostedAgentValue({
      kind: "send", durableFence: false, input: { text: "Summarize this report.", images: [], files: [], mentions: [], disposition: "prompt" }
    }) } };
    await host.application.callLocalAgent(send, credentials(a));
    await host.application.callLocalAgent(send, credentials(a));
    expect(sends).toHaveBeenCalledTimes(1);

    await host.close();
    host = undefined;
    host = await start();
    await host.application.openLocalAgent(open("original-after-restart", "resume"), credentials(a));
    await host.application.callLocalAgent(state("original-after-restart"), credentials(a));
    await host.application.openLocalAgent(open("original-after-restart", "resume"), credentials(b));
    await host.application.callLocalAgent(state("original-after-restart"), credentials(b));
    expect(homes.slice(2)).toEqual(homes.slice(0, 2));
    expect(resumes.mock.calls.map(call => call[0].nativeSessionId)).toEqual(["native-1", "native-2"]);
    await host.desktop.revokeDesktopLocalAgentAccess({ grantId: a.grantId }, { headers });
    await expect(host.application.listLocalAgentModels({}, credentials(a))).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(host.runtime.slots.summary().total).toBe(1);
    expect((await host.desktop.listDesktopLocalAgents({}, { headers })).grants.map(grant => grant.grantId)).toEqual([b.grantId]);
    expect(await host.application.listLocalAgentModels({}, credentials(b))).toMatchObject({ backends: [{ backendId: "native" }] });
  } finally {
    await host?.close();
    if (dirname(root) !== parent || !basename(root).startsWith("joko-local-agent-") || await realpath(root) !== root) throw new Error("Unsafe test cleanup.");
    await rm(root, { recursive: true, force: true });
  }
});
