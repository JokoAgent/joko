import { describe, expect, it } from "vitest";

import { createChildRuntimeEnvironment } from "./child-environment.js";

describe("child runtime environment", () => {
  it("inherits only the base and caller-allowed names, then applies explicit overrides", () => {
    const result = createChildRuntimeEnvironment({
      source: {
        PATH: "/runtime/bin",
        HOME: "/home/operator",
        SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.socket",
        BACKEND_API_KEY: "inherited-api-secret",
        NODE_OPTIONS: "--require=untrusted.js",
        UNRELATED_SECRET: "must-not-cross-boundary"
      },
      allowedKeys: ["BACKEND_API_KEY"],
      overrides: {
        HOME: undefined,
        EXPLICIT_CONFIG: "enabled",
        CUSTOM_PASSWORD: "explicit-password-secret"
      },
      platform: "linux"
    });

    expect(result.environment).toEqual({
      PATH: "/runtime/bin",
      SSH_AUTH_SOCK: "/run/user/1000/ssh-agent.socket",
      BACKEND_API_KEY: "inherited-api-secret",
      EXPLICIT_CONFIG: "enabled",
      CUSTOM_PASSWORD: "explicit-password-secret"
    });
    expect(result.sensitiveValues).toEqual([
      "explicit-password-secret",
      "inherited-api-secret"
    ]);
  });

  it("resolves inherited and overridden Windows names case-insensitively", () => {
    const result = createChildRuntimeEnvironment({
      source: {
        Path: "C:\\runtime",
        codex_home: "C:\\profile",
        UNRELATED: "excluded"
      },
      allowedKeys: ["CODEX_HOME"],
      overrides: {
        PATH: "C:\\explicit",
        Codex_Home: undefined
      },
      platform: "win32"
    });

    expect(result.environment).toEqual({ PATH: "C:\\explicit" });
  });
});
