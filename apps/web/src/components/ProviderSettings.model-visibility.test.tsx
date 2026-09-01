// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { translate } from "../i18n.js";
import { modelPreferenceKey, providerPreferenceKey, readModelPickerOwnerPreferences, resetModelPickerPreferencesForTests } from "../model-picker-preferences.js";
import {
  emptySnapshot,
  type ManagedModelRuntimeView,
  type ModelView,
  type ProviderConfigurationView,
  type ProviderModelConfigurationView,
  type ProviderRuntimeView
} from "../model.js";
import { ProviderLoginDialog } from "./ProviderLoginDialog.js";
import { ProviderSettings, providerSettingsEntries } from "./SettingsPage.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  resetModelPickerPreferencesForTests();
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  window.history.replaceState(null, "", "#/");
  resetModelPickerPreferencesForTests();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("ProviderSettings model visibility", () => {
  it("keeps authenticated backend-native Provider entries separate when Provider IDs overlap", () => {
    const base = emptySnapshot();
    const configuration = provider("shared", "Shared account", { enabled: false, keyless: false });
    const catalog = providerSettingsEntries({
      ...base,
      providers: [
        providerRuntime(configuration, { backendId: "backend-a", ownerManaged: false, authenticationState: "authenticated", supportsLogin: true, loginMethods: ["oauthBrowser"] }),
        providerRuntime(configuration, { backendId: "backend-b", ownerManaged: false, authenticationState: "authenticated", supportsLogin: true, loginMethods: ["apiKey"] })
      ]
    });

    expect(catalog.configured).toHaveLength(2);
    expect(catalog.configured.map((entry) => entry.runtime?.backendId)).toEqual(["backend-a", "backend-b"]);
    expect(catalog.configured[0]?.id).not.toBe(catalog.configured[1]?.id);
    expect(catalog.available).toEqual([]);
    expect(catalog.detected).toEqual([]);
  });

  it("projects one configured Provider entry across related managed runtimes", () => {
    const base = emptySnapshot();
    const configuration = provider("shared", "Shared account", { models: [configuredModel("model", "Model")] });
    const catalog = providerSettingsEntries({
      ...base,
      providers: [
        providerRuntime(configuration, { backendId: "backend-a", authenticationState: "authenticated" }),
        providerRuntime(configuration, { backendId: "backend-b", authenticationState: "authenticated" })
      ],
      settings: { ...base.settings, providers: [configuration] }
    });

    expect(catalog.configured).toHaveLength(1);
    expect(catalog.configured[0]?.runtime?.backendId).toBe("backend-a");
  });

  it("does not offer an installed signed-out backend-native Provider without an in-app login method", () => {
    const base = emptySnapshot();
    const configuration = provider("external-account", "External account", { enabled: false, keyless: false });
    const catalog = providerSettingsEntries({
      ...base,
      backends: [{
        id: "backend-external-auth",
        name: "External CLI",
        version: "1",
        health: "healthy",
        installationState: "installed",
        authenticationState: "signedOut",
        capabilities: new Map()
      }],
      providers: [providerRuntime(configuration, {
        backendId: "backend-external-auth",
        ownerManaged: false,
        authenticationState: "signedOut",
        supportsLogin: false,
        loginMethods: []
      })]
    });

    expect(catalog.configured).toEqual([]);
    expect(catalog.detected).toEqual([]);
    expect(catalog.available).toEqual([]);
  });

  it("keeps installed owner-managed login catalogs out of detected providers", () => {
    const base = emptySnapshot();
    const configuration = provider("managed-template", "Managed template", {
      kind: "subscription",
      enabled: false,
      keyless: false
    });
    const catalog = providerSettingsEntries({
      ...base,
      backends: [{
        id: "backend-managed",
        name: "Managed runtime",
        version: "1",
        health: "healthy",
        installationState: "installed",
        authenticationState: "signedOut",
        capabilities: new Map()
      }],
      providers: [providerRuntime(configuration, {
        backendId: "backend-managed",
        ownerManaged: true,
        authenticationState: "signedOut",
        supportsLogin: true,
        loginMethods: ["subscription"]
      })],
      settings: { ...base.settings, providers: [configuration] }
    });

    expect(catalog.configured).toEqual([]);
    expect(catalog.available).toHaveLength(1);
    expect(catalog.detected).toEqual([]);
  });

  it("keeps signed-out managed catalog models in the add flow instead of treating their catalog as configuration", () => {
    const base = emptySnapshot();
    const configuration = provider("managed-template", "Managed template", {
      kind: "subscription",
      enabled: false,
      keyless: false,
      models: [configuredModel("catalog-model", "Catalog model")]
    });
    const catalog = providerSettingsEntries({
      ...base,
      providers: [providerRuntime(configuration, {
        ownerManaged: true,
        authenticationState: "signedOut",
        supportsLogin: true,
        loginMethods: ["subscription"]
      })],
      settings: { ...base.settings, providers: [configuration] }
    });

    expect(catalog.configured).toEqual([]);
    expect(catalog.available).toHaveLength(1);
    expect(catalog.detected).toEqual([]);
  });

  it("separates owner-managed and backend-native entries with the same Provider ID while retaining each complete management catalog", async () => {
    const base = emptySnapshot();
    const managedConfiguration = provider("shared", "Managed account", {
      models: [configuredModel("catalog-entry", "Catalog entry")]
    });
    const nativeConfiguration = provider("shared", "Native account", { enabled: false, keyless: false });
    const snapshot = {
      ...base,
      backends: [
        { id: "backend-managed", name: "Managed runtime", version: "1", health: "healthy" as const, capabilities: new Map() },
        { id: "backend-native", name: "Native runtime", version: "1", health: "healthy" as const, capabilities: new Map() }
      ],
      providers: [
        providerRuntime(managedConfiguration, { backendId: "backend-managed", ownerManaged: true, authenticationState: "authenticated" }),
        providerRuntime(nativeConfiguration, { backendId: "backend-native", ownerManaged: false, authenticationState: "authenticated" })
      ],
      models: [
        { ...catalogModel("shared", "catalog-entry", "Unavailable catalog entry"), backendId: "backend-managed", available: false },
        { ...catalogModel("shared", "native-one", "Native one"), backendId: "backend-native" },
        { ...catalogModel("shared", "native-two", "Native two"), backendId: "backend-native" },
        { ...catalogModel("shared", "native-unavailable", "Unavailable native entry"), backendId: "backend-native", available: false }
      ],
      settings: { ...base.settings, providers: [managedConfiguration] }
    };
    const catalog = providerSettingsEntries(snapshot);

    expect(catalog.configured).toHaveLength(2);
    expect(catalog.configured.map((entry) => entry.runtime?.ownerManaged)).toEqual([true, false]);

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controllerFor(snapshot)}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    const rows = [...container.querySelectorAll<HTMLElement>(".provider-master-row")];
    const managedRow = required(rows.find((row) => row.querySelector("strong")?.textContent === "Managed account"));
    const nativeRow = required(rows.find((row) => row.querySelector("strong")?.textContent === "Native account"));
    expect(managedRow.querySelector("small")?.textContent).toBe("1 model");
    expect(nativeRow.querySelector("small")?.textContent).toBe("3 models");
  });

  it("refreshes the snapshot when native browser login polling completes", async () => {
    vi.useFakeTimers();
    try {
      const pending = {
        id: "flow-one",
        providerId: "native-provider",
        method: "oauthBrowser" as const,
        state: "pending" as const,
        verificationUri: "https://accounts.example.test/authorize",
        updatedAt: 1
      };
      const refresh = vi.fn(async () => undefined);
      const openHttpLink = vi.fn(async () => undefined);
      const controller = {
        beginProviderLogin: vi.fn(async () => pending),
        getProviderLoginFlow: vi.fn(async () => ({ ...pending, state: "completed" as const, updatedAt: 2 })),
        openHttpLink,
        refresh,
        state: {
          preferences: { locale: "en" },
          snapshot: emptySnapshot()
        }
      } as unknown as AppController;
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      roots.push(root);
      await act(async () => root.render(<ProviderLoginDialog
        controller={controller}
        backendId="backend-native"
        provider={provider("native-provider", "Native Provider", { kind: "oauth" })}
        loginMethods={["oauthBrowser"]}
        t={(key, values) => translate("en", key, values)}
        onClose={() => undefined}
      />));

      const start = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent === "Start sign-in");
      if (start === undefined) throw new Error("Expected login start button.");
      await act(async () => start.click());
      await act(async () => vi.advanceTimersByTimeAsync(1_250));

      expect(openHttpLink).toHaveBeenCalledWith(pending.verificationUri, { forceExternal: true });
      expect(controller.getProviderLoginFlow).toHaveBeenCalledWith("flow-one");
      expect(refresh).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unconfigured login templates out of the rail and offers only supported templates in the add wizard", async () => {
    const base = emptySnapshot();
    const configured = provider("configured", "Configured");
    const signInTemplate = provider("sign-in-template", "Sign-in Template", {
      kind: "subscription",
      enabled: false,
      keyless: false
    });
    const unsupportedTemplate = provider("unsupported-template", "Unsupported Template", {
      kind: "apiKey",
      enabled: false,
      keyless: false
    });
    const snapshot = {
      ...base,
      providers: [
        providerRuntime(signInTemplate, { authenticationState: "signedOut", supportsLogin: true }),
        providerRuntime(unsupportedTemplate, { authenticationState: "signedOut", supportsLogin: false })
      ],
      settings: { ...base.settings, providers: [configured, signInTemplate, unsupportedTemplate] }
    };
    const controller = controllerFor(snapshot);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(providerNames(container)).toEqual(["Configured"]);

    const addProvider = required(container.querySelector<HTMLButtonElement>(".provider-master__footer button"));
    await act(async () => addProvider.click());
    const catalogNames = [...container.querySelectorAll<HTMLElement>(".provider-add-wizard__catalog strong")]
      .map((name) => name.textContent);
    expect(catalogNames).toContain("Sign-in Template");
    expect(catalogNames).not.toContain("Unsupported Template");
    expect(document.body.querySelector('.provider-add-wizard-modal .modal__header button[aria-label="Back"]')).not.toBeNull();
    expect(document.body.querySelector(".modal__header .provider-wizard-progress")).not.toBeNull();
    expect([...document.body.querySelectorAll<HTMLButtonElement>(".provider-add-wizard .provider-flow-footer button")]
      .some((button) => button.textContent === "Cancel")).toBe(false);
  });

  it("keeps an absent local runtime out of the configured rail and offers it only from the add flow", async () => {
    const base = emptySnapshot();
    const absentRuntime: ManagedModelRuntimeView = {
      id: "local-runtime",
      name: "Local runtime",
      state: "absent",
      source: "none",
      capabilities: {
        canInstall: true,
        canCancelInstall: false,
        canStart: false,
        canListModels: false,
        canPullModels: false,
        canDeleteModels: false,
        canPausePulls: false,
        canResumePulls: false,
        canCancelPulls: false,
        supportsCustomModels: false,
        supportsCuratedCatalog: false,
        supportsModelPreflight: false
      },
      installPreflight: { allowed: true, memory: "unknown", disk: "unknown", requiredDiskBytes: 0 },
      installedModels: [],
      catalog: [],
      transfers: [],
      revision: 0n
    };
    const snapshot = { ...base, managedModelRuntimes: [absentRuntime] };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controllerFor(snapshot)}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(container.querySelector(".provider-master")?.textContent).not.toContain("Local runtime");
    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-master__footer button")).click());
    expect(container.querySelector(".provider-add-wizard__catalog")?.textContent).toContain("Local runtime");
  });

  it("returns from local runtime onboarding through the footer Back action", async () => {
    const base = emptySnapshot();
    const absentRuntime: ManagedModelRuntimeView = {
      id: "local-runtime",
      name: "Local runtime",
      state: "absent",
      source: "none",
      capabilities: {
        canInstall: true,
        canCancelInstall: false,
        canStart: false,
        canListModels: false,
        canPullModels: false,
        canDeleteModels: false,
        canPausePulls: false,
        canResumePulls: false,
        canCancelPulls: false,
        supportsCustomModels: false,
        supportsCuratedCatalog: false,
        supportsModelPreflight: false
      },
      installPreflight: { allowed: true, memory: "unknown", disk: "unknown", requiredDiskBytes: 0 },
      installedModels: [],
      catalog: [],
      transfers: [],
      revision: 0n
    };
    const snapshot = { ...base, managedModelRuntimes: [absentRuntime] };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controllerFor(snapshot)}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-master__footer button")).click());
    const runtimeChoice = [...document.body.querySelectorAll<HTMLButtonElement>(".provider-add-wizard__catalog button")]
      .find((button) => button.textContent?.includes("Local runtime"));
    await act(async () => required(runtimeChoice ?? null).click());

    expect(document.body.querySelector('.provider-runtime-modal .modal__header button[aria-label="Back"]')).not.toBeNull();
    expect(document.body.querySelector(".provider-runtime-modal .modal__header")?.textContent).toContain("Add Local runtime");
    expect(document.body.querySelector(".provider-runtime-onboarding .provider-flow-header-back")).toBeNull();
    const back = required(document.body.querySelector<HTMLButtonElement>(".provider-runtime-modal .modal__header .provider-flow-header-back"));
    await act(async () => back.click());

    expect(document.body.querySelector(".provider-runtime-onboarding")).toBeNull();
    expect(document.body.querySelector(".provider-add-wizard")?.textContent).toContain("Local runtime");
  });

  it("returns from custom provider setup through the title-bar Back action", async () => {
    const snapshot = emptySnapshot();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controllerFor(snapshot)}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-master__footer button")).click());
    await act(async () => required(document.body.querySelector<HTMLButtonElement>(".provider-add-wizard__custom")).click());

    expect(document.body.querySelector(".provider-editor__actions .provider-flow-header-back")).toBeNull();
    const back = required(document.body.querySelector<HTMLButtonElement>(".provider-editor-modal .modal__header .provider-flow-header-back"));
    await act(async () => back.click());

    expect(document.body.querySelector(".provider-editor")).toBeNull();
    expect(document.body.querySelector(".provider-add-wizard")).not.toBeNull();
  });

  it("saves a custom endpoint through the managed credential channel before saving the provider", async () => {
    const snapshot = emptySnapshot();
    const calls: string[] = [];
    const saveCredential = vi.fn(async (_draft: unknown) => { calls.push("credential"); });
    const saveProvider = vi.fn(async (_draft: unknown) => { calls.push("provider"); });
    const controller = {
      refreshProviderModels: vi.fn(async () => undefined),
      saveCredential,
      saveProvider,
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={(_key, action) => { void action(); }}
      t={(key, values) => translate("en", key, values)}
    />));

    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-master__footer button")).click());
    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-add-wizard__custom")).click());
    await setControlValue(required(container.querySelector<HTMLInputElement>('input[placeholder="My model provider"]')), "Example provider");
    await setControlValue(required(container.querySelector<HTMLInputElement>('input[type="url"]')), "https://models.example.invalid/v1");
    await setControlValue(required(container.querySelector<HTMLInputElement>('input[type="password"]')), "test-secret");
    const modelInputs = container.querySelectorAll<HTMLInputElement>(".provider-model-card input");
    await setControlValue(required(modelInputs.item(0)), "example-model");
    await setControlValue(required(modelInputs.item(1)), "Example model");
    const save = required(container.querySelector<HTMLButtonElement>('.provider-editor__actions button[type="submit"]'));
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(calls).toEqual(["credential", "provider"]);
    expect(saveCredential).toHaveBeenCalledWith(expect.objectContaining({
      id: "credential-example-provider",
      providerId: "example-provider",
      environmentName: "JOKO_PROVIDER_EXAMPLE_PROVIDER_API_KEY",
      secret: "test-secret"
    }));
    expect(saveProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: "example-provider",
      credentialId: "credential-example-provider",
      environmentName: "JOKO_PROVIDER_EXAMPLE_PROVIDER_API_KEY",
      endpoint: "https://models.example.invalid/v1"
    }));
    expect(saveProvider.mock.calls[0]?.[0]).not.toHaveProperty("secret");
  });

  it("returns to provider selection when the chosen sign-in provider is wrong", async () => {
    const base = emptySnapshot();
    const signInTemplate = provider("sign-in-template", "Sign-in Template", {
      kind: "subscription",
      enabled: false,
      keyless: false
    });
    const snapshot = {
      ...base,
      providers: [providerRuntime(signInTemplate, { authenticationState: "signedOut", supportsLogin: true })],
      settings: { ...base.settings, providers: [signInTemplate] }
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controllerFor(snapshot)}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-master__footer button")).click());
    const providerChoice = [...document.body.querySelectorAll<HTMLButtonElement>(".provider-add-wizard__catalog button")]
      .find((button) => button.textContent?.includes("Sign-in Template"));
    await act(async () => required(providerChoice ?? null).click());
    expect(document.body.textContent).toContain("Add Sign-in Template");

    expect(document.body.querySelector(".provider-login .provider-flow-header-back")).toBeNull();
    const back = required(document.body.querySelector<HTMLButtonElement>(".provider-login-modal .modal__header .provider-flow-header-back"));
    await act(async () => back.click());

    expect(document.body.textContent).not.toContain("Add Sign-in Template");
    expect(document.body.querySelector(".provider-add-wizard")?.textContent).toContain("Sign-in Template");
  });

  it("does not leave an unconfigured signed-out provider detail behind when add is cancelled", async () => {
    const base = emptySnapshot();
    const signInTemplate = provider("sign-in-template", "Sign-in Template", {
      kind: "subscription",
      enabled: false,
      keyless: false
    });
    const snapshot = {
      ...base,
      providers: [providerRuntime(signInTemplate, { authenticationState: "signedOut", supportsLogin: true })],
      settings: { ...base.settings, providers: [signInTemplate] }
    };
    const deleteProvider = vi.fn(async (_providerId: string) => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={{ ...controllerFor(snapshot), deleteProvider } as unknown as AppController}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-master__footer button")).click());
    const providerChoice = [...document.body.querySelectorAll<HTMLButtonElement>(".provider-add-wizard__catalog button")]
      .find((button) => button.textContent?.includes("Sign-in Template"));
    await act(async () => required(providerChoice ?? null).click());
    const back = document.body.querySelector<HTMLButtonElement>('.provider-login-modal .modal__header button[aria-label="Back"]');
    await act(async () => required(back).click());

    expect(container.querySelector(".provider-master")?.textContent).not.toContain("Sign-in Template");
    expect(container.querySelector(".provider-detail")?.textContent).not.toContain("Sign-in Template");
    expect(deleteProvider).not.toHaveBeenCalled();
  });

  it("confirms before deleting an editable persisted provider through the controller", async () => {
    const base = emptySnapshot();
    const removable = provider("removable", "Removable provider", {
      models: [configuredModel("removable-model", "Removable model")]
    });
    const snapshot = { ...base, settings: { ...base.settings, providers: [removable] } };
    const deleteProvider = vi.fn(async (_providerId: string) => undefined);
    const controller = {
      ...controllerFor(snapshot),
      deleteProvider
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={(_key, action) => { void action(); }}
      t={(key, values) => translate("en", key, values)}
    />));

    const remove = required(container.querySelector<HTMLButtonElement>('[aria-label="Delete Removable provider"]'));
    await act(async () => remove.click());
    expect(deleteProvider).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Delete Removable provider?");

    const confirm = required(document.body.querySelector<HTMLButtonElement>(".modal .button--danger"));
    await act(async () => { confirm.click(); await Promise.resolve(); });
    expect(deleteProvider).toHaveBeenCalledOnce();
    expect(deleteProvider).toHaveBeenCalledWith("removable");
  });

  it("keeps disabled persisted providers and actionable authentication states in the rail", async () => {
    const base = emptySnapshot();
    const disabledPersisted = provider("disabled", "Disabled persisted", {
      enabled: false,
      models: [configuredModel("persisted-model", "Persisted model")]
    });
    const pending = provider("pending", "Pending provider", {
      kind: "oauth",
      enabled: false,
      keyless: false
    });
    const refreshing = provider("refreshing", "Refreshing provider", {
      kind: "subscription",
      enabled: false,
      keyless: false
    });
    const dormant = provider("dormant", "Dormant template", {
      kind: "subscription",
      enabled: false,
      keyless: false
    });
    const authenticated = provider("authenticated", "Authenticated provider", {
      kind: "subscription",
      enabled: false,
      keyless: false
    });
    const expired = provider("expired", "Expired provider", {
      kind: "oauth",
      enabled: false,
      keyless: false
    });
    const failed = provider("failed", "Failed provider", {
      kind: "apiKey",
      enabled: false,
      keyless: false
    });
    const snapshot = {
      ...base,
      providers: [
        providerRuntime(pending, { authenticationState: "pending", supportsLogin: true }),
        providerRuntime(refreshing, { authenticationState: "refreshing", supportsLogin: true }),
        providerRuntime(authenticated, { authenticationState: "authenticated", supportsLogin: true }),
        providerRuntime(expired, { authenticationState: "expired", supportsLogin: true }),
        providerRuntime(failed, { authenticationState: "error", supportsLogin: true }),
        providerRuntime(dormant, { authenticationState: "signedOut", supportsLogin: true })
      ],
      settings: { ...base.settings, providers: [disabledPersisted, pending, refreshing, authenticated, expired, failed, dormant] }
    };
    const controller = controllerFor(snapshot);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(providerNames(container)).toEqual([
      "Disabled persisted",
      "Pending provider",
      "Refreshing provider",
      "Authenticated provider",
      "Expired provider"
    ]);
    expect(container.textContent).not.toContain("Failed provider");
  });

  it("removes a configured native provider authorization and returns its template to Add provider", async () => {
    const base = emptySnapshot();
    const nativeProvider = provider("native-account", "Native account", {
      kind: "subscription",
      enabled: false,
      keyless: false
    });
    const authenticatedSnapshot = {
      ...base,
      providers: [providerRuntime(nativeProvider, {
        authenticationState: "authenticated",
        supportsLogin: true,
        supportsLogout: true
      })],
      settings: { ...base.settings, providers: [nativeProvider] }
    };
    const logoutProvider = vi.fn(async (_providerId: string) => undefined);
    const controller = {
      ...controllerFor(authenticatedSnapshot),
      logoutProvider
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const render = async (snapshot: typeof authenticatedSnapshot): Promise<void> => act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={(_key, action) => { void action(); }}
      t={(key, values) => translate("en", key, values)}
    />));
    await render(authenticatedSnapshot);

    expect(providerNames(container)).toEqual(["Native account"]);
    const remove = required(container.querySelector<HTMLButtonElement>('[aria-label="Remove Native account"]'));
    await act(async () => remove.click());
    expect(logoutProvider).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("removes the saved authorization for this built-in provider");

    const confirm = required(document.body.querySelector<HTMLButtonElement>(".modal .button--danger"));
    await act(async () => { confirm.click(); await Promise.resolve(); });
    expect(logoutProvider).toHaveBeenCalledOnce();
    expect(logoutProvider).toHaveBeenCalledWith("backend-provider-catalog", "native-account");

    const signedOutSnapshot = {
      ...authenticatedSnapshot,
      providers: [providerRuntime(nativeProvider, {
        authenticationState: "signedOut",
        supportsLogin: true,
        supportsLogout: true
      })]
    };
    await render(signedOutSnapshot);
    expect(providerNames(container)).toEqual([]);
    expect(container.querySelector(".provider-detail")?.textContent).not.toContain("Native account");
    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-master__footer button")).click());
    expect(document.body.querySelector(".provider-add-wizard__catalog")?.textContent).toContain("Native account");
  });

  it("derives the provider model count from the live model catalog instead of stale configuration metadata", async () => {
    const base = emptySnapshot();
    const configured = provider("provider", "Provider", { modelCount: 27 });
    const snapshot = {
      ...base,
      providers: [providerRuntime(configured)],
      models: [
        catalogModel("provider", "first", "First"),
        catalogModel("provider", "second", "Second"),
        catalogModel("another-provider", "unrelated", "Unrelated")
      ],
      settings: { ...base.settings, providers: [configured] }
    };
    const controller = controllerFor(snapshot);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    const railRow = required(container.querySelector<HTMLElement>(".provider-master-row"));
    expect(required(railRow.querySelector("small")).textContent).toBe("2 models");
    expect(container.textContent).not.toContain("27 models");
  });

  it("persists keyboard reordering and keeps absent Provider slots when the catalog changes", async () => {
    const base = emptySnapshot();
    const alpha = provider("alpha", "Alpha");
    const beta = provider("beta", "Beta");
    const firstSnapshot = {
      ...base,
      providers: [providerRuntime(alpha), providerRuntime(beta)],
      settings: { ...base.settings, providers: [alpha, beta] }
    };
    const controller = {
      refreshProviderModels: vi.fn(async () => undefined),
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot: firstSnapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const render = async (snapshot: typeof firstSnapshot): Promise<void> => act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));
    await render(firstSnapshot);

    const betaHandle = required(container.querySelector<HTMLButtonElement>('[aria-label="Reorder Beta"]'));
    await act(async () => betaHandle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(readModelPickerOwnerPreferences("orchestrator-one").providerOrder).toEqual([
      providerPreferenceKey("backend-provider-catalog", "beta"),
      providerPreferenceKey("backend-provider-catalog", "alpha")
    ]);
    expect(providerNames(container)).toEqual(["Beta", "Alpha"]);

    const gamma = provider("gamma", "Gamma");
    const withoutBeta = {
      ...firstSnapshot,
      providers: [providerRuntime(alpha), providerRuntime(gamma)],
      settings: { ...firstSnapshot.settings, providers: [alpha, gamma] }
    };
    await render(withoutBeta);
    expect(providerNames(container)).toEqual(["Alpha", "Gamma"]);
    expect(readModelPickerOwnerPreferences("orchestrator-one").providerOrder).toEqual([
      providerPreferenceKey("backend-provider-catalog", "beta"),
      providerPreferenceKey("backend-provider-catalog", "alpha"),
      providerPreferenceKey("backend-provider-catalog", "gamma")
    ]);

    const restored = {
      ...firstSnapshot,
      providers: [providerRuntime(alpha), providerRuntime(gamma), providerRuntime(beta)],
      settings: { ...firstSnapshot.settings, providers: [alpha, gamma, beta] }
    };
    await render(restored);
    expect(providerNames(container)).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("keeps hidden models in the catalog while removing them from this service owner's pickers", async () => {
    const base = emptySnapshot();
    const configured = provider("provider", "Provider");
    const snapshot = { ...base, models: [model], providers: [providerRuntime(configured)], settings: { ...base.settings, providers: [configured] } };
    const controller = {
      refreshProviderModels: vi.fn(async () => undefined),
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    const toggle = required(container.querySelector<HTMLButtonElement>('[aria-label="Hide Reasoner from model pickers"]'));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await act(async () => toggle.click());

    expect(container.textContent).toContain("Reasoner");
    expect(readModelPickerOwnerPreferences("orchestrator-one").visibility[
      modelPreferenceKey("backend-provider-catalog", "provider", "reasoner")
    ]).toBe(false);
    expect(toggle.getAttribute("aria-label")).toBe("Show Reasoner in model pickers");
  });

  it("starts newly discovered models hidden until this service owner shows them", async () => {
    const base = emptySnapshot();
    const configured = provider("provider", "Provider");
    const snapshot = { ...base, models: [{ ...model, defaultVisible: false }], providers: [providerRuntime(configured)], settings: { ...base.settings, providers: [configured] } };
    const controller = {
      refreshProviderModels: vi.fn(async () => undefined),
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    const toggle = required(container.querySelector<HTMLButtonElement>('[aria-label="Show Reasoner in model pickers"]'));
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await act(async () => toggle.click());

    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(readModelPickerOwnerPreferences("orchestrator-one").visibility[
      modelPreferenceKey("backend-provider-catalog", "provider", "reasoner")
    ]).toBe(true);
  });

  it("auto-refreshes once on open and reports manual refresh progress", async () => {
    let finishManualRefresh: (() => void) | undefined;
    const refreshProviderModels = vi.fn((providerId?: string, automatic?: boolean): Promise<void> => {
      if (automatic === true) return Promise.resolve();
      return new Promise<void>((resolve) => { finishManualRefresh = resolve; });
    });
    const base = emptySnapshot();
    const provider = {
      id: "provider",
      name: "Provider",
      kind: "customEndpoint" as const,
      compatibility: "openaiChat" as const,
      endpoint: "https://provider.invalid/v1",
      credentialId: "credential",
      enabled: true,
      keyless: false,
      authHeader: true,
      environmentName: "",
      modelCount: 1,
      headers: [],
      models: []
    };
    const snapshot = {
      ...base,
      providers: [{
        backendId: "backend-provider-catalog",
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        compatibility: provider.compatibility,
        authenticationState: "authenticated" as const,
        endpoint: provider.endpoint,
        ownerManaged: true,
        supportsLogin: false,
        loginMethods: [],
        supportsLogout: false,
        supportsRefresh: false,
        supportsModelRefresh: true,
        credentialSurfaces: [],
        capabilities: new Set<string>()
      }],
      settings: { ...base.settings, providers: [provider] }
    };
    const controller = {
      refreshProviderModels,
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(refreshProviderModels).toHaveBeenCalledWith("backend-provider-catalog", undefined, true);
    const refresh = required(container.querySelector<HTMLButtonElement>('[aria-label="Refresh model catalog Provider"]'));
    await act(async () => refresh.click());
    expect(refreshProviderModels).toHaveBeenLastCalledWith("backend-provider-catalog", "provider", false);
    expect(container.textContent).toContain("Refreshing model catalog…");
    await act(async () => finishManualRefresh?.());
    expect(container.textContent).toContain("Model catalog refreshed.");
  });

  it("disables a Provider across related runtimes and supports per-runtime model visibility", async () => {
    const base = emptySnapshot();
    const configuration = provider("shared-provider", "Shared Provider", { keyless: false });
    const secondConfiguration = provider("shared-provider", "Shared Provider", { keyless: false });
    const snapshot = {
      ...base,
      backends: [
        { id: "backend-a", name: "Runtime A", version: "1", health: "healthy" as const, capabilities: new Map() },
        { id: "backend-b", name: "Runtime B", version: "1", health: "healthy" as const, capabilities: new Map() }
      ],
      providers: [
        providerRuntime(configuration, { backendId: "backend-a", ownerManaged: true, authenticationState: "authenticated", routingEnabled: true }),
        providerRuntime(secondConfiguration, { backendId: "backend-b", ownerManaged: true, authenticationState: "authenticated", routingEnabled: true })
      ],
      models: [
        { ...catalogModel("shared-provider", "shared-model", "Shared model"), backendId: "backend-a" },
        { ...catalogModel("shared-provider", "bridge/shared-model", "Shared model"), backendId: "backend-b", logicalId: "shared-model" }
      ],
      settings: { ...base.settings, providers: [configuration] }
    };
    const updateBackendSettings = vi.fn(async () => undefined);
    const controller = {
      refreshProviderModels: vi.fn(async () => undefined),
      updateBackendSettings,
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={(_key, action) => { void action(); }}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(providerNames(container)).toEqual(["Shared Provider"]);
    expect(required(container.querySelector<HTMLElement>(".provider-master-row small")).textContent).toBe("1 model");

    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-detail__actions .provider-overflow-menu > summary")).click());
    const disableProvider = [...container.querySelectorAll<HTMLButtonElement>(".provider-overflow-menu button")]
      .find((button) => button.textContent === "Disable provider");
    await act(async () => { required(disableProvider ?? null).click(); await Promise.resolve(); });
    expect(updateBackendSettings).toHaveBeenCalledWith("backend-a", { modelAccessUpdate: { providerId: "shared-provider", enabled: false } });
    expect(updateBackendSettings).toHaveBeenCalledWith("backend-b", { modelAccessUpdate: { providerId: "shared-provider", enabled: false } });

    const split = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Adjust separately");
    await act(async () => required(split ?? null).click());
    expect(container.textContent).toContain("Runtime A");
    expect(container.textContent).toContain("Runtime B");
    const routeSwitches = [...container.querySelectorAll<HTMLButtonElement>(".provider-model-row--split [role=switch]")];
    expect(routeSwitches).toHaveLength(2);
    await act(async () => routeSwitches[1]?.click());
    expect(readModelPickerOwnerPreferences("orchestrator-one").visibility[
      modelPreferenceKey("backend-b", "shared-provider", "bridge/shared-model")
    ]).toBe(false);

    const together = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Done");
    await act(async () => required(together ?? null).click());
    const divergence = [...container.querySelectorAll<HTMLButtonElement>(".provider-model-row__divergence")]
      .find((button) => button.textContent === "Hidden in Runtime B");
    expect(required(container.querySelector<HTMLButtonElement>(".provider-model-row [role=switch]")).getAttribute("aria-checked")).toBe("true");
    await act(async () => required(divergence ?? null).click());

    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-model-row__menu > summary")).click());
    const disableModel = [...container.querySelectorAll<HTMLButtonElement>(".provider-model-row__menu button")]
      .find((button) => button.textContent === "Disable model");
    await act(async () => { required(disableModel ?? null).click(); await Promise.resolve(); });
    expect(updateBackendSettings).toHaveBeenCalledWith("backend-a", { modelAccessUpdate: { providerId: "shared-provider", modelId: "shared-model", enabled: false } });
    expect(updateBackendSettings).toHaveBeenCalledWith("backend-b", { modelAccessUpdate: { providerId: "shared-provider", modelId: "bridge/shared-model", enabled: false } });
  });

  it("keeps every related runtime column when a model route is unavailable", async () => {
    const base = emptySnapshot();
    const configuration = provider("shared-provider", "Shared Provider", { keyless: false });
    const snapshot = {
      ...base,
      backends: [
        { id: "backend-a", name: "Runtime A", version: "1", health: "healthy" as const, capabilities: new Map() },
        { id: "backend-b", name: "Runtime B", version: "1", health: "healthy" as const, capabilities: new Map() }
      ],
      providers: [
        providerRuntime(configuration, { backendId: "backend-a", ownerManaged: true, authenticationState: "authenticated" }),
        providerRuntime(configuration, { backendId: "backend-b", ownerManaged: true, authenticationState: "authenticated" })
      ],
      models: [{ ...catalogModel("shared-provider", "runtime-a-only", "Runtime A only"), backendId: "backend-a" }],
      settings: { ...base.settings, providers: [configuration] }
    };
    const controller = {
      refreshProviderModels: vi.fn(async () => undefined),
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(container.textContent).toContain("Not supported by Runtime B");
    const split = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Adjust separately");
    await act(async () => required(split ?? null).click());
    expect([...container.querySelectorAll(".provider-model-split-header > span")].map((item) => item.textContent)).toEqual(["", "Runtime A", "Runtime B", ""]);
    expect(container.querySelectorAll(".provider-model-row--split [role=switch]")).toHaveLength(1);
    expect(required(container.querySelector<HTMLElement>(".provider-model-route-empty")).textContent).toBe("—");
  });

  it("shows a disabled Provider state and restores it without exposing its model list", async () => {
    const base = emptySnapshot();
    const configuration = provider("provider", "Provider", { keyless: false });
    const snapshot = {
      ...base,
      backends: [{ id: "backend-provider-catalog", name: "Runtime", version: "1", health: "healthy" as const, capabilities: new Map() }],
      providers: [providerRuntime(configuration, {
        ownerManaged: false,
        authenticationState: "authenticated",
        routingEnabled: false
      })],
      models: [catalogModel("provider", "model", "Model")]
    };
    const updateBackendSettings = vi.fn(async () => undefined);
    const controller = {
      refreshProviderModels: vi.fn(async () => undefined),
      updateBackendSettings,
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={(_key, action) => { void action(); }}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(required(container.querySelector<HTMLElement>(".provider-master-row")).classList.contains("is-disabled")).toBe(true);
    expect(required(container.querySelector<HTMLElement>(".provider-master-row small")).textContent).toBe("Disabled");
    expect(container.querySelector(".provider-detail__title")?.textContent).toContain("Disabled");
    expect(container.textContent).toContain("This provider is disabled. Credentials are kept; enable it to use its models again.");
    expect(container.querySelector(".provider-model-toolbar")).toBeNull();
    const enableAgain = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Enable again");
    await act(async () => { required(enableAgain ?? null).click(); await Promise.resolve(); });
    expect(updateBackendSettings).toHaveBeenCalledWith("backend-provider-catalog", {
      modelAccessUpdate: { providerId: "provider", enabled: true }
    });
  });

  it("keeps the recovery action for a disabled model that is no longer in the catalog", async () => {
    const base = emptySnapshot();
    const configuration = provider("provider", "Provider", { keyless: false });
    const snapshot = {
      ...base,
      backends: [{ id: "backend-provider-catalog", name: "Runtime", version: "1", health: "healthy" as const, capabilities: new Map() }],
      providers: [providerRuntime(configuration, { ownerManaged: false, authenticationState: "authenticated" })],
      models: [],
      settings: {
        ...base.settings,
        backendSettings: [{
          backendId: "backend-provider-catalog",
          enabled: true,
          permissionMode: "ask" as const,
          planMode: false,
          modelAccess: {
            disabledProviderIds: [],
            disabledModels: [{ providerId: "provider", modelId: "retired-model" }]
          }
        }]
      }
    };
    const updateBackendSettings = vi.fn(async () => undefined);
    const controller = {
      refreshProviderModels: vi.fn(async () => undefined),
      updateBackendSettings,
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={(_key, action) => { void action(); }}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(container.querySelector(".provider-model-group--disabled")?.textContent).toContain("1");
    const enableAll = [...container.querySelectorAll<HTMLButtonElement>(".provider-model-group--disabled button")]
      .find((button) => button.textContent === "Enable all");
    await act(async () => { required(enableAll ?? null).click(); await Promise.resolve(); });
    expect(updateBackendSettings).toHaveBeenCalledWith("backend-provider-catalog", {
      modelAccessUpdate: { providerId: "provider", modelId: "retired-model", enabled: true }
    });
  });

  it("moves a logical model to disabled when any runtime route is disabled", async () => {
    const base = emptySnapshot();
    const first = provider("shared-provider", "Shared Provider", { keyless: false });
    const second = provider("shared-provider", "Shared Provider", { keyless: false });
    const snapshot = {
      ...base,
      backends: [
        { id: "backend-a", name: "Runtime A", version: "1", health: "healthy" as const, capabilities: new Map() },
        { id: "backend-b", name: "Runtime B", version: "1", health: "healthy" as const, capabilities: new Map() }
      ],
      providers: [
        providerRuntime(first, { backendId: "backend-a", ownerManaged: true, authenticationState: "authenticated" }),
        providerRuntime(second, { backendId: "backend-b", ownerManaged: true, authenticationState: "authenticated" })
      ],
      models: [
        { ...catalogModel("shared-provider", "shared-model", "Shared model"), backendId: "backend-a", routingEnabled: true },
        { ...catalogModel("shared-provider", "shared-model", "Shared model"), backendId: "backend-b", routingEnabled: false }
      ],
      settings: { ...base.settings, providers: [first] }
    };
    const updateBackendSettings = vi.fn(async () => undefined);
    const controller = {
      refreshProviderModels: vi.fn(async () => undefined),
      updateBackendSettings,
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={(_key, action) => { void action(); }}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(container.querySelectorAll(".provider-model-group--disabled .provider-model-row")).toHaveLength(1);
    expect(container.querySelectorAll(".provider-model-row [role=switch]")).toHaveLength(0);
    await act(async () => { required(container.querySelector<HTMLButtonElement>(".provider-model-row__enable")).click(); await Promise.resolve(); });
    expect(updateBackendSettings).toHaveBeenCalledWith("backend-a", { modelAccessUpdate: { providerId: "shared-provider", modelId: "shared-model", enabled: true } });
    expect(updateBackendSettings).toHaveBeenCalledWith("backend-b", { modelAccessUpdate: { providerId: "shared-provider", modelId: "shared-model", enabled: true } });
  });

  it("separates capability-only and disabled models from picker visibility", async () => {
    const base = emptySnapshot();
    const configuration = provider("provider", "Provider", { keyless: false });
    const snapshot = {
      ...base,
      backends: [{ id: "backend-provider-catalog", name: "Runtime", version: "1", health: "healthy" as const, capabilities: new Map() }],
      providers: [providerRuntime(configuration, { ownerManaged: false, authenticationState: "authenticated" })],
      models: [
        { ...catalogModel("provider", "disabled-model", "Disabled model"), routingEnabled: false },
        { ...catalogModel("provider", "image-model", "Image model"), outputModalities: ["image" as const], routingEnabled: true }
      ]
    };
    const updateBackendSettings = vi.fn(async () => undefined);
    const controller = {
      refreshProviderModels: vi.fn(async () => undefined),
      updateBackendSettings,
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={(_key, action) => { void action(); }}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(container.textContent).toContain("Image generation");
    expect(container.textContent).toContain("Disabled");
    expect(container.querySelectorAll(".provider-model-row [role=switch]")).toHaveLength(0);
    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-model-group--capability > .provider-model-group__heading")).click());
    expect(container.textContent).toContain("Image model");
    expect(container.querySelectorAll(".provider-model-group--capability [role=switch]")).toHaveLength(0);

    const enableModel = required(container.querySelector<HTMLButtonElement>(".provider-model-group--disabled .provider-model-row__enable"));
    expect(enableModel.textContent).toBe("Enable This Model");
    await act(async () => { enableModel.click(); await Promise.resolve(); });
    expect(updateBackendSettings).toHaveBeenCalledWith("backend-provider-catalog", {
      modelAccessUpdate: { providerId: "provider", modelId: "disabled-model", enabled: true }
    });
  });

  it("shows authoritative account windows, plan, and credits without inventing unknown totals", async () => {
    const refreshProviderAccountUsage = vi.fn(async () => undefined);
    const base = emptySnapshot();
    const configured = provider("subscription", "Subscription");
    const snapshot = {
      ...base,
      providers: [{
        backendId: "backend-provider-catalog",
        id: configured.id,
        name: configured.name,
        kind: "subscription" as const,
        compatibility: configured.compatibility,
        authenticationState: "authenticated" as const,
        endpoint: "",
        ownerManaged: true,
        supportsLogin: true,
        loginMethods: ["subscription" as const],
        supportsLogout: true,
        supportsRefresh: true,
        credentialSurfaces: [],
        capabilities: new Set(["provider.account_usage"]),
        accountUsage: {
          primaryWindow: { usedPercent: 42, windowMinutes: 300, resetAt: Date.now() + 3_600_000 },
          secondaryWindow: { usedPercent: 75.5, windowMinutes: 10_080, resetAt: Date.now() + 7_200_000 },
          limitReached: true,
          planType: "pro",
          credits: { hasCredits: true, unlimited: false, balance: "4.50" },
          observedAt: Date.now()
        }
      }],
      settings: { ...base.settings, providers: [{ ...configured, kind: "subscription" as const }] }
    };
    const controller = {
      refreshProviderModels: vi.fn(async () => undefined),
      refreshProviderAccountUsage,
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(container.textContent).toContain("Plan pro");
    expect(container.textContent).toContain("Account limit reached");
    expect(container.textContent).toContain("Primary window · 42% used · 300 min window");
    expect(container.textContent).toContain("Secondary window · 75.5% used · 10,080 min window");
    expect(container.textContent).toContain("Credits 4.50");
    expect(container.textContent).not.toContain("0/0");
    const accountUsage = required(container.querySelector<HTMLElement>('[aria-label="Provider account usage"]'));
    expect(accountUsage.classList.contains("provider-account-usage")).toBe(true);
    expect([...accountUsage.querySelectorAll('[role="listitem"]')].map((item) => item.textContent)).toHaveLength(5);
    expect(refreshProviderAccountUsage).toHaveBeenCalledOnce();
    expect(refreshProviderAccountUsage).toHaveBeenCalledWith("backend-provider-catalog", "subscription");

    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      runAction={() => undefined}
      t={(key, values) => translate("en", key, values)}
    />));
    expect(refreshProviderAccountUsage).toHaveBeenCalledOnce();
  });

  it("mounts the credential vault from its deep link and confirms destructive deletion", async () => {
    const base = emptySnapshot();
    const credential = {
      id: "credential-one",
      name: "Primary key",
      kind: "apiKey" as const,
      providerId: "",
      configured: true
    };
    const snapshot = {
      ...base,
      settings: { ...base.settings, credentials: [credential] }
    };
    const deleteCredential = vi.fn(async () => undefined);
    const controller = {
      refreshProviderModels: vi.fn(async () => undefined),
      deleteCredential,
      state: {
        activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
        preferences: { locale: "en" },
        snapshot
      }
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    window.history.replaceState(null, "", "#/settings/providers/credentials");
    await act(async () => root.render(<ProviderSettings
      controller={controller}
      snapshot={snapshot}
      initialView="credentials"
      runAction={(_key, action) => { void action(); }}
      t={(key, values) => translate("en", key, values)}
    />));

    expect(container.querySelector('.provider-master-row[aria-current="true"]')?.textContent).toContain("Credentials");
    expect(container.querySelector(".provider-vault-header")?.textContent).toContain("Add credential");
    expect(container.querySelector(".provider-detail__scroll.provider-vault")).not.toBeNull();
    expect(container.textContent).toContain("Primary key");
    expect(document.body.querySelector(".modal")).toBeNull();

    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-vault-header button")).click());
    expect(document.body.querySelector(".credential-editor-modal .modal__header .provider-flow-header-back")).not.toBeNull();
    expect(document.body.querySelector(".credential-editor-modal .modal__body .provider-flow-header-back")).toBeNull();
    await act(async () => required(document.body.querySelector<HTMLButtonElement>(".credential-editor-modal .provider-flow-header-back")).click());
    expect(document.body.querySelector(".credential-editor-modal")).toBeNull();

    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Delete Primary key"]')).click());
    expect(document.body.textContent).toContain("Delete Primary key?");
    expect(deleteCredential).not.toHaveBeenCalled();

    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>(".modal__actions button")]
      .find((button) => button.textContent === "Delete");
    await act(async () => {
      required(confirm ?? null).click();
      await Promise.resolve();
    });
    expect(deleteCredential).toHaveBeenCalledOnce();
    expect(deleteCredential).toHaveBeenCalledWith("credential-one");

    await act(async () => required(container.querySelector<HTMLButtonElement>(".provider-detail__mobile-back")).click());
    expect(window.location.hash).toBe("#/settings/providers");
  });
});

const model: ModelView = {
  backendId: "backend-provider-catalog",
  providerId: "provider",
  providerName: "Provider",
  modelId: "reasoner",
  name: "Reasoner",
  available: true,
  supportsImages: false,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportsFast: true,
  efforts: ["low", "high"],
  contextWindow: 128_000,
  maximumOutputTokens: 8_192,
  inputCostMicrosPerMillion: 100,
  outputCostMicrosPerMillion: 300,
  currencyCode: "USD"
};

function provider(id: string, name: string, overrides: Partial<ProviderConfigurationView> = {}): ProviderConfigurationView {
  return {
    id,
    name,
    kind: "customEndpoint" as const,
    compatibility: "openaiChat" as const,
    endpoint: `https://${id}.invalid/v1`,
    credentialId: "",
    enabled: true,
    keyless: true,
    authHeader: true,
    environmentName: "",
    modelCount: 0,
    headers: [],
    models: [],
    ...overrides
  };
}

function providerRuntime(
  configuration: ProviderConfigurationView,
  overrides: Partial<ProviderRuntimeView> = {}
): ProviderRuntimeView {
  return {
    backendId: "backend-provider-catalog",
    id: configuration.id,
    name: configuration.name,
    kind: configuration.kind,
    compatibility: configuration.compatibility,
    authenticationState: "unknown",
    endpoint: configuration.endpoint,
    ownerManaged: true,
    supportsLogin: false,
    supportsLogout: false,
    supportsRefresh: false,
    supportsModelRefresh: false,
    capabilities: new Set<string>(),
    ...overrides,
    credentialSurfaces: overrides.credentialSurfaces ?? [],
    loginMethods: overrides.loginMethods ?? (configuration.kind === "apiKey"
      ? ["apiKey"]
      : configuration.kind === "subscription"
        ? ["subscription"]
        : configuration.kind === "oauth" ? ["oauthBrowser", "deviceCode"] : [])
  };
}

function configuredModel(modelId: string, name: string): ProviderModelConfigurationView {
  return {
    modelId,
    name,
    reasoning: false,
    inputModalities: ["text"],
    contextWindowTokens: 32_000,
    maximumOutputTokens: 4_096,
    inputCostMicrosPerMillion: 0,
    outputCostMicrosPerMillion: 0,
    cacheReadCostMicrosPerMillion: 0,
    cacheWriteCostMicrosPerMillion: 0,
    thinkingLevels: [],
    supportsFastMode: false
  };
}

function catalogModel(providerId: string, modelId: string, name: string): ModelView {
  return {
    ...model,
    providerId,
    providerName: providerId,
    modelId,
    name
  };
}

function controllerFor(snapshot: ReturnType<typeof emptySnapshot>): AppController {
  return {
    refreshProviderModels: vi.fn(async () => undefined),
    state: {
      activeProfile: { id: "profile-one", serverId: "orchestrator-one", name: "Orchestrator", origin: "https://orchestrator.invalid" },
      preferences: { locale: "en" },
      snapshot
    }
  } as unknown as AppController;
}

function providerNames(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll<HTMLElement>(".provider-order-list .provider-master-row strong")]
    .map((name) => name.textContent);
}

async function setControlValue(control: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected rendered value.");
  return value;
}
