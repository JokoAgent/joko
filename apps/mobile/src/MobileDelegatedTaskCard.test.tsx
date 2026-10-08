// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import {
  SubagentRunDetailSchema, SubagentRunSchema, SubagentRunState, SubagentToolPhase, SubagentTranscriptEntrySchema, SubagentTranscriptRole
} from "@joko/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileDelegatedControls, MobileDelegatedReadClient } from "./mobile-delegated-reader";

const native = vi.hoisted(() => ({ listeners: new Set<(state: string) => void>() }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("./MobileMarkdownMessage", () => ({ MobileMarkdownMessage: ({ text }: { text: string }) => createElement("div", { "data-markdown": true }, text) }));
vi.mock("react-native", () => {
  const box = ({ children }: { children?: ReactNode }) => createElement("div", {}, children);
  return { View: box, ScrollView: box, Text: ({ children }: { children?: ReactNode }) => createElement("span", {}, children),
    Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => visible ? createElement("div", { role: "dialog" }, children) : null,
    Pressable: ({ children, onPress, accessibilityLabel, accessibilityState, disabled, style }: { children?: ReactNode; onPress?: () => void;
      accessibilityLabel?: string; accessibilityState?: { expanded?: boolean; selected?: boolean }; disabled?: boolean; style?: unknown }) =>
      createElement("button", { onClick: onPress, "aria-label": accessibilityLabel, disabled, "data-native-style": JSON.stringify(style),
        "aria-expanded": accessibilityState?.expanded, "aria-pressed": accessibilityState?.selected }, children),
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    AppState: { currentState: "active", addEventListener: (_name: string, listener: (state: string) => void) => {
      native.listeners.add(listener); return { remove: () => native.listeners.delete(listener) };
    } }
  };
});
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement("div", {}, children) }));
import { MobileDelegatedTaskCard } from "./MobileDelegatedTaskCard";
import { mobileExpandedBlockStore } from "./mobile-expanded-block-memory";

const colors = { background: "#fff", surface: "#fafafa", ink: "#111", muted: "#666", border: "#ccc", accent: "#ff9800", negative: "#b00", brandBackground: "#fff4df" };
const controls: MobileDelegatedControls = { authorityKey: "authority", surfaceOwnerKey: "owner", sessionId: "session", generation: 1n,
  canListBackground: true, canListRuns: true, canReadDetail: true, canReadTranscript: true };
const run = create(SubagentRunSchema, { subagentRunId: "run", sessionId: "session", title: "Investigate", assignment: "Inspect the logs", summary: "Found a race",
  state: SubagentRunState.COMPLETED, usage: { totalTokens: 31n, toolUses: 1n }, version: { generation: 1n, revision: { value: 3n } },
  capabilities: { viewFullTranscript: true, viewReturnedResult: true, viewActivity: true } });
let host: HTMLDivElement; let root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); mobileExpandedBlockStore.reset();
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); native.listeners.clear();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT"); });

function fixture(): MobileDelegatedReadClient {
  return { taskDelegatedControls: vi.fn(() => controls), loadTaskBackgroundTasks: vi.fn(async () => ({ tasks: [], nextPageToken: "" })),
    loadTaskDelegatedRuns: vi.fn(async () => ({ runs: [run], nextPageToken: "" })),
    loadTaskDelegatedDetail: vi.fn(async () => create(SubagentRunDetailSchema, { run, returnedResult: "Found a race", children: [
      { childId: "child", title: "Worker", assignment: "Read files", state: SubagentRunState.COMPLETED, readOnly: true }
    ] })), loadTaskDelegatedTranscript: vi.fn(async () => ({ entries: [], nextPageToken: "", tailPageToken: "tail" })) };
}
async function render(client: MobileDelegatedReadClient, owner = controls, entries = [{ key: "delegated:run", run }]) {
  await act(async () => root.render(createElement(MobileDelegatedTaskCard, {
    entry: { key: "delegated:run", run }, entries, readClient: client, controls: owner, colors, locale: "en", enabled: true
  })));
}
async function click(label: string) {
  const button = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.getAttribute("aria-label") === label);
  expect(button, label).toBeDefined(); await act(async () => button!.click());
}

