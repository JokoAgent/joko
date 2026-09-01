import { describe, expect, it, vi } from "vitest";

import { GhCliTokenSource, type GhCliCommand } from "./index.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("host CLI credential source", () => {
  it("uses fixed arguments, platform candidates, bounded execution, and a positive cache", async () => {
    const command = vi.fn<GhCliCommand>(async () => bytes("gho_memory_only\n"));
    const source = new GhCliTokenSource({
      command,
      platform: "darwin",
      exists: (path) => path === "/opt/homebrew/bin/gh",
      now: () => 1_000
    });

    const first = await source.readCredential();
    const second = await source.readCredential();
    expect(first).toBe(second);
    expect(first).toMatchObject({ token: "gho_memory_only", generation: 1 });
    expect(source.isCurrent(first!)).toBe(true);
    expect(command).toHaveBeenCalledOnce();
    expect(command).toHaveBeenCalledWith(
      "/opt/homebrew/bin/gh",
      ["auth", "token"],
      { timeoutMs: 3_000, maximumOutputBytes: 16 * 1024 }
    );
  });

  it("deduplicates in-flight reads and negative-caches command failures for 30 seconds", async () => {
    let release: ((value: Uint8Array) => void) | undefined;
    let now = 1_000;
    const command = vi.fn<GhCliCommand>(() => new Promise((resolve) => { release = resolve; }));
    const source = new GhCliTokenSource({ command, platform: "linux", exists: () => false, now: () => now });

    const first = source.readCredential();
    const second = source.readCredential();
    await vi.waitFor(() => expect(command).toHaveBeenCalledOnce());
    release?.(new Uint8Array());
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(command.mock.calls[0]?.[0]).toBe("gh");

    now = 30_999;
    await expect(source.readCredential()).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledOnce();
    now = 31_001;
    command.mockResolvedValueOnce(bytes("github_pat_new\n"));
    await expect(source.readCredential()).resolves.toMatchObject({ token: "github_pat_new", generation: 2 });
    expect(command).toHaveBeenCalledTimes(2);
  });

  it("normalizes timeout, oversized, invalid UTF-8, and header-injection output to unavailable", async () => {
    const cases: Array<Uint8Array | Error> = [
      new Error("timed out with secret-token"),
      new Uint8Array(16 * 1024 + 1),
      new Uint8Array([0xff]),
      bytes("safe\r\nx-injected: value\n"),
      bytes("two\nlines\n")
    ];
    for (const candidate of cases) {
      const source = new GhCliTokenSource({
        command: async () => {
          if (candidate instanceof Error) throw candidate;
          return candidate;
        }
      });
      await expect(source.readCredential()).resolves.toBeUndefined();
    }
  });

  it("fences an issued credential after explicit invalidation", async () => {
    const source = new GhCliTokenSource({ command: async () => bytes("gho_ephemeral\n") });
    const credential = await source.readCredential();
    expect(source.isCurrent(credential!)).toBe(true);
    source.invalidate();
    expect(source.isCurrent(credential!)).toBe(false);
  });

  it("does not resurrect a credential command that was invalidated while in flight", async () => {
    let release: ((value: Uint8Array) => void) | undefined;
    const source = new GhCliTokenSource({
      command: () => new Promise((resolve) => { release = resolve; })
    });
    const pending = source.readCredential();
    await vi.waitFor(() => expect(release).toBeDefined());
    source.invalidate();
    release?.(bytes("gho_stale\n"));
    await expect(pending).resolves.toBeUndefined();
  });
});
