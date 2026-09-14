import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  OperationState,
  ResourceAcquisitionKind,
  ResourceScope,
  ResourceState,
  SkillDiffChangeKind,
  SkillFileKind,
  SkillMarketInstallAction,
  SkillMarketInstallConfirmationReason,
  SkillMarketInstallStatusState,
  SkillMarketPreviewUnavailableReason,
  SkillMarketSourceKind,
  SkillMarketSourceState,
  SkillMarketSyncJobState,
  SkillMarketSyncOutcome
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway } from "./gateway.js";

const SOURCE_ID = "skill_market_source_0123456789abcdef0123456789abcdef";
const ENTRY_ID = "skill_market_entry_0123456789abcdef0123456789abcdef";
const PREVIEW_ID = "skill_market_preview_0123456789abcdef0123456789abcdef";
const PLAN_ID = "skill_market_install_0123456789abcdef0123456789abcdef";
const JOB_ID = "skill_sync_0123456789abcdef0123456789abcdef";
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
      { case: "addSkillMarketSource", value: { expectedCatalogRevision: { value: 9n }, source: { kind: { case: "local", value: { serverPath: "D:\\private\\skill-market" } } } } },
      { case: "refreshSkillMarketSource", value: { sourceId: SOURCE_ID, expectedRevision: { value: 2n } } },
      { case: "removeSkillMarketSource", value: { sourceId: SOURCE_ID, expectedRevision: { value: 2n } } }
    ]);
    const publicProjection = JSON.stringify({ sources, firstPage, entry, preview, plan, policies, jobs }, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
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
