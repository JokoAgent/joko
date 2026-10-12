import { expect, it, vi } from "vitest";
import { CodeHostProjectProvider } from "./project-provider.js";

it("uses the configured memory lease and projects only this repository's own work without credential content", async () => {
  const lease = { token: "fixture-token-private", generation: 1 };
  const fetch = vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    return Response.json(url.endsWith("/user") ? { login: "fixture-owner" } : { items: [
      { number: 1, title: `Work ${lease.token}`, html_url: "https://github.com/owner/project/issues/1", updated_at: "2026-10-09T00:00:00Z" },
      { number: 2, title: "Another repository", html_url: "https://github.com/other/project/issues/2" }
    ] });
  });
  const readCredential = vi.fn(async () => lease);
  const provider = new CodeHostProjectProvider({ credentials: { readCredential, isCurrent: () => true }, fetch: fetch as typeof globalThis.fetch });
  const result = await provider.read("owner/project", () => undefined);
  expect(result.issues).toMatchObject([{ number: 1, title: "Work [redacted]" }]);
  expect(JSON.stringify(result)).not.toContain(lease.token);
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls.slice(1).every(([url]) => String(url).includes("repo%3Aowner%2Fproject"))).toBe(true);
});

it("makes no unconfigured outbound read and retires a response after grant withdrawal", async () => {
  const fetch = vi.fn();
  const unconfigured = new CodeHostProjectProvider({ credentials: { readCredential: async () => undefined, isCurrent: () => false }, fetch });
  expect(await unconfigured.read("owner/project", () => undefined)).toMatchObject({ unavailable: "no_credential" });
  expect(fetch).not.toHaveBeenCalled();
  let live = true;
  const provider = new CodeHostProjectProvider({ credentials: { readCredential: async () => ({ token: "fixture-token", generation: 1 }), isCurrent: () => true },
    fetch: vi.fn(async () => { live = false; return Response.json({ login: "fixture-owner" }); }) });
  await expect(provider.read("owner/project", () => { if (!live) throw new Error("Grant withdrawn"); })).rejects.toThrow("Grant withdrawn");
});
