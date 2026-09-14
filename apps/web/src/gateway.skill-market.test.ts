import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  CollaborationRole,
  CollaborationScopeKind,
  OperationState,
  ResourceAcquisitionKind,
  ResourceScope,
  ResourceState,
  ResourceUsageSource,
  SkillDiffChangeKind,
  SkillFileKind,
  SkillMarketInstallAction,
  SkillMarketInstallConfirmationReason,
  SkillMarketInstallStatusState,
  SkillMarketPreviewUnavailableReason,
  SkillMarketSourceKind,
  SkillMarketSourceState,
  SkillMarketSyncJobState,
  SkillMarketSyncOutcome,
  SkillPublicationGateStatus,
  SkillPublicationMode,
  SkillPublicationPublisher,
  SkillPublicationState,
  SkillPublicationVerdict,
  SkillPublicationVisibility
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

const SOURCE_ID = "skill_market_source_0123456789abcdef0123456789abcdef";
const ENTRY_ID = "skill_market_entry_0123456789abcdef0123456789abcdef";
const PREVIEW_ID = "skill_market_preview_0123456789abcdef0123456789abcdef";
const PLAN_ID = "skill_market_install_0123456789abcdef0123456789abcdef";
const JOB_ID = "skill_sync_0123456789abcdef0123456789abcdef";
const PUBLICATION_ID = "skill_publication_0123456789abcdef0123456789abcdef";
const HASH = `sha256:${"a".repeat(64)}`;
const OTHER_HASH = `sha256:${"b".repeat(64)}`;

