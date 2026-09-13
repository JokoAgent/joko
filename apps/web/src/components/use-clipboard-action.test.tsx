// @vitest-environment jsdom
import { StrictMode, act } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserActionContext } from "../browser-action.js";
import { writeClipboardText } from "../clipboard-action.js";
import { useClipboardAction, type ClipboardActionOptions } from "./use-clipboard-action.js";

let root: Root | undefined;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
});
afterEach(async () => {
  if (root !== undefined) await act(async () => root!.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Probe({ operation, ...options }: ClipboardActionOptions & { readonly operation: (context: BrowserActionContext) => Promise<void> | void }) {
  const copy = useClipboardAction(options);
  const target = options.ownerDocument ?? document;
  return createPortal(<>
    <button aria-busy={copy.pending} onClick={() => copy.run(target, operation)}>Copy</button>
    <button onClick={copy.cancel}>Cancel</button>
    <output>{copy.state}</output>
  </>, target.body);
}
function button(target: Document, text = "Copy") {
  return [...target.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

it("admits one synchronous attempt in its actual Document and retires prepared content across source, connection, pagehide and Document changes", async () => {
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const other = iframe.contentDocument!;
  const mainClipboard = vi.fn(async () => undefined);
  const otherClipboard = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: mainClipboard } });
  Object.defineProperty(other.defaultView!.navigator, "clipboard", { configurable: true, value: { writeText: otherClipboard } });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  let ownerDocument: Document | undefined;
  let source = "first";
  let connection = {};
  const attempts: { context: BrowserActionContext; gate: ReturnType<typeof deferred<void>> }[] = [];
  const render = () => {
    const value = source;
    return act(async () => root!.render(<StrictMode><Probe ownerKey="task" sourceKey={value} connectionOwner={connection} ownerDocument={ownerDocument} operation={async (context) => {
      const gate = deferred<void>();
      attempts.push({ context, gate });
      await gate.promise;
      await writeClipboardText(value, context);
    }} /></StrictMode>));
  };
  await render();
  await act(async () => button(document).click());
  expect(attempts).toHaveLength(0);
  ownerDocument = other;
  await render();
  act(() => { button(other).click(); button(other).click(); expect(attempts).toHaveLength(1); });
  expect(attempts[0]!.context.ownerDocument).toBe(other);
  await render();
  expect(attempts[0]!.context.signal.aborted).toBe(false);
  source = "second";
  await render();
  source = "first";
  await render();
  expect(attempts[0]!.context.signal.aborted).toBe(true);
  await act(async () => button(other).click());
  await act(async () => attempts[0]!.gate.resolve());
  expect(otherClipboard).not.toHaveBeenCalled();
  expect(button(other).getAttribute("aria-busy")).toBe("true");
  await act(async () => other.defaultView!.dispatchEvent(new Event("pagehide")));
  expect(attempts[1]!.context.signal.aborted).toBe(true);
  expect(button(other).getAttribute("aria-busy")).toBe("false");
  await act(async () => { other.defaultView!.dispatchEvent(new Event("pageshow")); button(other).click(); });
  await act(async () => attempts[1]!.gate.reject(new Error("old preparation")));
  expect(other.querySelector("output")?.textContent).toBe("pending");
  connection = {};
  await render();
  expect(attempts[2]!.context.signal.aborted).toBe(true);
  await act(async () => button(other).click());
  ownerDocument = document;
  await render();
  expect(attempts[3]!.context.signal.aborted).toBe(true);
  await act(async () => button(document).click());
  await act(async () => attempts[4]!.gate.resolve());
  expect(mainClipboard).toHaveBeenCalledExactlyOnceWith("first");
  expect(document.querySelector("output")?.textContent).toBe("copied");
  await act(async () => { attempts[2]!.gate.resolve(); attempts[3]!.gate.resolve(); });
  expect(otherClipboard).not.toHaveBeenCalled();
  await act(async () => button(document).click());
  await act(async () => root!.unmount());
  root = undefined;
  expect(attempts[5]!.context.signal.aborted).toBe(true);
  await act(async () => attempts[5]!.gate.resolve());
  expect(mainClipboard).toHaveBeenCalledTimes(1);
});

it("keeps already-issued clipboard failures visible only for their current attempt and clears feedback timers without unlocking newer work", async () => {
  const writes: ReturnType<typeof deferred<void>>[] = [];
  const writeText = vi.fn(() => { const gate = deferred<void>(); writes.push(gate); return gate.promise; });
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  let operation = (context: BrowserActionContext): Promise<void> | void => writeClipboardText("payload", context);
  const render = () => act(async () => root!.render(<Probe ownerKey="task" sourceKey="payload" ownerDocument={document} operation={operation} />));
  await render();
  await act(async () => button(document).click());
  expect(writeText).toHaveBeenCalledTimes(1);
  await act(async () => button(document, "Cancel").click());
  expect(document.querySelector("output")?.textContent).toBe("idle");
  await act(async () => button(document).click());
  await act(async () => writes[0]!.reject(new Error("late OS acknowledgement")));
  expect(document.querySelector("output")?.textContent).toBe("pending");
  expect(writeText).toHaveBeenCalledTimes(2);
  await act(async () => writes[1]!.reject(new Error("denied")));
  expect(document.querySelector("output")?.textContent).toBe("failed");
  await act(async () => button(document).click());
  await act(async () => writes[2]!.resolve());
  expect(document.querySelector("output")?.textContent).toBe("copied");
  await act(async () => button(document).click());
  await act(async () => vi.advanceTimersByTime(1_600));
  expect(document.querySelector("output")?.textContent).toBe("pending");
  await act(async () => writes[3]!.resolve());
  await act(async () => vi.advanceTimersByTime(1_600));
  expect(document.querySelector("output")?.textContent).toBe("idle");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  await act(async () => button(document).click());
  expect(document.querySelector("output")?.textContent).toBe("failed");
  operation = () => { throw new Error("synchronous preparation failure"); };
  await render();
  await act(async () => button(document).click());
  expect(document.querySelector("output")?.textContent).toBe("failed");
});
