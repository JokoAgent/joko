import { create } from "@bufbuild/protobuf";
import {
  ExtensionLibraryCallSchema, ExtensionLibraryEntryKind as ProtoExtensionLibraryEntryKind,
  type ExtensionLibraryCallResult as ProtoExtensionLibraryCallResult,
  type ExtensionLibraryEntry as ProtoExtensionLibraryEntry,
  type ExtensionLibrarySqlResult as ProtoExtensionLibrarySqlResult,
  type ExtensionLibrarySqlValue as ProtoExtensionLibrarySqlValue,
  type ExtensionLibrarySession as ProtoExtensionLibrarySession
} from "@joko/contracts";

export interface MobileExtensionLibrarySession {
  readonly id: string;
  readonly extensionId: string;
  readonly expiresAt: number;
  readonly bindingGeneration: bigint;
  readonly limits: {
    readonly maximumReadBytes: bigint;
    readonly maximumWriteBytes: bigint;
    readonly maximumStreamBytes: bigint;
    readonly maximumPathCharacters: number;
    readonly maximumPathSegments: number;
    readonly maximumListPageSize: number;
    readonly maximumFiles: number;
    readonly softLimitBytes: bigint;
    readonly diskReserveBytes: bigint;
  };
}

export interface MobileExtensionLibraryEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly bytes: bigint;
  readonly modifiedAt: number;
}

export type MobileExtensionLibrarySqlValue =
  | { readonly kind: "null" }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "integer"; readonly value: bigint }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "blob"; readonly value: Uint8Array };

export interface MobileExtensionLibrarySqlStatement {
  readonly sql: string;
  readonly parameters?: readonly MobileExtensionLibrarySqlValue[];
}

export type MobileExtensionLibraryCall =
  | { readonly kind: "read"; readonly path: string; readonly offset?: bigint; readonly length?: bigint }
  | { readonly kind: "write"; readonly path: string; readonly content: Uint8Array; readonly ifNotExists?: boolean }
  | { readonly kind: "stat"; readonly path: string }
  | { readonly kind: "list"; readonly path?: string; readonly recursive?: boolean; readonly limit?: number; readonly cursor?: string }
  | { readonly kind: "mkdir"; readonly path: string }
  | { readonly kind: "delete"; readonly path: string; readonly recursive?: boolean }
  | { readonly kind: "rename"; readonly from: string; readonly to: string; readonly overwrite?: boolean }
  | { readonly kind: "writeBegin"; readonly path: string; readonly totalBytes: bigint; readonly sha256?: string; readonly ifNotExists?: boolean }
  | { readonly kind: "writeChunk"; readonly streamId: string; readonly sequence: number; readonly content: Uint8Array }
  | { readonly kind: "writeCommit"; readonly streamId: string }
  | { readonly kind: "writeAbort"; readonly streamId: string }
  | { readonly kind: "sqlOpen"; readonly path: string; readonly create?: boolean; readonly readOnly?: boolean }
  | { readonly kind: "sqlExecute"; readonly handleId: string; readonly statement: MobileExtensionLibrarySqlStatement }
  | { readonly kind: "sqlBatch"; readonly handleId: string; readonly statements: readonly MobileExtensionLibrarySqlStatement[] }
  | { readonly kind: "sqlMigrate"; readonly handleId: string; readonly migrations: readonly { readonly version: number; readonly statements: readonly string[] }[] }
  | { readonly kind: "sqlBackup"; readonly handleId: string; readonly targetPath: string }
  | { readonly kind: "sqlCheck" | "sqlClose"; readonly handleId: string };

export interface MobileExtensionLibrarySqlResult {
  readonly rows: readonly { readonly cells: readonly { readonly name: string; readonly value: MobileExtensionLibrarySqlValue }[] }[];
  readonly changes: bigint;
  readonly lastInsertRowId?: bigint;
}

