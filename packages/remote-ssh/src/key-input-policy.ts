const MAXIMUM_INPUT_BYTES = 64 * 1024;
const OPENSSH_HEADER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const OPENSSH_FOOTER = "-----END OPENSSH PRIVATE KEY-----";
const OPENSSH_MAGIC = Buffer.from("openssh-key-v1\0");

/** Bounds public key-container costs before ssh2's synchronous decryption. */
export function assertSshPrivateKeyInput(encoded: Buffer): void {
  if (encoded.length === 0 || encoded.length > MAXIMUM_INPUT_BYTES) invalid();
  const text = encoded.toString("utf8").trim();
  if (!text.startsWith(`${OPENSSH_HEADER}\n`) && !text.startsWith(`${OPENSSH_HEADER}\r\n`)) {
    // Traditional RSA/EC PEM encryption has a fixed-cost derivation. Other
    // containers have not established a bounded KDF contract at this boundary.
    for (const type of ["RSA", "EC"]) {
      const header = `-----BEGIN ${type} PRIVATE KEY-----`;
      if ((text.startsWith(`${header}\n`) || text.startsWith(`${header}\r\n`))
        && text.endsWith(`-----END ${type} PRIVATE KEY-----`)) return;
    }
    invalid();
  }
  if (!text.endsWith(OPENSSH_FOOTER)) invalid();
  const body = text.slice(OPENSSH_HEADER.length, -OPENSSH_FOOTER.length).replace(/[\r\n]/gu, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(body)) invalid();
  const decoded = Buffer.from(body, "base64");
  try {
    if (decoded.toString("base64") !== body || !decoded.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) invalid();
    const fields = new SshFields(decoded, OPENSSH_MAGIC.length);
    const cipher = fields.string().toString("utf8");
    const kdf = fields.string().toString("utf8");
    const options = fields.string();
    if (cipher === "none") {
      if (kdf !== "none" || options.length !== 0) invalid();
    } else {
      // Cipher support and ciphertext integrity remain ssh2's public parser's
      // authority; no alternative KDF is allowed to reach it synchronously.
      if (cipher.length === 0 || kdf !== "bcrypt") invalid();
      const costs = new SshFields(options);
      const salt = costs.string();
      const rounds = costs.uint32();
      if (salt.length < 16 || salt.length > 64 || rounds < 1 || rounds > 64 || !costs.finished()) invalid();
    }
    if (fields.uint32() !== 1) invalid();
    const publicKey = new SshFields(fields.string());
    const algorithm = publicKey.string().toString("utf8");
    if (algorithm !== "ssh-ed25519" && algorithm !== "ssh-rsa"
      && algorithm !== "ecdsa-sha2-nistp256" && algorithm !== "ecdsa-sha2-nistp384" && algorithm !== "ecdsa-sha2-nistp521") invalid();
    if (fields.string().length === 0) invalid();
    // Authenticated ciphers can append their tag. ssh2 checks its exact size.
  } finally { decoded.fill(0); }
}

class SshFields {
  constructor(readonly bytes: Buffer, private offset = 0) {}
  uint32(): number {
    if (this.offset + 4 > this.bytes.length) invalid();
    const value = this.bytes.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }
  string(): Buffer {
    const length = this.uint32();
    if (length > this.bytes.length - this.offset) invalid();
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  finished(): boolean { return this.offset === this.bytes.length; }
}

function invalid(): never { throw new Error("SSH private key input is unsupported or exceeds its parsing policy."); }
