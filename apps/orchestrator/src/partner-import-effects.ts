import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  AgentImportError, changeSourceAutomationState, createEnvironmentRedactor, createImportSourceReader,
  fingerprint, importDelivery, memoryFileContent, projectImportedSkill, resolveImportReferences,
  retainedImportRedactions, selectedImportEnvironment, sniffImportedMediaMime, validateImportSelection, readOpenClawCronDatabase,
  verifyImportedAutomation, writeImportFiles, readImportTree, createImportBudget,
  type AgentImportSelection, type ImportedEnvironment, type ImportedRoutineInput, type ImportItem, type ImportVerificationDeps,
} from "@joko/agent-import";
import { decodePartnerAvatar, normalizedPartnerName, type PartnerCapabilitiesRecord, type PartnerProfileRecord, type OperationalStore } from "@joko/store";
import type { ArtifactStore } from "./artifact-store.js";
import type { MakerMemoryController } from "./maker-memory.js";
import { PARTNER_TEMPLATES, type PartnerManager } from "./partner-manager.js";
import type { PartnerRoutineManager } from "./partner-routine-manager.js";
import { parseRoutineInput } from "./partner-routine-definition.js";
import type { PartnerImportEffectContext } from "./partner-import-manager.js";
import type { PartnerImportStorage } from "./partner-import-storage.js";
import type { PiResourceManager } from "./resource-manager.js";

interface CreationDraft { version: 1; directoryRevision: string; capabilities: PartnerCapabilitiesRecord; }
export const importedPartnerId = (requestId: string): string => `agent_import_${fingerprint(requestId).slice(0, 32)}`;
const creationRequestId = (requestId: string): string => `agent_import_${fingerprint(requestId).slice(0, 48)}`;

/** Freeze configured model routes before checkpoint acceptance; source credentials never select a Backend. */
export function preparePartnerImportCreation(partners: PartnerManager, selection: AgentImportSelection, nativePackage = false): string {
  const directory = partners.directory().state;
  if (!directory.defaultCapabilities && !nativePackage) throw new AgentImportError("IMPORT_MODEL_SETTINGS_REQUIRED");
  let name: string; try { name = normalizedPartnerName(selection.name); } catch { throw new AgentImportError("INVALID_SELECTION"); }
  if (partners.listPartners().some(profile => profile.id !== importedPartnerId(selection.requestId) && normalizedPartnerName(profile.displayName) === name)) throw new AgentImportError("IMPORT_NAME_EXISTS");
  return JSON.stringify({ version: 1, directoryRevision: directory.revision.toString(), capabilities: directory.defaultCapabilities
    ?? { modelChain: [], permissionMode: "ask", planMode: false } } satisfies CreationDraft);
}

/** Explicit model/policy mapping can adopt those fields, but cannot adopt edits to imported identity or a different task. */
export async function adoptPartnerImportSettings(partners: PartnerManager, store: OperationalStore, storage: PartnerImportStorage, partnerId: string, assertOwner: () => void): Promise<void> {
  const environment = await storage.environment.read(partnerId, assertOwner); assertOwner();
  const stamp = environment?.targetOwner; const profile = partners.getPartner(partnerId);
  if (!stamp || profile.lifecycle !== "active" || profile.initializationState !== "ready" || profile.canonicalSessionId !== stamp.sessionId
    || importIdentityFingerprint(profile) !== stamp.identityFingerprint) throw new AgentImportError("IMPORT_OWNER_CHANGED");
  const session = store.getSession(stamp.sessionId).descriptor; const target = store.getTarget(profile.homeTargetId).descriptor;
  if (!target.trusted || target.workspaceRoot !== stamp.workspaceRoot || session.archived || session.deletedAt !== undefined
    || session.targetId !== profile.homeTargetId || session.backendId !== profile.capabilities.modelChain[0]?.backendId) throw new AgentImportError("IMPORT_OWNER_CHANGED");
  const next = captureImportOwner(profile, store);
  await storage.environment.update(partnerId, assertOwner, current => {
    if (current.targetOwner?.profileFingerprint !== stamp.profileFingerprint) throw new AgentImportError("IMPORT_OWNER_CHANGED");
    current.targetOwner = next;
  }); assertOwner();
}

