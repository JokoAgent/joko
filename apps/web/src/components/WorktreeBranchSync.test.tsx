// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OperationApi, WorktreeBranchStatusView, WorktreeBranchSyncOperationView } from "../model.js";
import { translate } from "../i18n.js";
import { WorktreeBranchSync } from "./WorktreeBranchSync.js";

let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); });
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]) => translate("en", key, values);
const status: WorktreeBranchStatusView = { branch: "main", remoteOnly: false, ahead: 0, behind: 1, dirtyFiles: 2, revision: "a".repeat(64) };
function fixture() {
  const read = vi.fn<OperationApi["getTargetWorktreeBranchStatus"]>(async () => status);
  const start = vi.fn<OperationApi["syncTargetWorktreeBranch"]>(async input => ({ operationId: input.operationId, pending: false, unknown: false, updated: 1, status: { ...status, behind: 0 } }));
  const poll = vi.fn<OperationApi["getWorktreeBranchSyncOperation"]>(async operationId => ({ operationId, pending: false, unknown: false, updated: 1, status: { ...status, behind: 0 } }));
  const updated = vi.fn(async () => {});
  const show = async (sourceRef = "refs/heads/main", ownerKey = "original-owner") => {
    if (!root) { const host = document.body.appendChild(document.createElement("div")); root = createRoot(host); }
    await act(async () => root!.render(<><button type="button">Create task</button><WorktreeBranchSync key={JSON.stringify([sourceRef, ownerKey])}
      api={{ getTargetWorktreeBranchStatus: read, syncTargetWorktreeBranch: start, getWorktreeBranchSyncOperation: poll }}
      ownerKey={ownerKey} targetId="target" sourceRef={sourceRef} disabled={false} t={t} onUpdated={updated} /></>));
  };
  const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent === label)!;
  const click = async (label: string) => act(async () => button(label).click());
  return { read, start, poll, updated, show, button, click };
}
it("reads without updating, retains the original intent before dispatch, and refreshes sources after completion", async () => {
  const f = fixture();
  f.start.mockImplementation(async input => {
    expect(localStorage.length).toBe(1);
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!)).toMatchObject({ operationId: input.operationId, expectedRevision: status.revision });
    return { operationId: input.operationId, pending: false, unknown: false, updated: 1, status: { ...status, behind: 0 } };
  });
  await f.show(); expect(f.start).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("Ahead 0 · Behind 1 · Local changes 2");
  await f.click("Update selected branch");
  expect(f.start).toHaveBeenCalledWith({ targetId: "target", sourceRef: "refs/heads/main", expectedRevision: status.revision, operationId: expect.any(String) }, expect.any(AbortSignal));
  expect(f.updated).toHaveBeenCalledOnce(); expect(localStorage.length).toBe(0); expect(document.body.textContent).toContain("Updated commits: 1.");
});
it("does not block creating a task during an update and discards late results after changing the branch", async () => {
  const f = fixture(); let settle!: (value: WorktreeBranchSyncOperationView) => void;
  f.start.mockImplementation(async input => ({ operationId: input.operationId, pending: true, unknown: false, updated: 0 }));
  f.poll.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
  await f.show(); await f.click("Update selected branch");
  expect(f.button("Create task").disabled).toBe(false); expect(f.button("Updating branch…").disabled).toBe(true);
  const original = f.start.mock.calls[0]![0];
  f.read.mockResolvedValue({ ...status, branch: "other", behind: 3 });
  await f.show("refs/heads/other");
  await act(async () => settle({ operationId: original.operationId, pending: false, unknown: false, updated: 9, status: { ...status, behind: 0 } }));
  expect(document.body.textContent).toContain("Behind 3"); expect(document.body.textContent).not.toContain("Updated commits: 9.");
  expect(f.updated).not.toHaveBeenCalled(); expect(localStorage.length).toBe(1);
});
it("recovers an unconfirmed admission with the retained operation ID and never sends the mutation again", async () => {
  const f = fixture(); f.start.mockRejectedValue(new Error("ACK lost"));
  await f.show(); await f.click("Update selected branch");
  const original = f.start.mock.calls[0]![0].operationId;
  expect(document.body.textContent).toContain("original update is unconfirmed"); expect(f.button("Update selected branch").disabled).toBe(true);
  await act(async () => root!.unmount()); root = undefined;
  await f.show(); expect(f.poll).toHaveBeenCalledWith(original, expect.any(AbortSignal)); expect(f.start).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("Updated commits: 1."); expect(localStorage.length).toBe(0);
});
it("keeps a blocked branch and unavailable receipt storage from admitting an update", async () => {
  const f = fixture(); f.read.mockResolvedValue({ ...status, blocked: "diverged" }); await f.show();
  expect(f.button("Update selected branch").disabled).toBe(true); expect(document.body.textContent).toContain("histories have diverged");
  f.read.mockResolvedValue(status); await f.click("Refresh branch status");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  await f.click("Update selected branch"); expect(f.start).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("receipt could not be retained");
});
