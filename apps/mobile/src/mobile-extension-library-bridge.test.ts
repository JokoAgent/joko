// @vitest-environment jsdom
import { create } from "@bufbuild/protobuf";
import { ExtensionLibrarySessionSchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MobileExtensionLibraryBridge, decodeMobileLibraryMessage, encodeMobileLibraryMessage,
  mobileExtensionLibraryBootstrap
} from "./mobile-extension-library-bridge";
import {
  EXTENSION_LIBRARY_BRIDGE_REQUEST, assertMobileExtensionLibraryCallResult, extensionLibraryBridgeCapabilities,
  mapMobileExtensionLibraryCall, parseMobileExtensionLibraryRequest, projectMobileExtensionLibrarySession,
  type MobileExtensionLibraryCall, type MobileExtensionLibraryCallResult, type MobileExtensionLibrarySession
} from "./mobile-extension-library-runtime";
import type { MobileExtension, MobileExtensionMainViewSurface, MobileExtensionTransport } from "./mobile-extensions";

const extension: MobileExtension = {
  extensionId: `extension_${"a".repeat(32)}`, revision: 3n,
  owner: { kind: "resource", resourceId: "resource-mail", discoveredRevision: `sha256:${"b".repeat(64)}`, resourceRevision: 5n },
  source: "local", installed: true, installState: "installed", name: "Mail", description: "Review mail.",
  enabled: true, sidebarSupported: true, sidebarVisible: true, tools: [], permissions: [], commands: [],
  setup: { state: "notRequired", revision: 0n, fields: [] }, useSupported: true, updateAvailable: false,
  mainView: { title: "Mail" }, library: { schemaVersion: 1 }
};
const surface: MobileExtensionMainViewSurface = {
  surfaceId: `extension_surface_${"c".repeat(32)}`, extensionId: extension.extensionId,
  owner: extension.owner as Extract<MobileExtension["owner"], { kind: "resource" }>,
  backendId: "backend-mail", backendRevision: 7n, backendGeneration: 4,
  url: `https://node.example/v1/extensions/main-views/extension_surface_${"c".repeat(32)}/${"d".repeat(64)}/index.html`,
  title: "Mail", expiresAt: Date.now() + 600_000
};
const frameId = `${surface.surfaceId}:0`;
const streamId = `library_stream_${"1".repeat(32)}`;
const session: MobileExtensionLibrarySession = {
  id: `library_session_${"e".repeat(32)}`, extensionId: extension.extensionId,
  expiresAt: Date.now() + 300_000, bindingGeneration: 2n,
  limits: {
    maximumReadBytes: 16n * 1024n ** 2n, maximumWriteBytes: 16n * 1024n ** 2n,
    maximumStreamBytes: 8n * 1024n ** 3n, maximumPathCharacters: 512, maximumPathSegments: 32,
    maximumListPageSize: 500, maximumFiles: 50_000, softLimitBytes: 8n * 1024n ** 3n, diskReserveBytes: 1024n ** 3n
  }
};
const bridges: MobileExtensionLibraryBridge[] = [];
afterEach(() => { bridges.splice(0).forEach((bridge) => bridge.dispose()); vi.useRealTimers(); });

