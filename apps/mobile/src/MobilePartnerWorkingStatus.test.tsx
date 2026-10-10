// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobilePartnerWorkingStatus } from "./MobilePartnerWorkingStatus";
import { profileSnapshot } from "./test/mobile-partner-profile";
import type { MobilePartnerWorkingPhase } from "./mobile-partner-working";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const native = vi.hoisted(() => ({ motion: undefined as boolean | undefined,
  queries: [] as ((value: boolean) => void)[], listeners: new Set<(value: boolean) => void>(),
  timings: [] as Record<string, unknown>[], delays: [] as number[], stopped: 0 }));
vi.mock("./MobilePartnerAvatar", async () => {
  const React = await import("react");
  return { MobilePartnerAvatar: ({ size }: { size: number }) => React.createElement("div", { "data-avatar-size": size }) };
});
vi.mock("react-native", async () => {
  const React = await import("react");
  const primitive = (tag: "div" | "span") => ({ children, testID, style, accessibilityLiveRegion }: {
    children?: ReactNode; testID?: string; style?: unknown; accessibilityLiveRegion?: string;
  }) => React.createElement(tag, { "data-testid": testID, "data-style": JSON.stringify(style),
    ...(accessibilityLiveRegion ? { "aria-live": accessibilityLiveRegion } : {}) }, children);
  class Value {
    timers = new Set<ReturnType<typeof setTimeout>>();
    constructor(readonly initial: number) {}
    setValue() {}
    interpolate(value: unknown) { return value; }
    stopAnimation() { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); native.stopped += 1; }
  }
  const composite = (parts: { stop(): void }[]) => ({ start() {}, stop() { native.stopped += 1; for (const part of parts) part.stop(); } });
  return { View: primitive("div"), Text: primitive("span"), StyleSheet: { create: (value: unknown) => value },
    AccessibilityInfo: {
      isReduceMotionEnabled: () => native.motion === undefined ? new Promise<boolean>((resolve) => native.queries.push(resolve))
        : Promise.resolve(native.motion),
      addEventListener: (_name: string, listener: (value: boolean) => void) => {
        native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
      }
    },
    Animated: { Value, View: primitive("div"), timing: (value: Value, config: Record<string, unknown>) => {
      native.timings.push(config);
      return { start: (done?: (result: { finished: boolean }) => void) => {
        if (done) { const timer = setTimeout(() => { value.timers.delete(timer); done({ finished: true }); }, Number(config["duration"])); value.timers.add(timer); }
      }, stop: () => value.stopAnimation() };
    }, sequence: composite, loop: (part: { stop(): void }) => composite([part]),
      delay: (duration: number) => { native.delays.push(duration); return composite([]); } },
    Easing: { bezier: () => "move", inOut: (value: unknown) => value, ease: "ease" } };
});

const colors = { background: "#fff", surface: "#eee", ink: "#111", muted: "#666", border: "#ddd", accent: "#287", brandBackground: "#eaf", negative: "#b00" };
let root: Root | undefined;
let container: HTMLDivElement;
function render(phase: MobilePartnerWorkingPhase, turnKey = "turn") {
  return act(async () => root!.render(createElement(MobilePartnerWorkingStatus, { key: turnKey, status: { turnKey, phase },
    partner: profileSnapshot.partner, locale: "en", colors })));
}
function setup(motion: boolean | undefined) {
  vi.useFakeTimers(); vi.setSystemTime(100_000); native.motion = motion;
  native.timings.length = 0; native.delays.length = 0; native.queries.length = 0; native.stopped = 0;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined;
  container?.remove(); native.listeners.clear(); vi.useRealTimers(); });

describe("mobile Partner live working row", () => {
  it("paces the latest factual caption while unknown or reduced motion remains still", async () => {
    setup(undefined); await render("thinking");
    expect(container.querySelector('[data-testid="partner.workingStatus"]')?.getAttribute("aria-live")).toBe("polite");
    expect(container.querySelector("[data-avatar-size]")?.getAttribute("data-avatar-size")).toBe("20");
    expect(container.querySelector('[data-testid="partner.workingDots"]')?.children).toHaveLength(3);
    expect(native.timings).toEqual([]);
    await act(async () => { for (const listener of native.listeners) listener(true); });
    await act(async () => { for (const resolve of native.queries.splice(0)) resolve(false); });
    expect(native.timings).toEqual([]);
    await act(async () => vi.advanceTimersByTime(200)); await render("reading-file");
    await act(async () => vi.advanceTimersByTime(500)); await render("saving-file");
    await act(async () => vi.advanceTimersByTime(299)); expect(container.textContent).toBe("Thinking…");
    await act(async () => vi.advanceTimersByTime(1)); expect(container.textContent).toBe("Updating files…");
    expect(native.timings).toEqual([]);
    await render("testing", "next-turn"); expect(container.textContent).toBe("Running tests…");
  });

  it("animates at native cadence, consumes the latest fade text and cancels on terminal unmount or preference change", async () => {
    setup(false); await render("thinking");
    expect(native.delays).toEqual([0, 200, 400]);
    expect(native.timings.filter((entry) => entry["duration"] === 480)).toHaveLength(3);
    expect(native.timings.filter((entry) => entry["duration"] === 720)).toHaveLength(3);
    expect(native.timings.every((entry) => entry["useNativeDriver"] === true)).toBe(true);
    await render("reading-file"); await act(async () => vi.advanceTimersByTime(1000));
    expect(container.textContent).toBe("Thinking…"); await render("checking");
    await act(async () => vi.advanceTimersByTime(150)); expect(container.textContent).toBe("Checking code…");
    expect(native.timings.some((entry) => entry["duration"] === 150 && entry["toValue"] === 0)).toBe(true);
    expect(Array.from(container.querySelectorAll("[data-style]")).some((element) =>
      element.getAttribute("data-style")?.includes('"outputRange":[3,0]'))).toBe(true);
    const stopped = native.stopped;
    await act(async () => { for (const listener of native.listeners) listener(true); });
    expect(native.stopped).toBeGreaterThan(stopped);
    await render("reading-web"); expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => root!.render(null));
    expect(container.textContent).toBe(""); expect(vi.getTimerCount()).toBe(0); expect(native.listeners.size).toBe(0);
  });
});
