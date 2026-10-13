// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import type { ManagedModelContextTarget, ManagedModelContextView, ManagedModelRuntimeView } from "../model.js";
import { ManagedModelRuntimeSettings } from "./ManagedModelRuntimeSettings.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("ManagedModelRuntimeSettings", () => {
  it("covers recommended, custom, resumable and installed model actions through capabilities", async () => {
    const calls: string[] = [];
    const controller = {
      state: { preferences: { locale: "en" } },
      refreshManagedModelRuntimes: vi.fn(async () => [runtime]),
      pullManagedModel: vi.fn(async (_runtimeId: string, name: string) => { calls.push(`pull:${name}`); return runtime; }),
      pauseManagedModelPull: vi.fn(async (_runtimeId: string, name: string) => { calls.push(`pause:${name}`); return runtime; }),
      resumeManagedModelPull: vi.fn(async (_runtimeId: string, name: string) => { calls.push(`resume:${name}`); return runtime; }),
      cancelManagedModelPull: vi.fn(async (_runtimeId: string, name: string) => { calls.push(`cancel:${name}`); return runtime; }),
      deleteManagedModel: vi.fn(async (_runtimeId: string, name: string) => { calls.push(`delete:${name}`); return runtime; })
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ManagedModelRuntimeSettings
      controller={controller}
      runtimes={[runtime]}
      runAction={(_key, action) => { void action(); }}
    />));

    expect(container.textContent).toContain("Recommended for this device");
    expect(container.textContent).toContain("Best for you");
    expect(container.textContent).toContain("Installed models");
    expect(container.textContent).toContain("25%");
    expect(container.textContent).toContain("Paused");

    await act(async () => buttonWithText(container, "Download & add").click());
    expect(calls).toContain("pull:recommended:a");

    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Resume download"]')).click());
    expect(calls).toContain("resume:paused:a");

    const manual = required(container.querySelector<HTMLInputElement>('[placeholder^="qwen3"]'));
    await act(async () => {
      setInputValue(manual, "custom:model");
      manual.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonWithText(container, "Download & add", true).click());
    expect(calls).toContain("pull:custom:model");

    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Delete Installed A"]')).click());
    await act(async () => buttonWithText(container, "Delete").click());
    expect(calls).toContain("delete:installed:a");
  });

  it("shows install preflight and cancel controls without inferring a concrete runtime identity", async () => {
    const installRuntime: ManagedModelRuntimeView = {
      ...runtime,
      id: "runtime-capability-a",
      name: "Local Runtime",
      state: "installing",
      capabilities: { ...runtime.capabilities, canInstall: true, canCancelInstall: true, canPullModels: false, supportsCustomModels: false },
      installedModels: [],
      catalog: [],
      transfers: [{ kind: "runtimeInstall", phase: "downloading", completedBytes: 50, totalBytes: 100, percent: 50, done: false }]
    };
    const cancel = vi.fn(async () => installRuntime);
    const controller = {
      state: { preferences: { locale: "en" } },
      refreshManagedModelRuntimes: vi.fn(async () => [installRuntime]),
      cancelManagedModelRuntimeInstall: cancel
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<ManagedModelRuntimeSettings
      controller={controller}
      runtimes={[installRuntime]}
      runAction={(_key, action) => { void action(); }}
    />));
    expect(container.textContent).toContain("50%");
    await act(async () => buttonWithText(container, "Cancel install").click());
    expect(cancel).toHaveBeenCalledWith("runtime-capability-a");
  });

  it("searches repository aliases and retains each active, paused and failed variant once with exact selection", async () => {
    const value = repositoryRuntime({ transfers: [repositoryTransfer("verifying", false)], catalog: [repositoryCatalog(), { ...repositoryCatalog(), id: "other", displayName: "Other model", recommended: false, variants: [{ repository: "Owner/Other-GGUF", file: "Other.Q4.gguf", quantization: "Q4", sizeBytes: 2_048 }] }] });
    const controller = repositoryController(value);
    const { container, root } = await mountRuntime(controller, value);
    expect(container.textContent).toContain("Host: Test chip · 16 GB memory");
    expect(container.textContent).toContain("English description");
    expect(container.textContent).toContain("GGUF · Q4_K_M");
    await changeInput(required(container.querySelector<HTMLInputElement>('[placeholder="Search models or paste a model name"]')), "no match");
    expect(container.querySelectorAll(".managed-model-runtime-model-card")).toHaveLength(1);
    expect(container.textContent).toContain("Verifying");
    for (const phase of ["paused", "error"] as const) {
      await act(async () => root.render(<ManagedModelRuntimeSettings controller={controller} runtimes={[{ ...value, transfers: [repositoryTransfer(phase, true)] }]} runAction={runNow} />));
      expect(container.querySelectorAll(".managed-model-runtime-model-card")).toHaveLength(1);
      expect(container.textContent).toContain(phase === "paused" ? "Paused" : "Failed");
    }
    await act(async () => buttonWithText(container, "Retry download").click());
    expect(controller.downloadManagedRepositoryModel).toHaveBeenCalledWith(value.id, exactRepositoryModel);
    await changeInput(required(container.querySelector<HTMLInputElement>('[placeholder="Search models or paste a model name"]')), "friendly alias");
    expect(container.textContent).toContain("Example model");
    expect(container.querySelector(".managed-model-runtime-more")).toBeNull();
  });

  it("queries exact repository files with loading, late query retirement, empty, failure and retry before shard selection", async () => {
    const value = repositoryRuntime();
    const controller = repositoryController(value);
    let finishOld!: (value: RepositoryFiles) => void;
    const old = new Promise<RepositoryFiles>((resolve) => { finishOld = resolve; });
    const list = vi.fn().mockImplementationOnce(() => old).mockRejectedValueOnce(new Error("query failed")).mockResolvedValueOnce({ repository: "Owner/New-GGUF", sourceRevision: "new", files: [] }).mockResolvedValueOnce({ repository: "Owner/New-GGUF", sourceRevision: "new", files: [{ file: "Split-00001-of-00002.gguf", sizeBytes: 6_144 }, { file: "Whole.gguf", sizeBytes: 1_024 }] });
    controller.listManagedModelRepositoryFiles = list;
    const { container } = await mountRuntime(controller, value);
    const input = required(container.querySelector<HTMLInputElement>('[placeholder="owner/model-GGUF"]'));
    await changeInput(input, "Owner/Old-GGUF");
    await act(async () => buttonWithText(container, "Find files").click());
    expect(container.textContent).toContain("Loading repository files");
    const oldSignal = list.mock.calls[0]![2] as AbortSignal;
    await changeInput(input, "Owner/New-GGUF");
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finishOld({ repository: "Owner/Old-GGUF", sourceRevision: "old", files: [{ file: "Old.gguf", sizeBytes: 1_024 }] }));
    expect(container.textContent).not.toContain("Old.gguf");
    await act(async () => buttonWithText(container, "Find files").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
    await act(async () => buttonWithText(container, "Retry").click());
    expect(container.textContent).toContain("No supported GGUF files");
    await act(async () => buttonWithText(container, "Find files").click());
    const file = required(container.querySelector<HTMLSelectElement>('select'));
    expect(file.options[0]?.textContent).toContain("6 KB");
    await act(async () => { file.value = "Whole.gguf"; file.dispatchEvent(new Event("change", { bubbles: true })); });
    await act(async () => buttonWithText(container.querySelector<HTMLElement>(".managed-model-runtime-repository")!, "Download & add").click());
    expect(controller.downloadManagedRepositoryModel).toHaveBeenCalledWith(value.id, { repository: "Owner/New-GGUF", file: "Whole.gguf" });
  });

  it("reopens paused repository transfers and sends captured transfer controls while keeping verifying visible", async () => {
    const value = repositoryRuntime({ transfers: [repositoryTransfer("paused", true)] });
    const controller = repositoryController(value);
    const { container, root } = await mountRuntime(controller, value);
    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Resume download"]')).click());
    expect(controller.controlManagedRepositoryDownload).toHaveBeenCalledWith(value.id, "transfer-one", exactRepositoryModel, "resume");
    await act(async () => root.render(<ManagedModelRuntimeSettings controller={controller} runtimes={[{ ...value, transfers: [repositoryTransfer("downloading", false)] }]} runAction={runNow} />));
    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Pause download"]')).click());
    await act(async () => required(container.querySelector<HTMLButtonElement>('[aria-label="Cancel download"]')).click());
    expect(controller.controlManagedRepositoryDownload).toHaveBeenCalledWith(value.id, "transfer-one", exactRepositoryModel, "pause");
    expect(controller.controlManagedRepositoryDownload).toHaveBeenCalledWith(value.id, "transfer-one", exactRepositoryModel, "cancel");
    await act(async () => root.render(<ManagedModelRuntimeSettings controller={controller} runtimes={[{ ...value, transfers: [repositoryTransfer("verifying", false)] }]} runAction={runNow} />));
    expect(container.textContent).toContain("Verifying");
    expect(container.querySelector('[aria-label="Delete Example installed"]')).toBeNull();
  });

  it("installs with explicit consent without starting and keeps stopped inventory downloadable on use", async () => {
    const value = repositoryRuntime({ state: "absent", installedModels: [] });
    const controller = repositoryController(value);
    const { container, root } = await mountRuntime(controller, value);
    await act(async () => buttonWithText(container, "Install in Joko").click());
    expect(controller.installManagedModelRuntime).toHaveBeenCalledWith(value.id);
    expect(controller.startManagedModelRuntime).not.toHaveBeenCalled();
    const stopped = repositoryRuntime({ state: "stopped" });
    await act(async () => root.render(<ManagedModelRuntimeSettings controller={controller} runtimes={[stopped]} runAction={runNow} />));
    expect(container.textContent).toContain("Example installed");
    expect(container.textContent).toContain("Starts automatically");
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Start runtime")).toBe(false);
    await act(async () => buttonWithText(container, "Download & add").click());
    expect(controller.downloadManagedRepositoryModel).toHaveBeenCalledWith(value.id, exactRepositoryModel);
    expect(controller.startManagedModelRuntime).not.toHaveBeenCalled();
  });

  it("shows owner action failures and preserves borrowed inventory with configuration disabled", async () => {
    const value = repositoryRuntime({ state: "ready", capabilities: { ...repositoryRuntime().capabilities, canStop: true, canRestart: true } });
    const controller = repositoryController(value);
    controller.stopManagedModelRuntime = vi.fn(async () => { throw new Error("stop unconfirmed"); });
    const { container, root } = await mountRuntime(controller, value);
    await act(async () => buttonWithText(container, "Restart").click());
    expect(controller.restartManagedModelRuntime).toHaveBeenCalledWith(value.id);
    await act(async () => buttonWithText(container, "Stop").click());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("action failed");
    const borrowed = { ...value, configureBlockedReason: "ownedElsewhere" as const, capabilities: { ...value.capabilities, canConfigure: false, canStop: false, canRestart: false } };
    await act(async () => root.render(<ManagedModelRuntimeSettings controller={controller} runtimes={[borrowed]} runAction={runNow} />));
    expect(container.textContent).toContain("Another application owns");
    expect(container.textContent).toContain("Example installed");
    expect(buttonWithText(container, "Download & add").disabled).toBe(true);
    expect(required(container.querySelector<HTMLInputElement>('[placeholder="owner/model-GGUF"]')).disabled).toBe(true);
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Stop" || button.textContent === "Restart")).toBe(false);
  });

  it("reads model context, validates limits and saves all current routes atomically with presets, reset and visible failure", async () => {
    const value = repositoryRuntime({ providerRoutes: [{ backendId: "route-one", providerId: "local-provider" }, { backendId: "route-two", providerId: "local-provider" }] });
    const controller = repositoryController(value);
    const target: ManagedModelContextTarget = { ...value.providerRoutes![0]!, modelId: "installed-model", repositoryModel: installedRepositoryModel, relatedTargets: [{ ...value.providerRoutes![1]!, modelId: "installed-model", repositoryModel: installedRepositoryModel }] };
    const context: ManagedModelContextView = { ...target, defaultContextWindowTokens: 262_144, effectiveContextWindowTokens: 262_144, maximumContextWindowTokens: 1_000_000, presets: [262_144, 1_000_000], customized: false, canConfigure: true, pendingApply: false, mixed: true };
    controller.getManagedModelContext = vi.fn().mockRejectedValueOnce(new Error("read failed")).mockResolvedValue(context);
    controller.setManagedModelContext = vi.fn().mockResolvedValueOnce({ ...context, effectiveContextWindowTokens: 1_000_000, customized: true, mixed: false, pendingApply: true }).mockRejectedValueOnce(new Error("save failed"));
    controller.resetManagedModelContext = vi.fn(async () => ({ ...context, mixed: false }));
    const { container } = await mountRuntime(controller, value);
    const section = required(container.querySelector<HTMLElement>(".managed-model-runtime-context"));
    expect(section.querySelector('[role="alert"]')?.textContent).toContain("could not be read or saved");
    await act(async () => buttonWithText(section, "Retry").click());
    expect(section.textContent).toContain("Default 262144 · Effective 262144 · Maximum 1000000");
    expect(section.textContent).toContain("different saved limits");
    const input = required(section.querySelector<HTMLInputElement>("input"));
    await changeInput(input, "1001");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(buttonWithText(section, "Save").disabled).toBe(true);
    await act(async () => buttonWithText(section, "1,000,000 tokens").click());
    expect(controller.setManagedModelContext).toHaveBeenCalledWith(value.id, target, 1_000_000);
    expect(section.textContent).toContain("Restart the running runtime");
    await changeInput(input, "128");
    await act(async () => buttonWithText(section, "Save").click());
    expect(section.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => buttonWithText(section, "Retry").click());
    expect(input.value).toBe("262.144");
    await act(async () => buttonWithText(section, "Restore default").click());
    expect(controller.resetManagedModelContext).toHaveBeenCalledWith(value.id, target);
  });
});