function harness(timeoutMs?: number) {
  let current = true;
  const replies: Array<{ response: { id: string; ok: boolean; result?: unknown; error?: { code: string } } }> = [];
  const transport = {
    ownerKey: "owner-mail", openLibrary: vi.fn(async () => session), closeLibrary: vi.fn(async () => true),
    callLibrary: vi.fn(async (_extension: unknown, _surface: unknown, _session: unknown, call: MobileExtensionLibraryCall): Promise<MobileExtensionLibraryCallResult> => {
      if (call.kind === "read") return { kind: "read", path: call.path, content: Uint8Array.of(0, 128, 255), sha256: "f".repeat(64) };
      return { kind: "boolean", value: true };
    }),
    libraryStatus: vi.fn(async () => ({ extensionId: extension.extensionId, name: "Mail", state: "ready" as const,
      location: { kind: "default" as const, path: "D:\\private-library", generation: 2n }, files: 1,
      bytes: 3n, softLimitBytes: session.limits.softLimitBytes, softLimitExceeded: false, orphaned: false, trashCount: 0, graceCount: 0 }))
  } as unknown as MobileExtensionTransport;
  const bridge = new MobileExtensionLibraryBridge({ extension, surface, frameId, transport, current: () => current,
    send: (message) => replies.push(decodeMobileLibraryMessage(message) as typeof replies[number]), timeoutMs });
  bridges.push(bridge);
  const send = (id: string, operation: unknown, changes: Record<string, unknown> = {}, url = surface.url) =>
    bridge.receive(encodeMobileLibraryMessage({ frameId, surfaceId: surface.surfaceId,
      request: { type: EXTENSION_LIBRARY_BRIDGE_REQUEST, version: 1, id, operation }, ...changes }), url);
  return { bridge, replies, send, transport, retire: () => { current = false; } };
}

