// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TimelineItemView, ToolCallView } from "../model.js";
import { ToolBlock } from "./Timeline.js";
import type { Translator } from "./types.js";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("Timeline tool presentation", () => {
  it("renders a readable action and stable primary parameter without hiding payload or state", async () => {
    await renderTool("command", "$: git status --short", "running");

    expect(heading()).toEqual(["Run command", "git status --short · Running"]);
    expect(host.querySelector("details")?.hasAttribute("open")).toBe(true);
    expect(host.querySelector(".tool-block__detail")?.textContent).toContain("$: git status --short");

    await renderTool("Read", '$: {"file_path":"src/main.ts"}', "succeeded");
    expect(heading()).toEqual(["Read file", "src/main.ts · Completed"]);
    expect(host.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  it("covers search, MCP, and delegated-task families", async () => {
    await renderTool("Grep", '{"pattern":"TODO","path":"src"}', "waiting");
    expect(heading()).toEqual(["Search files", "TODO · Waiting"]);

    await renderTool("mcp__records__lookup_customer", '$: {"query":"Acme"}', "succeeded");
    expect(heading()).toEqual(["Call tool", "records · lookup customer — Acme · Completed"]);

    await renderTool("subagent", '{"title":"Verify release"}', "failed");
    expect(heading()).toEqual(["Delegate task", "Verify release · Failed"]);
  });

  it("preserves the original tool name and raw payload for an unknown shape", async () => {
    await renderTool("custom_runtime_tool", '$: {"path":"src/main.ts"}', "failed");

    expect(heading()).toEqual(["custom_runtime_tool", "Failed"]);
    expect(host.querySelector(".tool-block__detail")?.textContent).toContain('$: {"path":"src/main.ts"}');
  });
});

async function renderTool(name: string, input: string, state: ToolCallView["state"]): Promise<void> {
  const item: TimelineItemView = {
    id: "tool-call",
    sequence: 1n,
    kind: state === "succeeded" || state === "failed" ? "toolResult" : "tool",
    createdAt: 1,
    tool: { id: "tool-call", name, state, input, isError: state === "failed" }
  };
  await act(async () => root.render(<ToolBlock
    item={item}
    locale="en"
    t={t}
    onArtifactUrl={async () => ""}
    onArtifactDownload={async () => "dispatched"}
  />));
}

function heading(): readonly [string | null | undefined, string | null | undefined] {
  return [
    host.querySelector(".tool-block__heading strong")?.textContent,
    host.querySelector(".tool-block__heading small")?.textContent
  ];
}

const messages: Readonly<Record<string, string>> = {
  "timeline.toolAction.runCommand": "Run command",
  "timeline.toolAction.readFile": "Read file",
  "timeline.toolAction.searchFiles": "Search files",
  "timeline.toolAction.callTool": "Call tool",
  "timeline.toolAction.delegateTask": "Delegate task",
  "timeline.waitingPermission": "Waiting",
  "timeline.running": "Running",
  "timeline.completed": "Completed",
  "timeline.failed": "Failed",
  "timeline.toolPayloadOpen": "View payload",
  "common.input": "Input"
};

const t: Translator = (key) => messages[key] ?? key;
