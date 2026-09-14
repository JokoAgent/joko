import { describe, expect, it } from "vitest";

import {
  EXTENSION_LIBRARY_BRIDGE_REQUEST,
  extensionLibraryBridgeCapabilities,
  parseExtensionLibraryBridgeRequest
} from "./extension-library-bridge.js";

const request = (operation: unknown, extra: Record<string, unknown> = {}) => ({
  type: EXTENSION_LIBRARY_BRIDGE_REQUEST,
  version: 1,
  id: "request:1",
  operation,
  ...extra
});

describe("Extension Library frame bridge request boundary", () => {
  it("accepts only exact versioned envelopes and exact control operations", () => {
    expect(parseExtensionLibraryBridgeRequest(request({ kind: "capabilities" }))).toEqual({
      id: "request:1",
      command: { kind: "capabilities" }
    });
    expect(parseExtensionLibraryBridgeRequest(request({ kind: "open", future: true }))).toBeUndefined();
    expect(parseExtensionLibraryBridgeRequest(request({ kind: "status" }, { future: true }))).toBeUndefined();
    expect(parseExtensionLibraryBridgeRequest({ ...request({ kind: "open" }), version: 2 })).toBeUndefined();
    expect(parseExtensionLibraryBridgeRequest({ ...request({ kind: "open" }), id: "" })).toBeUndefined();
  });

  it("normalizes bounded calls, clones byte payloads, and rejects host paths", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const parsed = parseExtensionLibraryBridgeRequest(request({
      kind: "write",
      path: "canvases/c1/state.bin",
      content: bytes,
      ifNotExists: true
    }));
    expect(parsed).toEqual({
      id: "request:1",
      command: { kind: "call", call: { kind: "write", path: "canvases/c1/state.bin", content: bytes, ifNotExists: true } }
    });
    const cloned = parsed?.command.kind === "call" && parsed.command.call.kind === "write"
      ? parsed.command.call.content
      : undefined;
    expect(cloned).not.toBe(bytes);
    bytes[0] = 9;
    expect(cloned?.[0]).toBe(1);

    for (const path of ["C:/private/file", "/private/file", "../file", ".hidden/file", "folder\\file", "aux.txt", "db.sqlite-wal"]) {
      expect(parseExtensionLibraryBridgeRequest(request({ kind: "stat", path })), path).toBeUndefined();
    }
    expect(parseExtensionLibraryBridgeRequest(request({
      kind: "writeChunk",
      streamId: "stream:1",
      sequence: 0,
      content: new Uint8Array(16 * 1024 * 1024 + 1)
    }))).toBeUndefined();
  });

  it("keeps integer and SQLite values typed while rejecting unsafe statements", () => {
    expect(parseExtensionLibraryBridgeRequest(request({
      kind: "sqlExecute",
      handleId: "sql:1",
      statement: {
        sql: "INSERT INTO notes VALUES (?, ?, ?)",
        parameters: [
          { kind: "integer", value: 42 },
          { kind: "text", value: "note" },
          { kind: "blob", value: new Uint8Array([7, 8]) }
        ]
      }
    }))).toEqual({
      id: "request:1",
      command: {
        kind: "call",
        call: {
          kind: "sqlExecute",
          handleId: "sql:1",
          statement: {
            sql: "INSERT INTO notes VALUES (?, ?, ?)",
            parameters: [
              { kind: "integer", value: 42n },
              { kind: "text", value: "note" },
              { kind: "blob", value: new Uint8Array([7, 8]) }
            ]
          }
        }
      }
    });
    expect(parseExtensionLibraryBridgeRequest(request({
      kind: "sqlExecute",
      handleId: "sql:1",
      statement: { sql: "SELECT 1", parameters: [{ kind: "future", value: 1 }] }
    }))).toBeUndefined();
    expect(parseExtensionLibraryBridgeRequest(request({
      kind: "sqlOpen", path: "data.sqlite-wal", create: true
    }))).toBeUndefined();
  });

  it("publishes an immutable current-v1 capability list", () => {
    const capabilities = extensionLibraryBridgeCapabilities(["reveal"]);
    expect(capabilities).toEqual(expect.objectContaining({
      version: 1,
      operations: expect.arrayContaining(["capabilities", "open", "read", "sqlCheck", "reveal"])
    }));
    expect(Object.isFrozen(capabilities)).toBe(true);
    expect(Object.isFrozen(capabilities.operations)).toBe(true);
  });

  it("accepts only bounded native gesture requests", () => {
    expect(parseExtensionLibraryBridgeRequest(request({ kind: "reveal", path: "exports/art.png" })))
      .toMatchObject({ command: { kind: "reveal", path: "exports/art.png" } });
    expect(parseExtensionLibraryBridgeRequest(request({ kind: "saveAs", path: "exports/art.png", name: "art.png" })))
      .toMatchObject({ command: { kind: "saveAs", name: "art.png" } });
    expect(parseExtensionLibraryBridgeRequest(request({ kind: "saveAs", path: "exports/art.png", name: "../art.png" })))
      .toBeUndefined();
    const content = new Uint8Array([1, 2]);
    const parsed = parseExtensionLibraryBridgeRequest(request({ kind: "clipboardWrite", content }));
    expect(parsed).toMatchObject({ command: { kind: "clipboardWrite", content: new Uint8Array([1, 2]) } });
    content[0] = 9;
    expect(parsed?.command.kind === "clipboardWrite" ? parsed.command.content[0] : undefined).toBe(1);
    expect(parseExtensionLibraryBridgeRequest(request({ kind: "clipboardWrite", content: new Uint8Array() }))).toBeUndefined();
  });
});
