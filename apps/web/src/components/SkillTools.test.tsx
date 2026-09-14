// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type {
  BackendView,
  ResourceUsageReportView,
  SkillDescriptorView,
  SkillDraftView,
  SkillMarketEntryView,
  SkillMarketSourceView,
  SkillPublicationJobView,
  SkillPublicationPreviewView,
  SkillRecoveryView,
  SkillSessionView,
  TargetView
} from "../model.js";
import { diffLineClass, groupSkillCatalog, SkillTools } from "./SkillTools.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  vi.restoreAllMocks();
});

describe("SkillTools", () => {
  it("shows loading, catalog failure, empty, and independently retryable recovery states", async () => {
    const listSkills = vi.fn()
      .mockRejectedValueOnce(new Error("Catalog unavailable."))
      .mockResolvedValue({ revision: 2n, skills: [] });
    const listSkillRecoveries = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("Recovery list unavailable."))
      .mockResolvedValueOnce([]);
    const controller = skillController({ listSkills, listSkillRecoveries });
    const container = await renderSkills(controller);

    expect(container.textContent).toContain("Loading Skills");
    await settle();
    expect(container.textContent).toContain("Catalog unavailable.");

    await act(async () => buttonWithText(container, "Retry").click());
    await settle();
    expect(container.textContent).toContain("No local Skills");
    expect(container.textContent).toContain("Recovery list unavailable.");

    await act(async () => buttonWithText(container, "Retry").click());
    await settle();
    expect(container.textContent).toContain("No local Skills");
    expect(container.textContent).not.toContain("Recovery list unavailable.");
    expect(listSkills).toHaveBeenCalledTimes(3);
    expect(listSkillRecoveries).toHaveBeenCalledTimes(3);
  });

  it("preserves edited text across a failed apply and reviews the exact draft diff before retry", async () => {
    let revision = 1n;
    const applySkillDraft = vi.fn()
      .mockRejectedValueOnce(new Error("The Skill changed before commit."))
      .mockImplementationOnce(async () => {
        revision = 2n;
        return { skill: { ...globalSkill(), revision } };
      });
    const controller = skillController({
      listSkills: vi.fn(async () => ({ revision, skills: [{ ...globalSkill(), revision }, projectSkill()] })),
      applySkillDraft
    });
    const container = await renderSkills(controller);
    await settle();

    expect(container.textContent).toContain("Global");
    expect(container.textContent).toContain("Review helper");
    expect(container.textContent).toContain("# Original Skill");
    expect(container.textContent).toContain("Changes from approved revision");

    await act(async () => buttonWithText(container, "Edit").click());
    const editor = required(container.querySelector<HTMLTextAreaElement>('[aria-label="Skill file editor"]'));
    await act(async () => setInputValue(editor, "# Changed Skill"));
    await act(async () => buttonWithText(container, "Review changes").click());
    await settle();

    const review = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    expect(review.textContent).toContain("Review Skill changes");
    expect(review.textContent).toContain("-# Original Skill");
    expect(review.textContent).toContain("+# Changed Skill");

    await act(async () => buttonWithText(review, "Apply changes").click());
    await settle();
    expect(document.body.textContent).toContain("The Skill changed before commit.");
    expect(required(container.querySelector<HTMLTextAreaElement>('[aria-label="Skill file editor"]')).value).toBe("# Changed Skill");

    await act(async () => buttonWithText(review, "Apply changes").click());
    await settle();
    expect(applySkillDraft).toHaveBeenCalledTimes(2);
    expect(controller.openSkill).toHaveBeenLastCalledWith("resource-global", 2n, expect.any(AbortSignal));
  });

  it("lazy-loads nested files and prevents a dirty editor from silently changing Skills", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const listSkillFiles = vi.fn()
      .mockRejectedValueOnce(new Error("Nested files unavailable."))
      .mockResolvedValueOnce([{ key: "notes.txt", name: "notes.txt", kind: "file", size: 12, editable: true }]);
    const controller = skillController({ listSkillFiles });
    const container = await renderSkills(controller);
    await settle();

    await act(async () => buttonWithText(container, "references/").click());
    await settle();
    expect(container.textContent).toContain("Nested files unavailable.");
    await act(async () => buttonWithText(container, "Retry").click());
    await settle();
    expect(controller.listSkillFiles).toHaveBeenCalledWith(
      expect.stringMatching(/^skill-session-/u),
      "references",
      expect.any(AbortSignal)
    );
    await act(async () => buttonWithText(container, "notes.txt").click());
    await settle();
    expect(container.textContent).toContain("Nested notes");

    await act(async () => buttonWithText(container, "SKILL.md").click());
    await settle();
    await act(async () => buttonWithText(container, "Edit").click());
    await act(async () => setInputValue(required(container.querySelector("textarea")), "Unsaved text"));
    const projectCard = buttonWithText(container, /Project helper/u);
    await act(async () => projectCard.click());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(controller.openSkill).toHaveBeenCalledTimes(1);
    expect(required(container.querySelector("textarea")).value).toBe("Unsaved text");

    await act(async () => projectCard.click());
    await settle();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(controller.openSkill).toHaveBeenCalledTimes(2);
    expect(controller.closeSkill).toHaveBeenCalled();
  });

  it("uses exact rendered authority for toggle and typed-name deletion, then exposes recovery status", async () => {
    let current: SkillDescriptorView | undefined = globalSkill();
    let recovery: SkillRecoveryView | undefined;
    const setSkillEnabled = vi.fn(async (skill: SkillDescriptorView, enabled: boolean) => {
      current = { ...skill, enabled, state: enabled ? "loaded" : "disabled", revision: skill.revision + 1n };
      return { skill: current };
    });
    const deleteSkill = vi.fn(async (session: SkillSessionView, confirmation: string) => {
      expect(session.skill.revision).toBe(2n);
      expect(confirmation).toBe("Review helper");
      current = undefined;
      recovery = recoveryFixture();
      return { recoveryId: recovery.id };
    });
    const controller = skillController({
      listSkills: vi.fn(async () => ({ revision: current === undefined ? 3n : current.revision, skills: current === undefined ? [] : [current] })),
      listSkillRecoveries: vi.fn(async () => recovery === undefined ? [] : [recovery]),
      setSkillEnabled,
      deleteSkill,
      openSkill: vi.fn(async (id: string, expectedRevision: bigint) => sessionFor({ ...required(current), id, revision: expectedRevision }))
    });
    const container = await renderSkills(controller);
    await settle();

    await act(async () => buttonWithText(container, "Disable").click());
    await settle();
    expect(setSkillEnabled).toHaveBeenCalledWith(expect.objectContaining({ id: "resource-global", revision: 1n }), false);
    expect(container.textContent).toContain("Disabled");

    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Delete Review helper?"]')).click());
    const dialog = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    expect(dialog.textContent).toContain("Pi Runtime");
    expect(dialog.textContent).toContain("Global");
    expect(dialog.textContent).toContain("3 files · 128 B");
    const deleteButton = buttonWithText(dialog, "Delete");
    expect(deleteButton.disabled).toBe(true);
    await act(async () => setInputValue(required(dialog.querySelector("input")), "Review helper"));
    expect(deleteButton.disabled).toBe(false);
    await act(async () => deleteButton.click());
    await settle();

    expect(deleteSkill).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(recoveryFixture().id);
    await act(async () => buttonWithText(required(document.body.querySelector('[role="dialog"]')), "Close").click());
    expect(container.textContent).toContain("Recoverable copies");
    expect(container.textContent).toContain("Ready");
  });

  it("retries a failed file read and moves focus into the narrow-screen detail", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const readSkillFile = vi.fn()
      .mockRejectedValueOnce(new Error("File preview unavailable."))
      .mockResolvedValueOnce({ key: "SKILL.md", content: "# Retried", revision: "sha256:retried", size: 9, editable: true });
    const controller = skillController({ readSkillFile });
    const container = await renderSkills(controller);
    await settle();
    expect(container.textContent).toContain("File preview unavailable.");
    await act(async () => buttonWithText(container, "Retry").click());
    await settle();
    expect(container.textContent).toContain("# Retried");

    await act(async () => buttonWithText(container, /Review helper/u).click());
    await settle();
    expect(document.activeElement?.tagName).toBe("H2");
    expect(document.activeElement?.textContent).toBe("Review helper");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  });

  it("publishes only a manageable Skill and hands the exact result directly to its market detail", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const preview = publicationPreviewFixture();
    const published = publicationJobFixture();
    let started = false;
    const getSkillMarketEntry = vi.fn(async () => marketEntryFixture());
    const controller = skillController({
      listSkillMarketSources: vi.fn(async () => ({ revision: 4n, sources: [marketSourceFixture()], recoveredFromCorruption: false })),
      getSkillPublicationPreview: vi.fn(async () => preview),
      listSkillPublicationJobs: vi.fn(async () => ({ items: started ? [published] : [], recoveredFromCorruption: false })),
      startSkillPublication: vi.fn(async () => { started = true; }),
      getSkillPublicationJob: vi.fn(async () => published),
      cancelSkillPublication: vi.fn(async () => undefined),
      retrySkillPublication: vi.fn(async () => undefined),
      listSkillMarketCatalog: vi.fn(async () => ({
        revision: published.result!.sourceRevision,
        entries: [marketEntryFixture()],
        categories: [],
        sourceCount: 1,
        totalSize: 1
      })),
      getSkillMarketEntry,
      openSkillMarketPreview: vi.fn(async () => ({
        id: "skill-market-preview",
        entry: marketEntryFixture(),
        snapshotRevision: HASH_B,
        files: 1,
        bytes: 96,
        expiresAt: Date.now() + 60_000
      })),
      listSkillMarketPreviewFiles: vi.fn(async () => ({
        snapshotRevision: HASH_B,
        files: [{ key: "SKILL.md", kind: "file" as const, size: 96 }],
        totalSize: 1
      })),
      readSkillMarketPreviewFile: vi.fn(async () => ({
        previewId: "skill-market-preview",
        snapshotRevision: HASH_B,
        key: "SKILL.md",
        size: 96,
        previewable: true,
        content: "# Published"
      })),
      closeSkillMarketPreview: vi.fn(async () => true)
    });
    const container = await renderSkills(controller);
    await settle();

    await act(async () => buttonWithText(container, "Publish").click());
    await settle();
    const dialog = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    await act(async () => buttonWithText(dialog, "Review publication target").click());
    await settle();
    await act(async () => buttonWithText(dialog, "Publish Skill").click());
    await settle();
    await act(async () => buttonWithText(dialog, "Open in Skill market").click());
    await settle(140);

    const identity = marketEntryFixture().identity;
    expect(getSkillMarketEntry).toHaveBeenCalledWith(identity, expect.any(AbortSignal));
    expect(container.textContent).toContain("Published Review helper");
    expect(container.textContent).toContain("# Published");
    expect(container.querySelector(".skill-market-browser--mobile-detail")).not.toBeNull();
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();

    const unmanaged = { ...globalSkill(), canEdit: false, canDelete: false };
    const unmanagedController = skillController({
      listSkills: vi.fn(async () => ({ revision: 1n, skills: [unmanaged] })),
      openSkill: vi.fn(async () => sessionFor(unmanaged))
    });
    const unmanagedContainer = await renderSkills(unmanagedController);
    await settle();
    expect([...unmanagedContainer.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Publish")).toBe(false);
  });

  it("groups global and project identities without using service paths and classifies diff rows", () => {
    expect(groupSkillCatalog([projectSkill(), globalSkill()], targets, "Global", "Project")).toMatchObject([
      { key: "global", label: "Global", skills: [{ id: "resource-global" }] },
      { key: "project:target-project", label: "Project Alpha", skills: [{ id: "resource-project" }] }
    ]);
    expect(diffLineClass("+++ SKILL.md")).toBe("skill-diff-line--header");
    expect(diffLineClass("+added")).toBe("skill-diff-line--added");
    expect(diffLineClass("-deleted")).toBe("skill-diff-line--deleted");
    expect(diffLineClass("@@ -1 +1 @@")).toBe("skill-diff-line--hunk");
  });

  it("loads exact Resource usage, retries independently, and exposes degraded evidence honestly", async () => {
    const getSkillResourceUsageReport = vi.fn()
      .mockRejectedValueOnce(new Error("Usage projection unavailable."))
      .mockResolvedValueOnce(resourceUsageFixture(false));
    const controller = skillController({ getSkillResourceUsageReport });
    const container = await renderSkills(controller);
    await settle();

    expect(container.textContent).toContain("Usage projection unavailable.");
    await act(async () => buttonWithText(container, "Retry").click());
    await settle();

    expect(container.textContent).toContain("Usage and impact");
    expect(container.textContent).toContain("Usage is still being reconciled");
    expect(container.textContent).toContain("Runtime-confirmed loads");
    expect(container.textContent).toContain("Runtime tool calls");
    expect(container.textContent).toContain("Pi Runtime");
    expect(container.textContent).toContain("v2.0.0");
    expect(container.textContent).toContain("v1.0.0");
    expect(getSkillResourceUsageReport).toHaveBeenNthCalledWith(
      2,
      "resource-global",
      expect.any(String),
      expect.any(AbortSignal)
    );
  });
});

