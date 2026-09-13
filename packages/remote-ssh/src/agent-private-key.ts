import { createPrivateKey, randomBytes } from "node:crypto";
import type { ParsedKey } from "ssh2";

/** OpenSSH PROTOCOL.key encoding, used only as ephemeral ssh-add stdin. */
export function encodeAgentPrivateKey(key: ParsedKey): Buffer {
  const buffers: Buffer[] = [];
  const keep = (value: Buffer): Buffer => { buffers.push(value); return value; };
  const bytes = (value: string | undefined): Buffer => {
    if (!value) throw new Error("SSH private identity has incomplete components.");
    return keep(Buffer.from(value, "base64url"));
  };
  const string = (value: Buffer | string): Buffer => {
    const buffer = typeof value === "string" ? Buffer.from(value) : value;
    const length = Buffer.alloc(4); length.writeUInt32BE(buffer.length);
    return keep(Buffer.concat([length, buffer]));
  };
  const integer = (value: string | undefined): Buffer => {
    const buffer = bytes(value);
    let start = 0;
    while (start < buffer.length && buffer[start] === 0) start++;
    const trimmed = buffer.subarray(start);
    return string(trimmed.length && trimmed[0]! >= 128 ? keep(Buffer.concat([Buffer.from([0]), trimmed])) : trimmed);
  };
  try {
    const jwk = createPrivateKey(key.getPrivatePEM()).export({ format: "jwk" });
    const fields: Buffer[] = [string(key.type)];
    if (key.type === "ssh-ed25519" && jwk.kty === "OKP" && jwk.crv === "Ed25519") {
      const x = bytes(jwk.x); const d = bytes(jwk.d);
      if (x.length !== 32 || d.length !== 32) throw new Error("SSH private identity has invalid components.");
      fields.push(string(x), string(keep(Buffer.concat([d, x]))));
    } else if (key.type === "ssh-rsa" && jwk.kty === "RSA") {
      fields.push(...[jwk.n, jwk.e, jwk.d, jwk.qi, jwk.p, jwk.q].map(integer));
    } else if (key.type.startsWith("ecdsa-sha2-") && jwk.kty === "EC") {
      const curve = jwk.crv === "P-256" ? "nistp256" : jwk.crv === "P-384" ? "nistp384" : jwk.crv === "P-521" ? "nistp521" : undefined;
      if (!curve || key.type !== `ecdsa-sha2-${curve}`) throw new Error("SSH private identity has an unsupported curve.");
      fields.push(string(curve), string(keep(Buffer.concat([Buffer.from([4]), bytes(jwk.x), bytes(jwk.y)]))), integer(jwk.d));
    } else throw new Error("SSH private identity algorithm is unsupported.");
    const check = keep(randomBytes(4));
    const content = keep(Buffer.concat([check, check, ...fields, string(key.comment)]));
    const padding = keep(Buffer.from(Array.from({ length: (8 - content.length % 8) % 8 }, (_, i) => i + 1)));
    const count = Buffer.alloc(4); count.writeUInt32BE(1);
    const binary = keep(Buffer.concat([Buffer.from("openssh-key-v1\0"), string("none"), string("none"), string(""), count,
      string(key.getPublicSSH()), string(keep(Buffer.concat([content, padding]))) ]));
    const lines = binary.toString("base64").match(/.{1,70}/gu)!;
    return Buffer.from(`-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`);
  } finally { for (const buffer of buffers) buffer.fill(0); }
}
