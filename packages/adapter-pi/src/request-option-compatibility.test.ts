import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtemp } from "./test-paths.js";
import {
  encodePiCacheCompatibilityRequest,
  handlePiCacheCompatibilityRequest,
  isUnsupportedCacheOptionError,
  PiCacheCompatibilityStore,
  piCacheRouteKey,
  type PiCacheRoute
} from "./request-option-compatibility.js";

describe("optional cache parameter compatibility", () => {
  it.each([
    '400: {"error":{"type":"invalid_request_error","param":"prompt_cache_key","message":"Validation: Unsupported parameter(s): `prompt_cache_key`"}}',
    '"prompt_cache_retention" is not supported by this endpoint; use "prompt_cache_options"',
    "400: Unsupported request parameter: prompt_cache_key",
    '400: {"type":"unsupported_parameter","message":"prompt_cache_retention is unsupported"}'
  ])("recognizes the exact deterministic rejection: %s", message => {
    expect(isUnsupportedCacheOptionError(message)).toBe(true);
  });

  it.each([
    "401: Unsupported parameter: prompt_cache_key",
    "429: prompt_cache_retention is not supported",
    "400: Unsupported parameter: prompt_cache_keyword",
    "400: prompt_cache_retention_policy is not supported",
    "400: prompt_cache_key is invalid",
    "400: prompt_cache_retention requires a different value",
    "400: Unsupported parameter: temperature; prompt_cache_key was accepted",
    '{"error":{"param":"temperature","message":"prompt_cache_key is not supported"}}',
    '{"error":{"type":"authentication_error","message":"prompt_cache_key is not supported"}}',
    '{"error":"Unsupported parameter: prompt_cache_key"}',
    '{"error":{"error":{"error":{"type":"authentication_error","message":"prompt_cache_key is not supported"}}}}',
    '{"message":"prompt_cache_key is not supported"',
    "prompt_cache_key " + "x".repeat(65_536),
    ""
  ])("preserves unrelated or ambiguous failures: %s", message => {
    expect(isUnsupportedCacheOptionError(message)).toBe(false);
  });

  it("isolates full API paths and query routes while ignoring URL fragments", () => {
    const key = piCacheRouteKey("https://example.test/v1?tenant=one#fragment", "openai-completions");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).toBe(piCacheRouteKey("https://example.test/v1?tenant=one", "openai-completions"));
    expect(key).not.toBe(piCacheRouteKey("https://example.test/v1?tenant=two", "openai-completions"));
    expect(key).not.toBe(piCacheRouteKey("https://example.test/v2?tenant=one", "openai-completions"));
    expect(key).not.toBe(piCacheRouteKey("https://example.test/v1?tenant=one", "openai-responses"));
    expect(piCacheRouteKey("file:///v1", "openai-completions")).toBeUndefined();
  });

  it("retains concurrent route learning across cold starts without persisting the endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-cache-compatibility-"));
    const path = join(root, "rules.json");
    const store = new PiCacheCompatibilityStore(path);
    const routes = Array.from({ length: 12 }, (_, index): PiCacheRoute => ({ providerId: `provider-${index}`,
      wireModelId: "wire-model", routeKey: piCacheRouteKey(`https://endpoint.test/v1?private-route=${index}`, "openai-completions")! }));
    expect(await Promise.all(routes.map(route => store.record(route)))).toEqual(routes.map(() => true));
    const cold = new PiCacheCompatibilityStore(path);
    expect(await Promise.all(routes.map(route => cold.has(route)))).toEqual(routes.map(() => true));
    expect(await cold.has({ ...routes[0]!, wireModelId: "other-model" })).toBe(false);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("endpoint.test");
    expect(text).not.toContain("private-route");
    expect(Object.keys(JSON.parse(text).routes)).toHaveLength(routes.length);
  });

  it.each(["not json", '{"version":0,"routes":{}}', '{"version":1,"routes":{"bad-key":{"supportsLongCacheRetention":false}}}', "x".repeat(256 * 1024 + 1)])(
    "preserves unreadable learning instead of authorizing replay (%#)", async value => {
      const root = await mkdtemp(join(tmpdir(), "joko-cache-unreadable-"));
      const path = join(root, "rules.json");
      await writeFile(path, value, { mode: 0o600 });
      const store = new PiCacheCompatibilityStore(path);
      const route = { providerId: "local", wireModelId: "model", routeKey: "a".repeat(64) };
      expect(await store.has(route)).toBe(false);
      expect(await store.record(route)).toBe(false);
      expect(await readFile(path, "utf8")).toBe(value);
    });

  it("handles private control messages before ordinary UI, rejecting malformed routes and stale responses", async () => {
    const requests: unknown[] = [], responses: unknown[] = [];
    let current = true;
    const options = { resolve: async (value: unknown) => { requests.push(value); return { applied: true }; },
      isCurrent: () => current, transport: { closed: false, notify: async (value: unknown) => { responses.push(value); } } };
    const route = { providerId: "local", wireModelId: "model", routeKey: "a".repeat(64) };
    const title = encodePiCacheCompatibilityRequest({ action: "prepare", route, hasCacheOptions: true });
    expect(await handlePiCacheCompatibilityRequest({ method: "input", id: "private-one", title }, options)).toBe(true);
    expect(requests).toEqual([{ action: "prepare", route, hasCacheOptions: true }]);
    expect(responses).toEqual([{ type: "extension_ui_response", id: "private-one", value: '{"applied":true}' }]);
    requests.length = 0;
    await handlePiCacheCompatibilityRequest({ method: "input", id: "bad-route",
      title: encodePiCacheCompatibilityRequest({ action: "prepare", route: { ...route, providerId: "../\nsecret" }, hasCacheOptions: true }) }, options);
    expect(requests).toEqual([]);
    current = false;
    const count = responses.length;
    await handlePiCacheCompatibilityRequest({ method: "input", id: "stale", title }, options);
    expect(responses).toHaveLength(count);
    expect(await handlePiCacheCompatibilityRequest({ method: "input", title: "ordinary question" }, options)).toBe(false);
  });
});
