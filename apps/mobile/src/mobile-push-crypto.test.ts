import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ getRandomBytesAsync: vi.fn<(count: number) => Promise<Uint8Array>>() }));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: vi.fn(), randomUUID: vi.fn(), getRandomBytesAsync: native.getRandomBytesAsync
}));
import { createMobilePushRevocationSecret } from "./mobile-push-crypto";

beforeEach(() => {
  native.getRandomBytesAsync.mockReset();
  vi.stubGlobal("btoa", undefined);
  vi.stubGlobal("atob", undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("native push revocation secret", () => {
  it.each([new Uint8Array(32), new Uint8Array(32).fill(255),
    Uint8Array.from({ length: 32 }, (_, index) => index * 7 + 11)])
  ("encodes all 32 native random bytes as canonical unpadded base64url without browser codecs", async (bytes) => {
    native.getRandomBytesAsync.mockResolvedValue(bytes);
    const secret = await createMobilePushRevocationSecret();
    expect(native.getRandomBytesAsync).toHaveBeenCalledExactlyOnceWith(32);
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(secret).toBe(Buffer.from(bytes).toString("base64url"));
    expect(Uint8Array.from(Buffer.from(secret, "base64url"))).toEqual(bytes);
  });

  it("rejects a failed or truncated native random source without returning a replacement secret", async () => {
    native.getRandomBytesAsync.mockRejectedValue(new Error("random source unavailable"));
    await expect(createMobilePushRevocationSecret()).rejects.toThrow("random source unavailable");
    native.getRandomBytesAsync.mockResolvedValue(new Uint8Array(31));
    await expect(createMobilePushRevocationSecret()).rejects.toThrow(/32 random bytes/u);
  });
});
