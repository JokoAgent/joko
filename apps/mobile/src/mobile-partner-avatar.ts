import { base64Decode, base64Encode } from "@bufbuild/protobuf/wire";
import type { PartnerAvatar, PartnerAvatarInput } from "@joko/contracts";

export interface MobilePartnerAvatarImage {
  readonly sha256: string;
  readonly mimeType: "image/jpeg" | "image/png" | "image/webp";
  readonly byteLength: number;
}
export type MobilePartnerAvatarValue = string | MobilePartnerAvatarImage;
export type MobilePartnerAvatarDraft = MobilePartnerAvatarValue | { readonly base64: string };
export interface MobilePartnerAvatarIdentity {
  readonly partnerId: string; readonly revision: bigint; readonly avatar: MobilePartnerAvatarValue;
}
export interface MobilePartnerAvatarTransport {
  readonly ownerKey: string;
  read(partner: MobilePartnerAvatarIdentity, signal: AbortSignal): Promise<string>;
}

export function projectMobilePartnerAvatar(value: PartnerAvatar | undefined): MobilePartnerAvatarValue {
  if (value?.value.case === "presetId" && /^[a-z][a-z0-9-]{0,31}$/u.test(value.value.value)) return value.value.value;
  if (value?.value.case === "image") {
    const image = value.value.value;
    if (/^[a-f0-9]{64}$/u.test(image.sha256) && ["image/jpeg", "image/png", "image/webp"].includes(image.mimeType)
      && image.byteLength > 0n && image.byteLength <= 5_242_880n) return { sha256: image.sha256,
        mimeType: image.mimeType as MobilePartnerAvatarImage["mimeType"], byteLength: Number(image.byteLength) };
  }
  throw new Error("The Joko node returned an invalid Partner avatar.");
}

export function mobilePartnerPhotoValid(base64: string): boolean {
  try {
    if (!base64 || base64.length > 55_000) return false;
    const bytes = base64Decode(base64);
    return bytes.length > 0 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && base64Encode(bytes) === base64;
  } catch { return false; }
}

export function protoMobilePartnerAvatar(value: string | { readonly base64: string }): { value: PartnerAvatarInput["value"] } {
  return { value: typeof value === "string" ? { case: "presetId", value }
    : { case: "imageBase64", value: value.base64 } };
}

export async function pickMobilePartnerPhoto(signal: AbortSignal): Promise<{ readonly base64: string } | undefined> {
  signal.throwIfAborted();
  const picker = await import("expo-image-picker");
  const result = await picker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, aspect: [1, 1], quality: 1 });
  signal.throwIfAborted();
  if (result.canceled || !result.assets[0]) return undefined;
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  const { File } = await import("expo-file-system");
  signal.throwIfAborted();
  const context = ImageManipulator.manipulate(result.assets[0].uri);
  let image: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
  try {
    context.resize({ width: 256, height: 256 });
    image = await context.renderAsync();
    signal.throwIfAborted();
    for (const compress of [0.85, 0.65, 0.4]) {
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress, base64: true });
      try { new File(saved.uri).delete(); } catch { /* Only this generated thumbnail is disposable. */ }
      signal.throwIfAborted();
      if (saved.base64 && mobilePartnerPhotoValid(saved.base64)) return { base64: saved.base64 };
    }
    throw new Error("Partner photo preparation failed.");
  } finally { image?.release(); context.release(); }
}
