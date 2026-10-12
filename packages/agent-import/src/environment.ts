import { fingerprint } from "./files.js";
import { decodeEnvironment, encodeEnvironment } from "./environmentJson.js";
import { AgentImportError, type AgentImportSelection, type ImportSource, type ImportedDelivery, type ImportedMcpServer } from "./types.js";

/** Private encrypted truth; no source bodies or secrets enter Workspace or public receipts. */
export interface ImportedEnvironment {
  version: 1;
  source: ImportSource;
  env: Record<string, string>;
  mcp: ImportedMcpServer[];
  credentials: Array<{ id: string; format: string; value: unknown }>;
  files: Record<string, string>;
  fileExecutables: Record<string, boolean>;
  memoryFiles: Record<string, string>;
  skillFiles: Record<string, Array<{ name: string; bytes: string; executable: boolean; interpreterLink?: string }>>;
  documents: Record<string, string>;
  appliedDocuments: string[];
  profileProjection: { identity: string; user: string; instructions: string };
  targetOwner?: { revision: string; profileVersion: number; sessionId: string; generation: number; workspaceRoot: string; profileFingerprint: string; identityFingerprint: string };
  profileUpdate?: { fromRevision: string; expectedFingerprint: string };
  contentRedactions: Record<string, string>;
  sourceAutomations: Array<{ entryId: string; kind: "hermes" | "openclaw"; original: Record<string, unknown> }>;
  pendingImport?: { selection: AgentImportSelection; snapshotJson: string; creationJson: string };
  automations: Record<string, {
    kind: "hermes" | "openclaw"; original: Record<string, unknown>; sourceRoot: string; sourceWorkspace: string; sourceId: string;
    handover: "pending" | "ready";
    issues: string[]; deliveries: ImportedDelivery[]; completed: number;
    lastRun?: string;
    deliveryProgress?: { runId: string; text: string; direct: boolean; deliveries: ImportedDelivery[]; next: number };
    monitorHash?: string; monitorOutput?: string;
    prepared?: { runId: string; prompt: string; direct?: string; skipped?: boolean; monitorHash?: string; monitorOutput?: string };
  }>;
}

/** Implemented by the service's authenticated, encrypted credential storage. */
export interface ImportSecretIo {
  read(key: string, assertOwner: () => void): Promise<string | null>;
  write(key: string, value: string, assertOwner: () => void): Promise<void>;
  remove(key: string, assertOwner: () => void): Promise<void>;
}
export const importedEnvironmentKey = (partnerId: string): string => `partner_import_environment_${fingerprint(partnerId)}`;

export function emptyImportedEnvironment(source: ImportSource): ImportedEnvironment {
  return { version: 1, source, env: {}, mcp: [], credentials: [], files: {}, fileExecutables: {}, memoryFiles: {},
    skillFiles: {}, documents: {}, appliedDocuments: [], profileProjection: { identity: "", user: "", instructions: "" }, contentRedactions: {}, sourceAutomations: [], automations: {} };
}

