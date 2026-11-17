// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { TimelineItemView } from "../model.js";
import { ThinkingBlock } from "./Timeline.js";
import type { Translator } from "./types.js";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.body.appendChild(document.createElement("div")); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
const t: Translator = (key, values) => ({ "timeline.thinking": "Thinking", "timeline.thinkingHidden": "Thinking hidden",
  "timeline.thinkingDuration": `Thinking · ${values?.seconds}s` } as Record<string, string>)[key] ?? key;
const item: TimelineItemView = { id: "original-block", kind: "thinking", sequence: 1n, createdAt: 1_000, text: "Draft thinking", streaming: true };

it("ends the active thinking pulse while the task continues and displays only a supplied phase duration", async () => {
  await act(async () => root.render(<ThinkingBlock item={item} locale="en" t={t} />));
  expect(host.querySelector(".thinking-pulse")).not.toBeNull();
  await act(async () => root.render(<ThinkingBlock item={{ ...item, text: "Final reasoning", streaming: false, thinkingCompleted: true, thinkingDurationMs: 2_500 }} locale="en" t={t} />));
  expect(host.querySelector(".thinking-pulse")).toBeNull();
  expect(host.querySelector("summary")?.textContent).toContain("Thinking · 2s");
  expect(host.textContent).toContain("Final reasoning");
  await act(async () => root.render(<ThinkingBlock item={{ ...item, streaming: false, thinkingCompleted: true }} locale="en" t={t} />));
  expect(host.querySelector("summary")?.textContent).not.toContain("0s");
  expect(host.querySelector("summary")?.textContent).not.toContain("2s");
});

it("withholds a redacted thinking body even when a renderer receives text alongside the redaction", async () => {
  await act(async () => root.render(<ThinkingBlock item={{ ...item, text: "PRIVATE REASONING", streaming: false, thinkingRedacted: true }} locale="en" t={t} />));
  expect(host.textContent).not.toContain("PRIVATE REASONING");
  expect(host.textContent).toContain("Thinking hidden");
});
