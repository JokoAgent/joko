import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { BrowserProvider, type BrowserContextLauncher } from "./provider.js";
import type { BrowserProxyRequestGateHandle } from "./proxy-request-gate.js";

class PageView extends EventEmitter {
  readonly #context: Context;
  constructor(context: Context) { super(); this.#context = context; }
  url(): string { return "https://example.com/"; }
  async title(): Promise<string> { return "Managed page"; }
  isClosed(): boolean { return this.#context.closed; }
  context(): BrowserContext { return this.#context as unknown as BrowserContext; }
  mainFrame(): object { return this; }
}
class Context extends EventEmitter {
  closeCount = 0;
  closed = false;
  closeFailure = false;
  closeWait: Promise<void> | undefined;
  readonly page = new PageView(this);
  readonly request = { get: vi.fn() };
  pages(): Page[] { return this.closed ? [] : [this.page as unknown as Page]; }
  async close(): Promise<void> {
    this.closeCount++;
    if (this.closeFailure) throw new Error("writer not confirmed");
    await this.closeWait;
    this.closed = true;
    this.emit("close");
  }
}
class Gate implements BrowserProxyRequestGateHandle {
  readonly failure: () => void;
  readonly context: Context;
  started = false;
  retiring = false;
  disposed = false;
  wait: Promise<void> | undefined;
  constructor(context: Context, failure: () => void) { this.context = context; this.failure = failure; }
  get active(): boolean { return this.started && !this.retiring; }
  async start(): Promise<void> { await this.wait; this.started = true; }
  beginRetirement(): void { this.retiring = true; }
  async dispose(): Promise<void> { expect(this.context.closed).toBe(true); this.disposed = true; }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-browser-proxy-"));
  const contexts: Context[] = [];
  const gates: Gate[] = [];
  let gateWait: Promise<void> | undefined;
  const launch = vi.fn<BrowserContextLauncher>(async () => {
    const context = new Context();
    contexts.push(context);
    return context as unknown as BrowserContext;
  });
  const provider = new BrowserProvider({ executablePath: "managed-browser", targetMode: "external",
    profileDirectories: { external: join(root, "external"), sidebar: join(root, "sidebar") }, downloadDirectory: join(root, "downloads"), uploadRoots: [],
    launchPersistentContext: launch,
    createProxyRequestGate: (context, _route, failure) => {
      const gate = new Gate(context as unknown as Context, failure);
      gate.wait = gateWait;
      gates.push(gate);
      return gate;
    } });
  return { provider, launch, contexts, gates, setGateWait: (wait: Promise<void>) => { gateWait = wait; },
    cleanup: async () => { await provider.stop(); await rm(root, { recursive: true, force: true }); } };
}
const PROXY = { proxyServer: "socks5://127.0.0.1:1080", proxyAllowedHostnames: ["*.example.com", "example.com"] };

describe("owned Browser proxy route", () => {
  it("validates before teardown and reuses the exact canonical route without closing tabs", async () => {
    const value = await fixture();
    try {
      await value.provider.start(PROXY);
      const generation = value.provider.generation;
      await value.provider.start({ ...PROXY, proxyAllowedHostnames: [...PROXY.proxyAllowedHostnames].reverse() });
      expect(value.launch).toHaveBeenCalledTimes(1);
      expect(value.contexts[0]!.closeCount).toBe(0);
      expect(value.provider.generation).toBe(generation);
      const lease = value.provider.acquireAgentLease("resource-owner");
      const [page] = await value.provider.listPages();
      await expect(value.provider.captureResource(page!.id, lease, "https://example.com/blob")).rejects.toThrow("while the Browser uses a proxy");
      expect(value.contexts[0]!.request.get).not.toHaveBeenCalled();
      await value.provider.releaseAgentLease(lease);
      expect(value.launch.mock.calls[0]![1].args).toEqual(expect.arrayContaining([expect.stringContaining("--proxy-pac-url="), "--webrtc-ip-handling-policy=disable_non_proxied_udp"]));
      expect(() => value.provider.start({ proxyServer: "http://user:password@proxy.example:8080" })).toThrow("authenticated proxies");
      expect(value.contexts[0]!.closeCount).toBe(0);
      await value.provider.start({});
      expect(value.gates[0]!.disposed).toBe(true);
      expect(value.provider.proxyState()).toEqual({ mode: "direct" });
      await value.provider.stop();
      await value.provider.setTargetMode("sidebar");
      expect(() => value.provider.start(PROXY)).toThrow("external");
      expect(value.launch).toHaveBeenCalledTimes(2);
    } finally { await value.cleanup(); }
  });

  it("keeps an unconfirmed exact writer fenced until explicit stop confirms retirement", async () => {
    const value = await fixture();
    try {
      await value.provider.start(PROXY);
      value.contexts[0]!.closeFailure = true;
      await expect(value.provider.start({})).rejects.toThrow("retirement is unconfirmed");
      expect(value.provider.proxyState()).toEqual({ mode: "unknown" });
      expect(() => value.provider.start()).toThrow("unknown");
      await expect(value.provider.start({})).rejects.toThrow("retirement is unconfirmed");
      expect(value.launch).toHaveBeenCalledTimes(1);
      expect(value.gates[0]!.disposed).toBe(false);
      value.contexts[0]!.closeFailure = false;
      await value.provider.stop();
      expect(value.gates[0]!.disposed).toBe(true);
      await value.provider.start({});
      expect(value.launch).toHaveBeenCalledTimes(2);
    } finally { value.contexts[0]!.closeFailure = false; await value.cleanup(); }
  });

  it("fences a failed lifetime gate and waits for its writer before creating a replacement route", async () => {
    const value = await fixture();
    let finishRetirement!: () => void;
    try {
      await value.provider.start(PROXY);
      value.contexts[0]!.closeWait = new Promise(resolve => { finishRetirement = resolve; });
      value.gates[0]!.failure();
      expect(value.provider.running).toBe(false);
      await expect(value.provider.listPages()).rejects.toThrow();
      const replacing = value.provider.start({});
      await vi.waitFor(() => expect(value.contexts[0]!.closeCount).toBe(1));
      expect(value.launch).toHaveBeenCalledTimes(1);
      expect(value.gates[0]!.disposed).toBe(false);
      finishRetirement();
      await replacing;
      expect(value.gates[0]!.disposed).toBe(true);
      expect(value.launch).toHaveBeenCalledTimes(2);
    } finally { finishRetirement?.(); await value.cleanup(); }
  });

  it("retires a late startup writer after cancellation and does not commit ready", async () => {
    const value = await fixture();
    let finishGate!: () => void;
    const signal = new AbortController();
    value.setGateWait(new Promise(resolve => { finishGate = resolve; }));
    try {
      const starting = value.provider.start({ ...PROXY, signal: signal.signal });
      await vi.waitFor(() => expect(value.gates).toHaveLength(1));
      signal.abort();
      finishGate();
      await expect(starting).rejects.toThrow();
      expect(value.contexts[0]!.closed).toBe(true);
      expect(value.gates[0]!.disposed).toBe(true);
      expect(value.provider.running).toBe(false);
      expect(value.provider.generation).toBe(0);
    } finally { finishGate?.(); await value.cleanup(); }
  });
});
