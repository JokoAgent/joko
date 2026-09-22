import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { weChatInvalid, weChatMalformed } from "./errors.js";

export const WECHAT_MEDIA_MAXIMUM_BYTES = 5 * 1_024 * 1_024;
export const WECHAT_MEDIA_CIPHER_MAXIMUM_BYTES = WECHAT_MEDIA_MAXIMUM_BYTES + 16;

export interface WeChatPreparedUpload {
  readonly aesKeyHex: string;
  readonly ciphertext: Uint8Array;
  readonly fileKey: string;
  readonly md5Hex: string;
}

export function weChatCiphertextSize(plainBytes: number): number {
  if (!Number.isSafeInteger(plainBytes) || plainBytes < 1 || plainBytes > WECHAT_MEDIA_MAXIMUM_BYTES) {
    throw weChatInvalid("WeChat media size must be between 1 byte and 5 MiB.");
  }
  return Math.ceil((plainBytes + 1) / 16) * 16;
}

export function prepareWeChatUpload(bytes: Uint8Array): WeChatPreparedUpload {
  weChatCiphertextSize(bytes.byteLength);
  const key = randomBytes(16);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return {
    aesKeyHex: key.toString("hex"),
    ciphertext,
    fileKey: randomBytes(16).toString("hex"),
    md5Hex: createHash("md5").update(bytes).digest("hex")
  };
}

export function decryptWeChatMedia(input: {
  readonly ciphertext: Uint8Array;
  readonly aesKeyBase64?: string;
  readonly aesKeyHex?: string;
  readonly expectedPlainBytes?: number;
  readonly expectedCipherBytes?: number;
  readonly md5Hex?: string;
}): Uint8Array {
  const ciphertext = input.ciphertext;
  if (ciphertext.byteLength < 16 || ciphertext.byteLength > WECHAT_MEDIA_CIPHER_MAXIMUM_BYTES
    || ciphertext.byteLength % 16 !== 0
    || (input.expectedCipherBytes !== undefined && ciphertext.byteLength !== input.expectedCipherBytes)) {
    throw weChatMalformed("WeChat media ciphertext size is invalid.", false);
  }
  let plaintext: Uint8Array;
  try {
    const decipher = createDecipheriv("aes-128-ecb", parseKey(input), null);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw weChatMalformed("WeChat media decryption failed.", false);
  }
  if (plaintext.byteLength < 1 || plaintext.byteLength > WECHAT_MEDIA_MAXIMUM_BYTES
    || (input.expectedPlainBytes !== undefined && plaintext.byteLength !== input.expectedPlainBytes)) {
    throw weChatMalformed("WeChat media plaintext size did not match its metadata.", false);
  }
  if (input.md5Hex !== undefined) {
    if (!/^[a-f0-9]{32}$/iu.test(input.md5Hex)
      || createHash("md5").update(plaintext).digest("hex") !== input.md5Hex.toLowerCase()) {
      throw weChatMalformed("WeChat media checksum did not match its metadata.", false);
    }
  }
  return plaintext;
}

function parseKey(input: Pick<Parameters<typeof decryptWeChatMedia>[0], "aesKeyHex" | "aesKeyBase64">): Buffer {
  if (input.aesKeyHex !== undefined) {
    if (!/^[a-f0-9]{32}$/iu.test(input.aesKeyHex)) throw weChatInvalid("WeChat media AES key is invalid.");
    return Buffer.from(input.aesKeyHex, "hex");
  }
  const encoded = input.aesKeyBase64;
  if (encoded === undefined || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length > 64) {
    throw weChatInvalid("WeChat media AES key is invalid.");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength === 16) return decoded;
  if (decoded.byteLength === 32 && /^[a-f0-9]{32}$/iu.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw weChatInvalid("WeChat media AES key is invalid.");
}
