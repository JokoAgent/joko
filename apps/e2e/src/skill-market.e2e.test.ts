import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";

import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  AddSkillMarketSourceMutationSchema,
  DeleteSkillMutationSchema,
  EnableSkillMarketSyncMutationSchema,
  EnqueueSkillMarketSyncMutationSchema,
  InstallSkillMarketPlanMutationSchema,
  OperationMutationSchema,
  OperationState,
  RefreshSkillMarketSourceMutationSchema,
  RemoveSkillMarketSourceMutationSchema,
  ResourceScope,
  SkillFileKind,
  SkillMarketInstallAction,
  SkillMarketInstallStatusState,
  SkillMarketInstallTargetSchema,
  SkillMarketSort,
  SkillMarketSyncJobState,
  SkillMarketSyncOutcome,
  SkillPublicationGateStatus,
  SkillPublicationMode,
  SkillPublicationPublisher,
  SkillPublicationState,
  SkillPublicationVerdict,
  SkillPublicationVisibility,
  StartSkillPublicationMutationSchema,
  TargetState,
  type Operation,
  type OperationMutation,
  type SkillMarketEntry,
  type SkillMarketInstallTarget
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { waitFor } from "./fixture.js";
import type { PairedClient } from "./connect-clients.js";
import { submit } from "./operations.js";
import {
  MARKET_NAME,
  MARKET_SLUG,
  SkillMarketSystemFixture,
  writeSkillMarketSource
} from "./skill-market-system-fixture.js";

