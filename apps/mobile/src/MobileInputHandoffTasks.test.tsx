// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { SessionSchema } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import type { MobileInputHandoffTasksApi, MobileInputHandoffTask } from "./mobile-input-handoff";
vi.mock("react-native", async () => {
  const React = await import("react"); const box = ({ children }: { children?: ReactNode }) => React.createElement("div", {}, children);
  return { View: box, Text: box, Pressable: ({ children, onPress }: { children?: ReactNode; onPress(): void }) => React.createElement("button", { onClick: onPress }, children),
    AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) } };
});
import { MobileInputHandoffTasks } from "./MobileInputHandoffTasks";

it("shows only fixed owner attention for matching native tasks and ignores a previous connection reply", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host), open = vi.fn();
  const task: MobileInputHandoffTask = { sessionId: "task", requestId: "private-id", generation: 8n, stepNumber: 1 };
  let finish!: (value: readonly MobileInputHandoffTask[]) => void;
  const first: MobileInputHandoffTasksApi = { ownerKey: "first", isCurrent: () => true, list: () => new Promise(resolve => { finish = resolve; }) };
  const next: MobileInputHandoffTasksApi = { ownerKey: "next", isCurrent: () => true, list: async () => [task, { ...task, sessionId: "foreign" }] };
  const sessions = [create(SessionSchema, { sessionId: "task", displayName: "Owned task", nativeBinding: { runtimeGeneration: 8n } }),
    create(SessionSchema, { sessionId: "old", displayName: "Old task", nativeBinding: { runtimeGeneration: 7n } })];
  const render = (api: MobileInputHandoffTasksApi) => act(async () => root.render(createElement(MobileInputHandoffTasks, { api, sessions, onOpen: open, locale: "en",
    colors: { background: "#fff", surface: "#fff", ink: "#111", muted: "#777", border: "#ccc", accent: "#f80", negative: "#c00", brandBackground: "#ffe" } })));
  try {
    await render(first); await render(next); expect(host.textContent).toContain("Your input is needed"); expect(host.textContent).toContain("Owned task");
    expect(host.textContent).not.toContain("private-id"); expect(host.textContent).not.toContain("Old task");
    await act(async () => finish([{ ...task, sessionId: "old", generation: 7n }])); expect(host.textContent).not.toContain("Old task");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click()); expect(open).toHaveBeenCalledExactlyOnceWith("task");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
