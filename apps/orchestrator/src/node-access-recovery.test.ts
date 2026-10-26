import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import { OperationalStore, TaskShareStore } from "@joko/store";
import { expect, it } from "vitest";
import { ConnectionManager } from "./connection-manager.js";
import { PartnerIdentityDirectory } from "./partner-identity-directory.js";
import { revokeAllNodeAccess } from "./node-access-recovery.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const at = 1_000, store = new OperationalStore(":memory:", { now: () => at });
  store.upsertBackend({ id: "backend", displayName: "Backend", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "backend", displayName: "Target", workspaceRoot: process.cwd(), managed: false, trusted: true });
  store.createSession({ id: "session", backendId: "backend", targetId: "target", title: "Keep history", binding: { opaqueRef: "native", generation: 1 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: at, updatedAt: at });
  const connections = new ConnectionManager(store, { now: () => at });
  const challenge = connections.issuePairing(), paired = connections.completePairing({ challengeId: challenge.id, code: challenge.code, connectionName: "Original owner" });
  const pending = connections.issuePairing();
  const shares = new TaskShareStore(store, () => at);
  const share = shares.create({ shareId: "share", sessionId: "session", invitationSha256Hex: digest("invitation") });
  const { member } = shares.join({ shareId: share.shareId, shareGeneration: share.shareGeneration, invitationSha256Hex: share.invitationSha256Hex,
    memberId: "member", credentialSha256Hex: digest("guest"), intentId: "original-join", displayName: "Guest", homeServerId: "home", homeDeviceId: "device" });
  const identity = new PartnerIdentityDirectory({ store, serverId: "node", origin: "https://node.example", endpointPublicKey: `ed25519:${"a".repeat(64)}`,
    vault: {} as never, home: {} as never, partner: id => ({ id, name: "Partner", description: "", canonicalSessionId: "session", revision: 1n }) });
  const issued = identity.issue(create(contract.IssuePartnerIdentityRequestSchema, { operationId: "identity", partnerId: "partner", expectedRevision: 1n }));
  const invitation = contract.parsePartnerIdentityInvitation(issued.invitation);
  return { store, at, connections, paired, pending, shares, member, share, identity, invitation };
}

it("retires restored owner, pairing, task guest and identity proofs while preserving their canonical task", () => {
  const f = fixture(); try {
    const proof = { shareId: f.share.shareId, shareGeneration: f.share.shareGeneration, memberId: f.member.memberId,
      memberGeneration: f.member.memberGeneration, credentialSha256Hex: f.member.credentialSha256Hex };
    const request = create(contract.InspectPartnerIdentityRequestSchema, { grantId: f.invitation.grantId, partnerId: f.invitation.partnerId });
    const authorization = `PartnerIdentity ${f.invitation.secret}`;
    expect(f.identity.inspect(request, authorization).identity?.partnerId).toBe("partner");
    revokeAllNodeAccess(f.store, "node", f.at);
    expect(() => f.connections.authenticate(`Bearer ${f.paired.authKey}`)).toThrow();
    expect(() => f.connections.completePairing({ challengeId: f.pending.id, code: f.pending.code, connectionName: "Late" })).toThrow();
    expect(() => f.shares.authorize(proof)).toThrow(); expect(() => f.identity.inspect(request, authorization)).toThrow();
    expect(f.store.getSession("session").descriptor.title).toBe("Keep history");
    expect(f.store.getBackend("backend").descriptor.displayName).toBe("Backend");
    expect(f.store.getDevice(f.paired.connection.deviceId).state).toBe("active");
    expect(f.shares.get("share").members).toHaveLength(1);
    expect(revokeAllNodeAccess(f.store, "node", f.at)).toMatchObject({ connections: 0, pairings: 0, taskShares: 0, partnerGrants: 0 });
  } finally { f.store.close(); }
});

it("rolls every authority reset back if an inbound grant cannot be validated", () => {
  const f = fixture(); try {
    f.store.setSetting("service", "partner-identity-authority", "grant:invalid", { id: "invalid", status: "unknown" });
    expect(() => revokeAllNodeAccess(f.store, "node", f.at)).toThrow();
    expect(f.connections.authenticate(`Bearer ${f.paired.authKey}`).id).toBe(f.paired.connection.id);
    expect(f.store.getPairing(f.pending.id).expiresAt).toBeGreaterThan(f.at);
    expect(f.shares.get("share").status).toBe("active");
  } finally { f.store.close(); }
});
