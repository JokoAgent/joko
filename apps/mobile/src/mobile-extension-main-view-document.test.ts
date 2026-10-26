import { beforeEach, expect, it, vi } from "vitest";
import { allowExtensionDocumentNavigation, MOBILE_EXTENSION_DOCUMENT_CSP, prepareExtensionMainViewDocument } from "./mobile-extension-main-view-document";

const native = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), files: new Map<string, Uint8Array>(), nonce: 1 }));
vi.mock("expo-crypto", () => ({ getRandomBytes: (length: number) => new Uint8Array(length).fill(native.nonce++) }));
vi.mock("../modules/joko-mcp-app-surface/src/JokoMcpAppSurfaceModule", () => ({ default: {
  appHostAvailable: true, startApp: native.start, stop: native.stop
} }));
vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string; readonly name: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = parts.map(value => typeof value === "string" ? value : value.uri).join("/"); this.name = this.uri.split("/").at(-1)!; }
    get exists() { return [...native.files.keys()].some(path => path.startsWith(this.uri + "/")); }
    create() {}
    list() { return []; }
    delete() { for (const path of native.files.keys()) if (path.startsWith(this.uri + "/")) native.files.delete(path); }
  }
  class File {
    readonly uri: string;
    constructor(parent: Directory, name: string) { this.uri = parent.uri + "/" + name; }
    create() { native.files.set(this.uri, new Uint8Array()); }
    write(bytes: Uint8Array) { native.files.set(this.uri, bytes.slice()); }
  }
  return { Directory, File, Paths: { cache: "file:///native-cache" } };
});
beforeEach(() => {
  native.files.clear(); native.stop.mockReset().mockResolvedValue(undefined);
  native.start.mockReset().mockImplementation(async (_root, _entry, token) => `http://127.0.0.1:4401/__joko/${token}`);
});

it("hands only a fixed local HTML manifest and restrictive policy to the installed document host", async () => {
  const bytes = new TextEncoder().encode("<!doctype html><p>Isolated Extension</p>");
  const document = await prepareExtensionMainViewDocument({ bytes, mimeType: "text/html" }, "nested/view.html", "https://node.example/private-surface/nested/view.html");
  expect(native.start).toHaveBeenCalledWith(expect.stringMatching(/^\/native-cache\/mcp-apps\/extension-main-views\/[a-f0-9]{48}$/u),
    "nested/view.html", expect.stringMatching(/^[a-f0-9]{48}$/u), MOBILE_EXTENSION_DOCUMENT_CSP, [["nested/view.html", "0", "text/html"]]);
  expect(document.source.uri.startsWith("http://127.0.0.1:4401/__joko/")).toBe(true);
  expect(allowExtensionDocumentNavigation(document, document.documentUrl + "#section")).toBe(true);
  expect(allowExtensionDocumentNavigation(document, "https://public-node.example/private-token/index.html")).toBe(false);
  expect(allowExtensionDocumentNavigation(document, "http://127.0.0.1:4401/other.html")).toBe(false);
  const localHtml = new TextDecoder().decode([...native.files.values()][0]!);
  expect(localHtml).toContain("<!doctype html><script src=\"data:text/javascript;base64,");
  expect(localHtml).toContain("<p>Isolated Extension</p>");
  await document.close(); await document.close();
  expect(native.stop).toHaveBeenCalledOnce(); expect(native.files.size).toBe(0);
});

it("stops a native start that completes after cancellation and rejects unsafe entry paths", async () => {
  let finish!: () => void;
  native.start.mockImplementationOnce((_root, _entry, token) => new Promise<string>(resolve => { finish = () => resolve(`http://127.0.0.1:4401/__joko/${token}`); }));
  const owner = new AbortController();
  const resource = { bytes: new Uint8Array([1]), mimeType: "text/html" };
  const opening = prepareExtensionMainViewDocument(resource, "index.html", "https://node.example/private-surface/index.html", owner.signal);
  owner.abort(); finish();
  await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  expect(native.stop).toHaveBeenCalled(); expect(native.files.size).toBe(0);
  await expect(prepareExtensionMainViewDocument(resource, "../outside.html", "https://node.example/private")).rejects.toThrow(/invalid/u);
  await expect(prepareExtensionMainViewDocument(resource, "https://public.example/", "https://node.example/private")).rejects.toThrow(/invalid/u);
});
