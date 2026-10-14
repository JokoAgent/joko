import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import type { BrowserContext, CDPSession } from "playwright-core";
import ipaddr from "ipaddr.js";
import { describe, expect, it, vi } from "vitest";
import { BrowserProxyRequestGate } from "./proxy-request-gate.js";
import { buildBrowserProxyLaunchArgs, isBrowserProxyRequestUrlAllowed, parseBrowserProxyServer, type BrowserProxyLookup } from "./proxy.js";

class Cdp extends EventEmitter {
  readonly commands: Array<{ session?: string; method: string; params?: Record<string, unknown> }> = [];
  readonly parents = new Map<string, string | undefined>();
  detached = false;
  emitIn(session: string, message: object): void {
    const envelope = { method: "Target.receivedMessageFromTarget", params: { sessionId: session, message: JSON.stringify(message) } };
    const parent = this.parents.get(session);
    if (parent === undefined) this.emit("event", envelope);
    else this.emitIn(parent, envelope);
  }
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.commands.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "Target.getTargets") return { targetInfos: [] };
    if (method === "Target.setAutoAttach") {
      this.parents.set("page-session", undefined);
      this.emit("event", { method: "Target.attachedToTarget", params: { sessionId: "page-session", targetInfo: { targetId: "page-target", type: "page" } } });
    }
    if (method === "Target.sendMessageToTarget") this.child(params!);
    return {};
  }
  child(envelope: Record<string, unknown>): void {
    const session = envelope["sessionId"] as string;
    const message = JSON.parse(envelope["message"] as string) as { id: number; method: string; params?: Record<string, unknown> };
    this.commands.push({ session, method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
    if (message.method === "Target.sendMessageToTarget") this.child(message.params!);
    if (message.method === "Target.setAutoAttach" && session === "page-session") {
      this.parents.set("worker-session", session);
      this.emitIn(session, { method: "Target.attachedToTarget", params: { sessionId: "worker-session", targetInfo: { targetId: "worker-target", type: "worker" } } });
    }
    this.emitIn(session, { id: message.id, result: {} });
  }
  async detach(): Promise<void> { this.detached = true; }
}

describe("restricted Browser proxy", () => {
  it("enforces the launch floor for WSS, wildcard/apex, private DNS and no DIRECT fallback", () => {
    const route = parseBrowserProxyServer("socks5://127.0.0.1:1080", ["*.example.com"]);
    const argument = buildBrowserProxyLaunchArgs(route)[0]!;
    const pac = Buffer.from(argument.slice(argument.indexOf("base64,") + 7), "base64").toString();
    let address = "93.184.216.34";
    const context = { dnsResolve: () => address, isInNet: (ip: string, network: string, mask: string) => {
      const prefix = mask.split(".").map(value => Number(value).toString(2)).join("").replaceAll("0", "").length;
      return ipaddr.IPv4.parse(ip).match(ipaddr.IPv4.parse(network), prefix);
    } };
    runInNewContext(pac, context);
    const find = (context as unknown as { FindProxyForURL(url: string, host: string): string }).FindProxyForURL;
    expect(find("wss://chat.example.com/", "chat.example.com")).toBe("SOCKS5 127.0.0.1:1080");
    expect(find("https://example.com/", "example.com")).toBe("PROXY 0.0.0.0:0");
    expect(find("http://chat.example.com/", "chat.example.com")).toBe("PROXY 0.0.0.0:0");
    address = "127.0.0.1";
    expect(find("https://chat.example.com/", "chat.example.com")).toBe("PROXY 0.0.0.0:0");
  });

  it("rejects mixed private DNS answers and embedded IPv4 while retaining the fixed fake-IP exemption", async () => {
    const route = parseBrowserProxyServer("http://proxy.example:8080", ["example.com"]);
    const lookup = (addresses: string[]) => vi.fn(async () => addresses.map(address => ({ address, family: address.includes(":") ? 6 : 4 }))) as unknown as BrowserProxyLookup;
    expect(await isBrowserProxyRequestUrlAllowed("https://example.com/", route, lookup(["93.184.216.34", "fc00::1"]))).toBe(false);
    expect(await isBrowserProxyRequestUrlAllowed("https://example.com/", route, lookup(["64:ff9b::7f00:1"]))).toBe(false);
    expect(await isBrowserProxyRequestUrlAllowed("https://example.com/", route, lookup(["198.18.0.1"]))).toBe(true);
    expect(await isBrowserProxyRequestUrlAllowed("https://example.com/", parseBrowserProxyServer("http://proxy.example:8080"), lookup(["93.184.216.34"]))).toBe(false);
  });

  it("installs recursive worker gates before resume and rechecks DNS for each paused request", async () => {
    const cdp = new Cdp();
    let address = "93.184.216.34";
    const lookup = vi.fn(async () => [{ address, family: address.includes(":") ? 6 : 4 }]) as unknown as BrowserProxyLookup;
    const onFailure = vi.fn();
    const gate = new BrowserProxyRequestGate({ browser: () => ({ newBrowserCDPSession: async () => cdp as unknown as CDPSession }) } as unknown as BrowserContext,
      parseBrowserProxyServer("http://proxy.example:8080", ["example.com"]), onFailure, lookup);
    await gate.start();
    for (const session of ["page-session", "worker-session"]) {
      const commands = cdp.commands.filter(command => command.session === session).map(command => command.method);
      expect(commands.indexOf("Fetch.enable")).toBeLessThan(commands.indexOf("Runtime.runIfWaitingForDebugger"));
    }
    cdp.emitIn("worker-session", { method: "Fetch.requestPaused", params: { requestId: "request-one", request: { url: "https://example.com/" } } });
    await vi.waitFor(() => expect(cdp.commands).toContainEqual(expect.objectContaining({ session: "worker-session", method: "Fetch.continueRequest", params: { requestId: "request-one" } })));
    address = "::ffff:127.0.0.1";
    cdp.emitIn("worker-session", { method: "Fetch.requestPaused", params: { requestId: "request-two", request: { url: "https://example.com/" } } });
    await vi.waitFor(() => expect(cdp.commands).toContainEqual(expect.objectContaining({ session: "worker-session", method: "Fetch.failRequest", params: { requestId: "request-two", errorReason: "BlockedByClient" } })));
    cdp.emit("close");
    expect(gate.active).toBe(false);
    expect(onFailure).toHaveBeenCalledOnce();
    await gate.dispose();
  });
});
