// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SentPastedTextInline } from "./SentPastedTextInline.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key, values) => key === "composer.pastedTextLineCount"
  ? `${String(values?.["count"])} lines`
  : key;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("sent pasted-text inline chip", () => {
  it("keeps surrounding text compact and opens the full read-only payload", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<SentPastedTextInline ownerKey="task" t={t} segment={{
      text: "before\nfirst\nsecond\nafter",
      projectedText: "before\nPasted text (2 lines)\nafter",
      tokens: [
        { kind: "text", text: "before\n" },
        { kind: "pasted", text: "first\nsecond", display: "Pasted text (2 lines)" },
        { kind: "text", text: "\nafter" }
      ]
    }} />));
    expect(host.textContent).toBe("before\nPasted text (2 lines)\nafter");
    act(() => host.querySelector<HTMLButtonElement>(".message-user__pasted-text-chip")?.click());
    expect(document.querySelector("[role=dialog]")).not.toBeNull();
    expect(document.querySelector("pre")?.textContent).toBe("first\nsecond");
    expect(document.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBeNull();
  });

  it("retires the open payload when its message owner changes and does not revive it on return", async () => {
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    roots.push(root);
    const segment = { text: "full text", projectedText: "Pasted text", tokens: [{ kind: "pasted" as const, text: "full text", display: "Pasted text" }] };
    const render = (ownerKey: string) => act(async () => root.render(<SentPastedTextInline ownerKey={ownerKey} segment={segment} t={t} />));
    await render("first");
    act(() => document.querySelector<HTMLButtonElement>(".message-user__pasted-text-chip")!.click());
    expect(document.querySelector("pre")?.textContent).toBe("full text");
    await render("second");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await render("first");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
