import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { create } from "@bufbuild/protobuf";
import { ExtensionOAuthAuthorizationSchema } from "@joko/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { listenForExtensionOAuth, validateExtensionOAuthOffer } from "./extension-oauth-loopback.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const reservation = createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); if (!address || typeof address === "string") throw new Error("Missing fixture address.");
  const callbackUrl = `http://127.0.0.1:${address.port}/callback`, state = randomBytes(32).toString("base64url");
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const authorize = new URL("https://authorize.example.test/authorize");
  authorize.searchParams.set("response_type", "code"); authorize.searchParams.set("state", state); authorize.searchParams.set("redirect_uri", callbackUrl);
  const offer = create(ExtensionOAuthAuthorizationSchema, { callbackUrl, state, authorizeUrl: authorize.href, corsOrigins: [authorize.origin], corsHosts: ["*.service.example.test"] });
  return { offer, callback: (query: string) => `${callbackUrl}?${query}`, query: (code = "private-callback-code-fixture") => new URLSearchParams({ state, code }).toString() };
}
it("admits one exact callback with declared HTTPS CORS and never echoes the authorization result", async () => {
  const f = await fixture(), deliver = vi.fn(async () => {}), listener = await listenForExtensionOAuth(f.offer, deliver, () => {}); cleanups.push(listener.close);
  expect((await fetch(f.callback(f.query()), { method: "OPTIONS", headers: { origin: "https://ui.service.example.test" } })).status).toBe(204);
  expect(deliver).not.toHaveBeenCalled();
  for (const query of [`${f.query()}&state=${f.offer.state}`, `${f.query()}&code=second`, "state=wrong&code=private", `${f.query()}&error=denied`]) {
    expect((await fetch(f.callback(query))).status).toBe(400);
  }
  expect((await fetch(f.callback(f.query()), { headers: { origin: "https://unrelated.example.test" } })).status).toBe(403);
  expect((await fetch(f.callback(f.query()), { method: "POST" })).status).toBe(405);
  const wrongHost = await new Promise<number>(resolve => { const request = httpRequest(f.callback(f.query()), { headers: { host: "unrelated.example.test" } }, response => { response.resume(); resolve(response.statusCode!); }); request.end(); });
  expect(wrongHost).toBe(400);
  expect(deliver).not.toHaveBeenCalled();
  const response = await fetch(f.callback(f.query()), { headers: { origin: "https://authorize.example.test" } });
  expect(response.status).toBe(200); expect(response.headers.get("access-control-allow-origin")).toBe("https://authorize.example.test");
  const document = await response.text(); expect(document).toContain("Joko"); expect(document).not.toContain("private-callback-code-fixture"); expect(document).not.toContain(f.offer.state);
  expect(deliver).toHaveBeenCalledExactlyOnceWith({ state: f.offer.state, code: "private-callback-code-fixture" });
  expect((await fetch(f.callback(f.query()))).status).toBe(409);
  await listener.close(); await listener.close();
  const next = await listenForExtensionOAuth(f.offer, async () => {}, () => {}); cleanups.push(next.close);
});
it("rejects forged offers and an occupied port without disturbing the owning listener", async () => {
  const f = await fixture();
  for (const patch of [{ callbackUrl: "http://192.168.1.2:5555/callback" }, { callbackUrl: f.offer.callbackUrl + "?code=private" }, { state: "invalid" }, { authorizeUrl: f.offer.authorizeUrl.replace("https:", "http:") }]) {
    expect(() => validateExtensionOAuthOffer({ ...f.offer, ...patch })).toThrow();
  }
  const listener = await listenForExtensionOAuth(f.offer, async () => {}, () => {}); cleanups.push(listener.close);
  await expect(listenForExtensionOAuth(f.offer, async () => {}, () => {})).rejects.toThrow("unavailable");
  expect((await fetch(f.callback(f.query()))).status).toBe(200);
});
it("rejects callbacks after the original document is retired", async () => {
  const f = await fixture(); let current = true;
  const deliver = vi.fn(async () => {}), listener = await listenForExtensionOAuth(f.offer, deliver, () => { if (!current) throw new Error("Retired"); }); cleanups.push(listener.close);
  current = false; expect((await fetch(f.callback(f.query()))).status).toBe(410); expect(deliver).not.toHaveBeenCalled();
});