export type MobileExtensionLibraryCallResult =
  | { readonly kind: "read"; readonly path: string; readonly content: Uint8Array; readonly sha256: string }
  | { readonly kind: "write"; readonly path: string; readonly bytes: bigint; readonly sha256: string }
  | { readonly kind: "stat"; readonly entry: MobileExtensionLibraryEntry }
  | { readonly kind: "list"; readonly entries: readonly MobileExtensionLibraryEntry[]; readonly nextCursor?: string }
  | { readonly kind: "path"; readonly path: string; readonly existed: boolean }
  | { readonly kind: "rename"; readonly from: string; readonly to: string }
  | { readonly kind: "stream"; readonly streamId: string; readonly receivedBytes: bigint; readonly nextSequence: number; readonly expiresAt?: number; readonly aborted: boolean }
  | { readonly kind: "sqlHandle"; readonly handleId: string; readonly path: string; readonly readOnly: boolean; readonly userVersion: number }
  | { readonly kind: "sqlResult"; readonly value: MobileExtensionLibrarySqlResult }
  | { readonly kind: "sqlBatch"; readonly results: readonly MobileExtensionLibrarySqlResult[] }
  | { readonly kind: "sqlVersion"; readonly userVersion: number; readonly path?: string }
  | { readonly kind: "boolean"; readonly value: boolean };


export const EXTENSION_LIBRARY_BRIDGE_REQUEST = "joko:extension-library-request";
export const EXTENSION_LIBRARY_BRIDGE_RESPONSE = "joko:extension-library-response";
export const EXTENSION_LIBRARY_BRIDGE_VERSION = 1;

export type MobileExtensionLibraryCommand =
  | { readonly kind: "capabilities" | "open" | "status" }
  | { readonly kind: "call"; readonly call: MobileExtensionLibraryCall };

