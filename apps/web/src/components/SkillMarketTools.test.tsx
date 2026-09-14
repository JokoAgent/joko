// @vitest-environment jsdom

import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type {
  BackendView,
  SkillDescriptorView,
  SkillMarketCatalogPageView,
  SkillMarketEntryView,
  SkillMarketInstallPlanView,
  SkillMarketPreviewView,
  SkillMarketSourceCatalogView,
  SkillMarketSyncJobView,
  SkillMarketSyncPolicyView,
  TargetView
} from "../model.js";
import { SkillMarketCatalogTools, SkillMarketSourcesTools } from "./SkillMarketTools.js";

const roots: Root[] = [];
const HASH = `sha256:${"a".repeat(64)}`;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  vi.restoreAllMocks();
});

describe("Skill market sources", () => {
  it("covers load failure, retry, write-only add, refresh, and confirmed removal", async () => {
    let populated = false;
    let rejectFirst!: (cause: Error) => void;
    const firstLoad = new Promise<SkillMarketSourceCatalogView>((_resolve, reject) => { rejectFirst = reject; });
    const listSkillMarketSources = vi.fn()
      .mockReturnValueOnce(firstLoad)
      .mockImplementation(async () => sourceCatalog(populated));
    const addSkillMarketSource = vi.fn(async () => { populated = true; });
    const refreshSkillMarketSource = vi.fn(async () => undefined);
    const removeSkillMarketSource = vi.fn(async () => { populated = false; });
    const controller = {
      listSkillMarketSources,
      getSkillMarketGitPreflight: vi.fn(async () => ({ available: true, version: "2.50.0", minimumVersion: "2.25.0" })),
      addSkillMarketSource,
      refreshSkillMarketSource,
      removeSkillMarketSource
    } as unknown as AppController;
    const container = await render(<SkillMarketSourcesTools controller={controller} locale="en" t={t} onOpenMarket={vi.fn()} />);

    expect(container.textContent).toContain("Loading Skill sources");
    await act(async () => rejectFirst(new Error("Sources unavailable.")));
    await settle();
    expect(container.textContent).toContain("Sources unavailable.");
    await act(async () => buttonWithText(container, "Retry").click());
    await settle();
    expect(container.textContent).toContain("No Skill sources");

    const path = required(container.querySelector<HTMLInputElement>(".skill-market-source-editor input"));
    await act(async () => setInputValue(path, "D:\\private\\market"));
    await act(async () => buttonWithText(container, "Add and inspect source").click());
    await settle();
    expect(addSkillMarketSource).toHaveBeenCalledWith({ kind: "local", serverPath: "D:\\private\\market" }, 9n, expect.any(AbortSignal));
    expect(container.textContent).toContain("Team Skills");
    expect(container.textContent).toContain("1 catalog entries");
    expect(container.textContent).not.toContain("D:\\private\\market");

    await act(async () => buttonWithText(container, "Refresh").click());
    await settle();
    expect(refreshSkillMarketSource).toHaveBeenCalledWith(source().id, 2n, expect.any(AbortSignal));

    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Remove Team Skills"]')).click());
    const dialog = required(document.body.querySelector<HTMLElement>('[role="alertdialog"]'));
    expect(dialog.textContent).toContain("Installed Skills remain independently managed");
    await act(async () => buttonWithText(dialog, "Remove").click());
    await settle();
    expect(removeSkillMarketSource).toHaveBeenCalledWith(source().id, 2n, expect.any(AbortSignal));
    expect(container.textContent).toContain("No Skill sources");
  });
});

