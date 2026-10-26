import { describe, expect, it } from "vitest";
import { mobileConnectionJson, parseMobileConnectionMessage } from "./mobile-connection-protocol";

describe("local shared connection capability bridge", () => {
  it("accepts exact public actions and rejects retired, forged or malformed requests", () => {
    const instanceId = "connection-current";
    const request = (name: string, args: readonly unknown[], extra: Record<string, unknown> = {}) =>
      JSON.stringify({ type: "action", instanceId, id: 1, name, args, ...extra });
    expect(parseMobileConnectionMessage(JSON.stringify({ type: "ready", instanceId }), instanceId)?.type).toBe("ready");
    expect(parseMobileConnectionMessage(request("pair", ["https://node.example", "123456", "Phone", { automatic: false }]), instanceId))
      .toMatchObject({ name: "pair", args: ["https://node.example", "123456", "Phone", { automatic: false }] });
    expect(parseMobileConnectionMessage(request("connect", ["profile-1", { automatic: true }]), instanceId)?.type).toBe("action");
    expect(parseMobileConnectionMessage(request('startDeviceAuthorization', ['joko://pair#invitation', 'Phone']), instanceId)?.type).toBe('action');
    expect(parseMobileConnectionMessage(request('finishDeviceAuthorization', [{ automatic: true }]), instanceId)?.type).toBe('action');
    expect(parseMobileConnectionMessage(request('finishDeviceAuthorization', [{ authKey: 'forged' }]), instanceId)).toBeUndefined();
    expect(parseMobileConnectionMessage(request('getDeviceTransportRequest', []), instanceId)?.type).toBe('action');
    expect(parseMobileConnectionMessage(request('cancelDeviceTransportRequest', ['11111111-1111-4111-8111-111111111111']), instanceId)?.type).toBe('action');
    expect(parseMobileConnectionMessage(request('cancelDeviceTransportRequest', []), instanceId)).toBeUndefined();
    expect(parseMobileConnectionMessage(request('copyDeviceApprovalLink', ['joko://pair#secret']), instanceId)).toBeUndefined();
    expect(parseMobileConnectionMessage(request('startDeviceAuthorization', ['x'.repeat(65537), 'Phone']), instanceId)).toBeUndefined();
    expect(parseMobileConnectionMessage(request('claimDeviceAuthorization', ['forged-proof']), instanceId)).toBeUndefined();
    expect(parseMobileConnectionMessage(request("selectMode", ["pair"]), instanceId)?.type).toBe("action");
    expect(parseMobileConnectionMessage(request("trustEndpoint", ["https://node.example", `ed25519:${'a'.repeat(64)}`, false, "trusted-node"]), instanceId)?.type).toBe("action");
    expect(parseMobileConnectionMessage(request("trustEndpoint", ["https://node.example", "ed25519:truncated"]), instanceId)).toBeUndefined();
    expect(parseMobileConnectionMessage(request("trustEndpoint", ["https://node.example", `ed25519:${'a'.repeat(64)}`, "replace"]), instanceId)).toBeUndefined();
    const tailcat = { kind: 'tailcat', endpointId: `nodekey:${'b'.repeat(64)}`, address: 'tcPrivateAddress', port: 4318 };
    expect(parseMobileConnectionMessage(request('createTailcatClient', ['https://node.example', `ed25519:${'a'.repeat(64)}`, tailcat]), instanceId)?.type).toBe('action');
    expect(parseMobileConnectionMessage(request('createIrohClient', ['https://node.example', `ed25519:${'a'.repeat(64)}`, tailcat]), instanceId)).toBeUndefined();
    expect(parseMobileConnectionMessage(request('createIrohClient', []), instanceId)?.type).toBe('action');
    expect(parseMobileConnectionMessage(request('createIrohClient', ['unbound-partial-input']), instanceId)).toBeUndefined();
    for (const raw of [request("pair", ["https://node.example", "", "Phone"]), request("pair", ["https://node.example", "123", "Phone", { automatic: false, authKey: "forged" }]),
      request("connect", [{ id: "profile-1", authKey: "forged" }]), request("connect", ["profile-1"], { instanceId: "retired" }),
      request("setTheme", ["arbitrary"]), request("selectMode", ["settings"]), request("readCredential", []),
      request("pair", ["node", "123", "phone"], { id: "connection-current:1" }), request("setTheme", ["dark"], { credential: "forged" }),
      request("setTheme", ["dark"], { id: 0 }), "not json", "x".repeat(16_385)]) {
      expect(parseMobileConnectionMessage(raw, instanceId)).toBeUndefined();
    }
    expect(mobileConnectionJson({ text: "</script>\u2028&" })).not.toContain("</script>");
    expect(mobileConnectionJson(undefined)).toBe("null");
  });
});
