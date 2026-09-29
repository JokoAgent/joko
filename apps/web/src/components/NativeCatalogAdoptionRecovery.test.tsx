// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController, ControllerState } from "../controller.js";
import type { NativeCatalogAdoptionView } from "../model.js";
import type { Translator } from "./types.js";
import { NativeCatalogAdoptionRecovery } from "./NativeCatalogAdoptionRecovery.js";

const roots: Root[] = [];
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

it("shows only the current connection's pending recovery after a profile switch", async () => {
  const old = deferred<readonly NativeCatalogAdoptionView[]>();
  const current = deferred<readonly NativeCatalogAdoptionView[]>();
  const list = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  const render = (profileId: string) => act(async () => root.render(<NativeCatalogAdoptionRecovery
    controller={controller(profileId, list)} t={translateKey}
  />));
  await render("profile-a");
  await render("profile-b");
  await act(async () => current.resolve([{ ...adoption(), operationId: "current-operation", title: "Current task" }]));
  await act(async () => old.resolve([{ ...adoption(), operationId: "old-operation", title: "Old task" }]));
  expect(document.body.textContent).toContain("Current task");
  expect(document.body.textContent).not.toContain("Old task");
});

it("reconciles the exact visible request without re-importing and retires a late old response", async () => {
  const pending = deferred<{ adoption: NativeCatalogAdoptionView; inspection: "present" }>();
  const reconcile = vi.fn().mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ adoption: { ...adoption(), state: "adopted", sessionId: "session-1" }, inspection: "present" });
  const list = vi.fn().mockResolvedValue([adoption()]);
  const resolved = vi.fn();
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  const render = (profileId: string) => act(async () => root.render(<NativeCatalogAdoptionRecovery
    controller={controller(profileId, list, reconcile)} t={translateKey} onResolved={resolved}
  />));
  await render("profile-a");
  await click("settings.sessionImport.recoveryVerify");
  expect(reconcile).toHaveBeenCalledExactlyOnceWith("operation-1");
  await render("profile-b");
  await act(async () => pending.resolve({ adoption: { ...adoption(), state: "adopted", sessionId: "session-old" }, inspection: "present" }));
  expect(resolved).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("settings.sessionImport.recoveryPending");
  await click("settings.sessionImport.recoveryVerify");
  expect(reconcile).toHaveBeenLastCalledWith("operation-1");
  expect(document.body.textContent).toContain("settings.sessionImport.recoveryAdopted");
  expect(resolved).toHaveBeenCalledOnce();
});

it("reveals a claim created while the import settings remain mounted", async () => {
  const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([adoption()]);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  const active = controller("profile-a", list);
  await act(async () => root.render(<NativeCatalogAdoptionRecovery controller={active} t={translateKey}
    refreshKey={0} />));
  expect(document.body.textContent).not.toContain("Pending task");
  await act(async () => root.render(<NativeCatalogAdoptionRecovery controller={active} t={translateKey}
    refreshKey={1} />));
  expect(document.body.textContent).toContain("Pending task");
  expect(list).toHaveBeenCalledTimes(2);
});

const translateKey = ((key: string) => key) as Translator;

function adoption(): NativeCatalogAdoptionView {
  return {
    operationId: "operation-1", backendId: "codex", targetId: "target-1",
    title: "Pending task", state: "pending", revision: 1n,
    updatedAt: 1_800_000_000_000
  };
}

function controller(
  profileId: string,
  list: AppController["listNativeCatalogAdoptions"],
  reconcile: AppController["reconcileNativeCatalogAdoption"] = vi.fn()
): AppController {
  return {
    state: {
      connectionState: "connected",
      connectionGeneration: profileId === "profile-a" ? 1 : 2,
      activeProfile: { id: profileId, serverId: "node" }
    } as ControllerState,
    listNativeCatalogAdoptions: list,
    reconcileNativeCatalogAdoption: reconcile
  } as AppController;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function click(label: string): Promise<void> {
  const button = [...document.body.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(button, `Missing action ${label}`).toBeDefined();
  await act(async () => button!.click());
}
