import { expect, it, vi } from "vitest";
import { ExtensionNetwork, type ExtensionNetworkScope } from "./network.js";
import { extensionNetworkCredentialReference, parseExtensionNetwork } from "./network-manifest.js";

const declaration = parseExtensionNetwork({ hosts: ["api.example.test", "static.example.test"], secrets: [{ key: "api_key", label: "API key", inject: { hosts: ["api.example.test"], header: "Authorization", format: "Bearer {value}" } }] });
const scope = (overrides: Partial<ExtensionNetworkScope> = {}): ExtensionNetworkScope => ({ extensionId: "extension-one", authorityKey: "first-installation", declaration, signal: new AbortController().signal, readOnly: false, assertCurrent: () => {}, ...overrides });
const text = (body: string, init: ResponseInit = {}) => new Response(body, { ...init, headers: { "content-type": "application/json", ...init.headers } });

it("parses exact credential destinations and makes expanded injection require a fresh credential", () => {
  const changed = parseExtensionNetwork({ hosts: ["api.example.test", "static.example.test"], secrets: [{ key: "api_key", label: "API key", inject: { header: "Authorization", format: "Bearer {value}" } }] });
  expect(extensionNetworkCredentialReference("extension-one", declaration, declaration.secrets![0]!)).not.toBe(extensionNetworkCredentialReference("extension-one", changed, changed.secrets![0]!));
  for (const value of [
    { hosts: ["localhost"] }, { hosts: ["*.com"] }, { hosts: ["127.0.0.1"] }, { hosts: ["API.example.test"] },
    { hosts: ["api.example.test"], secrets: [{ key: "key", label: "Key", inject: { hosts: ["other.example.test"], header: "Authorization", format: "Bearer {value}" } }] },
    { hosts: ["api.example.test"], secrets: [{ key: "key", label: "Key", inject: { header: "Cookie", format: "{value}" } }] },
    { hosts: ["api.example.test"], secrets: [{ key: "key", label: "Key", inject: { header: "Authorization", format: "{value}{value}" } }] },
    { hosts: ["api.example.test"], secret: "not-current-v1" }
  ]) expect(() => parseExtensionNetwork(value)).toThrow();
});

it("uses only explicitly added connection hosts and selects fresh credentials at every redirect", async () => {
  const declaration = parseExtensionNetwork({ connections: [{ key: "service", label: "Service", inject: { header: "X-Service-Key", format: "Bearer {value}" } }] });
  const hosts = ["one.example.test", "two.example.test"];
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "https://two.example.test/resource" } })).mockResolvedValueOnce(text("one-secret two-secret"));
  const network = new ExtensionNetwork({ fetch: fetchMock, resolveCredential: () => { throw new Error("No ambient credential"); }, redact: value => value,
    connections: { hosts: () => hosts, token: (_id, _declaration, host) => host === hosts[0] ? "one-secret" : "two-secret" },
  });
  expect(await network.request(scope({ declaration }), { url: "https://one.example.test/start", headers: { "X-Service-Key": "forged", Authorization: "forged" } })).toMatchObject({ ok: true, body: "[REDACTED] [REDACTED]" });
  expect(new Headers(fetchMock.mock.calls[0]![1]!.headers).get("x-service-key")).toBe("Bearer one-secret");
  expect(new Headers(fetchMock.mock.calls[1]![1]!.headers).get("x-service-key")).toBe("Bearer two-secret");
  expect(new Headers(fetchMock.mock.calls[1]![1]!.headers).has("authorization")).toBe(false);
  expect(await network.request(scope({ declaration }), { url: "https://unlisted.example.test/" })).toMatchObject({ ok: false }); expect(fetchMock).toHaveBeenCalledTimes(2);
  hosts.splice(0);
  expect(await network.request(scope({ declaration }), { url: "https://one.example.test/" })).toMatchObject({ ok: false }); expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("refuses missing connection tokens and author-defined connection injection scopes", async () => {
  const entry = { key: "service", label: "Service", inject: { header: "X-Service-Key", format: "{value}" } };
  const declaration = parseExtensionNetwork({ connections: [entry] });
  for (const value of [
    { connections: [{ ...entry, inject: { ...entry.inject, hosts: ["*.example.test"] } }] },
    { connections: [entry, entry] }, { connections: [{ ...entry, maxConnections: 9 }] },
    { hosts: ["api.example.test"], secrets: [{ ...entry }], connections: [entry] },
  ]) expect(() => parseExtensionNetwork(value)).toThrow();
  const fetchMock = vi.fn<typeof fetch>();
  const network = new ExtensionNetwork({ fetch: fetchMock, resolveCredential: () => "", redact: value => value,
    connections: { hosts: () => ["service.example.test"], token: () => undefined },
  });
  expect(await network.request(scope({ declaration }), { url: "https://service.example.test/" })).toMatchObject({ ok: false }); expect(fetchMock).not.toHaveBeenCalled();
});

