import { base64Encode } from "@bufbuild/protobuf/wire";
import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytesAsync, randomUUID } from "expo-crypto";

export function mobilePushTokenDigest(value: string): Promise<string> {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, value);
}

export function createMobilePushRegistrationId(): string {
  return randomUUID();
}

export async function createMobilePushRevocationSecret(): Promise<string> {
  const bytes = await getRandomBytesAsync(32);
  if (bytes.byteLength !== 32) throw new Error("Push revocation requires 32 random bytes.");
  return base64Encode(bytes, "url");
}
