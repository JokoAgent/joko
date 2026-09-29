// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { AppController, ControllerState } from "../controller.js";
import type { PortableReplacementCleanupView } from "../model.js";
import type { Translator } from "./types.js";
import { PortableReplacementCleanupNotice } from "./PortableReplacementCleanupNotice.js";

const roots: Root[] = [];
beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

it("shows a durable task receipt only for the current profile and ignores a late old response", async () => {
  const old = deferred<PortableReplacementCleanupView | undefined>();
  const current = deferred<PortableReplacementCleanupView | undefined>();
  const get = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  const render = (profileId: string) => act(async () => root.render(<PortableReplacementCleanupNotice
    controller={controller(profileId, get)} sessionId="imported" t={translateKey}
  />));
  await render("profile-a");
  await render("profile-b");
  await act(async () => current.resolve(cleanup(2n)));
  expect(document.body.textContent).toContain("portable.cleanupUnknown");
  await act(async () => old.resolve({ ...cleanup(1n), nativeState: "completed", worktreeState: "completed" }));
  expect(document.body.textContent).toContain("portable.cleanupUnknown");
  expect(document.body.textContent).not.toContain("portable.cleanupComplete");
});

it("requires verification and a separate confirmation before retrying the exact receipt revision", async () => {
  const get = vi.fn().mockResolvedValue(cleanup(7n));
  const inspect = vi.fn().mockResolvedValue({ cleanup: cleanup(7n), inspection: "present" });
  const retry = vi.fn().mockResolvedValue({
    cleanup: { ...cleanup(8n), nativeState: "completed", worktreeState: "completed" },
    inspection: "present"
  });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () => root.render(<PortableReplacementCleanupNotice
    controller={controller("profile", get, inspect, retry)} sessionId="imported" t={translateKey}
  />));
  await vi.waitFor(() => expect(document.body.textContent).toContain("portable.cleanupUnknown"));
  expect(retry).not.toHaveBeenCalled();
  await click("portable.cleanupVerify");
  expect(inspect).toHaveBeenCalledExactlyOnceWith("imported");
  expect(document.body.textContent).toContain("portable.cleanupPresent");
  await click("portable.cleanupRetryDelete");
  expect(retry).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("portable.cleanupConfirmBody");
  await click("portable.cleanupConfirmDelete");
  expect(retry).toHaveBeenCalledExactlyOnceWith("imported", 7n);
  expect(document.body.textContent).toContain("portable.cleanupComplete");
});

it("retires a pending verification when the visible profile changes", async () => {
  const pending = deferred<{ cleanup: PortableReplacementCleanupView; inspection: "present" }>();
  const inspect = vi.fn().mockReturnValue(pending.promise);
  const get = vi.fn().mockResolvedValueOnce(cleanup(4n)).mockResolvedValueOnce(undefined);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  const render = (profileId: string) => act(async () => root.render(<PortableReplacementCleanupNotice
    controller={controller(profileId, get, inspect)} sessionId="imported" t={translateKey}
  />));
  await render("profile-a");
  await vi.waitFor(() => expect(document.body.textContent).toContain("portable.cleanupUnknown"));
  await click("portable.cleanupVerify");
  await render("profile-b");
  await act(async () => pending.resolve({ cleanup: cleanup(4n), inspection: "present" }));
  expect(document.body.textContent).not.toContain("portable.cleanupPresent");
  expect(document.body.textContent).not.toContain("portable.cleanupRetryDelete");
});

const translateKey = ((key: string) => key) as Translator;

function cleanup(revision: bigint): PortableReplacementCleanupView {
  return {
    importedSessionId: "imported",
    nativeState: "unknown",
    worktreeState: "pending",
    revision,
    updatedAt: 1_800_000_000_000
  };
}

function controller(
  profileId: string,
  get: AppController["getPortableReplacementCleanup"],
  inspect: AppController["reconcilePortableReplacementCleanup"] = vi.fn(),
  retry: AppController["retryPortableReplacementCleanup"] = vi.fn()
): AppController {
  return {
    state: {
      connectionState: "connected",
      connectionGeneration: profileId === "profile-a" ? 1 : 2,
      activeProfile: { id: profileId, serverId: "node" }
    } as ControllerState,
    getPortableReplacementCleanup: get,
    reconcilePortableReplacementCleanup: inspect,
    retryPortableReplacementCleanup: retry
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
