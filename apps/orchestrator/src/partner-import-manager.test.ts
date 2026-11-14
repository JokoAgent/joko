import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport, type HandlerContext } from "@connectrpc/connect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationalStore, PartnerStore, PartnerRoutineStore, partnerHomeDirectoryName } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { createPartnerImportApi, PartnerImportService, PartnerImportCategory, PartnerImportCheckStatus, PartnerImportEditor, PartnerImportReceipts,
  PartnerImportStatus, StartPartnerImportRequestSchema, GetPartnerImportStatusRequestSchema,
  DeletePartnerMemoryRequestSchema, DeletePartnerSkillRequestSchema, UpdatePartnerMemoryRequestSchema, UpdatePartnerSkillRequestSchema,
  PermissionRisk, PolicyEffect, PolicySettingsSchema, PolicySubjectKind } from "@joko/contracts";
import { readImportTree, createImportBudget, prepareImportedAutomation } from "@joko/agent-import";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { CredentialVault } from "./credential-vault.js";
import { MakerMemoryController } from "./maker-memory.js";
import { PiResourceManager } from "./resource-manager.js";
import { PartnerManager } from "./partner-manager.js";
import { PartnerRoutineManager } from "./partner-routine-manager.js";
import { PartnerImportManager } from "./partner-import-manager.js";
import { PartnerImportRuntime } from "./partner-import-runtime.js";
import { PartnerImportStorage } from "./partner-import-storage.js";
import { adoptPartnerImportSettings, createPartnerImportEffects, importedPartnerId, preparePartnerImportCreation } from "./partner-import-effects.js";
import { createPartnerImportConnectService } from "./partner-import-connect-service.js";
import { ScheduleCoordinator } from "./schedule-coordinator.js";
import { SessionHost } from "./session-host.js";
import { PartnerMemoryManager } from "./partner-memory.js";
import { PartnerSkillsManager } from "./partner-skills.js";
import { SkillMutationCoordinator } from "./skill-mutation-coordinator.js";

const secret = "fixture-import-secret-abcdef012345"; const cleanups: Array<() => Promise<void>> = [];
const backendProfile = { ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities.map(capability => capability.key === "permission.modes"
  ? { ...capability, options: ["ask", "auto", "bypassPermissions"] } : capability), { key: "permission.change", supported: true },
  { key: "runtime.resources", supported: true, options: ["skill", "prompt"] }] };
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { changeDefaults?: boolean; nativeTools?: boolean; resourceFiles?: number; noDefaults?: boolean; observeImport?: (phase: string) => void; currentCanonicalSession?: () => string | undefined; probePlan?: string; planMode?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "joko-import-owner-")); const native = join(root, ".hermes");
  await mkdir(join(native, "skills", "reports"), { recursive: true }); await mkdir(join(native, "memories")); await mkdir(join(native, "cron"));
  await writeFile(join(native, "config.yaml"), "name: Analyst\n" + (options.nativeTools ? "tools:\n  allowed: [read]\n" : "")); await writeFile(join(native, ".env"), `ACCESS_TOKEN=${secret}\n`);
  await writeFile(join(native, "SOUL.md"), `Identity ${secret}\n` + "Complete identity.\n".repeat(1200));
  for (let i = 0; i < 25; i++) await writeFile(join(native, "memories", `notes-${i}.md`), `Memory ${i} ${secret}\n` + (i === 0 ? "Retained original.\n".repeat(1000) : "healthy"));
  await writeFile(join(native, "memories", "image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
  const manifest = `---\nname: Reports\ndescription: Read reports\n---\nCredential ${secret}\n` + "Full native skill instruction.\n".repeat(14000);
  await writeFile(join(native, "skills", "reports", "SKILL.md"), manifest);
  await writeFile(join(native, "skills", "reports", "query.py"), "print('report')\n");
  await writeFile(join(native, "skills", "reports", "resource.txt"), `Resource ${secret}`);
  await writeFile(join(native, "cron", "jobs.json"), JSON.stringify([{ id: "weekly", name: "Weekly", prompt: "Review memories", enabled: false, schedule: { kind: "cron", expr: "0 9 * * 1" } }]));
  const store = new OperationalStore(join(root, "operational.db")); const profiles = new PartnerStore(join(root, "partners.db"));
  const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] }); await artifacts.initialize();
  const adapter = new FakeBackendAdapter(backendProfile); const host = new SessionHost(store, artifacts, [adapter], {
    partnerSessionRetiring: id => profiles.isPartnerSessionRetiring(id) || profiles.isPartnerTargetRetiring(store.getSession(id).descriptor.targetId),
    partnerTargetRetired: id => profiles.isPartnerTargetRetired(id),
    partnerSessionPaused: id => profiles.isPartnerSessionPaused(id), partnerSessionRestarting: id => profiles.isPartnerSessionRestarting(id) }); await host.initialize();
  const vault = await CredentialVault.open(join(root, "credentials", "master.key")); const storage = new PartnerImportStorage(store, vault, root);
  const resources = new PiResourceManager({ store, managedRoot: join(root, "resources"), maximumFiles: options.resourceFiles ?? 2 }); await resources.initialize();
  const memory = new MakerMemoryController({ store }); const scheduler = new ScheduleCoordinator(store, host);
  let imports: PartnerImportManager; let routines: PartnerRoutineManager;
  const partners = new PartnerManager({ store: profiles, operationalStore: store, sessionHost: host, homesRoot: join(root, "homes"),
    workspaceService: { register: async input => input, unregister: () => undefined },
    onRoutineLifecycle: (id, lifecycle) => routines.lifecycle(id, lifecycle), prepareImportDeletion: id => imports.prepareDeletion(id), onReady: async id => { await imports?.activatePackage(id); } });
  routines = new PartnerRoutineManager({ partners, store, scheduler, storage: new PartnerRoutineStore(join(root, "routines")) }); await routines.start();
  if (!options.noDefaults) profiles.setDirectoryDefaults(profiles.directoryState().revision, { modelChain: [{ backendId: PI_LIKE_PROFILE.id, providerId: "test", modelId: "text", effort: "medium", fastMode: false }], permissionMode: options.probePlan === undefined ? "ask" : "bypassPermissions", planMode: options.planMode ?? false });
  const makeRuntime = (importStorage: PartnerImportStorage) => new PartnerImportRuntime({
    partners, store, host, routines, storage: importStorage, imports,
    assertServiceOwner: () => {}, auxiliary: { capture: () => ({ models: [], revision: 0n, runtimeRevision: "fixture" }),
      run: async () => ({ status: "ok", text: options.probePlan! }) }
  });
  const makeImportManager = (importStorage: PartnerImportStorage) => new PartnerImportManager({ storage: importStorage, home: root, environment: {}, assertServiceOwner: () => {},
    getPartner: id => partners.getPartner(id),
    ...(options.currentCanonicalSession ? { currentCanonicalSession: options.currentCanonicalSession } : {}),
    nativeRuntimeReady: id => partners.getPartner(id).initializationState === "ready",
    prepareCreation: (selection, nativePackage) => {
    const frozen = preparePartnerImportCreation(partners, selection, nativePackage);
    if (options.changeDefaults) profiles.setDirectoryDefaults(profiles.directoryState().revision, { ...profiles.directoryState().defaultCapabilities!, permissionMode: "auto" });
    return frozen;
  },
    adoptSettings: (id, assertOwner) => adoptPartnerImportSettings(partners, store, storage, id, assertOwner),
    runPass: (id, action) => partners.runImportManagement(id, options.observeImport ? observedImportEffect("pass", action, options.observeImport) : action), effects: context => {
      options.observeImport?.("effects-start");
      const runtime = options.probePlan === undefined ? undefined : makeRuntime(importStorage);
      const pendingEffects = createPartnerImportEffects({ partners, routines, storage: importStorage, store, memory, resources, artifacts,
      verification: runtime?.verification ?? { readEnvironment: (id, owner) => importStorage.environment.read(id, owner), canonicalSessionId: async id => partners.getPartner(id).canonicalSessionId!,
        plan: async () => undefined, authorize: async () => { throw new Error("No external probe is authorized by this fixture"); }, verifyDelivery: async () => { throw new Error("No channel is authorized by this fixture"); } }, home: root, environment: {} }, context);
      if (!options.observeImport) return pendingEffects;
      const observe = options.observeImport;
      return pendingEffects.then(effects => {
        observe("effects-ready");
        return { ...effects,
        validateItems: observedImportEffect("validate", effects.validateItems, observe),
        createPartner: observedImportEffect("create-partner", effects.createPartner, observe),
        importItem: observedImportEffect("import-item", effects.importItem, observe),
        saveEnvironment: observedImportEffect("save-environment", effects.saveEnvironment, observe),
        createConversation: observedImportEffect("create-conversation", effects.createConversation, observe),
        createRoutine: observedImportEffect("create-routine", effects.createRoutine, observe),
        verifyAutomation: observedImportEffect("verify-automation", effects.verifyAutomation, observe),
        pauseSource: observedImportEffect("pause-source", effects.pauseSource, observe),
        resumeSource: observedImportEffect("resume-source", effects.resumeSource, observe),
        enableRoutine: observedImportEffect("enable-routine", effects.enableRoutine, observe)
        };
      });
    } });
  imports = makeImportManager(storage);
  if (options.planMode !== undefined) routines.setImportedRuntime(makeRuntime(storage));
  let authenticated = "device-a";
  const context = (): HandlerContext => ({ signal: new AbortController().signal } as HandlerContext);
  const authenticate = () => { if (!authenticated) throw new ConnectError("Revoked", Code.Unauthenticated); return { id: authenticated }; };
  const service = createPartnerImportConnectService(imports, authenticate);
  const connect = (server: typeof service) => createPartnerImportApi({
    ownerKey: "device-a:sheet", controllerId: "sheet", assertCurrent: () => {}, newRequestId: () => "owner_import_request_0001",
    rpc: createClient(PartnerImportService, createRouterTransport(router => { router.service(PartnerImportService, server); }))
  });
  const api = connect(service);
  const reopenImports = async () => {
    await imports.close();
    const reopened = new PartnerImportStorage(store, await CredentialVault.open(join(root, "credentials", "master.key")), root);
    imports = makeImportManager(reopened);
    return { manager: imports, storage: reopened, api: connect(createPartnerImportConnectService(imports, authenticate)) };
  };
  cleanups.push(async () => { await imports.close(); await routines.stop(); await scheduler.stop(); await host.dispose(); memory.dispose(); profiles.close(); store.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("joko-import-owner-")) throw new Error("Unsafe fixture cleanup"); await rm(root, { recursive: true, force: true }); });
  return { root, native, store, profiles, artifacts, host, storage, resources, memory, partners, routines, imports, service, api, context, manifest, reopenImports,
    authenticate: (value: string) => { authenticated = value; } };
}

