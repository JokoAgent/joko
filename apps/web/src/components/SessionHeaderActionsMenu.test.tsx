// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView, TargetView } from "../model.js";
import type { SessionProjectNavigationPlacement } from "../session-project-navigation.js";
import { SessionHeaderActionsMenu, type SessionHeaderActionsMenuProps } from "./SessionHeaderActionsMenu.js";

const roots: Root[] = [];
const session = {
  id: "task-1",
  name: "Task one",
  projectId: "project-1",
  pinned: false,
  archived: false,
  remoteWorkspace: false
} as unknown as SessionView;
const projectTargets = [
  { id: "project-1", name: "One" },
  { id: "project-2", name: "Two" }
] as unknown as readonly TargetView[];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("SessionHeaderActionsMenu", () => {
  it("renders the Session-owned pull request projection in the task header", async () => {
    const callbacks = callbackProps();
    const container = await renderMenu({
      ...callbacks,
      session: {
        ...session,
        codeHostPullRequests: [{
          key: "code.example/acme/widgets#42",
          host: "code.example",
          repositoryOwner: "acme",
          repositoryName: "widgets",
          number: 42,
          webUrl: "https://code.example/acme/widgets/pull/42",
          projection: {
            state: "open",
            draft: true,
            title: "Open the header chip",
            headBranch: "feature/header-chip",
            unresolvedReviewThreadCount: 100,
            observedAt: 1
          }
        }]
      }
    });
    const summary = container.querySelector<HTMLElement>(".code-host-pull-request-summary");
    expect(summary?.tagName).toBe("BUTTON");
    expect(summary?.getAttribute("data-state")).toBe("draft");
    expect(summary?.getAttribute("aria-label")).toContain("codeHost.openPullRequest");
    expect(summary?.getAttribute("aria-label")).toContain("codeHost.unresolvedReviewThreads");
    expect(summary?.textContent).toContain("#42");
    expect(summary?.textContent).toContain("99+");
    await click(summary as HTMLElement);
    expect(callbacks.onOpenCodeHostPullRequest).toHaveBeenCalledWith("https://code.example/acme/widgets/pull/42");
  });

  it("exposes the complete applicable task action surface", async () => {
    const callbacks = callbackProps();
    const container = await renderMenu(callbacks);

    expect(labels(container)).toEqual(expect.arrayContaining([
      "session.pin",
      "session.rename",
      "session.moveToProject",
      "session.copyTaskLink",
      "session.exportPortable",
      "session.export",
      "session.clone",
      "session.splitRight",
      "session.splitDown",
      "session.openNewWindow",
      "session.archive",
      "session.delete"
    ]));

    await click(button(container, "session.copyTaskLink"));
    await click(button(container, "session.exportPortable"));
    await click(button(container, "session.export"));
    await click(button(container, "session.clone"));
    await click(button(container, "session.splitRight"));
    await click(button(container, "session.splitDown"));
    await click(button(container, "session.openNewWindow"));

    expect(callbacks.onCopyTaskLink).toHaveBeenCalledOnce();
    expect(callbacks.onExportPortableSession).toHaveBeenCalledOnce();
    expect(callbacks.onExportHtml).toHaveBeenCalledOnce();
    expect(callbacks.onClone).toHaveBeenCalledOnce();
    expect(callbacks.onSplitSession).toHaveBeenNthCalledWith(1, "right");
    expect(callbacks.onSplitSession).toHaveBeenNthCalledWith(2, "bottom");
    expect(callbacks.onOpenSessionWindow).toHaveBeenCalledOnce();
  });

  it("moves through the project picker and reports the selected placement", async () => {
    const callbacks = callbackProps();
    const container = await renderMenu(callbacks);

    await click(button(container, "session.moveToProject"));
    expect(labels(container)).toEqual(expect.arrayContaining(["session.moveToProject", "Two", "session.moveToDialogue"]));
    expect(button(container, "One").disabled).toBe(true);

    await click(button(container, "Two"));
    expect(callbacks.onMoveSessionProject).toHaveBeenCalledWith({ kind: "project", projectId: "project-2" });
  });

  it("uses the archived variant and omits actions that cannot apply", async () => {
    const callbacks = callbackProps();
    const container = await renderMenu({ ...callbacks, session: { ...session, archived: true } as SessionView });
    const visibleLabels = labels(container);

    expect(visibleLabels).toContain("session.unarchive");
    expect(visibleLabels).not.toContain("session.pin");
    expect(visibleLabels).not.toContain("session.moveToProject");
    expect(visibleLabels).not.toContain("session.splitRight");
    expect(visibleLabels).not.toContain("session.splitDown");
    expect(visibleLabels).not.toContain("session.openNewWindow");
  });
});

function callbackProps() {
  return {
    session,
    projectTargets,
    t: (key) => key,
    onRename: vi.fn<() => void>(),
    onPin: vi.fn<() => void>(),
    onArchive: vi.fn<() => void>(),
    onDelete: vi.fn<() => void>(),
    onMoveSessionProject: vi.fn<(placement: SessionProjectNavigationPlacement) => void>(),
    onCopyTaskLink: vi.fn<() => void>(),
    onExportPortableSession: vi.fn<() => void>(),
    onExportHtml: vi.fn<() => void>(),
    onClone: vi.fn<() => void>(),
    onSplitSession: vi.fn<(side: "right" | "bottom") => void>(),
    onOpenSessionWindow: vi.fn<() => void>(),
    onOpenCodeHostPullRequest: vi.fn<(url: string) => void>()
  } satisfies SessionHeaderActionsMenuProps;
}

async function renderMenu(props: SessionHeaderActionsMenuProps): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SessionHeaderActionsMenu {...props} />));
  return container;
}

function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
    .map((item) => item.textContent?.trim() ?? "");
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("[role='menuitem']")]
    .find((item) => item.textContent?.trim() === label);
  if (match === undefined) throw new Error(`Missing menu item: ${label}`);
  return match;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
}
