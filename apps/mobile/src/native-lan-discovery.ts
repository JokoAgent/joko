import { getRandomBytes } from "expo-crypto";
import { requireOptionalNativeModule } from "expo";
import { createMobileDiscovery, type MobileLanDiscoveryTransport } from "./connection-discovery";

interface NativeLanDiscoveryResponse {
  readonly data: string;
  readonly address: string;
}

interface NativeLanDiscoveryModule {
  discover(
    queryBase64: string,
    group: string,
    port: number,
    timeoutMs: number,
    maximumResponses: number
  ): Promise<readonly NativeLanDiscoveryResponse[]>;
}

const nativeModule = requireOptionalNativeModule<NativeLanDiscoveryModule>("JokoLanDiscovery");

const nativeTransport: MobileLanDiscoveryTransport = {
  async discover(request) {
    if (nativeModule === null) {
      throw new Error("Nearby node discovery requires an installed Joko mobile build; it is unavailable in this runtime.");
    }
    const responses = await nativeModule.discover(
      bytesToBase64(request.bytes),
      request.group,
      request.port,
      request.timeoutMs,
      request.maximumResponses
    );
    return responses.map((response) => ({
      bytes: base64ToBytes(response.data),
      address: response.address
    }));
  }
};

export const mobileDiscovery = createMobileDiscovery(
  nativeTransport,
  () => getRandomBytes(16)
);

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
