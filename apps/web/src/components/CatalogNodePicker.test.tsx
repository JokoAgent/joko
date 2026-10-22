// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { emptySnapshot, type ConnectionProfile } from "../model.js";
import { translate } from "../i18n.js";
import { registerCatalogNavigationLeave } from "../catalog-navigation-leave.js";
import { ToolsPage } from "./ToolsPage.js";
import type { Translator } from "./types.js";
let root: Root | undefined;
const a = profile("a"), b = profile("b"), c = profile("c");
const t: Translator = (key, values) => translate("en", key, values);
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("keeps an offline node selected, hides the original catalog and retries the same node without falling back", async () => {
  const pending = deferred();
  const open = vi.fn().mockImplementationOnce(() => pending.promise).mockRejectedValueOnce(new Error("Still offline"));
  const view = await mount(open);
  expect(document.querySelector(".skill-hub")).not.toBeNull();
  await choose("B");
  expect(open).toHaveBeenCalledExactlyOnceWith(b.id, "skills");
  expect(document.querySelector(".skill-hub")).toBeNull();
  expect(document.body.textContent).toContain("Opening plugins and skills on B");
  await act(async () => { pending.reject(new Error("B is offline")); });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("B is offline");
  expect(document.querySelector('[aria-label="Catalog node"]')?.textContent).toContain("B");
  expect(document.querySelector(".skill-hub")).toBeNull();
  await act(async () => button("Retry").click());
  expect(open).toHaveBeenLastCalledWith(b.id, "skills");
  expect(document.body.textContent).toContain("Still offline");
  expect(view.reads).toHaveBeenCalledTimes(1);
});

it("keeps the latest node selection while an older request finishes and remounts the actual catalog on adoption", async () => {
  const first = deferred(), last = deferred();
  const open = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => last.promise);
  const view = await mount(open);
  await choose("B"); await choose("C");
  await act(async () => first.resolve(true));
  expect(document.body.textContent).toContain("Opening plugins and skills on C");
  expect(document.querySelector(".skill-hub")).toBeNull();
  await view.render(c);
  await act(async () => last.resolve(true));
  expect(document.querySelector(".skill-hub")).not.toBeNull();
  expect(document.querySelector('[aria-label="Catalog node"]')?.textContent).toContain("C");
  expect(view.reads).toHaveBeenCalledTimes(2);
});

it("leaves the original mounted editor intact when its discard decision is declined and blocks mismatched deep-link data", async () => {
  const open = vi.fn(async () => true), view = await mount(open);
  const close = registerCatalogNavigationLeave(async () => false);
  try { await choose("B"); } finally { close(); }
  expect(open).not.toHaveBeenCalled();
  expect(document.querySelector(".skill-hub")).not.toBeNull();
  await view.render(a, b.id);
  expect(document.querySelector(".skill-hub")).toBeNull();
  expect(document.body.textContent).toContain("Connect to the selected node");
  expect(view.reads).toHaveBeenCalledTimes(1);
});

it("does not load a catalog until both the connection and its active node are present", async () => {
  const reads = vi.fn();
  root = createRoot(document.body.appendChild(document.createElement("div")));
  for (const state of [
    { profiles: [a], activeProfile: a }, { profiles: [a], connectionState: "connected" }
  ]) {
    const controller = { state: { ...state, preferences: { navigationOpen: true } }, listSkills: reads } as unknown as AppController;
    await act(async () => root!.render(<ToolsPage controller={controller} snapshot={emptySnapshot()} selectedTab="skills" locale="en" t={t}
      runAction={(_key, action) => { void action(); }} onOpenNavigation={() => undefined} />));
    expect(document.querySelector(".skill-hub")).toBeNull();
  }
  expect(reads).not.toHaveBeenCalled();
});

async function mount(openMachineCatalog: AppController["openMachineCatalog"]) {
  const reads = vi.fn(async () => ({ revision: 1n, skills: [] }));
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const render = async (active = a, catalogProfileId?: string) => {
    const controller = { state: { activeProfile: active, profiles: [a, b, c], connectionGeneration: active === a ? 1 : 2,
      connectionState: "connected", machinePresenceByProfile: { [b.id]: "offline" }, preferences: { navigationOpen: true } },
      openMachineCatalog, listSkills: reads, listSkillRecoveries: async () => [] } as unknown as AppController;
    await act(async () => root!.render(<ToolsPage controller={controller} snapshot={emptySnapshot()} catalogProfileId={catalogProfileId}
      selectedTab="skills" locale="en" t={t} runAction={(_key, action) => { void action(); }} onOpenNavigation={() => undefined} />));
  };
  await render(); return { render, reads };
}
async function choose(name: string) {
  await act(async () => (document.querySelector('[aria-label="Catalog node"]') as HTMLButtonElement).click());
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent?.startsWith(name));
  if (!option) throw new Error("Missing node option " + name);
  await act(async () => option.click());
}
function button(text: string) { const value = [...document.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.trim() === text); if (!value) throw new Error("Missing button " + text); return value; }
function profile(id: string): ConnectionProfile { return { id, deviceId: "device-" + id, serverId: "node-" + id, name: id.toUpperCase(), origin: `https://${id}.example` }; }
function deferred() { let resolve!: (value: boolean) => void, reject!: (error: Error) => void; const promise = new Promise<boolean>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
