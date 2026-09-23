// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController, ControllerState } from "../controller.js";
import { emptySnapshot } from "../model.js";
import { ProjectEditor } from "./ProjectEditor.js";

let root: Root | undefined;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "jokoDesktop");
  vi.unstubAllGlobals();
});

it("offers native directory selection only for the exact local service and ignores a late path after ownership changes", async () => {
  const pickDirectory = vi.fn();
  Object.defineProperty(window, "jokoDesktop", { configurable: true, value: {
    capabilities: ["projects.directoryPicker"], projects: { pickDirectory }
  } });
  const profile = { id: "profile", deviceId: "device", serverId: "server", name: "Local", origin: "http://127.0.0.1", managedLocal: true };
  let state = { connectionState: "connected", activeProfile: profile, managedOrchestratorStatus: { state: "ready", connection: {
    profileId: profile.id, deviceId: profile.deviceId, serverId: profile.serverId, name: profile.name, origin: profile.origin
  } } } as ControllerState;
  const controller = { get state() { return state; } } as AppController;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const snapshot = { ...emptySnapshot(), backends: [{ id: "backend", name: "Backend", version: "1", instanceGeneration: 1,
    health: "healthy" as const, capabilities: new Map() }] };
  const render = async () => act(async () => root?.render(<ProjectEditor open controller={controller} snapshot={snapshot} t={(key) => key}
    onClose={() => undefined} onSave={() => undefined} />));
  await render();
  const browse = button("projects.browseLocal");
  let resolveFirst!: (value: { readonly cancelled: true } | { readonly cancelled: false; readonly path: string }) => void;
  pickDirectory.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
  await act(async () => browse.click());
  expect(pickDirectory).toHaveBeenCalledExactlyOnceWith({ profileId: "profile", deviceId: "device", serverId: "server", origin: "http://127.0.0.1" });
  await act(async () => { resolveFirst({ cancelled: true }); await Promise.resolve(); });
  expect(path().value).toBe("");

  pickDirectory.mockResolvedValueOnce({ cancelled: false, path: "C:\\work\\project" });
  await act(async () => { button("projects.browseLocal").click(); await Promise.resolve(); });
  expect(path().value).toBe("C:\\work\\project");
  expect(document.querySelector<HTMLInputElement>('[role="dialog"] input[maxlength="120"]')?.value).toBe("project");

  let resolveLate!: (value: { readonly cancelled: false; readonly path: string }) => void;
  pickDirectory.mockReturnValueOnce(new Promise((resolve) => { resolveLate = resolve; }));
  await act(async () => button("projects.browseLocal").click());
  state = { ...state, activeProfile: { ...profile, id: "remote", managedLocal: false } };
  await render();
  expect(host.textContent).not.toContain("projects.browseLocal");
  await act(async () => { resolveLate({ cancelled: false, path: "C:\\wrong" }); await Promise.resolve(); });
  expect(path().value).toBe("C:\\work\\project");

  function button(label: string): HTMLButtonElement {
    const result = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((candidate) => candidate.textContent === label);
    if (result === undefined) throw new Error(`Missing ${label}.`);
    return result;
  }
  function path(): HTMLInputElement {
    const result = document.querySelector<HTMLInputElement>("#project-editor-path");
    if (result === null) throw new Error("Missing service path.");
    return result;
  }
});