describe("Skill market catalog", () => {
  it("hydrates the install picker when Backend capabilities arrive after the dialog mounts", async () => {
    const controller = marketController();
    let publishBackends = (): void => undefined;
    function Harness(): ReactElement {
      const [availableBackends, setAvailableBackends] = useState<readonly BackendView[]>([]);
      publishBackends = () => setAvailableBackends(backends);
      return <SkillMarketCatalogTools controller={controller} backends={availableBackends} targets={targets} locale="en" t={t} onOpenSources={vi.fn()} />;
    }
    const container = await render(<Harness />);
    await settle(120);
    await act(async () => buttonWithText(container, /Review helper/u).click());
    await settle();
    await act(async () => buttonWithText(container, "Choose install target").click());
    const dialog = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    const review = buttonWithText(dialog, "Review install plan");
    expect(review.disabled).toBe(true);
    await act(async () => publishBackends());
    expect(review.disabled).toBe(false);
  });

  it.each([
    ["not installed", undefined, "Not installed"],
    ["installed", "installed", "Installed"],
    ["update", "updateAvailable", "Update available"],
    ["conflict", "conflict", "Conflict"]
  ] as const)("shows the exact %s placement state on market cards", async (_label, state, copy) => {
    const statusEntry: SkillMarketEntryView = {
      ...entry(),
      installStatuses: state === undefined ? [] : [{
        resourceId: "resource-skill",
        resourceRevision: 7n,
        backendId: "pi",
        scope: "global",
        state,
        installedVersion: "1.0.0"
      }]
    };
    const controller = marketController({
      listSkillMarketCatalog: vi.fn(async () => ({
        revision: 9n,
        entries: [statusEntry],
        categories: ["Productivity"],
        sourceCount: 1,
        totalSize: 1
      }))
    });
    const container = await render(<SkillMarketCatalogTools controller={controller} backends={backends} targets={targets} locale="en" t={t} onOpenSources={vi.fn()} />);
    await settle(120);
    expect(container.textContent).toContain(copy);
  });

  it("revision-pages, previews, installs with confirmation, and drives the complete sync lifecycle", async () => {
    let policyEnabled: boolean | undefined;
    let jobState: SkillMarketSyncJobView["state"] | undefined;
    const listSkillMarketCatalog = vi.fn(async (options: Parameters<AppController["listSkillMarketCatalog"]>[0]) => catalogPage(options?.pageToken));
    const enableSkillMarketSync = vi.fn(async () => { policyEnabled = true; });
    const disableSkillMarketSync = vi.fn(async () => { policyEnabled = false; });
    const enqueueSkillMarketSync = vi.fn(async () => { jobState = "running"; });
    const cancelSkillMarketSync = vi.fn(async () => { jobState = "cancelled"; });
    const retrySkillMarketSync = vi.fn(async () => { jobState = "running"; });
    const installSkillMarketPlan = vi.fn(async () => ({ skill: installedSkill() }));
    const controller = marketController({
      listSkillMarketCatalog,
      installSkillMarketPlan,
      listSkillMarketSyncPolicies: vi.fn(async () => ({ items: policyEnabled === undefined ? [] : [syncPolicy(policyEnabled)], recoveredFromCorruption: false })),
      listSkillMarketSyncJobs: vi.fn(async () => ({ items: jobState === undefined ? [] : [syncJob(jobState)], recoveredFromCorruption: false })),
      enableSkillMarketSync,
      disableSkillMarketSync,
      enqueueSkillMarketSync,
      cancelSkillMarketSync,
      retrySkillMarketSync
    });
    const container = await render(<SkillMarketCatalogTools controller={controller} backends={backends} targets={targets} locale="en" t={t} onOpenSources={vi.fn()} />);
    await settle(120);

    expect(container.textContent).toContain("Review helper");
    await act(async () => buttonWithText(container, "Next").click());
    await settle(120);
    expect(listSkillMarketCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ expectedRevision: 9n, pageToken: "page-2" }));
    await act(async () => buttonWithText(container, "Previous").click());
    await settle(120);

    await act(async () => buttonWithText(container, /Review helper/u).click());
    await settle();
    expect(controller.getSkillMarketEntry).toHaveBeenCalledWith(entry().identity, expect.any(AbortSignal));
    expect(controller.openSkillMarketPreview).toHaveBeenCalledWith(entry().identity, expect.any(AbortSignal));
    expect(container.textContent).toContain("# Review safely");

    await act(async () => buttonWithText(container, "Choose install target").click());
    const dialog = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    await act(async () => buttonWithText(dialog, "Review install plan").click());
    await settle();
    expect(controller.createSkillMarketInstallPlan).toHaveBeenCalledWith(entry().identity, { backendId: "pi", scope: "global" }, expect.any(AbortSignal));
    expect(dialog.textContent).toContain("Installed content has local changes");
    const replace = buttonWithText(dialog, "Replace");
    expect(replace.disabled).toBe(true);
    await act(async () => required(dialog.querySelector<HTMLButtonElement>('[role="checkbox"]')).click());
    expect(replace.disabled).toBe(false);
    await act(async () => replace.click());
    await settle();
    expect(installSkillMarketPlan).toHaveBeenCalledWith(expect.objectContaining({
      id: installPlan().id,
      preview: expect.objectContaining({ candidateRevision: HASH, action: "replace" })
    }), true);
    expect(dialog.textContent).toContain("was installed and its runtime was refreshed");

    await act(async () => buttonWithText(dialog, "Enable automatic updates").click());
    await settle();
    expect(enableSkillMarketSync).toHaveBeenCalledWith("resource-skill", 8n, { backendId: "pi", scope: "global" });
    await act(async () => buttonWithText(dialog, "Check now").click());
    await settle();
    expect(enqueueSkillMarketSync).toHaveBeenCalledWith(expect.objectContaining({ resourceId: "resource-skill", enabled: true }));
    await act(async () => buttonWithText(dialog, "Cancel").click());
    await settle();
    expect(cancelSkillMarketSync).toHaveBeenCalledWith(expect.objectContaining({ state: "running" }));
    await act(async () => buttonWithText(dialog, "Retry").click());
    await settle();
    expect(retrySkillMarketSync).toHaveBeenCalledWith(expect.objectContaining({ state: "cancelled" }));
    await act(async () => buttonWithText(dialog, "Disable").click());
    await settle();
    expect(disableSkillMarketSync).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(dialog.textContent).toContain("Automatic updates disabled");
  });

  it("keeps the install mutation live across an authoritative controller snapshot update", async () => {
    let resolvePolicies!: (value: { readonly items: readonly SkillMarketSyncPolicyView[]; readonly recoveredFromCorruption: false }) => void;
    const pendingPolicies = new Promise<{ readonly items: readonly SkillMarketSyncPolicyView[]; readonly recoveredFromCorruption: false }>((resolve) => {
      resolvePolicies = resolve;
    });
    const initialController = marketController({
      installSkillMarketPlan: vi.fn(async () => ({ skill: installedSkill() })),
      listSkillMarketSyncPolicies: vi.fn(() => pendingPolicies)
    });
    let publishSnapshot = (): void => undefined;
    function Harness(): ReactElement {
      const [controller, setController] = useState(initialController);
      publishSnapshot = () => setController({ ...initialController });
      return <SkillMarketCatalogTools controller={controller} backends={backends} targets={targets} locale="en" t={t} onOpenSources={vi.fn()} />;
    }
    const container = await render(<Harness />);
    await settle(120);
    await act(async () => buttonWithText(container, /Review helper/u).click());
    await settle();
    await act(async () => buttonWithText(container, "Choose install target").click());
    const dialog = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    await act(async () => buttonWithText(dialog, "Review install plan").click());
    await settle();
    await act(async () => required(dialog.querySelector<HTMLButtonElement>('[role="checkbox"]')).click());
    await act(async () => buttonWithText(dialog, "Replace").click());
    await settle();
    expect(dialog.textContent).toContain("was installed and its runtime was refreshed");
    expect(buttonWithText(dialog, "Enable automatic updates").disabled).toBe(true);

    await act(async () => publishSnapshot());
    await act(async () => resolvePolicies({ items: [], recoveredFromCorruption: false }));
    await settle();

    expect(buttonWithText(dialog, "Enable automatic updates").disabled).toBe(false);
  });

  it("uninstalls through the exact Local Skill session and restores narrow-screen focus", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const deleteSkill = vi.fn(async () => ({ recoveryId: "recovery" }));
    const controller = marketController({ deleteSkill });
    const container = await render(<SkillMarketCatalogTools controller={controller} backends={backends} targets={targets} locale="en" t={t} onOpenSources={vi.fn()} />);
    await settle(120);
    const card = buttonWithText(container, /Review helper/u);
    await act(async () => card.click());
    await settle();
    expect(document.activeElement?.tagName).toBe("H2");
    await act(async () => buttonWithText(container, "Back").click());
    await settle();
    expect(document.activeElement).toBe(card);
    await act(async () => card.click());
    await settle();
    expect(document.activeElement?.tagName).toBe("H2");
    await act(async () => buttonWithText(container, "Choose install target").click());
    const dialog = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    await act(async () => buttonWithText(dialog, "Review install plan").click());
    await settle();
    const confirmation = required([...dialog.querySelectorAll<HTMLInputElement>("input")].find((input) => input.value === "" && input.type === "text"));
    await act(async () => setInputValue(confirmation, "Review helper"));
    await act(async () => buttonWithText(dialog, "Uninstall").click());
    await settle();
    expect(controller.listSkills).toHaveBeenCalledWith({ backendId: "pi", scope: "global" });
    expect(controller.openSkill).toHaveBeenCalledWith("resource-skill", 7n);
    expect(deleteSkill).toHaveBeenCalledWith(expect.objectContaining({ skill: expect.objectContaining({ id: "resource-skill" }) }), "Review helper");
    expect(controller.closeSkill).toHaveBeenCalledWith("skill-session");
    expect(controller.closeSkillMarketInstallPlan).toHaveBeenCalledWith(installPlan().id);
  });

  it("shows access provenance and submits a fenced visibility change only for a manageable entry", async () => {
    const managed: SkillMarketEntryView = {
      ...entry(),
      access: { revision: 3n, publisher: { kind: "personal", actorId: "collaboration_actor_test" }, visibility: "public", audienceScopeIds: [] },
      canManage: true
    };
    const updateSkillMarketAccess = vi.fn(async () => undefined);
    const controller = marketController({
      listSkillMarketCatalog: vi.fn(async () => ({ revision: 9n, entries: [managed], categories: [], sourceCount: 1, totalSize: 1 })),
      getSkillMarketEntry: vi.fn(async () => managed),
      getCollaborationDirectory: vi.fn(async () => ({
        available: true,
        revision: 7n,
        actor: { id: "collaboration_actor_test", displayName: "Local owner" },
        scopes: [],
        recoveredFromCorruption: false
      })),
      updateSkillMarketAccess
    });
    const container = await render(<SkillMarketCatalogTools controller={controller} backends={backends} targets={targets} locale="en" t={t} onOpenSources={vi.fn()} />);
    await settle(120);
    await act(async () => buttonWithText(container, /Review helper/u).click());
    await settle();
    expect(container.textContent).toContain("Personal publisher · Public visibility");
    await act(async () => buttonWithText(container, "Manage visibility").click());
    await settle();
    const dialog = required(document.body.querySelector<HTMLElement>('[role="dialog"]'));
    const privateInput = required([...dialog.querySelectorAll<HTMLLabelElement>("label")]
      .find((label) => label.textContent?.includes("Private"))?.querySelector<HTMLInputElement>('input[type="radio"]'));
    await act(async () => privateInput.click());
    await act(async () => buttonWithText(dialog, "Save").click());
    await settle();
    expect(updateSkillMarketAccess).toHaveBeenCalledWith(
      managed,
      7n,
      { publisher: "personal", visibility: "private", audienceScopeIds: [] }
    );
  });
});

