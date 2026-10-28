import { expect, it, vi } from "vitest";
import { parseExtensionNetwork } from "./extension-cards/network-manifest.js";
import { checkExtensionSecretCandidate } from "./extension-secret-check.js";

function declaration() {
  return parseExtensionNetwork({ hosts: ["api.example.com"], secrets: [{ key: "token", label: "Token", inject: { header: "Authorization", format: "Bearer {value}" },
    exchange: { url: "https://api.example.com/exchange", bodyFormat: '{"candidate":"{value}"}', tokenPath: "access.token" },
    check: { url: "https://api.example.com/check", bodyFormat: '{"candidate":"{value}"}', validPath: "result.active", validValue: true, expiresAtPath: "result.expires", expiresAtFormat: "unix-seconds" } }] });
}

it("checks the actual candidate in its declared exchange without exposing upstream credentials", async () => {
  const network = declaration(), secret = network.secrets![0]!, requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: typeof fetch = vi.fn(async (url, init) => {
    requests.push({ url: String(url), ...(init ? { init } : {}) });
    return Response.json(requests.length === 1 ? { access: { token: "temporary-exchanged" } }
      : { result: { active: true, expires: 1_900_000_000 }, privateToken: "must-not-leave-boundary" });
  });
  const candidate = 'candidate-$&-"-one';
  const result = await checkExtensionSecretCandidate({ declaration: network, secret, value: candidate, fetch: fetcher,
    signal: new AbortController().signal, assertCurrent: () => undefined });
  expect(result).toEqual({ valid: true, expiresAt: 1_900_000_000_000 });
  expect(requests.map(request => request.url)).toEqual(["https://api.example.com/exchange", "https://api.example.com/check"]);
  expect(JSON.parse(requests[0]!.init!.body as string)).toEqual({ candidate });
  expect(requests[1]!.init!.headers).toMatchObject({ Authorization: "Bearer temporary-exchanged" });
  expect(requests.every(request => request.init?.redirect === "manual")).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/candidate|temporary-exchanged|must-not-leave/u);
});

it("rejects a changed owner, redirects, oversized responses and a string pretending to be a boolean", async () => {
  const network = declaration(), secret = { ...network.secrets![0]!, exchange: undefined };
  const current = vi.fn(() => undefined);
  const run = (fetcher: typeof fetch) => checkExtensionSecretCandidate({ declaration: network, secret, value: "private-candidate", fetch: fetcher,
    signal: new AbortController().signal, assertCurrent: current });
  for (const response of [new Response(null, { status: 302, headers: { location: "https://foreign.example/" } }),
    Response.json({ result: { active: "true" } }), new Response("x".repeat(65_537))]) {
    await expect(run(vi.fn(async () => response))).rejects.toThrow(/could not be completed/u);
  }
  const fetcher: typeof fetch = vi.fn(async () => { current.mockImplementation(() => { throw new Error("owner changed"); }); return Response.json({ result: { active: true } }); });
  await expect(run(fetcher)).rejects.toThrow(/could not be completed/u);
});

it("does not let a check declaration expand its approved destinations", () => {
  expect(() => parseExtensionNetwork({ hosts: ["api.example.com"], secrets: [{ key: "token", label: "Token", inject: { header: "X-Key", format: "{value}" },
    check: { url: "https://foreign.example/check", bodyFormat: '{"value":"{value}"}', validPath: "active", validValue: true } }] })).toThrow(/not approved/u);
});
