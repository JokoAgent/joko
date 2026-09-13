import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteSshError } from "./errors.js";
import {
  FileSshHostKeyPinStore,
  sshHostKeyFingerprint,
  sshHostKeyPinId,
  TofuSshHostKeyVerifier
} from "./host-keys.js";
import type { SshHostKeyPinStorePort } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

describe("SSH host key identity", () => {
  it("uses the OpenSSH-style SHA256 fingerprint without base64 padding", () => {
    expect(sshHostKeyFingerprint(Uint8Array.from([1, 2, 3, 4]))).toBe(
      "SHA256:n2SnR+G5fxMfq7a0Rylsm28CAeefs8U1bmx36JtqgGo"
    );
  });

  it("scopes pins to normalized hostname, port, and algorithm", () => {
    expect(sshHostKeyPinId("EXAMPLE.COM", 22, "ssh-ed25519")).toBe("example.com:22|ssh-ed25519");
    expect(sshHostKeyPinId("2001:DB8::1", 2200, "rsa-sha2-512")).toBe(
      "[2001:db8::1]:2200|rsa-sha2-512"
    );
  });

  it("rejects missing key bytes and malformed algorithms before touching the store", async () => {
    const store: SshHostKeyPinStorePort = { compareAndPin: vi.fn() };
    const verifier = new TofuSshHostKeyVerifier(store);
    await expect(verifier.verify({
      hostname: "example.com",
      port: 22,
      algorithm: "ssh-ed25519",
      key: new Uint8Array()
    })).rejects.toEqual(expect.objectContaining({ code: "HOST_KEY_MISSING" }));
    await expect(verifier.verify({
      hostname: "example.com",
      port: 22,
      algorithm: "bad algorithm",
      key: Uint8Array.of(1)
    })).rejects.toEqual(expect.objectContaining({ code: "HOST_KEY_INVALID" }));
    expect(store.compareAndPin).not.toHaveBeenCalled();
  });

  it("sanitizes injected store failures and rejects invalid store decisions", async () => {
    const leakingStore: SshHostKeyPinStorePort = {
      compareAndPin: vi.fn(async () => {
        throw new RemoteSshError(
          "HOST_KEY_STORE_UNREADABLE",
          "RAW_STORE_SENTINEL",
          true,
          { unsafe: "RAW_STORE_SENTINEL" }
        );
      })
    };
    const request = {
      hostname: "example.com",
      port: 22,
      algorithm: "ssh-ed25519",
      key: Uint8Array.of(1)
    };
    const failure = await new TofuSshHostKeyVerifier(leakingStore).verify(request).catch((error: unknown) => error);
    expect(failure).toEqual(expect.objectContaining({ code: "HOST_KEY_STORE_UNREADABLE", retryable: false }));
    expect(JSON.stringify(failure)).not.toContain("RAW_STORE_SENTINEL");

    const invalidStore: SshHostKeyPinStorePort = {
      compareAndPin: vi.fn(async () => "invalid" as "matched")
    };
    await expect(new TofuSshHostKeyVerifier(invalidStore).verify(request)).rejects.toEqual(
      expect.objectContaining({ code: "HOST_KEY_STORE_CORRUPT", retryable: false })
    );
  });
});

