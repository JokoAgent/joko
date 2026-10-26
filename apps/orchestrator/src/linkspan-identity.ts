import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createIdentity, identityFromPrivateKey, type Identity } from "@jokoagent/linkspan-noise";
import type { OperationalStore } from "@joko/store";
import type { CredentialVault, EncryptedCredential } from "./credential-vault.js";
import { revokeAllNodeAccess } from "./node-access-recovery.js";

/** Private key ownership stays with Joko; Linkspan receives only this identity. */
export async function openLinkspanIdentity(input: {
  readonly dataDirectory: string;
  readonly serverId: string;
  readonly store: OperationalStore;
  readonly vault: CredentialVault;
}): Promise<Identity> {
  const reference = `linkspan.endpoint:${input.serverId}`;
  const path = join(input.dataDirectory, "credentials", "linkspan-identity.json");
  const advertised = input.store.findSetting<{ publicKey: string }>("service", "orchestrator", "public.linkspan_identity")?.value;
  let identity: Identity;
  try {
    const sealed = JSON.parse(await readFile(path, "utf8")) as EncryptedCredential;
    const bytes = Buffer.from(input.vault.open(sealed, reference), "base64");
    try { identity = await identityFromPrivateKey(bytes); } finally { bytes.fill(0); }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT") || advertised !== undefined) {
      throw new Error("The saved endpoint identity is unavailable. Restore its trusted credentials or explicitly recover the node identity.");
    }
    identity = await createIdentity();
    await mkdir(join(input.dataDirectory, "credentials"), { recursive: true });
    await writeFile(path, JSON.stringify(input.vault.seal(Buffer.from(identity.privateKey).toString("base64"), reference)), { flag: "wx", mode: 0o600 });
  }
  if (advertised !== undefined && advertised.publicKey !== identity.publicKey) {
    identity.privateKey.fill(0);
    throw new Error("The saved endpoint public key conflicts with its private identity. Explicit trusted recovery is required.");
  }
  if (advertised === undefined) input.store.setSetting("service", "orchestrator", "public.linkspan_identity", { publicKey: identity.publicKey });
  return identity;
}

/** A trusted, offline action also used after restoring a complete old backup. */
export async function recoverLinkspanIdentity(input: {
  readonly dataDirectory: string;
  readonly serverId: string;
  readonly store: OperationalStore;
  readonly vault: CredentialVault;
}): Promise<string> {
  const identity = await createIdentity();
  const reference = `linkspan.endpoint:${input.serverId}`;
  const directory = join(input.dataDirectory, "credentials");
  const pending = join(directory, `.linkspan-identity-${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(pending, JSON.stringify(input.vault.seal(Buffer.from(identity.privateKey).toString("base64"), reference)),
      { flag: "wx", mode: 0o600 });
    // Revoke before publishing the new private key. A crash between the Store
    // commit and rename leaves an identity conflict and startup refuses it.
    input.store.transaction(store => {
      revokeAllNodeAccess(store, input.serverId, Date.now());
      store.setSetting("service", "orchestrator", "public.linkspan_identity", { publicKey: identity.publicKey });
    });
    await rename(pending, join(directory, "linkspan-identity.json"));
    return identity.publicKey;
  } finally {
    identity.privateKey.fill(0);
    await rm(pending, { force: true });
  }
}