function marketController(overrides: Partial<AppController> = {}): AppController {
  return {
    listSkillMarketCatalog: vi.fn(async (options) => catalogPage(options?.pageToken)),
    getSkillMarketEntry: vi.fn(async () => entry()),
    openSkillMarketPreview: vi.fn(async () => preview()),
    listSkillMarketPreviewFiles: vi.fn(async () => ({ snapshotRevision: HASH, files: [{ key: "SKILL.md", kind: "file", size: 96 }], totalSize: 1 })),
    readSkillMarketPreviewFile: vi.fn(async () => ({ previewId: preview().id, snapshotRevision: HASH, key: "SKILL.md", size: 96, previewable: true, content: "# Review safely" })),
    closeSkillMarketPreview: vi.fn(async () => true),
    createSkillMarketInstallPlan: vi.fn(async () => installPlan()),
    closeSkillMarketInstallPlan: vi.fn(async () => true),
    installSkillMarketPlan: vi.fn(async () => ({ skill: installedSkill() })),
    listSkillMarketSyncPolicies: vi.fn(async () => ({ items: [], recoveredFromCorruption: false })),
    listSkillMarketSyncJobs: vi.fn(async () => ({ items: [], recoveredFromCorruption: false })),
    listSkills: vi.fn(async () => ({ revision: 7n, skills: [installedSkill(7n)] })),
    openSkill: vi.fn(async () => ({
      id: "skill-session", skill: installedSkill(7n), observedRevision: HASH, dirty: false, baselineAvailable: true,
      metadata: { frontmatter: {} }, files: [], fileCount: 1, bytes: 96, diff: { available: true, changes: [], truncated: false }, expiresAt: Date.now() + 60_000
    })),
    deleteSkill: vi.fn(async () => ({ recoveryId: "recovery" })),
    closeSkill: vi.fn(async () => true),
    ...overrides
  } as unknown as AppController;
}

