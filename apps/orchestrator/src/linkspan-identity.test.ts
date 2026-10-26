import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { OperationalStore } from "@joko/store";
import { openLinkspanIdentity } from "./linkspan-identity.js";
import { CredentialVault } from "./credential-vault.js";

it("retains the encrypted node key and refuses silent key replacement after loss or conflict", async () => {
  const directory = await mkdtemp(join(tmpdir(), "joko-endpoint-identity-"));
  const store = new OperationalStore(join(directory, "state.db"));
  try {
    const vault = await CredentialVault.open(join(directory, "credentials", "master.key"));
    const input = { dataDirectory: directory, serverId: "endpoint-test", store, vault };
    const first = await openLinkspanIdentity(input);
    const restored = await openLinkspanIdentity(input);
    expect(restored.publicKey).toBe(first.publicKey);
    expect(restored.privateKey).toEqual(first.privateKey);
    const saved = await readFile(join(directory, "credentials", "linkspan-identity.json"), "utf8");
    expect(saved).not.toContain(Buffer.from(first.privateKey).toString("base64"));
    await unlink(join(directory, "credentials", "linkspan-identity.json"));
    await expect(openLinkspanIdentity(input)).rejects.toThrow(/Restore|recover/u);
    expect(store.findSetting<{ publicKey: string }>("service", "orchestrator", "public.linkspan_identity")?.value.publicKey).toBe(first.publicKey);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