function skillController(overrides: Partial<AppController> = {}): AppController {
  const openSkill = vi.fn(async (id: string, expectedRevision: bigint) => sessionFor(
    id === "resource-project" ? { ...projectSkill(), revision: expectedRevision } : { ...globalSkill(), revision: expectedRevision }
  ));
  return {
    listSkills: vi.fn(async () => ({ revision: 1n, skills: [globalSkill(), projectSkill()] })),
    getSkillResourceUsageReport: vi.fn(async () => resourceUsageFixture(true)),
    listSkillRecoveries: vi.fn(async () => []),
    openSkill,
    closeSkill: vi.fn(async () => true),
    readSkillFile: vi.fn(async (_sessionId: string, key: string) => ({
      key,
      content: key === "notes.txt" ? "Nested notes" : "# Original Skill",
      revision: `sha256:${key}`,
      size: 16,
      editable: true
    })),
    listSkillFiles: vi.fn(async () => [{ key: "notes.txt", name: "notes.txt", kind: "file", size: 12, editable: true }]),
    getSkillDiff: vi.fn(async () => diffFixture()),
    prepareSkillFileEdit: vi.fn(async (sessionId: string, _key: string, _revision: string, content: string) => draftFixture(sessionId, "edit", content)),
    prepareSkillRename: vi.fn(async (sessionId: string, name: string) => draftFixture(sessionId, "rename", name)),
    applySkillDraft: vi.fn(async () => ({ skill: globalSkill() })),
    setSkillEnabled: vi.fn(async (skill: SkillDescriptorView, enabled: boolean) => ({ skill: { ...skill, enabled } })),
    deleteSkill: vi.fn(async () => ({ recoveryId: recoveryFixture().id })),
    getCollaborationDirectory: vi.fn(async () => ({
      available: true,
      revision: 1n,
      actor: { id: "collaboration_actor_test", displayName: "Local owner" },
      scopes: [],
      recoveredFromCorruption: false
    })),
    ...overrides
  } as unknown as AppController;
}

