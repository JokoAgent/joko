// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MOBILE_HIDDEN_HISTORY_LIMIT, planMobileHiddenHistory, useMobileHiddenHistory,
  type MobileHiddenHistoryInput, type MobileHiddenHistoryState } from "./use-mobile-hidden-history";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const input: MobileHiddenHistoryInput = { scope: "owner", enabled: true, visibleCount: 0, hasEarlier: true, loading: false, cursor: "cursor-1" };
const initial: MobileHiddenHistoryState = { scope: "owner", pages: 0, exhausted: false };
let root: Root | undefined; let container: HTMLDivElement | undefined; let chasing = false;
function Harness({ current, load }: { current: MobileHiddenHistoryInput; load: () => Promise<void> }) {
  chasing = useMobileHiddenHistory(current, load); return createElement("span", {}, chasing ? "loading" : "ready");
}
async function render(current: MobileHiddenHistoryInput, load: () => Promise<void>) {
  if (!root) { container = document.createElement("div"); document.body.append(container); root = createRoot(container); }
  await act(async () => root!.render(createElement(Harness, { current, load })));
}
afterEach(() => { if (root) act(() => root!.unmount()); container?.remove(); root = undefined; });

describe("mobile hidden Partner history", () => {
  it("reads only empty, online, foreground eligible history and stops on no progress or the fixed cap", () => {
    for (const patch of [{ enabled: false }, { visibleCount: 1 }, { hasEarlier: false }, { loading: true }]) {
      expect(planMobileHiddenHistory(initial, { ...input, ...patch }).load).toBe(false);
    }
    const first = planMobileHiddenHistory(initial, input); expect(first.load).toBe(true);
    expect(planMobileHiddenHistory(first.state, input)).toMatchObject({ load: false, state: { exhausted: true } });
    let state = initial;
    for (let index = 0; index < MOBILE_HIDDEN_HISTORY_LIMIT; index++) {
      const next = planMobileHiddenHistory(state, { ...input, cursor: `cursor-${index}` });
      expect(next.load).toBe(true); state = next.state;
    }
    expect(planMobileHiddenHistory(state, { ...input, cursor: "after-cap" }).load).toBe(false);
    expect(planMobileHiddenHistory(state, { ...input, scope: "another-owner" })).toMatchObject({ load: true, state: { pages: 1, exhausted: false } });
  });

  it("does not issue parallel pages, ends the syncing placeholder when content appears, and keeps failure terminal", async () => {
    const load = vi.fn(async () => undefined);
    await render(input, load); expect(load).toHaveBeenCalledOnce(); expect(chasing).toBe(true);
    await render({ ...input, loading: true }, load); expect(load).toHaveBeenCalledOnce();
    await render({ ...input, cursor: "cursor-2" }, load); expect(load).toHaveBeenCalledTimes(2);
    await render({ ...input, visibleCount: 1, cursor: "cursor-3" }, load); expect(chasing).toBe(false);
    load.mockRejectedValueOnce(new Error("offline"));
    await render({ ...input, cursor: "cursor-4" }, load); expect(load).toHaveBeenCalledTimes(3); expect(chasing).toBe(false);
    await render({ ...input, cursor: "cursor-5" }, load); expect(load).toHaveBeenCalledTimes(3);
    await render({ ...input, scope: "new-owner", enabled: false }, load); expect(chasing).toBe(false);
  });

  it("retires a delayed old-owner failure without exhausting the new history", async () => {
    let reject!: (error: Error) => void;
    const load = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    await render(input, load);
    const oldReject = reject;
    await render({ ...input, scope: "new-owner", loading: true }, load);
    await act(async () => oldReject(new Error("late")));
    await render({ ...input, scope: "new-owner", cursor: "new-cursor" }, load);
    expect(load).toHaveBeenCalledTimes(2); expect(chasing).toBe(true);
  });
});