describe("production Skill market chain", () => {
  let fixture: SkillMarketSystemFixture | undefined;
  let rootDirectory: string | undefined;

  afterEach(async () => {
    await fixture?.close().catch(() => undefined);
    fixture = undefined;
    if (rootDirectory !== undefined) {
      await rm(rootDirectory, { recursive: true, force: true, maxRetries: 3 });
      rootDirectory = undefined;
    }
  });

  it("installs, updates, restarts, removes its source, and uninstalls exact Resources through production Connect", async () => {
    fixture = await SkillMarketSystemFixture.start({ keepRoot: true });
    rootDirectory = fixture.rootDirectory;
    await expect(fixture.anonymous.skill.listSkillMarketSources({ page: { pageSize: 10 } }))
      .rejects.toMatchObject({ code: Code.Unauthenticated });
    let paired = await fixture.pair("Skill market HTTP owner");
    const sourceRoot = await writeSkillMarketSource(fixture, "1.0.0", "# Version one");

    await succeed(paired, {
      case: "addSkillMarketSource",
      value: create(AddSkillMarketSourceMutationSchema, {
        source: { kind: { case: "local", value: { serverPath: sourceRoot } } },
        expectedCatalogRevision: { value: 0n }
      })
    }, "add the market source");
    let sources = await paired.clients.skill.listSkillMarketSources({ page: { pageSize: 500 } });
    expect(sources.sources).toMatchObject([{ displayName: "Production Skill Market", entryCount: 1 }]);
    expect(privateJson(sources)).not.toContain(sourceRoot);

    let catalog = await paired.clients.skill.listSkillMarketCatalog({
      query: "production",
      category: "Writing",
      sort: SkillMarketSort.UPDATED,
      page: { pageSize: 1 }
    });
    const entry = required(catalog.entries[0], "market entry");
    expect(entry).toMatchObject({ slug: MARKET_SLUG, name: MARKET_NAME, version: "1.0.0", installStatuses: [] });
    const preview = required((await paired.clients.skill.openSkillMarketPreview({ identity: entry.identity })).preview, "market preview");
    const files = await paired.clients.skill.listSkillMarketPreviewFiles({
      previewId: preview.previewId,
      expectedSnapshotRevision: preview.snapshotRevision,
      page: { pageSize: 1 }
    });
    expect(files.files).toHaveLength(1);
    expect(files.page?.nextPageToken).not.toBe("");
    const allFiles = await paired.clients.skill.listSkillMarketPreviewFiles({
      previewId: preview.previewId,
      expectedSnapshotRevision: preview.snapshotRevision,
      page: { pageSize: 500 }
    });
    expect(allFiles.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "SKILL.md", kind: SkillFileKind.FILE }),
      expect.objectContaining({ key: "references/guide.md", kind: SkillFileKind.FILE })
    ]));
    const document = required((await paired.clients.skill.readSkillMarketPreviewFile({
      previewId: preview.previewId,
      expectedSnapshotRevision: preview.snapshotRevision,
      key: "SKILL.md"
    })).file, "market preview file");
    expect(document.content).toContain("# Version one");
    expect(privateJson({ catalog, preview, allFiles, document })).not.toContain(fixture.rootDirectory);
    await paired.clients.skill.closeSkillMarketPreview({ previewId: preview.previewId });

    const globalTarget = createTarget({ backendId: "pi", scope: ResourceScope.GLOBAL });
    const globalSkill = await install(paired, entry, globalTarget, SkillMarketInstallAction.INSTALL);
    const targets = await paired.clients.target.listTargets({ backendId: "pi", state: TargetState.ACTIVE, page: { pageSize: 100 } });
    const project = required(targets.targets[0], "trusted project Target");
    await install(paired, entry, createTarget({ backendId: "pi", scope: ResourceScope.PROJECT, targetId: project.targetId }), SkillMarketInstallAction.INSTALL);
    await install(paired, entry, createTarget({
      backendId: "pi",
      scope: ResourceScope.PROJECT,
      targetId: project.targetId,
      relativeParent: "custom/skills"
    }), SkillMarketInstallAction.INSTALL);
    catalog = await paired.clients.skill.listSkillMarketCatalog({ sort: SkillMarketSort.UPDATED, page: { pageSize: 100 } });
    const initialStatuses = required(catalog.entries[0], "installed catalog entry").installStatuses;
    expect(initialStatuses).toHaveLength(3);
    expect(initialStatuses.find((status) => status.resourceId === globalSkill.skillId)).toMatchObject({
      scope: ResourceScope.GLOBAL,
      state: SkillMarketInstallStatusState.INSTALLED,
      installedVersion: "1.0.0"
    });
    expect(initialStatuses.filter((status) => status.scope === ResourceScope.PROJECT))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ relativeParent: ".agents/skills", state: SkillMarketInstallStatusState.INSTALLED }),
        expect.objectContaining({ relativeParent: "custom/skills", state: SkillMarketInstallStatusState.INSTALLED })
      ]));

    await succeed(paired, {
      case: "enableSkillMarketSync",
      value: create(EnableSkillMarketSyncMutationSchema, {
        resourceId: globalSkill.skillId,
        expectedResourceRevision: globalSkill.entityVersion?.revision,
        target: globalTarget
      })
    }, "enable exact automatic updates");
    await writeSkillMarketSource(fixture, "1.1.0", "# Version two");
    sources = await paired.clients.skill.listSkillMarketSources({ page: { pageSize: 500 } });
    const source = required(sources.sources[0], "market source");
    await succeed(paired, {
      case: "refreshSkillMarketSource",
      value: create(RefreshSkillMarketSourceMutationSchema, {
        sourceId: source.sourceId,
        expectedRevision: source.revision
      })
    }, "refresh the market source");
    catalog = await paired.clients.skill.listSkillMarketCatalog({ sort: SkillMarketSort.UPDATED, page: { pageSize: 100 } });
    expect(catalog.entries[0]?.version).toBe("1.1.0");
    expect(catalog.entries[0]?.installStatuses.find((status) => status.resourceId === globalSkill.skillId)?.state)
      .toBe(SkillMarketInstallStatusState.UPDATE_AVAILABLE);
    const policy = required((await paired.clients.skill.listSkillMarketSyncPolicies({ page: { pageSize: 100 } })).policies[0], "sync policy");
    await succeed(paired, {
      case: "enqueueSkillMarketSync",
      value: create(EnqueueSkillMarketSyncMutationSchema, {
        resourceId: globalSkill.skillId,
        expectedPolicyRevision: policy.revision
      })
    }, "queue automatic update");
    const completedJobs = await waitFor(
      () => paired.clients.skill.listSkillMarketSyncJobs({ resourceId: globalSkill.skillId, page: { pageSize: 100 } }),
      (value) => value.jobs.some((job) => job.state === SkillMarketSyncJobState.SUCCEEDED),
      "the production Skill market sync job",
      20_000
    );
    expect(completedJobs.jobs[0]).toMatchObject({
      state: SkillMarketSyncJobState.SUCCEEDED,
      outcome: SkillMarketSyncOutcome.UPDATED,
      availableVersion: "1.1.0"
    });
    catalog = await paired.clients.skill.listSkillMarketCatalog({ sort: SkillMarketSort.UPDATED, page: { pageSize: 100 } });
    expect(catalog.entries[0]?.installStatuses.find((status) => status.resourceId === globalSkill.skillId))
      .toMatchObject({ state: SkillMarketInstallStatusState.INSTALLED, installedVersion: "1.1.0" });

    const publicationResource = required(
      (await paired.clients.skill.listSkills({ page: { pageSize: 500 } })).skills.find((skill) => skill.skillId === globalSkill.skillId),
      "publication Skill Resource"
    );
    const publicationEntry = required(catalog.entries[0], "publication destination entry");
    const publicationPreview = required((await paired.clients.skill.getSkillPublicationPreview({
      resourceId: publicationResource.skillId,
      expectedResourceRevision: publicationResource.entityVersion?.revision,
      sourceId: required(publicationEntry.identity, "publication destination identity").sourceId,
      expectedSourceRevision: publicationEntry.identity?.sourceRevision,
      slug: MARKET_SLUG
    })).preview, "publication preview");
    expect(publicationPreview).toMatchObject({
      mode: SkillPublicationMode.VERSION,
      suggestedSlug: MARKET_SLUG,
      suggestedVersion: "1.1.1",
      personalPublisherAvailable: true,
      teamPublisherAvailable: false,
      publicVisibilityAvailable: true,
      departmentVisibilityAvailable: false,
      privateVisibilityAvailable: false
    });
    const publicationAuthority = required(publicationPreview.authority, "publication authority");
    await succeed(paired, {
      case: "startSkillPublication",
      value: create(StartSkillPublicationMutationSchema, {
        resourceId: publicationAuthority.resourceId,
        expectedResourceRevision: publicationAuthority.resourceRevision,
        expectedObservedRevision: publicationAuthority.observedRevision,
        sourceId: publicationAuthority.sourceId,
        expectedSourceRevision: publicationAuthority.sourceRevision,
        expectedSourceContentRevision: publicationAuthority.sourceContentRevision,
        expectedExistingEntryId: publicationAuthority.existingEntryId,
        metadata: {
          slug: MARKET_SLUG,
          name: MARKET_NAME,
          author: "Joko E2E",
          description: "Production Skill market fixture",
          tags: ["writing", "production"],
          version: "1.2.0",
          changelog: "Publish through the production HTTP chain."
        },
        publisher: SkillPublicationPublisher.PERSONAL,
        visibility: SkillPublicationVisibility.PUBLIC
      })
    }, "publish the exact Skill version");
    const publications = await waitFor(
      () => paired.clients.skill.listSkillPublicationJobs({ resourceId: publicationResource.skillId, page: { pageSize: 100 } }),
      (value) => value.jobs.some((job) => job.state === SkillPublicationState.PUBLISHED),
      "the production Skill publication job",
      20_000
    );
    const published = required(publications.jobs.find((job) => job.state === SkillPublicationState.PUBLISHED), "published Skill job");
    expect(published).toMatchObject({
      verdict: SkillPublicationVerdict.PASSED,
      metadata: { slug: MARKET_SLUG, version: "1.2.0", changelog: "Publish through the production HTTP chain." },
      cancellable: false
    });
    expect(published.gates).toHaveLength(4);
    expect(published.gates.every((gate) => gate.status === SkillPublicationGateStatus.PASSED)).toBe(true);
    const publicationResult = required(published.result, "published market identity");
    const exactPublishedEntry = required((await paired.clients.skill.getSkillMarketEntry({
      identity: {
        sourceId: publicationResult.sourceId,
        sourceRevision: publicationResult.sourceRevision,
        entryId: publicationResult.entryId,
        entryRevision: publicationResult.entryRevision,
        contentRevision: publicationResult.entryContentRevision
      }
    })).entry, "exact published entry");
    expect(exactPublishedEntry).toMatchObject({ slug: MARKET_SLUG, version: "1.2.0" });
    const publishedPreview = required((await paired.clients.skill.openSkillMarketPreview({ identity: exactPublishedEntry.identity })).preview, "published preview");
    const publishedManifest = required((await paired.clients.skill.readSkillMarketPreviewFile({
      previewId: publishedPreview.previewId,
      expectedSnapshotRevision: publishedPreview.snapshotRevision,
      key: "SKILL.md"
    })).file, "published manifest");
    expect(publishedManifest.content).toContain("version: 1.2.0");
    await paired.clients.skill.closeSkillMarketPreview({ previewId: publishedPreview.previewId });
    const installedSession = required((await paired.clients.skill.openSkill({
      skillId: publicationResource.skillId,
      expectedResourceRevision: publicationResource.entityVersion?.revision
    })).skill, "installed Skill after publication");
    const installedManifest = required((await paired.clients.skill.readSkillFile({
      sessionId: installedSession.sessionId,
      key: "SKILL.md"
    })).file, "installed manifest after publication");
    expect(installedManifest.content).toContain("version: 1.1.0");
    expect(installedManifest.content).not.toContain("version: 1.2.0");
    await paired.clients.skill.closeSkill({ sessionId: installedSession.sessionId });
    expect(privateJson({ publicationPreview, publications, exactPublishedEntry, publishedPreview, publishedManifest })).not.toContain(fixture.rootDirectory);

    await fixture.close({ removeRoot: false });
    fixture = undefined;
    fixture = await SkillMarketSystemFixture.start({ rootDirectory, keepRoot: true });
    paired = await fixture.pair("Skill market restart owner");
    const restartedCatalog = await paired.clients.skill.listSkillMarketCatalog({ sort: SkillMarketSort.UPDATED, page: { pageSize: 100 } });
    expect(restartedCatalog.entries[0]?.installStatuses.find((status) => status.resourceId === globalSkill.skillId))
      .toMatchObject({ state: SkillMarketInstallStatusState.UPDATE_AVAILABLE, installedVersion: "1.1.0" });
    expect(restartedCatalog.entries[0]).toMatchObject({ version: "1.2.0" });
    expect((await paired.clients.skill.listSkillPublicationJobs({ resourceId: globalSkill.skillId, page: { pageSize: 100 } })).jobs)
      .toMatchObject([{ state: SkillPublicationState.PUBLISHED, result: { version: "1.2.0" } }]);
    expect((await paired.clients.skill.listSkillMarketSyncPolicies({ page: { pageSize: 100 } })).policies)
      .toMatchObject([{ resourceId: globalSkill.skillId, enabled: true }]);

    const restartedSource = required((await paired.clients.skill.listSkillMarketSources({ page: { pageSize: 100 } })).sources[0], "restarted source");
    await succeed(paired, {
      case: "removeSkillMarketSource",
      value: create(RemoveSkillMarketSourceMutationSchema, {
        sourceId: restartedSource.sourceId,
        expectedRevision: restartedSource.revision
      })
    }, "remove the source without uninstalling");
    expect((await paired.clients.skill.listSkillMarketCatalog({ sort: SkillMarketSort.UPDATED, page: { pageSize: 100 } })).entries).toEqual([]);
    const remainingSkills = await paired.clients.skill.listSkills({ page: { pageSize: 500 } });
    const remainingGlobal = required(remainingSkills.skills.find((skill) => skill.skillId === globalSkill.skillId), "source-independent installed Skill");
    const session = required((await paired.clients.skill.openSkill({
      skillId: remainingGlobal.skillId,
      expectedResourceRevision: remainingGlobal.entityVersion?.revision
    })).skill, "uninstall Skill session");
    await succeed(paired, {
      case: "deleteSkill",
      value: create(DeleteSkillMutationSchema, { sessionId: session.sessionId, confirmation: MARKET_SLUG })
    }, "uninstall the exact global Skill");
    const terminated = required((await paired.clients.skill.listSkillMarketSyncPolicies({ page: { pageSize: 100 } })).policies[0], "terminated sync policy");
    expect(terminated).toMatchObject({ resourceId: globalSkill.skillId, enabled: false, disabledReason: "resource_removed" });
    expect(privateJson({ restartedCatalog, terminated })).not.toContain(fixture.rootDirectory);
  }, 120_000);
});