export interface MobileExtensionLibraryRequest {
  readonly id: string;
  readonly command: MobileExtensionLibraryCommand;
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HANDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const PORTABLE_SEGMENT = /^[A-Za-z0-9_@][A-Za-z0-9_@.+ -]*$/u;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const SQLITE_SIDECAR = /\.sqlite-(?:wal|shm|journal)$/iu;
export const MAXIMUM_INLINE_BYTES = 16 * 1024 * 1024;

export function parseMobileExtensionLibraryRequest(value: unknown): MobileExtensionLibraryRequest | undefined {
  if (!plain(value) || !exact(value, ["type", "version", "id", "operation"])
    || value.type !== EXTENSION_LIBRARY_BRIDGE_REQUEST || value.version !== EXTENSION_LIBRARY_BRIDGE_VERSION
    || typeof value.id !== "string" || !REQUEST_ID.test(value.id)) return undefined;
  const command = parseOperation(value.operation);
  return command === undefined ? undefined : { id: value.id, command };
}

export function extensionLibraryBridgeCapabilities(): Readonly<{
  version: 1;
  operations: readonly string[];
}> {
  return Object.freeze({
    version: 1,
    operations: Object.freeze([
      "capabilities", "open", "status", "read", "write", "stat", "list", "mkdir", "delete", "rename",
      "writeBegin", "writeChunk", "writeCommit", "writeAbort", "sqlOpen", "sqlExecute", "sqlBatch",
      "sqlMigrate", "sqlBackup", "sqlCheck", "sqlClose"
    ])
  });
}

function parseOperation(value: unknown): MobileExtensionLibraryCommand | undefined {
  if (!plain(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "capabilities" || value.kind === "open" || value.kind === "status") {
    return exact(value, ["kind"]) ? { kind: value.kind } : undefined;
  }
  const call = parseCall(value);
  return call === undefined ? undefined : { kind: "call", call };
}

function parseCall(value: Record<string, unknown>): MobileExtensionLibraryCall | undefined {
  switch (value.kind) {
    case "read": {
      if (!exact(value, ["kind", "path", "offset", "length"], ["offset", "length"])) return undefined;
      const path = portablePath(value.path);
      const offset = optionalBigint(value.offset);
      const length = optionalBigint(value.length);
      return path === undefined || offset === null || length === null
        || length !== undefined && length > BigInt(MAXIMUM_INLINE_BYTES) ? undefined : {
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
      if (path === undefined || totalBytes === undefined || totalBytes > 8n * 1024n ** 3n
        || value.sha256 !== undefined && (typeof value.sha256 !== "string" || !HASH.test(value.sha256))) return undefined;
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
        : { kind: "sqlBatch", handleId: value.handleId as string, statements: statements as MobileExtensionLibrarySqlStatement[] };
    }
    case "sqlMigrate": {
      if (!exact(value, ["kind", "handleId", "migrations"]) || !safeId(value.handleId)
        || !Array.isArray(value.migrations) || value.migrations.length === 0 || value.migrations.length > 100) return undefined;
      const migrations: Array<{ version: number; statements: string[] }> = [];
      for (const migration of value.migrations) {
        if (!plain(migration) || !exact(migration, ["version", "statements"])
          || !Number.isSafeInteger(migration.version) || (migration.version as number) < 1 || (migration.version as number) > 0x7fffffff
          || !Array.isArray(migration.statements) || migration.statements.length === 0 || migration.statements.length > 100
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

function parseStatement(value: unknown): MobileExtensionLibrarySqlStatement | undefined {
  if (!plain(value) || !exact(value, ["sql", "parameters"], ["parameters"])
    || typeof value.sql !== "string" || value.sql.length === 0 || value.sql.length > 100_000
    || value.parameters !== undefined && (!Array.isArray(value.parameters) || value.parameters.length > 500)) return undefined;
  const parameters = value.parameters === undefined ? undefined : value.parameters.map(parseSqlValue);
  return parameters?.some((parameter) => parameter === undefined) === true
    ? undefined
    : { sql: value.sql, ...(parameters === undefined ? {} : { parameters: parameters as MobileExtensionLibrarySqlValue[] }) };
}

function parseSqlValue(value: unknown): MobileExtensionLibrarySqlValue | undefined {
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

export function portablePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value !== value.trim()
    || value.includes("\\") || value.includes(":") || value.startsWith("/")) return undefined;
  const segments = value.split("/");
  return segments.length > 32 || segments.some((segment) => segment === "" || segment === "." || segment === ".."
    || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(" ") || !PORTABLE_SEGMENT.test(segment)
    || WINDOWS_RESERVED.test(segment) || SQLITE_SIDECAR.test(segment)) ? undefined : value;
}

function optionalBigint(value: unknown): bigint | undefined | null {
  return value === undefined ? undefined : requiredBigint(value) ?? null;
}

function requiredBigint(value: unknown, signed = false): bigint | undefined {
  if (typeof value === "bigint") return value >= (signed ? -(2n ** 63n) : 0n)
    && value <= (signed ? 2n ** 63n - 1n : 2n ** 64n - 1n) ? value : undefined;
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
export function mapMobileExtensionLibraryCall(call: MobileExtensionLibraryCall) {
  const statement = (value: { readonly sql: string; readonly parameters?: readonly MobileExtensionLibrarySqlValue[] }) => ({
    sql: value.sql,
    parameters: (value.parameters ?? []).map(mapExtensionLibrarySqlValueInput)
  });
  switch (call.kind) {
    case "read": return create(ExtensionLibraryCallSchema, { operation: { case: "read", value: {
      path: call.path,
      ...(call.offset === undefined ? {} : { offset: call.offset }),
      ...(call.length === undefined ? {} : { length: call.length })
    } } });
    case "write": return create(ExtensionLibraryCallSchema, { operation: { case: "write", value: {
      path: call.path, content: call.content, ifNotExists: call.ifNotExists ?? false
    } } });
    case "stat": return create(ExtensionLibraryCallSchema, { operation: { case: "stat", value: { path: call.path } } });
    case "list": return create(ExtensionLibraryCallSchema, { operation: { case: "list", value: {
      ...(call.path === undefined ? {} : { path: call.path }),
      recursive: call.recursive ?? false,
      ...(call.limit === undefined ? {} : { limit: call.limit }),
      ...(call.cursor === undefined ? {} : { cursor: call.cursor })
    } } });
    case "mkdir": return create(ExtensionLibraryCallSchema, { operation: { case: "mkdir", value: { path: call.path } } });
    case "delete": return create(ExtensionLibraryCallSchema, { operation: { case: "delete", value: { path: call.path, recursive: call.recursive ?? false } } });
    case "rename": return create(ExtensionLibraryCallSchema, { operation: { case: "rename", value: { from: call.from, to: call.to, overwrite: call.overwrite ?? false } } });
    case "writeBegin": return create(ExtensionLibraryCallSchema, { operation: { case: "writeBegin", value: {
      path: call.path,
      totalBytes: call.totalBytes,
      ...(call.sha256 === undefined ? {} : { sha256: call.sha256 }),
      ifNotExists: call.ifNotExists ?? false
    } } });
    case "writeChunk": return create(ExtensionLibraryCallSchema, { operation: { case: "writeChunk", value: {
      streamId: call.streamId, sequence: call.sequence, content: call.content
    } } });
    case "writeCommit": return create(ExtensionLibraryCallSchema, { operation: { case: "writeCommit", value: { streamId: call.streamId } } });
    case "writeAbort": return create(ExtensionLibraryCallSchema, { operation: { case: "writeAbort", value: { streamId: call.streamId } } });
    case "sqlOpen": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlOpen", value: {
      path: call.path, create: call.create ?? false, readOnly: call.readOnly ?? false
    } } });
    case "sqlExecute": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlExecute", value: {
      handleId: call.handleId, statement: statement(call.statement)
    } } });
    case "sqlBatch": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlBatch", value: {
      handleId: call.handleId, statements: call.statements.map(statement)
    } } });
    case "sqlMigrate": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlMigrate", value: {
      handleId: call.handleId,
      migrations: call.migrations.map((migration) => ({ version: migration.version, statements: [...migration.statements] }))
    } } });
    case "sqlBackup": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlBackup", value: {
      handleId: call.handleId, targetPath: call.targetPath
    } } });
    case "sqlCheck": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlCheck", value: { handleId: call.handleId } } });
    case "sqlClose": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlClose", value: { handleId: call.handleId } } });
  }
}

