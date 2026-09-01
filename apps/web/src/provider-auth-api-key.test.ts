import { ProviderLoginMethod } from "@joko/contracts";
import { describe, expect, it } from "vitest";

import {
  defaultProviderLoginMethod,
  providerLoginMethods
} from "./components/ProviderLoginDialog.js";
import { providerConfigurationEditable } from "./components/SettingsPage.js";
import { protoProviderLoginMethod, providerLoginMethod } from "./gateway.js";
import type { ProviderConfigurationView } from "./model.js";

describe("native API-key Provider settings", () => {
  it("routes an API-key Provider through its native login flow", () => {
    expect(providerLoginMethods("apiKey")).toEqual(["apiKey"]);
    expect(defaultProviderLoginMethod("apiKey")).toBe("apiKey");
    expect(protoProviderLoginMethod("apiKey")).toBe(ProviderLoginMethod.API_KEY);
    expect(providerLoginMethod(ProviderLoginMethod.API_KEY)).toBe("apiKey");
  });

  it("does not offer the managed endpoint editor for a native catalog descriptor", () => {
    expect(providerConfigurationEditable({ models: [] } as unknown as ProviderConfigurationView)).toBe(false);
    expect(providerConfigurationEditable({ models: [{ modelId: "managed-model" }] } as unknown as ProviderConfigurationView)).toBe(true);
  });
});
