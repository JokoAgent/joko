// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import { SidebarFrame, type SidebarFrameProps } from "./SidebarFrame.js";

const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]): string => translate("en", key, values);
const server = { name: "Orchestrator", version: "1.2.3", health: "healthy" as const } as SidebarFrameProps["server"];
const noop = (): void => undefined;
const probeRuntimeActivity = async (): Promise<boolean> => false;
const roots: Root[] = [];
const originalMatchMedia = window.matchMedia;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

describe("SidebarFrame", () => {
  it("keeps Joko brand chrome and Orchestrator state around a feature-owned body", () => {
    const markup = renderToStaticMarkup(<SidebarFrame {...frameProps({
      expandedBody: <div>Expanded files tree</div>,
      railBody: <div>Files rail</div>
    })} />);

    expect(markup).toContain("Expanded files tree");
    expect(markup).toContain("Files rail");
    expect(markup).toContain("Orchestrator");
    expect(markup).toContain("v1.2.3");
    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-valuenow="312"');
  });

  it("keeps both feature bodies mounted in rail mode so Files tree state survives", () => {
    const markup = renderToStaticMarkup(<SidebarFrame {...frameProps({
      mode: "rail",
      width: 78,
      expandedBody: <div>Preserved expanded state</div>,
      railBody: <div>Visible rail state</div>
    })} />);

    expect(markup).toContain("Preserved expanded state");
    expect(markup).toContain("Visible rail state");
  });

  it("moves focus out before a desktop rail becomes hidden", async () => {
    installMatchMedia(window, false);
    const main = document.createElement("main");
    main.id = "main-content";
    main.tabIndex = -1;
    document.body.append(main);
    const mounted = await mountFrame({ mode: "rail", width: 78 });
    const hide = required(mounted.host.querySelector<HTMLButtonElement>(
      ".sidebar__rail-actions button[aria-label='Close navigation']"
    ));

    hide.focus();
    expect(document.activeElement).toBe(hide);
    await mounted.render({ open: false, mode: "hidden" });

    expect(document.activeElement).toBe(main);
    expect(mounted.host.querySelector("aside")?.hasAttribute("inert")).toBe(true);
  });

  it("moves focus between rail, expanded, and responsive presentations", async () => {
    const media = installMatchMedia(window, false);
    const mounted = await mountFrame({ mode: "expanded" });
    const collapse = required(mounted.host.querySelector<HTMLButtonElement>(".sidebar__collapse"));
    collapse.focus();

    await mounted.render({ mode: "rail", width: 78 });
    const expand = required(mounted.host.querySelector<HTMLButtonElement>(
      ".sidebar__rail-actions button[aria-label='Expand navigation']"
    ));
    expect(document.activeElement).toBe(expand);

    await mounted.render({ mode: "expanded", width: 312 });
    expect(document.activeElement).toBe(collapse);

    await act(async () => media.setMatches(true));
    const mobileClose = required(mounted.host.querySelector<HTMLButtonElement>(".sidebar__mobile-close"));
    expect(document.activeElement).toBe(mobileClose);
    await act(async () => media.setMatches(false));
    expect(document.activeElement).toBe(collapse);
  });

  it("owns compact focus, traps Tab, respects a higher surface, and restores in the rendering realm", async () => {
    installMatchMedia(window, false);
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const frameDocument = required(frame.contentDocument);
    const frameWindow = required(frame.contentWindow);
    installMatchMedia(frameWindow, true);
    const trigger = frameDocument.createElement("button");
    trigger.textContent = "Open navigation";
    frameDocument.body.append(trigger);
    trigger.focus();
    const onCloseDrawer = vi.fn();

    const mounted = await mountFrame({ onCloseDrawer }, frameDocument);
    const aside = required(mounted.host.querySelector<HTMLElement>("aside"));
    const mobileClose = required(aside.querySelector<HTMLButtonElement>(".sidebar__mobile-close"));
    expect(frameDocument.activeElement).toBe(mobileClose);
    expect(document.activeElement).toBe(frame);

    const focusable = [...aside.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
    )];
    for (const element of focusable) {
      Object.defineProperty(element, "getClientRects", { configurable: true, value: () => [{}] });
    }
    const first = required(focusable[0]);
    const last = required(focusable.at(-1));
    last.focus();
    await act(async () => dispatchKey(frameWindow, { key: "Tab" }));
    expect(frameDocument.activeElement).toBe(first);
    await act(async () => dispatchKey(frameWindow, { key: "Tab", shiftKey: true }));
    expect(frameDocument.activeElement).toBe(last);

    frameDocument.body.classList.add("modal-open");
    await act(async () => dispatchKey(frameWindow, { key: "Escape" }));
    expect(onCloseDrawer).not.toHaveBeenCalled();
    frameDocument.body.classList.remove("modal-open");
    await act(async () => dispatchKey(frameWindow, { key: "Escape", isComposing: true }));
    expect(onCloseDrawer).not.toHaveBeenCalled();
    await act(async () => dispatchKey(frameWindow, { key: "Escape" }));
    expect(onCloseDrawer).toHaveBeenCalledTimes(1);

    mobileClose.focus();
    await mounted.render({ open: false, mode: "hidden" });
    expect(frameDocument.activeElement).toBe(trigger);
  });

  it("uses the owner fallback when the compact trigger is no longer safe", async () => {
    installMatchMedia(window, true);
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const fallback = document.createElement("button");
    document.body.append(fallback);
    trigger.focus();
    const mounted = await mountFrame({ drawerRestoreFocus: () => fallback });
    const mobileClose = required(mounted.host.querySelector<HTMLButtonElement>(".sidebar__mobile-close"));
    expect(document.activeElement).toBe(mobileClose);

    trigger.setAttribute("inert", "");
    await mounted.render({ open: false, mode: "hidden" });

    expect(document.activeElement).toBe(fallback);
  });
});

