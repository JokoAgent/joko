import { base64Decode, base64Encode } from "@bufbuild/protobuf/wire";
import type { PartnerAvatar, PartnerAvatarInput } from "@joko/contracts";

export interface PartnerAvatarImageView {
  readonly sha256: string;
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
  readonly byteLength: number;
}
export type PartnerAvatarView = string | PartnerAvatarImageView;
export type PartnerAvatarInputView = string | { readonly base64: string };
export type PartnerAvatarDraft = PartnerAvatarView | PartnerAvatarInputView;
export const PARTNER_AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export function mapPartnerAvatar(value: PartnerAvatar | undefined): PartnerAvatarView {
  if (value?.value.case === "presetId" && /^[a-z][a-z0-9-]{0,31}$/u.test(value.value.value)) return value.value.value;
  if (value?.value.case === "image") {
    const image = value.value.value;
    if (/^[a-f0-9]{64}$/u.test(image.sha256) && ["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)
      && image.byteLength > 0n && image.byteLength <= BigInt(PARTNER_AVATAR_MAX_BYTES)) {
      return { sha256: image.sha256, mimeType: image.mimeType as PartnerAvatarImageView["mimeType"], byteLength: Number(image.byteLength) };
    }
  }
  throw new Error("The Joko node returned an invalid Partner avatar.");
}

export function protoPartnerAvatar(avatar: PartnerAvatarInputView): { value: PartnerAvatarInput["value"] } {
  return { value: typeof avatar === "string" ? { case: "presetId", value: avatar }
    : { case: "imageBase64", value: avatar.base64 } };
}

export function partnerAvatarInput(value: PartnerAvatarDraft): value is PartnerAvatarInputView {
  if (typeof value === "string") return /^[a-z][a-z0-9-]{0,31}$/u.test(value);
  if (!("base64" in value)) return false;
  try {
    if (!value.base64 || value.base64.length > Math.ceil(PARTNER_AVATAR_MAX_BYTES / 3) * 4) return false;
    const bytes = base64Decode(value.base64);
    return bytes.length > 0 && bytes.length <= PARTNER_AVATAR_MAX_BYTES && base64Encode(bytes) === value.base64;
  } catch { return false; }
}

export async function preparePartnerPhoto(file: File, signal: AbortSignal): Promise<{ readonly base64: string }> {
  signal.throwIfAborted();
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || !file.size || file.size > PARTNER_AVATAR_MAX_BYTES) throw new Error("Invalid Partner photo.");
  const bitmap = await createImageBitmap(file);
  try {
    signal.throwIfAborted();
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error("Invalid Partner photo dimensions.");
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 256;
    const context = canvas.getContext("2d"); if (!context) throw new Error("Partner photo preparation is unavailable.");
    const size = Math.min(bitmap.width, bitmap.height);
    context.drawImage(bitmap, (bitmap.width - size) / 2, (bitmap.height - size) / 2, size, size, 0, 0, 256, 256);
    for (const quality of [0.85, 0.65, 0.4]) {
      const base64 = canvas.toDataURL("image/jpeg", quality).replace(/^data:image\/jpeg;base64,/u, "");
      signal.throwIfAborted();
      if (base64 && base64.length <= 55_000 && partnerAvatarInput({ base64 })) return { base64 };
    }
    throw new Error("Partner photo preparation failed.");
  } finally { bitmap.close(); }
}
