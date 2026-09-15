import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ManagedProviderSmartRoutingCandidate, ProviderModel } from "@joko/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodexSmartModelCatalog,
  buildCodexSmartRoutingLaunchArgs,
  inspectCodexSmartRouting,
  prepareCodexSmartRouting
} from "./smart-subagent-routing.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

describe("Codex smart subagent routing catalog", () => {
  it("preserves the native catalog and deterministically adds only authorized v2 models", () => {
    const built = buildCodexSmartModelCatalog(nativeCatalog(), "native-revision", "openai", [
      candidate("managed", "gpt-5.6-luna", "managed-a"),
      candidate("managed", "gpt-5.6-luna", "managed-a"),
      { ...candidate("managed", "tool-less", "ignored-tools"), model: { ...model("managed", "tool-less"), supportsTools: false } },
      { ...candidate("managed", "hidden-worker", "ignored-hidden"), model: { ...model("managed", "hidden-worker"), defaultVisible: false } },
      { ...candidate("unsupported", "cheap-chat", "ignored"), protocol: "anthropic-messages" }
    ]);

    expect(built).toBeDefined();
    expect(built!.routes).toEqual([
      { providerId: "managed", modelId: "gpt-5.6-luna", revision: "managed-a", native: false },
      { providerId: "openai", modelId: "gpt-6-astra", revision: "native:native-revision", native: true }
    ]);
    expect(built!.nativeRoutes).toEqual([
      { providerId: "openai", modelId: "gpt-5.6-terra", revision: "native:native-revision", native: true },
      { providerId: "openai", modelId: "gpt-5.6-sol", revision: "native:native-revision", native: true }
    ]);
    expect(built!.routes.map((route) => route.modelId)).not.toEqual(expect.arrayContaining([
      "gpt-disabled", "gpt-future", "gpt-hidden", "tool-less", "hidden-worker"
    ]));
    expect(built!.models.slice(0, 3).map((model) => model.slug)).toEqual([
      "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra"
    ]);
    expect(built!.models.find((model) => model.slug === "gpt-6-astra")).toMatchObject({
      preserved_field: "native",
      multi_agent_version: "v2"
    });
    expect(built!.models.find((model) => model.slug === "gpt-5.6-luna")).toMatchObject({
      display_name: "gpt-5.6-luna",
      multi_agent_version: "v2",
      visibility: "list",
      supported_in_api: true
    });
    expect(JSON.stringify(built)).not.toContain("ignored-secret");
    expect(buildCodexSmartModelCatalog(nativeCatalog(), "native-revision", "openai", [
      candidate("managed", "gpt-5.6-luna", "managed-a")
    ])?.revision).toBe(buildCodexSmartModelCatalog(nativeCatalog(), "native-revision", "openai", [
      candidate("managed", "gpt-5.6-luna", "managed-a")
    ])?.revision);
    const managedOnly = buildCodexSmartModelCatalog(nativeCatalog(), "native-revision", "openai", [
      candidate("managed", "gpt-5.6-luna", "managed-a")
    ], false)!;
    expect(managedOnly.nativeRoutes).toEqual([]);
    expect(managedOnly.models.filter((entry) => entry.slug === "gpt-5.6-sol" || entry.slug === "gpt-5.6-terra"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ slug: "gpt-5.6-sol", multi_agent_version: "v2", visibility: "hide" }),
        expect.objectContaining({ slug: "gpt-5.6-terra", multi_agent_version: "v2", visibility: "hide" })
      ]));
    expect(buildCodexSmartModelCatalog(nativeCatalog(), "native-revision", "openai", [
      candidate("managed", "gpt-5.6-sol", "must-not-shadow-native")
    ], false)).toBeUndefined();
    expect(() => buildCodexSmartRoutingLaunchArgs("relative/catalog.json", built!.routes)).toThrow(
      "launch inputs are invalid"
    );
    const escaped = buildCodexSmartRoutingLaunchArgs(resolve("catalog\nname.json"), built!.routes)[1]!;
    expect(escaped).toContain("\\nname.json");
    expect(escaped).not.toContain("\n");
  });

  it("fails closed instead of choosing between ambiguous model identities", () => {
    const duplicateNative = nativeCatalog().models.flatMap((model, index) => index === 2 ? [model, { ...model }] : [model]);
    expect(buildCodexSmartModelCatalog({ models: duplicateNative }, "native-revision", "openai", [])).toBeUndefined();

    const templatesOnly = { models: nativeCatalog().models.slice(0, 2) };
    expect(buildCodexSmartModelCatalog(templatesOnly, "native-revision", "openai", [
      candidate("managed-a", "shared-worker", "route-a"),
      candidate("managed-b", "shared-worker", "route-b")
    ])).toBeUndefined();

    const optedOutDefaults = {
      models: nativeCatalog().models.slice(0, 2).map((model) => ({ ...model, multi_agent_version: "disabled" }))
    };
    expect(buildCodexSmartModelCatalog(optedOutDefaults, "native-revision", "openai", [
      candidate("managed", "worker-model", "route-a")
    ])).toBeUndefined();
  });

  it("installs account-specific generation catalogs, exposes exact launch overrides, and cleans them up", async () => {
    const root = await temporaryDirectory();
    const codexHome = join(root, "profile");
    const outputDirectory = join(root, "runtime", "smart");
    await writeCatalog(codexHome, nativeCatalog());

    const preparation = await prepareCodexSmartRouting({
      desired: true,
      codexHome,
      outputDirectory,
      instanceGeneration: 7,
      nativeProviderId: "openai",
      managedCandidates: [candidate("managed", "gpt-5.6-luna", "managed-a")]
    });

    expect(preparation).toMatchObject({ desired: true, applied: true, unavailableReason: "" });
    expect(preparation.nativeRoutes.map((route) => route.modelId)).toEqual(["gpt-5.6-terra", "gpt-5.6-sol"]);
    expect(preparation.catalogPath).toContain("catalog-7-");
    expect(preparation.launchArgs).toEqual(buildCodexSmartRoutingLaunchArgs(
      preparation.catalogPath!,
      preparation.routes
    ));
    expect(preparation.launchArgs).toContain("features.multi_agent_v2.expose_spawn_agent_model_overrides=true");
    expect(preparation.managedOnly).toMatchObject({
      routes: [{ providerId: "managed", modelId: "gpt-5.6-luna", revision: "managed-a", native: false }],
      nativeRoutes: []
    });
    expect(preparation.managedOnlyInspection).toMatchObject({ candidateCount: 1, unavailableReason: "" });
    const installed = JSON.parse(await readFile(preparation.catalogPath!, "utf8")) as { models: unknown[] };
    const managedInstalled = JSON.parse(await readFile(preparation.managedOnly!.catalogPath, "utf8")) as {
      models: Array<{ readonly slug?: string; readonly visibility?: string }>;
    };
    expect(installed.models).toHaveLength(7);
    expect(managedInstalled.models.filter((entry) => entry.slug === "gpt-5.6-sol" || entry.slug === "gpt-5.6-terra"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ slug: "gpt-5.6-sol", visibility: "hide" }),
        expect.objectContaining({ slug: "gpt-5.6-terra", visibility: "hide" })
      ]));
    expect((await stat(preparation.catalogPath!)).isFile()).toBe(true);
    expect((await stat(preparation.managedOnly!.catalogPath)).isFile()).toBe(true);

    await preparation.cleanup();
    await preparation.cleanup();
    await expect(stat(preparation.catalogPath!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(preparation.managedOnly!.catalogPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for missing, malformed, and unbounded native catalogs without writing output", async () => {
    const root = await temporaryDirectory();
    const missing = await inspectCodexSmartRouting({
      desired: true,
      codexHome: join(root, "missing"),
      nativeProviderId: "openai",
      managedCandidates: [candidate("managed", "gpt-5.6-luna", "managed-a")]
    });
    expect(missing).toMatchObject({ candidateCount: 0, unavailableReason: expect.stringContaining("unavailable or unsafe") });

    const profile = join(root, "profile");
    await writeCatalog(profile, { models: Array.from({ length: 4_097 }, (_value, index) => ({ slug: `model-${index}` })) });
    const bounded = await prepareCodexSmartRouting({
      desired: true,
      codexHome: profile,
      outputDirectory: join(root, "output"),
      instanceGeneration: 1,
      nativeProviderId: "openai",
      managedCandidates: [candidate("managed", "gpt-5.6-luna", "managed-a")]
    });
    expect(bounded).toMatchObject({ desired: true, applied: false, unavailableReason: expect.stringContaining("no compatible") });
    expect(bounded.catalogPath).toBeUndefined();

    const disabled = await prepareCodexSmartRouting({
      desired: false,
      codexHome: join(root, "still-missing"),
      outputDirectory: join(root, "disabled-output"),
      instanceGeneration: 1,
      nativeProviderId: "openai",
      managedCandidates: []
    });
    expect(disabled).toMatchObject({ desired: false, applied: false, revision: "default", unavailableReason: "" });
  });
});

