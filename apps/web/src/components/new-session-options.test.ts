import { describe, expect, it } from "vitest";
import type { BackendView, ModelView, TargetView } from "../model.js";
import { defaultNewSessionSelection, dialogueBackends, newSessionSelectionValue, newSessionTargets, parseNewSessionSelection, resolveNewSessionExecutionOptions } from "./new-session-options.js";

describe("new-session target choices", () => {
  const capable = backend("capable", "healthy", true);
  const unavailable = backend("offline", "unavailable", true);
  const textless = backend("textless", "healthy", false);
  const target = { id: "target-1", backendId: "capable", name: "Repo", workspaceId: "workspace-1", workspaceName: "Repo", trusted: true, pinned: false, archived: false } satisfies TargetView;

  it("offers managed dialogue only through available text-capable backends", () => {
    expect(dialogueBackends([unavailable, textless, capable]).map((item) => item.id)).toEqual(["capable"]);
    expect(parseNewSessionSelection("dialogue:offline", [target], [unavailable, capable])).toBeUndefined();
    expect(parseNewSessionSelection("dialogue:capable", [target], [capable])).toEqual({ kind: "dialogue", backendId: "capable" });
  });

  it("round-trips target selection and falls back to dialogue without fabricating a project", () => {
    expect(newSessionSelectionValue({ kind: "target", targetId: "target-1" })).toBe("target:target-1");
    expect(parseNewSessionSelection("target:target-1", [target], [capable])).toEqual({ kind: "target", targetId: "target-1" });
    expect(defaultNewSessionSelection([], [capable])).toEqual({ kind: "dialogue", backendId: "capable" });
  });

  it("removes disabled Backends from every new-task entry point", () => {
    const settings = [{ backendId: "capable", enabled: false, permissionMode: "ask" as const, planMode: false }];

    expect(newSessionTargets([target], settings)).toEqual([]);
    expect(dialogueBackends([capable], settings)).toEqual([]);
  });

  it("offers models only from the selected Backend instance", () => {
    const selectedBackend = {
      ...capable,
      capabilities: new Map([...capable.capabilities, ["model.switch", { name: "model.switch", supported: true, options: [] }]])
    };
    const options = resolveNewSessionExecutionOptions(selectedBackend, [model("capable"), model("other")], "provider\u0000model");

    expect(options.availableModels.map((item) => item.backendId)).toEqual(["capable"]);
    expect(options.selectedModel?.backendId).toBe("capable");
  });

  it("excludes models disabled for new routing", () => {
    const selectedBackend = {
      ...capable,
      capabilities: new Map([...capable.capabilities, ["model.switch", { name: "model.switch", supported: true, options: [] }]])
    };
    const options = resolveNewSessionExecutionOptions(selectedBackend, [
      { ...model("capable"), modelId: "disabled", routingEnabled: false },
      { ...model("capable"), modelId: "enabled", routingEnabled: true }
    ], "provider\u0000disabled");

    expect(options.availableModels.map((item) => item.modelId)).toEqual(["enabled"]);
    expect(options.selectedModel).toBeUndefined();
  });
});

function backend(id: string, health: BackendView["health"], inputText: boolean): BackendView {
  return {
    id,
    name: id,
    version: "1",
    health,
    capabilities: new Map([["input.text", { name: "input.text", supported: inputText, options: [] }]])
  };
}

function model(backendId: string): ModelView {
  return {
    backendId,
    providerId: "provider",
    providerName: "Provider",
    modelId: "model",
    name: "Model",
    available: true,
    supportsImages: false,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsFast: false,
    efforts: [],
    contextWindow: 1,
    maximumOutputTokens: 1,
    inputCostMicrosPerMillion: 0,
    outputCostMicrosPerMillion: 0,
    currencyCode: "USD"
  };
}
