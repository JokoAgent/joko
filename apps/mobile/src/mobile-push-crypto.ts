import { CryptoDigestAlgorithm, digestStringAsync, getRandomBytesAsync, randomUUID } from "expo-crypto";

export function mobilePushTokenDigest(value: string): Promise<string> {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, value);
}

export function createMobilePushRegistrationId(): string {
  return randomUUID();
}

export async function createMobilePushRevocationSecret(): Promise<string> {
  const bytes = await getRandomBytesAsync(32);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}
