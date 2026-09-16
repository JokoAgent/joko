// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TimelineItemView } from "../model.js";
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

describe("Timeline native file changes", () => {
  it("shows the exact move identity and action in the tool heading", async () => {
    await renderTool([{ path: "src/old.ts", kind: { type: "update", movePath: "src/new.ts" }, diff: "-old\n+new" }]);

    expect(host.querySelector(".tool-block__heading strong")?.textContent).toBe("src/old.ts → src/new.ts");
    expect(host.querySelector(".tool-block__heading small")?.textContent).toBe("Renamed · Running");
  });

  it("opens the complete ordered multi-file diff payload", async () => {
    await renderTool([
      { path: "src/old.ts", kind: { type: "update", movePath: "src/new.ts" }, diff: "-old\n+new" },
      { path: "src/added.ts", kind: { type: "add" }, diff: "+added" }
    ]);

    expect(host.querySelector(".tool-block__heading strong")?.textContent).toBe("2 changed files");
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="View payload · Input"]')?.click());
    const select = document.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="View file"]');
    expect(select).not.toBeNull();
    await act(async () => select?.click());
    expect([...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')].map((option) => option.textContent)).toEqual([
      "All files",
      "src/old.ts → src/new.ts",
      "src/added.ts"
    ]);
  });
});

async function renderTool(changes: readonly unknown[]): Promise<void> {
  const item: TimelineItemView = {
    id: "file-change",
    sequence: 1n,
    kind: "tool",
    createdAt: 1,
    tool: {
      id: "file-change",
      name: "file_change",
      state: "running",
      input: JSON.stringify({ changes }),
      isError: false
    }
  };
  await act(async () => root.render(<ToolBlock
    item={item}
    locale="en"
    t={t}
    onArtifactUrl={async () => ""}
    onArtifactDownload={async () => "dispatched"}
  />));
}

const t: Translator = (key, values) => {
  if (key === "timeline.fileChangeFiles") return `${values?.["count"]} changed files`;
  const messages: Partial<Record<string, string>> = {
    "timeline.fileChange.moved": "Renamed",
    "timeline.running": "Running",
    "timeline.toolPayloadOpen": "View payload",
    "timeline.toolPayloadChooseFile": "View file",
    "timeline.toolPayloadAllFiles": "All files",
    "common.input": "Input"
  };
  return messages[key] ?? key;
};
