// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type {
  SubagentChildRunView,
  SubagentRunDetailView,
  SubagentRunView,
  SubagentTranscriptEntryView
} from "../model.js";
import { SubagentsPanel } from "./SubagentsPanel.js";

const roots: Root[] = [];
const LARGE_RECORD_SIZE = 20_000;
const MAXIMUM_EXPECTED_VIRTUAL_ROWS = 150;
const MINIMUM_TRANSCRIPT_CONTENT_BYTES = 50 * 1024 * 1024;
const MAXIMUM_ACCEPTABLE_HEAP_GROWTH_BYTES = 256 * 1024 * 1024;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("SubagentsPanel bounded rendering", () => {
  it("keeps a manually paged 20,000-run list bounded without fetching an implicit page", async () => {
    const firstPage = makeRuns(0, LARGE_RECORD_SIZE / 2);
    const secondPage = makeRuns(LARGE_RECORD_SIZE / 2, LARGE_RECORD_SIZE / 2);
    const listSubagentRuns = vi.fn(async (_sessionId: string, _state: unknown, pageToken: string) => pageToken === ""
      ? { runs: firstPage, nextPageToken: "older", totalSize: LARGE_RECORD_SIZE }
      : { runs: secondPage, totalSize: LARGE_RECORD_SIZE });
    const controller = { listSubagentRuns } as unknown as AppController;
    const container = await mount(controller);

    expect(listSubagentRuns).toHaveBeenCalledTimes(1);
    expectBoundedRows(container, ".subagents-run-row");
    await act(async () => container.querySelector<HTMLButtonElement>(".subagents-run-list__more")?.click());
    await settle(32);

    expect(listSubagentRuns).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".subagents-panel__header")?.textContent).toContain("20000 of 20000");
    expectBoundedRows(container, ".subagents-run-row");
  });

  it("bounds renderer heap and conversation, child and technical DOM for a 20,000-entry 50 MiB record", async () => {
    const heapBefore = currentHeapUsed();
    const entries = makeTranscript();
    const children = makeChildren();
    const selectedRun = run("scale-run", "Scale record", 0);
    const detail: SubagentRunDetailView = {
      run: selectedRun,
      children,
      childrenObserved: true,
      activity: Array.from({ length: LARGE_RECORD_SIZE }, (_, index) => ({
        sequence: index + 1,
        kind: "progress" as const,
        state: "completed" as const,
        summary: `activity-${index}`,
        occurredAt: index + 1
      }))
    };
    const controller = {
      listSubagentRuns: vi.fn(async () => ({ runs: [selectedRun], totalSize: 1 })),
      getSubagentRun: vi.fn(async () => detail),
      listSubagentTranscript: vi.fn(async () => ({ entries, tailPageToken: "tail", totalSize: entries.length }))
    } as unknown as AppController;
    const container = await mount(controller, { focusRunId: selectedRun.id, focusRequestId: 1 });

    expect(entries.reduce((total, entry) => total + entry.content.length, 0)).toBeGreaterThanOrEqual(MINIMUM_TRANSCRIPT_CONTENT_BYTES);
    expectBoundedRows(container, ".subagent-conversation__row");
    expectBoundedRows(container, ".subagent-child-tabs__row");
    expectBoundedRows(container, ".subagent-children__row");

    await act(async () => container.querySelector<HTMLElement>(".subagent-technical > summary")?.click());
    await settle(16);
    expectBoundedRows(container, ".subagent-technical__row");
    const heapAfter = currentHeapUsed();
    if (heapBefore !== undefined && heapAfter !== undefined) {
      expect(heapAfter - heapBefore).toBeLessThan(MAXIMUM_ACCEPTABLE_HEAP_GROWTH_BYTES);
    }
  }, 20_000);
});

function expectBoundedRows(container: HTMLElement, selector: string): void {
  const count = container.querySelectorAll(selector).length;
  expect(count).toBeGreaterThan(0);
  expect(count).toBeLessThanOrEqual(MAXIMUM_EXPECTED_VIRTUAL_ROWS);
}

function makeRuns(start: number, count: number): readonly SubagentRunView[] {
  return Array.from({ length: count }, (_, offset) => run(`run-${start + offset}`, `Run ${start + offset}`, start + offset));
}

function makeChildren(): readonly SubagentChildRunView[] {
  return Array.from({ length: LARGE_RECORD_SIZE }, (_, index) => ({
    id: `child-${index}`,
    identityAliases: [],
    title: `Child ${index}`,
    state: "completed" as const,
    startedAt: index,
    endedAt: index + 1
  }));
}

function makeTranscript(): readonly SubagentTranscriptEntryView[] {
  const payloadSize = Math.ceil(MINIMUM_TRANSCRIPT_CONTENT_BYTES / LARGE_RECORD_SIZE);
  const bytes = new Uint8Array(payloadSize).fill(120);
  const decoder = new TextDecoder();
  return Array.from({ length: LARGE_RECORD_SIZE }, (_, index) => {
    const marker = index.toString(36).padStart(8, "0");
    for (let offset = 0; offset < marker.length; offset += 1) bytes[offset] = marker.charCodeAt(offset);
    const common = { id: `entry-${index}`, sequence: index + 1, content: decoder.decode(bytes), occurredAt: index + 1 };
    if (index % 4 === 0) return { ...common, role: "parent" as const };
    if (index % 4 === 1) return { ...common, role: "subagent" as const, childId: `child-${index}` };
    if (index % 4 === 2) return { ...common, role: "tool" as const, toolName: "read", toolCallId: `tool-${index}`, toolPhase: "end" as const };
    return { ...common, role: "system" as const, systemEvent: { kind: "future-event", params: [] } };
  });
}

function currentHeapUsed(): number | undefined {
  const runtime = (globalThis as typeof globalThis & {
    readonly process?: { readonly memoryUsage?: () => { readonly heapUsed: number } };
  }).process;
  return runtime?.memoryUsage?.().heapUsed;
}

function run(id: string, title: string, updatedAt: number): SubagentRunView {
  return {
    id,
    sessionId: "session-scale",
    identityAliases: [],
    providerRunIds: [],
    state: "completed",
    title,
    capabilities: {
      viewActivity: true,
      viewReturnedResult: true,
      viewFullTranscript: true,
      stop: false,
      steer: false,
      followUp: false,
      resume: false,
      parentContext: "snapshot"
    },
    startedAt: updatedAt,
    updatedAt,
    revision: 1n
  };
}

async function mount(controller: AppController, focus?: { readonly focusRunId?: string; readonly focusRequestId?: number }): Promise<HTMLDivElement> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<SubagentsPanel
    controller={controller}
    sessionId="session-scale"
    {...focus}
    locale="en"
    t={(key, values) => translate("en", key, values)}
    runAction={(_key, action) => { void action(); }}
  />));
  await settle(32);
  return container;
}

async function settle(rounds = 8): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}
