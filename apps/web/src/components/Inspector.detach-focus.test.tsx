// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sortableMock = vi.hoisted(() => {
  class MockSortable {
    static active: MockSortable | null = null;
    readonly destroy = vi.fn();
    readonly option = vi.fn();
    constructor(readonly element: HTMLElement, readonly options: Record<string, unknown>) {}
    static create(element: HTMLElement, options: Record<string, unknown>): MockSortable {
      return new MockSortable(element, options);
    }
  }
  return { MockSortable };
});

vi.mock("sortablejs", () => ({ default: sortableMock.MockSortable }));

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type SessionView } from "../model.js";
import { Inspector } from "./Inspector.js";
import type { RunAction, Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key, values) => translate("en", key, values);

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.localStorage.clear();
  Reflect.deleteProperty(window, "jokoDesktop");
  vi.restoreAllMocks();
});

describe("Inspector detach focus", () => {
  it.each([
    { name: "active tab", empty: false, expected: "inspector-tab-context" },
    { name: "safe empty fallback", empty: true, expected: t("inspector.addTab") }
  ])("focuses the child owner Document after portal readiness: $name", async ({ empty, expected }) => {
    if (empty) window.localStorage.setItem("joko.session.inspectorTabs.v1", JSON.stringify({ "session-one": { tabs: [] } }));
    const child = createInspectorChild(true);
    installDesktop([child]);
    const rendered = await renderInspector(session("session-one"));

    await detach(rendered.host);
    expect(child.ready).toHaveBeenCalledOnce();
    expect(child.window.document.activeElement).toBe(child.window.document.body);

    await act(async () => {
      child.resolveReady();
      await rendered.actions[0];
    });

    const active = child.window.document.activeElement;
    if (empty) expect(active?.getAttribute("aria-label")).toBe(expected);
    else expect(active?.id).toBe(expected);
    expect(active?.ownerDocument).toBe(child.window.document);
  });

  it("restores the Inspector invoker after reattach without stealing a safe main-Document focus", async () => {
    const first = createInspectorChild(false);
    const second = createInspectorChild(false);
    const third = createInspectorChild(false);
    const focusDuringCommit = document.body.appendChild(document.createElement("button"));
    focusDuringCommit.textContent = "Focus during reattach commit";
    let focusWhenReattached = false;
    const desktop = installDesktop([first, second, third]);
    const rendered = await renderInspector(session("session-one"), (detached) => {
      if (!detached && focusWhenReattached) focusDuringCommit.focus();
    });

    await detach(rendered.host);
    await rendered.actions[0];
    await act(async () => first.window.document.querySelector<HTMLButtonElement>(`button[aria-label="${t("inspector.mergeBack")}"]`)!.click());
    expect(first.close).toHaveBeenCalledExactlyOnceWith("user");
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    await act(async () => desktop.notifyClosed(first.occurrence));

    const restoredInvoker = rendered.host.querySelector<HTMLButtonElement>(`button[aria-label="${t("a11y.inspectorTabActions")}"]`);
    expect(document.activeElement).toBe(restoredInvoker);

    await detach(rendered.host);
    await rendered.actions.at(-1);
    const userFocus = document.body.appendChild(document.createElement("button"));
    userFocus.textContent = "User focus";
    userFocus.focus();
    expect(document.activeElement).toBe(userFocus);

    await act(async () => desktop.notifyClosed(second.occurrence));
    expect(document.activeElement).toBe(userFocus);

    await detach(rendered.host);
    await rendered.actions.at(-1);
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    focusWhenReattached = true;
    await act(async () => desktop.notifyClosed(third.occurrence));
    expect(document.activeElement).toBe(focusDuringCommit);
  });

  it("retires a pending child-focus commit when the Session owner changes and permits a clean retry", async () => {
    const child = createInspectorChild(true);
    const retry = createInspectorChild(false);
    const desktop = installDesktop([child, retry]);
    const onDetachedChange = vi.fn();
    const rendered = await renderInspector(session("session-one"), onDetachedChange);

    await detach(rendered.host);
    await rendered.render(session("session-one", 2n));
    expect(child.close).toHaveBeenCalledExactlyOnceWith("passive");
    expect(onDetachedChange.mock.calls.map(([detached]) => detached)).toEqual([true, false]);
    await act(async () => {
      child.resolveReady();
      await rendered.actions[0];
    });
    expect(child.window.document.activeElement).toBe(child.window.document.body);

    await detach(rendered.host);
    await rendered.actions.at(-1);
    expect(retry.ready).toHaveBeenCalledOnce();
    expect(retry.window.document.activeElement?.id).toBe("inspector-tab-context");
    expect(onDetachedChange.mock.calls.map(([detached]) => detached)).toEqual([true, false, true]);

    await act(async () => desktop.notifyClosed(child.occurrence));
    expect(retry.close).not.toHaveBeenCalled();
    expect(onDetachedChange.mock.calls.map(([detached]) => detached)).toEqual([true, false, true]);

    await act(async () => desktop.notifyClosed(retry.occurrence, "child-failure"));
    expect(onDetachedChange.mock.calls.map(([detached]) => detached)).toEqual([true, false, true, false]);
    expect(document.activeElement).not.toBe(rendered.host.querySelector(`[aria-label="${t("a11y.inspectorTabActions")}"]`));
  });

  it("does not focus either Document after unmount retires a pending portal-ready action", async () => {
    const child = createInspectorChild(true);
    installDesktop([child]);
    const rendered = await renderInspector(session("session-one"));

    await detach(rendered.host);
    const focus = vi.spyOn(child.window.document.defaultView!.HTMLElement.prototype, "focus");
    await act(async () => rendered.root.unmount());
    roots.splice(roots.indexOf(rendered.root), 1);
    await act(async () => {
      child.resolveReady();
      await rendered.actions[0];
    });

    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);
  });

  it("coalesces repeated detach gestures while the child identity is pending", async () => {
    const child = createInspectorChild(false, true);
    const onDetachedChange = vi.fn();
    installDesktop([child]);
    const rendered = await renderInspector(session("session-one"), onDetachedChange);

    await act(async () => rendered.host.querySelector<HTMLButtonElement>(
      `button[aria-label="${t("a11y.inspectorTabActions")}"]`
    )!.click());
    const item = [...rendered.host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((candidate) => candidate.textContent === t("inspector.detach"));
    expect(item).not.toBeUndefined();
    await act(async () => {
      item!.click();
      item!.click();
      await settle();
    });

    expect(window.open).toHaveBeenCalledOnce();
    expect(child.ready).not.toHaveBeenCalled();
    expect(child.close).not.toHaveBeenCalled();
    expect(onDetachedChange).not.toHaveBeenCalled();

    await act(async () => {
      child.resolveIdentity();
      await Promise.all(rendered.actions);
    });
    expect(child.ready).toHaveBeenCalledOnce();
    expect(child.close).not.toHaveBeenCalled();
    expect(onDetachedChange).toHaveBeenCalledExactlyOnceWith(true);
  });
});

