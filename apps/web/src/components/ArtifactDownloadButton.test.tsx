// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ArtifactDownloadContext } from "../model.js";
import { ArtifactDownloadButton } from "./ArtifactDownloadButton.js";

let root: Root | undefined;
beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
  if (root !== undefined) await act(async () => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("owns the triggering Document, retires pending source ABA and connection work, and unlocks cancelled requests without accepting their late results", async () => {
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const ownerDocument = iframe.contentDocument!;
  const host = ownerDocument.body.appendChild(ownerDocument.createElement("div"));
  root = createRoot(host);
  let connection = {};
  let source = "a";
  const attempts: { readonly context: ArtifactDownloadContext; readonly task: ReturnType<typeof deferred<unknown>> }[] = [];
  const action = vi.fn((context: ArtifactDownloadContext) => {
    const task = deferred<unknown>();
    attempts.push({ context, task });
    return task.promise;
  });
  const render = () => act(async () => root!.render(<StrictMode><ArtifactDownloadButton ownerKey={source} connectionOwner={connection} label="Save" errorLabel="Save failed" action={action} /></StrictMode>));
  const button = () => host.querySelector<HTMLButtonElement>("button")!;
  await render();
  button().focus();
  await act(async () => { button().click(); button().click(); });
  expect(action).toHaveBeenCalledTimes(1);
  expect(attempts[0]!.context.ownerDocument).toBe(ownerDocument);
  expect(button().getAttribute("aria-busy")).toBe("true");
  await render();
  expect(attempts[0]!.context.signal.aborted).toBe(false);
  source = "b";
  await render();
  source = "a";
  await render();
  expect(attempts[0]!.context.signal.aborted).toBe(true);
  await act(async () => button().click());
  await act(async () => attempts[0]!.task.reject(new Error("late a")));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(button().getAttribute("aria-busy")).toBe("true");
  await act(async () => ownerDocument.defaultView!.dispatchEvent(new Event("pagehide")));
  expect(attempts[1]!.context.signal.aborted).toBe(true);
  expect(button().getAttribute("aria-busy")).toBe("false");
  await act(async () => { ownerDocument.defaultView!.dispatchEvent(new Event("pageshow")); button().click(); });
  await act(async () => attempts[1]!.task.resolve("saved"));
  expect(button().getAttribute("aria-busy")).toBe("true");
  await act(async () => attempts[2]!.task.reject(new Error("current save failed")));
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Save failed");
  expect(ownerDocument.activeElement).toBe(button());
  await act(async () => button().click());
  await act(async () => attempts[3]!.task.resolve("cancelled"));
  expect(button().getAttribute("aria-busy")).toBe("false");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => button().click());
  connection = {};
  await render();
  expect(attempts[4]!.context.signal.aborted).toBe(true);
  await act(async () => attempts[4]!.task.reject(new Error("old connection")));
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => button().click());
  await act(async () => root!.unmount());
  root = undefined;
  expect(attempts[5]!.context.signal.aborted).toBe(true);
  await act(async () => attempts[5]!.task.resolve("saved"));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
