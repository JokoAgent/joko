// @vitest-environment jsdom
import { act, createElement, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileNewTaskWorktree } from "./MobileNewTaskWorktree";
import type { MobileAutomationWorktreeProof } from "./mobile-automation-authoring";
import type { MobileNewTaskWorktree as WorktreeSelection } from "./new-task-draft-store";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("react-native", async () => {
  const React = await import("react");
  return { StyleSheet: { create: (value: unknown) => value },
    View: ({ children, testID }: { children: React.ReactNode; testID?: string }) => React.createElement("div", { "data-testid": testID }, children),
    Text: ({ children, accessibilityRole }: { children: React.ReactNode; accessibilityRole?: string }) => React.createElement("span", { role: accessibilityRole }, children),
    Pressable: ({ children, accessibilityLabel, accessibilityRole, accessibilityState, disabled, onPress }: {
      children: React.ReactNode; accessibilityLabel: string; accessibilityRole: string;
      accessibilityState: { checked?: boolean }; disabled: boolean; onPress(): void;
    }) => React.createElement("button", { "aria-label": accessibilityLabel, role: accessibilityRole,
      "aria-checked": accessibilityState.checked, disabled, onClick: onPress }, children) };
});
const colors = { border: "#ddd", surface: "#fff", brandBackground: "#efe", ink: "#111", negative: "#900", muted: "#666" };
const changed = vi.fn();
let root: Root, host: HTMLDivElement;
type Props = Pick<ComponentProps<typeof MobileNewTaskWorktree>, "ownerKey" | "load">;
function Harness(props: Props) {
  const [value, setValue] = useState<WorktreeSelection>();
  return createElement(MobileNewTaskWorktree, { ...props, value, colors, locale: "en", disabled: false,
    onChange: next => { changed(next); setValue(next); } });
}
function proof(name: string): MobileAutomationWorktreeProof {
  return { targetId: "project", eligibility: "eligible", canRefreshRemote: true,
    sources: [{ ref: `refs/heads/${name}`, displayName: name, commit: "a".repeat(40), remote: false, current: false }] };
}
beforeEach(() => { changed.mockClear(); host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(props: Props) { await act(async () => root.render(createElement(Harness, props))); }
async function press(label: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(button).not.toBeNull(); expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}

it("selects an isolated task and an exact source branch, then retains remote refresh only when explicitly chosen", async () => {
  await render({ ownerKey: "node-project", load: async () => proof("review") });
  await press("Isolated Worktree"); await press("review"); await press("Refresh remote before run");
  expect(changed.mock.calls.map(([value]) => value)).toEqual([
    { refreshRemote: false }, { refreshRemote: false, sourceRef: "refs/heads/review" },
    { refreshRemote: true, sourceRef: "refs/heads/review" }
  ]);
  await press("Isolated Worktree");
  expect(changed).toHaveBeenLastCalledWith(undefined);
});

it("cancels an old owner's lookup and never adopts its branches into the next project", async () => {
  let resolveOld!: (value: MobileAutomationWorktreeProof) => void, oldSignal!: AbortSignal;
  await render({ ownerKey: "old-node-project", load: signal => {
    oldSignal = signal; return new Promise(resolve => { resolveOld = resolve; });
  } });
  await render({ ownerKey: "current-node-project", load: async () => proof("current") });
  expect(oldSignal.aborted).toBe(true);
  await act(async () => resolveOld(proof("stale")));
  await press("Isolated Worktree");
  expect(host.querySelector('[aria-label="current"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="stale"]')).toBeNull();
});