function nativeCatalog(): { readonly models: readonly Record<string, unknown>[] } {
  const common = {
    display_name: "Template",
    context_window: 128_000,
    max_output_tokens: 16_384,
    supported_reasoning_levels: [{ effort: "low", description: "Low" }],
    input_modalities: ["text", "image"],
    supported_in_api: true,
    visibility: "list",
    multi_agent_version: "v2",
    preserved_field: "native"
  };
  return { models: [
    { ...common, slug: "gpt-5.6-terra", priority: 1 },
    { ...common, slug: "gpt-5.6-sol", priority: 2 },
    { ...common, slug: "gpt-6-astra", priority: 3, multi_agent_version: null },
    { ...common, slug: "gpt-disabled", priority: 4, multi_agent_version: "disabled" },
    { ...common, slug: "gpt-future", priority: 5, multi_agent_version: "v3" },
    { ...common, slug: "gpt-hidden", priority: 6, visibility: "hide" }
  ] };
}

function candidate(providerId: string, modelId: string, revision: string): ManagedProviderSmartRoutingCandidate {
  return {
    providerId,
    model: model(providerId, modelId),
    protocol: "openai-responses",
    revision
  };
}

function model(providerId: string, modelId: string): ProviderModel {
  return {
    providerId,
    modelId,
    displayName: modelId,
    api: "openai-responses",
    contextWindow: 64_000,
    maxOutputTokens: 8_192,
    supportsImages: true,
    thinkingLevels: ["low", "medium"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "joko-codex-smart-routing-"));
  directories.push(directory);
  return directory;
}

async function writeCatalog(profile: string, value: unknown): Promise<void> {
  await mkdir(profile, { recursive: true });
  await writeFile(join(profile, "models_cache.json"), JSON.stringify(value), "utf8");
}