function sourceCatalog(populated: boolean): SkillMarketSourceCatalogView {
  return { revision: 9n, sources: populated ? [source()] : [], recoveredFromCorruption: false };
}

function source() {
  return {
    id: "skill_market_source_0123456789abcdef0123456789abcdef", revision: 2n, kind: "local" as const,
    display: "team-skills", name: "team-skills", displayName: "Team Skills", state: "ready" as const,
    contentRevision: HASH, entryCount: 1, addedAt: Date.now() - 60_000, refreshedAt: Date.now()
  };
}

function entry(): SkillMarketEntryView {
  return {
    identity: { sourceId: source().id, sourceRevision: 2n, entryId: "skill_market_entry_0123456789abcdef0123456789abcdef", entryRevision: 4n, contentRevision: HASH },
    slug: "review-helper", name: "Review helper", author: "Joko Team", description: "Review a change safely.", category: "Productivity",
    tags: ["review", "safe"], version: "2.0.0", createdAt: Date.now() - 100_000, updatedAt: Date.now() - 50_000,
    downloads: 42, trendScore: 9.5, archiveBytes: 512, sourceName: "team-skills", sourceDisplayName: "Team Skills", sourceState: "ready",
    installStatuses: [],
    access: { revision: 1n, publisher: { kind: "external", sourceId: source().id }, visibility: "public", audienceScopeIds: [] },
    canManage: false
  };
}

