import { createConnectTransport } from "@connectrpc/connect-web";
import { expect, vi } from "vitest";
import type { EndpointTrust } from "@joko/connection-transport";

export const mobileNetworkFixtureEndpointPublicKey = `ed25519:${"a".repeat(64)}`;

/** Generated RPC and host state tests control the wire below the secure adapter.
 * Trust policy remains real; these tests never open a socket to a fixture name. */
export function controlledMobileConnectionTransport(actual: typeof import("@joko/connection-transport")):
  typeof import("@joko/connection-transport") {
  const capture = (input: EndpointTrust): { readonly origin: string; readonly endpointPublicKey: string } => {
    const origin = actual.endpointOrigin(input.origin);
    const endpointPublicKey = input.endpointPublicKey === undefined
      ? actual.requireEndpointTrust(input) : actual.normalizeEndpointPublicKey(input.endpointPublicKey);
    expect(endpointPublicKey).toBe(mobileNetworkFixtureEndpointPublicKey);
    if (input.endpointPublicKey !== undefined) expect(input.endpointPublicKey).toBe(mobileNetworkFixtureEndpointPublicKey);
    return { origin, endpointPublicKey: endpointPublicKey! };
  };
  const controlledFetch = (captured: ReturnType<typeof capture>): typeof globalThis.fetch => (input, init) => {
    expect(captured.endpointPublicKey).toBe(mobileNetworkFixtureEndpointPublicKey);
    const url = typeof input === "string" || input instanceof URL ? input : input.url;
    expect(new URL(url, captured.origin).origin).toBe(captured.origin);
    expect(vi.isMockFunction(globalThis.fetch)).toBe(true);
    return globalThis.fetch(input, init);
  };
  return {
    ...actual,
    createConnectTransport(options) {
      const captured = capture({ origin: options.baseUrl, endpointPublicKey: options.endpointPublicKey });
      const { endpointPublicKey: _endpointPublicKey, ...wireOptions } = options;
      return createConnectTransport({ ...wireOptions, fetch: controlledFetch(captured) });
    },
    createConnectionFetch(input) { return controlledFetch(capture(input)); }
  };
}