export async function createPartnerImportEffects(options: {
  partners: PartnerManager; routines: PartnerRoutineManager; storage: PartnerImportStorage; store: OperationalStore;
  memory: MakerMemoryController; resources: PiResourceManager; artifacts: ArtifactStore;
  verification: ImportVerificationDeps; home: string; environment: NodeJS.ProcessEnv;
}, context: PartnerImportEffectContext) {
  const { partners, routines, storage, store } = options;
  const { snapshot, selection, assertOwner, publicationRedactions } = context;
  const selected = validateImportSelection(selection, snapshot);
  const redact = (text: string): string => createEnvironmentRedactor(publicationRedactions)(text);
  const partnerId = importedPartnerId(selection.requestId);
  const prior = await storage.environment.read(partnerId, assertOwner); assertOwner();
  let stamp = prior?.targetOwner;
  let packageStamp = prior?.packageOwner;
  const packagePending = (profile: PartnerProfileRecord) => snapshot.nativePackage !== undefined && !profile.canonicalSessionId
    && profile.initializationState === "error" && profile.initializationErrorCode === "model_unavailable";
  const capturePackageOwner = (profile: PartnerProfileRecord) => ({ revision: profile.revision.toString(), profileVersion: profile.profileVersion, profileFingerprint: importProfileFingerprint(profile) });
  const captureOwner = (profile: PartnerProfileRecord) => captureImportOwner(profile, store);
  if (prior?.profileUpdate && (stamp || packageStamp)) {
    const current = partners.getPartner(partnerId);
    if ((packagePending(current) ? current.revision >= BigInt(prior.profileUpdate.fromRevision) + 1n : current.revision === BigInt(prior.profileUpdate.fromRevision) + 1n) && current.profileVersion === (stamp ?? packageStamp)!.profileVersion + 1
      && current.canonicalSessionId === stamp?.sessionId && importProfileFingerprint(current) === prior.profileUpdate.expectedFingerprint) {
      if (packagePending(current)) packageStamp = capturePackageOwner(current); else stamp = captureOwner(current);
      await storage.environment.update(partnerId, assertOwner, value => { value.targetOwner = stamp; value.packageOwner = packageStamp; delete value.profileUpdate; });
    }
  }
  let owner: PartnerProfileRecord | undefined;
  let runtimeGeneration: number | undefined;
  const assertPartner = (id: string): PartnerProfileRecord => {
    assertOwner(); const current = partners.getPartner(id);
    if (current.lifecycle !== "active" || !(current.initializationState === "ready" && current.canonicalSessionId || packagePending(current))
      || owner && (current.id !== owner.id || current.revision !== owner.revision || current.profileVersion !== owner.profileVersion
        || current.canonicalSessionId !== owner.canonicalSessionId || current.homeTargetId !== owner.homeTargetId)) throw new AgentImportError("IMPORT_OWNER_CHANGED");
    if (packagePending(current)) {
      if (packageStamp && (packageStamp.revision !== current.revision.toString() || packageStamp.profileVersion !== current.profileVersion
        || packageStamp.profileFingerprint !== importProfileFingerprint(current))) throw new AgentImportError("IMPORT_OWNER_CHANGED");
      owner ??= current; return current;
    }
    const session = store.getSession(current.canonicalSessionId!).descriptor;
    const target = store.getTarget(current.homeTargetId).descriptor;
    const generation = store.getBackend(session.backendId).descriptor.instanceGeneration;
    if (runtimeGeneration !== undefined && runtimeGeneration !== generation) throw new AgentImportError("IMPORT_OWNER_CHANGED");
    runtimeGeneration ??= generation;
    if (session.deletedAt !== undefined || session.archived || session.targetId !== current.homeTargetId || !target.trusted
      || session.backendId !== current.capabilities.modelChain[0]?.backendId) throw new AgentImportError("IMPORT_OWNER_CHANGED");
    if (stamp && (stamp.revision !== current.revision.toString() || stamp.profileVersion !== current.profileVersion
      || stamp.profileFingerprint !== importProfileFingerprint(current) || stamp.sessionId !== session.id
      || stamp.generation !== session.binding.generation || stamp.workspaceRoot !== target.workspaceRoot)) throw new AgentImportError("IMPORT_OWNER_CHANGED");
    owner ??= current; return current;
  };
  const environment = (id: string) => storage.environment.read(id, () => { assertPartner(id); });
  const update = (id: string, mutate: (value: ImportedEnvironment) => void | Promise<void>) =>
    storage.environment.update(id, () => { assertPartner(id); }, mutate);
  const documents = (item: ImportItem) => [
    ...(item.text !== undefined ? [{ id: item.view.id, name: item.view.name, text: item.text, role: item.role }] : []),
    ...(item.documents ?? []),
  ];
  const skillSlug = (item: ImportItem): string => {
    const name = redact(item.view.name).toLowerCase().normalize("NFKC").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 35);
    return `${name || "import"}-${fingerprint(item.view.id).slice(0, 16)}`;
  };
  const publicRoutine = (input: Parameters<typeof parseRoutineInput>[0]) => {
    const parsed = parseRoutineInput(input); return { ...parsed, name: redact(parsed.name), prompt: redact(parsed.prompt) };
  };
  const writeDocument = async (partnerId: string, document: ReturnType<typeof documents>[number]): Promise<void> => {
    const partner = assertPartner(partnerId); const text = redact(document.text);
    const parts = splitImportedMemoryText(text); let saved = 0;
    try {
      for (const [index, content] of parts.entries()) {
        const body = `<!-- Imported document ${index + 1}/${parts.length} -->\n\n${content}\n\n<!-- End imported document -->`;
        assertPartner(partnerId);
        const slug = `import-${fingerprint(document.id).slice(0, 32)}-${index + 1}`;
        const kind = document.role === "user" ? "user" : "reference";
        const previous = store.findMakerMemoryEntry(partner.homeTargetId, kind, slug);
        if (previous && previous.body !== body) throw new AgentImportError("IMPORTED_MEMORY_CHANGED");
        if (!previous) options.memory.write(partner.homeTargetId, { kind, name: slug,
          title: singleLine(redact(document.name), 85) + (parts.length > 1 ? ` (${index + 1})` : ""),
          description: singleLine(content, 180) || "Imported document", body, mode: "create" });
        const committed = store.findMakerMemoryEntry(partner.homeTargetId, kind, slug);
        if (!committed || committed.body !== body) throw new AgentImportError("MEMORY_WRITE_FAILED");
        saved++;
      }
      await update(partnerId, value => {
        value.documents[document.id] = document.text;
        if (!value.appliedDocuments.includes(document.id)) value.appliedDocuments.push(document.id);
      });
    } catch (error) { throw Object.assign(error instanceof AgentImportError ? error : new AgentImportError("MEMORY_WRITE_FAILED"), { importProgress: { saved, total: parts.length } }); }
  };
  const applyProfile = async (partnerId: string, items: ImportItem[]): Promise<void> => {
    if (context.activateNativePackage) return;
    const previous = await environment(partnerId); if (!previous) throw new AgentImportError("CREDENTIAL_STORAGE_UNAVAILABLE");
    const applied = new Set(previous.appliedDocuments);
    const profile = { identity: "", user: "", instructions: "" };
    for (const role of ["identity", "user", "instructions"] as const) {
      profile[role] = redact(items.flatMap(documents).filter(document => document.role === role && applied.has(document.id)).map(document => previous.documents[document.id]!).join("\n\n"));
    }
    const current = assertPartner(partnerId);
    const identity = profilePrefix(profile.identity, 8_000) || PARTNER_TEMPLATES[0].identitySource;
    const baseline = profilePrefix(previous.profileProjection.identity, 8_000) || PARTNER_TEMPLATES[0].identitySource;
    if (current.identitySource !== baseline && current.identitySource !== identity) throw new AgentImportError("PROFILE_CHANGED");
    await update(partnerId, value => { value.profileProjection = profile; });
    if (current.identitySource !== identity || previous.profileProjection.user !== profile.user || previous.profileProjection.instructions !== profile.instructions) {
      await update(partnerId, value => { value.profileUpdate = { fromRevision: current.revision.toString(), expectedFingerprint: importProfileFingerprint({ ...current, identitySource: identity }) }; });
      const changed = await partners.updatePartner(partnerId, current.revision, { identitySource: identity }); assertOwner(); owner = changed;
      if (packagePending(changed)) packageStamp = capturePackageOwner(changed); else stamp = captureOwner(changed);
      await update(partnerId, value => { value.targetOwner = stamp; value.packageOwner = packageStamp; delete value.profileUpdate; });
    }
  };
  return {
    partnerId: importedPartnerId,
    async validateItems(items: ImportItem[]) {
      if (snapshot.nativePackage) return;
      for (const item of items) if (item.automation) {
        const delivery = importDelivery(snapshot.source, item.automation.original, items);
        item.automation.deliveries = delivery.deliveries;
        item.view.issues = [...new Set([...(item.view.issues ?? []), ...delivery.issues])];
      }
    },
    async createPartner(partnerId: string, input: AgentImportSelection) {
      if (context.activateNativePackage) {
        owner = partners.getPartner(partnerId);
        if (owner.initializationState !== "ready" || !owner.canonicalSessionId) throw new AgentImportError("IMPORT_PARTNER_SETUP_REQUIRED");
        packageStamp = undefined; stamp = captureOwner(owner);
        await storage.environment.update(partnerId, assertOwner, value => { value.targetOwner = stamp; delete value.packageOwner; });
        assertPartner(partnerId); return;
      }
      let draft: CreationDraft;
      try { draft = JSON.parse(context.creationJson) as CreationDraft; } catch { throw new AgentImportError("IMPORT_CREATION_INVALID"); }
      if (draft.version !== 1 || !/^\d+$/.test(draft.directoryRevision) || !draft.capabilities) throw new AgentImportError("IMPORT_CREATION_INVALID");
      let created = await partners.createImportedPartner({ id: partnerId, requestId: creationRequestId(input.requestId),
        ...(snapshot.nativePackage ? { allowUnconfiguredModel: true as const } : {}),
        expectedDirectoryRevision: BigInt(draft.directoryRevision), displayName: redact(input.name),
        avatar: input.avatarImageBase64 ? { base64: input.avatarImageBase64 } : snapshot.nativePackage?.avatarPreset ?? "orbit", templateId: "general",
        identitySource: PARTNER_TEMPLATES[0].identitySource, description: snapshot.nativePackage?.description ?? "", capabilities: draft.capabilities, usesDirectoryDefaults: false });
      assertOwner();
      if (snapshot.nativePackage && !created.canonicalSessionId && created.initializationState === "pending") created = await partners.retryInitialization(partnerId, created.revision);
      if (created.lifecycle === "active" && created.initializationState === "error" && !packagePending(created)) created = await partners.retryInitialization(partnerId, created.revision);
      if (created.initializationState !== "ready" && !packagePending(created)) throw new AgentImportError("IMPORT_PARTNER_SETUP_REQUIRED");
      if (!stamp && !packageStamp && (created.profileVersion !== 1 || created.displayName !== redact(input.name).trim() || created.templateId !== "general"
        || created.identitySource !== PARTNER_TEMPLATES[0].identitySource || created.usesDirectoryDefaults
        || fingerprint(created.capabilities) !== fingerprint(draft.capabilities) || created.homeTargetId !== `partner:${partnerId}`
        || fingerprint(created.avatar) !== fingerprint(input.avatarImageBase64 ? decodePartnerAvatar(input.avatarImageBase64).image : snapshot.nativePackage?.avatarPreset ?? "orbit"))) throw new AgentImportError("IMPORT_OWNER_CHANGED");
      owner = created; assertPartner(partnerId);
      if (packagePending(created)) {
        await partners.prepareImportedHome(partnerId); assertPartner(partnerId);
        packageStamp = capturePackageOwner(created); await update(partnerId, value => { value.packageOwner = packageStamp; });
      } else if (!stamp) { stamp = captureOwner(created); await update(partnerId, value => { value.targetOwner = stamp; }); }
    },
    async importItem(partnerId: string, item: ImportItem) {
      const partner = assertPartner(partnerId);
      if (snapshot.nativePackage && item.role === "identity") {
        if (context.activateNativePackage) return;
        await update(partnerId, value => { value.documents[item.view.id] = item.text ?? "";
          if (!value.appliedDocuments.includes(item.view.id)) value.appliedDocuments.push(item.view.id); });
        await applyProfile(partnerId, selected); return;
      }
      if (item.view.category === "skills") {
        const slug = skillSlug(item); const projection = projectImportedSkill(item.files ?? [], slug, publicationRedactions);
        const workspaceRoot = packagePending(partner) ? await partners.prepareImportedHome(partnerId) : store.getTarget(partner.homeTargetId).descriptor.workspaceRoot;
        const root = await prepareImportSkillRoot(workspaceRoot, () => { assertPartner(partnerId); });
        const destination = path.join(root, slug);
        const publishedFiles = projection.files.map(({ interpreterLink: _link, ...file }) => file);
        try {
          const existing = await fs.lstat(destination);
          if (!existing.isDirectory() || existing.isSymbolicLink()) throw new AgentImportError("IMPORTED_SKILL_CHANGED");
          const contents = await readImportTree(destination, () => true, createImportBudget(undefined, () => { assertPartner(partnerId); }));
          if (contents.length !== publishedFiles.length || publishedFiles.some(file => !contents.some(actual => actual.name === file.name && actual.bytes.equals(file.bytes)))) throw new AgentImportError("IMPORTED_SKILL_CHANGED");
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          const staged = path.join(root, `.import-${randomUUID()}`);
          try {
            await writeImportFiles(staged, publishedFiles, () => { assertPartner(partnerId); }); assertPartner(partnerId);
            await fs.rename(staged, destination); assertPartner(partnerId);
          } finally {
            const absolute = path.resolve(staged);
            if (absolute !== staged || path.dirname(absolute) !== path.resolve(root) || !path.basename(absolute).startsWith(".import-")) throw new AgentImportError("INVALID_TARGET");
            await fs.rm(absolute, { recursive: true, force: true });
          }
        }
        assertPartner(partnerId);
        await update(partnerId, value => { value.skillFiles[slug] = (item.files ?? []).map(file => ({ ...file, bytes: file.bytes.toString("base64") })); });
        if (packagePending(partner)) return;
        const id = `imported_skill_${fingerprint([partnerId, item.view.id]).slice(0, 40)}`;
        const existing = options.resources.list({ targetId: partner.homeTargetId }).find(resource => resource.id === id);
        const resource = existing ?? await options.resources.discover({ id, backendId: partner.capabilities.modelChain[0]!.backendId,
          importedSkill: { partnerId, requestId: selection.requestId, entryId: item.view.id },
          targetId: partner.homeTargetId, kind: "skill", scope: "project", name: redact(item.view.name), source: { kind: "local", path: destination }, workspaceRoot });
        assertPartner(partnerId);
        if (resource.state === "awaiting_approval") await options.resources.approve(resource.id, resource.discoveredRevision, `agent-import-${fingerprint(selection.requestId).slice(0, 32)}`);
        if (item.view.enabled !== false && !options.resources.get(id).enabled) await options.resources.setEnabled(id, true);
        assertPartner(partnerId);
        return;
      }
      if (item.view.category !== "memory" && item.view.category !== "personality") return;
      if (packagePending(partner)) {
        const home = await partners.prepareImportedHome(partnerId);
        const root = await prepareImportOwnedRoot(home, [".joko", "installed-knowledge"], () => { assertPartner(partnerId); });
        for (const document of documents(item)) {
          const file = path.join(root, `${fingerprint(document.id).slice(0, 32)}.md`);
          const bytes = Buffer.from(redact(document.text));
          try {
            const existing = await fs.lstat(file);
            if (!existing.isFile() || existing.isSymbolicLink() || !(await fs.readFile(file)).equals(bytes)) throw new AgentImportError("IMPORTED_MEMORY_CHANGED");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
          }
          await update(partnerId, value => { value.documents[document.id] = document.text; });
        }
        return;
      }
      if (snapshot.nativePackage && !options.memory.targetMemoryEnabled(partner.homeTargetId)) throw new AgentImportError("MEMORY_DISABLED");
      const docs = documents(item); let saved = 0, total = 0; let failure: AgentImportError | undefined;
      for (const file of [...(item.asset ? [item.asset] : []), ...(item.files ?? [])]) {
        const content = memoryFileContent({ ...file, executable: false });
        if (content.kind === "text") { docs.push({ id: `memory-${fingerprint([item.view.id, file.name]).slice(0, 32)}`, name: file.name, text: content.text, role: undefined }); continue; }
        if (content.kind === "empty") continue;
        total++;
        try {
          if (containsKnownCredential(file.bytes, publicationRedactions)) throw new AgentImportError("MEMORY_ORIGINAL_REQUIRES_PRIVATE_ACCESS");
          const artifact = await options.artifacts.ingestBytes(file.bytes, { fileName: redact(file.name), mimeType: sniffImportedMediaMime(file.bytes) ?? "application/octet-stream" });
          assertPartner(partnerId);
          const memoryRoot = await prepareImportOwnedRoot(store.getTarget(partner.homeTargetId).descriptor.workspaceRoot, [".joko", "imported-memory"], () => { assertPartner(partnerId); });
          const leaf = `${fingerprint([item.view.id, file.name]).slice(0, 32)}${path.extname(file.name).slice(0, 20)}`;
          const destination = path.join(memoryRoot, leaf);
          try {
            const existing = await fs.lstat(destination);
            if (!existing.isFile() || existing.isSymbolicLink() || !(await fs.readFile(destination)).equals(file.bytes)) throw new AgentImportError("IMPORTED_MEMORY_CHANGED");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            await writeImportFiles(memoryRoot, [{ name: leaf, bytes: file.bytes, executable: false }], () => { assertPartner(partnerId); });
          }
          assertPartner(partnerId);
          store.putArtifact({ id: `imported_memory_${fingerprint([partnerId, item.view.id, file.name, artifact.sha256]).slice(0, 40)}`,
            sha256: artifact.sha256, byteLength: artifact.byteLength, mimeType: artifact.mimeType, fileName: redact(file.name), storageKey: artifact.storagePath,
            sessionId: partner.canonicalSessionId!, traceId: `agent-import-${fingerprint(selection.requestId).slice(0, 32)}`, purpose: "imported_memory" });
          docs.push({ id: `memory-${fingerprint([item.view.id, file.name]).slice(0, 32)}`, name: file.name,
            text: `${artifact.mimeType.startsWith("image/") ? "!" : ""}[${redact(file.name).replace(/[\[\]\r\n]/g, "")}](${`.joko/imported-memory/${leaf}`})`, role: undefined }); saved++;
        } catch { assertPartner(partnerId); failure ??= new AgentImportError("MEMORY_ATTACHMENT_FAILED"); }
      }
      for (const document of docs) {
        const parts = splitImportedMemoryText(redact(document.text)); total += parts.length;
        try { await writeDocument(partnerId, document); saved += parts.length; }
        catch (error) { assertPartner(partnerId); saved += (error as { importProgress?: { saved: number } }).importProgress?.saved ?? 0;
          failure ??= error instanceof AgentImportError ? error : new AgentImportError("MEMORY_WRITE_FAILED"); }
      }
      await applyProfile(partnerId, selected);
      if (failure) throw Object.assign(failure, { importProgress: { saved, total } });
    },
    async saveEnvironment(partnerId: string, items: ImportItem[]) {
      assertPartner(partnerId); const chosen = new Set(items.map(item => item.view.id)); const env = selectedImportEnvironment(items);
      await update(partnerId, value => {
        value.env = env;
        value.mcp = items.flatMap(item => {
          if (!item.mcp || item.captureIssue || item.view.issues?.length || item.view.dependsOn?.some(id => !chosen.has(id))) return [];
          const server = resolveImportReferences(item.mcp, env) as NonNullable<ImportItem["mcp"]>;
          if (server.command && server.cwd !== undefined) server.cwd = path.resolve(snapshot.source.workspace, server.cwd);
          return [server];
        });
        value.credentials = items.flatMap(item => item.credential && !item.captureIssue && !item.view.dependsOn?.some(id => !chosen.has(id))
          && (!item.view.issues?.length || item.credential.format !== "telegram") ? [{ id: item.view.id, ...item.credential,
            ...(item.credential.format === "telegram" ? { value: resolveImportReferences(item.credential.value, env) } : {}) }] : []);
        for (const item of items) {
          for (const document of documents(item)) value.documents[document.id] = document.text;
          for (const file of [...(item.asset ? [item.asset] : []), ...(item.files ?? [])]) {
            if (item.view.category === "memory" || item.view.category === "personality") value.memoryFiles[`${item.view.id}/${file.name}`] = file.bytes.toString("base64");
            else if (item.asset) { value.files[file.name] = file.bytes.toString("base64"); value.fileExecutables[file.name] = file.executable === true; }
          }
          if (item.view.category === "skills") value.skillFiles[skillSlug(item)] = (item.files ?? []).map(file => ({ ...file, bytes: file.bytes.toString("base64") }));
        }
        value.sourceAutomations = snapshot.source.kind === "package" ? [] : items.flatMap(item => item.automation ? [{ entryId: item.view.id, kind: snapshot.source.kind as "hermes" | "openclaw", original: item.automation.original }] : []);
        value.contentRedactions = retainedImportRedactions(items, publicationRedactions);
      });
      await applyProfile(partnerId, items);
    },
    async createConversation(partnerId: string) { return assertPartner(partnerId).canonicalSessionId; },
    async createRoutine(partnerId: string, input: ImportedRoutineInput, creationId: string, item: ImportItem) {
      const partner = assertPartner(partnerId); if (!item.automation) throw new AgentImportError("SOURCE_AUTOMATION_INVALID");
      const routineId = routines.creationId(partnerId, creationId);
      if (snapshot.source.kind !== "package") await update(partnerId, value => { value.automations[routineId] ??= { kind: snapshot.source.kind as "hermes" | "openclaw", original: item.automation!.original,
        sourceRoot: snapshot.source.root, sourceWorkspace: snapshot.source.workspace, sourceId: item.automation!.sourceId,
        handover: item.view.enabled ? "pending" : "ready", issues: [...(item.view.issues ?? [])], deliveries: item.automation!.deliveries,
        completed: Number((item.automation!.original.repeat as { completed?: unknown } | undefined)?.completed ?? 0) || 0 }; });
      const routine = snapshot.nativePackage
        ? await routines.installPackage(partnerId, publicRoutine({ ...input, enabled: false }), creationId, () => { assertPartner(partnerId); })
        : await routines.save({ partnerId, partnerRevision: partner.revision, requestId: creationId, definition: publicRoutine({ ...input, enabled: false }) });
      assertPartner(partnerId); return routine.id;
    },
    verifyAutomation: (partnerId: string, item: ImportItem) => verifyImportedAutomation(partnerId, item, () => { assertPartner(partnerId); }, options.verification, selected, snapshot.source.root),
    pauseSource: (item: ImportItem, source: typeof snapshot, resumeInterrupted: boolean) => changeSourceAutomationState(source.source, item, false,
      { home: options.home, env: options.environment, assertOwner: () => { assertPartner(importedPartnerId(selection.requestId)); }, parseRoutineInput,
        readCronDatabase: input => readOpenClawCronDatabase(input, () => { assertPartner(importedPartnerId(selection.requestId)); }) },
      () => { assertPartner(importedPartnerId(selection.requestId)); }, resumeInterrupted, selectedImportEnvironment(selected)),
    resumeSource: (item: ImportItem, source: typeof snapshot) => changeSourceAutomationState(source.source, item, true,
      { home: options.home, env: options.environment, assertOwner: () => { assertPartner(importedPartnerId(selection.requestId)); }, parseRoutineInput,
        readCronDatabase: input => readOpenClawCronDatabase(input, () => { assertPartner(importedPartnerId(selection.requestId)); }) },
      () => { assertPartner(importedPartnerId(selection.requestId)); }, false, selectedImportEnvironment(selected)),
    async enableRoutine(partnerId: string, routineId: string, item: ImportItem) {
      const partner = assertPartner(partnerId); const value = await environment(partnerId); const binding = value?.automations[routineId];
      if (!binding) throw new AgentImportError("AUTOMATION_NOT_FOUND"); if (binding.handover === "ready") return;
      const routine = routines.list(partnerId).find(row => row.id === routineId);
      if (!routine || !item.automation || JSON.stringify(parseRoutineInput({ ...routine, enabled: false })) !== JSON.stringify(publicRoutine({ ...item.automation.input, enabled: false }))) throw new AgentImportError("TARGET_AUTOMATION_CHANGED");
      const expected = parseRoutineInput({ ...routine, enabled: true });
      if (!routine.enabled && expected.triggers.some(trigger => trigger.kind === "once" && trigger.at <= Date.now())) throw new AgentImportError("AUTOMATION_TIME_PASSED");
      try { await routines.activateImported({ partnerId, partnerRevision: partner.revision, routineId, revision: routine.revision, definition: expected }); }
      catch (error) {
        assertPartner(partnerId); const saved = routines.list(partnerId).find(row => row.id === routineId);
        if (!saved || JSON.stringify(parseRoutineInput(saved)) !== JSON.stringify(expected)) throw error;
      }
      try { await update(partnerId, value => { value.automations[routineId]!.handover = "ready"; }); }
      catch { throw new AgentImportError("TARGET_HANDOVER_UNCERTAIN"); }
    },
  };
}