function catalogPage(pageToken?: string): SkillMarketCatalogPageView {
  return pageToken === "page-2"
    ? { revision: 9n, entries: [], categories: ["Productivity"], sourceCount: 1, totalSize: 1 }
    : { revision: 9n, entries: [entry()], categories: ["Productivity"], sourceCount: 1, totalSize: 1, nextPageToken: "page-2" };
}

function preview(): SkillMarketPreviewView {
  return { id: "skill_market_preview_0123456789abcdef0123456789abcdef", entry: entry(), snapshotRevision: HASH, files: 1, bytes: 96, expiresAt: Date.now() + 60_000 };
}

function installPlan(): SkillMarketInstallPlanView {
  return {
    id: "skill_market_install_0123456789abcdef0123456789abcdef",
    entry: entry(),
    target: { backendId: "pi", scope: "global" },
    preview: {
      action: "replace", resourceId: "resource-skill", target: { backendId: "pi", scope: "global" }, name: "Review helper",
      availableVersion: "2.0.0", candidateRevision: HASH, files: 1, bytes: 96,
      currentResource: {
        resourceId: "resource-skill", resourceRevision: 7n, name: "Review helper", version: "1.0.0", sourceKind: "skillMarket",
        sourceDisplay: "Team Skills · Review helper", discoveredRevision: HASH, observedRevision: HASH, dirty: true
      },
      unregisteredDestination: false, sourceReplacement: false, preservesEnabled: true, diffAvailable: true,
      changes: [{ key: "SKILL.md", kind: "modified", binary: false, unifiedDiff: "-old\n+new" }], diffTruncated: false
    },
    confirmationReasons: ["dirtyContent"],
    requiresConfirmation: true,
    expiresAt: Date.now() + 60_000
  };
}