function mapExtensionLibrarySqlValueInput(value: MobileExtensionLibrarySqlValue) {
  switch (value.kind) {
    case "null": return { value: { case: "nullValue" as const, value: true } };
    case "number": return { value: { case: "numberValue" as const, value: value.value } };
    case "integer": return { value: { case: "integerValue" as const, value: value.value.toString(10) } };
    case "text": return { value: { case: "textValue" as const, value: value.value } };
    case "blob": return { value: { case: "blobValue" as const, value: value.value } };
  }
}

export function projectMobileExtensionLibraryCallResult(value: ProtoExtensionLibraryCallResult): MobileExtensionLibraryCallResult {
  switch (value.result.case) {
    case "read":
      if (!portablePath(value.result.value.path) || !/^[a-f0-9]{64}$/u.test(value.result.value.sha256)) {
        throw new Error("Orchestrator returned an invalid Extension Library read result.");
      }
      return { kind: "read", path: value.result.value.path, content: Uint8Array.from(value.result.value.content), sha256: value.result.value.sha256 };
    case "write":
      if (!portablePath(value.result.value.path) || value.result.value.bytes < 0n || !/^[a-f0-9]{64}$/u.test(value.result.value.sha256)) {
        throw new Error("Orchestrator returned an invalid Extension Library write result.");
      }
      return { kind: "write", path: value.result.value.path, bytes: value.result.value.bytes, sha256: value.result.value.sha256 };
    case "stat": return { kind: "stat", entry: mapExtensionLibraryEntry(value.result.value) };
    case "list": return {
      kind: "list",
      entries: value.result.value.entries.map(mapExtensionLibraryEntry),
      ...(value.result.value.nextCursor === undefined ? {} : { nextCursor: value.result.value.nextCursor })
    };
    case "path":
      if (!portablePath(value.result.value.path)) throw new Error("Orchestrator returned an invalid Extension Library path result.");
      return { kind: "path", path: value.result.value.path, existed: value.result.value.existed };
    case "rename":
      if (!portablePath(value.result.value.from) || !portablePath(value.result.value.to)) {
        throw new Error("Orchestrator returned an invalid Extension Library rename result.");
      }
      return { kind: "rename", from: value.result.value.from, to: value.result.value.to };
    case "stream": {
      if (!/^library_stream_[a-f0-9]{32}$/u.test(value.result.value.streamId) || value.result.value.receivedBytes < 0n
        || !Number.isSafeInteger(value.result.value.nextSequence) || value.result.value.nextSequence < 0) {
        throw new Error("Orchestrator returned an invalid Extension Library stream result.");
      }
      return {
        kind: "stream",
        streamId: value.result.value.streamId,
        receivedBytes: value.result.value.receivedBytes,
        nextSequence: value.result.value.nextSequence,
        ...(value.result.value.expiresAt === undefined ? {} : { expiresAt: libraryTimestamp(value.result.value.expiresAt, "stream expiry") }),
        aborted: value.result.value.aborted
      };
    }
    case "sqlHandle":
      if (!HANDLE_ID.test(value.result.value.handleId) || !portablePath(value.result.value.path)
        || !value.result.value.path.toLowerCase().endsWith(".sqlite") || value.result.value.userVersion > 0x7fffffff) {
        throw new Error("Orchestrator returned an invalid Extension Library SQLite handle.");
      }
      return {
        kind: "sqlHandle",
        handleId: value.result.value.handleId,
        path: value.result.value.path,
        readOnly: value.result.value.readOnly,
        userVersion: value.result.value.userVersion
      };
    case "sqlResult": return { kind: "sqlResult", value: mapExtensionLibrarySqlResult(value.result.value) };
    case "sqlBatch": return { kind: "sqlBatch", results: value.result.value.results.map(mapExtensionLibrarySqlResult) };
    case "sqlVersion": return {
      kind: "sqlVersion",
      userVersion: value.result.value.userVersion,
      ...(value.result.value.path === undefined ? {} : { path: value.result.value.path })
    };
    case "boolean": return { kind: "boolean", value: value.result.value.value };
    default: throw new Error("Orchestrator returned an unknown Extension Library call result.");
  }
}

