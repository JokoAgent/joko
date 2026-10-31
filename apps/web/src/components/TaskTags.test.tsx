// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { SessionView, TaskTagView } from "../model.js";
import { TaskTagDialog, TaskTagDots, taskTagDisplayName } from "./TaskTags.js";

const roots: Root[] = [];
const t = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("en", key, values);

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("task tags", () => {
  it("localizes untouched presets and renders every task dot without replacing labels with a count", async () => {
    expect(taskTagDisplayName(tag("preset:work", "Work", "indigo", "work"), t)).toBe("Work");
    expect(taskTagDisplayName({ ...tag("preset:work", "My work", "indigo", "work"), nameCustomized: true }, t))
      .toBe("My work");

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const tags = Array.from({ length: 8 }, (_, index) => tag(`tag-${index}`, `Tag ${index}`, "blue"));
    await act(async () => root.render(<TaskTagDots tags={tags} t={t} />));

    expect(host.querySelectorAll(".task-tag-dot")).toHaveLength(8);
    expect(host.querySelector(".task-tag-dots__more")).toBeNull();
    expect(host.querySelector(".task-tag-dots")?.getAttribute("aria-label"))
      .toBe(tags.map((value) => value.name).join(", "));
  });

  it("routes attach, edit, reorder, create, preview, and confirmed delete through the controller", async () => {
    const work = tag("preset:work", "Work", "indigo", "work");
    const release = tag("tag-release", "Release", "teal");
    const controller = {
      setSessionTaskTags: vi.fn(async () => undefined),
      updateTaskTag: vi.fn(async () => undefined),
      reorderTaskTags: vi.fn(async () => undefined),
      createTaskTag: vi.fn(async () => undefined),
      previewTaskTagDeletion: vi.fn(async () => ({
        tagId: release.id,
        affectedSessionCount: 3,
        tagRevision: release.revision,
        associationRevision: release.associationRevision
      })),
      deleteTaskTag: vi.fn(async () => undefined)
    } as unknown as AppController;
    const session = { id: "session-a", name: "Task", taskTags: [work] } as unknown as SessionView;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(<TaskTagDialog
      session={session}
      catalog={[work, release]}
      catalogRevision={7n}
      controller={controller}
      t={t}
      onClose={vi.fn()}
    />));

    const rows = [...document.querySelectorAll<HTMLElement>(".task-tag-editor__row")];
    expect(rows).toHaveLength(2);
    const releaseAttach = rows[1]!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => releaseAttach.click());
    expect(controller.setSessionTaskTags).toHaveBeenCalledWith("session-a", ["session-a"], [release.id], true);

    const handle = buttonByLabel(rows[1]!, t("taskTags.reorderLabel", { name: "Release" }));
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(controller.reorderTaskTags).toHaveBeenCalledWith("session-a", [release.id, work.id], 7n);

    await act(async () => buttonByLabel(rows[1]!, t("taskTags.editLabel", { name: "Release" })).click());
    expect(document.querySelectorAll(".task-tag-editor__row")).toHaveLength(0);
    expect(document.querySelectorAll(".task-tag-editor__swatch")).toHaveLength(12);
    const releaseName = document.querySelector<HTMLInputElement>('input[aria-label="Tag name"]')!;
    await change(releaseName, "Launch");
    await act(async () => document.querySelector<HTMLFormElement>(".task-tag-editor__form")!.requestSubmit());
    expect(controller.updateTaskTag).toHaveBeenCalledWith("session-a", release.id, release.revision, { name: "Launch" });

    await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === t("taskTags.create"))!.click());
    const createForm = document.querySelector<HTMLFormElement>(".task-tag-editor__form")!;
    const createName = createForm.querySelector<HTMLInputElement>("input")!;
    await change(createName, "Review");
    await act(async () => createForm.requestSubmit());
    expect(controller.createTaskTag).toHaveBeenCalledWith("session-a", "Review", "blue", 7n);

    const releaseRow = document.querySelectorAll<HTMLElement>(".task-tag-editor__row")[1]!;
    await act(async () => buttonByLabel(releaseRow, t("taskTags.editLabel", { name: "Release" })).click());
    const remove = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === t("taskTags.deleteTitle"))!;
    await act(async () => remove.click());
    await vi.waitFor(() => expect(controller.previewTaskTagDeletion).toHaveBeenCalledWith(release.id));
    expect(document.body.textContent).toContain("3");
    const confirm = [...document.querySelectorAll<HTMLButtonElement>(".button--danger")].find(button => button.textContent === t("common.delete"))!;
    await act(async () => confirm.click());
    expect(controller.deleteTaskTag).toHaveBeenCalledWith("session-a", expect.objectContaining({
      tagId: release.id,
      affectedSessionCount: 3
    }));
  });

  it("commits a pointer reorder once and cancels Escape, lost capture, and concurrent catalog changes", async () => {
    const callbacks = new Map<number, FrameRequestCallback>(); let sequence = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callbacks.set(++sequence, callback); return sequence; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
    const controller = { reorderTaskTags: vi.fn(async () => undefined) } as unknown as AppController;
    const session = { id: "original", name: "Original", taskTags: [] } as unknown as SessionView;
    const catalog = [tag("one", "One", "blue"), tag("two", "Two", "red")];
    const host = document.body.appendChild(document.createElement("div")), root = createRoot(host); roots.push(root);
    const render = async (revision = 7n) => act(async () => root.render(<TaskTagDialog session={session} catalog={catalog}
      catalogRevision={revision} controller={controller} t={t} onClose={vi.fn()} />));
    await render();
    const rows = [...document.querySelectorAll<HTMLElement>("[data-tag-id]")];
    rows.forEach((row, index) => vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ top: index * 50, bottom: index * 50 + 50, height: 50 } as DOMRect));
    const handle = rows[0]!.querySelector("button")!;
    const pointer = async (name: string, y = 90) => act(async () => {
      const event = new MouseEvent(name, { clientY: y, bubbles: true, button: 0 }); Object.defineProperty(event, "pointerId", { value: 1 });
      handle.dispatchEvent(event);
    });
    const tick = async () => act(async () => { const ready = [...callbacks.values()]; callbacks.clear(); ready.forEach(callback => callback(0)); });
    await pointer("pointerdown", 20); await pointer("pointermove"); await tick(); await pointer("pointerup"); await pointer("pointerup");
    expect(controller.reorderTaskTags).toHaveBeenCalledExactlyOnceWith("original", ["two", "one"], 7n);
    await pointer("pointerdown"); await tick();
    await act(async () => handle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await pointer("pointerup"); expect(controller.reorderTaskTags).toHaveBeenCalledOnce();
    await pointer("pointerdown"); await tick(); await pointer("lostpointercapture"); await pointer("pointerup");
    expect(controller.reorderTaskTags).toHaveBeenCalledOnce();
    await pointer("pointerdown"); await tick(); await render(8n); await pointer("pointerup");
    expect(controller.reorderTaskTags).toHaveBeenCalledOnce();
  });
});

function tag(id: string, name: string, color: TaskTagView["color"], presetKey?: string): TaskTagView {
  return {
    id,
    name,
    color,
    ...(presetKey === undefined ? {} : { presetKey }),
    nameCustomized: presetKey === undefined,
    sortOrder: 0,
    revision: 5n,
    associationRevision: 2n,
    createdAt: 1,
    updatedAt: 1
  };
}

async function change(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function buttonByLabel(root: HTMLElement, label: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.getAttribute("aria-label") === label);
  if (button === undefined) throw new Error(`Missing button: ${label}`);
  return button;
}