describe("native delegated inline card", () => {
  it("starts folded, reads assignment/result/child pages, pairs tools and keeps nested content in the card", async () => {
    const client = fixture();
    const nested = create(SubagentRunSchema, { ...run, subagentRunId: "nested", title: "Nested worker", parentSubagentRunId: "run" });
    client.loadTaskDelegatedDetail = vi.fn(async (_key, id) => create(SubagentRunDetailSchema, { run: id === "nested" ? nested : run,
      returnedResult: "Found a race", children: id === "nested" ? [] : [{ childId: "child", title: "Worker", assignment: "Read files" }] }));
    client.loadTaskDelegatedTranscript = vi.fn(async (_key, _runId, child, token) => ({ entries: token
      ? [create(SubagentTranscriptEntrySchema, { entryId: "reply", sequence: 4n, role: SubagentTranscriptRole.SUBAGENT, childId: child ?? "", content: "Last reply" })]
      : [create(SubagentTranscriptEntrySchema, { entryId: "start", sequence: 1n, role: SubagentTranscriptRole.TOOL, childId: "child",
        toolCallId: "call", toolName: "Read", toolPhase: SubagentToolPhase.START, toolInputJson: '{"path":"a.ts"}' }),
      create(SubagentTranscriptEntrySchema, { entryId: "end", sequence: 2n, role: SubagentTranscriptRole.TOOL, childId: "child",
        toolCallId: "call", toolName: "Read", toolPhase: SubagentToolPhase.END, content: "File content" })], nextPageToken: token ? "" : "more", tailPageToken: "tail" }));
    const entries = [{ key: "delegated:run", run }, { key: "delegated:nested", run: nested }];
    await render(client, controls, entries);
    expect(host.querySelector('button[aria-label="Expand Investigate"]')?.getAttribute("data-native-style")).toContain('"minHeight":44');
    expect(host.textContent).toContain("31 tokens"); expect(host.textContent).toContain("Found a race");
    expect(host.textContent).not.toContain("Inspect the logs"); expect(client.loadTaskDelegatedDetail).not.toHaveBeenCalled();
    await click("Expand Investigate"); expect(host.textContent).toContain("Inspect the logs"); expect(host.textContent).toContain("Nested worker");
    expect(host.querySelector('button[aria-label="Worker"]')?.getAttribute("data-native-style")).toContain('"minHeight":44');
    await click("Worker"); expect(host.textContent).toContain("Read files");
    expect(client.loadTaskDelegatedTranscript).toHaveBeenLastCalledWith("authority", "run", "child", "", expect.any(AbortSignal));
    await click("Load more"); expect(host.textContent).toContain("Last reply");
    await click("Expand Read"); await click("View result"); expect(host.querySelector('[role="dialog"]')?.textContent).toContain("File content");
    await click("Close"); await click("Expand Nested worker");
    expect(client.loadTaskDelegatedDetail).toHaveBeenLastCalledWith("authority", "nested", expect.any(AbortSignal));
  });

  it("cancels hidden/retired reads, exposes retry and remembers expansion only within the exact owner", async () => {
    const client = fixture(); let finish!: (value: Awaited<ReturnType<MobileDelegatedReadClient["loadTaskDelegatedDetail"]>>) => void;
    let signal!: AbortSignal;
    client.loadTaskDelegatedDetail = vi.fn((_key, _id, active) => { signal = active!; return new Promise<Awaited<ReturnType<MobileDelegatedReadClient["loadTaskDelegatedDetail"]>>>((resolve) => { finish = resolve; }); });
    await render(client); await click("Expand Investigate"); expect(host.textContent).toContain("Loading task content");
    await click("Cancel loading"); expect(signal.aborted).toBe(true); expect(host.textContent).toContain("Loading cancelled");
    finish(create(SubagentRunDetailSchema, { run, returnedResult: "Retired text" })); await act(async () => { await Promise.resolve(); });
    expect(host.textContent).not.toContain("Retired text");
    client.loadTaskDelegatedDetail = vi.fn(async () => create(SubagentRunDetailSchema, { run, returnedResult: "Current text" }));
    await click("Retry"); expect(host.textContent).toContain("Current text");
    await act(async () => root.render(null)); await render(client);
    expect(host.querySelector('button[aria-label="Collapse Investigate"]')).not.toBeNull();
    await act(async () => { for (const listener of [...native.listeners]) listener("background"); });
    expect(host.textContent).not.toContain("Current text");
    const newOwner = { ...controls, authorityKey: "new-authority", surfaceOwnerKey: "new-owner" };
    client.taskDelegatedControls = vi.fn(() => newOwner); await render(client, newOwner);
    expect(host.querySelector('button[aria-label="Expand Investigate"]')).not.toBeNull(); expect(host.textContent).not.toContain("Current text");
  });
});