function mapExtensionLibraryEntry(value: ProtoExtensionLibraryEntry): MobileExtensionLibraryEntry {
  const kind = value.kind === ProtoExtensionLibraryEntryKind.FILE
    ? "file" as const
    : value.kind === ProtoExtensionLibraryEntryKind.DIRECTORY
      ? "directory" as const
      : undefined;
  if (kind === undefined || !portablePath(value.path) || value.bytes < 0n) {
    throw new Error("Orchestrator returned an invalid Extension Library entry.");
  }
  return { path: value.path, kind, bytes: value.bytes, modifiedAt: libraryTimestamp(value.modifiedAt, "entry modification") };
}

function mapExtensionLibrarySqlResult(value: ProtoExtensionLibrarySqlResult): MobileExtensionLibrarySqlResult {
  if (!/^(?:0|[1-9][0-9]{0,19})$/u.test(value.changes)
    || value.lastInsertRowId !== undefined && !/^-?(?:0|[1-9][0-9]{0,18})$/u.test(value.lastInsertRowId)) {
    throw new Error("Orchestrator returned invalid Extension Library SQLite counters.");
  }
  return {
    rows: value.rows.map((row) => ({ cells: row.cells.map((cell) => {
      if (cell.name.trim() === "" || cell.value === undefined) throw new Error("Orchestrator returned an invalid Extension Library SQLite cell.");
      return { name: cell.name, value: mapExtensionLibrarySqlValue(cell.value) };
    }) })),
    changes: BigInt(value.changes),
    ...(value.lastInsertRowId === undefined ? {} : { lastInsertRowId: BigInt(value.lastInsertRowId) })
  };
}

