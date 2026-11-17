import { createCipheriv, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PortableSessionPackageError,
  createPortableSessionManifest,
  decodePortableSessionPackage,
  encodePortableSessionPackage,
  isEncryptedPortableSessionPackage,
  type PortableSessionPackage
} from "./portable-session-package.js";

function fixture(): PortableSessionPackage {
  return {
    manifest: createPortableSessionManifest({
      exportedAt: "2026-08-25T12:00:00.000Z",
      applicationVersion: "0.1.0",
      title: "Portable task",
      workspaceKind: "project",
      backendCapability: "native-session-tree-v1",
      fidelity: "full",
      messageCount: 2,
      mediaCount: 1,
      nativeHistoryEntry: "native/lead.jsonl",
      workers: [{
        id: "worker-one",
        title: "Research",
        role: "researcher",
        state: "completed",
        focused: true,
        backendCapability: "native-session-tree-v1",
        nativeHistoryEntry: "native/workers/worker-one.jsonl"
      }]
    }),
    entries: [
      { path: "native/lead.jsonl", kind: "native_history", mediaType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"session\"}\n") },
      { path: "native/workers/worker-one.jsonl", kind: "native_history", mediaType: "application/x-ndjson", bytes: Buffer.from("{\"type\":\"session\"}\n") },
      { path: "media/diagram.png", kind: "artifact", mediaType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }
    ]
  };
}

