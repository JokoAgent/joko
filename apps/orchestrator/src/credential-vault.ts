import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface EncryptedCredential {
  readonly algorithm: "aes-256-gcm";
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export class CredentialVault {
  readonly #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  static async open(keyPath: string): Promise<CredentialVault> {
    await mkdir(dirname(keyPath), { recursive: true });
    let key: Buffer;
    try {
      key = await readFile(keyPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
      key = randomBytes(32);
      await writeFile(keyPath, key, { flag: "wx", mode: 0o600 });
    }
    if (key.byteLength !== 32) throw new Error("Orchestrator credential master key is invalid.");
    if (process.platform !== "win32") await chmod(keyPath, 0o600);
    return new CredentialVault(key);
  }

  seal(value: string, associatedReference: string): EncryptedCredential {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(associatedReference, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      algorithm: "aes-256-gcm",
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: cipher.getAuthTag().toString("base64")
    };
  }

  open(value: EncryptedCredential, associatedReference: string): string {
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(value.nonce, "base64"));
    decipher.setAAD(Buffer.from(associatedReference, "utf8"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