function mapExtensionLibrarySqlValue(value: ProtoExtensionLibrarySqlValue): MobileExtensionLibrarySqlValue {
  switch (value.value.case) {
    case "nullValue":
      if (!value.value.value) throw new Error("Orchestrator returned an invalid Extension Library SQLite null.");
      return { kind: "null" };
    case "numberValue":
      if (!Number.isFinite(value.value.value)) throw new Error("Orchestrator returned a non-finite Extension Library SQLite number.");
      return { kind: "number", value: value.value.value };
    case "integerValue":
      if (!/^-?(?:0|[1-9][0-9]{0,18})$/u.test(value.value.value)
        || requiredBigint(BigInt(value.value.value), true) === undefined) throw new Error("Orchestrator returned an invalid Extension Library SQLite integer.");
      return { kind: "integer", value: BigInt(value.value.value) };
    case "textValue": return { kind: "text", value: value.value.value };
    case "blobValue": return { kind: "blob", value: Uint8Array.from(value.value.value) };
    default: throw new Error("Orchestrator returned an empty Extension Library SQLite value.");
  }
}

export function libraryTimestamp(value: { readonly seconds: bigint; readonly nanos: number } | undefined, label: string): number {
  if (value === undefined || value.seconds < 0n || value.seconds > 8_640_000_000_000n
    || !Number.isInteger(value.nanos) || value.nanos < 0 || value.nanos >= 1_000_000_000) {
    throw new Error(`The node returned an invalid Library ${label}.`);
  }
  const time = Number(value.seconds) * 1000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(time) || time > 8_640_000_000_000_000) throw new Error(`The node returned an invalid Library ${label}.`);
  return time;
}

export function projectMobileExtensionLibrarySession(value: ProtoExtensionLibrarySession, expectedExtensionId: string): MobileExtensionLibrarySession {
  const expiresAt = libraryTimestamp(value.expiresAt, "session expiry");
  const generation = value.bindingGeneration?.value;
  const limits = value.limits;
  if (!/^library_session_[a-f0-9]{32}$/u.test(value.sessionId)
    || !/^extension_[a-f0-9]{32}$/u.test(expectedExtensionId) || value.extensionId !== expectedExtensionId
    || generation === undefined || generation < 1n || expiresAt <= Date.now() || limits === undefined
    || limits.maximumReadBytes < 1n || limits.maximumReadBytes > BigInt(MAXIMUM_INLINE_BYTES)
    || limits.maximumWriteBytes < 1n || limits.maximumWriteBytes > BigInt(MAXIMUM_INLINE_BYTES)
    || limits.maximumStreamBytes < limits.maximumWriteBytes || limits.maximumStreamBytes > 8n * 1024n ** 3n
    || limits.maximumPathCharacters < 1 || limits.maximumPathCharacters > 512
    || limits.maximumPathSegments < 1 || limits.maximumPathSegments > 32
    || limits.maximumListPageSize < 1 || limits.maximumListPageSize > 500
    || limits.maximumFiles < 1 || limits.maximumFiles > 50_000
    || limits.softLimitBytes !== 8n * 1024n ** 3n || limits.diskReserveBytes !== 1024n ** 3n) {
    throw new Error("The node returned an invalid Extension Library session.");
  }
  return {
    id: value.sessionId, extensionId: value.extensionId, expiresAt, bindingGeneration: generation,
    limits: {
      maximumReadBytes: limits.maximumReadBytes, maximumWriteBytes: limits.maximumWriteBytes,
      maximumStreamBytes: limits.maximumStreamBytes, maximumPathCharacters: limits.maximumPathCharacters,
      maximumPathSegments: limits.maximumPathSegments, maximumListPageSize: limits.maximumListPageSize,
      maximumFiles: limits.maximumFiles, softLimitBytes: limits.softLimitBytes, diskReserveBytes: limits.diskReserveBytes
    }
  };
}

