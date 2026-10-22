import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Code, createClient } from "@connectrpc/connect";
import { toJsonString } from "@bufbuild/protobuf";
import { createConnectTransport } from "@connectrpc/connect-node";
import { GetHostedAgentCatalogResponseSchema, HostedAgentService } from "@joko/contracts";
import { expect, it } from "vitest";
import { createOrchestratorApplication, type OrchestratorApplication } from "./application.js";
import type { OrchestratorConfig } from "./config.js";
import { createPublicServer } from "./server.js";
import { HostedAgentConnectClient } from "./hosted-agent-connect-client.js";
import { HOSTED_AGENT_WIRE_ENVELOPE_BYTES } from "./hosted-agent-wire.js";

it("serves authenticated native hosting from the actual application with node-owned Provider credentials, opt-in, quota and revocation", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-hosted-application-")), data = join(root, "data"), workspace = join(root, "workspace");
  if (process.platform === "win32") await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl = New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))); [System.IO.Directory]::SetAccessControl($env:JOKO_HOSTED_FIXTURE, $acl)"],
    { windowsHide: true, env: { ...process.env, JOKO_HOSTED_FIXTURE: root } });
  await mkdir(workspace);
  const config: OrchestratorConfig = { host: "127.0.0.1", port: 0, internalPort: 4327, publicOrigin: "http://127.0.0.1", internalOrigin: "http://127.0.0.1:4327",
    dataDirectory: data, databasePath: join(data, "orchestrator.sqlite"), artifactDirectory: join(data, "artifacts"), piAgentHome: join(data, "pi"),
    allowInsecureLoopback: true, allowInsecureLan: false, lanDiscoveryEnabled: false, voiceDictionaryLanDiscoveryEnabled: false,
    codexExecutable: join(root, "missing-codex"), claudeCodeExecutable: join(root, "missing-claude"), webDirectory: join(root, "no-web"), corsOrigins: [],
    workspace: { id: "workspace", root: workspace, displayName: "Application", trusted: true } };
  let calls = 0, authorization = "";
  const model = createServer(async (request, response) => {
    authorization = request.headers.authorization ?? ""; for await (const _chunk of request) { /* Drain the SDK request. */ } calls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "native-host-answer", object: "chat.completion.chunk", created: 1, model: "host-model",
      choices: [{ index: 0, delta: { role: "assistant", content: "Hosted model answered." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(ready => model.listen(0, "127.0.0.1", ready));
  const address = model.address(); if (!address || typeof address === "string") throw new Error("Missing model fixture listener.");
  let application: OrchestratorApplication | undefined, server: Awaited<ReturnType<typeof createPublicServer>> | undefined;
  try {
    application = await createOrchestratorApplication(config);
    const credentials = application.credentials!, providers = application.providers!;
    const ticket = credentials.createUploadTicket(); credentials.upload(ticket.credentialUploadTicketId, "native-provider-node-test-key");
    await credentials.commitUpload({ credentialUploadTicketId: ticket.credentialUploadTicketId, credentialReferenceId: "cred_hosted_native",
      displayName: "Hosted native fixture", kind: "api_key", providerId: "host-provider" });
    await providers.upsert({ backendId: "pi", provider: { id: "host-provider", api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKeyEnv: "HOSTED_NATIVE_TEST_KEY", models: [{ id: "host-model", contextWindow: 32_768, maxTokens: 1024, input: ["text"] }] },
      displayName: "Host Provider", credentialOrigin: `http://127.0.0.1:${address.port}`, kind: "api_key", credentialBindings: { HOSTED_NATIVE_TEST_KEY: "cred_hosted_native" },
      enabled: true, supportsLogin: false, supportsLogout: true, supportsRefresh: false });
    await application.restartBackend("pi");
    server = await createPublicServer(application); server.log.level = "silent"; const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
    const challenge = application.connections.issuePairing("Native execution controller");
    const paired = application.connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Native controller" });
    const transport = createConnectTransport({ baseUrl, httpVersion: "1.1", useBinaryFormat: true,
      readMaxBytes: HOSTED_AGENT_WIRE_ENVELOPE_BYTES, writeMaxBytes: HOSTED_AGENT_WIRE_ENVELOPE_BYTES,
      interceptors: [next => request => { request.header.set("authorization", `Bearer ${paired.authKey}`); return next(request); }] });
    const generated = createClient(HostedAgentService, transport), client = new HostedAgentConnectClient(generated, () => {}), signal = new AbortController().signal;
    const anonymous = createClient(HostedAgentService, createConnectTransport({ baseUrl, httpVersion: "1.1" }));
    await expect(anonymous.getHostedAgentSettings({})).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(anonymous.getHostedAgentCatalog({ format: 1 })).rejects.toMatchObject({ code: Code.Unauthenticated });
    await expect(generated.getHostedAgentCatalog({ format: 2 })).rejects.toMatchObject({ code: Code.InvalidArgument });
    const initialCatalog = await client.catalog(signal);
    expect(initialCatalog.remoteControlEnabled).toBe(false);
    const initialProvider = initialCatalog.backends.find(backend => backend.backendId === "pi")?.providers.find(provider => provider.providerId === "host-provider");
    expect(initialProvider).toMatchObject({ displayName: "Host Provider", connected: true, remoteInvocationEnabled: false });
    expect(initialProvider?.models[0]).toMatchObject({ backendId: "pi", key: { providerId: "host-provider", modelId: "host-model" } });
    expect(toJsonString(GetHostedAgentCatalogResponseSchema, initialCatalog)).not.toContain("native-provider-node-test-key");
    expect(toJsonString(GetHostedAgentCatalogResponseSchema, initialCatalog)).not.toContain(`127.0.0.1:${address.port}`);
    let settings = (await generated.getHostedAgentSettings({})).settings!;
    expect(settings.remoteControlEnabled).toBe(false); expect(settings.limits).toMatchObject({ perDevice: 16, total: 64 });
    const open = { runId: "disabled-computer", nativeSessionId: "retained-native", start: "create" as const, sessionId: "original-task", targetId: "original-workspace",
      generation: 1, backendId: "pi", providerId: "host-provider", modelId: "host-model", permissionMode: "ask" as const, fastMode: false,
      workspace: { platform: process.platform as "win32" | "darwin" | "linux", shell: "bash", isGitRepository: false } };
    await expect(client.open(open, signal)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    settings = (await generated.updateHostedAgentSettings({ expectedRevision: settings.revision, update: { case: "remoteControl", value: { enabled: true } } })).settings!;
    await expect(client.open({ ...open, runId: "disabled-provider" }, signal)).rejects.toMatchObject({ code: Code.PermissionDenied });
    settings = (await generated.updateHostedAgentSettings({ expectedRevision: settings.revision,
      update: { case: "provider", value: { backendId: "pi", providerId: "host-provider", enabled: true } } })).settings!;
    const enabledCatalog = await client.catalog(signal);
    expect(enabledCatalog.remoteControlEnabled).toBe(true);
    expect(enabledCatalog.backends.find(backend => backend.backendId === "pi")?.providers.find(provider => provider.providerId === "host-provider")?.remoteInvocationEnabled).toBe(true);
    await expect(generated.updateHostedAgentSettings({ expectedRevision: 0n, update: { case: "limits", value: { perDevice: 1, total: 1 } } })).rejects.toMatchObject({ code: Code.Aborted });
    const opened = await client.open({ ...open, runId: "actual-native" }, signal); expect(opened.virtualRoot).toContain("hosted-agents");
    settings = (await generated.updateHostedAgentSettings({ expectedRevision: settings.revision, update: { case: "limits", value: { perDevice: 1, total: 1 } } })).settings!;
    expect(settings.usage).toMatchObject({ total: 1, devices: 1, maximumDevice: 1 });
    await expect(client.open({ ...open, runId: "excess-native", nativeSessionId: "another-native" }, signal)).rejects.toMatchObject({ code: Code.ResourceExhausted });
    await client.call("actual-native", "prompt", { kind: "send", durableFence: false, input: { text: "Answer briefly.", images: [], files: [], mentions: [], disposition: "prompt" } }, signal);
    let cursor = 0, done = false;
    while (!done) {
      const batches = await client.poll([{ runId: "actual-native", after: cursor }], AbortSignal.timeout(15_000));
      for (const batch of batches) { cursor = batch.cursor; done ||= batch.frames.some(frame => frame.payload.kind === "event" && frame.payload.event.type === "done"); }
    }
    expect(calls).toBe(1); expect(authorization).toBe("Bearer native-provider-node-test-key");
    expect(JSON.stringify(application.store.listSettingsByKeyPrefix("service", "native-hosted.v1", "").map(row => row.value))).not.toContain("native-provider-node-test-key");
    settings = (await generated.updateHostedAgentSettings({ expectedRevision: settings.revision,
      update: { case: "provider", value: { backendId: "pi", providerId: "host-provider", enabled: false } } })).settings!;
    expect(settings.usage?.total).toBe(0);
    expect((await client.catalog(signal)).backends.find(backend => backend.backendId === "pi")?.providers.find(provider => provider.providerId === "host-provider"))
      .toMatchObject({ remoteInvocationEnabled: false, connected: true });
    await expect(client.call("actual-native", "after-revocation", { kind: "state" }, signal)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    settings = (await generated.updateHostedAgentSettings({ expectedRevision: settings.revision, update: { case: "resetLimits", value: {} } })).settings!;
    expect(settings.limitsOverridden).toBe(false); expect(settings.limits).toMatchObject({ perDevice: 16, total: 64 });
    expect(settings.providers.find(provider => provider.providerId === "host-provider")?.enabled).toBe(false);
  } finally {
    await server?.close(); await application?.close(); model.closeAllConnections(); await new Promise<void>(closed => model.close(() => closed()));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup."); await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
