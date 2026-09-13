// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import type { SessionView, TimelineItemView } from "../model.js";
import { InspectorShellPanel } from "./Inspector.js";
import type { Translator } from "./types.js";

const roots: Root[] = [];
const t: Translator = (key, values) => translate("en", key, values);

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("Inspector runtime shell", () => {
  it("runs an exact command, forwards the context choice, and offers a bounded abort", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const executeUserShell = vi.fn(() => pending);
    const abortUserShell = vi.fn(async () => undefined);
    const { container } = await renderShell({ executeUserShell, abortUserShell }, []);
    const textarea = required(container.querySelector<HTMLTextAreaElement>("textarea"));
    setTextareaValue(textarea, "  pnpm test  ");
    await act(async () => required(container.querySelector<HTMLButtonElement>('button[role="checkbox"]')).click());
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));

    expect(executeUserShell).toHaveBeenCalledWith("session-one", "pnpm test", true);
    expect(textarea.disabled).toBe(true);
    const abort = buttonWithText(container, t("composer.shellAbort"));
    await act(async () => abort.click());
    expect(abortUserShell).toHaveBeenCalledWith("session-one");

    await act(async () => finish());
    expect(textarea.value).toBe("");
  });

  it("projects only durable Shell tool activity and keeps multiline entry available with Shift+Enter", async () => {
    const executeUserShell = vi.fn(async () => undefined);
    const { container } = await renderShell({ executeUserShell, abortUserShell: vi.fn(async () => undefined) }, [
      shellTimeline("shell", "pwd", "D:\\workspace", "succeeded"),
      toolTimeline("other", "Browser", "ignored")
    ]);

    expect(container.textContent).toContain("D:\\workspace");
    expect(container.textContent).not.toContain("ignored");
    const textarea = required(container.querySelector<HTMLTextAreaElement>("textarea"));
    setTextareaValue(textarea, "first line");
    await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true })));
    expect(executeUserShell).not.toHaveBeenCalled();
  });
});

async function renderShell(methods: {
  readonly executeUserShell: (sessionId: string, command: string, excludeFromContext: boolean) => Promise<void>;
  readonly abortUserShell: (sessionId: string) => Promise<void>;
}, timeline: readonly TimelineItemView[]): Promise<{ readonly container: HTMLElement }> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  const controller = methods as unknown as AppController;
  await act(async () => root.render(<InspectorShellPanel
    controller={controller}
    session={session()}
    timeline={timeline}
    t={t}
    runAction={(_key, action) => { void action(); }}
  />));
  return { container };
}

function session(): SessionView {
  return {
    id: "session-one",
    backendId: "backend-one",
    targetId: "target-one",
    name: "Task",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 1n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1
  };
}

function shellTimeline(id: string, input: string, output: string, state: NonNullable<TimelineItemView["tool"]>["state"]): TimelineItemView {
  return {
    id,
    sequence: 1n,
    kind: "toolResult",
    createdAt: 1,
    tool: { id, name: "Shell", state, input, output, isError: state === "failed" }
  };
}

function toolTimeline(id: string, name: string, output: string): TimelineItemView {
  return {
    id,
    sequence: 2n,
    kind: "toolResult",
    createdAt: 2,
    tool: { id, name, state: "succeeded", input: "", output, isError: false }
  };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("Expected the native textarea value setter.");
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  return required([...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((candidate) => candidate.textContent?.includes(text)));
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected rendered value.");
  return value;
}