function globalSkill(): SkillDescriptorView {
  return {
    id: "resource-global",
    backendId: "pi",
    scope: "global",
    name: "Review helper",
    sourceLabel: "review-helper",
    state: "loaded",
    enabled: true,
    canToggle: true,
    contentAvailable: true,
    canEdit: true,
    canDelete: true,
    revision: 1n,
    approvedRevision: "sha256:approved",
    updatedAt: 1_700_000_000_000
  };
}

function projectSkill(): SkillDescriptorView {
  return {
    ...globalSkill(),
    id: "resource-project",
    targetId: "target-project",
    scope: "project",
    name: "Project helper",
    sourceLabel: "project-helper",
    approvedRevision: "sha256:project"
  };
}

function sessionFor(skill: SkillDescriptorView): SkillSessionView {
  return {
    id: `skill-session-${skill.id}`,
    skill,
    observedRevision: "sha256:observed",
    dirty: skill.scope === "project",
    baselineAvailable: true,
    metadata: { name: skill.name, description: "Review safely", version: "1.0.0", frontmatter: { name: skill.name, token: "[redacted]" } },
    files: [
      { key: "SKILL.md", name: "SKILL.md", kind: "file", size: 96, editable: true },
      { key: "references", name: "references", kind: "directory", size: 0, editable: false }
    ],
    fileCount: 3,
    bytes: 128,
    diff: diffFixture(),
    expiresAt: 1_800_000_000_000
  };
}

