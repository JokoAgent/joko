import { create } from "@bufbuild/protobuf";
import {
  ListPartnerSessionsResponseSchema,
  ListPartnersResponseSchema,
  MarkPartnerReadResponseSchema,
  PartnerInitializationState,
  PartnerInvitationStage,
  PartnerLifecycle,
  PartnerSessionRole,
  PermissionMode
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  assertMobilePartnerDirectorySession,
  filterMobilePartnerDirectory,
  projectMobilePartnerCatalog,
  projectMobilePartnerReadResponse
} from "./mobile-partner-directory";

const at = (seconds: bigint) => ({ seconds, nanos: 0 });
const profile = (input: {
  readonly id: string;
  readonly name: string;
  readonly session: string;
  readonly unread?: bigint;
  readonly latest?: bigint;
  readonly updated?: bigint;
}) => ({
  partnerId: input.id,
  revision: { value: 2n },
  profileVersion: 3n,
  displayName: input.name,
  avatar: { value: { case: "presetId" as const, value: "orbit" } },
  identitySource: `${input.name} helps with product work.`,
  templateId: "general",
  lifecycle: PartnerLifecycle.ACTIVE,
  initializationState: PartnerInitializationState.READY,
  invitationStage: PartnerInvitationStage.READY,
  homeTargetId: `target-${input.id}`,
  canonicalSessionId: input.session,
  capabilities: {
    modelChain: [{ backendId: "backend", providerId: "provider", modelId: "model", fastMode: false }],
    permissionMode: PermissionMode.ASK,
    planMode: false
  },
  usesDirectoryDefaults: true,
  createdAt: at(10n),
  updatedAt: at(input.updated ?? 20n),
  activity: {
    partnerId: input.id,
    unreadReplyCount: input.unread ?? 0n,
    ...(input.latest === undefined ? {} : {
      latestReplyCursor: { value: input.latest }, latestReplyAt: at(input.updated ?? 20n)
    }),
    artifactCount: 2n,
    activeDelegationCount: 1n,
    readThroughCursor: { value: input.latest === undefined ? 0n : input.latest - (input.unread ?? 0n) },
    readUpdatedAt: at(19n)
  }
});

function catalog() {
  return create(ListPartnersResponseSchema, {
    directory: {
      revision: { value: 4n }, activeCount: 2, archivedCount: 0, errorCount: 0,
      updatedAt: at(30n)
    },
    partners: [
      profile({ id: "ada", name: "Ada", session: "session-ada", unread: 2n, latest: 5n, updated: 29n }),
      profile({ id: "bea", name: "Bea", session: "session-bea", updated: 25n })
    ]
  });
}

describe("mobile Partner directory projection", () => {
  it("projects exact current profiles, activity and canonical Session ownership", () => {
    const projected = projectMobilePartnerCatalog(catalog());
    expect(projected.directory).toMatchObject({ revision: 4n, activeCount: 2, errorCount: 0 });
    expect(projected.partners[0]).toMatchObject({
      partnerId: "ada", profileVersion: 3n,
      activity: { unreadReplyCount: 2, latestReplyCursor: 5n, readThroughCursor: 3n }
    });
    const sessions = create(ListPartnerSessionsResponseSchema, { sessions: [{
      sessionId: "session-ada", partnerId: "ada", role: PartnerSessionRole.CANONICAL,
      profileVersion: 3n, displayName: "Ada", available: true, createdAt: at(10n)
    }] });
    expect(assertMobilePartnerDirectorySession(projected.partners[0]!, sessions)).toBe("session-ada");
    sessions.sessions[0]!.profileVersion = 1n;
    expect(assertMobilePartnerDirectorySession(projected.partners[0]!, sessions)).toBe("session-ada");
    expect(projectMobilePartnerReadResponse("ada", 5n, create(MarkPartnerReadResponseSchema, {
      activity: {
        partnerId: "ada", unreadReplyCount: 0n, latestReplyCursor: { value: 5n }, latestReplyAt: at(29n),
        artifactCount: 2n, activeDelegationCount: 1n, readThroughCursor: { value: 5n }, readUpdatedAt: at(31n)
      }
    })).readThroughCursor).toBe(5n);
  });

  it("filters normalized name or identity text and orders recent activity first", () => {
    const partners = projectMobilePartnerCatalog(catalog()).partners;
    expect(filterMobilePartnerDirectory(partners, "active", "beA", "en").map((item) => item.partnerId))
      .toEqual(["bea"]);
    expect(filterMobilePartnerDirectory(partners, "active", "product", "en").map((item) => item.partnerId))
      .toEqual(["ada", "bea"]);
  });

  it("accepts published model IDs and a monotonic read cursor beyond the latest reply", () => {
    const current = catalog();
    current.partners[0]!.capabilities!.modelChain[0]!.modelId = "vendor/model-v1";
    current.partners[0]!.activity!.readThroughCursor!.value = 8n;
    current.partners[0]!.activity!.unreadReplyCount = 0n;
    const projected = projectMobilePartnerCatalog(current);
    expect(projected.partners[0]!.capabilities.modelChain[0]!.modelId).toBe("vendor/model-v1");
    expect(projected.partners[0]!.activity.readThroughCursor).toBe(8n);
  });

  it("rejects inconsistent counts, activity owners and stale canonical links", () => {
    const inconsistent = catalog();
    inconsistent.directory!.activeCount = 1;
    expect(() => projectMobilePartnerCatalog(inconsistent)).toThrow(/counts/u);
    const wrongOwner = catalog();
    wrongOwner.partners[0]!.activity!.partnerId = "bea";
    expect(() => projectMobilePartnerCatalog(wrongOwner)).toThrow(/another Partner/u);
    const projected = projectMobilePartnerCatalog(catalog());
    expect(() => assertMobilePartnerDirectorySession(projected.partners[0]!,
      create(ListPartnerSessionsResponseSchema, { sessions: [{
        sessionId: "session-ada", partnerId: "ada", role: PartnerSessionRole.CANONICAL,
        profileVersion: 4n, displayName: "Ada", available: true, createdAt: at(10n)
      }] }))).toThrow(/no longer available/u);
    expect(() => projectMobilePartnerReadResponse("ada", 5n, create(MarkPartnerReadResponseSchema, {
      activity: {
        partnerId: "ada", unreadReplyCount: 1n, latestReplyCursor: { value: 5n }, latestReplyAt: at(29n),
        artifactCount: 2n, activeDelegationCount: 1n, readThroughCursor: { value: 4n }, readUpdatedAt: at(31n)
      }
    }))).toThrow(/mismatched/u);
  });
});
