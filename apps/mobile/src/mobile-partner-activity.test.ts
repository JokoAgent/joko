import { create } from "@bufbuild/protobuf";
import { InteractionState, RunState, SessionAttentionKind, SessionState, SnapshotSchema } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { mobilePartnerActivityState, mobilePartnerDirectoryPreview } from "./mobile-partner-activity";
import { profileSnapshot } from "./test/mobile-partner-profile";

describe("Partner directory activity", () => {
  it("uses the exact canonical incarnation for execution, interaction and recovery", () => {
    const partner = profileSnapshot.partner;
    const observation = { ownerKey: "owner", online: true, snapshot: create(SnapshotSchema, { sessions: [{
      sessionId: partner.canonicalSessionId, targetId: partner.homeTargetId, backendId: partner.capabilities.modelChain[0]!.backendId,
      state: SessionState.IDLE, version: { generation: 2n }
    }] }) };
    expect(mobilePartnerActivityState(partner, observation)).toBe("ready");
    const session = observation.snapshot.sessions[0]!;
    for (const [state, expected] of [[SessionState.RUNNING, "working"], [SessionState.WAITING, "waiting"],
      [SessionState.RECOVERING, "recovering"], [SessionState.ERROR, "attention"]] as const) {
      session.state = state; expect(mobilePartnerActivityState(partner, observation)).toBe(expected);
    }
    session.state = SessionState.IDLE; session.contextState = { $typeName: "joko.v1.SessionContextState", compacting: true };
    expect(mobilePartnerActivityState(partner, observation)).toBe("compacting");
    session.contextState = undefined;
    session.attention = create(SnapshotSchema, { sessions: [{ attention: { kind: SessionAttentionKind.ERROR, unread: true,
      subjectCursor: { generation: 2n } } }] }).sessions[0]!.attention;
    expect(mobilePartnerActivityState(partner, observation)).toBe("attention");
    session.attention!.subjectCursor!.generation = 1n;
    expect(mobilePartnerActivityState(partner, observation)).toBe("ready");
    session.attention = undefined;
    observation.snapshot.interactions = create(SnapshotSchema, { interactions: [{ sessionId: session.sessionId,
      targetId: session.targetId, backendId: session.backendId, generation: 1n, state: InteractionState.PENDING }] }).interactions;
    expect(mobilePartnerActivityState(partner, observation)).toBe("ready");
    observation.snapshot.interactions[0]!.generation = 2n;
    expect(mobilePartnerActivityState(partner, observation)).toBe("waiting");
    observation.snapshot.interactions = [];
    observation.snapshot.runs = create(SnapshotSchema, { runs: [{ sessionId: session.sessionId,
      targetId: session.targetId, backendId: session.backendId, version: { generation: 2n }, state: RunState.DISPATCH_UNKNOWN }] }).runs;
    expect(mobilePartnerActivityState(partner, observation)).toBe("recovering");
    expect(mobilePartnerActivityState(partner, { ...observation, online: false })).toBe("offline");
    session.targetId = "different-target";
    expect(mobilePartnerActivityState(partner, observation)).toBe("unknown");
  });

  it("renders public Markdown text and image alt without reading destinations, then uses identity", () => {
    const partner = profileSnapshot.partner;
    expect(mobilePartnerDirectoryPreview({ ...partner, activity: { ...partner.activity,
      latestReplyPreview: "**Ready** [report](https://example.test) ![diagram](private-file.png)" } })).toBe("Ready report diagram");
    expect(mobilePartnerDirectoryPreview(partner)).toBe(partner.identitySource.split("\n")[0]);
  });
});