function encryptedWithExactPasswordBytes(value: PortableSessionPackage, password: string): Buffer {
  const magic = Buffer.from("JOKOSESSION\u0001", "ascii");
  const plain = Buffer.from(encodePortableSessionPackage(value));
  const compressed = plain.subarray(magic.byteLength + 4 + plain.readUInt32BE(magic.byteLength));
  const encrypted = Buffer.from(encodePortableSessionPackage(value, { password: "Header fixture" }));
  const headerStart = magic.byteLength + 4;
  const header = JSON.parse(encrypted.subarray(headerStart, headerStart + encrypted.readUInt32BE(magic.byteLength)).toString("utf8")) as {
    readonly salt: string; readonly nonce: string; readonly tag: string; readonly kdf: string; readonly [field: string]: unknown;
  };
  expect(header.kdf).toBe("scrypt-32768-8-1");
  const { tag: _tag, ...authenticated } = header;
  const key = scryptSync(Buffer.from(password, "utf8"), Buffer.from(header.salt, "base64"), 32,
    { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "base64"));
  cipher.setAAD(Buffer.from(JSON.stringify(authenticated), "utf8"));
  const payload = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const headerBytes = Buffer.from(JSON.stringify({ ...authenticated, tag: cipher.getAuthTag().toString("base64") }), "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(headerBytes.byteLength);
  return Buffer.concat([magic, length, headerBytes, payload]);
}

describe("portable Session package", () => {
  it("round-trips a full native Session, Worker graph, and media without a password", () => {
    const encoded = encodePortableSessionPackage(fixture());
    expect(isEncryptedPortableSessionPackage(encoded)).toBe(false);
    const decoded = decodePortableSessionPackage(encoded);
    expect(decoded.manifest).toEqual(fixture().manifest);
    expect(decoded.entries.map((entry) => ({ path: entry.path, bytes: Buffer.from(entry.bytes).toString("hex") }))).toEqual(
      fixture().entries.map((entry) => ({ path: entry.path, bytes: Buffer.from(entry.bytes).toString("hex") }))
    );
  });

  it("uses authenticated password encryption and rejects missing, wrong, or tampered input", () => {
    const encoded = encodePortableSessionPackage(fixture(), { password: "correct horse battery staple" });
    expect(isEncryptedPortableSessionPackage(encoded)).toBe(true);
    expect(() => decodePortableSessionPackage(encoded)).toThrowError(
      expect.objectContaining<Partial<PortableSessionPackageError>>({ code: "PASSWORD_REQUIRED" })
    );
    expect(() => decodePortableSessionPackage(encoded, { password: "wrong" })).toThrowError(
      expect.objectContaining<Partial<PortableSessionPackageError>>({ code: "DECRYPTION_FAILED" })
    );
    const tampered = Uint8Array.from(encoded);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0xff;
    expect(() => decodePortableSessionPackage(tampered, { password: "correct horse battery staple" })).toThrowError(
      expect.objectContaining<Partial<PortableSessionPackageError>>({ code: "DECRYPTION_FAILED" })
    );
    expect(decodePortableSessionPackage(encoded, { password: "correct horse battery staple" }).manifest.title).toBe("Portable task");
  });

  it.each([
    ["caf\u00e9", "cafe\u0301"],
    ["cafe\u0301", "caf\u00e9"],
    ["a\u0301\u0327", "a\u0327\u0301"]
  ])("unlocks canonically equivalent password input %j with %j", (exportPassword, importPassword) => {
    const value = fixture();
    const encoded = encodePortableSessionPackage(value, { password: exportPassword });
    const decoded = decodePortableSessionPackage(encoded, { password: importPassword });
    expect(isEncryptedPortableSessionPackage(encoded)).toBe(true);
    expect(decoded.manifest).toEqual(value.manifest);
    expect(decoded.entries).toEqual(value.entries);
    const tampered = Buffer.from(encoded);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(() => decodePortableSessionPackage(tampered, { password: importPassword })).toThrowError(
      expect.objectContaining<Partial<PortableSessionPackageError>>({ code: "DECRYPTION_FAILED" })
    );
  });

  it.each([
    ["decomposed password", "cafe\u0301"],
    ["raw byte limit", "\u0344".repeat(512)]
  ])("authenticates the supplied bytes of an existing current-format package at %s", (_label, password) => {
    const value = fixture();
    const decoded = decodePortableSessionPackage(encryptedWithExactPasswordBytes(value, password), { password });
    expect(decoded.manifest).toEqual(value.manifest);
    expect(decoded.entries).toEqual(value.entries);
  });

  it("keeps password whitespace significant and bounds both supplied and canonical export bytes", () => {
    const encoded = encodePortableSessionPackage(fixture(), { password: " caf\u00e9 " });
    expect(decodePortableSessionPackage(encoded, { password: " cafe\u0301 " }).manifest.title).toBe("Portable task");
    for (const password of ["caf\u00e9", " caf\u00e9  ", " caf\u00e8 "]) {
      expect(() => decodePortableSessionPackage(encoded, { password })).toThrowError(
        expect.objectContaining<Partial<PortableSessionPackageError>>({ code: "DECRYPTION_FAILED" })
      );
    }
    for (const password of ["", "a\u0000b", "a".repeat(1025), "e\u0301".repeat(342), "\u0344".repeat(512)]) {
      expect(() => encodePortableSessionPackage(fixture(), { password })).toThrowError(
        expect.objectContaining<Partial<PortableSessionPackageError>>({ code: "INVALID_PACKAGE" })
      );
    }
  });

  it("rejects traversal, absolute, drive-qualified, duplicate, and unresolved native entry paths", () => {
    for (const path of ["../secret", "/absolute", "C:/secret", "native\\lead.jsonl", "native//lead.jsonl"]) {
      const value = fixture();
      expect(() => encodePortableSessionPackage({ ...value, entries: [{ ...value.entries[0]!, path }] })).toThrow(
        /entry path is unsafe|native history entry is missing/
      );
    }
    const duplicated = fixture();
    expect(() => encodePortableSessionPackage({
      ...duplicated,
      entries: [...duplicated.entries, duplicated.entries[0]!]
    })).toThrow(/duplicated/);
    const unresolved = fixture();
    expect(() => encodePortableSessionPackage({
      ...unresolved,
      manifest: { ...unresolved.manifest, nativeHistoryEntry: "native/missing.jsonl" }
    })).toThrow(/native history entry is missing/);
  });

  it("enforces bounded encoded and decompressed content before materializing entries", () => {
    expect(() => encodePortableSessionPackage(fixture(), { contentLimitBytes: 4 })).toThrowError(
      expect.objectContaining<Partial<PortableSessionPackageError>>({ code: "CONTENT_LIMIT_EXCEEDED" })
    );
    const encoded = encodePortableSessionPackage(fixture());
    expect(() => decodePortableSessionPackage(encoded, { contentLimitBytes: 32 })).toThrowError(
      expect.objectContaining<Partial<PortableSessionPackageError>>({ code: "CONTENT_LIMIT_EXCEEDED" })
    );
  });

  it("validates manifest bounds and does not accept an unknown format version", () => {
    expect(() => createPortableSessionManifest({
      exportedAt: "not-a-date",
      applicationVersion: "0.1.0",
      title: "Task",
      workspaceKind: "dialogue",
      backendCapability: "native-session-tree-v1",
      fidelity: "product_only",
      messageCount: 0,
      mediaCount: 0
    })).toThrow(/export time is invalid/);

    const encoded = Uint8Array.from(encodePortableSessionPackage(fixture()));
    const magicLength = Buffer.from("JOKOSESSION\u0001", "ascii").byteLength;
    const headerLength = Buffer.from(encoded).readUInt32BE(magicLength);
    const headerStart = magicLength + 4;
    const header = JSON.parse(Buffer.from(encoded).subarray(headerStart, headerStart + headerLength).toString("utf8")) as Record<string, unknown>;
    header.formatVersion = 2;
    const replacement = Buffer.from(JSON.stringify(header), "utf8");
    expect(replacement.byteLength).toBe(headerLength);
    encoded.set(replacement, headerStart);
    expect(() => decodePortableSessionPackage(encoded)).toThrowError(
      expect.objectContaining<Partial<PortableSessionPackageError>>({ code: "UNSUPPORTED_VERSION" })
    );
  });
});