function resourceUsageFixture(complete: boolean): ResourceUsageReportView {
  const previous = {
    identity: { resourceRevision: 1n, contentRevision: HASH_A, version: "1.0.0" },
    metrics: resourceUsageMetrics(5, { passiveExposures: 5 }),
    firstUsedAt: 1_699_999_800_000
  };
  const current = {
    identity: { resourceRevision: 2n, contentRevision: HASH_B, version: "2.0.0" },
    metrics: resourceUsageMetrics(5, { strongActive: 5, toolCalls: 5, toolErrors: 1 }),
    firstUsedAt: 1_700_000_000_000
  };
  const totals = resourceUsageMetrics(10, {
    strongActive: 5,
    passiveExposures: 5,
    toolCalls: 5,
    toolErrors: 1
  });
  return {
    resourceId: "resource-global",
    timeZone: "UTC",
    fromDay: "2026-08-16",
    throughDay: "2026-09-14",
    days: Array.from({ length: 30 }, (_value, index) => ({
      localDay: new Date(Date.UTC(2026, 7, 16 + index)).toISOString().slice(0, 10),
      metrics: index === 29 ? totals : resourceUsageMetrics(0)
    })),
    totals: { ...totals, latestUsedAt: 1_700_000_100_000 },
    sources: [
      { source: "runtimeConfirmedResourceLoad", metrics: previous.metrics },
      { source: "runtimeToolCall", metrics: current.metrics }
    ],
    agents: [{ backendId: "pi", metrics: totals }],
    versions: [current, previous],
    comparison: { available: true, minimumSamples: 5, current, previous },
    projection: complete
      ? { complete: true, streamCount: 2, pendingStreamCount: 0, failures: [] }
      : {
          complete: false,
          streamCount: 2,
          pendingStreamCount: 1,
          failures: [{
            sessionId: "session-usage",
            source: "runtimeToolCall",
            attempts: 1,
            retryAt: 1_700_000_200_000,
            errorCode: "RESOURCE_USAGE_PROJECTION_FAILED"
          }]
        }
  };
}

