import { describe, expect, it } from "vitest";
import type { BackendView, CapabilityView, ModelView } from "../model.js";
import { resolveNewSessionExecutionOptions } from "./new-session-options.js";

const model: ModelView = {
  backendId: "pi",
  providerId: "provider",
  providerName: "Provider",
  modelId: "model",
  name: "Model",
  available: true,
  supportsImages: true,
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  supportsFast: true,
  efforts: ["low", "high"],
  contextWindow: 128_000,
  maximumOutputTokens: 16_000,
  inputCostMicrosPerMillion: 0,
  outputCostMicrosPerMillion: 0,
  currencyCode: "USD"
};

describe("new-session execution controls", () => {
  it("does not expose catalog choices that the selected backend cannot apply", () => {
    const options = resolveNewSessionExecutionOptions(backend({}), [model], "provider\u0000model");

    expect(options).toMatchObject({
      modelSwitchSupported: false,
      modelSelectable: false,
      effortSupported: false,
      effortSelectable: false,
      fastModeSupported: false,
      fastModeSelectable: false,
      permissionModes: ["ask"],
      permissionSelectable: false,
      planModeSupported: false
    });
    expect(options.selectedModel).toBeUndefined();
  });

  it("enables only controls supported by both the backend and selected model", () => {
    const options = resolveNewSessionExecutionOptions(backend({
      "model.switch": capability(),
      "model.effort": capability(),
      "model.fast_mode": capability(),
      "permission.modes": capability(["ask", "auto", "bypassPermissions"]),
      plan_mode: capability()
    }), [model], "provider\u0000model");

    expect(options).toMatchObject({
      selectedModel: model,
      modelSelectable: true,
      effortSelectable: true,
      fastModeSelectable: true,
      permissionModes: ["ask", "auto", "bypassPermissions"],
      permissionSelectable: true,
      planModeSupported: true
    });
  });

  it("keeps model-dependent controls inert until an available model is selected", () => {
    const unavailable = { ...model, available: false };
    const options = resolveNewSessionExecutionOptions(backend({
      "model.switch": capability(),
      "model.effort": capability(),
      "model.fast_mode": capability()
    }), [unavailable], "provider\u0000model");

    expect(options.availableModels).toEqual([]);
    expect(options.modelSelectable).toBe(false);
    expect(options.selectedModel).toBeUndefined();
    expect(options.effortSelectable).toBe(false);
    expect(options.fastModeSelectable).toBe(false);
  });

  it("requires the Backend to advertise its exact permission option catalog", () => {
    const advertised = resolveNewSessionExecutionOptions(backend({ "permission.modes": capability() }), [], "");
    const missing = resolveNewSessionExecutionOptions(backend({}), [], "");

    expect(advertised.permissionModes).toEqual(["ask"]);
    expect(advertised.permissionSelectable).toBe(false);
    expect(missing.permissionModes).toEqual(["ask"]);
    expect(missing.permissionSelectable).toBe(false);
  });
});

function backend(capabilities: Readonly<Record<string, CapabilityView>>): BackendView {
  return {
    id: "pi",
    name: "Pi",
    version: "1",
    health: "healthy",
    capabilities: new Map(Object.entries(capabilities))
  };
}

function capability(options: readonly string[] = []): CapabilityView {
  return { name: "capability", supported: true, options };
}
