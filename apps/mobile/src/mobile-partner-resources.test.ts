import { create } from "@bufbuild/protobuf";
import {
  ArtifactKind,
  ArtifactSchema,
  BlobDisposition,
  BlobRefSchema,
  ListPartnerSessionsResponseSchema,
  PartnerSessionRole
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import type { MobilePartner } from "./mobile-partner-private";
import {
  filterMobilePartnerResources,
  mobilePartnerResourceKey,
  projectMobilePartnerResourcePreview
} from "./mobile-partner-resources";

const at = (seconds: bigint) => ({ seconds, nanos: 0 });
const partner: MobilePartner = {
  partnerId: "partner-a",
  displayName: "Ada",
  avatar: "standard",
  lifecycle: "active",
  initializationState: "ready",
  canonicalSessionId: "session-a",
  profileVersion: 3
};

function sessions(profileVersion = 3n, sessionId = "session-a") {
  return create(ListPartnerSessionsResponseSchema, { sessions: [{
    partnerId: "partner-a",
    sessionId,
    role: PartnerSessionRole.CANONICAL,
    profileVersion,
    displayName: "Ada's task",
    available: true,
    readOnly: false,
    archived: false,
    deleted: false,
    createdAt: at(10n),
    lastActivityAt: at(30n)
  }] });
}

function artifact(id: string, createdAt: bigint) {
  return create(ArtifactSchema, {
    artifactId: id,
    sessionId: "session-a",
    kind: ArtifactKind.FILE,
    title: id === "new" ? "New report" : "Old report",
    createdAt: at(createdAt),
    blob: create(BlobRefSchema, {
      blobId: `blob-${id}`,
      fileName: `${id}.txt`,
      mediaType: "text/plain",
      byteSize: 4n,
      sha256Hex: "a".repeat(64),
      disposition: BlobDisposition.ARTIFACT
    })
  });
}

describe("mobile Partner Resource projection", () => {
  it("binds a preview to the exact canonical Partner task and stable Artifact catalog", () => {
    const preview = projectMobilePartnerResourcePreview(partner, sessions(), {
      artifacts: [artifact("old", 20n), artifact("new", 25n)],
      revision: "artifacts-r1"
    });
    expect(preview).toMatchObject({
      resourceKey: mobilePartnerResourceKey(partner),
      session: { sessionId: "session-a", displayName: "Ada's task", profileVersion: 3,
        createdAt: 10_000, lastActivityAt: 30_000 },
      artifacts: [{ artifactId: "new", title: "New report" }, { artifactId: "old", title: "Old report" }],
      artifactRevision: "artifacts-r1"
    });
  });

  it("rejects stale profile ownership and malformed or cross-task Artifacts", () => {
    expect(() => projectMobilePartnerResourcePreview(partner, sessions(2n), {
      artifacts: [], revision: "artifacts-r1"
    })).toThrow(/canonical Session|Resource/u);
    expect(() => projectMobilePartnerResourcePreview(partner, sessions(), {
      artifacts: [{ ...artifact("new", 25n), sessionId: "another-session" }], revision: "artifacts-r1"
    })).toThrow(/Artifact preview/u);
    expect(() => projectMobilePartnerResourcePreview(partner, sessions(), {
      artifacts: [{ ...artifact("new", 25n), blob: { ...artifact("new", 25n).blob!, sha256Hex: "bad" } }],
      revision: "artifacts-r1"
    })).toThrow(/Artifact preview/u);
  });

  it("searches stable display text without using it as Resource identity", () => {
    const archived: MobilePartner = { ...partner, partnerId: "partner-b", displayName: "研究伙伴",
      canonicalSessionId: undefined, lifecycle: "archived" };
    expect(filterMobilePartnerResources([partner, archived], "研究")).toEqual([archived]);
    expect(filterMobilePartnerResources([partner, archived], "ada")).toEqual([partner]);
    expect(filterMobilePartnerResources([partner, archived], "")).toEqual([partner, archived]);
  });
});
