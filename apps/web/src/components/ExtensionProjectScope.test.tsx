// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { ExtensionProjectView, ExtensionProjectStateView } from "../model.js";
import { ExtensionProjectScopePicker, useExtensionProjectScope, type ExtensionProjectScope } from "./ExtensionProjectScope.js";

let root: Root | undefined;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const a = { id: "a".repeat(64), name: "A", path: "/projects/a" }, b = { id: "b".repeat(64), name: "B", path: "/projects/b" };
async function mount(overrides: Partial<AppController>) {
  const controller = { listExtensionProjects: async () => [a, b], ...overrides } as AppController;
  let scope!: ExtensionProjectScope;
  function Probe() { scope = useExtensionProjectScope(controller); return <ExtensionProjectScopePicker scope={scope} controller={controller} disabled={false} t={(key, values) => translate("en", key, values)} />; }
  const container = document.body.appendChild(document.createElement("div")); root = createRoot(container);
  await act(async () => root!.render(<Probe />));
  return { container, scope: () => scope };
}
function choose(container: HTMLElement, value: string) {
  const select = container.querySelector("select")!;
  select.value = value; select.dispatchEvent(new Event("change", { bubbles: true }));
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.trim() === text)!; }

it("ignores a late project read after choosing another project and never treats pending state as global", async () => {
  let release!: (value: ExtensionProjectStateView) => void;
  const waiting = new Promise<ExtensionProjectStateView>(resolve => { release = resolve; });
  const view = await mount({ getExtensionProjectState: async id => id === a.id ? waiting : { project: b, revision: 4n, disabledExtensionIds: ["plugin-b"] } });
  await act(async () => choose(view.container, a.id));
  expect(view.scope().project).toEqual(a); expect(view.scope().ready).toBe(false);
  await act(async () => choose(view.container, b.id));
  expect(view.scope().ready).toBe(true); expect(view.scope().state?.project).toEqual(b);
  await act(async () => release({ project: a, revision: 2n, disabledExtensionIds: [] }));
  expect(view.scope().state?.project).toEqual(b);
});

it("browses the selected service and ignores a cancelled folder resolution", async () => {
  let release!: (value: ExtensionProjectView) => void;
  const waiting = new Promise<ExtensionProjectView>(resolve => { release = resolve; });
  const list = vi.fn(async () => ({ path: "/service/folder", parentPath: "/service", directories: [], truncated: false }));
  const resolve = vi.fn(() => waiting);
  const view = await mount({ listExtensionProjectDirectories: list, resolveExtensionProject: resolve });
  await act(async () => choose(view.container, "browse"));
  expect(list).toHaveBeenCalledWith("", expect.any(AbortSignal));
  await act(async () => button("Use this folder").click());
  expect(resolve).toHaveBeenCalledWith("/service/folder", expect.any(AbortSignal));
  await act(async () => button("Cancel").click());
  await act(async () => release({ id: "c".repeat(64), name: "Folder", path: "/service/folder" }));
  expect(view.scope().project).toBeUndefined(); expect(view.scope().ready).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
