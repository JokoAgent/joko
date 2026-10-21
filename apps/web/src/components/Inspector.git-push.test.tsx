// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { SessionView, WorkspaceDiffView, WorkspaceGitPushResultView, WorkspaceView } from "../model.js";
import { ChangesPanel } from "./Inspector.js";

const roots: Root[] = [];
beforeAll(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  document.body.replaceChildren();
  document.body.className = "";
});

const pushTarget = { remote: "team/upstream", remoteRef: "refs/heads/published/topic", hasUpstream: true };
const diff: WorkspaceDiffView = { files: [], source: "unstaged", truncated: false, repositoryRevision: "repository-1", headRevision: "a".repeat(40), pushTarget };
const session: SessionView = { id: "task", backendId: "backend", targetId: "target", name: "Task", generation: 1n,
  state: "idle", pinned: false, archived: false, fastMode: false, planMode: false, permissionMode: "ask", updatedAt: 1 };
const workspace: WorkspaceView = { id: "workspace", targetId: "target", name: "Project", kind: "userProject", serverPath: "D:/project",
  trusted: true, branch: "feature/local", head: diff.headRevision, dirty: false, entries: [] };

describe("Inspector Git push destinations", () => {
  it("shows the exact upstream and re-reads an untouched automatic destination before pushing", async () => {
    const view = await mount();
    expect(view.inputs().map((input) => input.value)).toEqual(["team/upstream", "refs/heads/published/topic"]);
    view.api.getWorkspaceDiff.mockResolvedValueOnce({ ...diff, pushTarget: { remote: "publish/next", remoteRef: "refs/heads/next-topic", hasUpstream: true } });
    await view.push();
    expect(view.api.pushWorkspaceBranch).toHaveBeenCalledExactlyOnceWith("workspace", {
      remote: "publish/next", remoteRef: "refs/heads/next-topic", expectedRepositoryRevision: "repository-1",
      expectedHeadRevision: "a".repeat(40), confirmForceWithLease: false
    });
  });

  it("keeps an explicit destination and force confirmation bound to the original remote, ref and OID", async () => {
    const view = await mount();
    await view.edit("publish/manual", "refs/heads/manual-topic");
    view.api.pushWorkspaceBranch.mockResolvedValueOnce({ outcome: "needsForce", remote: "publish/manual", remoteRef: "refs/heads/manual-topic",
      remoteOid: "b".repeat(40), ahead: 1, behind: 1, repositoryRevision: "repository-1", headRevision: "a".repeat(40) });
    await view.push();
    expect(view.api.pushWorkspaceBranch).toHaveBeenCalledWith("workspace", expect.objectContaining({ remote: "publish/manual", remoteRef: "refs/heads/manual-topic", confirmForceWithLease: false }));
    await view.edit("different/remote", "refs/heads/different-topic");
    await act(async () => button(document.body, "workspace.reviewPushForceConfirm").click());
    await view.flush();
    expect(view.api.pushWorkspaceBranch).toHaveBeenLastCalledWith("workspace", {
      remote: "publish/manual", remoteRef: "refs/heads/manual-topic", expectedRepositoryRevision: "repository-1",
      expectedHeadRevision: "a".repeat(40), confirmForceWithLease: true, expectedRemoteOid: "b".repeat(40)
    });
    expect(view.inputs().map((input) => input.value)).toEqual(["different/remote", "refs/heads/different-topic"]);
  });

  it("leaves an unavailable automatic target empty and keeps an explicit target after a failed push", async () => {
    const view = await mount({ ...diff, pushTarget: undefined });
    expect(view.inputs().map((input) => input.value)).toEqual(["", ""]);
    expect(button(view.host, "workspace.reviewPush").disabled).toBe(true);
    await view.edit("publish/manual", "refs/heads/manual-topic");
    view.api.pushWorkspaceBranch.mockRejectedValueOnce(new Error("push unavailable"));
    await view.push();
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain("push unavailable");
    expect(view.inputs().map((input) => input.value)).toEqual(["publish/manual", "refs/heads/manual-topic"]);
    expect(view.api.pushWorkspaceBranch).toHaveBeenCalledOnce();
  });
});

async function mount(initial = diff) {
  const api = {
    getWorkspaceDiff: vi.fn<AppController["getWorkspaceDiff"]>(async () => initial),
    listWorkspaceChangeSets: vi.fn(async () => []),
    pushWorkspaceBranch: vi.fn<AppController["pushWorkspaceBranch"]>(async () => ({ outcome: "pushed", remote: pushTarget.remote, remoteRef: pushTarget.remoteRef,
      repositoryRevision: "repository-1", headRevision: "a".repeat(40), ahead: 0, behind: 0 } satisfies WorkspaceGitPushResultView)),
    releaseArtifactUrl: vi.fn()
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const pending: Promise<void>[] = [];
  await act(async () => root.render(<ChangesPanel controller={api as unknown as AppController} session={session} workspace={workspace}
    canDiff canPushDiff canCommitDiff={false} canDiffImagePreview={false} canStageDiff={false} canUnstageDiff={false} canRevertDiff={false} canRewind={false}
    t={(key) => key} runAction={(_key, action) => { pending.push(action().catch(() => undefined)); }} />));
  const flush = () => act(async () => { await Promise.all(pending); });
  return { api, host, flush,
    inputs: () => [...host.querySelectorAll<HTMLInputElement>(".review-push-target input")],
    push: async () => { await act(async () => button(host, "workspace.reviewPush").click()); await flush(); },
    edit: async (remote: string, ref: string) => {
      const inputs = [...host.querySelectorAll<HTMLInputElement>(".review-push-target input")];
      await act(async () => { for (const [index, value] of [remote, ref].entries()) {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(inputs[index], value);
        inputs[index]!.dispatchEvent(new Event("input", { bubbles: true }));
      } });
    }
  };
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label);
  if (result === undefined) throw new Error(`Missing button: ${label}`);
  return result;
}
