import { beforeEach, expect, it, vi } from "vitest";
import type { PairedCredential } from "./network";
import type { MobileExtensionMainViewSurface } from "./mobile-extensions";
import { readMobileExtensionMainViewResource, MOBILE_EXTENSION_RESOURCE_MAXIMUM_BYTES } from "./mobile-extension-main-view-resource";

const channel = vi.hoisted(() => ({ factory: vi.fn(), fetch: vi.fn() }));
vi.mock("@joko/connection-transport", () => ({ createConnectionFetch: channel.factory }));
const credential: PairedCredential = { profileId: "profile", origin: "https://private-node.example", serverId: "node", connectionId: "connection",
  deviceId: "phone", displayName: "Phone", authKey: "private-owner-key", endpointPublicKey: `ed25519:${"a".repeat(64)}` };
const surface: MobileExtensionMainViewSurface = { surfaceId: `extension_surface_${"b".repeat(32)}`, extensionId: `extension_${"c".repeat(32)}`,
  owner: { kind: "resource", resourceId: "resource", resourceRevision: 1n, discoveredRevision: `sha256:${"d".repeat(64)}` },
  backendId: "backend", backendRevision: 1n, backendGeneration: 1,
  url: `https://private-node.example/v1/extensions/main-views/extension_surface_${"b".repeat(32)}/${"e".repeat(64)}/index.html`, expiresAt: Date.now() + 60_000 };
beforeEach(() => { channel.factory.mockReset().mockReturnValue(channel.fetch); channel.fetch.mockReset(); });

it("loads a materialized child document and media through the captured pin without exposing a public WebView locator", async () => {
  const bytes = new TextEncoder().encode("<!doctype html><p>Local document</p>");
  channel.fetch.mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": "text/html; charset=utf-8", "content-length": String(bytes.length) } }));
  const destination = surface.url.replace("index.html", "nested/view.html#section");
  const result = await readMobileExtensionMainViewResource(credential, surface, destination, "document");
  expect(result).toEqual({ bytes, mimeType: "text/html" });
  expect(channel.factory).toHaveBeenCalledExactlyOnceWith(credential);
  expect(channel.fetch).toHaveBeenCalledWith(destination.split("#")[0], expect.objectContaining({
    headers: { authorization: `Bearer ${credential.authKey}`, "x-joko-isolated-document": "1" }, redirect: "error", cache: "no-store"
  }));
});

it("rejects another surface, origin or executable media before adopting its bytes", async () => {
  for (const url of ["https://attacker.example/private", surface.url.replace("e".repeat(64), "f".repeat(64)), surface.url + "?secret=1"]) {
    await expect(readMobileExtensionMainViewResource(credential, surface, url, "document")).rejects.toThrow(/another surface/u);
  }
  expect(channel.factory).not.toHaveBeenCalled();
  const cancel = vi.fn();
  channel.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: {
    "content-type": "text/javascript", "content-length": "100"
  } }));
  await expect(readMobileExtensionMainViewResource(credential, surface, surface.url.replace("index.html", "secret.js"), "media")).rejects.toThrow(/invalid/u);
  expect(cancel).toHaveBeenCalledOnce();
});

it.each(["script", "module", "style", "style-text"] as const)("materializes authorized runtime %s resources with an exact private request", async kind => {
  const script = kind === "script" || kind === "module";
  const mimeType = script ? "text/javascript" : "text/css";
  const bytes = new TextEncoder().encode(script ? "export const value=1;" : "body{color:red}");
  channel.fetch.mockResolvedValueOnce(new Response(bytes, { headers: { "content-type": mimeType, "content-length": String(bytes.length) } }));
  const url = surface.url.replace("index.html", script ? "runtime/view.js" : "runtime/view.css");
  const text = kind === "style-text" ? "body{background:url('../media/image.png')}" : undefined;
  await expect(readMobileExtensionMainViewResource(credential, surface, url, kind, undefined, text)).resolves.toEqual({ bytes, mimeType });
  expect(channel.factory).toHaveBeenCalledWith(credential);
  expect(channel.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: kind === "style-text" ? "POST" : "GET",
    headers: { authorization: `Bearer ${credential.authKey}`, "x-joko-isolated-document": kind, ...(kind === "style-text" ? { "content-type": "text/css" } : {}) },
    ...(kind === "style-text" ? { body: text } : {}) }));
});

it("rejects oversized or truncated responses and releases a stalled stream on cancellation", async () => {
  const cancel = vi.fn();
  channel.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: {
    "content-type": "text/html", "content-length": String(MOBILE_EXTENSION_RESOURCE_MAXIMUM_BYTES + 1)
  } }));
  await expect(readMobileExtensionMainViewResource(credential, surface, surface.url, "document")).rejects.toThrow(/budget/u);
  expect(cancel).toHaveBeenCalledOnce();
  channel.fetch.mockResolvedValueOnce(new Response(Uint8Array.of(1), { headers: { "content-type": "image/png", "content-length": "2" } }));
  await expect(readMobileExtensionMainViewResource(credential, surface, surface.url, "media")).rejects.toThrow(/changed/u);
  const owner = new AbortController();
  channel.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "image/png", "content-length": "2" } }));
  const pending = readMobileExtensionMainViewResource(credential, surface, surface.url, "media", owner.signal);
  await vi.waitFor(() => expect(channel.fetch).toHaveBeenCalledTimes(3));
  owner.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(cancel).toHaveBeenCalledTimes(2);
});

it("ends a stalled resource at the original surface expiry without reissuing it", async () => {
  const cancel = vi.fn();
  channel.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/html", "content-length": "2" } }));
  const leased = { ...surface, expiresAt: Date.now() + 100 };
  await expect(readMobileExtensionMainViewResource(credential, leased, leased.url, "document")).rejects.toMatchObject({ name: "TimeoutError" });
  expect(channel.fetch).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});
