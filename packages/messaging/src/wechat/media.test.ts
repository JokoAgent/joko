import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { decryptWeChatMedia, prepareWeChatUpload, weChatCiphertextSize } from "./media-crypto.js";
import { downloadWeChatMedia, isPublicAddress, uploadWeChatCiphertext } from "./media-transfer.js";

function encrypt(bytes: Uint8Array, key: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

describe("WeChat media security", () => {
  it("checks AES padding, exact plaintext length and MD5 before adopting bytes", () => {
    const input = Buffer.from("hello image");
    const key = Buffer.alloc(16, 7);
    const ciphertext = encrypt(input, key);
    const expected = { ciphertext, aesKeyBase64: key.toString("base64"), expectedPlainBytes: input.length, md5Hex: createHash("md5").update(input).digest("hex") };
    expect(Buffer.from(decryptWeChatMedia(expected))).toEqual(input);
    expect(() => decryptWeChatMedia({ ...expected, expectedPlainBytes: 1 })).toThrow();
    expect(() => decryptWeChatMedia({ ...expected, md5Hex: "0".repeat(32) })).toThrow();
    expect(() => decryptWeChatMedia({ ...expected, ciphertext: ciphertext.subarray(0, 15) })).toThrow();
    expect(weChatCiphertextSize(16)).toBe(32);
    expect(prepareWeChatUpload(input).ciphertext.byteLength).toBe(16);
  });

  it("restricts HTTPS media URL, forbids redirects, bounds bytes and uses encrypted CDN parameters", async () => {
    const plain = Buffer.from("downloaded");
    const key = Buffer.alloc(16, 3);
    const ciphertext = encrypt(plain, key);
    const fetch = vi.fn(async (input: string | URL) => {
      expect(new URL(String(input)).hostname).toBe("novac2c.cdn.weixin.qq.com");
      return new Response(Buffer.from(ciphertext), { status: 200 });
    });
    const result = await downloadWeChatMedia({ kind: "file", encryptedQuery: "private-query", aesKeyBase64: key.toString("base64"), byteLength: plain.length }, new AbortController().signal, { fetch });
    expect(Buffer.from(result)).toEqual(plain);
    expect(fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({ redirect: "manual", method: "GET" }));
    await expect(downloadWeChatMedia({ kind: "file", downloadUrl: "http://127.0.0.1/x", aesKeyBase64: key.toString("base64") }, new AbortController().signal, { fetch })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(downloadWeChatMedia({ kind: "file", downloadUrl: "https://evil.test/x", aesKeyBase64: key.toString("base64") }, new AbortController().signal, { fetch })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(downloadWeChatMedia({ kind: "file", encryptedQuery: "q", aesKeyBase64: key.toString("base64") }, new AbortController().signal, { fetch: async () => new Response(null, { status: 302 }) })).rejects.toMatchObject({ code: "provider_rejected" });
    await expect(downloadWeChatMedia({ kind: "file", encryptedQuery: "q", aesKeyBase64: key.toString("base64") }, new AbortController().signal, { fetch: async () => new Response(Buffer.alloc(5 * 1_024 * 1_024 + 17)) })).rejects.toMatchObject({ code: "malformed_response" });
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
  });

  it("treats upload as one unknown effect and requires encrypted response parameter", async () => {
    const ciphertext = Buffer.alloc(16, 9);
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 200, headers: { "x-encrypted-param": "download-param" } });
    });
    expect(await uploadWeChatCiphertext({ uploadParam: "upload-param", fileKey: "a".repeat(32), ciphertext }, new AbortController().signal, { fetch })).toBe("download-param");
    await expect(uploadWeChatCiphertext({ uploadParam: "upload-param", fileKey: "a".repeat(32), ciphertext }, new AbortController().signal, { fetch: async () => new Response(null, { status: 503 }) })).rejects.toMatchObject({ code: "provider_unavailable", options: { effect: "unknown" } });
  });
});
