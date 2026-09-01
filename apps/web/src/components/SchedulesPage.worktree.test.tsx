// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { emptySnapshot, type BackendView, type TargetView, type WorkspaceView } from "../model.js";
import { SchedulesPage } from "./SchedulesPage.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Schedule editor isolated workspace controls", () => {
  it("probes independently from enabled state and submits the selected source and refresh behavior", async () => {
    const saveSchedule = vi.fn(async () => undefined);
    const probeTargetWorktree = vi.fn(async () => ({
      targetId: "target-one",
      eligibility: "eligible" as const,
      repositoryRoot: "D:\\workspace",
      currentBranch: "main",
      headCommit: "a".repeat(40),
      canRefreshRemote: true
    }));
    const listTargetWorktreeSources = vi.fn(async () => [{
      ref: "refs/heads/main",
      commit: "a".repeat(40),
      name: "main",
      remote: false,
      current: true
    }, {
      ref: "refs/heads/release",
      commit: "b".repeat(40),
      name: "release",
      remote: false,
      current: false
    }]);
    const snapshot = {
      ...emptySnapshot(),
      workspaces: [workspace]
    };
    const controller = {
      state: { snapshot, preferences: { navigationOpen: true } },
      getSchedulerRuntime: async () => ({
        instanceId: "scheduler-test",
        inFlight: 0,
        slotsInUse: 0,
        maxConcurrentRuns: 8,
        runs: [],
        waiting: []
      }),
      probeTargetWorktree,
      listTargetWorktreeSources,
      saveSchedule
    } as unknown as AppController;
    const container = await render(controller);

    await act(async () => findButton(container, "New schedule").click());
    await act(async () => Promise.resolve());
    expect(probeTargetWorktree).toHaveBeenCalledWith("target-one", expect.any(AbortSignal));
    expect(listTargetWorktreeSources).toHaveBeenCalledWith("target-one", expect.any(AbortSignal));

    const isolation = container.querySelector<HTMLElement>('.new-task-worktree[aria-label="Isolated worktree"]')!;
    const enable = isolation.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(enable.disabled).toBe(false);
    await act(async () => enable.click());

    const source = isolation.querySelector<HTMLSelectElement>("select")!;
    await act(async () => setValue(source, "refs/heads/release", "change"));
    const refresh = isolation.querySelector<HTMLInputElement>(".new-task-worktree__refresh input")!;
    await act(async () => refresh.click());
    await act(async () => setValue(findInputByLabel(container, "Name"), "Release review", "input"));
    await act(async () => setValue(container.querySelector<HTMLTextAreaElement>("textarea")!, "Inspect the release branch", "input"));

    const submit = container.querySelector<HTMLButtonElement>('form button[type="submit"]')!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await act(async () => Promise.resolve());

    expect(saveSchedule).toHaveBeenCalledWith(undefined, expect.objectContaining({
      enabled: true,
      sessionMode: "fresh",
      executionMode: "agent",
      useWorktree: true,
      worktreeSourceRef: "refs/heads/release",
      refreshWorktreeRemote: true
    }));

    await act(async () => findButton(container, "New schedule").click());
    await act(async () => Promise.resolve());
    await act(async () => setValue(findSelectByLabel(container, "Use a template"), "nightly-test-repair", "change"));
    await act(async () => findButton(container, "Use a template").click());
    expect(findInputByLabel(container, "Name").value).toBe("Nightly test self-healing");
    expect(container.querySelector<HTMLInputElement>('.new-task-worktree input[type="checkbox"]')?.checked).toBe(true);
  });
});

const target: TargetView = {
  id: "target-one",
  backendId: "backend-one",
  name: "Project",
  workspaceId: "workspace-one",
  workspaceName: "Project",
  trusted: true,
  pinned: false,
  archived: false
};

const workspace: WorkspaceView = {
  id: "workspace-one",
  targetId: "target-one",
  name: "Project",
  kind: "userProject",
  serverPath: "D:\\workspace",
  trusted: true,
  dirty: false,
  entries: []
};

const backend: BackendView = {
  id: "backend-one",
  name: "Backend",
  version: "1",
  health: "healthy",
  capabilities: new Map([["input.text", {
    name: "Text input",
    supported: true,
    options: []
  }]])
};

async function render(controller: AppController): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SchedulesPage
    controller={controller}
    schedules={[]}
    sessions={[]}
    targets={[target]}
    models={[]}
    backends={[backend]}
    extraDirectories={[]}
    locale="en"
    t={(key, values) => translate("en", key, values)}
    runAction={(_key, action) => { void action(); }}
    onOpenNavigation={() => undefined}
  />));
  return container;
}

function findButton(container: ParentNode, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.includes(text));
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  return button;
}

function findInputByLabel(container: ParentNode, text: string): HTMLInputElement {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent?.trim().startsWith(text));
  const input = label?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`Input not found: ${text}`);
  return input;
}

function findSelectByLabel(container: ParentNode, text: string): HTMLSelectElement {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent?.trim().startsWith(text));
  const select = label?.querySelector("select");
  if (!(select instanceof HTMLSelectElement)) throw new Error(`Select not found: ${text}`);
  return select;
}

function setValue(control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, event: "input" | "change"): void {
  const prototype = control instanceof HTMLSelectElement
    ? HTMLSelectElement.prototype
    : control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event(event, { bubbles: true }));
}