function resourceUsageMetrics(samples: number, overrides: Partial<ResourceUsageReportView["totals"]> = {}): ResourceUsageReportView["totals"] {
  return {
    samples,
    strongActive: 0,
    semiActive: 0,
    passiveExposures: 0,
    reads: 0,
    rereads: 0,
    toolCalls: 0,
    toolErrors: 0,
    commands: 0,
    commandFailures: 0,
    ...overrides
  };
}

function diffFixture() {
  return {
    available: true,
    changes: [{ key: "SKILL.md", kind: "modified" as const, binary: false, unifiedDiff: "--- SKILL.md\n+++ SKILL.md\n-# Original Skill\n+# Changed Skill" }],
    truncated: false
  };
}

function draftFixture(sessionId: string, kind: "edit" | "rename", value: string): SkillDraftView {
  return {
    id: `skill-draft-${kind}`,
    sessionId,
    skillId: "resource-global",
    kind,
    name: kind === "rename" ? value : "Review helper",
    resourceRevision: 1n,
    observedRevision: "sha256:observed",
    changes: kind === "edit" ? diffFixture().changes : [{ key: "SKILL.md", kind: "modified", binary: false, unifiedDiff: `-name: Review helper\n+name: ${value}` }],
    expiresAt: 1_800_000_000_000
  };
}

function recoveryFixture(): SkillRecoveryView {
  return {
    id: "skill-recovery-1",
    skillId: "resource-global",
    backendId: "pi",
    scope: "global",
    name: "Review helper",
    revision: "sha256:observed",
    files: 3,
    bytes: 128,
    createdAt: Date.now(),
    status: "ready"
  };
}

