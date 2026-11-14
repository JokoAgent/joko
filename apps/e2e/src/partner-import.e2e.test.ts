import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { Code } from "@connectrpc/connect";
import { afterEach, expect, it, vi } from "vitest";
import { createPartnerImportApi, importSelectionInput, PartnerImportCategory, PartnerImportCheckStatus, PartnerImportStatus, PartnerInitializationErrorCode,
  PartnerInitializationState, PermissionMode, RoutineRunStatus } from "@joko/contracts";
import { RealPiSystemFixture, REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID } from "./real-pi-fixture.js";
import { waitFor } from "./fixture.js";
import { queueRunIdFrom, sendInputMutation, submit } from "./operations.js";
import { installLocalSkill } from "./skill-system-fixture.js";

let fixture: RealPiSystemFixture | undefined;
afterEach(async () => { await fixture?.close({ removeRoot: true }); fixture = undefined; });
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
