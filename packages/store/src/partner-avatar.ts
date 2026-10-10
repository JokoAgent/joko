import { createHash } from "node:crypto";
import { PartnerStoreError, type PartnerAvatarImageRecord } from "./partner-types.js";

export const PARTNER_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

export function decodePartnerAvatar(base64: string): { readonly image: PartnerAvatarImageRecord; readonly bytes: Uint8Array } {
  const invalid = (): never => { throw new PartnerStoreError("PARTNER_INVALID", "Select a valid PNG, JPEG or WebP Partner image of at most 5 MiB."); };
  if (typeof base64 !== "string" || !base64.length || base64.length > Math.ceil(PARTNER_AVATAR_MAX_BYTES / 3) * 4
    || base64.length % 4 !== 0 || !BASE64.test(base64)) return invalid();
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > PARTNER_AVATAR_MAX_BYTES || bytes.toString("base64") !== base64) return invalid();
  const mimeType = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
    : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : undefined;
  if (mimeType === undefined) return invalid();
  return { image: { sha256: createHash("sha256").update(bytes).digest("hex"), mimeType, byteLength: bytes.length }, bytes };
}

export function partnerAvatarImage(value: unknown): PartnerAvatarImageRecord {
  const image = value as Partial<PartnerAvatarImageRecord> | null;
  if (!image || typeof image !== "object" || Array.isArray(image) || Object.keys(image).sort().join(",") !== "byteLength,mimeType,sha256"
    || typeof image.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(image.sha256)
    || !["image/jpeg", "image/png", "image/webp"].includes(image.mimeType ?? "")
    || !Number.isSafeInteger(image.byteLength) || image.byteLength! < 1 || image.byteLength! > PARTNER_AVATAR_MAX_BYTES) {
    throw new PartnerStoreError("PARTNER_INVALID", "The Partner image descriptor is invalid.");
  }
  return { sha256: image.sha256, mimeType: image.mimeType!, byteLength: image.byteLength! };
}