export function splitImportedMemoryText(text: string): string[] {
  if (!text.trim()) return [];
  const parts: string[] = []; let part = "";
  for (const character of text) { if (part.length + character.length > 8_000) { parts.push(part); part = ""; } part += character; }
  if (part) parts.push(part); return parts;
}
function profilePrefix(text: string, maximum: number): string {
  let end = Math.min(text.length, maximum); if (end && end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--; return text.slice(0, end).trim();
}
function singleLine(text: string, maximum: number): string { return text.replace(/[\r\n\t\u0000-\u001f]/g, " ").trim().slice(0, maximum); }
function containsKnownCredential(bytes: Buffer, values: Record<string, string>): boolean {
  return Object.values(values).filter(Boolean).some(value => bytes.includes(Buffer.from(value, "utf8")) || bytes.includes(Buffer.from(value, "utf16le")));
}
function importProfileFingerprint(profile: PartnerProfileRecord): string {
  return fingerprint([profile.id, profile.displayName, profile.avatar, profile.templateId, profile.identitySource, profile.homeTargetId,
    profile.canonicalSessionId, profile.capabilities, profile.usesDirectoryDefaults]);
}
function importIdentityFingerprint(profile: PartnerProfileRecord): string {
  return fingerprint([profile.id, profile.displayName, profile.avatar, profile.templateId, profile.identitySource, profile.homeTargetId, profile.canonicalSessionId]);
}
function captureImportOwner(profile: PartnerProfileRecord, store: OperationalStore): NonNullable<ImportedEnvironment["targetOwner"]> {
  const session = store.getSession(profile.canonicalSessionId!).descriptor;
  return { revision: profile.revision.toString(), profileVersion: profile.profileVersion, sessionId: session.id, generation: session.binding.generation,
    workspaceRoot: store.getTarget(profile.homeTargetId).descriptor.workspaceRoot, profileFingerprint: importProfileFingerprint(profile), identityFingerprint: importIdentityFingerprint(profile) };
}

async function prepareImportSkillRoot(workspaceRoot: string, assertOwner: () => void): Promise<string> {
  return prepareImportOwnedRoot(workspaceRoot, [".agents", "skills"], assertOwner);
}
async function prepareImportOwnedRoot(workspaceRoot: string, parts: readonly string[], assertOwner: () => void): Promise<string> {
  const root = path.resolve(workspaceRoot); assertOwner();
  if (await fs.realpath(root) !== root) throw new AgentImportError("INVALID_TARGET");
  let current = root;
  for (const part of parts) {
    current = path.join(current, part); assertOwner();
    try { await fs.mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = await fs.lstat(current); assertOwner();
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(current) !== current) throw new AgentImportError("INVALID_TARGET");
  }
  assertOwner(); return current;
}
