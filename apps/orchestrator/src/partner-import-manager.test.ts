import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, createRouterTransport, type HandlerContext } from "@connectrpc/connect";
import { afterEach, describe, expect, it } from "vitest";
import { OperationalStore, PartnerStore, PartnerRoutineStore, partnerHomeDirectoryName } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { createPartnerImportApi, PartnerImportService, PartnerImportCategory, PartnerImportStatus, StartPartnerImportRequestSchema, GetPartnerImportStatusRequestSchema } from "@joko/contracts";
import { readImportTree, createImportBudget } from "@joko/agent-import";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { CredentialVault } from "./credential-vault.js";
import { MakerMemoryController } from "./maker-memory.js";
import { PiResourceManager } from "./resource-manager.js";
import { PartnerManager } from "./partner-manager.js";
import { PartnerRoutineManager } from "./partner-routine-manager.js";
import { PartnerImportManager } from "./partner-import-manager.js";
import { PartnerImportStorage } from "./partner-import-storage.js";
import { adoptPartnerImportSettings, createPartnerImportEffects, preparePartnerImportCreation } from "./partner-import-effects.js";
import { createPartnerImportConnectService } from "./partner-import-connect-service.js";
import { ScheduleCoordinator } from "./schedule-coordinator.js";
import { SessionHost } from "./session-host.js";

const secret = "fixture-import-secret-abcdef012345"; const cleanups: Array<() => Promise<void>> = [];
const backendProfile = { ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities.map(capability => capability.key === "permission.modes"
  ? { ...capability, options: ["ask", "auto", "bypassPermissions"] } : capability), { key: "permission.change", supported: true },
  { key: "runtime.resources", supported: true, options: ["skill", "prompt"] }] };
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: { changeDefaults?: boolean; nativeTools?: boolean; resourceFiles?: number; noDefaults?: boolean; observeImport?: (phase: string) => void; currentCanonicalSession?: () => string | undefined } = {}) {
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
  const vault = await CredentialVault.open(join(root, "credentials", "master.key")); const storage = new PartnerImportStorage(store, vault);
  const resources = new PiResourceManager({ store, managedRoot: join(root, "resources"), maximumFiles: options.resourceFiles ?? 2 }); await resources.initialize();
  const memory = new MakerMemoryController({ store }); const scheduler = new ScheduleCoordinator(store, host);
  let imports: PartnerImportManager; let routines: PartnerRoutineManager;
  const partners = new PartnerManager({ store: profiles, operationalStore: store, sessionHost: host, homesRoot: join(root, "homes"),
    workspaceService: { register: async input => input, unregister: () => undefined },
    onRoutineLifecycle: (id, lifecycle) => routines.lifecycle(id, lifecycle), prepareImportDeletion: id => imports.prepareDeletion(id), onReady: async id => { await imports?.activatePackage(id); } });
  routines = new PartnerRoutineManager({ partners, store, scheduler, storage: new PartnerRoutineStore(join(root, "routines")) }); await routines.start();
  if (!options.noDefaults) profiles.setDirectoryDefaults(profiles.directoryState().revision, { modelChain: [{ backendId: PI_LIKE_PROFILE.id, providerId: "test", modelId: "text", effort: "medium", fastMode: false }], permissionMode: "ask", planMode: false });
  imports = new PartnerImportManager({ storage, home: root, environment: {}, assertServiceOwner: () => {},
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
      const pendingEffects = createPartnerImportEffects({ partners, routines, storage, store, memory, resources, artifacts,
      verification: { readEnvironment: (id, owner) => storage.environment.read(id, owner), canonicalSessionId: async id => partners.getPartner(id).canonicalSessionId!,
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
  let authenticated = "device-a";
  const context = (): HandlerContext => ({ signal: new AbortController().signal } as HandlerContext);
  const service = createPartnerImportConnectService(imports, () => { if (!authenticated) throw new ConnectError("Revoked", Code.Unauthenticated); return { id: authenticated }; });
  const api = createPartnerImportApi({ ownerKey: "device-a:sheet", controllerId: "sheet", assertCurrent: () => {}, newRequestId: () => "owner_import_request_0001",
    rpc: createClient(PartnerImportService, createRouterTransport(router => { router.service(PartnerImportService, service); })) });
  cleanups.push(async () => { await imports.close(); await routines.stop(); await scheduler.stop(); await host.dispose(); profiles.close(); store.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("joko-import-owner-")) throw new Error("Unsafe fixture cleanup"); await rm(root, { recursive: true, force: true }); });
  return { root, native, store, profiles, artifacts, host, storage, resources, memory, partners, routines, imports, service, api, context, manifest,
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
  it("saves a complete package without a model and projects its saved files only after an explicit real model selection", async () => {
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
    const restored = new PartnerImportStorage(f.store, await CredentialVault.open(join(f.root, "credentials", "master.key")));
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
    const receipts = new PartnerImportStorage(f.store, await CredentialVault.open(join(f.root, "credentials", "master.key")));
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
    phase = "delete";
    const deletion = await f.partners.deletePartner({ requestId: "owner_import_delete_0002", partnerId: partner.id, expectedRevision: partner.revision, confirmName: partner.displayName });
    expect(deletion.phase).toBe("completed");
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
