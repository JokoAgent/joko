import { describe, expect, it } from "vitest";
import type { BackendView, ProviderRuntimeConfigurationView } from "./model.js";
import { emptyProviderRuntime, providerCredentialBindingsValid, providerEndpointOrigin, providerTransferDifferences, transferProviderRuntime } from "./provider-runtime-draft.js";

const sourceBackend: BackendView = { id: "writer", name: "Writer", version: "1", health: "healthy", capabilities: new Map(),
  providerRuntimeSupport: { protocols: ["openaiResponses", "openaiChat"], fields: ["requestPath", "modelsEndpoint", "headers", "keyless", "authHeader", "modelLimits", "modelCompatibility", "modelInputModalities"] } };
const targetBackend: BackendView = { ...sourceBackend, id: "reader", name: "Reader",
  providerRuntimeSupport: { protocols: ["openaiResponses"], fields: ["headers", "keyless", "authHeader", "modelCompatibility"] } };
function route(backend: BackendView, patch: Partial<ProviderRuntimeConfigurationView> = {}): ProviderRuntimeConfigurationView {
  const empty = emptyProviderRuntime(backend);
  return { ...empty, endpoint: "https://new.example/v1", credentialId: "source-key", credentialOrigin: "https://new.example", environmentName: "ROUTE_KEY",
    models: [{ ...empty.models[0]!, modelId: "model", name: "Model" }], ...patch };
}