describe("file host key pin store", () => {
  it("initializes a private app-owned store, pins once atomically, and matches after restart", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "trust", "host-keys.json");
    const store = await FileSshHostKeyPinStore.initialize({ filePath });
    const request = pin("example.com:22|ssh-ed25519", Uint8Array.of(1, 2, 3));
    await expect(store.compareAndPin(request)).resolves.toBe("pinned");
    const restarted = new FileSshHostKeyPinStore({ filePath });
    await expect(restarted.compareAndPin(request)).resolves.toBe("matched");
    const persisted = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(persisted).toEqual({ version: 1, pins: { [request.id]: request.fingerprint } });
    expect((await fs.readdir(join(root, "trust"))).sort()).toEqual(["host-keys.json"]);
    if (process.platform !== "win32") {
      expect((await fs.stat(filePath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(join(root, "trust"))).mode & 0o777).toBe(0o700);
    }
  });

  it("rejects a changed key and leaves the original pin intact", async () => {
    const { filePath, store } = await initializedStore();
    const first = pin("example.com:22|ssh-ed25519", Uint8Array.of(1));
    const changed = pin(first.id, Uint8Array.of(2));
    await store.compareAndPin(first);
    await expect(store.compareAndPin(changed)).rejects.toEqual(
      expect.objectContaining<Partial<RemoteSshError>>({ code: "HOST_KEY_CHANGED", retryable: false })
    );
    expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({
      version: 1,
      pins: { [first.id]: first.fingerprint }
    });
  });

  it("fails closed if an initialized store disappears", async () => {
    const { filePath, store } = await initializedStore();
    await fs.unlink(filePath);
    await expect(store.compareAndPin(pin("example.com:22|ssh-ed25519", Uint8Array.of(1)))).rejects.toEqual(
      expect.objectContaining({ code: "HOST_KEY_STORE_MISSING", retryable: false })
    );
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["invalid JSON", "{"],
    ["wrong root", "[]"],
    ["wrong version", JSON.stringify({ version: 2, pins: {} })],
    ["non-string pin", JSON.stringify({ version: 1, pins: { endpoint: null } })],
    ["invalid fingerprint", JSON.stringify({ version: 1, pins: { endpoint: "sha256:no" } })]
  ])("fails closed for %s", async (_label, content) => {
    const root = await temporaryDirectory();
    const filePath = join(root, "host-keys.json");
    await fs.writeFile(filePath, content, { mode: 0o600 });
    const store = new FileSshHostKeyPinStore({ filePath });
    await expect(store.compareAndPin(pin("example.com:22|ssh-ed25519", Uint8Array.of(1)))).rejects.toEqual(
      expect.objectContaining({ code: "HOST_KEY_STORE_CORRUPT", retryable: false })
    );
  });

  it("fails closed when the store path is unreadable as a regular file", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "host-keys.json");
    await fs.mkdir(filePath);
    const store = new FileSshHostKeyPinStore({ filePath });
    await expect(store.compareAndPin(pin("example.com:22|ssh-ed25519", Uint8Array.of(1)))).rejects.toEqual(
      expect.objectContaining({ code: "HOST_KEY_STORE_UNREADABLE", retryable: false })
    );
  });

  it("allows only one concurrent first-use writer and fails the rest closed", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "trust", "host-keys.json");
    await FileSshHostKeyPinStore.initialize({ filePath });
    const request = pin("example.com:22|ssh-ed25519", Uint8Array.of(9, 8, 7));
    const stores = Array.from({ length: 12 }, () => new FileSshHostKeyPinStore({ filePath }));
    const results = await Promise.allSettled(stores.map((store) => store.compareAndPin(request)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(11);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toEqual(expect.objectContaining({ code: "HOST_KEY_CONFLICT", retryable: false }));
      }
    }
  });

  it("keeps algorithm-specific pins separate", async () => {
    const { store } = await initializedStore();
    await expect(store.compareAndPin(pin("example.com:22|ssh-ed25519", Uint8Array.of(1)))).resolves.toBe("pinned");
    await expect(store.compareAndPin(pin("example.com:22|rsa-sha2-512", Uint8Array.of(2)))).resolves.toBe("pinned");
  });
});

function pin(id: string, key: Uint8Array): { readonly id: string; readonly fingerprint: string } {
  return { id, fingerprint: sshHostKeyFingerprint(key) };
}

async function initializedStore(): Promise<{
  readonly filePath: string;
  readonly store: FileSshHostKeyPinStore;
}> {
  const root = await temporaryDirectory();
  const filePath = join(root, "host-keys.json");
  return { filePath, store: await FileSshHostKeyPinStore.initialize({ filePath }) };
}

async function temporaryDirectory(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), "joko-remote-ssh-trust-"));
  temporaryDirectories.push(path);
  return path;
}
