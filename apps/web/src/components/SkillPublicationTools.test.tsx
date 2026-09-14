// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type {
  SkillMarketEntryView,
  SkillMarketSourceView,
  SkillPublicationJobView,
  SkillPublicationMetadataView,
  SkillPublicationPreviewView,
  SkillSessionView
} from "../model.js";
import { SkillPublicationDialog } from "./SkillPublicationTools.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("SkillPublicationDialog", () => {
  it("requires the version changelog, renders machine progress, and returns the exact published market identity", async () => {
    let current: SkillPublicationJobView | undefined;
    const preview = publicationPreview("version");
    const startSkillPublication = vi.fn(async (_reviewed: SkillPublicationPreviewView, metadata: SkillPublicationMetadataView) => {
      current = publicationJob("scanning", metadata);
    });
    const getSkillPublicationJob = vi.fn(async () => {
      current = publicationJob("published", required(current).metadata, required(current).id, 6n);
      return current;
    });
    const controller = publicationController({
      getSkillPublicationPreview: vi.fn(async () => preview),
      startSkillPublication,
      getSkillPublicationJob,
      listSkillPublicationJobs: vi.fn(async () => ({ items: current === undefined ? [] : [current], recoveredFromCorruption: false }))
    });
    const onPublished = vi.fn();
    const onOpenPublished = vi.fn();
    const dialog = await renderPublication(controller, onPublished, onOpenPublished);
    await settle();

    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(dialog.textContent).not.toContain("D:\\private\\market");

    await act(async () => buttonWithText(dialog, "Review publication target").click());
    await settle();
    expect(dialog.textContent).toContain("New version");
    expect(dialog.textContent).toContain("Team");
    expect(dialog.textContent).toContain("Private");
    expect([...dialog.querySelectorAll<HTMLInputElement>('input[type="radio"]')].filter((input) => input.disabled)).toHaveLength(3);
    const publish = buttonWithText(dialog, "Publish new version");
    expect(publish.disabled).toBe(true);

    await act(async () => setInputValue(fieldByLabel(dialog, "Changelog · required"), "Describe the exact version delta."));
    expect(publish.disabled).toBe(false);
    await act(async () => publish.click());
    await settle();

    expect(startSkillPublication).toHaveBeenCalledWith(preview, expect.objectContaining({
      slug: "review-helper",
      version: "1.4.1",
      category: "Writing",
      tags: ["review"],
      changelog: "Describe the exact version delta."
    }), { publisher: "personal", visibility: "public", audienceScopeIds: [] });
    expect(dialog.textContent).toContain("Scanning");
    expect(dialog.textContent).toContain("Waiting");

    await settle(340);
    expect(getSkillPublicationJob).toHaveBeenCalledWith(required(current).id, expect.any(AbortSignal));
    expect(dialog.textContent).toContain("Version 1.4.1 is published");
    expect(onPublished).toHaveBeenCalledTimes(1);
    await act(async () => buttonWithText(dialog, "Open in Skill market").click());
    expect(onOpenPublished).toHaveBeenCalledWith(required(current).result);
  });

  it("polls a hidden active job, blocks a parallel publication, then exposes cancel and retry", async () => {
    const historical = publicationJob("published", metadata("1.0.0"), "skill_publication_11111111111111111111111111111111", 8n);
    let active = publicationJob("scanning", metadata("1.1.0"), "skill_publication_22222222222222222222222222222222", 3n);
    const cancelSkillPublication = vi.fn(async (job: SkillPublicationJobView) => {
      expect(job.id).toBe(active.id);
      active = publicationJob("cancelled", active.metadata, active.id, job.revision + 1n);
    });
    const retrySkillPublication = vi.fn(async (job: SkillPublicationJobView) => {
      expect(job.state).toBe("cancelled");
      active = publicationJob("pending", active.metadata, "skill_publication_33333333333333333333333333333333", 1n);
    });
    const getSkillPublicationJob = vi.fn(async () => active);
    const controller = publicationController({
      listSkillPublicationJobs: vi.fn(async () => ({ items: [active, historical], recoveredFromCorruption: false })),
      getSkillPublicationJob,
      cancelSkillPublication,
      retrySkillPublication
    });
    const dialog = await renderPublication(controller, vi.fn(), vi.fn());
    await settle();
    await act(async () => buttonWithText(dialog, "Review publication target").click());
    await settle();

    expect(buttonWithText(dialog, "Publish Skill").disabled).toBe(true);
    await settle(300);
    expect(getSkillPublicationJob).toHaveBeenCalledWith(active.id, expect.any(AbortSignal));

    await act(async () => buttonWithText(dialog, /v1\.1\.0/u).click());
    await act(async () => buttonWithText(dialog, "Cancel").click());
    await settle();
    expect(cancelSkillPublication).toHaveBeenCalledTimes(1);
    expect(dialog.textContent).toContain("Cancelled");
    await act(async () => buttonWithText(dialog, "Retry").click());
    await settle();
    expect(retrySkillPublication).toHaveBeenCalledTimes(1);
    expect(dialog.textContent).toContain("Pending");
  });

  it("publishes through an exact team and department selection", async () => {
    const preview: SkillPublicationPreviewView = {
      ...publicationPreview("first"),
      collaborationRevision: 4n,
      teamPublisherAvailable: true,
      departmentVisibilityAvailable: true,
      collaborationUnavailableReason: undefined
    };
    const startSkillPublication = vi.fn(async () => undefined);
    const controller = publicationController({
      getSkillPublicationPreview: vi.fn(async () => preview),
      getCollaborationDirectory: vi.fn(async () => ({
        available: true,
        revision: 4n,
        actor: { id: "collaboration_actor_test", displayName: "Local owner" },
        scopes: [{
          id: "collaboration_scope_team",
          revision: 1n,
          kind: "team" as const,
          name: "Platform",
          members: [{ actorId: "collaboration_actor_test", role: "administrator" as const }]
        }, {
          id: "collaboration_scope_department",
          revision: 1n,
          kind: "department" as const,
          name: "Engineering",
          members: [{ actorId: "collaboration_actor_test", role: "administrator" as const }]
        }],
        recoveredFromCorruption: false
      })),
      startSkillPublication
    });
    const dialog = await renderPublication(controller, vi.fn(), vi.fn());
    await settle();
    await act(async () => buttonWithText(dialog, "Review publication target").click());
    await settle();
    const radio = (label: string): HTMLInputElement => required([...dialog.querySelectorAll<HTMLLabelElement>("label")]
      .find((candidate) => candidate.textContent?.trim() === label)?.querySelector<HTMLInputElement>('input[type="radio"]'));
    await act(async () => radio("Team").click());
    await act(async () => radio("Department").click());
    expect(required(dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')).checked).toBe(true);
    await act(async () => buttonWithText(dialog, "Publish Skill").click());
    await settle();
    expect(startSkillPublication).toHaveBeenCalledWith(
      preview,
      expect.objectContaining({ slug: "review-helper", version: "1.0.0" }),
      {
        publisher: "team",
        publisherScopeId: "collaboration_scope_team",
        visibility: "department",
        audienceScopeIds: ["collaboration_scope_department"]
      }
    );
  });
});