/** One serialization lane per Partner prevents a late write from recreating deleted material. */
export function createImportedEnvironmentStore(io: ImportSecretIo) {
  const lanes = new Map<string, Promise<unknown>>(); const retired = new Set<string>();
  const owner = (id: string, assertOwner: () => void): void => {
    assertOwner();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id) || retired.has(id)) throw new AgentImportError("IMPORT_OWNER_RETIRED");
  };
  const serialize = async <T>(id: string, assertOwner: () => void, run: () => Promise<T>): Promise<T> => {
    owner(id, assertOwner);
    const task = (lanes.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => { owner(id, assertOwner); return run(); });
    lanes.set(id, task);
    try { return await task; } finally { if (lanes.get(id) === task) lanes.delete(id); }
  };
  const read = async (id: string, assertOwner: () => void): Promise<ImportedEnvironment | undefined> => {
    owner(id, assertOwner); const text = await io.read(importedEnvironmentKey(id), assertOwner); owner(id, assertOwner);
    if (text === null) return undefined;
    try {
      const result = await decodeEnvironment<ImportedEnvironment>(text, assertOwner);
      validateImportedEnvironment(result); owner(id, assertOwner); return result;
    } catch { owner(id, assertOwner); throw new AgentImportError("CREDENTIAL_STORAGE_INVALID"); }
  };
  const write = async (id: string, value: ImportedEnvironment, assertOwner: () => void): Promise<void> => {
    owner(id, assertOwner); validateImportedEnvironment(value);
    const encoded = await encodeEnvironment(value, assertOwner); owner(id, assertOwner);
    await io.write(importedEnvironmentKey(id), encoded.text, assertOwner); owner(id, assertOwner);
    if (await io.read(importedEnvironmentKey(id), assertOwner) !== encoded.text) throw new AgentImportError("CREDENTIAL_STORAGE_FAILED");
    owner(id, assertOwner);
  };
  return {
    read: (id: string, assertOwner: () => void) => serialize(id, assertOwner, () => read(id, assertOwner)),
    write: (id: string, value: ImportedEnvironment, assertOwner: () => void) => serialize(id, assertOwner, () => write(id, value, assertOwner)),
    update: (id: string, assertOwner: () => void, mutate: (value: ImportedEnvironment) => void | Promise<void>) => serialize(id, assertOwner, async () => {
      const value = await read(id, assertOwner); if (!value) throw new AgentImportError("CREDENTIAL_STORAGE_UNAVAILABLE");
      await mutate(value); owner(id, assertOwner); await write(id, value, assertOwner);
    }),
    async remove(id: string, assertOwner: () => void): Promise<void> {
      assertOwner(); retired.add(id); await lanes.get(id)?.catch(() => {}); assertOwner();
      await io.remove(importedEnvironmentKey(id), assertOwner); assertOwner();
    },
  };
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function stringMap(value: unknown): boolean { return record(value) && Object.values(value).every(child => typeof child === "string"); }
/** Current-v1 required fields are explicit; omitted old records cannot acquire defaults. */
export function validateImportedEnvironment(value: unknown): asserts value is ImportedEnvironment {
  const fields = ["version", "source", "env", "mcp", "credentials", "files", "fileExecutables", "memoryFiles", "skillFiles", "documents", "appliedDocuments", "profileProjection", "contentRedactions", "sourceAutomations", "automations"];
  if (!record(value) || fields.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !fields.includes(key) && !["pendingImport", "targetOwner", "profileUpdate"].includes(key))
    || value.version !== 1 || !record(value.source) || !["hermes", "openclaw"].includes(String(value.source.kind))
    || ["agentId", "name", "root", "workspace", "configFile"].some(key => typeof (value.source as Record<string, unknown>)[key] !== "string")
    || !stringMap(value.env) || !stringMap(value.files) || !stringMap(value.memoryFiles) || !stringMap(value.documents) || !stringMap(value.contentRedactions)
    || !Array.isArray(value.appliedDocuments) || value.appliedDocuments.some(id => typeof id !== "string")
    || !record(value.profileProjection) || ["identity", "user", "instructions"].some(role => typeof (value.profileProjection as Record<string, unknown>)[role] !== "string")
    || value.targetOwner !== undefined && (!record(value.targetOwner) || typeof value.targetOwner.revision !== "string" || !/^\d+$/.test(value.targetOwner.revision)
      || !Number.isSafeInteger(value.targetOwner.profileVersion) || !Number.isSafeInteger(value.targetOwner.generation)
      || ["sessionId", "workspaceRoot", "profileFingerprint", "identityFingerprint"].some(key => typeof (value.targetOwner as Record<string, unknown>)[key] !== "string"))
    || value.profileUpdate !== undefined && (!record(value.profileUpdate) || typeof value.profileUpdate.fromRevision !== "string" || typeof value.profileUpdate.expectedFingerprint !== "string")
    || !Array.isArray(value.mcp) || !Array.isArray(value.credentials) || !Array.isArray(value.sourceAutomations) || !record(value.automations)
    || !record(value.fileExecutables) || Object.values(value.fileExecutables).some(child => typeof child !== "boolean")
    || !record(value.skillFiles) || Object.values(value.skillFiles).some(files => !Array.isArray(files) || files.some(file => !record(file)
      || typeof file.name !== "string" || typeof file.bytes !== "string" || typeof file.executable !== "boolean"))
    || value.pendingImport !== undefined && (!record(value.pendingImport) || typeof value.pendingImport.creationJson !== "string" || !value.pendingImport.creationJson || typeof value.pendingImport.snapshotJson !== "string" || !record(value.pendingImport.selection)
      || typeof value.pendingImport.selection.deferSetup !== "boolean")) throw new AgentImportError("CREDENTIAL_STORAGE_INVALID");
}