type RepositoryFiles = Awaited<ReturnType<AppController["listManagedModelRepositoryFiles"]>>;
const exactRepositoryModel = { repository: "Owner/Example-GGUF", file: "Example.Q4_K_M.gguf" };
const installedRepositoryModel = { repository: "Owner/Installed-GGUF", file: "Installed.gguf" };
function repositoryCatalog(): ManagedModelRuntimeView["catalog"][number] { return { ...runtime.catalog[0]!, id: "repo-model", name: "repo-model", displayName: "Example model", aliases: ["friendly alias"], descriptions: { en: "English description", "zh-CN": "中文描述", "zh-TW": "繁體描述", ja: "日本語", ko: "한국어" }, variants: [{ ...exactRepositoryModel, quantization: "Q4_K_M", sizeBytes: 4_096 }] }; }
function repositoryTransfer(phase: ManagedModelRuntimeView["transfers"][number]["phase"], done: boolean): ManagedModelRuntimeView["transfers"][number] { return { kind: "modelPull", transferId: "transfer-one", repositoryModel: exactRepositoryModel, phase, completedBytes: 4_096, totalBytes: 4_096, done }; }
function repositoryRuntime(overrides: Partial<ManagedModelRuntimeView> = {}): ManagedModelRuntimeView { return { ...runtime, id: "repository-runtime", name: "Repository runtime", state: "stopped", capabilities: { ...runtime.capabilities, canConfigure: true, canStop: false, canRestart: false, supportsRepositoryModels: true, startupPolicy: "onUse" }, catalog: [repositoryCatalog()], transfers: [], installedModels: [{ ...runtime.installedModels[0]!, name: "installed-model", displayName: "Example installed", repositoryModel: installedRepositoryModel }], providerRoutes: [], hostProfile: { platform: "darwin", arch: "arm64", memoryGb: 16, totalMemoryBytes: 16 * 1024 ** 3, appleSilicon: true, chip: "Test chip" }, ...overrides }; }
function repositoryController(value: ManagedModelRuntimeView): AppController { return { state: { effectiveLocale: "en" }, refreshManagedModelRuntimes: vi.fn(async () => [value]), downloadManagedRepositoryModel: vi.fn(async () => value), controlManagedRepositoryDownload: vi.fn(async () => value), installManagedModelRuntime: vi.fn(async () => value), startManagedModelRuntime: vi.fn(async () => value), stopManagedModelRuntime: vi.fn(async () => value), restartManagedModelRuntime: vi.fn(async () => value) } as unknown as AppController; }
const runNow = (_key: string, action: () => Promise<void>): void => { void action(); };
async function mountRuntime(controller: AppController, value: ManagedModelRuntimeView): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<ManagedModelRuntimeSettings controller={controller} runtimes={[value]} runAction={runNow} />));
  return { container, root };
}
async function changeInput(input: HTMLInputElement, value: string): Promise<void> { await act(async () => { setInputValue(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }

const runtime: ManagedModelRuntimeView = {
  id: "runtime-a",
  name: "Local Runtime",
  state: "ready",
  source: "running",
  version: "1.2.3",
  capabilities: {
    canInstall: true,
    canCancelInstall: false,
    canStart: true,
    canListModels: true,
    canPullModels: true,
    canDeleteModels: true,
    canPausePulls: true,
    canResumePulls: true,
    canCancelPulls: true,
    supportsCustomModels: true,
    supportsCuratedCatalog: true,
    supportsModelPreflight: true,
    canConfigure: true, canStop: false, canRestart: false, supportsRepositoryModels: false, startupPolicy: "explicit"
  },
  installPreflight: { allowed: true, memory: "sufficient", disk: "sufficient", requiredDiskBytes: 1_024 },
  installedModels: [{
    name: "installed:a",
    displayName: "Installed A",
    sizeBytes: 2_048,
    contextWindowTokens: 16_384,
    supportsTools: true,
    supportsImages: true
  }],
  catalog: [{
    id: "recommended-a",
    name: "recommended:a",
    displayName: "Recommended A",
    sizeBytes: 4_096,
    minimumMemoryGb: 8,
    platformLimited: false,
    recommended: true,
    preflight: { allowed: true, memory: "sufficient", disk: "sufficient", requiredDiskBytes: 8_192 }
  }, {
    id: "paused-a",
    name: "paused:a",
    displayName: "Paused A",
    sizeBytes: 4_096,
    minimumMemoryGb: 8,
    platformLimited: false,
    recommended: true,
    preflight: { allowed: true, memory: "sufficient", disk: "sufficient", requiredDiskBytes: 8_192 }
  }],
  transfers: [
    { kind: "modelPull", modelName: "paused:a", phase: "paused", completedBytes: 25, totalBytes: 100, percent: 25, done: true },
    { kind: "modelPull", modelName: "custom:active", phase: "downloading", completedBytes: 10, totalBytes: 100, percent: 10, done: false }
  ],
  revision: 1n
};

function buttonWithText(container: HTMLElement, text: string, last = false): HTMLButtonElement {
  const matches = [...container.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.textContent?.trim() === text);
  const button = last ? matches.at(-1) : matches[0];
  if (button === undefined) throw new Error(`Expected button ${text}.`);
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error("Expected rendered value.");
  return value;
}
