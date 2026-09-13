import { describe, expect, it, vi } from "vitest";

import {
  createProviderModelRefreshHostLifecycle,
  PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS
} from "../src/provider-model-refresh-lifecycle.js";

describe("Provider model refresh host lifecycle", () => {
  it("publishes resume and unlock as credential-free refresh hints", () => {
    const publish = vi.fn();
    const lifecycle = createProviderModelRefreshHostLifecycle({ publish });

    lifecycle.systemResumed();
    lifecycle.screenUnlocked();

    expect(publish.mock.calls).toEqual([
      ["system-resume"],
      ["screen-unlock"]
    ]);
  });

  it("requires a complete long-background focus transition", () => {
    let now = 10_000;
    const publish = vi.fn();
    const lifecycle = createProviderModelRefreshHostLifecycle({ now: () => now, publish });

    lifecycle.syncApplicationFocused(true);
    lifecycle.syncApplicationFocused(true);
    lifecycle.syncApplicationFocused(false);
    now += PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS - 1;
    lifecycle.syncApplicationFocused(true);
    expect(publish).not.toHaveBeenCalled();

    lifecycle.syncApplicationFocused(false);
    now += PROVIDER_MODEL_FOREGROUND_BACKGROUND_THRESHOLD_MS;
    lifecycle.syncApplicationFocused(true);
    lifecycle.syncApplicationFocused(true);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith("meaningful-foreground");
  });
});
