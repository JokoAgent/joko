import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { Code } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import { createPartnerImportApi, importSelectionInput, PartnerImportCategory, PartnerImportCheckStatus, PartnerImportStatus, PartnerInitializationErrorCode,
  PartnerInitializationState, OperationState, PermissionDecisionKind, PermissionMode, RoutineRunStatus } from "@joko/contracts";
import { RealPiSystemFixture, REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID } from "./real-pi-fixture.js";
import { waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, resolvePermissionMutation, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { installLocalSkill } from "./skill-system-fixture.js";

let fixture: RealPiSystemFixture | undefined;
afterEach(async () => { await fixture?.close({ removeRoot: true }); fixture = undefined; });

const verifiedCodex = process.env.GITHUB_ACTIONS === "true" ? process.env.JOKO_CODEX_HOSTED_TEST_BINARY : undefined;
const claudeFixtureModel = "claude-sonnet-4-6";

it.each([
  { backendId: "pi", native: "published Pi" },
  { backendId: "claude-code", native: "bundled Claude SDK" }
] as const)("imports selected local Agent entries from the $native tool with the original Owner's approval and durable receipt",
  { timeout: 100_000 }, async ({ backendId }) => exerciseAgentImport(backendId));

it.skipIf(verifiedCodex === undefined)("imports selected local Agent entries from the published Codex tool with the original Owner's approval and durable receipt",
  { timeout: 120_000 }, async () => exerciseAgentImport("codex"));

async function exerciseAgentImport(backendId: "pi" | "claude-code" | "codex"): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "joko-command-import-"));
  const source = join(root, ".hermes");
  const secret = "fixture-command-import-secret-abcdef012345";
  await mkdir(join(source, "memories"), { recursive: true });
  await writeFile(join(source, "config.yaml"), "name: Local analyst\n");
  await writeFile(join(source, ".env"), `ACCESS_TOKEN=${secret}\n`);
  await writeFile(join(source, "SOUL.md"), `Source identity ${secret}\nPRIVATE_IDENTITY_MARKER`);
  await writeFile(join(source, "memories", "notes.md"), "UNSELECTED_MEMORY_MARKER");
  const claude = backendId === "claude-code";
  const codex = backendId === "codex";
  const modelId = claude ? claudeFixtureModel : REAL_PI_MODEL_ID;
  const serverId = "joko_partner_import";
  const mcpName = claude ? `joko_${createHash("sha256").update(serverId).digest("hex").slice(0, 24)}` : serverId;
  const toolName = `mcp__${mcpName}__import_agent`;
  let toolArguments: Readonly<Record<string, unknown>> | undefined;
  let catalogToolName: string | undefined;
  let searchedForCodexTool = false;
  fixture = await RealPiSystemFixture.start({ rootDirectory: root, enableInternalServer: true,
    ...(claude ? { providerApi: "anthropic-messages" as const } : {}),
    ...(codex ? { codexExecutable: verifiedCodex! } : {}),
    agentImportSources: { home: root, environment: {} }, providerResponder: ({ request }) => {
      const messages = request.body["messages"] as readonly { role: string }[];
      if (toolArguments === undefined) return { kind: "text", text: "The local import tool returned." };
      type ImportSchema = { properties?: { operation?: { enum: string[] } } };
      let requestedToolName = toolName;
      if (codex) {
        const tools = request.body["tools"] as readonly { function?: { name: string; parameters?: ImportSchema } }[];
        const advertised = tools?.find(item => item.function?.name.endsWith("__import_agent"))?.function;
        if (!advertised && !searchedForCodexTool && tools?.some(item => item.function?.name === "tool_search")) {
          searchedForCodexTool = true;
          return { kind: "tool", name: "tool_search", arguments: { query: "import_agent: import a local Hermes or OpenClaw agent as a Partner", limit: 5 } };
        }
        expect(advertised?.parameters?.properties?.operation?.enum).toEqual(["sources", "preview", "start", "status"]);
        requestedToolName = catalogToolName = advertised!.name;
      }
      if (claude) {
        const definitions = request.body["tools"] as readonly { name: string; input_schema?: ImportSchema }[];
        const tool = definitions?.find(definition => definition.name === toolName);
        expect(tool?.input_schema?.properties?.operation?.enum).toEqual(["sources", "preview", "start", "status"]);
        catalogToolName = toolName;
      }
      if (backendId === "pi" && messages.at(-1)?.role === "tool") return { kind: "text", text: "The local import tool returned." };
      const args = toolArguments;
      toolArguments = undefined;
      return { kind: "tool", name: requestedToolName, arguments: args };
    } });
  const { store, providers, refreshBackendDescriptor } = fixture.application;
  if (backendId !== "pi") {
    const provider = providers!.resolveInferenceRoute("pi", REAL_PI_PROVIDER_ID, REAL_PI_MODEL_ID);
    expect(provider?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+(?:\/v1)?$/u);
    await providers!.upsert({
      backendId, credentialOrigin: "",
      provider: { id: REAL_PI_PROVIDER_ID, baseUrl: provider!.baseUrl, api: claude ? "anthropic-messages" : "openai-completions", keyless: true,
        models: [{ id: modelId, name: "Local import fixture model", contextWindow: 64_000, maxTokens: 4_096 }] },
      displayName: "Local import fixture", kind: "local_keyless", credentialBindings: {},
      enabled: true, supportsLogin: false, supportsLogout: false, supportsRefresh: false
    });
    await refreshBackendDescriptor(backendId);
    expect(providers!.resolveInferenceRoute(backendId, REAL_PI_PROVIDER_ID, modelId)).toMatchObject({
      modelId, api: claude ? "anthropic-messages" : "openai-completions", baseUrl: provider!.baseUrl
    });
  }
  const owner = await fixture.pair("Original import Owner");
  const other = await fixture.pair("Other paired controller");
  const { clients, connectionId } = owner;
  const directory = (await clients.partner.getPartnerDirectory({})).directory!;
  await clients.partner.updatePartnerDefaults({ expectedDirectoryRevision: directory.revision, capabilities: {
    modelChain: [{ backendId: "pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, fastMode: false }],
    permissionMode: PermissionMode.BYPASS_PERMISSIONS, planMode: false
  } });
  const targetId = backendId === "pi" ? "workspace-real-pi" : "workspace-real-pi:" + backendId;
  const target = store.getTarget(targetId);
  store.upsertTarget({ ...target.descriptor, trusted: true }, target.metadata);
  const createTask = async () => {
    const created = await submit(clients.operation, connectionId, createSessionMutation({ targetId, backendId,
      providerId: REAL_PI_PROVIDER_ID, modelId, permissionMode: PermissionMode.BYPASS_PERMISSIONS }));
    expect(created.state, JSON.stringify({ backendId, modelId, error: created.error?.code,
      message: created.error?.message, phase: created.error?.phase, mayHaveChanged: created.error?.stateMayHaveChanged,
      loopbackRequests: fixture!.providerRequests.length })).toBe(OperationState.SUCCEEDED);
    return sessionIdFrom(created);
  };
  const sessionId = await createTask(), otherSessionId = await createTask();
  const invoke = async (args: Readonly<Record<string, unknown>>, taskId = sessionId) => {
    toolArguments = args;
    searchedForCodexTool = false;
    const generation = BigInt(store.getSession(taskId).descriptor.binding.generation);
    const accepted = await submit(clients.operation, connectionId, sendInputMutation(taskId, generation, `Use the local import tool to ${args.operation}.`));
    const runId = queueRunIdFrom(accepted);
    const result = async () => {
      const read = () => store.getRun(runId).descriptor.state;
      expect(await waitFor(async () => read(), state => state === "completed" || state === "failed", "the original import tool turn", 25_000)).toBe("completed");
      const event = store.listEvents({ sessionId: taskId }).find(item => item.runId === runId && item.payload.type === "tool_result"
        && (codex ? /^joko_[^/]+\/import_agent$/u.test(item.payload.name) : item.payload.name === toolName));
      if (event?.payload.type !== "tool_result") throw new Error(`${backendId} did not receive the import tool result from its native turn.`);
      if (codex) {
        const response = JSON.parse(event.payload.output) as { content?: readonly { type: string; text?: string }[] };
        const output = response.content?.find(part => part.type === "text")?.text;
        if (output === undefined) throw new Error("Codex did not return the original MCP text result.");
        return { ...event.payload, output };
      }
      return event.payload;
    };
    return { runId, result };
  };
  const call = async <T>(args: Readonly<Record<string, unknown>>): Promise<T> => {
    const result = await (await invoke(args)).result();
    expect(result.isError, result.output).toBe(false);
    return JSON.parse(result.output) as T;
  };
  const [listed] = await call<Array<{ id: string; kind: string; name: string }>>({ operation: "sources" });
  expect(listed).toMatchObject({ kind: "hermes", name: "Local analyst" });
  const crossPreview = await (await invoke({ operation: "preview", sourceId: listed!.id }, otherSessionId)).result();
  expect(crossPreview).toMatchObject({ isError: true, output: expect.stringContaining("PREVIEW_EXPIRED") });
  const preview = await call<{ id: string; requestId: string; entries: Array<{ id: string; index: number; category: string }> }>({ operation: "preview", sourceId: listed!.id });
  expect(JSON.stringify(preview)).not.toMatch(/PRIVATE_IDENTITY_MARKER|UNSELECTED_MEMORY_MARKER|avatarImageBase64/u);
  const identity = preview.entries.find(entry => entry.category === "personality")!;
  const selection = { previewId: preview.id, requestId: preview.requestId, name: "Selected local analyst",
    entryRanges: [[identity.index, identity.index]], takeover: false };

  const start = async () => {
    const started = await invoke({ operation: "start", selection });
    const open = () => store.listInteractions({ sessionId, runId: started.runId, status: "open" });
    const [confirmation] = await waitFor(async () => open(), rows => rows.length === 1, "the original import selection approval", 10_000);
    expect(confirmation?.payload).toMatchObject({ kind: "permission", title: "Import the selected entries?",
      summary: expect.stringContaining(`(${identity.id})`) });
    expect(JSON.stringify(confirmation?.payload)).not.toContain(secret);
    const answer = (device: typeof owner, decision: PermissionDecisionKind) => submit(device.clients.operation, device.connectionId,
      resolvePermissionMutation({ connectionId: device.connectionId, interactionId: confirmation!.id,
        generation: BigInt(confirmation!.generation), decision }));
    return { answer, opened: open, result: started.result };
  };
  const denied = await start();
  let denial: Awaited<ReturnType<typeof denied.answer>> | undefined;
  let deniedResult: Awaited<ReturnType<typeof denied.result>> | undefined;
  try {
    await expect(denied.answer(other, PermissionDecisionKind.ALLOW_ONCE)).rejects.toMatchObject({
      code: Code.Unauthenticated, rawMessage: "This approval belongs to the connection that started the task."
    });
    expect(denied.opened()).toHaveLength(1);
  } finally {
    if (denied.opened().length === 1) {
      denial = await denied.answer(owner, PermissionDecisionKind.DENY_ONCE);
      deniedResult = await denied.result();
    }
  }
  expect(denial?.state).toBe(OperationState.SUCCEEDED);
  expect(deniedResult).toMatchObject({ isError: true, output: expect.stringContaining("IMPORT_SELECTION_DENIED") });
  expect((await clients.partnerImport.getPartnerImportStatus({ requestId: preview.requestId })).result).toBeUndefined();

  const approved = await start();
  expect((await approved.answer(owner, PermissionDecisionKind.ALLOW_ONCE)).state).toBe(OperationState.SUCCEEDED);
  expect(await approved.result()).toMatchObject({ isError: false });
  const read = () => clients.partnerImport.getPartnerImportStatus({ requestId: preview.requestId });
  const saved = (await waitFor(read, value => value.result?.status === PartnerImportStatus.COMPLETE, "the same durable import receipt", 30_000)).result!;
  expect(saved).toMatchObject({ saved: true, savedEntryIds: [identity.id] });
  expect((await clients.partner.getPartner({ partnerId: saved.partnerId })).partner).toMatchObject({ displayName: selection.name });

  // Retire the original preview and recover the accepted job through its original receipt.
  await call({ operation: "preview", sourceId: listed!.id });
  expect(await call({ operation: "status", requestId: preview.requestId })).toMatchObject({ partnerId: saved.partnerId, status: "complete" });
  expect(await call({ operation: "start", selection })).toMatchObject({ partnerId: saved.partnerId, status: "complete" });
  const wrongTask = await (await invoke({ operation: "status", requestId: preview.requestId }, otherSessionId)).result();
  expect(wrongTask).toMatchObject({ isError: true, output: expect.stringContaining("IMPORT_RECEIPT_MISSING") });
  const requests = JSON.stringify(fixture.providerRequests.map(({ body }) => body));
  if (backendId !== "pi") expect(catalogToolName).toBeDefined();
  expect(requests).toContain(catalogToolName ?? toolName);
  expect(requests).not.toContain(secret);
}

it("imports into the production HTTP/SQLite/published runtime, uses its full redacted resources and routines without a UI and restores the same task after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "joko-real-pi-system-e2e-")); const native = join(root, ".hermes");
  await mkdir(join(native, "skills", "reports"), { recursive: true }); await mkdir(join(native, "memories")); await mkdir(join(native, "cron"));
  const secret = "fixture-native-import-secret-abcdef012345";
  const identity = `You are a local analyst. ${secret}\n` + "Retain complete identity context.\n".repeat(400) + "IDENTITY_END_MARKER";
  await writeFile(join(native, "config.yaml"), "name: Analyst\n"); await writeFile(join(native, ".env"), `ACCESS_TOKEN=${secret}\n`);
  await writeFile(join(native, "SOUL.md"), identity); await writeFile(join(native, "memories", "notes.md"), `Retain source notes. ${secret}`);
  await writeFile(join(native, "skills", "reports", "SKILL.md"), "---\nname: Reports\ndescription: Read complete reports\n---\n" + "Full skill instructions.\n".repeat(14000));
  await writeFile(join(native, "cron", "jobs.json"), JSON.stringify([{ id: "weekly", name: "Review", enabled: false, prompt: "Review the retained import context.", schedule: { kind: "cron", expr: "0 9 * * 1" } }]));
  const sources = { home: root, environment: {} };
  fixture = await RealPiSystemFixture.start({ rootDirectory: root, keepRoot: true, enableInternalServer: true, agentImportSources: sources });
  const paired = await fixture.pair("Import manager"); let clients = paired.clients;
  const directory = (await clients.partner.getPartnerDirectory({})).directory!;
  await clients.partner.updatePartnerDefaults({ expectedDirectoryRevision: directory.revision, capabilities: {
    modelChain: [{ backendId: "pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, fastMode: false }], permissionMode: PermissionMode.AUTO, planMode: false } });
  const api = createPartnerImportApi({ rpc: clients.partnerImport, ownerKey: paired.connectionId, controllerId: "import-sheet", assertCurrent() {}, newRequestId: randomUUID });
  const signal = new AbortController().signal; const preview = await api.preview((await api.sources(signal))[0]!.id, signal);
  expect(new Set(preview.entries.map(entry => entry.category)).size).toBe(5);
  const selection = importSelectionInput(preview, new Set(preview.entries.map(entry => entry.id)), { requestId: "product_import_request_0001", name: "Imported analyst", takeover: true, deferSetup: true });
  await api.start(selection, signal);
  const saved = await waitFor(() => api.status(selection.requestId, signal), value => value?.status !== PartnerImportStatus.RUNNING, "the complete saved import", 45000);
  expect(saved, JSON.stringify({ checks: saved?.checks, profiles: fixture.application.partners?.listPartners().map(profile => ({ state: profile.initializationState, error: profile.initializationErrorCode })) })).toMatchObject({ saved: true, status: PartnerImportStatus.COMPLETE }); const taskId = saved!.canonicalSessionId!;
  const partner = (await clients.partner.getPartner({ partnerId: saved!.partnerId })).partner!;
  const home = fixture.application.store.getTarget(partner.homeTargetId).descriptor.workspaceRoot;
  const resources = fixture.application.piResources!.list({ targetId: partner.homeTargetId, kind: "skill" }); expect(resources[0]?.enabled).toBe(true);
  const generation = fixture.application.store.getSession(taskId).descriptor.binding.generation;
  const bridge = fixture.application.mcpRouter!.createPiBridgeSnapshot({ endpoint: `${fixture.application.config.internalOrigin}/internal/mcp`, sessionId: taskId,
    targetId: partner.homeTargetId, expectedPiGeneration: generation });
  expect(bridge.mcpBridge.tools.some(tool => tool.serverId === "joko_imported_connections" && tool.name === "setup_status")).toBe(true);
  const call = async (toolName: string, args: Record<string, unknown>) => {
    const response = await fetch(bridge.mcpBridge.endpoint, { method: "POST", headers: { authorization: `Bearer ${bridge.mcpBridge.token}`, "content-type": "application/json", "x-joko-pi-generation": String(generation) },
      body: JSON.stringify({ requestId: randomUUID(), sessionId: taskId, targetId: partner.homeTargetId, generation, serverId: "joko_imported_connections", toolName, arguments: args }) });
    expect(response.ok).toBe(true); const result = await response.json() as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(false); return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  };
  expect(await call("setup_status", {})).toMatchObject({ saved: true, status: "complete" });
  const identityId = preview.entries.find(entry => entry.category === PartnerImportCategory.PERSONALITY)!.id;
  const document = await call("read_document", { document_id: identityId }); expect(document.text).toContain("IDENTITY_END_MARKER"); expect(document.text).not.toContain(secret);
  const execution = await submit(clients.operation, paired.connectionId, sendInputMutation(taskId, BigInt(generation), "Review the full imported context. Do not run any command."));
  const runId = queueRunIdFrom(execution);
  await waitFor(async () => fixture!.application.store.getRun(runId).descriptor.state, value => ["completed", "failed", "aborted"].includes(value), "the published runtime", 45000);
  expect(fixture.application.store.getRun(runId).descriptor.state).toBe("completed");
  expect(JSON.stringify(fixture.providerRequests.map(request => request.body))).toContain("IDENTITY_END_MARKER"); expect(JSON.stringify(fixture.providerRequests)).not.toContain(secret);
  const catalog = await clients.partnerRoutine.listPartnerRoutines({ partnerId: partner.partnerId });
  const imported = catalog.routines.filter(routine => !routine.builtin); expect(imported).toHaveLength(1);
  const routine = imported[0]!; expect(routine.definition).toMatchObject({ name: "Review", prompt: "Review the retained import context.", enabled: false });
  const builtin = catalog.routines.filter(routine => routine.builtin === "follow-up"); expect(builtin).toHaveLength(1); expect(builtin[0]!.builtinVersion).toBe(1);
  await clients.partnerRoutine.runPartnerRoutine({ partnerId: partner.partnerId, expectedPartnerRevision: catalog.partnerRevision, routineId: routine.id, expectedRevision: routine.revision, requestId: "product_import_routine_run" });
  const history = await waitFor(() => clients.partnerRoutine.listPartnerRoutineRuns({ partnerId: partner.partnerId, routineId: routine.id }), value => value.runs[0]?.status === RoutineRunStatus.SUCCESS || value.runs[0]?.status === RoutineRunStatus.FAILED, "the imported routine", 45000);
  expect(history.runs[0]?.status).toBe(RoutineRunStatus.SUCCESS);
  expect((await readFile(join(root, "data", "orchestrator.db"))).includes(Buffer.from(secret))).toBe(false);
  await expect(fixture.anonymous.partnerImport.getPartnerImportStatus({ requestId: selection.requestId })).rejects.toMatchObject({ code: Code.Unauthenticated });
  const unselectedBody = "Authorization: <PLACEHOLDER>\nUNSELECTED_TEMPLATE_BODY";
  const unselected = await installLocalSkill(fixture, paired, "unselected-template", unselectedBody);
  const connections = await clients.partner.getPartnerConnections({ partnerId: partner.partnerId });
  expect(connections.connections?.entries.find(entry => entry.id === unselected.skill.skillId)).toMatchObject({ available: true });
  expect(connections.connections?.skills?.ids).not.toContain(unselected.skill.skillId);
  expect(JSON.stringify(connections, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value)).not.toContain("UNSELECTED_TEMPLATE_BODY");
  const beforeRestart = await clients.partnerRoutine.listPartnerRoutines({ partnerId: partner.partnerId });
  const port = Number(new URL(fixture.baseUrl).port); const internalPort = Number(new URL(fixture.application.config.internalOrigin).port);
  await fixture.close(); fixture = await RealPiSystemFixture.start({ rootDirectory: root, keepRoot: true, port, internalPort, enableInternalServer: true, agentImportSources: sources }); clients = fixture.clients(paired.authKey);
  expect((await clients.partnerImport.getPartnerImportStatus({ requestId: selection.requestId })).result).toEqual(saved);
  expect((await clients.partner.getPartner({ partnerId: partner.partnerId })).partner?.canonicalSessionId).toBe(taskId);
  const restoredCatalog = await clients.partnerRoutine.listPartnerRoutines({ partnerId: partner.partnerId });
  expect(restoredCatalog.routines).toEqual(beforeRestart.routines);
  expect(restoredCatalog.routines.filter(value => value.id === routine.id)).toHaveLength(1);
  expect(restoredCatalog.routines.find(value => value.id === routine.id)?.definition).toEqual(routine.definition);
  expect(restoredCatalog.routines.filter(value => value.builtin === "follow-up")).toEqual(builtin);
  expect((await clients.partnerRoutine.listPartnerRoutineRuns({ partnerId: partner.partnerId, routineId: routine.id })).runs[0]?.id).toBe(history.runs[0]?.id);
  expect(fixture.application.store.getTarget(partner.homeTargetId).descriptor.workspaceRoot).toBe(home);
  const restoredConnections = await clients.partner.getPartnerConnections({ partnerId: partner.partnerId });
  expect(restoredConnections.connections?.entries.find(entry => entry.id === unselected.skill.skillId)).toMatchObject({ available: true });
  const restoredGeneration = fixture.application.store.getSession(taskId).descriptor.binding.generation;
  const continued = await submit(clients.operation, paired.connectionId,
    sendInputMutation(taskId, BigInt(restoredGeneration), "Continue using the imported Partner's own instructions."));
  const continuedRun = queueRunIdFrom(continued);
  await waitFor(async () => fixture!.application.store.getRun(continuedRun).descriptor.state,
    value => ["completed", "failed", "aborted"].includes(value), "the restored Partner with an unselected template", 45000);
  expect(fixture.application.store.getRun(continuedRun).descriptor.state).toBe("completed");
  expect((await clients.session.listRuntimeCommands({ sessionId: taskId })).commands.some(command => command.resourceId === unselected.skill.skillId)).toBe(false);
  expect(JSON.stringify(fixture.providerRequests)).not.toContain("UNSELECTED_TEMPLATE_BODY");
  await clients.partner.deletePartner({ requestId: "product_import_delete_request", partnerId: partner.partnerId, expectedRevision: (await clients.partner.getPartner({ partnerId: partner.partnerId })).partner!.revision, confirmName: partner.displayName });
  const deletedImport = await fixture.application.partnerImports?.status(selection.requestId, { ownerKey: "service-check", assertCurrent() {} });
  expect(deletedImport?.status).toBe("needs-attention");
}, 150000);

it("activates the already installed engineer Partner after the Owner configures the directory default", async () => {
  fixture = await RealPiSystemFixture.start({ keepRoot: true, enableInternalServer: true });
  const { application } = fixture;
  const paired = await fixture.pair("Package Owner");
  let clients = paired.clients;
  const importApi = (rpc: typeof clients.partnerImport) => createPartnerImportApi({ rpc, ownerKey: paired.connectionId,
    controllerId: "partner-discovery", assertCurrent() {}, newRequestId: randomUUID });
  const signal = new AbortController().signal;
  const api = importApi(clients.partnerImport);
  expect((await clients.partner.getPartnerDirectory({})).directory?.defaultCapabilities).toBeUndefined();
  const entry = (await api.packages!("en", signal)).find(item => item.packageId === "engineer-bot")!;
  const admitted = await api.invitePackage!(entry, "en", signal);
  const saved = await application.partnerImports!.waitForRequest(admitted.requestId);
  expect(saved).toMatchObject({ saved: true, status: "complete" });
  expect(saved.canonicalSessionId).toBeUndefined();
  const pending = (await clients.partner.getPartner({ partnerId: saved.partnerId })).partner!;
  expect(pending).toMatchObject({ initializationState: PartnerInitializationState.ERROR, usesDirectoryDefaults: true,
    initializationErrorCode: PartnerInitializationErrorCode.MODEL_UNAVAILABLE });
  expect(application.store.listSessions({ targetId: pending.homeTargetId })).toHaveLength(0);
  const installedRoutine = application.partnerRoutines!.engine.list(pending.partnerId).find(routine => routine.builtin === undefined)!;
  expect(installedRoutine.enabled).toBe(false);

  const rootDirectory = fixture.rootDirectory;
  const port = Number(new URL(fixture.baseUrl).port);
  const internalPort = Number(new URL(application.config.internalOrigin).port);
  await fixture.close();
  fixture = await RealPiSystemFixture.start({ rootDirectory, port, internalPort, keepRoot: true, enableInternalServer: true });
  clients = fixture.clients(paired.authKey);
  const currentApi = importApi(clients.partnerImport);
  const directory = (await clients.partner.getPartnerDirectory({})).directory!;
  const capabilities = { modelChain: [{ backendId: "pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, fastMode: false }],
    permissionMode: PermissionMode.ASK, planMode: false, inputHandoff: true };
  const changed = await clients.partner.updatePartnerDefaults({ expectedDirectoryRevision: directory.revision, capabilities });
  const ready = changed.affectedPartners.find(partner => partner.partnerId === pending.partnerId)!;
  expect(ready).toMatchObject({ partnerId: pending.partnerId, homeTargetId: pending.homeTargetId, displayName: pending.displayName,
    initializationState: PartnerInitializationState.READY, usesDirectoryDefaults: true, canonicalSessionId: expect.any(String) });
  const sessionId = ready.canonicalSessionId!;
  expect(await currentApi.status(admitted.requestId, signal)).toMatchObject({ requestId: admitted.requestId,
    partnerId: pending.partnerId, canonicalSessionId: sessionId, saved: true, status: PartnerImportStatus.COMPLETE });
  expect(fixture.application.piResources!.list({ targetId: pending.homeTargetId, kind: "skill" })).toHaveLength(3);
  expect(fixture.application.store.listMakerMemoryEntries({ targetId: pending.homeTargetId, kind: "reference" })).toHaveLength(1);
  expect((await clients.partnerRoutine.listPartnerRoutines({ partnerId: pending.partnerId })).routines.find(routine => routine.id === installedRoutine.id)
    ?.definition?.enabled).toBe(false);
  const digest = createHash("sha256").update(JSON.stringify([sessionId, `package-welcome-${admitted.requestId}`])).digest("hex");
  const opening = fixture.application.store.findEvent(`import-message-${digest}`);
  expect(opening).toMatchObject({ sessionId, payload: { type: "message_complete", role: "assistant", blocks: [
    { kind: "text", text: expect.stringMatching(/\S/u) }
  ] } });

  await clients.partner.updatePartnerDefaults({ expectedDirectoryRevision: changed.directory!.revision, capabilities });
  expect(fixture.application.store.listSessions({ targetId: pending.homeTargetId }).map(item => item.descriptor.id)).toEqual([sessionId]);
  expect(fixture.application.store.listEvents({ sessionId }).filter(event => event.id === opening?.id)).toHaveLength(1);
  expect(await currentApi.invitePackage!(entry, "en", signal)).toMatchObject({ requestId: admitted.requestId, canonicalSessionId: sessionId });
}, 150000);

it("retries the failed installed skill and writes one opening to the original ready Partner task", async () => {
  fixture = await RealPiSystemFixture.start({ enableInternalServer: true });
  const { application } = fixture;
  const { clients, connectionId } = await fixture.pair("Package retry Owner");
  const directory = (await clients.partner.getPartnerDirectory({})).directory!;
  await clients.partner.updatePartnerDefaults({ expectedDirectoryRevision: directory.revision, capabilities: {
    modelChain: [{ backendId: "pi", providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, fastMode: false }],
    permissionMode: PermissionMode.ASK, planMode: false, inputHandoff: true
  } });
  const api = createPartnerImportApi({ rpc: clients.partnerImport, ownerKey: connectionId,
    controllerId: "partner-discovery", assertCurrent() {}, newRequestId: randomUUID });
  const signal = new AbortController().signal;
  const entry = (await api.packages!("en", signal)).find(item => item.packageId === "engineer-bot")!;
  const entryId = "skill-engineer-bot-ops";
  const slug = `engineer-bot-ops-${createHash("sha256").update(JSON.stringify(entryId)).digest("hex").slice(0, 16)}`;
  const homes = join(application.config.dataDirectory, "partner-homes");
  let failedDestination: string | undefined;
  const lstat = fs.lstat.bind(fs);
  // Fail the exact destination read once, before the original staging write.
  const denied = vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const [path] = args;
    if (typeof path === "string" && path.startsWith(homes + sep) && basename(path) === slug
      && dirname(path).endsWith(join(".agents", "skills")) && failedDestination === undefined) {
      failedDestination = path;
      throw Object.assign(new Error("Fixture skill destination is temporarily inaccessible."), { code: "EACCES" });
    }
    return lstat(...args);
  }) as typeof fs.lstat);
  let requestId: string;
  try {
    requestId = (await api.invitePackage!(entry, "en", signal)).requestId;
    await application.partnerImports!.waitForRequest(requestId);
  } finally { denied.mockRestore(); }
  expect(failedDestination).toBeDefined();
  await expect(fs.lstat(failedDestination!)).rejects.toMatchObject({ code: "ENOENT" });
  const failed = (await api.status(requestId, signal))!;
  const sessionId = failed.canonicalSessionId!;
  expect(failed).toMatchObject({ saved: true, status: PartnerImportStatus.NEEDS_ATTENTION, canonicalSessionId: expect.any(String) });
  expect(failed.checks.filter(check => check.status === PartnerImportCheckStatus.NEEDS_ATTENTION)).toMatchObject([
    { entryId, message: "IMPORT_PERMISSION_DENIED" }
  ]);
  expect(failed.savedEntryIds).not.toContain(entryId);
  const partner = (await clients.partner.getPartner({ partnerId: failed.partnerId })).partner!;
  expect(partner).toMatchObject({ initializationState: PartnerInitializationState.READY, canonicalSessionId: sessionId });
  const installed = () => application.piResources!.list({ targetId: partner.homeTargetId, kind: "skill" });
  const otherSkills = installed().map(resource => resource.id);
  expect(otherSkills).toHaveLength(2);
  const routines = () => clients.partnerRoutine.listPartnerRoutines({ partnerId: partner.partnerId });
  const earlier = (await routines()).routines.find(routine => !routine.builtin)!;
  expect(earlier.definition?.enabled).toBe(false);
  const welcomeId = `import-message-${createHash("sha256").update(JSON.stringify([sessionId, `package-welcome-${requestId}`])).digest("hex")}`;
  expect(application.store.findEvent(welcomeId)).toBeUndefined();

  expect(await api.invitePackage!(entry, "en", signal)).toMatchObject({ requestId });
  await application.partnerImports!.waitForRequest(requestId);
  const recovered = (await api.status(requestId, signal))!;
  expect(recovered).toMatchObject({ partnerId: failed.partnerId, canonicalSessionId: sessionId, status: PartnerImportStatus.COMPLETE });
  expect(recovered.checks.filter(check => check.entryId === entryId)).toMatchObject([{ status: PartnerImportCheckStatus.COPIED }]);
  expect(recovered.savedEntryIds.filter(id => id === entryId)).toEqual([entryId]);
  expect(installed().map(resource => resource.id)).toEqual(expect.arrayContaining(otherSkills));
  expect(installed()).toHaveLength(3);
  const resourceId = `imported_skill_${createHash("sha256").update(JSON.stringify([partner.partnerId, entryId])).digest("hex").slice(0, 40)}`;
  expect(installed().find(resource => resource.id === resourceId)).toMatchObject({ enabled: true });
  expect((await routines()).routines.find(routine => routine.id === earlier.id)?.definition?.enabled).toBe(false);
  expect(application.store.findEvent(welcomeId)).toMatchObject({ sessionId,
    payload: { type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: expect.stringMatching(/\S/u) }] } });
  expect(await api.invitePackage!(entry, "en", signal)).toEqual(recovered);
  expect(application.store.listEvents({ sessionId }).filter(event => event.id === welcomeId)).toHaveLength(1);
}, 150000);
