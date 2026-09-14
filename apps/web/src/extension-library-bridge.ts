import type { ExtensionLibraryCallView, ExtensionLibrarySqlStatementView, ExtensionLibrarySqlValueView } from "./model.js";

export const EXTENSION_LIBRARY_BRIDGE_REQUEST = "joko:extension-library-request";
export const EXTENSION_LIBRARY_BRIDGE_RESPONSE = "joko:extension-library-response";
export const EXTENSION_LIBRARY_BRIDGE_VERSION = 1;

export type ExtensionLibraryBridgeCommand =
  | { readonly kind: "capabilities" | "open" | "status" }
  | { readonly kind: "reveal"; readonly path: string }
  | { readonly kind: "saveAs"; readonly path: string; readonly name?: string }
  | { readonly kind: "clipboardWrite"; readonly content: Uint8Array }
  | { readonly kind: "call"; readonly call: ExtensionLibraryCallView };

export interface ExtensionLibraryBridgeRequest {
  readonly id: string;
  readonly command: ExtensionLibraryBridgeCommand;
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HANDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const PORTABLE_SEGMENT = /^[A-Za-z0-9_@][A-Za-z0-9_@.+ -]*$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const SQLITE_SIDECAR = /\.sqlite-(?:wal|shm|journal)$/iu;
const MAXIMUM_INLINE_BYTES = 16 * 1024 * 1024;

export function parseExtensionLibraryBridgeRequest(value: unknown): ExtensionLibraryBridgeRequest | undefined {
  if (!plain(value) || !exact(value, ["type", "version", "id", "operation"])
    || value.type !== EXTENSION_LIBRARY_BRIDGE_REQUEST || value.version !== EXTENSION_LIBRARY_BRIDGE_VERSION
    || typeof value.id !== "string" || !REQUEST_ID.test(value.id)) return undefined;
  const command = parseOperation(value.operation);
  return command === undefined ? undefined : { id: value.id, command };
}

export function extensionLibraryBridgeCapabilities(nativeOperations: readonly string[] = []): Readonly<{
  version: 1;
  operations: readonly string[];
}> {
  return Object.freeze({
    version: 1,
    operations: Object.freeze([
      "capabilities", "open", "status", "read", "write", "stat", "list", "mkdir", "delete", "rename",
      "writeBegin", "writeChunk", "writeCommit", "writeAbort", "sqlOpen", "sqlExecute", "sqlBatch",
      "sqlMigrate", "sqlBackup", "sqlCheck", "sqlClose", ...nativeOperations
    ])
  });
}

function parseOperation(value: unknown): ExtensionLibraryBridgeCommand | undefined {
  if (!plain(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "capabilities" || value.kind === "open" || value.kind === "status") {
    return exact(value, ["kind"]) ? { kind: value.kind } : undefined;
  }
  if (value.kind === "reveal") {
    if (!exact(value, ["kind", "path"])) return undefined;
    const path = portablePath(value.path);
    return path === undefined ? undefined : { kind: "reveal", path };
  }
  if (value.kind === "saveAs") {
    if (!exact(value, ["kind", "path", "name"], ["name"])) return undefined;
    const path = portablePath(value.path);
    if (path === undefined || value.name !== undefined && !safeFileName(value.name)) return undefined;
    return { kind: "saveAs", path, ...(value.name === undefined ? {} : { name: value.name as string }) };
  }
  if (value.kind === "clipboardWrite") {
    if (!exact(value, ["kind", "content"]) || !(value.content instanceof Uint8Array)
      || value.content.byteLength === 0 || value.content.byteLength > MAXIMUM_INLINE_BYTES) return undefined;
    return { kind: "clipboardWrite", content: new Uint8Array(value.content) };
  }
  const call = parseCall(value);
  return call === undefined ? undefined : { kind: "call", call };
}

function parseCall(value: Record<string, unknown>): ExtensionLibraryCallView | undefined {
  switch (value.kind) {
    case "read": {
      if (!exact(value, ["kind", "path", "offset", "length"], ["offset", "length"])) return undefined;
      const path = portablePath(value.path);
      const offset = optionalBigint(value.offset);
      const length = optionalBigint(value.length);
      return path === undefined || offset === null || length === null ? undefined : {
        kind: "read", path, ...(offset === undefined ? {} : { offset }), ...(length === undefined ? {} : { length })
      };
    }
    case "write": {
      if (!exact(value, ["kind", "path", "content", "ifNotExists"], ["ifNotExists"])) return undefined;
      const path = portablePath(value.path);
      return path === undefined || !(value.content instanceof Uint8Array) || value.content.byteLength > MAXIMUM_INLINE_BYTES
        || !optionalBoolean(value.ifNotExists)
        ? undefined
        : { kind: "write", path, content: new Uint8Array(value.content), ...(value.ifNotExists === true ? { ifNotExists: true } : {}) };
    }
    case "stat":
    case "mkdir": {
      if (!exact(value, ["kind", "path"])) return undefined;
      const path = portablePath(value.path);
      return path === undefined ? undefined : { kind: value.kind, path };
    }
    case "list": {
      if (!exact(value, ["kind", "path", "recursive", "limit", "cursor"], ["path", "recursive", "limit", "cursor"])) return undefined;
      const path = value.path === undefined ? undefined : portablePath(value.path);
      if (value.path !== undefined && path === undefined || !optionalBoolean(value.recursive)
        || value.limit !== undefined && (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 500)
        || value.cursor !== undefined && (typeof value.cursor !== "string" || value.cursor.length === 0 || value.cursor.length > 2048)) return undefined;
      return {
        kind: "list", ...(path === undefined ? {} : { path }), ...(value.recursive === true ? { recursive: true } : {}),
        ...(value.limit === undefined ? {} : { limit: value.limit as number }), ...(value.cursor === undefined ? {} : { cursor: value.cursor as string })
      };
    }
    case "delete": {
      if (!exact(value, ["kind", "path", "recursive"], ["recursive"]) || !optionalBoolean(value.recursive)) return undefined;
      const path = portablePath(value.path);
      return path === undefined ? undefined : { kind: "delete", path, ...(value.recursive === true ? { recursive: true } : {}) };
    }
    case "rename": {
      if (!exact(value, ["kind", "from", "to", "overwrite"], ["overwrite"]) || !optionalBoolean(value.overwrite)) return undefined;
      const from = portablePath(value.from);
      const to = portablePath(value.to);
      return from === undefined || to === undefined ? undefined : { kind: "rename", from, to, ...(value.overwrite === true ? { overwrite: true } : {}) };
    }
    case "writeBegin": {
      if (!exact(value, ["kind", "path", "totalBytes", "sha256", "ifNotExists"], ["sha256", "ifNotExists"]) || !optionalBoolean(value.ifNotExists)) return undefined;
      const path = portablePath(value.path);
      const totalBytes = requiredBigint(value.totalBytes);
      if (path === undefined || totalBytes === undefined || value.sha256 !== undefined && (typeof value.sha256 !== "string" || !HASH.test(value.sha256))) return undefined;
      return { kind: "writeBegin", path, totalBytes, ...(value.sha256 === undefined ? {} : { sha256: value.sha256 as string }), ...(value.ifNotExists === true ? { ifNotExists: true } : {}) };
    }
    case "writeChunk": {
      if (!exact(value, ["kind", "streamId", "sequence", "content"]) || !safeId(value.streamId)
        || !Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0 || !(value.content instanceof Uint8Array)
        || value.content.byteLength > MAXIMUM_INLINE_BYTES) return undefined;
      return { kind: "writeChunk", streamId: value.streamId as string, sequence: value.sequence as number, content: new Uint8Array(value.content) };
    }
    case "writeCommit":
    case "writeAbort": {
      return exact(value, ["kind", "streamId"]) && safeId(value.streamId)
        ? { kind: value.kind, streamId: value.streamId as string }
        : undefined;
    }
    case "sqlOpen": {
      if (!exact(value, ["kind", "path", "create", "readOnly"], ["create", "readOnly"])
        || !optionalBoolean(value.create) || !optionalBoolean(value.readOnly)) return undefined;
      const path = portablePath(value.path);
      return path === undefined || !path.toLowerCase().endsWith(".sqlite") ? undefined : {
        kind: "sqlOpen", path, ...(value.create === true ? { create: true } : {}), ...(value.readOnly === true ? { readOnly: true } : {})
      };
    }
    case "sqlExecute": {
      if (!exact(value, ["kind", "handleId", "statement"]) || !safeId(value.handleId)) return undefined;
      const statement = parseStatement(value.statement);
      return statement === undefined ? undefined : { kind: "sqlExecute", handleId: value.handleId as string, statement };
    }
    case "sqlBatch": {
      if (!exact(value, ["kind", "handleId", "statements"]) || !safeId(value.handleId)
        || !Array.isArray(value.statements) || value.statements.length === 0 || value.statements.length > 100) return undefined;
      const statements = value.statements.map(parseStatement);
      return statements.some((statement) => statement === undefined)
        ? undefined
        : { kind: "sqlBatch", handleId: value.handleId as string, statements: statements as ExtensionLibrarySqlStatementView[] };
    }
    case "sqlMigrate": {
      if (!exact(value, ["kind", "handleId", "migrations"]) || !safeId(value.handleId)
        || !Array.isArray(value.migrations) || value.migrations.length === 0 || value.migrations.length > 100) return undefined;
      const migrations: Array<{ version: number; statements: string[] }> = [];
      for (const migration of value.migrations) {
        if (!plain(migration) || !exact(migration, ["version", "statements"])
          || !Number.isSafeInteger(migration.version) || (migration.version as number) < 1
          || !Array.isArray(migration.statements) || migration.statements.length === 0
          || migration.statements.some((sql) => typeof sql !== "string" || sql.length === 0 || sql.length > 100_000)) return undefined;
        migrations.push({ version: migration.version as number, statements: migration.statements as string[] });
      }
      return { kind: "sqlMigrate", handleId: value.handleId as string, migrations };
    }
    case "sqlBackup": {
      if (!exact(value, ["kind", "handleId", "targetPath"]) || !safeId(value.handleId)) return undefined;
      const targetPath = portablePath(value.targetPath);
      return targetPath === undefined || !targetPath.toLowerCase().endsWith(".sqlite")
        ? undefined
        : { kind: "sqlBackup", handleId: value.handleId as string, targetPath };
    }
    case "sqlCheck":
    case "sqlClose":
      return exact(value, ["kind", "handleId"]) && safeId(value.handleId)
        ? { kind: value.kind, handleId: value.handleId as string }
        : undefined;
    default:
      return undefined;
  }
}

function parseStatement(value: unknown): ExtensionLibrarySqlStatementView | undefined {
  if (!plain(value) || !exact(value, ["sql", "parameters"], ["parameters"])
    || typeof value.sql !== "string" || value.sql.length === 0 || value.sql.length > 100_000
    || value.parameters !== undefined && (!Array.isArray(value.parameters) || value.parameters.length > 500)) return undefined;
  const parameters = value.parameters === undefined ? undefined : value.parameters.map(parseSqlValue);
  return parameters?.some((parameter) => parameter === undefined) === true
    ? undefined
    : { sql: value.sql, ...(parameters === undefined ? {} : { parameters: parameters as ExtensionLibrarySqlValueView[] }) };
}

function parseSqlValue(value: unknown): ExtensionLibrarySqlValueView | undefined {
  if (!plain(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "null") return exact(value, ["kind"]) ? { kind: "null" } : undefined;
  if (!exact(value, ["kind", "value"])) return undefined;
  if (value.kind === "number" && typeof value.value === "number" && Number.isFinite(value.value)) return { kind: "number", value: value.value };
  if (value.kind === "integer") {
    const integer = requiredBigint(value.value, true);
    return integer === undefined ? undefined : { kind: "integer", value: integer };
  }
  if (value.kind === "text" && typeof value.value === "string" && value.value.length <= 16 * 1024 * 1024) return { kind: "text", value: value.value };
  if (value.kind === "blob" && value.value instanceof Uint8Array && value.value.byteLength <= 16 * 1024 * 1024) return { kind: "blob", value: new Uint8Array(value.value) };
  return undefined;
}

function portablePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value !== value.trim()
    || value.includes("\\") || value.includes(":") || value.startsWith("/")) return undefined;
  const segments = value.split("/");
  return segments.length > 32 || segments.some((segment) => segment === "" || segment === "." || segment === ".."
    || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(" ") || !PORTABLE_SEGMENT.test(segment)
    || WINDOWS_RESERVED.test(segment) || SQLITE_SIDECAR.test(segment)) ? undefined : value;
}

function safeFileName(value: unknown): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= 255 && value === value.trim()
    && !/[\u0000-\u001f\u007f<>:"\/\\|?*]/u.test(value) && !value.startsWith(".")
    && !value.endsWith(".") && !value.endsWith(" ") && !WINDOWS_RESERVED.test(value);
}

function optionalBigint(value: unknown): bigint | undefined | null {
  return value === undefined ? undefined : requiredBigint(value) ?? null;
}

function requiredBigint(value: unknown, signed = false): bigint | undefined {
  if (typeof value === "bigint") return signed || value >= 0n ? value : undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && (signed || value >= 0)) return BigInt(value);
  return undefined;
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function safeId(value: unknown): boolean {
  return typeof value === "string" && HANDLE_ID.test(value);
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value: Record<string, unknown>, keys: readonly string[], optional: readonly string[] = []): boolean {
  const required = keys.filter((key) => !optional.includes(key));
  return Object.keys(value).every((key) => keys.includes(key)) && required.every((key) => key in value);
}
