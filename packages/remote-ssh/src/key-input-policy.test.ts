import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";
import { describe, expect, it } from "vitest";
import { assertSshPrivateKeyInput } from "./key-input-policy.js";

const encrypted = ssh2.utils.generateKeyPairSync("ed25519", { passphrase: "bounded fixture", cipher: "aes256-ctr", rounds: 16 }).private;
const plain = ssh2.utils.generateKeyPairSync("ed25519").private;

describe("SSH private input cost boundary", () => {
  it("admits current OpenSSH keys and fixed-cost RSA/EC PEM containers", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
    for (const value of [plain, encrypted,
      rsa.export({ format: "pem", type: "pkcs1" }),
      rsa.export({ format: "pem", type: "pkcs1", cipher: "aes-256-cbc", passphrase: "bounded fixture" }),
      ec.export({ format: "pem", type: "sec1" })]) {
      expect(() => assertSshPrivateKeyInput(Buffer.from(value))).not.toThrow();
    }
  });

  it.each([0, 65, 0xffff_ffff])("rejects bcrypt round count %i before synchronous decryption", (rounds) => {
    const encoded = rewrite(encrypted, fields => {
      const saltLength = fields.kdfOptions.readUInt32BE(0);
      fields.kdfOptions.writeUInt32BE(rounds, 4 + saltLength);
    });
    expect(() => assertSshPrivateKeyInput(encoded)).toThrow("parsing policy");
  });

  it.each([15, 65])("rejects bcrypt salt length %i outside the bounded range", (length) => {
    const encoded = rewrite(encrypted, fields => {
      const salt = Buffer.alloc(length, 1);
      const rounds = Buffer.alloc(4); rounds.writeUInt32BE(16);
      fields.kdfOptions = Buffer.concat([sshString(salt), rounds]);
    });
    expect(() => assertSshPrivateKeyInput(encoded)).toThrow();
  });

  it("admits the explicit bcrypt policy limits and rejects unrelated KDFs, multiple keys and hardware identities", () => {
    const bounded = rewrite(encrypted, fields => {
      const rounds = Buffer.alloc(4); rounds.writeUInt32BE(64);
      fields.kdfOptions = Buffer.concat([sshString(Buffer.alloc(64, 1)), rounds]);
    });
    expect(() => assertSshPrivateKeyInput(bounded)).not.toThrow();
    for (const change of [
      (fields: Container) => { fields.kdf = Buffer.from("argon2id"); },
      (fields: Container) => { fields.count = 2; },
      (fields: Container) => { fields.publicKey = sshString(Buffer.from("sk-ssh-ed25519@openssh.com")); },
      (fields: Container) => { fields.kdfOptions = Buffer.concat([fields.kdfOptions, Buffer.from([0])]); }
    ]) expect(() => assertSshPrivateKeyInput(rewrite(encrypted, change))).toThrow();
  });

  it("rejects malformed lengths, unproved containers and input overflow without echoing their contents", () => {
    const pkcs8 = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
    const encoded = Buffer.from(plain.trim().split(/\r?\n/u).slice(1, -1).join(""), "base64");
    encoded.writeUInt32BE(0xffff_ffff, 15);
    const malformed = wrap(encoded);
    for (const input of [Buffer.from(pkcs8), malformed,
      Buffer.from("PuTTY-User-Key-File-3: ssh-ed25519\nPRIVATE_SAMPLE"), Buffer.alloc(65 * 1024, 1)]) {
      expect(() => assertSshPrivateKeyInput(input)).toThrow("SSH private key input is unsupported");
    }
  });
});

interface Container { cipher: Buffer; kdf: Buffer; kdfOptions: Buffer; count: number; publicKey: Buffer; tail: Buffer; }
function rewrite(value: string, change: (fields: Container) => void): Buffer {
  const binary = Buffer.from(value.trim().split(/\r?\n/u).slice(1, -1).join(""), "base64");
  let offset = 15;
  const read = (): Buffer => {
    const length = binary.readUInt32BE(offset); offset += 4;
    const bytes = binary.subarray(offset, offset + length); offset += length;
    return bytes;
  };
  const cipher = read(); const kdf = read(); const kdfOptions = read();
  const count = binary.readUInt32BE(offset); offset += 4;
  const publicKey = read();
  const fields = { cipher, kdf, kdfOptions, count, publicKey, tail: binary.subarray(offset) };
  change(fields);
  const keyCount = Buffer.alloc(4); keyCount.writeUInt32BE(fields.count);
  return wrap(Buffer.concat([binary.subarray(0, 15), sshString(fields.cipher), sshString(fields.kdf),
    sshString(fields.kdfOptions), keyCount, sshString(fields.publicKey), fields.tail]));
}
function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4); length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
}
function wrap(value: Buffer): Buffer {
  return Buffer.from(`-----BEGIN OPENSSH PRIVATE KEY-----\n${value.toString("base64")}\n-----END OPENSSH PRIVATE KEY-----\n`);
}
