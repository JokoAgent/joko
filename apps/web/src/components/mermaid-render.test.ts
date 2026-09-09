// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { renderMermaid } from "./mermaid-render.js";

const api = vi.hoisted(() => ({ initialize: vi.fn(), parse: vi.fn(async () => true), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: api }));

it("serializes configuration through raw render settlement, retires cancelled work, and gives each live diagram distinct IDs", async () => {
  const iframe = document.body.appendChild(document.createElement("iframe"));
  const foreign = iframe.contentDocument!;
  const first = deferred<{ svg: string }>();
  api.render.mockReturnValueOnce(first.promise).mockImplementation(async (id: string) => ({ svg: `<svg id="${id}"/>` }));
  const a = new AbortController();
  const b = new AbortController();
  const c = new AbortController();
  const aResult = renderMermaid("graph LR; A-->B", "default", { ownerDocument: document, signal: a.signal }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));
  const aStaging = api.render.mock.calls[0]![2] as HTMLElement;
  const bResult = renderMermaid("graph LR; A-->B", "dark", { ownerDocument: foreign, signal: b.signal });
  const cResult = renderMermaid("graph LR; obsolete", "default", { ownerDocument: document, signal: c.signal }).catch((error: unknown) => error);
  c.abort();
  a.abort();
  await aResult;
  expect(aStaging.isConnected).toBe(false);
  expect(api.initialize).toHaveBeenCalledTimes(1);
  first.resolve({ svg: "discarded" });
  const svg = await bResult;
  await cResult;
  expect(api.initialize.mock.calls.map(([config]) => config.theme)).toEqual(["default", "dark"]);
  expect(api.render.mock.calls[1]![2].ownerDocument).toBe(foreign);
  expect(api.render.mock.calls[1]![2].isConnected).toBe(false);
  const repeated = await renderMermaid("graph LR; A-->B", "dark", { ownerDocument: foreign, signal: b.signal });
  expect(repeated).not.toBe(svg);
  expect(api.render).toHaveBeenCalledTimes(3);
  expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  expect(foreign.querySelector('[aria-hidden="true"]')).toBeNull();
  iframe.remove();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