describe("Provider runtime draft transfer", () => {
  it("keeps endpoint fields together and transfers only supported model declarations", () => {
    const source = route(sourceBackend, { requestPath: "/responses" });
    const target = route(targetBackend, { endpoint: "", credentialId: "", credentialOrigin: "", models: [] });
    expect(providerTransferDifferences(source, target, sourceBackend, targetBackend)).toContainEqual({ field: "endpoint", state: "incompatible" });
    expect(() => transferProviderRuntime(source, target, sourceBackend, targetBackend, ["endpoint"])).toThrow(/unavailable/u);
    const copied = transferProviderRuntime(source, target, sourceBackend, targetBackend, ["models"]);
    expect(copied.models[0]).toMatchObject({ modelId: "model", contextWindowTokens: 0, maximumOutputTokens: 0, inputModalities: ["text"] });
    const override = { ...source, models: [{ ...source.models[0]!, compatibility: "openaiChat" as const }] };
    expect(providerTransferDifferences(override, target, sourceBackend, targetBackend)).toContainEqual({ field: "models", state: "incompatible" });
    expect(() => transferProviderRuntime(override, target, sourceBackend, targetBackend, ["models"])).toThrow(/unavailable/u);
    for (const endpoint of ["https://user:secret@new.example", "https://new.example?key=secret", "http://external.example"]) {
      expect(providerEndpointOrigin(endpoint)).toBeUndefined();
      expect(providerTransferDifferences({ ...source, endpoint }, target, sourceBackend, sourceBackend)).toContainEqual({ field: "endpoint", state: "incompatible" });
    }
    expect(providerTransferDifferences({ ...source, requestPath: "/responses?key=secret" }, target, sourceBackend, sourceBackend)).toContainEqual({ field: "endpoint", state: "incompatible" });
  });

  it("requires separate credential selections and retires authority when the endpoint origin changes", () => {
    const source = route(sourceBackend, { headers: [{ headerName: "X-Route-Key", credentialId: "source-header", environmentName: "ROUTE_HEADER" }] });
    const target = route(sourceBackend, { backendId: "reader", endpoint: "https://old.example/v1", credentialId: "old-key", credentialOrigin: "https://old.example",
      headers: [{ headerName: "X-Old", credentialId: "old-header", environmentName: "OLD_HEADER" }], modelsEndpoint: "https://old.example/models" });
    expect(() => transferProviderRuntime(source, target, sourceBackend, sourceBackend, ["authentication"])).toThrow(/endpoint/u);
    const endpointOnly = transferProviderRuntime(source, target, sourceBackend, sourceBackend, ["endpoint"]);
    expect(endpointOnly).toMatchObject({ endpoint: source.endpoint, credentialId: "", credentialOrigin: "", headers: [] });
    expect(endpointOnly.modelsEndpoint).toBeUndefined();
    const authorized = transferProviderRuntime(source, target, sourceBackend, sourceBackend, ["endpoint", "authentication"]);
    expect(authorized).toMatchObject({ credentialId: "source-key", credentialOrigin: "https://new.example", headers: [] });
    expect(target.credentialId).toBe("old-key");
    const mismatched = { ...target, endpoint: source.endpoint };
    for (const field of ["authentication", "headers"] as const) {
      expect(() => transferProviderRuntime(source, mismatched, sourceBackend, sourceBackend, [field])).toThrow(/unrelated/u);
    }
    expect(transferProviderRuntime(source, mismatched, sourceBackend, sourceBackend, ["authentication", "headers"]))
      .toMatchObject({ credentialId: "source-key", headers: source.headers, credentialOrigin: "https://new.example" });
    expect(() => transferProviderRuntime({ ...source, credentialOrigin: "https://other.example" }, route(sourceBackend), sourceBackend, sourceBackend, ["authentication"]))
      .toThrow(/authorization/u);
  });

  it("treats an unsubmitted destination key as a conflict without reading it into a diff", () => {
    const source = route(sourceBackend);
    const target = route(sourceBackend, { credentialId: "", credentialOrigin: "" });
    expect(providerTransferDifferences(source, target, sourceBackend, sourceBackend, false, true))
      .toContainEqual({ field: "authentication", state: "conflict" });
    expect(providerTransferDifferences(source, target, sourceBackend, sourceBackend, false, false))
      .toContainEqual({ field: "authentication", state: "empty" });
    const same = route(sourceBackend);
    expect(providerTransferDifferences(source, same, sourceBackend, sourceBackend)).toContainEqual({ field: "authentication", state: "same" });
    expect(providerTransferDifferences(source, same, sourceBackend, sourceBackend, true, true)).toContainEqual({ field: "authentication", state: "conflict" });
  });

  it("copies API credentials to fixed authentication protocols and reviews removal of header authentication", () => {
    const fixedBackend = { ...targetBackend, providerRuntimeSupport: { ...targetBackend.providerRuntimeSupport!, fields: ["keyless" as const] } };
    const fixed = route(fixedBackend, { credentialId: "target-key", authHeader: false });
    const source = route(sourceBackend);
    expect(providerTransferDifferences(source, fixed, sourceBackend, fixedBackend)).toContainEqual({ field: "authentication", state: "conflict" });
    expect(transferProviderRuntime(source, fixed, sourceBackend, fixedBackend, ["authentication"]))
      .toMatchObject({ credentialId: source.credentialId, authHeader: false });
    const noAuth = route(sourceBackend, { keyless: true, authHeader: false, credentialId: "", environmentName: "", credentialOrigin: "" });
    const headers = route(targetBackend, { credentialId: "", environmentName: "", headers: [{ headerName: "X-Route", credentialId: "header-key", environmentName: "HEADER_KEY" }] });
    expect(providerTransferDifferences(noAuth, headers, sourceBackend, targetBackend)).toContainEqual({ field: "authentication", state: "conflict" });
    expect(transferProviderRuntime(noAuth, headers, sourceBackend, targetBackend, ["authentication"]))
      .toMatchObject({ keyless: true, credentialId: "", credentialOrigin: "", headers: [] });
    expect(() => transferProviderRuntime({ ...noAuth, headers: headers.headers }, fixed, sourceBackend, fixedBackend, ["authentication"]))
      .toThrow(/unavailable/u);
  });

  it("rejects conflicting credential environment identities including a new key and platform case collisions", () => {
    const duplicate = route(sourceBackend, { headers: [{ headerName: "X-Route", credentialId: "header-key", environmentName: "route_key" }] });
    expect(providerCredentialBindingsValid(duplicate)).toBe(false);
    expect(providerCredentialBindingsValid({ ...duplicate, headers: [{ ...duplicate.headers[0]!, credentialId: duplicate.credentialId }] })).toBe(false);
    const shared = { ...duplicate, headers: [{ ...duplicate.headers[0]!, environmentName: duplicate.environmentName, credentialId: duplicate.credentialId }] };
    expect(providerCredentialBindingsValid(shared)).toBe(true);
    expect(providerCredentialBindingsValid(shared, true)).toBe(false);
    const headerOnly = { ...duplicate, credentialId: "", environmentName: "" };
    expect(providerCredentialBindingsValid(headerOnly)).toBe(true);
    expect(providerCredentialBindingsValid({ ...headerOnly, keyless: true })).toBe(false);
  });
});
