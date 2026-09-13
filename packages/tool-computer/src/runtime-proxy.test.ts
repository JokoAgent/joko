import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyHarness = vi.hoisted(() => {
  const dispatchers: Array<{
    readonly dispatch: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
    readonly destroy: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    dispatchers,
    fetch: vi.fn(),
    createSocks5Dispatcher: vi.fn(() => {
      const dispatcher = {
        dispatch: vi.fn(),
        close: vi.fn(async () => undefined),
        destroy: vi.fn(async () => undefined)
      };
      dispatchers.push(dispatcher);
      return dispatcher;
    })
  };
});

vi.mock("@joko/outbound-network", () => ({
  createSocks5Dispatcher: proxyHarness.createSocks5Dispatcher
}));

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return { ...actual, fetch: proxyHarness.fetch };
});

const { ComputerRuntime } = await import("./runtime.js");

describe("ComputerRuntime update proxy dispatch", () => {
  beforeEach(() => {
    proxyHarness.dispatchers.length = 0;
    proxyHarness.createSocks5Dispatcher.mockClear();
    proxyHarness.fetch.mockReset();
    proxyHarness.fetch.mockResolvedValue(new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
  });

  it("uses explicit SOCKS5 environment for GitHub requests without consulting the host resolver", async () => {
    const resolveOutboundProxy = vi.fn(async () => "http://system-proxy.invalid:8080");
    const runtime = new ComputerRuntime({
      platform: "linux",
      executablePath: "/runtime/bin/driver",
      environment: {
        HTTPS_PROXY: "socks5://agent:volatile-secret@127.0.0.1:1080",
        HTTP_PROXY: "http://http-only.invalid:8080"
      },
      resolveOutboundProxy,
      runner: versionRunner()
    });

    const update = await runtime.checkForUpdate({ fresh: true });

    expect(update).toMatchObject({ currentVersion: "0.1.0", updateAvailable: false, updating: false });
    expect(resolveOutboundProxy).not.toHaveBeenCalled();
    expect(proxyHarness.createSocks5Dispatcher).toHaveBeenCalledWith(
      "socks5://agent:volatile-secret@127.0.0.1:1080"
    );
    expect(proxyHarness.fetch.mock.calls[0]?.[1]?.dispatcher).toBe(proxyHarness.dispatchers[0]);
    expect(JSON.stringify(update)).not.toContain("volatile-secret");

    await runtime.dispose();
    expect(proxyHarness.dispatchers[0]?.close).toHaveBeenCalledOnce();
  });

  it("does not use HTTP_PROXY for an HTTPS update request", async () => {
    const resolveOutboundProxy = vi.fn(async () => "socks5://system-proxy.invalid:1080");
    const runtime = new ComputerRuntime({
      platform: "linux",
      executablePath: "/runtime/bin/driver",
      environment: { HTTP_PROXY: "http://http-only.invalid:8080" },
      resolveOutboundProxy,
      runner: versionRunner()
    });

    await runtime.checkForUpdate({ fresh: true });

    expect(resolveOutboundProxy).not.toHaveBeenCalled();
    expect(proxyHarness.createSocks5Dispatcher).not.toHaveBeenCalled();
    expect(proxyHarness.fetch.mock.calls[0]?.[1]).not.toHaveProperty("dispatcher");
    await runtime.dispose();
  });

  it("uses a host SOCKS5 verdict for GitHub requests when no explicit proxy is configured", async () => {
    const resolveOutboundProxy = vi.fn(async () => "socks5://127.0.0.1:1081");
    const runtime = new ComputerRuntime({
      platform: "linux",
      executablePath: "/runtime/bin/driver",
      environment: {},
      resolveOutboundProxy,
      runner: versionRunner()
    });

    await expect(runtime.checkForUpdate({ fresh: true })).resolves.toMatchObject({
      currentVersion: "0.1.0",
      updateAvailable: false
    });
    expect(resolveOutboundProxy).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api\.github\.com\//u),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(proxyHarness.createSocks5Dispatcher).toHaveBeenCalledWith("socks5://127.0.0.1:1081");
    expect(proxyHarness.fetch.mock.calls[0]?.[1]?.dispatcher).toBe(proxyHarness.dispatchers[0]);

    await runtime.dispose();
  });
});

function versionRunner(): {
  readonly run: () => Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly stdoutTruncated: false;
    readonly stderrTruncated: false;
    readonly exitCode: 0;
    readonly signal: null;
  }>;
} {
  return {
    run: async () => ({
      stdout: "cua-driver 0.1.0\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
      signal: null
    })
  };
}