function createTarget(input: {
  readonly backendId: string;
  readonly scope: ResourceScope;
  readonly targetId?: string;
  readonly relativeParent?: string;
}): SkillMarketInstallTarget {
  return create(SkillMarketInstallTargetSchema, input);
}

async function install(
  paired: PairedClient,
  entry: SkillMarketEntry,
  target: SkillMarketInstallTarget,
  expectedAction: SkillMarketInstallAction
) {
  const plan = required((await paired.clients.skill.createSkillMarketInstallPlan({ identity: entry.identity, target })).plan, "install plan");
  expect(plan.preview?.action).toBe(expectedAction);
  const preview = required(plan.preview, "install preview");
  const operation = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
    payload: {
      case: "installSkillMarketPlan",
      value: create(InstallSkillMarketPlanMutationSchema, {
        planId: plan.planId,
        expectedCandidateRevision: preview.candidateRevision,
        confirmReplacement: false
      })
    }
  }), randomUUID());
  if (operation.state !== OperationState.SUCCEEDED || operation.result?.payload.case !== "skill" || operation.result.payload.value.skill === undefined) {
    throw new Error("Production Skill market install did not return a Skill Resource.");
  }
  return operation.result.payload.value.skill;
}

async function succeed(
  paired: PairedClient,
  payload: OperationMutation["payload"],
  action: string
): Promise<Operation> {
  const operation = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, { payload }), randomUUID());
  if (operation.state !== OperationState.SUCCEEDED) throw new Error(`Failed to ${action}: ${operation.error?.message ?? operation.state}.`);
  return operation;
}

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined || value === "") throw new Error(`${label} is missing.`);
  return value;
}

function privateJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => typeof nested === "bigint" ? nested.toString() : nested);
}
