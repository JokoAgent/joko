import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { compileFunction } from "node:vm";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createRouterTransport } from "@connectrpc/connect";
import { createConnectTransport } from "@joko/connection-transport/node";
import { ConnectionService, McpAppNativeService, McpAppService, McpAppOperation,
  McpAppServiceOperateRequestSchema, McpAppServiceOperateResponseSchema } from "@joko/contracts";
import type { HeadersReceivedResponse, OnHeadersReceivedListenerDetails, WebContents, WebFrameMain } from "electron";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopMcpAppHost, MCP_APP_CAPTURE, MCP_APP_CHANNEL, MCP_APP_SCHEME } from "../src/mcp-app-host.js";
import { DESKTOP_APP_ORIGIN, DESKTOP_CONTENT_SECURITY_POLICY, mergeContentSecurityPolicyHeaders,
  shouldMergeDesktopFrameContentSecurityPolicy } from "../src/security.js";

const ipc = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock("electron", () => ({
  ipcMain: { on: (name: string, callback: (...args: unknown[]) => unknown) => ipc.handlers.set(name, callback),
    handle: (name: string, callback: (...args: unknown[]) => unknown) => ipc.handlers.set(name, callback) },
  protocol: { handle: vi.fn() },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: vi.fn() } } }
}));
vi.mock("@joko/connection-transport/node", async original => ({
  ...await original<typeof import("@joko/connection-transport/node")>(), createConnectTransport: vi.fn()
}));
afterEach(() => { vi.clearAllMocks(); ipc.handlers.clear(); });

function frame(url: string, parent: WebFrameMain | null = null): WebFrameMain {
  return { url, parent, isDestroyed: () => false } as unknown as WebFrameMain;
}

async function fixture() {
  const owner = { profileId: "profile", serverId: "server", origin: "https://mcp.example", endpointPublicKey: `ed25519:${"a".repeat(64)}` };
  const contents = Object.assign(new EventEmitter(), { id: 17, isDestroyed: () => false });
  const event = { sender: contents as unknown as WebContents, returnValue: undefined as unknown };
  const teardown = vi.fn(() => ({}));
  vi.mocked(createConnectTransport).mockImplementation(options => createRouterTransport(router => {
    router.service(ConnectionService, { getServerInfo: () => ({ server: { serverId: owner.serverId } }) });
    router.service(McpAppNativeService, { operate: (request, context) => {
      expect(request.view?.operation).toBe(McpAppOperation.OPEN);
      expect(context.requestHeader.get("authorization")).toBe(`Bearer ${"k".repeat(43)}`);
      return { document: { viewId: "view", html: "<!doctype html><title>Controlled application</title>" } };
    } });
    router.service(McpAppService, { operate: teardown });
  }, { transport: { interceptors: options.interceptors ?? [] } }));
  const host = new DesktopMcpAppHost({ assertSource: source => { expect(source.sender).toBe(contents); },
    readAuthKey: async () => "k".repeat(43), quitting: () => false });
  host.register();
  ipc.handlers.get(MCP_APP_CAPTURE)!(event, randomUUID());
  expect(typeof event.returnValue).toBe("string");
  const bytes = toBinary(McpAppServiceOperateRequestSchema, create(McpAppServiceOperateRequestSchema, { operation: McpAppOperation.OPEN, sessionId: "session" }));
  const result = await ipc.handlers.get(MCP_APP_CHANNEL)!(event, event.returnValue, owner, bytes) as Uint8Array;
  const opened = fromBinary(McpAppServiceOperateResponseSchema, result);
  expect(opened.viewId).toBe("view");
  return { host, contents, url: opened.proxyUrl, teardown };
}