describe("Skill market gateway", () => {
  it("maps path-private catalog, preview, plan, and sync state and fences every mutation", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    const gateway = await mount(async (method, input) => {
      requests.push({ method, input });
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "getSkillMarketGitPreflight") return { preflight: { available: true, version: "2.50.0", minimumVersion: "2.25.0" } };
      if (method === "listSkillMarketSources") return {
        sources: [protoSource()], catalogRevision: { value: 9n }, recoveredFromCorruption: false,
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "listSkillMarketCatalog") return {
        entries: [protoEntry()], catalogRevision: { value: 9n }, categories: ["Productivity"], sourceCount: 1,
        page: { totalSize: 2n, nextPageToken: input.page.pageToken === "" ? "revision-cursor" : "" }
      };
      if (method === "getSkillMarketEntry") return { entry: protoEntry() };
      if (method === "openSkillMarketPreview") return { preview: protoPreview() };
      if (method === "listSkillMarketPreviewFiles") return {
        files: [{ key: "SKILL.md", kind: SkillFileKind.FILE, size: 96n }],
        snapshotRevision: HASH,
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "readSkillMarketPreviewFile") return {
        file: { previewId: PREVIEW_ID, snapshotRevision: HASH, key: "SKILL.md", size: 96n, previewable: true, content: "# Review safely" }
      };
      if (method === "closeSkillMarketPreview" || method === "closeSkillMarketInstallPlan") return { closed: true };
      if (method === "createSkillMarketInstallPlan" || method === "getSkillMarketInstallPlan") return { plan: protoPlan() };
      if (method === "listSkillMarketSyncPolicies") return {
        policies: [protoPolicy()], recoveredFromCorruption: false, page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "listSkillMarketSyncJobs") return {
        jobs: [protoJob()], recoveredFromCorruption: false, page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "getSkillMarketSyncJob") return { job: protoJob(), recoveredFromCorruption: false };
      if (method === "getSkillPublicationPreview") return { preview: protoPublicationPreview() };
      if (method === "listSkillPublicationJobs") return {
        jobs: [protoPublicationJob()], recoveredFromCorruption: false, page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "getSkillPublicationJob") return { job: protoPublicationJob(), recoveredFromCorruption: false };
      if (method === "getCollaborationDirectory") return { directory: protoCollaborationDirectory() };
      if (method === "submitOperation") return {
        operation: {
          operationId: input.operationId,
          connectionId: input.connectionId,
          state: OperationState.SUCCEEDED,
          result: input.mutation.payload.case === "installSkillMarketPlan"
            ? { payload: { case: "skill", value: { skill: protoSkill(), replacedSkillId: "resource-old", recoveryId: "" } } }
            : { payload: { case: "acknowledgement", value: { accepted: true } } }
        }
      };
      throw new Error(`Unexpected method: ${method}`);
    });

    await expect(gateway.getSkillMarketGitPreflight()).resolves.toEqual({ available: true, version: "2.50.0", minimumVersion: "2.25.0" });
    const sources = await gateway.listSkillMarketSources();
    expect(sources).toMatchObject({ revision: 9n, sources: [{ id: SOURCE_ID, display: "team-skills", entryCount: 1 }] });

    const firstPage = await gateway.listSkillMarketCatalog({ query: "review", category: "Productivity", sort: "downloads" });
    expect(firstPage).toMatchObject({ revision: 9n, totalSize: 2, nextPageToken: "revision-cursor", entries: [{
      name: "Review helper",
      installStatuses: [{ resourceId: "resource-skill", resourceRevision: 7n, scope: "global", state: "updateAvailable", installedVersion: "1.0.0" }]
    }] });
    await gateway.listSkillMarketCatalog({ expectedRevision: firstPage.revision, query: "review", category: "Productivity", sort: "downloads", pageToken: firstPage.nextPageToken });
    const entry = await gateway.getSkillMarketEntry(firstPage.entries[0]!.identity);
    const preview = await gateway.openSkillMarketPreview(entry.identity);
    expect(await gateway.listSkillMarketPreviewFiles(preview)).toMatchObject({ snapshotRevision: HASH, files: [{ key: "SKILL.md", kind: "file" }] });
    expect(await gateway.readSkillMarketPreviewFile(preview, "SKILL.md")).toMatchObject({ previewable: true, content: "# Review safely" });
    await expect(gateway.closeSkillMarketPreview(preview.id)).resolves.toBe(true);

    const target = { backendId: "pi", scope: "global" as const };
    const plan = await gateway.createSkillMarketInstallPlan(entry.identity, target);
    expect(plan).toMatchObject({ id: PLAN_ID, requiresConfirmation: true, confirmationReasons: ["dirtyContent"], preview: { action: "replace", currentResource: { dirty: true } } });
    expect(await gateway.getSkillMarketInstallPlan(plan.id)).toEqual(plan);
    expect(await gateway.installSkillMarketPlan(plan, true)).toMatchObject({ skill: { id: "resource-skill" }, replacedSkillId: "resource-old" });
    await expect(gateway.closeSkillMarketInstallPlan(plan.id)).resolves.toBe(true);

    const policies = await gateway.listSkillMarketSyncPolicies();
    const jobs = await gateway.listSkillMarketSyncJobs("resource-skill");
    const policy = policies.items[0]!;
    const job = jobs.items[0]!;
    expect(policy).toMatchObject({ resourceId: "resource-skill", revision: 3n, enabled: true });
    expect(job).toMatchObject({ id: JOB_ID, state: "failed", outcome: "dirtyContent", attempt: 1 });
    await expect(gateway.getSkillMarketSyncJob(job.id)).resolves.toEqual(job);
    await gateway.enableSkillMarketSync(policy.resourceId, policy.baseline.resourceRevision, target);
    await gateway.disableSkillMarketSync(policy);
    await gateway.enqueueSkillMarketSync(policy);
    await gateway.cancelSkillMarketSync(job);
    await gateway.retrySkillMarketSync(job);

    const publicationPreview = await gateway.getSkillPublicationPreview("resource-skill", 7n, SOURCE_ID, 2n);
    const publications = await gateway.listSkillPublicationJobs("resource-skill");
    const publication = publications.items[0]!;
    expect(publicationPreview).toMatchObject({
      mode: "first", suggestedSlug: "draft-skill", suggestedVersion: "1.0.0",
      teamPublisherAvailable: false, privateVisibilityAvailable: true
    });
    expect(publication).toMatchObject({ id: PUBLICATION_ID, state: "published", verdict: "passed", result: { version: "1.0.0" } });
    await expect(gateway.getSkillPublicationJob(publication.id)).resolves.toEqual(publication);
    await gateway.startSkillPublication(publicationPreview, {
      slug: "draft-skill", name: "Draft Skill", description: "Publish safely.", tags: ["writing"], version: "1.0.0"
    }, { publisher: "personal", visibility: "private", audienceScopeIds: [] });
    await gateway.cancelSkillPublication(publication);
    await gateway.retrySkillPublication(publication);

    const collaboration = await gateway.getCollaborationDirectory();
    expect(collaboration).toMatchObject({ available: true, revision: 4n, actor: { displayName: "Local owner" }, scopes: [{ kind: "team" }] });
    await gateway.createCollaborationScope("department", "Engineering", collaboration.revision);
    await gateway.updateCollaborationScope(collaboration.scopes[0]!, "Platform core");
    await gateway.deleteCollaborationScope(collaboration.scopes[0]!);
    await gateway.updateSkillMarketAccess(entry, collaboration.revision, { publisher: "personal", visibility: "private", audienceScopeIds: [] });

    await gateway.addSkillMarketSource({ kind: "local", serverPath: "D:\\private\\skill-market" }, sources.revision);
    await gateway.refreshSkillMarketSource(sources.sources[0]!.id, sources.sources[0]!.revision);
    await gateway.removeSkillMarketSource(sources.sources[0]!.id, sources.sources[0]!.revision);

    const secondCatalogRequest = requests.filter((request) => request.method === "listSkillMarketCatalog")[1]!.input;
    expect(secondCatalogRequest).toMatchObject({ expectedCatalogRevision: { value: 9n }, page: { pageToken: "revision-cursor" } });
    expect(requests.find((request) => request.method === "openSkillMarketPreview")?.input.identity).toEqual({
      sourceId: SOURCE_ID, sourceRevision: { value: 2n }, entryId: ENTRY_ID, entryRevision: { value: 4n }, contentRevision: HASH
    });
    expect(requests.find((request) => request.method === "createSkillMarketInstallPlan")?.input.target).toMatchObject({ backendId: "pi", scope: ResourceScope.GLOBAL });
    expect(requests.find((request) => request.method === "readSkillMarketPreviewFile")?.input).toEqual({ previewId: PREVIEW_ID, expectedSnapshotRevision: HASH, key: "SKILL.md" });
    const mutations = requests.filter((request) => request.method === "submitOperation").map((request) => request.input.mutation.payload);
    expect(mutations).toMatchObject([
      { case: "installSkillMarketPlan", value: { planId: PLAN_ID, expectedCandidateRevision: OTHER_HASH, confirmReplacement: true } },
      { case: "enableSkillMarketSync", value: { resourceId: "resource-skill", expectedResourceRevision: { value: 7n } } },
      { case: "disableSkillMarketSync", value: { resourceId: "resource-skill", expectedPolicyRevision: { value: 3n } } },
      { case: "enqueueSkillMarketSync", value: { resourceId: "resource-skill", expectedPolicyRevision: { value: 3n } } },
      { case: "cancelSkillMarketSync", value: { jobId: JOB_ID, expectedRevision: { value: 5n } } },
      { case: "retrySkillMarketSync", value: { jobId: JOB_ID, expectedRevision: { value: 5n } } },
      { case: "startSkillPublication", value: {
        resourceId: "resource-skill", expectedResourceRevision: { value: 7n }, expectedObservedRevision: HASH,
        sourceId: SOURCE_ID, expectedSourceRevision: { value: 2n }, expectedSourceContentRevision: HASH,
        expectedCollaborationRevision: { value: 1n },
        metadata: { slug: "draft-skill", version: "1.0.0" },
        publisher: SkillPublicationPublisher.PERSONAL, visibility: SkillPublicationVisibility.PRIVATE
      } },
      { case: "cancelSkillPublication", value: { jobId: PUBLICATION_ID, expectedRevision: { value: 6n } } },
      { case: "retrySkillPublication", value: { jobId: PUBLICATION_ID, expectedRevision: { value: 6n } } },
      { case: "createCollaborationScope", value: { expectedCatalogRevision: { value: 4n }, kind: CollaborationScopeKind.DEPARTMENT, name: "Engineering" } },
      { case: "updateCollaborationScope", value: { scopeId: "collaboration_scope_test", expectedRevision: { value: 2n }, name: "Platform core" } },
      { case: "deleteCollaborationScope", value: { scopeId: "collaboration_scope_test", expectedRevision: { value: 2n } } },
      { case: "updateSkillMarketAccess", value: {
        expectedAccessRevision: { value: 1n }, expectedCollaborationRevision: { value: 4n },
        publisher: SkillPublicationPublisher.PERSONAL, visibility: SkillPublicationVisibility.PRIVATE
      } },
      { case: "addSkillMarketSource", value: { expectedCatalogRevision: { value: 9n }, source: { kind: { case: "local", value: { serverPath: "D:\\private\\skill-market" } } } } },
      { case: "refreshSkillMarketSource", value: { sourceId: SOURCE_ID, expectedRevision: { value: 2n } } },
      { case: "removeSkillMarketSource", value: { sourceId: SOURCE_ID, expectedRevision: { value: 2n } } }
    ]);
    const publicProjection = JSON.stringify({ sources, firstPage, entry, preview, plan, policies, jobs, publicationPreview, publications }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
    expect(publicProjection).not.toMatch(/[A-Za-z]:[\\/]|\/home\//u);
    gateway.disconnect();
  });

  it("fails closed on path-bearing source labels and invalid preview availability", async () => {
    let invalid: "source" | "file" = "source";
    const gateway = await mount(async (method) => {
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "listSkillMarketSources") return {
        sources: [{ ...protoSource(), display: "D:\\private\\catalog" }], catalogRevision: { value: 1n }, recoveredFromCorruption: false,
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "readSkillMarketPreviewFile" && invalid === "file") return {
        file: {
          previewId: PREVIEW_ID, snapshotRevision: HASH, key: "SKILL.md", size: 2n,
          previewable: false, content: "secret", unavailableReason: SkillMarketPreviewUnavailableReason.BINARY
        }
      };
      throw new Error(`Unexpected method: ${method}`);
    });
    await expect(gateway.listSkillMarketSources()).rejects.toThrow("path-bearing Skill market source");
    invalid = "file";
    await expect(gateway.readSkillMarketPreviewFile(mappedPreview(), "SKILL.md")).rejects.toThrow("invalid Skill market preview file");
    gateway.disconnect();
  });

  it("maps an exact 30-day Resource usage report and preserves its requested calendar authority", async () => {
    const requests: Array<{ readonly method: string; readonly input: any }> = [];
    const gateway = await mount(async (method, input) => {
      requests.push({ method, input });
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "getSkillResourceUsageReport") return { report: protoResourceUsageReport() };
      throw new Error(`Unexpected method: ${method}`);
    });

    const report = await gateway.getSkillResourceUsageReport("resource-skill", "Asia/Shanghai");
    expect(report).toMatchObject({
      resourceId: "resource-skill",
      timeZone: "Asia/Shanghai",
      fromDay: "2026-08-16",
      throughDay: "2026-09-14",
      totals: { samples: 10, strongActive: 5, passiveExposures: 5, toolCalls: 5, toolErrors: 1 },
      sources: [
        { source: "runtimeConfirmedResourceLoad", metrics: { samples: 5 } },
        { source: "runtimeToolCall", metrics: { samples: 5 } }
      ],
      agents: [{ backendId: "pi", metrics: { samples: 10 } }],
      comparison: {
        available: true,
        minimumSamples: 5,
        current: { identity: { resourceRevision: 8n, version: "2.0.0" }, metrics: { samples: 5 } },
        previous: { identity: { resourceRevision: 7n, version: "1.0.0" }, metrics: { samples: 5 } }
      },
      projection: { complete: true, streamCount: 2, pendingStreamCount: 0, failures: [] }
    });
    expect(report.days).toHaveLength(30);
    expect(report.days.at(-1)).toMatchObject({ localDay: "2026-09-14", metrics: { samples: 10 } });
    expect(requests.find((request) => request.method === "getSkillResourceUsageReport")?.input)
      .toEqual({ resourceId: "resource-skill", timeZone: "Asia/Shanghai" });
    expect(JSON.stringify(report, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value))
      .not.toMatch(/[A-Za-z]:[\\/]|\/home\//u);
    gateway.disconnect();
  });

  it("fails closed on discontinuous or unknown Resource usage evidence", async () => {
    let invalid: "day" | "source" = "day";
    const gateway = await mount(async (method) => {
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "getSkillResourceUsageReport") {
        const report = protoResourceUsageReport() as any;
        if (invalid === "day") report.days[8].localDay = "2026-08-30";
        else report.sources[0].source = 999;
        return { report };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    await expect(gateway.getSkillResourceUsageReport("resource-skill", "Asia/Shanghai"))
      .rejects.toThrow("invalid Resource usage day series");
    invalid = "source";
    await expect(gateway.getSkillResourceUsageReport("resource-skill", "Asia/Shanghai"))
      .rejects.toThrow("unknown Resource usage source");
    gateway.disconnect();
  });

  it("fails closed on publication paths and unknown publication state", async () => {
    let invalid: "authority" | "state" | "error" = "authority";
    const gateway = await mount(async (method) => {
      if (method === "getSnapshot") return { snapshot: {} };
      if (method === "getSkillPublicationPreview" && invalid === "authority") return {
        preview: {
          ...protoPublicationPreview(),
          authority: { ...protoPublicationAuthority(), sourceDisplay: "Local source D:\\private\\market" }
        }
      };
      if (method === "listSkillPublicationJobs" && invalid === "state") return {
        jobs: [{ ...protoPublicationJob(), state: 999 }], recoveredFromCorruption: false,
        page: { totalSize: 1n, nextPageToken: "" }
      };
      if (method === "listSkillPublicationJobs" && invalid === "error") return {
        jobs: [protoFailedPublicationJob("Commit failed at D:\\private\\market\\manifest.json")],
        recoveredFromCorruption: false, page: { totalSize: 1n, nextPageToken: "" }
      };
      throw new Error(`Unexpected method: ${method}`);
    });
    await expect(gateway.getSkillPublicationPreview("resource-skill", 7n, SOURCE_ID, 2n))
      .rejects.toThrow("path-bearing Skill publication authority");
    invalid = "state";
    await expect(gateway.listSkillPublicationJobs("resource-skill"))
      .rejects.toThrow("invalid Skill publication state");
    invalid = "error";
    await expect(gateway.listSkillPublicationJobs("resource-skill"))
      .rejects.toThrow("inconsistent Skill publication job");
    gateway.disconnect();
  });
});

function protoSource(): object {
  return {
    sourceId: SOURCE_ID,
    revision: { value: 2n },
    kind: SkillMarketSourceKind.LOCAL,
    display: "team-skills",
    name: "team-skills",
    displayName: "Team Skills",
    state: SkillMarketSourceState.READY,
    contentRevision: HASH,
    entryCount: 1,
    addedAt: timestamp(),
    refreshedAt: timestamp(1_700_000_100n)
  };
}

function protoIdentity(): object {
  return { sourceId: SOURCE_ID, sourceRevision: { value: 2n }, entryId: ENTRY_ID, entryRevision: { value: 4n }, contentRevision: HASH };
}

function protoEntry(): object {
  return {
    identity: protoIdentity(), slug: "review-helper", name: "Review helper", author: "Joko Team",
    description: "Review a change safely.", category: "Productivity", tags: ["review", "safe"], version: "2.0.0",
    createdAt: timestamp(), updatedAt: timestamp(1_700_000_100n), downloads: 42n, trendScore: 9.5, archiveBytes: 512n,
    sourceName: "team-skills", sourceDisplayName: "Team Skills", sourceState: SkillMarketSourceState.READY,
    access: {
      revision: { value: 1n },
      publisher: { kind: SkillPublicationPublisher.EXTERNAL, sourceId: SOURCE_ID },
      visibility: SkillPublicationVisibility.PUBLIC,
      audienceScopeIds: []
    },
    canManage: false,
    installStatuses: [{
      resourceId: "resource-skill", resourceRevision: { value: 7n }, backendId: "pi",
      scope: ResourceScope.GLOBAL, state: SkillMarketInstallStatusState.UPDATE_AVAILABLE, installedVersion: "1.0.0"
    }]
  };
}

function protoPreview(): object {
  return { previewId: PREVIEW_ID, entry: protoEntry(), snapshotRevision: HASH, files: 1n, bytes: 96n, expiresAt: timestamp(1_800_000_000n) };
}

function mappedPreview(): any {
  return {
    id: PREVIEW_ID,
    entry: {},
    snapshotRevision: HASH,
    files: 1,
    bytes: 96,
    expiresAt: 1_800_000_000_000
  };
}

function protoTarget(): object {
  return { backendId: "pi", scope: ResourceScope.GLOBAL };
}

function protoBaseline(): object {
  return {
    resourceRevision: { value: 7n }, resourceContentRevision: HASH, installedContentRevision: HASH,
    installedVersion: "1.0.0", sourceRevision: { value: 2n }, entryRevision: { value: 4n }, entryContentRevision: HASH
  };
}

function protoPlan(): object {
  return {
    planId: PLAN_ID,
    entry: protoEntry(),
    target: protoTarget(),
    preview: {
      action: SkillMarketInstallAction.REPLACE,
      resourceId: "resource-skill",
      target: protoTarget(),
      name: "Review helper",
      availableVersion: "2.0.0",
      candidateRevision: OTHER_HASH,
      files: 1n,
      bytes: 96n,
      currentResource: {
        resourceId: "resource-skill", resourceRevision: { value: 7n }, name: "Review helper", version: "1.0.0",
        sourceKind: ResourceAcquisitionKind.SKILL_MARKET, sourceDisplay: "Team Skills · Review helper",
        discoveredRevision: HASH, observedRevision: HASH, dirty: true
      },
      unregisteredDestination: false,
      sourceReplacement: false,
      preservesEnabled: true,
      diffAvailable: true,
      changes: [{ key: "SKILL.md", kind: SkillDiffChangeKind.MODIFIED, binary: false, unifiedDiff: "-old\n+new" }],
      diffTruncated: false
    },
    confirmationReasons: [SkillMarketInstallConfirmationReason.DIRTY_CONTENT],
    requiresConfirmation: true,
    expiresAt: timestamp(1_800_000_000n)
  };
}

function protoPolicy(): object {
  return {
    resourceId: "resource-skill", revision: { value: 3n }, enabled: true, sourceId: SOURCE_ID, entryId: ENTRY_ID,
    target: protoTarget(), baseline: protoBaseline(), createdAt: timestamp(), updatedAt: timestamp(1_700_000_100n)
  };
}

function protoJob(): object {
  return {
    jobId: JOB_ID, revision: { value: 5n }, state: SkillMarketSyncJobState.FAILED,
    policyResourceId: "resource-skill", policyRevision: { value: 3n },
    authority: { sourceId: SOURCE_ID, entryId: ENTRY_ID, target: protoTarget(), baseline: protoBaseline() },
    attempt: 1, availableVersion: "2.0.0", outcome: SkillMarketSyncOutcome.DIRTY_CONTENT,
    error: "Installed content changed.", createdAt: timestamp(), updatedAt: timestamp(1_700_000_100n), completedAt: timestamp(1_700_000_100n)
  };
}

function protoPublicationAuthority(): object {
  return {
    resourceId: "resource-skill", resourceRevision: { value: 7n }, observedRevision: HASH,
    backendId: "pi", scope: ResourceScope.GLOBAL, sourceId: SOURCE_ID, sourceRevision: { value: 2n },
    sourceContentRevision: HASH, sourceDisplay: "team-skills"
  };
}

function protoPublicationGates(): object[] {
  return ["metadata", "package", "sensitive_content", "source_authority"].map((gateId) => ({
    gateId, label: gateId, status: SkillPublicationGateStatus.PASSED, issues: []
  }));
}

function protoPublicationPreview(): object {
  return {
    authority: protoPublicationAuthority(), source: protoSource(), mode: SkillPublicationMode.FIRST,
    suggestedSlug: "draft-skill", suggestedVersion: "1.0.0", dirty: false,
    personalPublisherAvailable: true, teamPublisherAvailable: false,
    publicVisibilityAvailable: true, departmentVisibilityAvailable: false, privateVisibilityAvailable: true,
    collaborationRevision: { value: 1n },
    collaborationUnavailableReason: "A collaboration identity owner is not configured."
  };
}

function protoPublicationJob(): object {
  return {
    jobId: PUBLICATION_ID, revision: { value: 6n }, state: SkillPublicationState.PUBLISHED,
    authority: protoPublicationAuthority(),
    metadata: { slug: "draft-skill", name: "Draft Skill", description: "Publish safely.", tags: ["writing"], version: "1.0.0" },
    publisher: SkillPublicationPublisher.PERSONAL, visibility: SkillPublicationVisibility.PUBLIC,
    audienceScopeIds: [], accessRevision: { value: 1n },
    gates: protoPublicationGates(), verdict: SkillPublicationVerdict.PASSED,
    files: 2n, uncompressedBytes: 256n, archiveBytes: 128n, attempt: 1,
    result: {
      sourceId: SOURCE_ID, sourceRevision: { value: 3n }, entryId: ENTRY_ID, entryRevision: { value: 1n },
      entryContentRevision: OTHER_HASH, version: "1.0.0"
    },
    createdAt: timestamp(), updatedAt: timestamp(1_700_000_100n), completedAt: timestamp(1_700_000_100n), cancellable: false
  };
}

function protoCollaborationDirectory(): object {
  return {
    available: true,
    revision: { value: 4n },
    actor: { actorId: "collaboration_actor_test", displayName: "Local owner" },
    scopes: [{
      scopeId: "collaboration_scope_test",
      revision: { value: 2n },
      kind: CollaborationScopeKind.TEAM,
      name: "Platform",
      members: [{ actorId: "collaboration_actor_test", role: CollaborationRole.ADMINISTRATOR }]
    }],
    recoveredFromCorruption: false
  };
}

function protoFailedPublicationJob(error: string): object {
  return {
    ...protoPublicationJob(),
    state: SkillPublicationState.FAILED,
    gates: ["metadata", "package", "sensitive_content", "source_authority"].map((gateId) => ({
      gateId, label: gateId, status: SkillPublicationGateStatus.PENDING, issues: []
    })),
    verdict: SkillPublicationVerdict.PENDING,
    result: undefined,
    error,
    cancellable: false
  };
}

function protoResourceUsageReport(): object {
  const passive = protoResourceUsageMetrics(5, { passiveExposures: 5n }, 1_699_999_900n);
  const active = protoResourceUsageMetrics(5, { strongActive: 5n, toolCalls: 5n, toolErrors: 1n }, 1_700_000_100n);
  const totals = protoResourceUsageMetrics(10, {
    strongActive: 5n,
    passiveExposures: 5n,
    toolCalls: 5n,
    toolErrors: 1n
  }, 1_700_000_100n);
  const previous = {
    identity: { resourceRevision: { value: 7n }, contentRevision: HASH, version: "1.0.0" },
    metrics: passive,
    firstUsedAt: timestamp(1_699_999_800n)
  };
  const current = {
    identity: { resourceRevision: { value: 8n }, contentRevision: OTHER_HASH, version: "2.0.0" },
    metrics: active,
    firstUsedAt: timestamp(1_700_000_000n)
  };
  return {
    resourceId: "resource-skill",
    timeZone: "Asia/Shanghai",
    fromDay: "2026-08-16",
    throughDay: "2026-09-14",
    days: Array.from({ length: 30 }, (_value, index) => ({
      localDay: new Date(Date.UTC(2026, 7, 16 + index)).toISOString().slice(0, 10),
      metrics: index === 29 ? totals : protoResourceUsageMetrics(0)
    })),
    totals,
    sources: [
      { source: ResourceUsageSource.RUNTIME_CONFIRMED_RESOURCE_LOAD, metrics: passive },
      { source: ResourceUsageSource.RUNTIME_TOOL_CALL, metrics: active }
    ],
    agents: [{ backendId: "pi", metrics: totals }],
    versions: [current, previous],
    comparison: { available: true, minimumSamples: 5, current, previous },
    projection: {
      complete: true,
      streamCount: 2,
      pendingStreamCount: 0,
      lastProjectedAt: timestamp(1_700_000_200n),
      failures: []
    }
  };
}

function protoResourceUsageMetrics(
  samples: number,
  values: Partial<Record<"strongActive" | "semiActive" | "passiveExposures" | "reads" | "rereads" | "toolCalls" | "toolErrors" | "commands" | "commandFailures", bigint>> = {},
  latestUsedAt?: bigint
): object {
  return {
    samples: BigInt(samples),
    strongActive: values.strongActive ?? 0n,
    semiActive: values.semiActive ?? 0n,
    passiveExposures: values.passiveExposures ?? 0n,
    reads: values.reads ?? 0n,
    rereads: values.rereads ?? 0n,
    toolCalls: values.toolCalls ?? 0n,
    toolErrors: values.toolErrors ?? 0n,
    commands: values.commands ?? 0n,
    commandFailures: values.commandFailures ?? 0n,
    ...(latestUsedAt === undefined ? {} : { latestUsedAt: timestamp(latestUsedAt) })
  };
}

function protoSkill(): object {
  return {
    skillId: "resource-skill", backendId: "pi", scope: ResourceScope.GLOBAL, name: "Review helper", sourceLabel: "review-helper",
    state: ResourceState.LOADED, enabled: true, canToggle: true, contentAvailable: true, canEdit: true, canDelete: true,
    entityVersion: { revision: { value: 7n }, generation: 0n, updatedAt: timestamp() }, approvedRevision: HASH, updatedAt: timestamp()
  };
}

function timestamp(seconds = 1_700_000_000n): { readonly seconds: bigint; readonly nanos: number } {
  return { seconds, nanos: 0 };
}

async function mount(handler: (method: string, input: any) => Promise<object>): Promise<ReturnType<typeof createOrchestratorGateway>> {
  const transport = {
    unary: vi.fn(async (method: any, _signal: AbortSignal | undefined, _timeout: unknown, _headers: Headers, input: any) =>
      response(method, create(method.output, await handler(method.localName, input)))),
    stream: vi.fn(async (method: any) => response(method, idleStream(), true))
  } as unknown as Transport;
  const gateway = createOrchestratorGateway(
    { id: "connection", deviceId: "device", name: "Desktop", origin: "https://orchestrator.example", serverId: "server" },
    "auth-key",
    {},
    () => transport
  );
  await gateway.connect();
  return gateway;
}

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
