// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import type { SessionTitleSuggestionView, SessionView } from "../model.js";
import { RenameSessionDialog } from "./SessionDialogs.js";

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  vi.unstubAllGlobals();
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("RenameSessionDialog", () => {
  it("fills and selects a generated title without submitting it", async () => {
    const onRename = vi.fn();
    const onSuggest = vi.fn(async () => ({ title: "Generated title", status: "ok" as const }));
    await renderDialog({ onRename, onSuggest });

    await act(async () => magicButton().click());
    const input = nameInput();
    expect(input.value).toBe("Generated title");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("Generated title".length);
    expect(onRename).not.toHaveBeenCalled();

    await act(async () => input.form?.requestSubmit());
    expect(onRename).toHaveBeenCalledWith("Generated title");
  });

  it("discards a late result after cancellation", async () => {
    const result = deferred<SessionTitleSuggestionView>();
    const onClose = vi.fn();
    await renderDialog({ onClose, onSuggest: vi.fn(() => result.promise) });
    await act(async () => magicButton().click());
    await act(async () => cancelButton().click());
    await act(async () => result.resolve({ title: "Too late", status: "ok" }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(nameInput().value).toBe("Existing title");
  });

  it("shows typed generation failure semantics", async () => {
    await renderDialog({
      onSuggest: vi.fn(async () => ({ title: "", status: "provider_unavailable" as const }))
    });
    await act(async () => magicButton().click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
  });
});

async function renderDialog(overrides: {
  readonly onClose?: () => void;
  readonly onRename?: (name: string) => void;
  readonly onSuggest?: (signal: AbortSignal) => Promise<SessionTitleSuggestionView>;
}): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<RenameSessionDialog
    session={session()}
    t={(key, values) => translate("en", key, values)}
    onClose={overrides.onClose ?? vi.fn()}
    onRename={overrides.onRename ?? vi.fn()}
    onSuggest={overrides.onSuggest}
  />));
}

function session(): SessionView {
  return {
    id: "session-a",
    backendId: "pi",
    targetId: "target-a",
    name: "Existing title",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 0n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1
  };
}

function magicButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Generate title"]');
  if (button === null) throw new Error("missing title generation button");
  return button;
}

function cancelButton(): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent === "Cancel");
  if (button === undefined) throw new Error("missing cancel button");
  return button;
}

function nameInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(".rename-session input");
  if (input === null) throw new Error("missing rename input");
  return input;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
