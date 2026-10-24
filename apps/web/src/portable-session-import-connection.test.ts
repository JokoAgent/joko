import { expect, it, vi } from "vitest";
import { bindPortableSessionImportApi, portableSessionImportOwnerKey, type PortableSessionImportApi } from "./portable-session-import-connection.js";
import { emptySnapshot, type PortableSessionImportDraftView, type PortableSessionImportResultView } from "./model.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function api(): PortableSessionImportApi {
  return {
    inspectPortableSessionImport: vi.fn(), unlockPortableSessionImport: vi.fn(),
    commitPortableSessionImport: vi.fn(), retryPortableSessionActivation: vi.fn(),
    cancelPortableSessionImport: vi.fn(async () => undefined)
  };
}
const draft: PortableSessionImportDraftView = { draftId: "original-draft", expiresAt: 1, encrypted: true, passwordRequired: true };

it("binds owner identity to the exact connection occurrence while allowing normal revisions", () => {
  const state = { connectionState: "connected", connectionGeneration: 3, snapshot: emptySnapshot(), activeProfile: {
    id: "profile-a", serverId: "server-a", deviceId: "device-a", origin: "https://a.example", name: "A" } };
  const key = portableSessionImportOwnerKey(state);
  const updated = { ...state, snapshot: { ...state.snapshot, revision: 5n } };
  expect(key).toBeDefined();
  expect(portableSessionImportOwnerKey(updated)).toBe(key);
  expect(portableSessionImportOwnerKey({ ...state, connectionState: "disconnected" })).toBeUndefined();
  expect(portableSessionImportOwnerKey({ ...state, connectionGeneration: 4 })).not.toBe(key);
  expect(portableSessionImportOwnerKey({ ...state, snapshot: { ...state.snapshot, generation: 7n } })).not.toBe(key);
});

it("rejects retired business calls and cleans a late inspection only through its original API", async () => {
  const original = api(), replacement = api(), pending = deferred<PortableSessionImportDraftView>();
  let current = true;
  vi.mocked(original.inspectPortableSessionImport).mockReturnValue(pending.promise);
  const bound = bindPortableSessionImportApi(original, () => current);
  const inspection = bound.inspectPortableSessionImport(new File(["private"], "private.jshare"));
  const rejected = expect(inspection).rejects.toMatchObject({ name: "AbortError" });
  current = false;
  pending.resolve(draft);
  await rejected;
  expect(original.cancelPortableSessionImport).toHaveBeenCalledExactlyOnceWith(draft.draftId);
  await expect(bound.unlockPortableSessionImport(draft.draftId, "private-password")).rejects.toMatchObject({ name: "AbortError" });
  expect(original.unlockPortableSessionImport).not.toHaveBeenCalled();
  expect(replacement.inspectPortableSessionImport).not.toHaveBeenCalled();
  await bound.cancelPortableSessionImport("original-draft");
  expect(replacement.cancelPortableSessionImport).not.toHaveBeenCalled();
});

it.each(["unlock", "commit"] as const)("does not adopt a late %s result after the owner retires", async kind => {
  const original = api(), pending = deferred<PortableSessionImportDraftView & PortableSessionImportResultView>();
  let current = true;
  vi.mocked(original.unlockPortableSessionImport).mockReturnValue(pending.promise);
  vi.mocked(original.commitPortableSessionImport).mockReturnValue(pending.promise);
  const bound = bindPortableSessionImportApi(original, () => current);
  const operation = kind === "unlock" ? bound.unlockPortableSessionImport("original-draft", "private-password")
    : bound.commitPortableSessionImport({ draftId: "original-draft", targetId: "original-target", overwrite: false, useWorktree: false,
      execution: { fastMode: false, permissionMode: "ask", planMode: false } });
  const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
  current = false;
  pending.resolve({ ...draft, sessionId: "original-imported", fidelity: "full", messageCount: 1, mediaCount: 0,
    workerCount: 0, replacedSessionIds: [], status: "ready" });
  await rejected;
});