describe("Mobile Library wire and authority", () => {
  it("round-trips full precision integers and binary JSON without coercing ordinary values", () => {
    const value = { bytes: Uint8Array.of(0, 128, 255), offset: 9_007_199_254_740_993n, negative: -7n, text: "42", number: 42 };
    expect(decodeMobileLibraryMessage(encodeMobileLibraryMessage(value))).toEqual(value);
    for (const invalid of ['{"$jokoLibraryInteger":"01"}', '{"$jokoLibraryInteger":"1","extra":1}',
      '{"$jokoLibraryBytes":"AA"}', '{"$jokoLibraryBytes":"AA==","extra":1}']) {
      expect(() => decodeMobileLibraryMessage(invalid)).toThrow();
    }
  });

  it("rejects unknown shape, escaping keys, oversized transfers and unadvertised gestures", () => {
    const request = (operation: unknown) => ({ type: EXTENSION_LIBRARY_BRIDGE_REQUEST, version: 1, id: "request:1", operation });
    for (const operation of [
      { kind: "write", path: "../outside", content: Uint8Array.of(1) },
      { kind: "stat", path: "C:/outside" }, { kind: "stat", path: "db.sqlite-wal" },
      { kind: "list", limit: 501 }, { kind: "read", path: "mail", length: 16n * 1024n ** 2n + 1n },
      { kind: "writeBegin", path: "mail", totalBytes: 8n * 1024n ** 3n + 1n },
      { kind: "sqlOpen", path: "mail.json" }, { kind: "sqlExecute", handleId: "db", statement: { sql: "SELECT ?", parameters: [{ kind: "number", value: Infinity }] } },
      { kind: "reveal", path: "mail" }, { kind: "write", path: "mail", content: Uint8Array.of(1), secret: "unknown" }
    ]) expect(parseMobileExtensionLibraryRequest(request(operation))).toBeUndefined();
    expect(parseMobileExtensionLibraryRequest({ ...request({ kind: "open" }), version: 2 })).toBeUndefined();
    expect(extensionLibraryBridgeCapabilities().operations).not.toContain("clipboardWrite");
  });

  it("maps every supported operation and typed SQLite parameter to generated contracts", () => {
    const calls: MobileExtensionLibraryCall[] = [
      { kind: "read", path: "mail", offset: 9_007_199_254_740_993n, length: 12n },
      { kind: "write", path: "mail", content: Uint8Array.of(1) }, { kind: "stat", path: "mail" },
      { kind: "list", path: "mail", limit: 5 }, { kind: "mkdir", path: "mail" }, { kind: "delete", path: "mail" },
      { kind: "rename", from: "mail", to: "next" }, { kind: "writeBegin", path: "mail", totalBytes: 4n, sha256: "a".repeat(64) },
      { kind: "writeChunk", streamId, sequence: 0, content: Uint8Array.of(1) }, { kind: "writeCommit", streamId },
      { kind: "writeAbort", streamId }, { kind: "sqlOpen", path: "mail.sqlite", create: true },
      { kind: "sqlExecute", handleId: "db", statement: { sql: "SELECT ?, ?, ?, ?, ?", parameters: [
        { kind: "null" }, { kind: "number", value: 1.5 }, { kind: "integer", value: -9_007_199_254_740_993n },
        { kind: "text", value: "mail" }, { kind: "blob", value: Uint8Array.of(128) }
      ] } },
      { kind: "sqlBatch", handleId: "db", statements: [{ sql: "SELECT 1" }] },
      { kind: "sqlMigrate", handleId: "db", migrations: [{ version: 1, statements: ["CREATE TABLE mail(id INTEGER)"] }] },
      { kind: "sqlBackup", handleId: "db", targetPath: "backup.sqlite" }, { kind: "sqlCheck", handleId: "db" }, { kind: "sqlClose", handleId: "db" }
    ];
    for (const call of calls) {
      const parsed = parseMobileExtensionLibraryRequest({ type: EXTENSION_LIBRARY_BRIDGE_REQUEST, version: 1, id: call.kind, operation: call });
      expect(parsed).toEqual({ id: call.kind, command: { kind: "call", call } });
      expect(mapMobileExtensionLibraryCall(call).operation.case).toBe(call.kind);
    }
    expect(mapMobileExtensionLibraryCall(calls[12]!).operation).toMatchObject({ case: "sqlExecute", value: {
      statement: { parameters: [{ value: { case: "nullValue", value: true } }, { value: { case: "numberValue", value: 1.5 } },
        { value: { case: "integerValue", value: "-9007199254740993" } }, { value: { case: "textValue", value: "mail" } },
        { value: { case: "blobValue", value: Uint8Array.of(128) } }] }
    } });
  });

  it("accepts only bounded sessions for the exact Extension and matching result identities", () => {
    const wire = create(ExtensionLibrarySessionSchema, { sessionId: session.id, extensionId: extension.extensionId,
      expiresAt: { seconds: BigInt(Math.ceil(session.expiresAt / 1000)) }, bindingGeneration: { value: 2n }, limits: session.limits });
    expect(projectMobileExtensionLibrarySession(wire, extension.extensionId)).toMatchObject({ id: session.id, bindingGeneration: 2n });
    expect(() => projectMobileExtensionLibrarySession(wire, `extension_${"0".repeat(32)}`)).toThrow();
    expect(() => projectMobileExtensionLibrarySession(create(ExtensionLibrarySessionSchema, { ...wire,
      limits: { ...wire.limits!, maximumListPageSize: 501 } }), extension.extensionId)).toThrow();
    expect(() => assertMobileExtensionLibraryCallResult({ kind: "write", path: "other", bytes: 1n, sha256: "a".repeat(64) },
      { kind: "write", path: "mail", content: Uint8Array.of(1) })).toThrow();
    expect(() => assertMobileExtensionLibraryCallResult({ kind: "stream", streamId, receivedBytes: 1n, nextSequence: 4, aborted: false },
      { kind: "writeChunk", streamId, sequence: 0, content: Uint8Array.of(1) })).toThrow();
  });

  it("serializes calls, consumes repeated IDs, and hides Library root and session identity", async () => {
    const active = harness();
    active.send("capabilities", { kind: "capabilities" });
    active.send("open", { kind: "open" });
    active.send("read", { kind: "read", path: "mail" });
    active.send("read", { kind: "read", path: "mail" });
    active.send("status", { kind: "status" });
    await vi.waitFor(() => expect(active.replies).toHaveLength(4));
    expect(active.transport.openLibrary).toHaveBeenCalledTimes(1);
    expect(active.transport.callLibrary).toHaveBeenCalledTimes(1);
    const open = active.replies.find((reply) => reply.response.id === "open")!;
    expect(open.response.result).toMatchObject({ extensionId: extension.extensionId, bindingGeneration: 2n });
    expect(open.response.result).not.toHaveProperty("id");
    expect(active.replies.find((reply) => reply.response.id === "status")!.response.result).toMatchObject({ location: "default", bytes: 3n });
    expect(encodeMobileLibraryMessage(active.replies)).not.toContain("private-library");
    active.send("read", { kind: "read", path: "mail" });
    active.send("foreign", { kind: "read", path: "mail" }, { frameId: "foreign" });
    active.send("foreign-url", { kind: "read", path: "mail" }, {}, "https://attacker.example/");
    await Promise.resolve();
    expect(active.transport.callLibrary).toHaveBeenCalledTimes(1);
    active.bridge.dispose();
    expect(active.transport.closeLibrary).toHaveBeenCalledWith(session);
  });

  it("closes late opens and drops old-document responses after owner or document retirement", async () => {
    const active = harness();
    let finish!: (value: MobileExtensionLibrarySession) => void;
    vi.mocked(active.transport.openLibrary).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    active.send("open", { kind: "open" });
    await vi.waitFor(() => expect(active.transport.openLibrary).toHaveBeenCalled());
    active.retire();
    active.bridge.dispose();
    finish(session);
    await vi.waitFor(() => expect(active.transport.closeLibrary).toHaveBeenCalledWith(session));
    expect(active.replies).toEqual([]);
  });

  it("reports lost responses once, closes the lease, and fences queued or later writes", async () => {
    vi.useFakeTimers();
    const active = harness(100);
    let finish!: (value: MobileExtensionLibraryCallResult) => void;
    vi.mocked(active.transport.callLibrary).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    active.send("write", { kind: "write", path: "mail", content: Uint8Array.of(1) });
    await vi.advanceTimersByTimeAsync(0);
    expect(active.transport.callLibrary).toHaveBeenCalledTimes(1);
    active.send("queued", { kind: "delete", path: "mail" });
    await vi.advanceTimersByTimeAsync(100);
    expect(active.replies.find((reply) => reply.response.id === "write")!.response.error?.code).toBe("result-unknown");
    expect(active.transport.closeLibrary).toHaveBeenCalledWith(session);
    active.send("later", { kind: "write", path: "mail", content: Uint8Array.of(1) });
    expect(active.replies.at(-1)!.response.error?.code).toBe("reopen-required");
    finish({ kind: "write", path: "mail", bytes: 1n, sha256: "a".repeat(64) });
    await vi.advanceTimersByTimeAsync(0);
    expect(active.transport.callLibrary).toHaveBeenCalledTimes(1);
    expect(active.replies.filter((reply) => reply.response.id === "write")).toHaveLength(1);
  });

  it("transports the existing page API envelope across JSON request and response delivery", async () => {
    const active = harness();
    const page = window as Window & typeof globalThis;
    const native = vi.fn((message: string) => active.bridge.receive(message, surface.url));
    Object.defineProperty(page, "ReactNativeWebView", { value: { postMessage: native } });
    const send = active.bridge.context.send;
    // The mounted WebView delivers native messages to the document on Android and the window on iOS.
    Object.assign(active.bridge.context, { send: (message: string) => {
      send(message);
      page.dispatchEvent(new page.MessageEvent("message", { data: message }));
      page.document.dispatchEvent(new page.MessageEvent("message", { data: message }));
    } });
    const script = mobileExtensionLibraryBootstrap(frameId, surface.surfaceId);
    page.eval(script);
    page.eval(script);
    const response = new Promise<{ result: { kind: string; content: Uint8Array } }>((resolve) => {
      page.addEventListener("message", (event) => {
        if (event.data?.type === "joko:extension-library-response") resolve(event.data);
      });
    });
    page.dispatchEvent(new page.MessageEvent("message", { source: page, origin: page.location.origin,
      data: { type: EXTENSION_LIBRARY_BRIDGE_REQUEST, version: 1, id: "page-read",
        operation: { kind: "read", path: "mail", offset: 9_007_199_254_740_993n } } }));
    const result = (await response).result;
    expect(result.kind).toBe("read");
    expect(Array.from(result.content)).toEqual([0, 128, 255]);
    expect(active.transport.callLibrary).toHaveBeenCalledWith(extension, surface, session,
      { kind: "read", path: "mail", offset: 9_007_199_254_740_993n }, expect.any(AbortSignal));
    expect(native).toHaveBeenCalledTimes(1);
    expect(script).not.toContain(session.id);
  });
});