export function assertMobileExtensionLibraryCallResult(result: MobileExtensionLibraryCallResult, call: MobileExtensionLibraryCall): void {
  const invalid = (): never => { throw new Error("The node returned a mismatched or oversized Library result."); };
  const entry = (value: MobileExtensionLibraryEntry): void => {
    if (!portablePath(value.path) || value.bytes < 0n || value.kind === "directory" && value.bytes !== 0n) invalid();
  };
  const sql = (value: MobileExtensionLibrarySqlResult): void => {
    if (value.rows.length > 2_000 || value.changes < 0n) invalid();
    let bytes = 0;
    const encoder = new TextEncoder();
    for (const row of value.rows) {
      for (const cell of row.cells) {
        bytes += encoder.encode(cell.name).byteLength;
        bytes += cell.value.kind === "blob" ? cell.value.value.byteLength
          : cell.value.kind === "text" ? encoder.encode(cell.value.value).byteLength : 16;
        if (bytes > MAXIMUM_INLINE_BYTES) invalid();
      }
    }
  };
  switch (call.kind) {
    case "read":
      if (result.kind !== "read" || result.path !== call.path || result.content.byteLength > MAXIMUM_INLINE_BYTES
        || call.length !== undefined && BigInt(result.content.byteLength) > call.length) invalid();
      return;
    case "write":
      if (result.kind !== "write" || result.path !== call.path || result.bytes !== BigInt(call.content.byteLength)) invalid();
      return;
    case "stat":
      if (result.kind !== "stat" || result.entry.path !== call.path) invalid();
      if (result.kind === "stat") entry(result.entry);
      return;
    case "list": {
      if (result.kind !== "list") return invalid();
      if (result.entries.length > (call.limit ?? 500) || new Set(result.entries.map((value) => value.path)).size !== result.entries.length
        || result.nextCursor !== undefined && (result.nextCursor.length === 0 || result.nextCursor.length > 2048
          || result.nextCursor === call.cursor)) invalid();
      for (const value of result.entries) {
        entry(value);
        if (call.path !== undefined && !value.path.startsWith(`${call.path}/`)
          || !call.recursive && value.path.slice((call.path?.length ?? -1) + 1).includes("/")) invalid();
      }
      return;
    }
    case "mkdir":
    case "delete":
      if (result.kind !== "path" || result.path !== call.path) invalid();
      return;
    case "rename":
      if (result.kind !== "rename" || result.from !== call.from || result.to !== call.to) invalid();
      return;
    case "writeBegin":
    case "writeChunk":
    case "writeAbort":
      if (result.kind !== "stream") return invalid();
      if (result.receivedBytes < 0n || result.receivedBytes > 8n * 1024n ** 3n
        || !Number.isSafeInteger(result.nextSequence) || result.nextSequence < 0
        || call.kind === "writeBegin" && (result.receivedBytes !== 0n || result.nextSequence !== 0 || result.aborted)
        || call.kind !== "writeBegin" && result.streamId !== call.streamId
        || call.kind === "writeChunk" && (result.nextSequence !== call.sequence + 1 || result.aborted)
        || call.kind === "writeAbort" && !result.aborted) invalid();
      return;
    case "writeCommit":
      if (result.kind !== "write" || result.bytes < 0n || result.bytes > 8n * 1024n ** 3n) invalid();
      return;
    case "sqlOpen":
      if (result.kind !== "sqlHandle" || result.path !== call.path || call.readOnly === true && !result.readOnly) invalid();
      return;
    case "sqlExecute":
      if (result.kind !== "sqlResult") return invalid();
      sql(result.value);
      return;
    case "sqlBatch":
      if (result.kind !== "sqlBatch" || result.results.length !== call.statements.length) return invalid();
      result.results.forEach(sql);
      return;
    case "sqlMigrate":
    case "sqlBackup":
      if (result.kind !== "sqlVersion" || !Number.isInteger(result.userVersion) || result.userVersion < 0
        || result.userVersion > 0x7fffffff || call.kind === "sqlBackup" && result.path !== call.targetPath) invalid();
      return;
    case "sqlCheck":
    case "sqlClose":
      if (result.kind !== "boolean") invalid();
  }
}
