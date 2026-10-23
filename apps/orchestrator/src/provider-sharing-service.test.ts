import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport, type Interceptor } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { AdapterContext, BackendAdapter, BackendDescriptor, CreateNativeSessionInput, EventPayload, NativeSessionBinding, PromptInput, ProviderModel } from "@joko/core";
import { createPiAdapter } from "@joko/adapter-pi";
import { HostedAgentSourceAdapter } from "@joko/adapter-hosted";
import { HostedAgentStore, OperationalStore } from "@joko/store";
import { expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { HostedAgentRuntime, type HostedAgentBackendCreation } from "./hosted-agent-runtime.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { createHostedAgentConnectService } from "./hosted-agent-connect-service.js";
import { ProviderSharingHost, PROVIDER_SHARING_SOURCE_DEVICE_HEADER, PROVIDER_SHARING_RECIPIENT_HEADER } from "./provider-sharing-host.js";
import { ProviderSharingHome, type ProviderSharingRemote, type ProviderSharingRemoteOptions } from "./provider-sharing-home.js";
import { createProviderSharingConnectService, createProviderSharingGuestConnectService } from "./provider-sharing-connect-service.js";
import { providerSharingReshareKey } from "./provider-sharing-ports.js";
import type { HostedAgentOpen } from "./hosted-agent-host.js";
import { encodeHostedAgentValue } from "./hosted-agent-wire.js";
import { HostedAgentPoller } from "./hosted-agent-poller.js";
import { createHostedAgentSourceController } from "./hosted-agent-source-controller.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex"), signal = () => new AbortController().signal;
async function fixture(options: { readonly backendId?: string; readonly createNative?: (creation: HostedAgentBackendCreation) => BackendAdapter | Promise<BackendAdapter> } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-provider-sharing-service-"))), database = new OperationalStore(":memory:"), connections = new ConnectionManager(database);
  database.createConnection({ id: "owner", name: "Owner", authKeyDigest: hash("private-owner-key") });
  let sharing!: ProviderSharingHost, captured: AdapterContext | undefined, created = 0, disposed = 0, cleanupUnknown = false;
  let beforeCreate: (() => Promise<void>) | undefined;
  const model: ProviderModel = { providerId: "provider", modelId: "model", displayName: "Model", api: "openai-completions", contextWindow: 32768,
    maxOutputTokens: 1024, supportsImages: false, thinkingLevels: [], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const backendId = options.backendId ?? "native";
  database.upsertBackend({ id: backendId, adapterKind: "native-test", instanceGeneration: 1, displayName: "Provider host",
    health: "healthy", version: "1", installationState: "installed", authenticationState: "not_required",
    capabilities: new Map(), models: [model, { ...model, providerId: "foreign-provider", modelId: "foreign-model" }], tools: [], diagnostics: [] });
  const native = new HostedAgentRuntime({ store: database, root: join(root, "native"), artifactCapacityBytes: 1024 * 1024, connections,
    authenticateGuest: context => sharing.authenticateNative(context),
    factories: [{ backendId, providerIds: () => ["provider", "foreign-provider"], isolatedGuests: () => true,
      models: () => [model, { ...model, providerId: "foreign-provider", modelId: "foreign-model" }],
      describe: () => ({ adapterKind: "native-test", providers: [] }), create: async creation => {
        await beforeCreate?.(); if (options.createNative) return options.createNative(creation);
        return { id: backendId, hostedExecutionCapabilities: { toolsOnSource: true, isolatedGuests: true },
          createSession: async (_input: CreateNativeSessionInput, context: AdapterContext) => { captured = context; return { opaqueRef: `private-native-${++created}`, nativeSessionId: `sdk-${created}`, generation: 1 }; },
          send: async (_input: PromptInput, context: AdapterContext) => { captured = context; await context.emit({ type: "run_state", state: "running" }); },
          inspectSession: async (binding: NativeSessionBinding) => ({ binding, streaming: false, compacting: false, pendingMessages: 0, permissionMode: "ask", fastMode: false }),
          resumeSession: async (binding: NativeSessionBinding) => ({ binding, providerId: "provider", modelId: "model", streaming: false, compacting: false, pendingMessages: 0, permissionMode: "ask", fastMode: false }),
          dispose: async () => { disposed++; if (cleanupUnknown) throw new Error("Exact process closure is unconfirmed."); }
        } as unknown as BackendAdapter;
      } }] });
  let settings = native.settings.update({ kind: "remote_control", enabled: true }, 0n);
  for (const providerId of ["provider", "foreign-provider"]) settings = native.settings.update({ kind: "provider", backendId, providerId, enabled: true }, settings.revision);
  sharing = new ProviderSharingHost({ store: database, serverId: "issuer-home", origin: "http://127.0.0.1:43210", native });
  const vault = await CredentialVault.open(join(root, "master.key")), homeDirectory = join(root, "received-home");
  let loseSubmit = false, submits = 0, seenSecret = "";
  const connect = (options: ProviderSharingRemoteOptions): ProviderSharingRemote => {
    const authorization: Interceptor = next => async request => {
      options.assertCurrent(); if (options.serverId && options.serverId !== "issuer-home") throw new ConnectError("Different Home", Code.PermissionDenied);
      const auth = options.authorization?.(); if (auth) { request.header.set("authorization", auth); if (auth.startsWith("ProviderShareGuest ")) seenSecret = auth; }
      if (options.sourceDeviceId) request.header.set(PROVIDER_SHARING_SOURCE_DEVICE_HEADER, options.sourceDeviceId);
      if (options.recipientKey) request.header.set(PROVIDER_SHARING_RECIPIENT_HEADER, options.recipientKey);
      if (request.method.name === "SubmitProviderShareRequest") submits++;
      const response = await next(request); options.assertCurrent();
      if (loseSubmit && request.method.name === "SubmitProviderShareRequest") { loseSubmit = false; throw new ConnectError("Reply lost", Code.Unavailable); }
      return response;
    };
    const transport = createRouterTransport(router => {
      router.service(contract.ProviderSharingGuestService, createProviderSharingGuestConnectService(sharing));
      router.service(contract.HostedAgentService, createHostedAgentConnectService(native.connectOptions()));
    }, { transport: { interceptors: [authorization] } });
    return { verify: async expected => { if (expected && expected !== "issuer-home") throw new ConnectError("Different Home", Code.PermissionDenied); return "issuer-home"; },
      guest: createClient(contract.ProviderSharingGuestService, transport), native: createClient(contract.HostedAgentService, transport) };
  };
  let home = new ProviderSharingHome({ directory: homeDirectory, serverId: "recipient-home", vault, connect }); await home.initialize();
  const authority = { deviceId: "recipient-device", signal: signal(), assertCurrent: () => {} };
  const issue = () => sharing.issue(create(contract.CreateProviderShareLinkRequestSchema, { operationId: crypto.randomUUID(), backendId, providerId: "provider", providerName: "My Provider", owner: { name: "Issuer" } }));
  const apply = async (link: string, operationId: string = crypto.randomUUID()) => home.apply(create(contract.ApplyProviderShareRequestSchema, { operationId, link, person: { name: "Recipient" } }), authority);
  const approve = async (requestId: string) => { sharing.decide(create(contract.DecideProviderShareRequestRequestSchema, { operationId: crypto.randomUUID(), requestId, approve: true })); await home.refresh(authority); return home.listReceived()[0]!; };
  const open = (runId: string): HostedAgentOpen => ({ runId, nativeSessionId: `native-${runId}`, start: "create", sessionId: "task", targetId: "workspace", generation: 1,
    backendId, providerId: "provider", modelId: "model", permissionMode: "ask", fastMode: false, workspace: { platform: process.platform as "win32" | "linux" | "darwin", shell: "bash", isGitRepository: false } });
  return { root, database, connections, native, sharing, connect, authority, issue, apply, approve, open,
    home: () => home, secret: () => seenSecret, submits: () => submits, created: () => created, disposed: () => disposed, captured: () => captured,
    loseSubmit: () => { loseSubmit = true; }, unknownCleanup: (value: boolean) => { cleanupUnknown = value; }, beforeCreate: (value: (() => Promise<void>) | undefined) => { beforeCreate = value; },
    restart: async () => { await home.close(); home = new ProviderSharingHome({ directory: homeDirectory, serverId: "recipient-home", vault, connect }); await home.initialize(); },
    close: async () => { await home.close(); sharing.close(); await native.close(); database.close(); if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe fixture cleanup."); await rm(root, { recursive: true, force: true }); } };
}

it("restores an unknown submitted application with the sealed original credential and no duplicate submit", async () => {
  const f = await fixture(); try {
    const invitation = f.issue(); f.loseSubmit(); const intent = await f.apply(invitation.link, "original-application");
    expect(intent.status).toBe("unknown"); expect(f.submits()).toBe(1); await f.restart(); await f.home().refresh(f.authority);
    const recovered = f.home().intents()[0]!; expect(recovered.status).toBe("pending"); expect(recovered.request?.pairingCode).toMatch(/^\d{4}$/u); expect(f.submits()).toBe(1);
    expect(f.sharing.list()[0]!.requests[0]!.pairingCode).toBe(recovered.request!.pairingCode);
    const received = await f.approve(recovered.request!.requestId); expect(received.state).toBe("active");
    const disk = await readFile(join(f.root, "received-home", "home.json"), "utf8");
    expect(disk).not.toContain(invitation.link); expect(disk).not.toContain(contract.parseProviderSharingLink(invitation.link).secret); expect(disk).not.toContain("ProviderShareGuest ");
    expect(JSON.stringify(f.database.listSettings().map(row => row.value))).not.toContain(contract.parseProviderSharingLink(invitation.link).secret);
  } finally { await f.close(); }
});
it("confines a real native guest to the issued Provider and leaves only terminal cleanup after revocation", async () => {
  const f = await fixture(); try {
    const intent = await f.apply(f.issue().link), received = await f.approve(intent.request!.requestId), capture = f.home().captureNative(received, "original-computer");
    const catalog = await capture.client.catalog(signal()); expect(catalog.backends[0]!.providers.map(row => row.providerId)).toEqual(["provider"]);
    const input = f.open("first"); await capture.client.open(input, signal()); await capture.client.call(input.runId, "first-send", { kind: "send", durableFence: false, input: { text: "Work on my Source", images: [], files: [], mentions: [], disposition: "prompt" } }, signal());
    expect(f.captured()?.hostedExecution?.trust).toBe("guest"); expect(f.native.host.activeProviderTurns("native", "provider")).toBe(1);
    await f.captured()!.emit({ type: "run_state", state: "waiting" }); expect(f.native.host.activeProviderTurns("native", "provider")).toBe(1);
    await f.captured()!.emit({ type: "done", outcome: "completed" }); expect(f.native.host.activeProviderTurns("native", "provider")).toBe(0);
    await expect(capture.client.open({ ...input, runId: "foreign", nativeSessionId: "native-foreign", providerId: "foreign-provider", modelId: "foreign-model" }, signal())).rejects.toMatchObject({ code: Code.PermissionDenied });
    const guestRaw = f.connect({ origin: "http://127.0.0.1:43210", authorization: f.secret, sourceDeviceId: "original-computer", assertCurrent: () => {} });
    const ownerTransport = createRouterTransport(router => router.service(contract.ProviderSharingService, createProviderSharingConnectService({ host: f.sharing, home: f.home(), connections: f.connections })),
      { transport: { interceptors: [next => async request => { request.header.set("authorization", f.secret()); return next(request); }] } });
    await expect(createClient(contract.ProviderSharingService, ownerTransport).listProviderShares({})).rejects.toBeDefined();
    const record = new HostedAgentStore(f.database).list()[0]!, privateRoot = join(f.root, "native", record.key);
    f.unknownCleanup(true); f.sharing.member(create(contract.SetProviderShareMemberRequestSchema, { operationId: "remove", shareId: received.shareId, memberId: received.memberId, generation: BigInt(received.generation), action: "remove" }));
    await f.sharing.reconcile(); expect(f.native.slots.summary().total).toBe(1); expect((await stat(privateRoot)).isDirectory()).toBe(true);
    await expect(guestRaw.native.getHostedAgentCatalog({ format: 1 })).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(guestRaw.native.callHostedAgent({ format: 1, runId: input.runId, callId: "after-remove", commandJson: encodeHostedAgentValue({ kind: "state" }) })).rejects.toBeDefined();
    await expect(guestRaw.native.readHostedAgentArtifact({ format: 1, runId: input.runId, artifactId: "artifact", maximumBytes: 10 })).rejects.toBeDefined();
    await expect(capture.close(input.runId, signal())).rejects.toBeDefined(); expect(new HostedAgentStore(f.database).find(record.key)).toBeDefined();
    f.unknownCleanup(false); await capture.close(input.runId, signal()); expect(f.native.slots.summary().total).toBe(0); expect(new HostedAgentStore(f.database).find(record.key)).toBeUndefined();
    await expect(stat(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await f.home().refresh(f.authority); expect(f.home().listReceived()[0]!.state).toBe("removed");
    const disk = JSON.parse(await readFile(join(f.root, "received-home", "home.json"), "utf8")); expect(disk.joined[0][1].credential).toBeUndefined(); expect(disk.intents[0].memberCredential).toBeUndefined();
  } finally { f.unknownCleanup(false); await f.close(); }
});
it("atomically replaces full reshare batches, keeps person consent across pause, and rechecks before native admission", async () => {
  const f = await fixture(); try {
    const intent = await f.apply(f.issue().link), received = await f.approve(intent.request!.requestId);
    const recipient = { shareId: "onward-share", memberId: "third-person", generation: 1, name: "Third person", avatarUrl: null }, key = providerSharingReshareKey(recipient);
    await f.home().syncReshares(received, [recipient], signal()); expect(f.home().canRelayToRecipient(received, recipient).approved).toBe(false);
    let consent = f.sharing.list()[0]!.reshares[0]!; f.sharing.decideReshare(create(contract.DecideProviderReshareRequestSchema, { operationId: "consent", id: consent.id, approve: true }));
    await f.home().syncReshares(received, [recipient], signal()); const relay = f.home().captureNative(received, f.home().localSourceDeviceId, recipient);
    expect(f.home().canRelayToRecipient(received, recipient).approved).toBe(true);
    let release!: () => void, waiting = false; f.beforeCreate(async () => { waiting = true; await new Promise<void>(ready => { release = ready; }); });
    const opening = relay.client.open(f.open("relay-before-revoke"), signal()); void opening.catch(() => {}); await vi.waitFor(() => expect(waiting).toBe(true));
    f.sharing.decideReshare(create(contract.DecideProviderReshareRequestSchema, { operationId: "revoke-consent", id: consent.id, approve: false })); release();
    await opening;
    await expect(relay.client.call("relay-before-revoke", "after-admission-revoke", { kind: "state" }, signal())).rejects.toBeDefined();
    await f.sharing.reconcile(); expect(f.created()).toBe(0); f.beforeCreate(undefined);
    const guest = f.connect({ origin: "http://127.0.0.1:43210", authorization: f.secret, sourceDeviceId: f.home().localSourceDeviceId, assertCurrent: () => {} }).guest;
    const batch = { id: "full_batch_identity_1", count: 2 };
    expect((await guest.syncProviderReshares({ entries: [{ key, person: { name: "Third person" } }], batch: { ...batch, index: 0 } })).complete).toBe(false);
    expect(f.sharing.list()[0]!.reshares).toHaveLength(1);
    await expect(guest.syncProviderReshares({ entries: [{ key, person: { name: "Conflicting identity" } }], batch: { ...batch, index: 0 } })).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect((await guest.syncProviderReshares({ entries: [{ key: "new_recipient_key_2", person: { name: "Other person" } }], batch: { ...batch, index: 1 } })).complete).toBe(true);
    expect(f.sharing.list()[0]!.reshares).toHaveLength(2);
    await guest.syncProviderReshares({ entries: [] }); expect(f.sharing.list()[0]!.reshares).toEqual([]);
  } finally { await f.close(); }
});
it("resumes the same private native binding after a paused membership while the old generation remains denied", async () => {
  const f = await fixture(); try {
    const intent = await f.apply(f.issue().link), received = await f.approve(intent.request!.requestId), first = f.home().captureNative(received, "source-computer");
    const input = f.open("before-pause"); await first.client.open(input, signal()); await first.client.call(input.runId, "ready", { kind: "state" }, signal());
    const record = new HostedAgentStore(f.database).list()[0]!;
    f.sharing.member(create(contract.SetProviderShareMemberRequestSchema, { operationId: "pause-member", shareId: received.shareId, memberId: received.memberId, generation: BigInt(received.generation), action: "pause" }));
    await f.home().refresh(f.authority); await f.sharing.reconcile(); expect(f.home().listReceived()[0]!.state).toBe("paused");
    await expect(first.client.call(input.runId, "old-paused-generation", { kind: "state" }, signal())).rejects.toBeDefined();
    const paused = f.sharing.list()[0]!.members[0]!;
    f.sharing.member(create(contract.SetProviderShareMemberRequestSchema, { operationId: "resume-member", shareId: received.shareId, memberId: paused.memberId, generation: paused.generation, action: "resume" }));
    await f.home().refresh(f.authority); const current = f.home().captureNative(f.home().listReceived()[0]!, "source-computer");
    await current.client.open({ ...input, start: "resume", runId: "after-pause" }, signal()); await current.client.call("after-pause", "resumed", { kind: "state" }, signal());
    const resumed = new HostedAgentStore(f.database).list()[0]!; expect(resumed.key).toBe(record.key); expect(resumed.binding).toEqual(record.binding); expect(f.created()).toBe(1);
    await expect(first.client.call(input.runId, "still-old-generation", { kind: "state" }, signal())).rejects.toBeDefined();
  } finally { await f.close(); }
});
it("runs the published native SDK through an approved received Provider and reads only the original Source workspace", { timeout: 75_000 }, async () => {
  let requests = 0;
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString(); expect(request.headers.authorization).toBe("Bearer private-model-key"); requests++;
    if (requests === 2) expect(body).toContain("ORIGINAL_RECEIVED_SOURCE_BYTES");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: `native-${requests}`, object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0,
      delta: requests === 1 ? { role: "assistant", tool_calls: [{ index: 0, id: "original-source-read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "proof.txt" }) } }] }
        : { role: "assistant", content: "Confirmed ORIGINAL_RECEIVED_SOURCE_BYTES." }, finish_reason: requests === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(ready => modelServer.listen(0, "127.0.0.1", ready)); const address = modelServer.address(); if (!address || typeof address === "string") throw new Error("Missing model listener.");
  const f = await fixture({ backendId: "pi", createNative: async creation => createPiAdapter({ agentHome: creation.home, sessionRoot: creation.home,
    includeManagedSubagentTools: () => false, settings: { compaction: { enabled: false }, retry: { enabled: false } }, environment: { PRIVATE_MODEL_KEY: "private-model-key" },
    providers: [{ id: "provider", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: "PRIVATE_MODEL_KEY",
      models: [{ id: "model", contextWindow: 32768, maxTokens: 1024, input: ["text"] }] }] }) });
  let adapter: HostedAgentSourceAdapter | undefined, poller: HostedAgentPoller | undefined;
  try {
    const intent = await f.apply(f.issue().link), received = await f.approve(intent.request!.requestId), capture = f.home().captureNative(received, "source-computer");
    const workspace = join(f.root, "source-workspace"); await mkdir(workspace); await writeFile(join(workspace, "proof.txt"), "ORIGINAL_RECEIVED_SOURCE_BYTES");
    const sourceBackendId = received.backendId, events: EventPayload[] = [];
    const target = { id: "source-target", backendId: sourceBackendId, displayName: "Original Source", workspaceRoot: workspace, trusted: true, managed: true };
    const descriptor: BackendDescriptor = { id: sourceBackendId, adapterKind: "hosted", instanceGeneration: 1, displayName: "Received Provider", health: "healthy", version: "1",
      installationState: "installed", authenticationState: "not_required", capabilities: new Map(), models: received.models, tools: [], diagnostics: [] };
    poller = new HostedAgentPoller(capture.client); const activePoller = poller;
    const assertContext = (context: AdapterContext) => { capture.assertCurrent(); if (context.target.id !== target.id || context.target.workspaceRoot !== workspace) throw new Error("Foreign Source."); };
    adapter = new HostedAgentSourceAdapter({ id: sourceBackendId, source: { targetDeviceId: received.hostServerId, controllerDeviceId: "source-computer", backendId: "pi" },
      describe: () => descriptor, assertContext, readPolicy: () => ({ permissionMode: "bypassPermissions", fastMode: false }),
      workspace: async () => ({ platform: process.platform as "win32" | "linux" | "darwin", shell: "bash", isGitRepository: false }), capture: async runId => ({ ...capture,
        close: () => capture.close(runId, signal()), createController: input => createHostedAgentSourceController({ ...input, poller: activePoller, temporaryRoot: join(f.root, "incoming"), assertContext,
          assertCurrent: capture.assertCurrent, readPolicy: () => ({ revision: "source-policy", permissionMode: "bypassPermissions", planMode: false, approvedRoots: [], confirmCredentials: true }) }) }) });
    const context: AdapterContext = { sessionId: "source-task", target, generation: 1, backendInstanceGeneration: 1, operationId: "create-source", signal: signal(),
      emit: async event => { events.push(event); }, requestInteraction: async () => ({ kind: "cancelled" }), artifactCapacityBytes: 1024 * 1024,
      storeArtifact: async () => { throw new Error("This check reads Source bytes only."); } };
    const binding = await adapter.createSession({ target, providerId: "provider", modelId: "model", permissionMode: "bypassPermissions", fastMode: false }, context);
    const persist = vi.fn(async preparation => { expect(preparation.inputFingerprint).toMatch(/^[a-f0-9]{64}$/u); expect(requests).toBe(0); });
    await adapter.sendWithDurableNativeDispatchFence({ text: "Read proof.txt", images: [], files: [], mentions: [], disposition: "prompt" }, { ...context, binding, operationId: "source-send" }, persist);
    await vi.waitFor(() => expect(events.some(event => event.type === "done" && event.outcome === "completed")).toBe(true), { timeout: 30_000 });
    expect(requests).toBe(2); expect(persist).toHaveBeenCalledTimes(1); expect(events.filter(event => event.type === "error")).toEqual([]);
    expect(await readFile(join(workspace, "proof.txt"), "utf8")).toBe("ORIGINAL_RECEIVED_SOURCE_BYTES");
    expect(binding.opaqueRef).not.toContain("private-model-key"); expect(binding.opaqueRef).not.toContain(join(f.root, "native"));
    await f.home().leave("leave-native", received.joinId, f.authority); await f.sharing.reconcile();
    expect(f.native.slots.summary().total).toBe(0); expect(new HostedAgentStore(f.database).list()).toEqual([]);
    await expect(adapter.send({ text: "Must stay revoked", images: [], files: [], mentions: [], disposition: "prompt" }, { ...context, binding, operationId: "after-leave" })).rejects.toBeDefined();
    expect(requests).toBe(2);
  } finally { await adapter?.dispose(); await poller?.close(); await f.close(); modelServer.closeAllConnections(); await new Promise<void>(closed => modelServer.close(() => closed())); }
});
