import { base64Decode, base64Encode } from "@bufbuild/protobuf/wire";
import { LAN_DISCOVERY_MAX_DATAGRAM_BYTES } from "@joko/contracts";
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
      base64Encode(request.bytes),
      request.group,
      request.port,
      request.timeoutMs,
      request.maximumResponses
    );
    return responses.slice(0, request.maximumResponses).flatMap((response) => {
      const bytes = decodeNativeDatagram(response.data);
      return bytes === undefined ? [] : [{ bytes, address: response.address }];
    });
  }
};

export const mobileDiscovery = createMobileDiscovery(
  nativeTransport,
  () => getRandomBytes(16)
);

function decodeNativeDatagram(value: string): Uint8Array | undefined {
  if (typeof value !== "string" || value.length === 0
    || value.length > Math.ceil(LAN_DISCOVERY_MAX_DATAGRAM_BYTES / 3) * 4) return undefined;
  try {
    const bytes = base64Decode(value);
    if (bytes.byteLength > LAN_DISCOVERY_MAX_DATAGRAM_BYTES || base64Encode(bytes) !== value) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}