function installedSkill(revision = 8n): SkillDescriptorView {
  return {
    id: "resource-skill", backendId: "pi", scope: "global", name: "Review helper", sourceLabel: "review-helper",
    state: "loaded", enabled: true, canToggle: true, contentAvailable: true, canEdit: true, canDelete: true,
    revision, approvedRevision: HASH, updatedAt: Date.now()
  };
}

function syncPolicy(enabled: boolean): SkillMarketSyncPolicyView {
  return {
    resourceId: "resource-skill", revision: 3n, enabled, sourceId: source().id, entryId: entry().identity.entryId,
    target: { backendId: "pi", scope: "global" },
    baseline: { resourceRevision: 8n, resourceContentRevision: HASH, installedContentRevision: HASH, installedVersion: "2.0.0", sourceRevision: 2n, entryRevision: 4n, entryContentRevision: HASH },
    createdAt: Date.now() - 10_000, updatedAt: Date.now()
  };
}

function syncJob(state: SkillMarketSyncJobView["state"]): SkillMarketSyncJobView {
  return {
    id: "skill_sync_0123456789abcdef0123456789abcdef", revision: state === "cancelled" ? 6n : 5n, state,
    policyResourceId: "resource-skill", policyRevision: 3n,
    authority: { sourceId: source().id, entryId: entry().identity.entryId, target: { backendId: "pi", scope: "global" }, baseline: syncPolicy(true).baseline },
    attempt: 1, createdAt: Date.now() - 5_000, updatedAt: Date.now(), ...(state === "cancelled" ? { outcome: "cancelled" as const, completedAt: Date.now() } : {})
  };
}

const backends: readonly BackendView[] = [{
  id: "pi", name: "Pi Runtime", version: "1", health: "healthy",
  capabilities: new Map([["runtime.resources", { name: "runtime.resources", supported: true, options: ["skill"] }]])
}];

const targets: readonly TargetView[] = [{
  id: "target-project", revision: 1n, backendId: "pi", name: "Project Alpha", workspaceId: "workspace",
  workspaceName: "Project Alpha", trusted: true, pinned: false, archived: false
}];

const t = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>): string => translate("en", key, values);

async function render(element: ReactElement): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return container;
}

async function settle(delay = 20): Promise<void> {
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, delay)); });
}

function buttonWithText(container: ParentNode, text: string | RegExp): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => typeof text === "string" ? candidate.textContent?.trim() === text : text.test(candidate.textContent?.trim() ?? ""));
  if (button === undefined) throw new Error(`Expected button ${String(text)}.`);
  return button;
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
