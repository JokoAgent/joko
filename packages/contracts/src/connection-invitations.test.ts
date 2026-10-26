import { describe, expect, it } from "vitest";
import { buildTaskShareInvitation, parseTaskShareInvitation } from "./task-sharing.js";
import { buildProviderSharingLink, parseProviderSharingLink } from "./provider-sharing.js";
import { buildPartnerIdentityInvitation, parsePartnerIdentityInvitation } from "./partner-identity.js";

const endpointPublicKey = `ed25519:${"a".repeat(64)}`;
const secret = "s".repeat(43);
describe("trusted cross-node invitations", () => {
  it("carries the exact Host endpoint key in each v1 private invitation", () => {
    const task = buildTaskShareInvitation({ hostOrigin: "https://host.example", hostServerId: "host", shareId: "share", shareGeneration: 1n, inviteSecret: secret, endpointPublicKey });
    expect(parseTaskShareInvitation(task).endpointPublicKey).toBe(endpointPublicKey);
    expect(parseProviderSharingLink(buildProviderSharingLink("https://host.example", secret, endpointPublicKey))).toEqual({ origin: "https://host.example", secret, endpointPublicKey });
    const partner = buildPartnerIdentityInvitation({ authorityServerId: "host", partnerId: "partner", origin: "https://host.example", grantId: "grant", secret, endpointPublicKey });
    expect(parsePartnerIdentityInvitation(partner).endpointPublicKey).toBe(endpointPublicKey);
  });
  it("rejects absent, truncated, substituted-shape, and extra-field trust records", () => {
    expect(() => buildProviderSharingLink("https://host.example", secret, "short fingerprint")).toThrow();
    expect(() => parseProviderSharingLink(`https://host.example/provider-share/join#${secret}`)).toThrow();
    const task = buildTaskShareInvitation({ hostOrigin: "https://host.example", hostServerId: "host", shareId: "share", shareGeneration: 1n, inviteSecret: secret, endpointPublicKey });
    const url = new URL(task), payload = JSON.parse(decodeURIComponent(url.hash.slice(1)));
    delete payload.endpointPublicKey;
    url.hash = encodeURIComponent(JSON.stringify(payload));
    expect(() => parseTaskShareInvitation(url.href)).toThrow();
    const partner = new URL(buildPartnerIdentityInvitation({ authorityServerId: "host", partnerId: "partner", origin: "https://host.example", grantId: "grant", secret, endpointPublicKey }));
    partner.searchParams.delete("endpointPublicKey");
    expect(() => parsePartnerIdentityInvitation(partner.href)).toThrow();
  });
});
