import { describe, expect, it } from "vitest";

import {
  DEFAULT_MANAGED_BASH_TIMEOUT_SECONDS,
  MANAGED_BRIDGE_SOURCE,
  MAXIMUM_MANAGED_BASH_TIMEOUT_SECONDS,
  MAXIMUM_MANAGED_MCP_BRIDGE_RESPONSE_BYTES,
  normalizeManagedBashTimeout
} from "./bridge.js";
import { DEFAULT_PI_JSONL_RECORD_BYTES } from "./jsonl.js";
import {
  MAXIMUM_PI_RUNTIME_TOOL_CATALOG_BYTES,
  PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES
} from "./runtime-tool-catalog.js";

describe("managed Pi bridge boundaries", () => {
  it("normalizes the public bash deadline without widening its upper bound", () => {
    expect(DEFAULT_MANAGED_BASH_TIMEOUT_SECONDS).toBe(300);
    expect(MAXIMUM_MANAGED_BASH_TIMEOUT_SECONDS).toBe(1_800);
    expect(normalizeManagedBashTimeout(undefined)).toBe(300);
    expect(normalizeManagedBashTimeout(0.001)).toBe(0.001);
    expect(normalizeManagedBashTimeout(1_800)).toBe(1_800);

    for (const value of [null, "300", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1_800.001]) {
      expect(() => normalizeManagedBashTimeout(value)).toThrowError(
        "Invalid bash timeout: expected a finite number of seconds in (0, 1800]"
      );
    }
  });

  it("keeps managed MCP previews bounded independently of complete artifacts", () => {
    expect(MAXIMUM_MANAGED_MCP_BRIDGE_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
  });

  it("removes credentialed proxy names from model and direct-user Bash environments", () => {
    const sanitizeEnvironment = managedEnvironmentSanitizer(["HTTP_PROXY"]);
    expect(sanitizeEnvironment({
      PATH: "/usr/bin",
      HTTP_PROXY: "http://proxy-user:proxy-passphrase@127.0.0.1:8080",
      HTTPS_PROXY: "http://127.0.0.1:8081",
      NO_PROXY: "127.0.0.1"
    })).toEqual({
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://127.0.0.1:8081",
      NO_PROXY: "127.0.0.1"
    });
  });

  it("fits the largest runtime-tool catalog chunk inside one Pi JSONL record", () => {
    const payload = Buffer.alloc(PI_RUNTIME_TOOL_CATALOG_CHUNK_BYTES, 0xff).toString("base64url");
    const statusText = JSON.stringify({
      format: 1,
      catalogId: "f".repeat(64),
      index: 999_999,
      count: 1_000_000,
      byteLength: MAXIMUM_PI_RUNTIME_TOOL_CATALOG_BYTES,
      sha256: "f".repeat(64),
      payload
    });
    const wireRecord = JSON.stringify({
      type: "extension_ui_request",
      id: "runtime-tool-catalog",
      method: "setStatus",
      statusKey: "joko-runtime-tool-catalog/v1",
      statusText
    });
    expect(Buffer.byteLength(wireRecord, "utf8") + 1).toBeLessThan(DEFAULT_PI_JSONL_RECORD_BYTES);
  });
});

function managedEnvironmentSanitizer(
  secretEnvironmentNames: readonly string[]
): (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv {
  const start = MANAGED_BRIDGE_SOURCE.indexOf("function sanitizeEnvironment(");
  const end = MANAGED_BRIDGE_SOURCE.indexOf("\n\ntype PlanReviewResponse", start);
  if (start < 0 || end < 0) throw new Error("Managed environment sanitizer source is unavailable");
  const source = MANAGED_BRIDGE_SOURCE.slice(start, end).replaceAll(": NodeJS.ProcessEnv", "");
  const factory = Function(
    "secretEnvironmentNames",
    `${source}\nreturn sanitizeEnvironment;`
  ) as (names: readonly string[]) => (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  return factory(secretEnvironmentNames);
}
