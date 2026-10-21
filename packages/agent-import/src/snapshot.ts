import path from "node:path";
import { createImportBudget, MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES, reserveSnapshotItems } from "./files.js";
import { decodeEnvironment, encodeEnvironment } from "./environmentJson.js";
import { AgentImportError, validateNativePartnerPackage, type ImportItem, type ImportSnapshot } from "./types.js";

/** Binary fields have one current encoding, bounded before Buffer allocation. */
export async function serializeImportSnapshotAsync(snapshot: ImportSnapshot, assertOwner: () => void): Promise<string> {
  await reserveSnapshotItems(snapshot.items, createImportBudget(MAX_SNAPSHOT_BYTES, assertOwner), assertOwner);
  const items: unknown[] = []; const encode = (bytes: Buffer) => ({ encoding: "base64", data: bytes.toString("base64") });
  for (const item of snapshot.items) {
    assertOwner(); const files: unknown[] = [];
    for (const file of item.files ?? []) {
      assertOwner(); files.push({ ...file, bytes: encode(file.bytes) }); await new Promise<void>(resolve => setImmediate(resolve));
    }
    items.push({ ...item, ...(item.files ? { files } : {}), ...(item.asset ? { asset: { ...item.asset, bytes: encode(item.asset.bytes) } } : {}) });
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return (await encodeEnvironment({ version: 1, ...snapshot, items }, assertOwner)).text;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function fail(): never { throw new AgentImportError("CREDENTIAL_STORAGE_INVALID"); }
function nativePath(value: unknown): value is string { return typeof value === "string" && !value.includes("\0") && path.isAbsolute(value); }

export async function deserializeImportSnapshotAsync(text: string, assertOwner: () => void): Promise<ImportSnapshot> {
  assertOwner(); if (Buffer.byteLength(text) > 2 * MAX_SNAPSHOT_BYTES) fail();
  let value: unknown; try { value = await decodeEnvironment<unknown>(text, assertOwner); } catch { assertOwner(); fail(); }
  if (!record(value) || !fields(value, ["version", "source", "items", "fingerprint"], ["avatarImageBase64", "publicationRedactions", "nativePackage"])
    || value.version !== 1 || !Array.isArray(value.items) || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
    || !record(value.source) || !fields(value.source, ["kind", "agentId", "name", "root", "workspace", "configFile"])
    || !["hermes", "openclaw", "package"].includes(String(value.source.kind)) || typeof value.source.agentId !== "string" || typeof value.source.name !== "string"
    || !nativePath(value.source.root) || !nativePath(value.source.workspace) || !nativePath(value.source.configFile)) fail();
  const budget = createImportBudget(MAX_SNAPSHOT_BYTES, assertOwner);
  if (value.nativePackage !== undefined) {
    validateNativePartnerPackage(value.nativePackage);
    if (value.source.kind !== "package" || value.source.agentId !== value.nativePackage.packageId || value.fingerprint !== value.nativePackage.packageHash) fail();
  } else if (value.source.kind === "package") fail();
  const bytes = (input: unknown): Buffer => {
    if (!record(input) || !fields(input, ["encoding", "data"]) || input.encoding !== "base64" || typeof input.data !== "string"
      || input.data.length > 4 * Math.ceil(MAX_FILE_BYTES / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) fail();
    const size = input.data.length / 4 * 3 - (input.data.endsWith("==") ? 2 : input.data.endsWith("=") ? 1 : 0);
    if (size > MAX_FILE_BYTES) fail(); budget.reserveFile(size);
    const decoded = Buffer.from(input.data, "base64"); if (decoded.toString("base64") !== input.data) fail(); return decoded;
  };
  const ids = new Set<string>(); const indexes = new Set<number>();
  const itemFields = ["sourceIndex", "files", "sourceDirectory", "sourceAlias", "sourceFile", "documents", "filesComplete", "captureIssue", "text", "role", "env", "envDependencies", "mcp", "credential", "asset", "automation"];
  for (const input of value.items) {
    assertOwner();
    if (!record(input) || !fields(input, ["view", "sourceIndex"], itemFields) || !record(input.view)
      || !fields(input.view, ["id", "category", "name", "selected"], ["description", "enabled", "dependsOn", "exclusiveWith", "issues"])
      || typeof input.view.id !== "string" || ids.has(input.view.id) || typeof input.view.name !== "string" || typeof input.view.selected !== "boolean"
      || !["personality", "memory", "skills", "connections", "automations"].includes(String(input.view.category))
      || !Number.isSafeInteger(input.sourceIndex) || Number(input.sourceIndex) < 0 || indexes.has(Number(input.sourceIndex))) fail();
    ids.add(input.view.id); indexes.add(Number(input.sourceIndex));
    if (input.sourceFile !== undefined && (!record(input.sourceFile) || !fields(input.sourceFile, ["root", "file", "kind"], ["logicalPrefix", "sharedDocumentRoots"])
      || !nativePath(input.sourceFile.root) || !nativePath(input.sourceFile.file) || !["file", "directory", "unknown"].includes(String(input.sourceFile.kind)))) fail();
    if (input.files !== undefined) {
      if (!Array.isArray(input.files)) fail();
      for (const file of input.files) {
        assertOwner();
        if (!record(file) || !fields(file, ["name", "bytes", "executable"], ["interpreterLink"]) || typeof file.name !== "string" || typeof file.executable !== "boolean") fail();
        file.bytes = bytes(file.bytes); await new Promise<void>(resolve => setImmediate(resolve));
      }
    }
    if (input.asset !== undefined) {
      if (!record(input.asset) || !fields(input.asset, ["name", "bytes"], ["executable"]) || typeof input.asset.name !== "string") fail();
      input.asset.bytes = bytes(input.asset.bytes);
    }
    if (input.automation !== undefined && (!record(input.automation)
      || !fields(input.automation, ["sourceId", "input", "original", "fingerprint", "deliveries"])
      || typeof input.automation.sourceId !== "string" || !record(input.automation.input) || !record(input.automation.original)
      || typeof input.automation.fingerprint !== "string" || !Array.isArray(input.automation.deliveries))) fail();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  const { version: _version, ...snapshot } = value;
  const result = snapshot as unknown as ImportSnapshot;
  await reserveSnapshotItems(result.items, createImportBudget(MAX_SNAPSHOT_BYTES, assertOwner), assertOwner);
  assertOwner(); return result;
}

/** Selected checkpoints retain original preview indexes, independent of storage order. */
export function indexImportSnapshot(snapshot: ImportSnapshot): ImportSnapshot {
  return { ...snapshot, items: snapshot.items.map((item, sourceIndex): ImportItem => ({ ...item, sourceIndex })) };
}