function observedImportEffect<Args extends unknown[], Result>(phase: string, action: (...args: Args) => Promise<Result>, observe: (phase: string) => void) {
  return (...args: Args): Promise<Result> => {
    observe(`${phase}-start`);
    const result = action(...args);
    // Observe the existing promise; return it unchanged so the fixture does not
    // replace the import's value, rejection or await boundary.
    void result.then(() => observe(`${phase}-complete`), () => observe(`${phase}-failed`));
    return result;
  };
}
describe("native import service and owning effects", () => {
  it.skipIf(process.platform !== "win32")("runs an imported command with a quoted executable path and arguments on Windows", async () => {
    const f = await fixture();
    const signal = new AbortController().signal;
    const preview = await f.api.preview((await f.api.sources(signal))[0]!.id, signal);
    const selection = { previewId: preview.id, requestId: "owner_import_windows_cmd_0001", name: "Windows command fixture",
      entryIds: preview.entries.filter(entry => entry.category === PartnerImportCategory.PERSONALITY).map(entry => entry.id), takeover: false, deferSetup: true };
    await f.api.start(selection, signal);
    const saved = await f.imports.waitForRequest(selection.requestId);
    const task = f.store.getSession(saved.canonicalSessionId!).descriptor;
    const executable = join(f.store.getTarget(task.targetId).descriptor.workspaceRoot, "Node With Spaces.exe");
    await copyFile(process.execPath, executable);
    const runtime = new PartnerImportRuntime({ partners: f.partners, store: f.store, host: f.host,
      routines: f.routines, storage: f.storage, imports: f.imports, assertServiceOwner: () => {},
      auxiliary: { capture: () => ({ models: [], revision: 0n, runtimeRevision: "fixture" }), run: async () => ({ status: "ok", text: "" }) } });
    const result = await runtime.callTool("run_command", {
      command: `"${executable}" -e "process.stdout.write(process.argv[1])" "quoted argument"`, timeout_ms: 10_000
    }, signal, { sessionId: task.id, targetId: task.targetId, generation: task.binding.generation });
    expect(result).toEqual({ isError: false, content: [{ type: "text", text: JSON.stringify({ exitCode: 0, stdout: "quoted argument" }) }] });
  }, 20_000);

  it("releases a definitively rejected name and retries the same preview with a new request", async () => {
    const f = await fixture();
    const signal = new AbortController().signal;
    const firstId = "owner_import_contested_0001", secondId = "owner_import_contested_0002";
    const api = { ...f.api, newRequestId: vi.fn().mockReturnValueOnce(firstId).mockReturnValueOnce(secondId), start: vi.fn(f.api.start) };
    const local = new Map<string, string>();
    const receipts = new PartnerImportReceipts({ getItem: key => local.get(key) ?? null,
      setItem: (key, value) => { local.set(key, value); }, removeItem: key => { local.delete(key); } }, "import-owner");
    const editor = new PartnerImportEditor(api, receipts);
    await editor.load();
    await editor.choose(editor.state.sources![0]!.id);
    const preview = editor.state.preview!;
    editor.select(preview.entries.filter(entry => entry.category !== PartnerImportCategory.PERSONALITY).map(entry => entry.id), false);
    editor.edit({ name: "Contested partner" });
    const selected = [...editor.state.selected];
    const createImported = f.partners.createImportedPartner.bind(f.partners);
    vi.spyOn(f.partners, "createImportedPartner").mockImplementationOnce(async input => {
      expect((await f.storage.environment.read(input.id!, () => {}))?.pendingImport?.selection.requestId).toBe(firstId);
      await f.partners.createPartner({ ...input, id: "competing-partner", requestId: "competing_partner_create_0001",
        expectedDirectoryRevision: f.profiles.directoryState().revision });
      return createImported(input);
    });

    await editor.start();
    expect(editor.state).toMatchObject({ error: "IMPORT_NAME_EXISTS", preview, name: "Contested partner" });
    expect(editor.locked).toBe(false);
    expect([...editor.state.selected]).toEqual(selected);
    await expect(receipts.read()).resolves.toBeUndefined();
    const rejected = f.storage.readReceipt(firstId)!;
    expect(rejected).toMatchObject({ creationRejected: "IMPORT_NAME_EXISTS", checkpointCleared: true, partnerCreated: false });
    expect(() => f.partners.getPartner(rejected.result.partnerId)).toThrow();
    expect(f.partners.getPartner("competing-partner").displayName).toBe("Contested partner");
    await expect(f.storage.environment.read(rejected.result.partnerId, () => {})).resolves.toBeUndefined();
    expect(await f.api.retry(firstId, false, signal)).toMatchObject({ requestId: firstId, saved: false,
      checks: expect.arrayContaining([expect.objectContaining({
        entryId: "creation", status: PartnerImportCheckStatus.NEEDS_ATTENTION, message: "IMPORT_NAME_EXISTS"
      })]) });
    await expect(f.api.start({ ...api.start.mock.calls[0]![0]!, name: "Changed on the same request" }, signal)).rejects.toThrow("REQUEST_ALREADY_USED");

    await receipts.claim(firstId);
    const reopened = new PartnerImportEditor(f.api, receipts);
    await reopened.load();
    expect(reopened.locked).toBe(false);
    expect(reopened.state.error).toBe("IMPORT_NAME_EXISTS");
    expect(reopened.state.sources?.length).toBeGreaterThan(0);
    reopened.dispose();

    editor.edit({ name: "Renamed import" });
    await editor.start();
    const accepted = await f.imports.waitForRequest(secondId);
    expect(accepted.saved).toBe(true);
    expect(f.partners.getPartner(accepted.partnerId).displayName).toBe("Renamed import");
    expect(api.start.mock.calls.map(([input]) => input?.requestId)).toEqual([firstId, secondId]);
    editor.dispose();
  });

  it.each(["global deny", "exact deny", "revoked during handshake", "revoked before response"] as const)(
    "keeps the imported routine paused when a probe is %s", async (mode) => {
      const connection = "records__fixture", tool = "read_records";
      const f = await fixture({ probePlan: JSON.stringify({ reads: [{ kind: "mcp", connection, tool, arguments: { account: "fixture" }, pointer: "/records", array: true }] }) });
      let initializes = 0, toolCalls = 0, waiting = false;
      let releaseResponse!: () => void;
      const held = new Promise<void>((resolveResponse) => { releaseResponse = resolveResponse; });
      const server = createServer((request, response) => {
        if (request.method !== "POST") { response.writeHead(405).end(); return; }
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => void (async () => {
          const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method: string; params?: { protocolVersion?: string } };
          if (message.id === undefined) { response.writeHead(202).end(); return; }
          let result: unknown;
          if (message.method === "initialize") {
            initializes += 1;
            if (initializes === 2 && mode === "revoked during handshake") { waiting = true; await held; }
            result = { protocolVersion: message.params?.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } };
          } else if (message.method === "tools/list") {
            result = { tools: [{ name: tool, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }] };
          } else if (message.method === "tools/call") {
            toolCalls += 1;
            if (mode === "revoked before response") { waiting = true; await held; }
            result = { content: [], structuredContent: { records: ["fixture result"] } };
          }
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        })().catch(() => response.destroy()));
      });
      await new Promise<void>((listen) => server.listen(0, "127.0.0.1", listen));
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("No fixture server address.");
        await writeFile(join(f.native, "config.yaml"), `name: Analyst\nmcp_servers:\n  ${connection}:\n    url: http://127.0.0.1:${address.port}/mcp\n`);
        const sourceRoutine = join(f.native, "cron", "jobs.json");
        const original = JSON.stringify([{ id: "weekly", name: "Weekly", prompt: `Use ${connection}`, enabled: true, schedule: { kind: "cron", expr: "0 9 * * 1" } }]);
        await writeFile(sourceRoutine, original);
        const signal = new AbortController().signal;
        const preview = await f.api.preview((await f.api.sources(signal))[0]!.id, signal);
        const selected = preview.entries.filter((entry) => entry.name === connection || entry.category === PartnerImportCategory.AUTOMATIONS);
        expect(selected).toHaveLength(2);
        const selection = { previewId: preview.id, requestId: "owner_import_probe_0001", name: "Probe fixture", entryIds: selected.map((entry) => entry.id), takeover: true, deferSetup: true };
        await f.api.start(selection, signal);
        const saved = await f.imports.waitForRequest(selection.requestId);
        expect(saved.checks).toContainEqual(expect.objectContaining({ message: "IMPORT_SETUP_DEFERRED" }));
        const deny = () => f.store.setSetting("service", "orchestrator", "settings.policy", create(PolicySettingsSchema, {
          rules: [{ policyRuleId: "deny-import-probe", subjectKind: PolicySubjectKind.MCP, effect: PolicyEffect.DENY,
            ceiling: PermissionRisk.CRITICAL, enabled: true, ...(mode === "global deny" ? {} : { toolProviderId: connection, toolName: tool }) }]
        }));
        if (mode === "global deny" || mode === "exact deny") deny();
        await f.api.retry(selection.requestId, true, signal);
        if (mode === "revoked during handshake" || mode === "revoked before response") {
          await vi.waitFor(() => expect(waiting).toBe(true), { timeout: 5_000 });
          deny(); releaseResponse();
        }
        const result = await f.imports.waitForRequest(selection.requestId);
        expect(result.checks).toContainEqual(expect.objectContaining({ status: "needs-attention", message: "AUTOMATION_DATA_READ_FAILED" }));
        expect(initializes).toBe(mode === "global deny" || mode === "exact deny" ? 1 : 2);
        expect(toolCalls).toBe(mode === "revoked before response" ? 1 : 0);
        await expect(readFile(sourceRoutine, "utf8")).resolves.toBe(original);
      } finally {
        releaseResponse(); server.closeAllConnections();
        await new Promise<void>((closed) => server.close(() => closed()));
      }
    }, 20_000);

  it("masks native Discord credentials in imported knowledge even when connection entries were omitted", async () => {
    const f = await fixture({ resourceFiles: 20 });
    const root = join(f.root, ".openclaw"), workspace = join(root, "workspace");
    const direct = "fixture-discord-channel-credential-abcdef", override = "fixture-discord-account-credential-123456";
    const referenced = "fixture-discord-env-credential-987654", publicNote = "Public Discord label fixture";
    await mkdir(join(workspace, "skills", "records"), { recursive: true });
    await writeFile(join(root, "openclaw.json"), JSON.stringify({
      agents: { entries: [{ id: "main", default: true, name: `Analyst ${direct}` }, { id: "other" }] },
      channels: { discord: { token: direct, accounts: { inherited: {}, separate: { token: override },
        environment: { token: { source: "env", id: "BOT_NAME" } } }, metadata: { token: publicNote } } },
      bindings: [{ agentId: "other", match: { channel: "discord", accountId: "separate" } }]
    }));
    await writeFile(join(root, ".env"), `BOT_NAME=${referenced}\n`);
    await writeFile(join(workspace, "SOUL.md"), `Analyst notes. ${direct} ${publicNote}`);
    await writeFile(join(workspace, "MEMORY.md"), `Retained records. ${override} ${referenced} ${publicNote}`);
    await writeFile(join(workspace, "skills", "records", "SKILL.md"), `---\nname: Records\ndescription: Verify ${referenced}\n---\nUse records. ${direct} ${override} ${publicNote}\n`);
    const writeMemory = f.memory.write.bind(f.memory);
    let failMemory = true;
    vi.spyOn(f.memory, "write").mockImplementation((target, input) => {
      if (failMemory && input.body.includes("Retained records.")) throw new Error("Fixture memory unavailable.");
      return writeMemory(target, input);
    });
    const signal = new AbortController().signal;
    const source = (await f.api.sources(signal)).find((entry) => entry.name.startsWith("Analyst ["))!;
    const preview = await f.api.preview(source.id, signal);
    expect(preview.name).not.toContain(direct);
    const skillEntry = preview.entries.find((entry) => entry.category === PartnerImportCategory.SKILLS);
    expect(skillEntry?.description).toContain("Verify");
    expect(skillEntry?.description).not.toContain(referenced);
    const selection = { previewId: preview.id, requestId: "owner_import_discord_0001", name: "Redaction fixture",
      entryIds: preview.entries.filter((entry) => entry.category !== PartnerImportCategory.CONNECTIONS).map((entry) => entry.id), takeover: false, deferSetup: true };
    await f.api.start(selection, signal);
    const saved = await f.imports.waitForRequest(selection.requestId);
    expect(saved.checks).toContainEqual(expect.objectContaining({ status: "needs-attention", message: "MEMORY_WRITE_FAILED" }));
    const partner = f.partners.getPartner(saved.partnerId);
    const skill = f.resources.listPartnerSkills(partner.id, partner.homeTargetId)[0]!;
    const skillOwner = new PartnerSkillsManager(f.partners, f.profiles, f.store, f.resources, new SkillMutationCoordinator());
    const published = await skillOwner.read(partner.id, skill.resource.id, signal);
    expect(partner.identitySource).toContain(publicNote);
    expect(published.skill.body).toContain(publicNote);
    const publication = JSON.stringify([preview, partner.identitySource, published.skill], (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value);
    for (const token of [direct, override, referenced]) expect(publication).not.toContain(token);

    // Simulate a retained checkpoint created before source credential masking.
    await f.storage.environment.update(partner.id, () => {}, (environment) => {
      const pending = environment.pendingImport!;
      const snapshot = JSON.parse(pending.snapshotJson) as Record<string, unknown>;
      delete snapshot.publicationRedactions;
      pending.snapshotJson = JSON.stringify(snapshot);
      environment.contentRedactions = {};
    });
    failMemory = false;
    await f.api.retry(selection.requestId, false, signal);
    expect((await f.imports.waitForRequest(selection.requestId)).status).toBe("complete");
    const body = f.memory.list(partner.homeTargetId).find((entry) => entry.body.includes("Retained records."))!.body;
    expect(body).toContain(publicNote);
    expect(body).not.toContain(override);
    expect(body).not.toContain(referenced);
  }, 20_000);

  it("retries failed package knowledge without replaying edited, removed or disabled Skills", async () => {
    const f = await fixture({ resourceFiles: 20 });
    const signal = new AbortController().signal;
    await f.memory.update({ makerEnabled: false });
    const entry = (await f.api.packages!("en", signal)).find(row => row.packageId === "engineer-bot")!;
    const admitted = await f.api.invitePackage!(entry, "en", signal);
    const partial = await f.imports.waitForRequest(admitted.requestId);
    expect(partial).toMatchObject({ saved: true, status: "needs-attention", canonicalSessionId: expect.any(String) });
    const partner = f.partners.getPartner(partial.partnerId);
    const manager = new PartnerSkillsManager(f.partners, f.profiles, f.store, f.resources, new SkillMutationCoordinator());
    const published = f.resources.listPartnerSkills(partner.id, partner.homeTargetId);
    expect(published).toHaveLength(3);
    const edited = published.find(item => item.slug.startsWith("engineer-bot-ops-"))!;
    const [deleted, disabled] = published.filter(item => item !== edited);
    await f.memory.update({ makerEnabled: true });

    const priorEdit = await manager.read(partner.id, edited.resource.id, signal);
    const editedBody = "Keep the owner's revised instructions.";
    await manager.update(create(UpdatePartnerSkillRequestSchema, {
      partnerId: partner.id, skillId: edited.resource.id, expectedPartnerRevision: priorEdit.owner.revision,
      expectedRevision: priorEdit.skill.summary!.revision, expectedContentRevision: priorEdit.skill.summary!.contentRevision,
      name: priorEdit.skill.summary!.name, description: priorEdit.skill.summary!.description, body: editedBody
    }), signal);
    const priorDelete = await manager.read(partner.id, deleted!.resource.id, signal);
    await manager.remove(create(DeletePartnerSkillRequestSchema, {
      partnerId: partner.id, skillId: deleted!.resource.id, expectedPartnerRevision: priorDelete.owner.revision,
      expectedRevision: priorDelete.skill.summary!.revision, expectedContentRevision: priorDelete.skill.summary!.contentRevision
    }), signal);
    await f.resources.setEnabled(disabled!.resource.id, false);

    await f.api.retry(partial.requestId, false, signal);
    const complete = await f.imports.waitForRequest(partial.requestId);
    expect(complete).toMatchObject({ saved: true, status: "complete", canonicalSessionId: partial.canonicalSessionId });
    expect(complete.checks.some(check => check.status === "needs-attention")).toBe(false);
    expect(f.storage.readReceipt(partial.requestId)?.checkpointCleared).toBe(true);
    expect((await manager.read(partner.id, edited.resource.id, signal)).skill.body).toBe(editedBody);
    expect(f.resources.get(deleted!.resource.id).state).toBe("removed");
    const home = f.store.getTarget(partner.homeTargetId).descriptor.workspaceRoot;
    await expect(readFile(join(home, deleted!.relativeFilePath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.resources.get(disabled!.resource.id)).toMatchObject({ state: "disabled", enabled: false });
    expect(f.memory.list(partner.homeTargetId).filter(item => item.kind === "reference")).toHaveLength(1);
  }, 20_000);

  it.each(["edit", "delete"] as const)("finishes a failed package routine after the owner chooses to %s completed knowledge", async action => {
    const f = await fixture({ resourceFiles: 20 });
    const signal = new AbortController().signal;
    const install = vi.spyOn(f.routines, "installPackage").mockRejectedValueOnce(new Error("Fixture routine write failed"));
    const entry = (await f.api.packages!("en", signal)).find(row => row.packageId === "engineer-bot")!;
    const admitted = await f.api.invitePackage!(entry, "en", signal);
    const partial = await f.imports.waitForRequest(admitted.requestId);
    expect(partial).toMatchObject({ saved: true, status: "needs-attention", canonicalSessionId: expect.any(String) });
    const partner = f.partners.getPartner(partial.partnerId);
    expect(f.routines.list(partner.id)).toEqual([]);
    const memory = f.memory.list(partner.homeTargetId).find(item => item.kind === "reference")!;
    const manager = new PartnerMemoryManager(f.partners, f.store, f.memory);
    const source = { partnerId: partner.id, entryId: memory.id, expectedPartnerRevision: { value: partner.revision }, expectedRevision: { value: memory.revision } };
    const editedBody = "Keep the owner's revised method.";
    if (action === "delete") manager.remove(create(DeletePartnerMemoryRequestSchema, source));
    else manager.update(create(UpdatePartnerMemoryRequestSchema, { ...source, title: memory.title, body: editedBody }));

    await f.api.retry(partial.requestId, false, signal);
    const complete = await f.imports.waitForRequest(partial.requestId);
    expect(complete.status).toBe("complete");
    expect(complete.savedEntryIds).toContain("routine-pr-watch");
    expect(f.storage.readReceipt(partial.requestId)?.checkpointCleared).toBe(true);
    expect(f.routines.list(partner.id)).toMatchObject([{ enabled: false }]);
    expect(install).toHaveBeenCalledTimes(2);
    expect(install.mock.calls[1]?.[2]).toBe(install.mock.calls[0]?.[2]);
    expect(f.memory.list(partner.homeTargetId).filter(item => item.kind === "reference")).toMatchObject(
      action === "delete" ? [] : [{ id: memory.id, body: editedBody }]
    );
  }, 20_000);

  it.each([false, true])("projects a saved package after model selection with a legacy null binding of %s", async (legacy) => {
    const f = await fixture({ resourceFiles: 20, noDefaults: true }); const signal = new AbortController().signal;
    const entry = (await f.api.packages!("en", signal)).find(row => row.packageId === "engineer-bot")!;
    const admitted = await f.api.invitePackage!(entry, "en", signal);
    const saved = await f.imports.waitForRequest(admitted.requestId);
    expect(saved).toMatchObject({ saved: true, status: "complete" }); expect(saved.canonicalSessionId).toBeUndefined();
    const pending = f.partners.getPartner(saved.partnerId);
    expect(pending).toMatchObject({ initializationState: "error", initializationErrorCode: "model_unavailable", capabilities: { modelChain: [] } });
    expect(pending.identitySource).toContain("Joko");
    const home = join(f.root, "homes", partnerHomeDirectoryName(pending.id));
    expect((await readFile(join(home, "IDENTITY.md"), "utf8"))).toContain("Joko");
    const files = await readImportTree(join(home, ".agents", "skills"), () => true, createImportBudget());
    expect(files.filter(file => file.name.endsWith("/SKILL.md"))).toHaveLength(3);
    expect(f.routines.engine.list(pending.id)).toHaveLength(1); expect(f.routines.engine.list(pending.id)[0]!.enabled).toBe(false);
    expect(f.resources.list({ targetId: pending.homeTargetId })).toHaveLength(0);
    expect(f.store.listSessions({ targetId: pending.homeTargetId })).toHaveLength(0);
    expect(f.storage.readReceipt(saved.requestId)?.checkpointCleared).toBe(false);
    if (legacy) {
      const receipt = f.storage.readReceipt(saved.requestId)!;
      receipt.result.canonicalSessionId = undefined;
      f.storage.saveReceipt(receipt);
    }
    expect(f.storage.readReceipt(saved.requestId)?.result.canonicalSessionId).toBeUndefined();
    await expect(f.partners.createPartner({ requestId: "manual_empty_model_request", expectedDirectoryRevision: f.partners.directory().state.revision,
      displayName: "Manual", templateId: "general", avatar: "orbit", identitySource: "Manual identity", usesDirectoryDefaults: false,
      capabilities: { modelChain: [], permissionMode: "ask", planMode: false } })).rejects.toMatchObject({ code: "PARTNER_INVALID" });
    await f.imports.recover();
    expect((await f.api.invitePackage!(entry, "zh-CN", signal)).requestId).toBe(saved.requestId);
    const ready = await f.partners.updatePartner(pending.id, pending.revision, { capabilities: { modelChain: [{ backendId: PI_LIKE_PROFILE.id,
      providerId: "test", modelId: "text", effort: "medium", fastMode: false }], permissionMode: "ask", planMode: false } });
    expect(ready.initializationState).toBe("ready"); expect(ready.canonicalSessionId).toBeDefined();
    expect(f.resources.list({ targetId: ready.homeTargetId })).toHaveLength(3);
    expect(f.memory.list(ready.homeTargetId).filter(item => item.kind === "reference")).toHaveLength(1);
    expect(f.routines.engine.list(ready.id)[0]!.enabled).toBe(false);
    const receipt = f.storage.readReceipt(saved.requestId)!;
    expect(receipt.result).toMatchObject({ saved: true, status: "complete", canonicalSessionId: ready.canonicalSessionId });
    expect(receipt.checkpointCleared).toBe(true);
    await f.imports.recover();
    expect((await f.api.retry(saved.requestId, false, signal)).canonicalSessionId).toBe(ready.canonicalSessionId);
    expect(f.profiles.listPartners()).toHaveLength(1);
  }, 20_000);

  it.each(["startup", "status", "missing checkpoint"] as const)("settles an interrupted first import through %s", async entry => {
    const phases: string[] = [];
    const f = await fixture({ observeImport: phase => phases.push(phase) });
    const firstIdentity = "Frozen identity for the original request.";
    const sourceIdentity = join(f.native, "SOUL.md");
    await writeFile(sourceIdentity, firstIdentity);
    const signal = new AbortController().signal;
    const preview = await f.api.preview((await f.api.sources(signal))[0]!.id, signal);
    const selected = preview.entries.find(item => item.category === PartnerImportCategory.PERSONALITY && item.name === "SOUL.md")!;
    const selection = {
      previewId: preview.id, requestId: "owner_import_checkpoint_0001", name: "Checkpoint recovery",
      entryIds: [selected.id], takeover: false, deferSetup: true
    };
    let interruptedReceipt: ReturnType<PartnerImportStorage["readReceipt"]>;
    const saveReceipt = f.storage.saveReceipt.bind(f.storage);
    const writeCheckpoint = f.storage.environment.write.bind(f.storage.environment);
    const marker = vi.spyOn(f.storage, "saveReceipt").mockImplementation(receipt => {
      if (receipt.checkpointSaved) throw new Error("Fixture interruption before checkpoint marker");
      return saveReceipt(receipt);
    });
    const checkpointWrite = vi.spyOn(f.storage.environment, "write").mockImplementation((...args) => {
      interruptedReceipt = f.storage.readReceipt(selection.requestId);
      if (entry === "missing checkpoint") throw new Error("Fixture interruption before checkpoint storage");
      return writeCheckpoint(...args);
    });
    try {
      await f.api.start(selection, signal);
      await f.imports.waitForRequest(selection.requestId);
    } finally {
      checkpointWrite.mockRestore();
      marker.mockRestore();
    }
    const original = interruptedReceipt!;
    expect(original).toMatchObject({ checkpointSaved: false, partnerCreated: false,
      result: { requestId: selection.requestId, status: "running", saved: false } });
    expect(f.profiles.listPartners()).toHaveLength(0);
    const { partnerId } = original.result;
    const checkpoint = (await f.storage.environment.read(partnerId, () => {}))?.pendingImport;
    if (entry === "missing checkpoint") expect(checkpoint).toBeUndefined();
    else expect(checkpoint?.selection).toEqual(selection);
    // Restore the exact durable receipt that a process exit would leave behind.
    f.storage.saveReceipt(original);
    await writeFile(sourceIdentity, "A later source edit must never replace the checkpoint.");
    const reopened = await f.reopenImports();
    if (entry === "startup") await reopened.manager.recover();
    const statuses = await Promise.all([reopened.api.status(selection.requestId, signal), reopened.api.status(selection.requestId, signal)]);
    expect(statuses.every(value => value?.requestId === selection.requestId && value.partnerId === partnerId)).toBe(true);
    const settled = await reopened.manager.waitForRequest(selection.requestId);
    const receipt = reopened.storage.readReceipt(selection.requestId);
    if (entry === "missing checkpoint") {
      expect(settled).toMatchObject({ status: "needs-attention", saved: false,
        checks: [{ entryId: "import", status: "needs-attention", message: "IMPORT_INTERRUPTED" }] });
      expect((await reopened.api.status(selection.requestId, signal))?.status).toBe(PartnerImportStatus.NEEDS_ATTENTION);
      expect(f.profiles.listPartners()).toHaveLength(0);
      expect(phases).not.toContain("create-partner-start");
    } else {
      expect(settled).toMatchObject({ status: "complete", partnerId, saved: true, savedEntryIds: [selected.id] });
      expect(receipt).toMatchObject({ checkpointSaved: true, checkpointCleared: true, partnerCreated: true });
      expect(f.partners.getPartner(partnerId).identitySource).toContain(firstIdentity);
      expect(f.profiles.listPartners()).toHaveLength(1);
      expect(phases.filter(phase => phase === "create-partner-start")).toHaveLength(1);
      expect((await reopened.api.status(selection.requestId, signal))?.status).toBe(PartnerImportStatus.COMPLETE);
      expect(await reopened.api.start(selection, signal)).toMatchObject({ requestId: selection.requestId, partnerId });
    }
  }, 20_000);

  it.each([false, true])("reconciles the saved first identity projection after an owner edit of %s", async edited => {
    const f = await fixture();
    const frozenIdentity = "Hermes import identity before the first completed profile write.";
    const sourceIdentity = join(f.native, "SOUL.md");
    await writeFile(sourceIdentity, frozenIdentity);
    const signal = new AbortController().signal;
    const preview = await f.api.preview((await f.api.sources(signal))[0]!.id, signal);
    const selected = preview.entries.find(item => item.category === PartnerImportCategory.PERSONALITY && item.name === "SOUL.md")!;
    const selection = {
      previewId: preview.id, requestId: "owner_import_first_profile_0001", name: "Profile recovery fixture",
      entryIds: [selected.id], takeover: false, deferSetup: true
    };
    const partnerId = importedPartnerId(selection.requestId);
    let originalIdentity: string | undefined;
    const update = f.partners.updatePartner.bind(f.partners);
    const interruption = vi.spyOn(f.partners, "updatePartner").mockImplementation((...args) => {
      if (args[0] !== partnerId || args[2].identitySource !== frozenIdentity) return update(...args);
      originalIdentity = f.partners.getPartner(partnerId).identitySource;
      return Promise.reject(new Error("Fixture interruption before the first profile write"));
    });
    try {
      await f.api.start(selection, signal);
      expect((await f.imports.waitForRequest(selection.requestId)).status).toBe("needs-attention");
    } finally {
      interruption.mockRestore();
    }
    expect(originalIdentity).toBeDefined();
    const original = f.partners.getPartner(partnerId);
    expect(original).toMatchObject({ profileVersion: 1, identitySource: originalIdentity });
    const environment = (await f.storage.environment.read(partnerId, () => {}))!;
    expect(Object.values(environment.documents)).toContain(frozenIdentity);
    expect(environment.pendingImport?.selection.requestId).toBe(selection.requestId);
    // Persist the precise state left by the older ordering between projection and intent.
    await f.storage.environment.update(partnerId, () => {}, value => {
      value.profileProjection.identity = frozenIdentity;
      delete value.profileUpdate;
    });
    const userIdentity = "The owner supplied a different identity.";
    if (edited) await update(partnerId, original.revision, { identitySource: userIdentity });
    await writeFile(sourceIdentity, "A later source edit.");
    const reopened = await f.reopenImports();
    await reopened.api.retry(selection.requestId, false, signal);
    const settled = await reopened.manager.waitForRequest(selection.requestId);
    const profile = f.partners.getPartner(partnerId);
    expect(profile.identitySource).toBe(edited ? userIdentity : frozenIdentity);
    expect(profile.canonicalSessionId).toBe(original.canonicalSessionId);
    expect(f.profiles.listPartners()).toHaveLength(1);
    if (edited) {
      expect(settled.status).toBe("needs-attention");
      expect(settled.checks).toContainEqual(expect.objectContaining({ message: "IMPORT_OWNER_CHANGED" }));
    } else {
      expect(settled).toMatchObject({ status: "complete", savedEntryIds: [selected.id], partnerId });
      const committed = (await reopened.storage.environment.read(partnerId, () => {}))!;
      expect(committed.profileProjection.identity).toBe(frozenIdentity);
      expect(committed.profileUpdate).toBeUndefined();
      expect(committed.targetOwner?.profileVersion).toBe(profile.profileVersion);
    }
  }, 20_000);

  it.each([true, false])("checks the source monitor before enabling an imported routine with Plan set to %s", async planMode => {
    const f = await fixture({ planMode, probePlan: JSON.stringify({ reads: [] }) });
    const requests: Array<{ method: string | undefined; url: string | undefined }> = [];
    const server = createServer((request, response) => {
      requests.push({ method: request.method, url: request.url });
      response.writeHead(200, { "content-type": "text/plain" }).end("fixture monitor");
    });
    await new Promise<void>(listen => server.listen(0, "127.0.0.1", listen));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture server address.");
      const jobs = join(f.native, "cron", "jobs.json");
      await writeFile(jobs, JSON.stringify([{
        id: "monitor", name: "Original monitor", prompt: "Send a local reminder.", enabled: true, state: "scheduled",
        schedule: { kind: "cron", expr: "0 9 1 1 *" }, monitor_url: `http://127.0.0.1:${address.port}/original-monitor`
      }]));
      const signal = new AbortController().signal;
      const preview = await f.api.preview((await f.api.sources(signal))[0]!.id, signal);
      const selected = preview.entries.find(item => item.category === PartnerImportCategory.AUTOMATIONS)!;
      const selection = {
        previewId: preview.id, requestId: "owner_import_monitor_0001", name: "Monitor takeover fixture",
        entryIds: [selected.id], takeover: true, deferSetup: true
      };
      await f.api.start(selection, signal);
      const imported = await f.imports.waitForRequest(selection.requestId);
      expect(imported.checks).toContainEqual(expect.objectContaining({ message: "IMPORT_SETUP_DEFERRED" }));
      const partner = f.partners.getPartner(imported.partnerId);
      const session = f.store.getSession(partner.canonicalSessionId!).descriptor;
      expect(session).toMatchObject({ planMode, permissionMode: "bypassPermissions" });
      expect(partner.initializationState).toBe("ready");
      const routine = f.routines.list(partner.id)[0]!;
      expect(routine.enabled).toBe(false);
      expect(requests).toHaveLength(0);
      const enabled = f.routines.save({ partnerId: partner.id, partnerRevision: partner.revision,
        routineId: routine.id, revision: routine.revision, definition: { ...routine, enabled: true } });
      await expect(enabled).rejects.toMatchObject({ code: "AUTOMATION_HANDOVER_REQUIRED" });
      expect(requests).toEqual(planMode ? [] : [{ method: "GET", url: "/original-monitor" }]);
      const verified = await f.imports.waitForRequest(selection.requestId);
      expect(verified.checks).toContainEqual(expect.objectContaining({
        message: planMode ? "AUTOMATION_DATA_READ_FAILED" : "AUTOMATION_READ_NOT_VERIFIED"
      }));
      expect(f.store.listInteractions({ sessionId: session.id })).toHaveLength(0);
      expect(f.routines.list(partner.id)[0]?.enabled).toBe(false);
      expect(JSON.parse(await readFile(jobs, "utf8"))[0]).toMatchObject({ enabled: true });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(closed => server.close(() => closed()));
    }
  }, 20_000);

  it("discovers bundled partners and admits one durable installation with skills, knowledge and disabled routines", async () => {
    let canonical: string | undefined;
    const f = await fixture({ resourceFiles: 20, currentCanonicalSession: () => canonical }); const signal = new AbortController().signal;
    const catalog = await f.api.packages!("en", signal);
    expect(catalog).toHaveLength(10); const entry = catalog.find(row => row.packageId === "engineer-bot")!;
    expect(entry.skills).toHaveLength(2); expect(entry.knowledge).toHaveLength(1); expect(entry.routines).toHaveLength(1);
    await expect(f.api.invitePackage!({ ...entry, packageHash: "0".repeat(64) }, "en", signal)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    const [first, second] = await Promise.all([f.api.invitePackage!(entry, "en", signal), f.api.invitePackage!(entry, "en", signal)]);
    expect(second.requestId).toBe(first.requestId);
    const result = await f.imports.waitForRequest(first.requestId);
    expect(result).toMatchObject({ saved: true, status: "complete" });
    const profile = f.partners.getPartner(result.partnerId);
    expect(profile.displayName).toBe(entry.name); expect(profile.description).toBe(entry.description);
    expect(profile.identitySource).toContain("Joko");
    expect(f.resources.list({ targetId: profile.homeTargetId })).toHaveLength(3);
    expect(f.routines.list(profile.id)).toHaveLength(1); expect(f.routines.list(profile.id)[0]!.enabled).toBe(false);
    const receipt = f.storage.readReceipt(result.requestId)!;
    expect(receipt.nativePackage?.packageId).toBe(entry.packageId); expect(receipt.checkpointCleared).toBe(true);
    const restored = new PartnerImportStorage(f.store, await CredentialVault.open(join(f.root, "credentials", "master.key")), f.root);
    expect(restored.readReceipt(result.requestId)?.nativePackage?.packageHash).toBe(entry.packageHash);
    expect((await f.api.packages!("en", signal)).find(row => row.packageId === entry.packageId)?.installation?.partnerId).toBe(profile.id);
    canonical = "new-main-canonical-session";
    expect((await f.api.packages!("en", signal)).find(row => row.packageId === entry.packageId)?.installation?.canonicalSessionId).toBe(canonical);
    expect((await f.api.invitePackage!(entry, "en", signal)).canonicalSessionId).toBe(canonical);
    expect((await f.api.status(result.requestId, signal))?.canonicalSessionId).toBe(canonical);
    expect(f.storage.readReceipt(result.requestId)?.result.canonicalSessionId).toBe(profile.canonicalSessionId);
    const deletion = await f.partners.deletePartner({ requestId: "package_install_delete_0001", partnerId: profile.id, expectedRevision: profile.revision, confirmName: profile.displayName });
    expect(deletion.phase).toBe("completed");
    expect((await f.api.packages!("en", signal)).find(row => row.packageId === entry.packageId)?.installation).toBeUndefined();
  }, 20_000);
  it("saves the complete five-category selection through the generated boundary and retains usable full originals after cold recovery", async ({ signal: testSignal, onTestFailed, onTestFinished }) => {
    type Phase = "fixture" | "sources" | "preview" | "start" | "completion" | "environment"
      | "published-tree" | "resources" | "resource-recovery" | "receipt-recovery" | "persistence" | "idempotency" | "complete";
    const startedAt = performance.now();
    let phase: Phase = "fixture";
    const completedPhases: Array<{ phase: Phase; elapsedMs: number }> = [];
    let importPhase = "not-started";
    let effectStarted = 0;
    let effectCompleted = 0;
    let effectFailed = 0;
    const effectCounts: Record<string, number> = {};
    const observeImport = (next: string) => {
      importPhase = next;
      effectCounts[next] = (effectCounts[next] ?? 0) + 1;
      if (next.endsWith("-start")) effectStarted += 1;
      else if (next.endsWith("-complete")) effectCompleted += 1;
      else if (next.endsWith("-failed")) effectFailed += 1;
    };
    const snapshot = () => ({ phase, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), completedPhases: [...completedPhases],
      importPhase, effectStarted, effectCompleted, effectFailed, effectCounts: { ...effectCounts } });
    let abortedSnapshot: ReturnType<typeof snapshot> | undefined;
    const captureAbort = () => { abortedSnapshot ??= snapshot(); };
    const advance = (next: Phase) => {
      completedPhases.push({ phase, elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)) });
      phase = next;
    };
    testSignal.addEventListener("abort", captureAbort, { once: true });
    onTestFinished(() => testSignal.removeEventListener("abort", captureAbort));
    onTestFailed(() => {
      try {
        console.error("[partner-import-boundary]", JSON.stringify({ boundary: abortedSnapshot ? "test-abort" : "failure", ...(abortedSnapshot ?? snapshot()) }));
      } catch { /* The observation must not replace the original test failure. */ }
    });
    const f = await fixture({ changeDefaults: true, observeImport }); const signal = new AbortController().signal;
    advance("sources");
    const sources = await f.api.sources(signal);
    advance("preview");
    const preview = await f.api.preview(sources[0]!.id, signal);
    expect(preview.entries.length).toBeGreaterThan(20); expect(new Set(preview.entries.map(entry => entry.category)).size).toBe(5);
    expect(JSON.stringify(preview)).not.toContain(secret);
    const selection = { previewId: preview.id, requestId: "owner_import_request_0001", name: "Imported analyst", entryIds: preview.entries.map(entry => entry.id), takeover: true, deferSetup: true };
    advance("start");
    await f.api.start(selection, signal);
    advance("completion");
    const saved = await f.imports.waitForRequest(selection.requestId);
    expect(saved, JSON.stringify({ checks: saved.checks, receipt: f.storage.readReceipt(selection.requestId)?.routines,
      profiles: f.partners.listPartners().map(p => ({ initialization: p.initializationState, failure: p.initializationErrorCode })) })).toMatchObject({ saved: true, status: "complete" }); expect(saved.savedEntryIds).toHaveLength(selection.entryIds.length);
    const profile = f.partners.getPartner(saved.partnerId); expect(profile.initializationState).toBe("ready"); expect(profile.canonicalSessionId).toBe(saved.canonicalSessionId);
    expect(profile.capabilities.permissionMode).toBe("ask"); expect(f.profiles.directoryState().defaultCapabilities?.permissionMode).toBe("auto");
    advance("environment");
    const environment = await f.storage.environment.read(profile.id, () => {});
    expect(environment?.env.ACCESS_TOKEN).toBe(secret); expect(environment?.pendingImport).toBeUndefined();
    expect(environment?.profileProjection.identity.length).toBeGreaterThan(8000); expect(profile.identitySource.length).toBeLessThanOrEqual(8000);
    expect(environment?.documents[preview.entries.find(entry => entry.name === "notes-0.md")!.id]).toContain("Retained original.");
    advance("published-tree");
    const published = await readImportTree(f.store.getTarget(profile.homeTargetId).descriptor.workspaceRoot, () => true, createImportBudget());
    expect(published.some(file => file.name.includes("imported-memory/") && file.bytes[0] === 137)).toBe(true);
    expect(published.every(file => !file.bytes.includes(Buffer.from(secret)))).toBe(true);
    advance("resources");
    const resource = f.resources.list({ targetId: profile.homeTargetId, kind: "skill" })[0]!; expect(resource.enabled).toBe(true);
    const text = await f.resources.runtimeTextSnapshot(profile.capabilities.modelChain[0]!.backendId, profile.homeTargetId, signal);
    expect(text[0]!.content.length).toBeGreaterThan(256 * 1024); expect(text[0]!.content).not.toContain(secret);
    advance("resource-recovery");
    const restoredResources = new PiResourceManager({ store: f.store, managedRoot: join(f.root, "resources"), maximumFiles: 2 }); await restoredResources.initialize();
    expect((await restoredResources.runtimeTextSnapshot(profile.capabilities.modelChain[0]!.backendId, profile.homeTargetId, signal))[0]!.content).toBe(text[0]!.content);
    const routine = f.routines.list(profile.id)[0]!; expect(routine.enabled).toBe(false); expect(environment?.automations[routine.id]?.handover).toBe("ready");
    advance("receipt-recovery");
    const receipts = new PartnerImportStorage(f.store, await CredentialVault.open(join(f.root, "credentials", "master.key")), f.root);
    expect(receipts.readReceipt(selection.requestId)?.result).toEqual(saved);
    expect((await receipts.environment.read(profile.id, () => {}))?.skillFiles).toEqual(environment?.skillFiles);
    advance("persistence");
    expect(JSON.stringify(f.store.listEvents({ sessionId: profile.canonicalSessionId! }), (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain(secret);
    expect((await readFile(join(f.root, "operational.db"))).includes(Buffer.from(secret))).toBe(false);
    advance("idempotency");
    expect((await f.api.start(selection, signal)).partnerId).toBe(profile.id); expect(f.profiles.listPartners()).toHaveLength(1);
    await expect(f.api.start({ ...selection, name: "Another intent" }, signal)).rejects.toMatchObject({ code: Code.AlreadyExists });
    advance("complete");
  }, 40_000);
  it("fences preview theft/revocation and serializes import deletion without recreating private data", async ({ signal: testSignal, onTestFailed, onTestFinished }) => {
    const started = performance.now(); let phase = "fixture";
    const effects: Array<{ phase: string; elapsedMs: number }> = [];
    const observation = () => ({ phase, elapsedMs: Math.round(performance.now() - started), effects: effects.slice(-24) });
    let aborted: ReturnType<typeof observation> | undefined;
    const captureAbort = () => { aborted ??= observation(); };
    testSignal.addEventListener("abort", captureAbort, { once: true });
    onTestFinished(() => testSignal.removeEventListener("abort", captureAbort));
    onTestFailed(() => { console.error("[import-deletion-boundary]", JSON.stringify(aborted ?? observation())); });
    const f = await fixture({ observeImport: value => { effects.push({ phase: value, elapsedMs: Math.round(performance.now() - started) }); } });
    const signal = new AbortController().signal; phase = "preview";
    const preview = await f.api.preview((await f.api.sources(signal))[0]!.id, signal);
    const selection = { previewId: preview.id, requestId: "owner_import_request_0002", name: "Owned import", entryIds: preview.entries.filter(entry => entry.category !== PartnerImportCategory.AUTOMATIONS).map(entry => entry.id), takeover: false, deferSetup: true };
    f.authenticate("device-b"); await expect(f.service.startPartnerImport(create(StartPartnerImportRequestSchema, { controllerId: "sheet", selection }), f.context())).rejects.toMatchObject({ code: Code.FailedPrecondition });
    f.authenticate(""); await expect(f.service.getPartnerImportStatus(create(GetPartnerImportStatusRequestSchema, { requestId: selection.requestId }), f.context())).rejects.toMatchObject({ code: Code.Unauthenticated });
    f.authenticate("device-a"); phase = "start"; await f.api.start(selection, signal);
    phase = "completion"; const saved = await f.imports.waitForRequest(selection.requestId);
    expect(saved.saved).toBe(true); expect(saved.status).toBe("complete");
    phase = "private-environment";
    const partner = f.partners.getPartner(saved.partnerId); expect(await f.storage.environment.read(partner.id, () => {})).toBeDefined();
    const assertOwner = () => { if (f.partners.getPartner(partner.id).lifecycle !== "active") throw new Error("The test Partner retired."); };
    const sourceScript = join(f.native, "scripts", "review.py");
    await mkdir(dirname(sourceScript), { recursive: true });
    const bytes = Buffer.from("print('original source')\n");
    await writeFile(sourceScript, bytes);
    await f.storage.environment.update(partner.id, assertOwner, environment => {
      environment.files["scripts/review.py"] = bytes.toString("base64");
      environment.automations["prepared-routine"] = { kind: "hermes", original: {}, sourceRoot: f.native, sourceWorkspace: f.native,
        sourceId: "original-script", handover: "ready", issues: [], deliveries: [], completed: 0 };
    });
    let abandoned = "";
    await prepareImportedAutomation({ id: "prepared-routine", partnerId: partner.id, prompt: "Review the workspace" }, "abandoned-run", signal, assertOwner, {
      environment: f.storage.environment, appendMessage: async () => { throw new Error("No delivery was requested."); },
      createExecutionDirectory: async (partnerId, owner) => {
        const allocated = await f.storage.createExecutionDirectory(partnerId, owner);
        abandoned = allocated.directory;
        return { directory: allocated.directory, cleanup: async () => undefined };
      }
    });
    const abandonedScript = join(abandoned, "scripts", "review.py");
    expect(await readFile(abandonedScript)).toEqual(bytes);
    const otherOwner = await f.storage.createExecutionDirectory("unrelated-partner", () => undefined);
    const unrelated = join(otherOwner.directory, "keep.txt");
    await writeFile(unrelated, "Other owner");
    phase = "delete";
    const deletion = await f.partners.deletePartner({ requestId: "owner_import_delete_0002", partnerId: partner.id, expectedRevision: partner.revision, confirmName: partner.displayName });
    expect(deletion.phase).toBe("completed");
    await expect(readFile(abandonedScript)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(sourceScript)).toEqual(bytes);
    expect(await readFile(unrelated, "utf8")).toBe("Other owner");
    await otherOwner.cleanup();
    expect(f.storage.readReceipt(selection.requestId)?.cancelled).toBe(true);
    phase = "retired-storage";
    await expect(f.storage.environment.read(partner.id, () => {})).rejects.toMatchObject({ code: "IMPORT_OWNER_RETIRED" });
    phase = "retry"; expect((await f.api.retry(selection.requestId, true, signal)).status).toBe(PartnerImportStatus.NEEDS_ATTENTION);
    expect(() => f.partners.getPartner(partner.id)).toThrowError("The partner profile was not found."); expect(f.profiles.listPartners()).toHaveLength(0);
    phase = "complete";
  }, 20_000);
  it("adopts an explicit current model and policy mapping under the same saved intent while refusing identity edits", async () => {
    const f = await fixture({ nativeTools: true }); const signal = new AbortController().signal;
    const preview = await f.api.preview((await f.api.sources(signal))[0]!.id, signal);
    const entries = preview.entries.filter(entry => entry.name === "tools" || entry.category === PartnerImportCategory.PERSONALITY);
    const selection = { previewId: preview.id, requestId: "owner_import_mapping_0001", name: "Mapped import", entryIds: entries.map(entry => entry.id), takeover: false, deferSetup: true };
    await f.api.start(selection, signal); const saved = await f.imports.waitForRequest(selection.requestId);
    expect(saved.saved).toBe(true); expect(saved.status).toBe("needs-attention");
    const profile = f.partners.getPartner(saved.partnerId);
    const updated = await f.partners.updatePartner(profile.id, profile.revision, { capabilities: { ...profile.capabilities, permissionMode: "auto" } });
    await f.imports.useCurrentSettings(profile.id, [entries.find(entry => entry.name === "tools")!.id], { ownerKey: "device-a:task", assertCurrent() {} });
    await f.api.retry(selection.requestId, true, signal);
    expect(await f.imports.waitForRequest(selection.requestId)).toMatchObject({ saved: true, status: "complete", partnerId: profile.id });
    expect(f.partners.getPartner(profile.id).revision).toBe(updated.revision);
    expect(f.profiles.listPartners()).toHaveLength(1);
    await f.partners.updatePartner(profile.id, updated.revision, { identitySource: "An explicit user edit" });
    await expect(adoptPartnerImportSettings(f.partners, f.store, f.storage, profile.id, () => {})).rejects.toMatchObject({ code: "IMPORT_OWNER_CHANGED" });
  }, 20_000);
});
