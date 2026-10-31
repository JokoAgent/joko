// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { TaskTagColor, TaskTagSchema } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { MobileTaskTagReorderList } from "./MobileTaskTagReorderList";

const native = vi.hoisted(() => ({ state: "active", row: 0, responders: [] as Array<Record<string, (...args: any[]) => any>>,
  listeners: new Set<(state: string) => void>(), scroll: vi.fn() }));
vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    AppState: { get currentState() { return native.state; }, addEventListener: (_name: string, listener: (state: string) => void) => {
      native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
    } },
    PanResponder: { create: (handlers: Record<string, (...args: any[]) => any>) => { native.responders.push(handlers); return { panHandlers: {} }; } },
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    View: ({ children, onLayout }: { children?: ReactNode; onLayout?: (event: unknown) => void }) => {
      const row = React.useRef(onLayout ? native.row++ : 0);
      React.useEffect(() => { onLayout?.({ nativeEvent: { layout: { y: row.current * 66, height: 56 } } }); }, []);
      return React.createElement("div", {}, children);
    },
    Text: ({ children }: { children?: ReactNode }) => React.createElement("span", {}, children),
    Pressable: ({ children, onPress, disabled }: { children?: ReactNode; onPress: () => void; disabled: boolean }) =>
      React.createElement("button", { onClick: onPress, disabled }, children),
    ScrollView: React.forwardRef(({ children }: { children?: ReactNode }, ref) => {
      React.useImperativeHandle(ref, () => ({ scrollTo: native.scroll, getNativeScrollRef: () => ({
        measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 100, 300, 160)
      }) }));
      return React.createElement("div", {}, children);
    })
  };
});
afterEach(() => { native.state = "active"; native.row = 0; native.responders = []; native.listeners.clear(); native.scroll.mockReset(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("requires a held handle, commits one exact reorder, and cancels background or catalog retirement", async () => {
  vi.useFakeTimers(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const frames = new Map<number, FrameRequestCallback>(); let sequence = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host);
  const reorder = vi.fn(), sorting = vi.fn();
  const tags = ["one", "two"].map(taskTagId => create(TaskTagSchema, { taskTagId, name: taskTagId, color: TaskTagColor.BLUE }));
  const render = async (revision = 7n) => act(async () => root.render(createElement(MobileTaskTagReorderList, {
    tags, revision, visible: true, busy: false, attached: new Set<string>(), colors: { background: "#fff", surface: "#fff", ink: "#111",
      muted: "#777", border: "#ddd", accent: "#f90", brandBackground: "#ffe", negative: "#b00" }, locale: "en",
    palette: { [TaskTagColor.BLUE]: "#00f" }, name: tag => tag.name, onToggle: vi.fn(), onEdit: vi.fn(), onReorder: reorder, onSortingChange: sorting
  })));
  const tick = async () => act(async () => { const ready = [...frames.values()]; frames.clear(); ready.forEach(callback => callback(0)); });
  try {
    await render(); const handle = native.responders[0]!;
    await act(async () => { handle.onPanResponderGrant!({}, { y0: 125 }); handle.onPanResponderRelease!(); await vi.advanceTimersByTimeAsync(300); });
    expect(reorder).not.toHaveBeenCalled(); expect(sorting).not.toHaveBeenCalledWith(true);
    await act(async () => { handle.onPanResponderGrant!({}, { y0: 125 }); await vi.advanceTimersByTimeAsync(250); });
    expect(sorting).toHaveBeenLastCalledWith(true);
    await act(async () => handle.onPanResponderMove!({}, { moveY: 210 })); await tick();
    expect([...host.querySelectorAll("button")].every(button => button.disabled)).toBe(true);
    await act(async () => { handle.onPanResponderRelease!(); handle.onPanResponderRelease!(); });
    expect(reorder).toHaveBeenCalledExactlyOnceWith("one", 1, ["one", "two"], 7n);
    await act(async () => { handle.onPanResponderGrant!({}, { y0: 125 }); await vi.advanceTimersByTimeAsync(250); });
    await act(async () => { native.state = "background"; native.listeners.forEach(listener => listener("background")); handle.onPanResponderRelease!(); });
    expect(reorder).toHaveBeenCalledOnce();
    native.state = "active";
    await act(async () => { handle.onPanResponderGrant!({}, { y0: 125 }); await vi.advanceTimersByTimeAsync(250); });
    await render(8n); await act(async () => handle.onPanResponderRelease!());
    expect(reorder).toHaveBeenCalledOnce();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
