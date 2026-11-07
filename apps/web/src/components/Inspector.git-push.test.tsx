// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import type { SessionView, WorkspaceDiffImageView, WorkspaceDiffView, WorkspaceFilePreviewView, WorkspaceGitPushResultView, WorkspaceView } from "../model.js";
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
const remoteWorkspace: WorkspaceView = { ...workspace,
  remoteWorkspace: { kind: "ssh", hostId: "ssh-host", hostTargetId: "ssh-target", workspaceRoot: "/project" } };

describe("Inspector Git push destinations", () => {
  it("keeps Markdown and image previews with their original Review commit", async () => {
    const commitA = "a".repeat(40), commitB = "b".repeat(40);
    const comparison = (commit: string): WorkspaceDiffView => ({ ...diff, source: "commit", sourceRevision: commit,
      repositoryRevision: commit, headRevision: commit, files: [
        { path: "README.md", oldPath: "README.md", source: "commit", status: "modified", binary: false, text: "", hunks: [] },
        { path: "photo.png", oldPath: "photo.png", source: "commit", status: "modified", binary: true, text: "", hunks: [] }
      ] });
    const markdown = (text: string): WorkspaceFilePreviewView => ({ path: "README.md", name: "README.md", kind: "text", text, truncated: false });
    const image = (commit: string): WorkspaceDiffImageView => ({ repositoryRevision: commit, maximumBytes: 4096,
      oldImage: { present: false, tooLarge: false }, newImage: { present: true, tooLarge: false, blobId: `photo-${commit[0]}` } });
    const view = await mount(diff, false, true);
    view.api.getWorkspaceDiff.mockImplementation(async (_workspaceId, query) => comparison(query?.sourceRevision ?? commitA));
    let finishMarkdown!: (value: WorkspaceFilePreviewView) => void;
    let finishImage!: (value: WorkspaceDiffImageView) => void;
    view.api.readWorkspaceDiffFile.mockReturnValueOnce(new Promise(resolve => { finishMarkdown = resolve; })).mockResolvedValueOnce(markdown("Current Markdown"));
    view.api.readWorkspaceDiffImage.mockReturnValueOnce(new Promise(resolve => { finishImage = resolve; })).mockResolvedValueOnce(image(commitB));

    await act(async () => view.host.querySelector<HTMLButtonElement>('[aria-label="workspace.reviewSource"]')!.click());
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent === "workspace.reviewSourceCommit")!.click());
    const field = view.host.querySelector<HTMLInputElement>('input[placeholder="HEAD"]')!;
    const selectCommit = (commit: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, commit);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const loadPreviews = () => act(async () => {
      button(view.host, "workspace.reviewMarkdownPreview").click();
      button(view.host, "workspace.reviewImagePreview").click();
    });
    await selectCommit(commitA);
    await loadPreviews();
    await selectCommit(commitB);
    await loadPreviews();
    await act(async () => { finishMarkdown(markdown("Retired Markdown")); finishImage(image(commitA)); });

    expect(view.host.querySelector(".review-markdown-preview")?.textContent).toContain("Current Markdown");
    expect(view.host.textContent).not.toContain("Retired Markdown");
    expect(view.host.querySelector(".review-image-preview img")?.getAttribute("src")).toBe("blob:photo-b");
    expect(view.api.acquireArtifactUrl).toHaveBeenCalledExactlyOnceWith("photo-b");
  });

  it("refreshes a Review image after its download failed, even with the same Blob ID", async () => {
    const file = { path: "photo.png", source: "unstaged" as const, status: "modified" as const, binary: true, text: "", hunks: [] };
    const view = await mount({ ...diff, files: [file] }, false, true);
    view.api.readWorkspaceDiffImage.mockResolvedValue({ repositoryRevision: diff.repositoryRevision, maximumBytes: 4096,
      oldImage: { present: false, tooLarge: false }, newImage: { present: true, tooLarge: false, blobId: "photo" } });
    const releaseFailed = vi.fn(), releaseRetried = vi.fn();
    view.api.acquireArtifactUrl.mockImplementationOnce(() => ({ url: Promise.reject(new Error("Temporary download failure")), release: releaseFailed }))
      .mockImplementationOnce(() => ({ url: Promise.resolve("blob:retried"), release: releaseRetried }));
    await act(async () => button(view.host, "workspace.reviewImagePreview").click());
    expect(view.host.querySelector(".review-image-preview [role=alert]")?.textContent).toBe("workspace.reviewImageUnavailable");

    await act(async () => button(view.host, "workspace.reviewRefreshPreview").click());
    expect(view.api.readWorkspaceDiffImage).toHaveBeenCalledTimes(2);
    expect(view.api.acquireArtifactUrl.mock.calls).toEqual([["photo"], ["photo"]]);
    expect(view.host.querySelector(".review-image-preview img")?.getAttribute("src")).toBe("blob:retried");
    expect(releaseFailed).toHaveBeenCalledOnce();
    expect(releaseRetried).not.toHaveBeenCalled();
    await view.render(remoteWorkspace);
    expect(releaseRetried).toHaveBeenCalledOnce();
  });

  it("replaces a settled Review diff when the same workspace is rebound to SSH", async () => {
    const file = (path: string) => ({ path, source: "unstaged" as const, status: "modified" as const, binary: false, text: "", hunks: [] });
    const view = await mount({ ...diff, files: [file("local-only.txt")] });
    expect(view.host.textContent).toContain("local-only.txt");
    view.api.getWorkspaceDiff.mockClear();
    view.api.listWorkspaceChangeSets.mockClear();
    let resolveRemote!: (diff: WorkspaceDiffView) => void;
    const remote = new Promise<WorkspaceDiffView>((resolve) => { resolveRemote = resolve; });
    view.api.getWorkspaceDiff.mockReturnValue(remote);
    await view.render(remoteWorkspace);
    expect(view.host.textContent).not.toContain("local-only.txt");
    expect(view.api.getWorkspaceDiff).toHaveBeenCalledWith(workspace.id, expect.objectContaining({ source: "unstaged" }));
    expect(view.api.listWorkspaceChangeSets).toHaveBeenCalledExactlyOnceWith(workspace.id, session.id);
    await act(async () => resolveRemote({ ...diff, repositoryRevision: "remote", files: [file("remote-only.txt")] }));
    expect(view.host.textContent).toContain("remote-only.txt");
  });

  it("retires a pending push intent if its workspace changes before the fence arrives", async () => {
    const view = await mount();
    let resolveOldFence!: (diff: WorkspaceDiffView) => void;
    view.api.getWorkspaceDiff.mockReturnValueOnce(new Promise((resolve) => { resolveOldFence = resolve; }));
    await act(async () => button(view.host, "workspace.reviewPush").click());
    await view.render(remoteWorkspace);
    await act(async () => resolveOldFence(diff));
    await view.flush();
    expect(view.api.pushWorkspaceBranch).not.toHaveBeenCalled();
  });

  it("pushes to the displayed upstream even when a fresh repository read reports a different default", async () => {
    const view = await mount();
    expect(view.inputs().map((input) => input.value)).toEqual(["team/upstream", "refs/heads/published/topic"]);
    view.api.getWorkspaceDiff.mockResolvedValueOnce({ ...diff, pushTarget: { remote: "publish/next", remoteRef: "refs/heads/next-topic", hasUpstream: true } });
    await view.push();
    expect(view.api.pushWorkspaceBranch).toHaveBeenCalledExactlyOnceWith("workspace", {
      remote: "team/upstream", remoteRef: "refs/heads/published/topic", expectedRepositoryRevision: "repository-1",
      expectedHeadRevision: "a".repeat(40), confirmForceWithLease: false
    });
  });

  it("keeps the force confirmation bound to its original remote, ref, remote OID and local HEAD", async () => {
    const view = await mount();
    await view.edit("publish/manual", "refs/heads/manual-topic");
    view.api.pushWorkspaceBranch.mockResolvedValueOnce({ outcome: "needsForce", remote: "publish/manual", remoteRef: "refs/heads/manual-topic",
      remoteOid: "b".repeat(40), ahead: 1, behind: 1, repositoryRevision: "repository-1", headRevision: "a".repeat(40) });
    await view.push();
    expect(view.api.pushWorkspaceBranch).toHaveBeenCalledWith("workspace", expect.objectContaining({ remote: "publish/manual", remoteRef: "refs/heads/manual-topic", confirmForceWithLease: false }));
    await view.edit("different/remote", "refs/heads/different-topic");
    view.api.getWorkspaceDiff.mockResolvedValue({ ...diff, repositoryRevision: "repository-2", headRevision: "c".repeat(40) });
    await act(async () => button(document.body, "workspace.reviewPushForceConfirm").click());
    await view.flush();
    expect(view.api.pushWorkspaceBranch).toHaveBeenLastCalledWith("workspace", {
      remote: "publish/manual", remoteRef: "refs/heads/manual-topic", expectedRepositoryRevision: "repository-1",
      expectedHeadRevision: "a".repeat(40), confirmForceWithLease: true, expectedRemoteOid: "b".repeat(40)
    });
    expect(view.inputs().map((input) => input.value)).toEqual(["different/remote", "refs/heads/different-topic"]);
  });

  it("pushes only the commit receipt and the destination shown when Commit and push was clicked", async () => {
    const view = await mount(diff, true);
    const committedHead = "c".repeat(40);
    view.api.commitWorkspaceDiff.mockResolvedValue({ repositoryRevision: "committed-revision", headRevision: committedHead });
    view.api.getWorkspaceDiff.mockResolvedValueOnce(diff).mockResolvedValue({ ...diff,
      repositoryRevision: "later-revision", headRevision: "d".repeat(40),
      pushTarget: { remote: "other/remote", remoteRef: "refs/heads/new-target", hasUpstream: true }
    });
    const message = view.host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(message, "Review changes");
      message.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(view.host, "workspace.reviewCommitAndPush").click());
    await view.flush();
    expect(view.api.commitWorkspaceDiff).toHaveBeenCalledOnce();
    expect(view.api.pushWorkspaceBranch).toHaveBeenCalledExactlyOnceWith("workspace", {
      remote: pushTarget.remote, remoteRef: pushTarget.remoteRef,
      expectedRepositoryRevision: "committed-revision", expectedHeadRevision: committedHead, confirmForceWithLease: false
    });
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

async function mount(initial = diff, canCommitDiff = false, canDiffImagePreview = false) {
  const api = {
    getWorkspaceDiff: vi.fn<AppController["getWorkspaceDiff"]>(async () => initial),
    listWorkspaceChangeSets: vi.fn(async () => []),
    readWorkspaceDiffFile: vi.fn<AppController["readWorkspaceDiffFile"]>(),
    readWorkspaceDiffImage: vi.fn<AppController["readWorkspaceDiffImage"]>(),
    acquireArtifactUrl: vi.fn<AppController["acquireArtifactUrl"]>((blobId) => ({ url: Promise.resolve(`blob:${blobId}`), release: vi.fn() })),
    commitWorkspaceDiff: vi.fn<AppController["commitWorkspaceDiff"]>(async () => undefined),
    pushWorkspaceBranch: vi.fn<AppController["pushWorkspaceBranch"]>(async () => ({ outcome: "pushed", remote: pushTarget.remote, remoteRef: pushTarget.remoteRef,
      repositoryRevision: "repository-1", headRevision: "a".repeat(40), ahead: 0, behind: 0 } satisfies WorkspaceGitPushResultView))
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const pending: Promise<void>[] = [];
  const render = (selectedWorkspace = workspace) => act(async () => root.render(<ChangesPanel controller={api as unknown as AppController} session={session} workspace={selectedWorkspace}
    canDiff canPushDiff canCommitDiff={canCommitDiff} canDiffImagePreview={canDiffImagePreview} canStageDiff={false} canUnstageDiff={false} canRevertDiff={false} canRewind={false}
    t={(key) => key} runAction={(_key, action) => { pending.push(action().catch(() => undefined)); }} />));
  await render();
  const flush = () => act(async () => { await Promise.all(pending); });
  return { api, host, flush, render,
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
