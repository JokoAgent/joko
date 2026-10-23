import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { OperationalStore } from "./operational-store.js";
import { ProviderSharingStore, PROVIDER_SHARING_LINK_TTL, PROVIDER_SHARING_REQUEST_TTL } from "./provider-sharing-store.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function setup() {
  const database = new OperationalStore(":memory:"); let now = 1_000_000;
  const store = new ProviderSharingStore(database, () => now), person = { name: "Owner", avatarUrl: null };
  const issue = (key: string) => store.issue({ shareId: `share-${key}`, backendId: "native", providerId: "provider", providerName: "Provider", owner: person, linkDigest: hash(key) });
  const apply = (key: string, home = "recipient-home") => store.apply({ id: `request-${key}`, linkDigest: hash(key), homeServerId: home, deviceId: "recipient-device",
    person: { name: "Recipient", avatarUrl: null }, requestDigest: hash(`request-${key}`), credentialDigest: hash(`member-${key}`), pairingCode: "0123" }, "issuer-home");
  return { database, store, issue, apply, advance: (ms: number) => { now += ms; } };
}
it("atomically locks only the first submitted applicant and keeps the original four digit receipt", () => {
  const s = setup(); try {
    s.issue("first"); const original = s.apply("first");
    const retry = s.store.apply({ id: original.id, linkDigest: original.linkDigest, homeServerId: original.homeServerId, deviceId: original.deviceId,
      person: original.person, requestDigest: original.requestDigest, credentialDigest: original.credentialDigest, pairingCode: "9999" }, "issuer-home");
    expect(retry.pairingCode).toBe("0123");
    expect(() => s.store.apply({ ...original, id: "second-request", homeServerId: "other-home" }, "issuer-home")).toThrow();
    s.store.withdraw(original.id, original.requestDigest);
    expect(s.store.link(original.linkDigest).state).toBe("withdrawn"); expect(() => s.apply("first", "other-home")).toThrow();
    expect(s.store.list()[0]!.members).toEqual([]);
  } finally { s.database.close(); }
});
it("expires unused links after five minutes and submitted requests after twenty four hours", () => {
  const s = setup(); try {
    s.issue("unused"); s.advance(PROVIDER_SHARING_LINK_TTL); expect(() => s.apply("unused")).toThrow();
    s.issue("pending"); const pending = s.apply("pending"); s.advance(PROVIDER_SHARING_LINK_TTL); s.store.expire();
    expect(s.store.request(pending.id).status).toBe("pending");
    s.advance(PROVIDER_SHARING_REQUEST_TTL); s.store.expire(); expect(s.store.request(pending.id).status).toBe("expired");
    expect(() => s.store.decide(pending.id, "approve", "member")).toThrow(); expect(s.store.link(pending.linkDigest).state).toBe("expired");
  } finally { s.database.close(); }
});
it("fences every grant generation, retains pause consent, and never resurrects consent on readmission", () => {
  const s = setup(); try {
    const { share } = s.issue("first"), request = s.apply("first"); s.store.decide(request.id, "approve", "member");
    let { member } = s.store.lookupCredential(request.credentialDigest), proof = { shareId: share.id, memberId: member.id, generation: member.generation, credentialDigest: member.credentialDigest };
    s.store.syncReshares(proof, "group-computer", [{ key: "recipient_person_key_1", person: { name: "Third person", avatarUrl: null } }]);
    const consent = s.store.reshares()[0]!; s.store.decideReshare(consent.id, "approved"); s.store.assertReshare(proof, "group-computer", consent.key);
    s.store.setMember(share.id, member.id, member.generation, "paused"); expect(() => s.store.authorize(proof)).toThrow(); expect(s.store.reshares()[0]!.state).toBe("approved");
    member = s.store.lookupCredential(request.credentialDigest, true).member; s.store.setMember(share.id, member.id, member.generation, "active");
    member = s.store.lookupCredential(request.credentialDigest).member; proof = { ...proof, generation: member.generation }; s.store.assertReshare(proof, "group-computer", consent.key);
    s.store.setMember(share.id, member.id, member.generation, "removed"); expect(s.store.reshares()).toEqual([]); expect(() => s.store.lookupCredential(member.credentialDigest)).toThrow();
    s.issue("again"); const next = s.apply("again"); s.store.decide(next.id, "approve", "ignored-new-member-id"); const replacement = s.store.lookupCredential(next.credentialDigest).member;
    expect(replacement.id).not.toBe(member.id); expect(replacement.incarnation).toBe(member.incarnation + 1); expect(() => s.store.authorize(proof)).toThrow();
    const nextProof = { ...proof, memberId: replacement.id, generation: replacement.generation, credentialDigest: replacement.credentialDigest };
    s.store.syncReshares(nextProof, "group-computer", [{ key: consent.key, person: consent.person }]); expect(s.store.reshares()[0]!.state).toBe("pending");
    s.store.syncReshares(nextProof, "group-computer", []); expect(s.store.reshares()).toEqual([]);
    const privateRows = JSON.stringify(s.database.listSettings("service", "provider-sharing.host.v1").map(row => row.value));
    expect(privateRows).not.toContain('"connectionId"'); expect(privateRows).not.toContain('"authKey"');
  } finally { s.database.close(); }
});