// Exercise Main's actual callback without starting the Electron application or
// copying its CSP decision into the regression fixture.
function headersReceived(host: DesktopMcpAppHost): (details: Partial<OnHeadersReceivedListenerDetails>, callback: (response: HeadersReceivedResponse) => void) => void {
  const filename = new URL("../src/main.ts", import.meta.url);
  const source = ts.createSourceFile("main.ts", readFileSync(filename, "utf8"), ts.ScriptTarget.Latest, true);
  const callbacks: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.getText(source) === "electronSession.webRequest.onHeadersReceived" && node.arguments[0]) callbacks.push(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(callbacks).toHaveLength(1);
  const javascript = ts.transpileModule(`const handler = ${callbacks[0]!.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext }
  }).outputText;
  return compileFunction(`${javascript}\nreturn handler;`, ["observePackagedSmokeRequest", "MCP_APP_SCHEME", "desktopMcpApps",
    "shouldMergeDesktopFrameContentSecurityPolicy", "navigationPolicy", "DESKTOP_APP_ORIGIN", "mergeContentSecurityPolicyHeaders"])(
      () => undefined, MCP_APP_SCHEME, host, shouldMergeDesktopFrameContentSecurityPolicy, {}, DESKTOP_APP_ORIGIN, mergeContentSecurityPolicyHeaders
    ) as ReturnType<typeof headersReceived>;
}

it("recognizes only registered live MCP ancestry and retires the original document with its contents", async () => {
  const f = await fixture();
  const ancestor = frame(f.url);
  expect(f.host.isAppFrame(ancestor)).toBe(true);
  expect(f.host.isAppFrame(frame("about:blank", ancestor))).toBe(true);
  expect(f.host.isAppFrame(frame("", ancestor))).toBe(true);
  expect(f.host.isAppFrame(frame("not a URL", ancestor))).toBe(true);
  expect(f.host.isAppFrame(frame("https://ordinary.example"))).toBe(false);
  expect(f.host.isAppFrame(frame(`${MCP_APP_SCHEME}://unregistered/sandbox`))).toBe(false);
  expect(f.host.isAppFrame(undefined)).toBe(false);
  f.contents.emit("render-process-gone");
  expect(f.host.isAppFrame(ancestor)).toBe(false);
  await vi.waitFor(() => expect(f.teardown).toHaveBeenCalledOnce());
});

it.each(["destroyed", "url", "parent"] as const)("completes Main's CSP callback when the native frame %s is retired", async retired => {
  const f = await fixture();
  const stale = Object.defineProperties({ isDestroyed: () => retired === "destroyed" }, {
    url: { get: () => { if (retired === "url") throw new Error("Controlled disposed native URL"); return ""; } },
    parent: { get: () => { throw new Error("Controlled disposed native parent"); } }
  }) as unknown as WebFrameMain;
  const callback = vi.fn();
  expect(() => headersReceived(f.host)({ url: `${DESKTOP_APP_ORIGIN}/index.html`, resourceType: "mainFrame", frame: stale,
    responseHeaders: { "Content-Security-Policy": ["default-src 'none'"] } }, callback)).not.toThrow();
  expect(callback).toHaveBeenCalledExactlyOnceWith({ responseHeaders: {
    "Content-Security-Policy": ["default-src 'none'", DESKTOP_CONTENT_SECURITY_POLICY]
  } });
  expect(f.host.isAppFrame(stale)).toBe(false);
});

it("preserves the registered MCP response policy while ordinary documents receive the application policy", async () => {
  const f = await fixture(), callback = vi.fn();
  const handler = headersReceived(f.host);
  const responseHeaders = { "Content-Security-Policy": ["default-src 'none'"] };
  handler({ url: "https://surface.example/child", resourceType: "subFrame", frame: frame("about:blank", frame(f.url)), responseHeaders }, callback);
  expect(callback).toHaveBeenCalledExactlyOnceWith({ responseHeaders });
  callback.mockClear();
  handler({ url: "https://ordinary.example/child", resourceType: "subFrame", frame: frame("about:blank"), responseHeaders }, callback);
  expect(callback).toHaveBeenCalledExactlyOnceWith({ responseHeaders: {
    "Content-Security-Policy": ["default-src 'none'", DESKTOP_CONTENT_SECURITY_POLICY]
  } });
});