it("browses the connected service node, selects a canonical path, and retires late results after owner change", async () => {
  const firstListing = { path: "/srv/projects", parentPath: "/srv", truncated: false,
    directories: [{ name: "alpha", path: "/srv/projects/alpha" }] };
  const childListing = { path: "/srv/projects/alpha", parentPath: "/srv/projects", truncated: false, directories: [] };
  const listProjectDirectories = vi.fn().mockResolvedValueOnce(firstListing).mockResolvedValueOnce(childListing);
  const profile = { id: "remote-profile", deviceId: "remote-device", serverId: "remote-server",
    name: "Remote", origin: "https://remote.example.test", managedLocal: false };
  let state = { connectionState: "connected", activeProfile: profile, managedOrchestratorStatus: undefined,
    route: { kind: "newSession" }, navigationRevision: 3, snapshot: { ...emptySnapshot(), generation: 7 } } as unknown as ControllerState;
  const controller = { get state() { return state; }, listProjectDirectories } as unknown as AppController;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const snapshot = { ...emptySnapshot(), backends: [{ id: "backend", name: "Backend", version: "1", instanceGeneration: 1,
    health: "healthy" as const, capabilities: new Map() }] };
  const render = async () => act(async () => root?.render(<ProjectEditor open controller={controller} snapshot={snapshot} t={(key) => key}
    onClose={() => undefined} onSave={() => undefined} />));
  await render();
  const button = (label: string): HTMLButtonElement => {
    const result = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((candidate) => candidate.textContent === label);
    if (result === undefined) throw new Error(`Missing ${label}.`);
    return result;
  };
  expect(document.querySelector<HTMLInputElement>("#project-editor-path")?.value).toBe("");
  await act(async () => { button("projects.browseService").click(); await Promise.resolve(); });
  expect(listProjectDirectories).toHaveBeenNthCalledWith(1, "", expect.any(AbortSignal));
  await act(async () => { button("alpha").click(); await Promise.resolve(); });
  expect(listProjectDirectories).toHaveBeenNthCalledWith(2, "/srv/projects/alpha", expect.any(AbortSignal));
  expect(host.textContent).toContain("projects.browseServiceEmpty");
  await act(async () => button("projects.browseServiceChoose").click());
  expect(document.querySelector<HTMLInputElement>("#project-editor-path")?.value).toBe("/srv/projects/alpha");
  expect(document.querySelector<HTMLInputElement>('[role="dialog"] input[maxlength="120"]')?.value).toBe("alpha");

  let resolveLate!: (listing: typeof firstListing) => void;
  listProjectDirectories.mockReturnValueOnce(new Promise((resolve) => { resolveLate = resolve; }));
  await act(async () => button("projects.browseService").click());
  state = { ...state, activeProfile: { ...profile, serverId: "different-server" } };
  await render();
  await act(async () => { resolveLate(firstListing); await Promise.resolve(); });
  expect(document.querySelector(".project-editor__browser")).toBeNull();
  expect(document.querySelector<HTMLInputElement>("#project-editor-path")?.value).toBe("/srv/projects/alpha");
});

it("shows browse failure, retry, disconnection, and cancellation without accepting stale directories", async () => {
  const listing = { path: "/srv/projects", parentPath: "/srv", truncated: false, directories: [] };
  let resolveLate!: (value: typeof listing) => void;
  const listProjectDirectories = vi.fn().mockRejectedValueOnce(new Error("read failed"))
    .mockResolvedValueOnce(listing).mockReturnValueOnce(new Promise((resolve) => { resolveLate = resolve; }));
  const profile = { id: "profile", deviceId: "device", serverId: "server", name: "Remote",
    origin: "https://remote.example.test", managedLocal: false };
  let state = { connectionState: "connected", activeProfile: profile, route: { kind: "newSession" },
    navigationRevision: 1, snapshot: { ...emptySnapshot(), generation: 1 } } as unknown as ControllerState;
  const controller = { get state() { return state; }, listProjectDirectories } as unknown as AppController;
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  const snapshot = { ...emptySnapshot(), backends: [{ id: "backend", name: "Backend", version: "1", instanceGeneration: 1,
    health: "healthy" as const, capabilities: new Map() }] };
  const render = async () => act(async () => root?.render(<ProjectEditor open controller={controller} snapshot={snapshot} t={(key) => key}
    onClose={() => undefined} onSave={() => undefined} />));
  const button = (label: string): HTMLButtonElement => {
    const result = [...document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((candidate) => candidate.textContent === label);
    if (result === undefined) throw new Error(`Missing ${label}.`);
    return result;
  };
  await render();
  await act(async () => { button("projects.browseService").click(); await Promise.resolve(); });
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("read failed");
  await act(async () => { button("common.retry").click(); await Promise.resolve(); });
  expect(host.textContent).toContain("projects.browseServiceEmpty");
  await act(async () => button("projects.browseServiceParent").click());
  expect(host.textContent).toContain("common.loading");
  state = { ...state, connectionState: "disconnected" };
  await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("projects.browseServiceDisconnected");
  await act(async () => { resolveLate(listing); await Promise.resolve(); });
  expect(host.textContent).not.toContain("projects.browseServiceEmpty");
  await act(async () => button("common.cancel").click());
  expect(document.querySelector(".project-editor__browser")).toBeNull();
  expect(document.querySelector<HTMLInputElement>("#project-editor-path")?.value).toBe("");
});
