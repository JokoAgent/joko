import { describe, expect, it, vi } from "vitest";
import type { ManagedModelRuntimePort } from "./managed-model-runtime-port.js";
import { ManagedModelRuntimeRegistry } from "./managed-model-runtime-registry.js";

function entry(runtimeId: string) { return { runtimeId, close: vi.fn(async () => undefined) } as unknown as ManagedModelRuntimePort; }
describe("ManagedModelRuntimeRegistry", () => {
  it("registers independent exact identities and rejects aliases, duplicate IDs and unsupported identity shapes", () => {
    const first = entry("ollama"), second = entry("llama-cpp"); const registry = new ManagedModelRuntimeRegistry([first, second]);
    expect(registry.list()).toEqual([first, second]); expect(registry.get("llama-cpp")).toBe(second);
    expect(registry.get("LLAMA-CPP")).toBeUndefined(); expect(registry.get("llamacpp")).toBeUndefined();
    expect(() => new ManagedModelRuntimeRegistry([first, entry("ollama")])).toThrow(/unique/u);
    expect(() => new ManagedModelRuntimeRegistry([entry("../escape")])).toThrow(/identity/u);
  });
  it("retires reads before shutdown and preserves retry responsibility when one engine fails to stop", async () => {
    const first = entry("ollama"), second = entry("llama-cpp");
    vi.mocked(second.close).mockRejectedValueOnce(new Error("unconfirmed stop"));
    const registry = new ManagedModelRuntimeRegistry([first, second]);
    const close = registry.close(); expect(() => registry.list()).toThrow(/retired/u);
    await expect(close).rejects.toThrow(/not confirmed/u); expect(first.close).toHaveBeenCalledOnce();
    await expect(registry.close()).resolves.toBeUndefined(); expect(second.close).toHaveBeenCalledTimes(2);
    expect(() => registry.get("llama-cpp")).toThrow(/retired/u);
  });
});