const targets: readonly TargetView[] = [{
  id: "target-project",
  name: "Project Alpha",
  pinned: false,
  archived: false,
  backendId: "pi",
  workspaceId: "workspace-project",
  revision: 1n
} as TargetView];

const backends: readonly BackendView[] = [{
  id: "pi",
  name: "Pi Runtime",
  version: "1",
  health: "healthy",
  capabilities: new Map()
}];

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

function marketSourceFixture(): SkillMarketSourceView {
  return {
    id: "skill_market_source_0123456789abcdef0123456789abcdef",
    revision: 4n,
    kind: "local",
    display: "local-publishing",
    name: "local-publishing",
    displayName: "Local publishing",
    state: "ready",
    contentRevision: HASH_A,
    entryCount: 0,
    addedAt: 1_700_000_000_000
  };
}

function publicationPreviewFixture(): SkillPublicationPreviewView {
  return {
    authority: {
      resourceId: "resource-global",
      resourceRevision: 1n,
      observedRevision: HASH_A,
      backendId: "pi",
      scope: "global",
      sourceId: marketSourceFixture().id,
      sourceRevision: 4n,
      sourceContentRevision: HASH_A,
      sourceDisplay: "Local publishing"
    },
    source: marketSourceFixture(),
    mode: "first",
    suggestedSlug: "review-helper",
    suggestedVersion: "1.0.0",
    dirty: false,
    collaborationRevision: 1n,
    personalPublisherAvailable: true,
    teamPublisherAvailable: false,
    publicVisibilityAvailable: true,
    departmentVisibilityAvailable: false,
    privateVisibilityAvailable: true,
    collaborationUnavailableReason: "Team and restricted visibility require a configured collaboration identity owner."
  };
}

function publicationJobFixture(): SkillPublicationJobView {
  return {
    id: "skill_publication_0123456789abcdef0123456789abcdef",
    revision: 7n,
    state: "published",
    authority: publicationPreviewFixture().authority,
    metadata: {
      slug: "review-helper",
      name: "Review helper",
      description: "Review safely",
      tags: [],
      version: "1.0.0"
    },
    publisher: "personal",
    visibility: "public",
    audienceScopeIds: [],
    accessRevision: 1n,
    gates: (["metadata", "package", "sensitive_content", "source_authority"] as const).map((id) => ({ id, label: id, status: "passed", issues: [] })),
    verdict: "passed",
    files: 1,
    uncompressedBytes: 96,
    archiveBytes: 80,
    attempt: 1,
    result: {
      sourceId: marketSourceFixture().id,
      sourceRevision: 5n,
      entryId: "skill_market_entry_0123456789abcdef0123456789abcdef",
      entryRevision: 1n,
      entryContentRevision: HASH_B,
      version: "1.0.0"
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    completedAt: 1_700_000_000_100,
    cancellable: false
  };
}

function marketEntryFixture(): SkillMarketEntryView {
  const result = publicationJobFixture().result!;
  return {
    identity: {
      sourceId: result.sourceId,
      sourceRevision: result.sourceRevision,
      entryId: result.entryId,
      entryRevision: result.entryRevision,
      contentRevision: result.entryContentRevision
    },
    slug: "review-helper",
    name: "Published Review helper",
    description: "Review safely",
    tags: [],
    version: result.version,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    downloads: 0,
    trendScore: 0,
    archiveBytes: 80,
    sourceName: "local-publishing",
    sourceDisplayName: "Local publishing",
    sourceState: "ready",
    installStatuses: [],
    access: { revision: 1n, publisher: { kind: "personal", actorId: "collaboration_actor_test" }, visibility: "public", audienceScopeIds: [] },
    canManage: true
  };
}

async function renderSkills(controller: AppController): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SkillTools controller={controller} backends={backends} targets={targets} locale="en" t={(key, values) => translate("en", key, values)} />));
  return container;
}

async function settle(milliseconds = 10): Promise<void> {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, milliseconds)); });
}

function buttonWithText(container: ParentNode, text: string | RegExp): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => typeof text === "string" ? candidate.textContent?.trim() === text : text.test(candidate.textContent?.trim() ?? ""));
  if (button === undefined) throw new Error(`Expected button ${String(text)}.`);
  return button;
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected value.");
  return value;
}
