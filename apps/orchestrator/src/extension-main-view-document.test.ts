import { expect, it, vi } from "vitest";
import { isolatedExtensionDocument } from "./extension-main-view-document.js";
import { extensionSourceSet } from "./extension-main-view-resource.js";

const input = (html: string, assets: Record<string, string | Buffer>) => ({ html: Buffer.from(html), entry: "index.html",
  read: vi.fn(async (path: string) => {
    if (!(path in assets)) throw new Error("Missing authorized asset: " + path);
    return { body: Buffer.from(assets[path]!), mimeType: path.endsWith(".svg") ? "image/svg+xml" : "text/plain" };
  }), assertCurrent: vi.fn(async () => {}) });

it("materializes modules, nested CSS and images without a network or filesystem resolver", async () => {
  const f = input('<html><head><script type="module" src="app.js"></script><link rel="stylesheet" href="main.css"></head><body style="background:url(./icon.svg)"><img src="icon.svg" srcset="icon.svg 1x, icon.svg 2x"></body></html>', {
    "app.js": "import { value } from './nested/value.js'; document.body.dataset.answer = value; const image = new URL('./icon.svg', import.meta.url);",
    "nested/value.js": "export const value = 'complete-module-graph';",
    "main.css": "@import './nested/colors.css';body{background:url('./icon.svg')}",
    "nested/colors.css": "body{color:rgb(1,2,3)}",
    "icon.svg": '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'
  });
  const html = (await isolatedExtensionDocument(f)).toString();
  expect(html).toContain('Content-Security-Policy');
  expect(html).toContain("connect-src 'none'");
  expect(html).toContain("data:text/javascript;base64,");
  expect(html).toContain("data:text/css;base64,");
  expect(html).toContain("data:image/svg+xml;base64,");
  expect(html).not.toContain('srcset="icon.svg');
  const script = [...html.matchAll(/data:text\/javascript;base64,([^"]+)/gu)].map(match => Buffer.from(match[1]!, "base64").toString()).find(source => source.includes("complete-module-graph"))!;
  const css = Buffer.from(/data:text\/css;base64,([^"]+)/u.exec(html)![1]!, "base64").toString();
  expect(script).toContain("complete-module-graph"); expect(script).not.toContain("import ");
  expect(script).toContain("data:image/svg+xml"); expect(script).not.toContain("./icon.svg");
  expect(css).toContain("data:image/svg+xml"); expect(css).not.toContain("@import");
  expect(f.assertCurrent.mock.calls.length).toBeGreaterThan(f.read.mock.calls.length);
});

it("preserves srcset descriptors and data URL commas while resolving each local candidate", () => {
  expect(extensionSourceSet(" icon.svg 1x, next.svg 2x, wide.png 1200w ")).toEqual([
    { url: "icon.svg", descriptor: "1x" }, { url: "next.svg", descriptor: "2x" }, { url: "wide.png", descriptor: "1200w" }
  ]);
  expect(extensionSourceSet("data:image/png;base64,AAAA 1x, next.png 2x")).toEqual([
    { url: "data:image/png;base64,AAAA", descriptor: "1x" }, { url: "next.png", descriptor: "2x" }
  ]);
});

it("refuses graph escapes, remote resources, missing nodes and cancellation", async () => {
  for (const path of ["../secret.js", "https://attacker.example/module.js", "file:///private.js", "node:fs"]) {
    const f = input('<script type="module" src="app.js"></script>', { "app.js": `import ${JSON.stringify(path)};` });
    await expect(isolatedExtensionDocument(f)).rejects.toThrow();
    expect(f.read.mock.calls.every(([path]) => path === "app.js")).toBe(true);
  }
  await expect(isolatedExtensionDocument(input('<img src="missing.svg">', {}))).rejects.toThrow(/Missing/u);
  const f = input('<script src="app.js"></script>', { "app.js": "void 0" });
  const abort = new AbortController(); abort.abort();
  await expect(isolatedExtensionDocument({ ...f, signal: abort.signal })).rejects.toThrow();
  expect(f.read).not.toHaveBeenCalled();
});

it("rejects a document retired while its asset graph is being read", async () => {
  let current = true;
  const f = input('<img src="icon.svg">', { "icon.svg": "<svg/>" });
  f.read.mockImplementation(async () => { current = false; return { body: Buffer.from("<svg/>"), mimeType: "image/svg+xml" }; });
  f.assertCurrent.mockImplementation(async () => { if (!current) throw new Error("retired"); });
  await expect(isolatedExtensionDocument(f)).rejects.toThrow(/retired/u);
});

it("routes compiled import expressions through the document's private module loader", async () => {
  const f = input("export const load=(name)=>import('./'+name+'.js');", {});
  const result = await isolatedExtensionDocument({ ...f, entry: "runtime.js", resourceRoot: "/owned/surface/", output: "module" });
  const key = Symbol.for("joko.extension.surface.import"), previous = Reflect.get(globalThis, key);
  const loader = vi.fn(async (from: string, value: string) => ({ from, value }));
  Reflect.set(globalThis, key, loader);
  try {
    const module = await import(`data:text/javascript;base64,${result.toString("base64")}`) as { load(name: string): Promise<unknown> };
    expect(await module.load("later")).toEqual({ from: "/owned/surface/runtime.js", value: "./later.js" });
    expect(loader).toHaveBeenCalledExactlyOnceWith("/owned/surface/runtime.js", "./later.js");
    expect(f.read).not.toHaveBeenCalled();
  } finally { if (previous === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, previous); }
});

it("materializes runtime stylesheet text with the same scoped reader", async () => {
  const f = input('body{background-image:url("./icon.svg")}', { "icon.svg": "<svg/>" });
  const result = await isolatedExtensionDocument({ ...f, output: "style" });
  expect(result.toString()).toContain("data:image/svg+xml");
  expect(result.toString()).not.toContain("./icon.svg");
  await expect(isolatedExtensionDocument({ ...input('body{background:url("https://other.example/image.png")}', {}), output: "style" })).rejects.toThrow();
});
