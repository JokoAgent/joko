// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageUsageMeta } from "./MessageUsageMeta.js";
import { TOOLTIP_DELAY_MS } from "./ui.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key, values) => key === "timeline.usageTokens"
  ? `${String(values?.["tokens"])} tokens`
  : `${key}${values === undefined ? "" : ` ${JSON.stringify(values)}`}`;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("message usage meta", () => {
  it("matches the delayed hover/focus detail interaction and token fallback", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<MessageUsageMeta t={t} usage={{
      inputTokens: 900,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_000,
      cost: 0,
      currency: "USD"
    }} />));
    const meta = host.querySelector<HTMLElement>(".message-usage-meta")!;
    expect(meta.textContent).toBe("1.0k tokens");
    act(() => meta.focus());
    act(() => vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1));
    expect(document.body.querySelector("[role=tooltip]")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(document.body.querySelector("[role=tooltip]")?.textContent).toContain("timeline.usageTokenLine");
    expect(meta.getAttribute("aria-describedby")).not.toBeNull();
    act(() => meta.blur());
    expect(document.body.querySelector("[role=tooltip]")).toBeNull();
  });
});
