// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMobileExpandedBlockStore, mobileExpandedBlockStore, useMobileExpandedBlock } from "./mobile-expanded-block-memory";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots = new Set<Root>();
afterEach(() => {
  act(() => { for (const root of roots) root.unmount(); });
  roots.clear();
  mobileExpandedBlockStore.reset();
});

describe("mobile expanded block memory", () => {
  it("remembers only manually expanded exact owner/block pairs within one process", () => {
    const store = createMobileExpandedBlockStore();
    expect(store.isExpanded("phone/session-one", "thinking-message-one")).toBe(false);
    store.setExpanded("phone/session-one", "thinking-message-one", true);
    expect(store.isExpanded("phone/session-one", "thinking-message-one")).toBe(true);
    expect(store.isExpanded("phone/session-two", "thinking-message-one")).toBe(false);
    expect(store.isExpanded("phone/session-one", "work-message-one")).toBe(false);
    store.setExpanded("a", "b/c", true);
    expect(store.isExpanded("a/b", "c")).toBe(false);
    expect(createMobileExpandedBlockStore().isExpanded("phone/session-one", "thinking-message-one")).toBe(false);
    store.setExpanded("phone/session-one", "thinking-message-one", false);
    expect(store.isExpanded("phone/session-one", "thinking-message-one")).toBe(false);
  });

  it("evicts the oldest expansion and notifies its exact consumers without refreshing on reads or no-ops", () => {
    const store = createMobileExpandedBlockStore({ maximumEntries: 2 });
    const oldest = vi.fn(); const newest = vi.fn(); const foreign = vi.fn();
    store.subscribe("owner", "first", oldest);
    store.subscribe("owner", "third", newest);
    store.subscribe("other", "first", foreign);
    store.setExpanded("owner", "first", true);
    store.setExpanded("owner", "second", true);
    expect(store.isExpanded("owner", "first")).toBe(true);
    store.setExpanded("owner", "first", true);
    expect(oldest).toHaveBeenCalledOnce();
    store.setExpanded("owner", "third", true);
    expect(store.isExpanded("owner", "first")).toBe(false);
    expect(store.isExpanded("owner", "second")).toBe(true);
    expect(store.isExpanded("owner", "third")).toBe(true);
    expect(oldest).toHaveBeenCalledTimes(2);
    expect(newest).toHaveBeenCalledOnce();
    expect(foreign).not.toHaveBeenCalled();
  });

  it("unsubscribes, resets mounted memory and isolates subscriber failures", () => {
    const failure = new Error("Consumer failed");
    const report = vi.fn(() => { throw new Error("Reporter failed"); });
    const store = createMobileExpandedBlockStore({ onSubscriberError: report });
    const observed = vi.fn(); const retired = vi.fn();
    store.subscribe("owner", "block", () => { throw failure; });
    store.subscribe("owner", "block", observed);
    const unsubscribe = store.subscribe("owner", "block", retired);
    unsubscribe(); unsubscribe();
    store.setExpanded("owner", "block", true);
    expect(report).toHaveBeenCalledWith(failure);
    expect(observed).toHaveBeenCalledOnce();
    expect(retired).not.toHaveBeenCalled();
    store.reset();
    expect(store.isExpanded("owner", "block")).toBe(false);
    expect(observed).toHaveBeenCalledTimes(2);
    store.setExpanded("owner", "block", true);
    expect(observed).toHaveBeenCalledTimes(3);
  });

  it("requires real owner/block keys and a finite memory bound", () => {
    const store = createMobileExpandedBlockStore();
    expect(() => store.isExpanded("", "block")).toThrow(/exact owner/u);
    expect(() => store.setExpanded("owner", " ", true)).toThrow(/stable block/u);
    expect(() => createMobileExpandedBlockStore({ maximumEntries: Infinity })).toThrow(/positive safe integer/u);
    expect(() => createMobileExpandedBlockStore({ maximumEntries: 0 })).toThrow(/positive safe integer/u);
  });

  it("keeps hook toggles synchronized across remounts, regrouping and exact owner switches", () => {
    function Block({ owner, block }: { owner: string; block: string }) {
      const [expanded, toggle] = useMobileExpandedBlock(owner, block);
      return createElement("button", { onClick: toggle, "aria-expanded": expanded }, expanded ? "Expanded" : "Collapsed");
    }
    const first = document.createElement("div"); const mirror = document.createElement("div");
    const root = createRoot(first); const mirrorRoot = createRoot(mirror);
    roots.add(root); roots.add(mirrorRoot);
    const render = (owner: string, key = "flat") => root.render(createElement(Block, { owner, block: "thinking-one", key }));
    act(() => {
      render("owner-one");
      mirrorRoot.render(createElement(Block, { owner: "owner-one", block: "thinking-one" }));
    });
    expect(first.textContent).toBe("Collapsed");
    act(() => first.querySelector("button")!.click());
    expect(first.textContent).toBe("Expanded");
    expect(mirror.textContent).toBe("Expanded");
    act(() => render("owner-one", "nested-work"));
    expect(first.textContent).toBe("Expanded");
    act(() => render("owner-two"));
    expect(first.textContent).toBe("Collapsed");
    act(() => first.querySelector("button")!.click());
    act(() => mirror.querySelector("button")!.click());
    expect(first.textContent).toBe("Expanded");
    expect(mirror.textContent).toBe("Collapsed");
    act(() => render("owner-one"));
    expect(first.textContent).toBe("Collapsed");
    act(() => first.querySelector("button")!.click());
    expect(mirror.textContent).toBe("Expanded");
    act(() => mobileExpandedBlockStore.reset());
    expect(first.textContent).toBe("Collapsed");
    expect(mirror.textContent).toBe("Collapsed");
  });

  it("keeps explicit default-expanded plans independent of default-collapsed blocks and remembers manual collapse", () => {
    function Block({ owner, plan }: { owner: string; plan: boolean }) {
      const [expanded, toggle] = useMobileExpandedBlock(owner, plan ? "inline-plan" : "thinking-one", plan);
      return createElement("button", { onClick: toggle, "aria-expanded": expanded }, expanded ? "Expanded" : "Collapsed");
    }
    const host = document.createElement("div"); const root = createRoot(host); roots.add(root);
    act(() => root.render(createElement(Block, { owner: "owner-one", plan: true })));
    expect(host.textContent).toBe("Expanded");
    act(() => host.querySelector("button")!.click());
    expect(host.textContent).toBe("Collapsed");
    act(() => root.render(null));
    act(() => root.render(createElement(Block, { owner: "owner-one", plan: true })));
    expect(host.textContent).toBe("Collapsed");
    act(() => root.render(createElement(Block, { owner: "owner-two", plan: true })));
    expect(host.textContent).toBe("Expanded");
    act(() => root.render(createElement(Block, { owner: "owner-one", plan: false })));
    expect(host.textContent).toBe("Collapsed");
    act(() => root.render(createElement(Block, { owner: "owner-one", plan: true })));
    expect(host.textContent).toBe("Collapsed");
    act(() => mobileExpandedBlockStore.reset());
    expect(host.textContent).toBe("Expanded");
    const restarted = createMobileExpandedBlockStore();
    expect(restarted.isExpanded("owner-one", "inline-plan", true)).toBe(true);
    expect(restarted.isExpanded("owner-one", "thinking-one")).toBe(false);
  });
});