function publicationController(overrides: Partial<AppController> = {}): AppController {
  return {
    listSkillMarketSources: vi.fn(async () => ({ revision: 4n, sources: [source()], recoveredFromCorruption: false })),
    listSkillPublicationJobs: vi.fn(async () => ({ items: [], recoveredFromCorruption: false })),
    getSkillPublicationPreview: vi.fn(async () => publicationPreview("first")),
    getCollaborationDirectory: vi.fn(async () => collaborationDirectory()),
    getSkillPublicationJob: vi.fn(async () => publicationJob("published", metadata("1.0.0"))),
    startSkillPublication: vi.fn(async () => undefined),
    cancelSkillPublication: vi.fn(async () => undefined),
    retrySkillPublication: vi.fn(async () => undefined),
    ...overrides
  } as unknown as AppController;
}

function collaborationDirectory() {
  return {
    available: true as const,
    revision: 1n,
    actor: { id: "collaboration_actor_test", displayName: "Local owner" },
    scopes: [],
    recoveredFromCorruption: false
  };
}

function publicationPreview(mode: "first" | "version"): SkillPublicationPreviewView {
  const existingEntry = mode === "version" ? entry() : undefined;
  return {
    authority: {
      resourceId: "resource-skill",
      resourceRevision: 7n,
      observedRevision: HASH_A,
      backendId: "pi",
      scope: "global",
      sourceId: source().id,
      sourceRevision: source().revision,
      sourceContentRevision: source().contentRevision,
      sourceDisplay: "Local publishing",
      ...(existingEntry === undefined ? {} : { existingEntryId: existingEntry.identity.entryId })
    },
    source: source(),
    mode,
    suggestedSlug: "review-helper",
    suggestedVersion: mode === "version" ? "1.4.1" : "1.0.0",
    ...(existingEntry === undefined ? {} : { existingEntry }),
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

function source(): SkillMarketSourceView {
  return {
    id: "skill_market_source_0123456789abcdef0123456789abcdef",
    revision: 4n,
    kind: "local",
    display: "local-market",
    name: "local-publishing",
    displayName: "Local publishing",
    state: "ready",
    contentRevision: HASH_B,
    entryCount: 1,
    addedAt: 1_700_000_000_000,
    refreshedAt: 1_700_000_001_000
  };
}

function entry(): SkillMarketEntryView {
  return {
    identity: {
      sourceId: source().id,
      sourceRevision: source().revision,
      entryId: "skill_market_entry_0123456789abcdef0123456789abcdef",
      entryRevision: 3n,
      contentRevision: HASH_A
    },
    slug: "review-helper",
    name: "Review helper",
    author: "Joko",
    description: "Review safely",
    category: "Writing",
    tags: ["review"],
    version: "1.4.0",
    changelog: "Prior release",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    downloads: 0,
    trendScore: 0,
    archiveBytes: 128,
    sourceName: "local-publishing",
    sourceDisplayName: "Local publishing",
    sourceState: "ready",
    installStatuses: [],
    access: { revision: 1n, publisher: { kind: "personal", actorId: "collaboration_actor_test" }, visibility: "public", audienceScopeIds: [] },
    canManage: true
  };
}

function metadata(version: string): SkillPublicationMetadataView {
  return {
    slug: "review-helper",
    name: "Review helper",
    description: "Review safely",
    tags: [],
    version,
    ...(version === "1.0.0" ? {} : { changelog: "Changed." })
  };
}

function publicationJob(
  state: SkillPublicationJobView["state"],
  value: SkillPublicationMetadataView,
  id = "skill_publication_0123456789abcdef0123456789abcdef",
  revision = 2n
): SkillPublicationJobView {
  const terminal = state === "published" || state === "blocked" || state === "failed" || state === "cancelled";
  const passed = state === "published";
  return {
    id,
    revision,
    state,
    authority: publicationPreview(value.version === "1.0.0" ? "first" : "version").authority,
    metadata: value,
    publisher: "personal",
    visibility: "public",
    audienceScopeIds: [],
    accessRevision: 1n,
    gates: (["metadata", "package", "sensitive_content", "source_authority"] as const).map((gateId) => ({
      id: gateId,
      label: gateId,
      status: passed ? "passed" : "pending",
      issues: []
    })),
    verdict: passed ? "passed" : "pending",
    files: 2,
    uncompressedBytes: 128,
    archiveBytes: 96,
    attempt: 1,
    ...(state === "published" ? {
      result: {
        sourceId: source().id,
        sourceRevision: 5n,
        entryId: entry().identity.entryId,
        entryRevision: 4n,
        entryContentRevision: HASH_B,
        version: value.version
      }
    } : {}),
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100 + Number(revision),
    ...(terminal ? { completedAt: 1_700_000_000_200 + Number(revision) } : {}),
    ...(state === "cancelled" ? { error: "Skill publication was cancelled before the final manifest switch." } : {}),
    cancellable: !terminal && state !== "reconciling"
  };
}

function session(): SkillSessionView {
  return {
    id: "skill-session",
    skill: {
      id: "resource-skill",
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
      revision: 7n,
      approvedRevision: HASH_A,
      updatedAt: 1_700_000_000_000
    },
    observedRevision: HASH_A,
    dirty: false,
    baselineAvailable: true,
    metadata: { name: "Review helper", description: "Review safely", version: "1.4.0", frontmatter: {} },
    files: [{ key: "SKILL.md", name: "SKILL.md", kind: "file", size: 96, editable: true }],
    fileCount: 1,
    bytes: 96,
    diff: { available: true, changes: [], truncated: false },
    expiresAt: 1_800_000_000_000
  };
}

async function renderPublication(
  controller: AppController,
  onPublished: () => void,
  onOpenPublished: (result: NonNullable<SkillPublicationJobView["result"]>) => void
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SkillPublicationDialog
    controller={controller}
    session={session()}
    locale="en"
    t={(key, values) => translate("en", key, values)}
    onClose={() => undefined}
    onPublished={onPublished}
    onOpenPublished={onOpenPublished}
  />));
  return required(container.querySelector<HTMLElement>('[role="dialog"]'));
}

async function settle(milliseconds = 15): Promise<void> {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, milliseconds)); });
}

function buttonWithText(container: ParentNode, text: string | RegExp): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => typeof text === "string" ? candidate.textContent?.trim() === text : text.test(candidate.textContent?.trim() ?? ""));
  if (button === undefined) throw new Error(`Expected button ${String(text)}.`);
  return button;
}

function fieldByLabel(container: ParentNode, text: string): HTMLInputElement | HTMLTextAreaElement {
  const label = [...container.querySelectorAll<HTMLLabelElement>("label")]
    .find((candidate) => candidate.querySelector("span")?.textContent?.trim() === text);
  return required(label?.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea"));
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected value.");
  return value;
}