function createInspectorChild(deferred: boolean, identityDeferred = false): {
  readonly window: Window;
  readonly occurrence: string;
  readonly ready: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly resolveIdentity: () => void;
  readonly resolveReady: () => void;
} {
  const frame = document.body.appendChild(document.createElement("iframe"));
  const child = frame.contentWindow!;
  const occurrence = `inspector-occurrence-${document.querySelectorAll("iframe").length}`;
  let resolveIdentity = (): void => undefined;
  const identityPromise = identityDeferred
    ? new Promise<string>((resolve) => { resolveIdentity = () => resolve(occurrence); })
    : Promise.resolve(occurrence);
  let resolveReady = (): void => undefined;
  const readyPromise = deferred ? new Promise<void>((resolve) => { resolveReady = resolve; }) : Promise.resolve();
  const ready = vi.fn(() => readyPromise);
  const close = vi.fn(async () => undefined);
  Object.defineProperty(child, "jokoInspectorDesktop", {
    configurable: true,
    value: {
      platform: "win32",
      window: {
        identity: vi.fn(() => identityPromise),
        ready,
        minimize: vi.fn(async () => undefined),
        toggleMaximize: vi.fn(async () => false),
        close
      },
      selectionContextMenu: { onAddToChat: () => () => undefined }
    } satisfies JokoInspectorDesktopApi
  });
  return { window: child, occurrence, ready, close, resolveIdentity, resolveReady };
}

function installDesktop(children: readonly ReturnType<typeof createInspectorChild>[]): {
  readonly notifyClosed: (occurrence: string, reason?: "user" | "child-failure") => void;
} {
  let closedListener: ((event: { readonly occurrence: string; readonly reason: "user" | "child-failure" }) => void) | undefined;
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: {
      capabilities: ["inspector.detach"],
      inspectorWindow: {
        activate: vi.fn(async () => true),
        onClosed(listener: (event: { readonly occurrence: string; readonly reason: "user" | "child-failure" }) => void): () => void {
          closedListener = listener;
          return () => { if (closedListener === listener) closedListener = undefined; };
        }
      }
    } as unknown as JokoDesktopApi
  });
  const queue = [...children];
  vi.spyOn(window, "open").mockImplementation(() => queue.shift()?.window ?? null);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  return {
    notifyClosed: (occurrence, reason = "user") => closedListener?.({ occurrence, reason })
  };
}

async function renderInspector(initialSession: SessionView, onDetachedChange?: (detached: boolean) => void): Promise<{
  readonly root: Root;
  readonly host: HTMLElement;
  readonly actions: Promise<void>[];
  readonly render: (value: SessionView) => Promise<void>;
}> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  const actions: Promise<void>[] = [];
  const controller = {
    state: { preferences: DEFAULT_UI_PREFERENCES },
    releaseArtifactUrl: vi.fn()
  } as unknown as AppController;
  const runAction: RunAction = (_key, action) => {
    const pending = action();
    actions.push(pending);
    void pending.catch(() => undefined);
  };
  const render = async (value: SessionView): Promise<void> => act(async () => root.render(<Inspector
    controller={controller}
    snapshot={emptySnapshot()}
    session={value}
    timeline={[]}
    open
    t={t}
    runAction={runAction}
    onClose={vi.fn()}
    onDetachedChange={onDetachedChange}
    onSelectionQuote={vi.fn()}
  />));
  await render(initialSession);
  return { root, host, actions, render };
}

async function detach(host: HTMLElement): Promise<void> {
  await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${t("a11y.inspectorTabActions")}"]`)!.click());
  const item = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find((candidate) => candidate.textContent === t("inspector.detach"));
  expect(item).not.toBeUndefined();
  await act(async () => item!.click());
  await settle();
}

function session(id: string, generation = 1n): SessionView {
  return {
    id,
    backendId: "backend-one",
    targetId: "target-one",
    name: id,
    state: "idle",
    pinned: false,
    archived: false,
    generation,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });
}
