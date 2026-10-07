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
    expect(parseMobileConnectionMessage(request("selectMode", ["pair"]), instanceId)?.type).toBe("action");
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
