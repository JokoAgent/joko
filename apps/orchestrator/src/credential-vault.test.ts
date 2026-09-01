import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialVault } from "./credential-vault.js";

describe("CredentialVault", () => {
  it("binds ciphertext to its credential reference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-vault-"));
    const vault = await CredentialVault.open(join(directory, "master.key"));
    const sealed = vault.seal("secret-value", "provider-a");
    expect(sealed.ciphertext).not.toContain("secret-value");
    expect(vault.open(sealed, "provider-a")).toBe("secret-value");
    expect(() => vault.open(sealed, "provider-b")).toThrow();
  });
});