function frameProps(overrides: Partial<SidebarFrameProps> = {}): SidebarFrameProps {
  return {
    server,
    open: true,
    mode: "expanded",
    width: 312,
    probeRuntimeActivity,
    t,
    expandedBody: <div>Expanded body</div>,
    railBody: <div>Rail body</div>,
    onHome: noop,
    onNewTask: noop,
    onSearch: noop,
    onCloseDrawer: noop,
    onHide: noop,
    onCollapse: noop,
    onExpand: noop,
    onResizePointerDown: noop,
    onResizePointerMove: noop,
    onResizePointerUp: noop,
    onResizePointerCancel: noop,
    onResizeKeyDown: noop,
    onResetWidth: noop,
    onDisconnect: noop,
    ...overrides
  };
}

async function mountFrame(
  initial: Partial<SidebarFrameProps>,
  ownerDocument: Document = document
): Promise<{
  readonly host: HTMLDivElement;
  readonly render: (overrides: Partial<SidebarFrameProps>) => Promise<void>;
}> {
  const host = ownerDocument.createElement("div");
  ownerDocument.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  let props = frameProps(initial);
  const render = async (overrides: Partial<SidebarFrameProps>): Promise<void> => {
    props = { ...props, ...overrides };
    await act(async () => root.render(<SidebarFrame {...props} />));
  };
  await render({});
  return { host, render };
}

function installMatchMedia(ownerWindow: Window, initialMatches: boolean): { readonly setMatches: (next: boolean) => void } {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() { return matches; },
    media: "(max-width: 980px)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true
  } as unknown as MediaQueryList;
  Object.defineProperty(ownerWindow, "matchMedia", {
    configurable: true,
    value: vi.fn(() => query)
  });
  return {
    setMatches: (next) => {
      matches = next;
      for (const listener of listeners) {
        listener({ matches: next, media: query.media } as MediaQueryListEvent);
      }
    }
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test value");
  return value;
}

function dispatchKey(ownerWindow: Window, init: KeyboardEventInit): boolean {
  const KeyboardEventConstructor = (ownerWindow as Window & typeof globalThis).KeyboardEvent;
  return ownerWindow.dispatchEvent(new KeyboardEventConstructor("keydown", init));
}
