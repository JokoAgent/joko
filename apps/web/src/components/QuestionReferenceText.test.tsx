// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { QuestionReferenceText } from "./QuestionReferenceText.js";

it("opens question evidence without forwarding answer shortcuts or choosing the enclosing option", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div")), root = createRoot(host);
  const choose = vi.fn(), shortcut = vi.fn(), open = vi.fn(async () => undefined);
  try {
    await act(async () => root.render(<div onClick={choose} onKeyDown={shortcut}>
      <QuestionReferenceText text="Read [evidence](https://example.com/a), then choose 1."
        actions={{ ownerKey: "question", sessionId: "task", t: key => key, onOpenHttpLink: open }} />
    </div>));
    const anchor = host.querySelector("a")!;
    await act(async () => {
      anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true }));
      anchor.click();
    });
    expect(open).toHaveBeenCalledOnce(); expect(choose).not.toHaveBeenCalled(); expect(shortcut).not.toHaveBeenCalled();
    expect(host.textContent).toContain(", then choose 1.");
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