it("revalidates every redirect, rebuilds host-only credentials and strips author and response authority", async () => {
  const fetchMock = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 303, headers: { location: "https://static.example.test/result" } }))
    .mockResolvedValueOnce(text('{"echo":"private-key"}', { headers: { "set-cookie": "private-key", etag: "private-key" } }));
  const network = new ExtensionNetwork({ fetch: fetchMock, resolveCredential: () => "private-key", redact: value => value });
  const result = await network.request(scope(), { url: "https://api.example.test/create", method: "POST", body: "{}", headers: { Authorization: "forged", Cookie: "forged", "X-Allowed": "public", "content-type": "application/json" } });
  expect(result).toMatchObject({ ok: true, status: 200, body: '{"echo":"[REDACTED]"}', headers: { etag: "[REDACTED]" } });
  expect((result as { headers: object }).headers).not.toHaveProperty("set-cookie");
  const initial = fetchMock.mock.calls[0]![1]!, redirected = fetchMock.mock.calls[1]![1]!;
  expect(initial.redirect).toBe("manual"); expect(new Headers(initial.headers).get("authorization")).toBe("Bearer private-key"); expect(new Headers(initial.headers).has("cookie")).toBe(false);
  expect(redirected.method).toBe("GET"); expect(redirected.body).toBeUndefined(); expect(new Headers(redirected.headers).has("authorization")).toBe(false); expect(new Headers(redirected.headers).has("content-type")).toBe(false);
  fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://outside.example.test" } }));
  expect(await network.request(scope(), { url: "https://api.example.test/start" })).toMatchObject({ ok: false }); expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("blocks unapproved URLs, review writes and unsupported response modes before a network call", async () => {
  const fetchMock = vi.fn<typeof fetch>(); const network = new ExtensionNetwork({ fetch: fetchMock, resolveCredential: () => "private-key", redact: value => value });
  for (const payload of [
    { url: "https://outside.example.test" }, { url: "https://owner:secret@api.example.test" }, { url: "http://api.example.test" }, { url: "https://api.example.test:444" },
    { url: "https://api.example.test", method: "POST" }, { url: "https://api.example.test", body: "invalid-get-body" }, { url: "https://api.example.test", as: "file" }
  ]) expect(await network.request(scope({ readOnly: true }), payload)).toMatchObject({ ok: false });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("keeps exchanged credentials inside the host, escapes templates and exchanges once across concurrent calls", async () => {
  const exchanged = parseExtensionNetwork({ hosts: ["api.example.test"], secrets: [{ key: "key", label: "Key", inject: { header: "Authorization", format: "Bearer {value}" }, exchange: { url: "https://api.example.test/token", bodyFormat: '{"key":"{value}"}', tokenPath: "data.token" } }] });
  let exchanges = 0;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    if (new URL(String(input)).pathname === "/token") { exchanges++; expect(JSON.parse(String(init?.body))).toEqual({ key: 'private"$&\\key' }); return text('{"data":{"token":"temporary-private-token"}}'); }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer temporary-private-token");
    return text('{"echo":"temporary-private-token"}');
  });
  const network = new ExtensionNetwork({ fetch: fetchMock, resolveCredential: () => 'private"$&\\key', redact: value => value });
  const requests = await Promise.all([network.request(scope({ declaration: exchanged }), { url: "https://api.example.test/data" }), network.request(scope({ declaration: exchanged }), { url: "https://api.example.test/data" })]);
  expect(exchanges).toBe(1); expect(requests).toEqual([expect.objectContaining({ ok: true, body: '{"echo":"[REDACTED]"}' }), expect.objectContaining({ ok: true, body: '{"echo":"[REDACTED]"}' })]);
  network.retire("first-installation"); await network.request(scope({ declaration: exchanged }), { url: "https://api.example.test/data" }); expect(exchanges).toBe(2);
});

it("cancels response delivery after a task or source changes and does not expose transport errors", async () => {
  let current = true, cancelled = false;
  const fetchMock = vi.fn<typeof fetch>(async () => { current = false; return new Response(new ReadableStream({ cancel() { cancelled = true; } })); });
  const network = new ExtensionNetwork({ fetch: fetchMock, resolveCredential: () => "private-key", redact: value => value });
  expect(await network.request(scope({ assertCurrent: () => { if (!current) throw new Error("secret from transport"); } }), { url: "https://api.example.test" })).toEqual({ ok: false, message: "Extension network request failed. Check its declared destinations and credential setup." });
  expect(cancelled).toBe(true);
});

it("caps each source at four concurrent requests and rejects binary response bodies", async () => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const fetchMock = vi.fn<typeof fetch>(async () => { await waiting; return new Response("binary", { headers: { "content-type": "image/png" } }); });
  const network = new ExtensionNetwork({ fetch: fetchMock, resolveCredential: () => "private-key", redact: value => value });
  const pending = Array.from({ length: 4 }, () => network.request(scope(), { url: "https://api.example.test" }));
  expect(await network.request(scope(), { url: "https://api.example.test" })).toMatchObject({ ok: false, message: expect.stringContaining("capacity") });
  release(); expect(await Promise.all(pending)).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ ok: false, message: expect.stringContaining("text type") })));
});
