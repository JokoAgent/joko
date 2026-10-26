/// <reference types="node" />

import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observePackagedSmokeWindowRetirement } from "../src/packaged-smoke-window-retirement.js";

interface SmokePackagedHelpers {
  readonly authoritativeSmokeJourneyError: (
    signal: AbortSignal,
    fallback?: unknown
  ) => Error | undefined;
  readonly applyPrimaryChildExitFence: (options: {
    readonly outcome: { readonly code: number | null; readonly signal: string | null };
    readonly marker: string;
    readonly progress: readonly string[];
    readonly requiredProgress: readonly string[];
    readonly abortController: AbortController;
  }) => { readonly failure: Error | undefined; readonly ownsAbort: boolean };
  readonly claimSmokeJourneyFailure: (options: {
    readonly abortController: AbortController;
    readonly failure: unknown;
    readonly source: "primary" | "second-instance" | "timeout" | "orchestration";
  }) => {
    readonly failure: Error;
    readonly ownsAbort: boolean;
    readonly terminatePrimary: boolean;
    readonly timedOut: boolean;
  };
  readonly canonicalSmokeDirectoryForRemoval: (directory: string, temporaryRoot: string) => string | undefined;
  readonly compareConfiguredExtraResourceMirrors: (options: {
    readonly applicationRoot: string;
    readonly artifactResourcesRoot: string;
    readonly extraResources: readonly {
      readonly from: string;
      readonly to: string;
      readonly filter?: readonly string[];
    }[];
  }) => { readonly missing: string[]; readonly unexpected: string[]; readonly changed: string[] };
  readonly comparePackagedApplicationMirror: (
    sourceRoot: string,
    artifactRoot: string
  ) => { readonly missing: string[]; readonly unexpected: string[]; readonly changed: string[] };
  readonly filesHaveEqualContents: (left: string, right: string) => boolean;
  readonly finalizeSmokeRun: (options: {
    readonly runJourney: () => Promise<unknown>;
    readonly preserveEvidence?: (result: { readonly passed: boolean; readonly payload: unknown }) => Promise<void> | void;
    readonly cleanupTemporaryDirectory: () => Promise<void> | void;
    readonly retainFailure: boolean;
    readonly reportRetained: () => void;
    readonly emitSuccess: (payload: unknown) => Promise<void> | void;
  }) => Promise<unknown>;
  readonly managedRuntimeCleanupDecision: (
    endpoint: "matchedLive" | "mismatchedLive" | "stopped" | "unreachable",
    processIdentity: "matched" | "mismatched" | "absent" | "unavailable"
  ) => "terminate" | "identityFailure" | "complete";
  readonly parseManagedConnectionMetadata: (source: string) => {
    readonly origin: string;
    readonly serverId: string;
    readonly endpointPublicKey?: string;
  };
  readonly managedOrchestratorIdentityMatches: (connection: {
    readonly serverId: string;
    readonly endpointPublicKey?: string;
  }, server: unknown) => boolean;
  readonly parseManagedRuntimeProcessMarker: (source: string, currentProcessId?: number) => {
    readonly version: 1;
    readonly pid: number;
    readonly processIdentity: string;
    readonly serverId: string;
  };
  readonly primaryChildExitError: (options: {
    readonly outcome: { readonly code: number | null; readonly signal: string | null };
    readonly marker: string;
    readonly progress: readonly string[];
    readonly requiredProgress: readonly string[];
  }) => Error | undefined;
  readonly runIdentityFencedProcessEffect: (options: {
    readonly pid: number;
    readonly expectedIdentity: string;
    readonly captureIdentity: (pid: number) => string | undefined;
    readonly effect: (pid: number) => Promise<void> | void;
  }) => Promise<"notRunning" | "identityMismatch" | "effectApplied">;
  readonly hasStalledPackagedSmokeResourceRetirement: (progress: string, now: number) => boolean;
  readonly hasStalledPackagedSmokeInspectorCrash: (progress: string, now: number) => boolean;
  readonly runOwnedChildDiagnosticEffect: (options: {
    readonly child: { readonly pid?: number; readonly exitCode: number | null; readonly signalCode: string | null };
    readonly pid: number;
    readonly parentPid: number;
    readonly expectedIdentity: string;
    readonly isCurrent: () => boolean;
    readonly captureIdentity: (pid: number) => Promise<{
      readonly parentPid: number; readonly processIdentity: string;
    } | undefined>;
    readonly effect: (pid: number) => void;
  }) => Promise<"notRunning" | "identityMismatch" | "effectApplied" | "unavailable">;
  readonly parseMacNativeSampleStacks: (source: string) => {
    readonly truncated: boolean;
    readonly threads: readonly {
      readonly index: number; readonly main: boolean;
      readonly frames: readonly { readonly indent: number; readonly samples: number; readonly symbol: string; readonly image: string }[];
    }[];
  };
  readonly createMacNativeSampleCapture: (path: string, owner: {
    readonly pid: number; readonly parentPid: number; readonly processIdentity: string; readonly trigger: string;
  }, invocation?: {
    readonly arguments: readonly string[]; readonly symbolicationMode: "disabled" | "default"; readonly toolHelp: string;
    readonly tool?: string;
  }) => {
    readonly stdout: (chunk: string | Buffer) => void;
    readonly stderr: (chunk: string | Buffer) => void;
    readonly finish: (reason?: string, cleanup?: Readonly<Record<string, unknown>>) => void;
  };
  readonly matchesBuilderFileSet: (path: string, filters: readonly string[]) => boolean;
  readonly observePrimaryChild: (
    child: EventEmitter,
    onExit: (outcome: { readonly code: number | null; readonly signal: string | null }) => void,
    drainTimeoutMs?: number
  ) => Promise<{ readonly code: number | null; readonly signal: string | null }>;
}

const helpers = await import(
  new URL("../scripts/smoke-packaged-helpers.mjs", import.meta.url).href
) as SmokePackagedHelpers;
const temporaryRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("packaged Desktop smoke helpers", () => {
  it("emits final success only after temporary cleanup succeeds", async () => {
    const order: string[] = [];
    const result = await helpers.finalizeSmokeRun({
      runJourney: async () => {
        order.push("journey");
        return { event: "ok" };
      },
      preserveEvidence: ({ passed, payload }) => {
        expect(passed).toBe(true); expect(payload).toEqual({ event: "ok" }); order.push("evidence");
      },
      cleanupTemporaryDirectory: () => { order.push("cleanup"); },
      retainFailure: false,
      reportRetained: vi.fn(),
      emitSuccess: () => { order.push("success"); }
    });

    expect(result).toEqual({ event: "ok" });
    expect(order).toEqual(["journey", "evidence", "cleanup", "success"]);

    const emitSuccess = vi.fn();
    await expect(helpers.finalizeSmokeRun({
      runJourney: async () => ({ event: "must-not-emit" }),
      cleanupTemporaryDirectory: () => { throw new Error("cleanup failed"); },
      retainFailure: false,
      reportRetained: vi.fn(),
      emitSuccess
    })).rejects.toThrow("cleanup failed");
    expect(emitSuccess).not.toHaveBeenCalled();
  });

  it("accepts only one canonical smoke directory segment below the canonical temp root", () => {
    const root = temporaryRoot("joko-smoke-helper-root-");
    const smokeDirectory = join(root, "joko-desktop-smoke-fixture");
    mkdirSync(smokeDirectory);
    expect(helpers.canonicalSmokeDirectoryForRemoval(smokeDirectory, root)).toBe(realpathSync(smokeDirectory));

    const nested = join(smokeDirectory, "joko-desktop-smoke-nested");
    mkdirSync(nested);
    expect(() => helpers.canonicalSmokeDirectoryForRemoval(nested, root)).toThrow("unsafe Desktop smoke directory");

    const target = join(root, "joko-desktop-smoke-target");
    const linked = join(root, "joko-desktop-smoke-linked");
    mkdirSync(target);
    symlinkSync(target, linked, process.platform === "win32" ? "junction" : "dir");
    expect(() => helpers.canonicalSmokeDirectoryForRemoval(linked, root)).toThrow("unsafe Desktop smoke directory");
  });

  it("byte-compares filtered source mirrors and rejects builder-ignored files in the artifact", () => {
    const root = temporaryRoot("joko-resource-mirror-");
    const applicationRoot = join(root, "application");
    const source = join(applicationRoot, "source");
    const artifactResourcesRoot = join(root, "artifact-resources");
    const artifact = join(artifactResourcesRoot, "mirror");
    mkdirSync(source, { recursive: true });
    mkdirSync(artifact, { recursive: true });
    writeFileSync(join(source, "same.bin"), Buffer.alloc(200_000, 7));
    writeFileSync(join(artifact, "same.bin"), Buffer.alloc(200_000, 7));
    writeFileSync(join(source, "changed.bin"), Buffer.from("source"));
    writeFileSync(join(artifact, "changed.bin"), Buffer.from("artifact"));
    writeFileSync(join(source, "missing.bin"), Buffer.from("missing"));
    writeFileSync(join(artifact, "unexpected.bin"), Buffer.from("unexpected"));
    writeFileSync(join(source, "ignored.map"), Buffer.from("source map"));
    writeFileSync(join(artifact, "ignored.map"), Buffer.from("artifact map"));
    writeFileSync(join(source, ".gitkeep"), Buffer.from("source keep"));
    writeFileSync(join(artifact, ".gitkeep"), Buffer.from("artifact keep"));
    writeFileSync(join(source, ".DS_Store"), Buffer.from("source metadata"));
    writeFileSync(join(artifact, ".DS_Store"), Buffer.from("artifact metadata"));

    const report = helpers.compareConfiguredExtraResourceMirrors({
      applicationRoot,
      artifactResourcesRoot,
      extraResources: [{ from: "source", to: "mirror", filter: ["**/*", "!**/*.map"] }]
    });

    expect(report).toEqual({
      missing: ["mirror/missing.bin"],
      unexpected: [
        "mirror/.DS_Store",
        "mirror/.gitkeep",
        "mirror/ignored.map",
        "mirror/unexpected.bin"
      ],
      changed: ["mirror/changed.bin"]
    });
    expect(helpers.filesHaveEqualContents(join(source, "same.bin"), join(artifact, "same.bin"))).toBe(true);
  });

  it("unions overlapping mappings while reporting every forbidden artifact file", () => {
    const root = temporaryRoot("joko-overlap-mirror-");
    const applicationRoot = join(root, "application");
    const runtime = join(applicationRoot, "runtime");
    const modules = join(runtime, "node_modules");
    const artifactResourcesRoot = join(root, "artifact-resources");
    const artifactRuntime = join(artifactResourcesRoot, "runtime");
    mkdirSync(modules, { recursive: true });
    mkdirSync(join(artifactRuntime, "node_modules"), { recursive: true });
    writeFileSync(join(runtime, "main.js"), "current");
    writeFileSync(join(modules, "dependency.js"), "dependency");
    writeFileSync(join(artifactRuntime, "main.js"), "current");
    writeFileSync(join(artifactRuntime, "node_modules", "dependency.js"), "dependency");
    writeFileSync(join(artifactRuntime, "node_modules", "stale.ts"), "stale");
    writeFileSync(join(artifactRuntime, ".env"), "stale");

    expect(helpers.compareConfiguredExtraResourceMirrors({
      applicationRoot,
      artifactResourcesRoot,
      extraResources: [
        { from: "runtime", to: "runtime", filter: ["**/*", "!node_modules/**", "!**/*.ts", "!**/.env"] },
        { from: "runtime/node_modules", to: "runtime/node_modules", filter: ["**/*", "!**/*.ts"] }
      ]
    })).toEqual({
      missing: [],
      unexpected: ["runtime/.env", "runtime/node_modules/stale.ts"],
      changed: []
    });
  });

  it("scans the unpacked application dist without source-side builder filters", () => {
    const root = temporaryRoot("joko-application-mirror-");
    const source = join(root, "source");
    const artifact = join(root, "artifact");
    mkdirSync(join(source, "web"), { recursive: true });
    mkdirSync(join(artifact, "web"), { recursive: true });
    writeFileSync(join(source, "main.js"), "current");
    writeFileSync(join(source, "main.ts"), "source only");
    writeFileSync(join(source, "web", "index.js"), "web");
    writeFileSync(join(source, "web", "index.js.map"), "source map");
    writeFileSync(join(artifact, "main.js"), "current");
    writeFileSync(join(artifact, "main.ts"), "stale");
    writeFileSync(join(artifact, "web", "index.js"), "web");
    writeFileSync(join(artifact, "web", "index.js.map"), "stale map");

    expect(helpers.comparePackagedApplicationMirror(source, artifact)).toEqual({
      missing: [],
      unexpected: ["main.ts", "web/index.js.map"],
      changed: []
    });
  });

  it("matches the configured workspace and extension exclusions", () => {
    const filters = [
      "**/*",
      "!**/*.{map,ts}",
      "!**/{test,tests,workspace}/**",
      "!**/WORKSPACE",
      "!**/WORKSPACE/**"
    ];
    expect(helpers.matchesBuilderFileSet("dist/main.js", filters)).toBe(true);
    expect(helpers.matchesBuilderFileSet("dist/main.js.map", filters)).toBe(false);
    expect(helpers.matchesBuilderFileSet("package/workspace/file.js", filters)).toBe(false);
    expect(helpers.matchesBuilderFileSet("package/WORKSPACE/file.js", filters)).toBe(false);
    expect(helpers.matchesBuilderFileSet("package/Workspace/file.js", filters)).toBe(true);
  });

  it("accepts v1 managed loopback metadata with or without its complete endpoint pin", () => {
    const metadata = { profileId: "managed-profile", deviceId: "abcde123-1234-4123-8123-123456789abc",
      serverId: "managed-node", name: "Managed Joko", origin: "http://127.0.0.1:4318" };
    const endpointPublicKey = `ed25519:${"a".repeat(64)}`;
    expect(helpers.parseManagedConnectionMetadata(JSON.stringify(metadata))).toEqual({ origin: metadata.origin, serverId: metadata.serverId });
    expect(helpers.parseManagedConnectionMetadata(JSON.stringify({ ...metadata, endpointPublicKey })))
      .toEqual({ origin: metadata.origin, serverId: metadata.serverId, endpointPublicKey });
    for (const invalidPin of ["", "ed25519:truncated", `ed25519:${"A".repeat(64)}`, null, 42]) {
      expect(() => helpers.parseManagedConnectionMetadata(JSON.stringify({ ...metadata, endpointPublicKey: invalidPin }))).toThrow("malformed");
    }
    expect(() => helpers.parseManagedConnectionMetadata(JSON.stringify({ ...metadata, endpointPublicKey, authKey: "must-not-enter-metadata" }))).toThrow("malformed");
    for (const origin of ["http://192.168.1.2:4318", "https://127.0.0.1:4318", "http://user@127.0.0.1:4318", "http://127.0.0.1:4318/path", "http://127.0.0.1:4318?query"]) {
      expect(() => helpers.parseManagedConnectionMetadata(JSON.stringify({ ...metadata, origin }))).toThrow("exact loopback HTTP authority");
    }
  });

  it("checks both the original node and a recorded endpoint pin before accepting cleanup identity", () => {
    const endpointPublicKey = `ed25519:${"a".repeat(64)}`, otherKey = `ed25519:${"b".repeat(64)}`;
    const legacy = { serverId: "managed-node" }, pinned = { ...legacy, endpointPublicKey };
    expect(helpers.managedOrchestratorIdentityMatches(legacy, legacy)).toBe(true);
    expect(helpers.managedOrchestratorIdentityMatches(pinned, { ...pinned })).toBe(true);
    expect(helpers.managedOrchestratorIdentityMatches(pinned, legacy)).toBe(false);
    expect(helpers.managedOrchestratorIdentityMatches(pinned, { ...pinned, endpointPublicKey: otherKey })).toBe(false);
    expect(helpers.managedOrchestratorIdentityMatches(pinned, { ...pinned, serverId: "another-node" })).toBe(false);
    expect(helpers.managedOrchestratorIdentityMatches(pinned, undefined)).toBe(false);
  });

  it("parses only the credential-free v1 managed-runtime birth marker", () => {
    const processIdentity = "a".repeat(64);
    expect(helpers.parseManagedRuntimeProcessMarker(JSON.stringify({
      version: 1,
      pid: 4242,
      processIdentity,
      serverId: "managed-runtime"
    }), 7)).toEqual({ version: 1, pid: 4242, processIdentity, serverId: "managed-runtime" });

    expect(() => helpers.parseManagedRuntimeProcessMarker(JSON.stringify({
      version: 1,
      pid: 4242,
      processIdentity,
      serverId: "managed-runtime",
      credential: "must-not-enter-marker"
    }), 7)).toThrow("malformed");
    expect(() => helpers.parseManagedRuntimeProcessMarker(JSON.stringify({
      version: 1,
      pid: 7,
      processIdentity,
      serverId: "managed-runtime"
    }), 7)).toThrow("malformed");
  });

  it("uses an exact birth match for cleanup even when the endpoint hangs", () => {
    expect(helpers.managedRuntimeCleanupDecision("matchedLive", "matched")).toBe("terminate");
    expect(helpers.managedRuntimeCleanupDecision("stopped", "matched")).toBe("terminate");
    expect(helpers.managedRuntimeCleanupDecision("unreachable", "matched")).toBe("terminate");
    expect(helpers.managedRuntimeCleanupDecision("stopped", "absent")).toBe("complete");
    expect(helpers.managedRuntimeCleanupDecision("unreachable", "absent")).toBe("complete");
    expect(helpers.managedRuntimeCleanupDecision("matchedLive", "absent")).toBe("identityFailure");
    expect(helpers.managedRuntimeCleanupDecision("mismatchedLive", "mismatched")).toBe("identityFailure");
    expect(helpers.managedRuntimeCleanupDecision("unreachable", "unavailable")).toBe("identityFailure");
  });

  it("fails a primary exit immediately unless its exact journey evidence is complete", () => {
    const requiredProgress = ["cold-ingress", "second-instance-ack"];
    expect(helpers.primaryChildExitError({
      outcome: { code: 0, signal: null },
      marker: "JOKO_DESKTOP_SMOKE_OK",
      progress: requiredProgress,
      requiredProgress
    })).toBeUndefined();

    expect(helpers.primaryChildExitError({
      outcome: { code: 1, signal: null },
      marker: "",
      progress: [],
      requiredProgress
    })?.message).toContain("code=1");
    expect(helpers.primaryChildExitError({
      outcome: { code: null, signal: "SIGTERM" },
      marker: "JOKO_DESKTOP_SMOKE_OK",
      progress: requiredProgress,
      requiredProgress
    })?.message).toContain("signal=SIGTERM");
    expect(helpers.primaryChildExitError({
      outcome: { code: 0, signal: null },
      marker: "JOKO_DESKTOP_SMOKE_OK",
      progress: ["cold-ingress"],
      requiredProgress
    })?.message).toContain("journey evidence");

    const abortController = new AbortController();
    const fenced = helpers.applyPrimaryChildExitFence({
      outcome: { code: 1, signal: null },
      marker: "",
      progress: [],
      requiredProgress,
      abortController
    });
    expect(fenced.ownsAbort).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(abortController.signal.reason).toBe(fenced.failure);

    const secondInstanceAbort = new AbortController();
    const secondInstanceFailure = new Error("second-instance failed first");
    secondInstanceAbort.abort(secondInstanceFailure);
    expect(helpers.applyPrimaryChildExitFence({
      outcome: { code: 1, signal: null },
      marker: "",
      progress: [],
      requiredProgress,
      abortController: secondInstanceAbort
    })).toMatchObject({ ownsAbort: false });
    expect(secondInstanceAbort.signal.reason).toBe(secondInstanceFailure);
  });

  it("claims a primary exit before waiting for close or the bounded pipe drain", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const stdout = { destroy: vi.fn() };
    const stderr = { destroy: vi.fn() };
    const child = Object.assign(new EventEmitter(), { stdout, stderr });
    const order: string[] = [];
    let settled = false;
    const observed = helpers.observePrimaryChild(child, () => {
      order.push("abort");
      const decision = helpers.claimSmokeJourneyFailure({
        abortController,
        failure: new Error("primary exited first"),
        source: "primary"
      });
      expect(decision).toMatchObject({
        ownsAbort: true,
        terminatePrimary: false,
        timedOut: false
      });
    }, 5_000).then((outcome) => {
      settled = true;
      order.push("drained");
      return outcome;
    });

    child.emit("exit", 1, null);
    await Promise.resolve();
    expect(abortController.signal.reason).toMatchObject({ message: "primary exited first" });
    expect(order).toEqual(["abort"]);
    expect(settled).toBe(false);
    expect(stdout.destroy).not.toHaveBeenCalled();
    expect(stderr.destroy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(observed).resolves.toEqual({ code: 1, signal: null });
    expect(order).toEqual(["abort", "drained"]);
    expect(stdout.destroy).not.toHaveBeenCalled();
    expect(stderr.destroy).not.toHaveBeenCalled();
  });

  it("keeps a second-instance first failure authoritative when timeout arrives later", () => {
    const abortController = new AbortController();
    const secondInstanceFailure = new Error("second instance failed first");
    const secondInstance = helpers.claimSmokeJourneyFailure({
      abortController,
      failure: secondInstanceFailure,
      source: "second-instance"
    });
    const timeout = helpers.claimSmokeJourneyFailure({
      abortController,
      failure: new Error("late timeout"),
      source: "timeout"
    });

    expect(secondInstance).toEqual({
      failure: secondInstanceFailure,
      ownsAbort: true,
      terminatePrimary: true,
      timedOut: false
    });
    expect(timeout).toEqual({
      failure: secondInstanceFailure,
      ownsAbort: false,
      terminatePrimary: false,
      timedOut: false
    });
    expect(abortController.signal.reason).toBe(secondInstanceFailure);
  });

  it("lets a timeout own the abort and immediate-primary-termination decision", () => {
    const abortController = new AbortController();
    const timeoutFailure = new Error("timeout owns");
    expect(helpers.claimSmokeJourneyFailure({
      abortController,
      failure: timeoutFailure,
      source: "timeout"
    })).toEqual({
      failure: timeoutFailure,
      ownsAbort: true,
      terminatePrimary: true,
      timedOut: true
    });
    expect(abortController.signal.reason).toBe(timeoutFailure);
  });

  it("allows only the first failure claim to own the abort reason", () => {
    const abortController = new AbortController();
    const first = new Error("first failure");
    const later = new Error("later failure");
    const firstClaim = helpers.claimSmokeJourneyFailure({
      abortController,
      failure: first,
      source: "orchestration"
    });
    const laterClaim = helpers.claimSmokeJourneyFailure({
      abortController,
      failure: later,
      source: "second-instance"
    });

    expect(firstClaim).toMatchObject({ failure: first, ownsAbort: true });
    expect(laterClaim).toEqual({
      failure: first,
      ownsAbort: false,
      terminatePrimary: false,
      timedOut: false
    });
    expect(helpers.authoritativeSmokeJourneyError(abortController.signal, later)).toBe(first);
    expect(abortController.signal.reason).toBe(first);
  });

  it("revalidates birth identity immediately before the injected process effect", async () => {
    const effect = vi.fn();
    await expect(helpers.runIdentityFencedProcessEffect({
      pid: 4242,
      expectedIdentity: "owned-birth",
      captureIdentity: vi.fn()
        .mockReturnValueOnce("owned-birth")
        .mockReturnValueOnce("reused-birth"),
      effect
    })).resolves.toBe("identityMismatch");
    expect(effect).not.toHaveBeenCalled();

    await expect(helpers.runIdentityFencedProcessEffect({
      pid: 4242,
      expectedIdentity: "owned-birth",
      captureIdentity: () => "owned-birth",
      effect
    })).resolves.toBe("effectApplied");
    expect(effect).toHaveBeenCalledOnce();
    expect(effect).toHaveBeenCalledWith(4242);

    effect.mockClear();
    await expect(helpers.runIdentityFencedProcessEffect({
      pid: 4242,
      expectedIdentity: "owned-birth",
      captureIdentity: () => undefined,
      effect
    })).resolves.toBe("notRunning");
    expect(effect).not.toHaveBeenCalled();
  });

  it("samples only the final owner's resource wait after six seconds and before resource completion", () => {
    const finalOwner = "peer_agent_retirement_started_at:10000\npeer_agent_executor_resources_started:10001\n";
    expect(helpers.hasStalledPackagedSmokeResourceRetirement(finalOwner, 16_000)).toBe(false);
    expect(helpers.hasStalledPackagedSmokeResourceRetirement(finalOwner, 16_001)).toBe(true);
    expect(helpers.hasStalledPackagedSmokeResourceRetirement(
      `${finalOwner}peer_agent_executor_resources_completed:10050\n`, 20_000
    )).toBe(false);
    expect(helpers.hasStalledPackagedSmokeResourceRetirement(
      "peer_agent_executor_resources_started:100\npeer_agent_retirement_started_at:10000\n", 20_000
    )).toBe(false);
    expect(helpers.hasStalledPackagedSmokeResourceRetirement(
      `${finalOwner}peer_agent_retirement_started_at:20000\n`, 30_000
    )).toBe(false);
    expect(helpers.hasStalledPackagedSmokeResourceRetirement(finalOwner, 9_000)).toBe(false);
  });

  it("samples only an unresolved exact Inspector force-crash request and clears it on loss, finish or timeout", () => {
    const requested = "inspector_owner_crash_native_request_returned_at:10000\n";
    expect(helpers.hasStalledPackagedSmokeInspectorCrash(requested, 15_999)).toBe(false);
    expect(helpers.hasStalledPackagedSmokeInspectorCrash(requested, 16_000)).toBe(true);
    for (const cleared of ["native_cleanup_main_render_process_gone_entered:10050", "inspector_owner_renderer_gone",
      "inspector_owner_crash_wait_timed_out", "finish_started"]) {
      expect(helpers.hasStalledPackagedSmokeInspectorCrash(`${requested}${cleared}\n`, 20_000)).toBe(false);
      expect(helpers.hasStalledPackagedSmokeInspectorCrash(`${cleared}\n${requested}`, 20_000)).toBe(true);
    }
    expect(helpers.hasStalledPackagedSmokeInspectorCrash(
      "inspector_owner_crash_native_request_returned\n", 20_000
    )).toBe(false);
  });

  it.each([
    { parentPid: 42, processIdentity: "reused-birth" },
    { parentPid: 99, processIdentity: "owned-birth" }
  ])("rejects a reused or reparented sample target after the first identity check: %j", async observed => {
    const effect = vi.fn();
    const captureIdentity = vi.fn()
      .mockResolvedValueOnce({ parentPid: 42, processIdentity: "owned-birth" })
      .mockResolvedValueOnce(observed);
    await expect(helpers.runOwnedChildDiagnosticEffect({
      child: { pid: 4242, exitCode: null, signalCode: null }, pid: 4242, parentPid: 42,
      expectedIdentity: "owned-birth", isCurrent: () => true, captureIdentity, effect
    })).resolves.toBe("identityMismatch");
    expect(captureIdentity).toHaveBeenCalledTimes(2);
    expect(effect).not.toHaveBeenCalled();
  });

  it("does not sample a primary that exited during the asynchronous OS identity probe", async () => {
    const child: { pid: number; exitCode: number | null; signalCode: string | null } = {
      pid: 4242, exitCode: null, signalCode: null
    };
    const effect = vi.fn();
    await expect(helpers.runOwnedChildDiagnosticEffect({
      child, pid: 4242, parentPid: 42, expectedIdentity: "owned-birth", isCurrent: () => true,
      captureIdentity: async () => {
        child.exitCode = 0;
        return { parentPid: 42, processIdentity: "owned-birth" };
      }, effect
    })).resolves.toBe("notRunning");
    expect(effect).not.toHaveBeenCalled();
    child.exitCode = null;
    const captureIdentity = vi.fn(async () => ({ parentPid: 42, processIdentity: "owned-birth" }));
    await expect(helpers.runOwnedChildDiagnosticEffect({
      child, pid: 4242, parentPid: 42, expectedIdentity: "owned-birth", isCurrent: () => true,
      captureIdentity, effect
    })).resolves.toBe("effectApplied");
    expect(captureIdentity).toHaveBeenCalledTimes(2);
    expect(effect).toHaveBeenCalledExactlyOnceWith(4242);
  });

  it("retains native thread symbols while dropping report identity, paths, names and non-stack content", () => {
    const stacks = helpers.parseMacNativeSampleStacks([
      "Process: private-process [4242]", "Path: /Users/private/secret/app", "Arguments: bearer credential",
      "Environment: PRIVATE_TOKEN=credential", "Call graph:",
      "    99 Thread_123: private-thread-name DispatchQueue_1: com.apple.main-thread (serial)",
      "    + 99 CFRunLoopRunSpecific  (in CoreFoundation) + 572 [0x7abc123] (/Users/private/secret/source.mm:9)",
      "    +   99 electron::api::BrowserWindow::Close()  (in Electron Framework) + 16 [0x7abc456]",
      "    +     99 evaluate('credential')  (in Electron Framework) + 1 [0x7abc456]",
      "    10 Thread_456: PRIVATE_TOKEN=credential", "    + 10 0x7abc789  (in libsystem_kernel.dylib)",
      "Binary Images:", "    + 99 ignored_symbol  (in private-library) + 1 [0x7abc123]", "Heap: credential"
    ].join("\n"));
    expect(stacks).toMatchObject({ truncated: false, threads: [
      { index: 1, main: true, frames: [
        { samples: 99, symbol: "CFRunLoopRunSpecific", image: "CoreFoundation" },
        { samples: 99, symbol: "electron::api::BrowserWindow::Close()", image: "Electron Framework" }
      ] },
      { index: 2, main: false, frames: [{ samples: 10, symbol: "<address>", image: "libsystem_kernel.dylib" }] }
    ] });
    const retained = JSON.stringify(stacks);
    for (const excluded of ["credential", "private", "/Users/", "0x7abc", "Thread_", "ignored_symbol", "Heap"]) {
      expect(retained).not.toContain(excluded);
    }
    expect(helpers.parseMacNativeSampleStacks("x".repeat(1024 * 1024 + 1))).toEqual({ threads: [], truncated: true });
  });

  it("preserves partial sample stdout and stderr on timeout in the hashed GUI evidence", async () => {
    const source = temporaryRoot("joko-desktop-smoke-"), destination = temporaryRoot("joko-sample-evidence-");
    const name = "result.txt.native-retirement-sample.json", path = join(source, name);
    const capture = helpers.createMacNativeSampleCapture(path, {
      pid: 4242, parentPid: 42, processIdentity: "controlled-birth", trigger: "resource_retirement"
    }, {
      tool: "/usr/sbin/spindump",
      arguments: ["4242", "1", "10", "-onlyTarget", "-noSymbolicate", "-noBinary", "-stdout", "-o", "/dev/null"],
      symbolicationMode: "disabled", toolHelp: "usage: spindump pid duration interval [-onlyTarget] [-noSymbolicate] [-noBinary] [-stdout] [-o path]"
    });
    const stdout = `Call graph:\n${"    + 1 controlled_frame (in Electron Framework)\n".repeat(700)}MainThreadDeepMarker\n`;
    capture.stdout(Buffer.from(stdout)); capture.stderr("sample: controlled partial diagnostic\n");
    capture.finish("tool_timeout", { wrapperExited: true, wrapperExitCode: 124, wrapperSignal: null, samplerExitConfirmed: true });
    // A delayed process-exit callback cannot overwrite the timeout snapshot.
    capture.stdout("late output"); capture.stderr("late error"); capture.finish();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ tool: "/usr/sbin/spindump", reason: "tool_timeout", stdout,
      stderr: "sample: controlled partial diagnostic\n", stdoutTruncated: false, stderrTruncated: false,
      cleanup: { wrapperExited: true, wrapperExitCode: 124, wrapperSignal: null, samplerExitConfirmed: true },
      arguments: ["4242", "1", "10", "-onlyTarget", "-noSymbolicate", "-noBinary", "-stdout", "-o", "/dev/null"],
      symbolicationMode: "disabled", toolHelp: expect.stringContaining("[-noSymbolicate]"), toolHelpTruncated: false });
    const evidence = await import(new URL("../scripts/smoke-packaged-evidence.mjs", import.meta.url).href) as {
      preservePackagedSmokeEvidence: (options: {
        readonly directory: string; readonly temporaryRoot: string; readonly destination: string;
        readonly applicationRoot: string; readonly executable: string; readonly packaged: boolean;
        readonly scope: string; readonly passed: boolean;
      }) => Promise<void>;
    };
    await evidence.preservePackagedSmokeEvidence({ directory: source, temporaryRoot: realpathSync(tmpdir()), destination,
      applicationRoot: process.cwd(), executable: process.execPath, packaged: false, scope: "inspector", passed: false });
    const output = join(destination, basename(source));
    expect(readFileSync(join(output, name), "utf8")).toBe(readFileSync(path, "utf8"));
    expect(JSON.parse(readFileSync(join(output, "result.json"), "utf8")).files).toEqual([
      expect.objectContaining({ name, bytes: Buffer.byteLength(readFileSync(path)), sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    ]);
  });

  it("bounds the one sample artifact's two output streams independently", () => {
    const path = join(temporaryRoot("joko-desktop-smoke-"), "result.txt.native-retirement-sample.json");
    const capture = helpers.createMacNativeSampleCapture(path, {
      pid: 4242, parentPid: 42, processIdentity: "controlled-birth", trigger: "resource_retirement"
    }, {
      arguments: ["4242", "1", "10", "-mayDie", "-file", "/dev/stdout"],
      symbolicationMode: "default", toolHelp: "h".repeat(64 * 1024 + 20)
    });
    capture.stdout(Buffer.alloc(1024 * 1024 + 20, 120)); capture.stderr(Buffer.alloc(16 * 1024 + 20, 121)); capture.finish();
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    expect(receipt).toMatchObject({ stdoutBytes: 1024 * 1024, stderrBytes: 16 * 1024,
      stdoutTruncated: true, stderrTruncated: true, toolHelpBytes: 64 * 1024, toolHelpTruncated: true });
    expect(Buffer.byteLength(receipt.stdout)).toBe(1024 * 1024); expect(Buffer.byteLength(receipt.stderr)).toBe(16 * 1024);
    expect(Buffer.byteLength(receipt.toolHelp)).toBe(64 * 1024);
  });

  it("requires installed target-only, symbol-less text flags before planning a privileged stack", async () => {
    const { selectMacNativeStackArguments } = await import(
      new URL("../scripts/mac-native-stack.mjs", import.meta.url).href
    ) as { selectMacNativeStackArguments: (help: string, pid: number) => readonly string[] | undefined };
    const help = "-onlyTarget Only sample the target process\n-noSymbolicate Do not symbolicate the report\n-noBinary Omit binary format\n-stdout Print report\n-o path";
    expect(selectMacNativeStackArguments(help, 4242)).toEqual([
      "4242", "1", "10", "-onlyTarget", "-noSymbolicate", "-noBinary", "-stdout", "-o", "/dev/null"
    ]);
    for (const flag of ["-onlyTarget", "-noSymbolicate", "-noBinary", "-stdout", "-o"]) {
      expect(selectMacNativeStackArguments(help.replace(flag, "unsupported"), 4242)).toBeUndefined();
    }
    expect(selectMacNativeStackArguments(help.replace("Only sample the target process", "All system processes"), 4242)).toBeUndefined();
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(selectMacNativeStackArguments(help, pid)).toBeUndefined();
  });

  it("keeps exit-zero output unavailable when the owned sampler retirement receipt is missing", async () => {
    const { runMacNativeStack } = await import(new URL("../scripts/mac-native-stack.mjs", import.meta.url).href) as {
      runMacNativeStack: (options: Record<string, unknown>) => { done: Promise<{ reason?: string; samplerExitConfirmed: boolean }> };
    };
    const path = join(temporaryRoot("joko-desktop-smoke-"), "result.txt.native-retirement-sample.json");
    const capture = helpers.createMacNativeSampleCapture(path, {
      pid: 4242, parentPid: process.pid, processIdentity: "controlled-birth", trigger: "resource_retirement"
    });
    // Actual owned child and pipe drain; it deliberately lacks the supervisor's
    // kill/wait receipt, so ordinary exit success cannot claim sampler cleanup.
    const result = await runMacNativeStack({ arguments: [], capture, launcher: process.execPath,
      launcherArguments: ["-e", "process.stdout.write('controlled stack output')"] }).done;
    expect(result).toMatchObject({ reason: "sampler_cleanup_unconfirmed", samplerExitConfirmed: false });
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ status: "unavailable", reason: "sampler_cleanup_unconfirmed",
      stdout: "controlled stack output", cleanup: { wrapperExited: true, wrapperExitCode: 0, samplerExitConfirmed: false } });
  });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function inspectorSurfaceRetirementFixture() {
  const window = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false) });
  const contents = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false) });
  return { window, contents };
}

describe("packaged Inspector surface retirement", () => {
  it("waits for the captured guest context after native close and ignores replacement events", async () => {
    const original = inspectorSurfaceRetirementFixture();
    const replacement = inspectorSurfaceRetirementFixture();
    const observed: string[] = [];
    const retirement = observePackagedSmokeWindowRetirement({
      ...original, observe: stage => { observed.push(stage); }
    });
    let completed = false;
    const completion = retirement.wait(Date.now() + 10_000);
    void completion.then(() => { completed = true; });
    original.window.emit("closed");
    original.window.isDestroyed.mockImplementation(() => { throw new Error("Do not inspect a closed native window."); });
    replacement.contents.emit("destroyed");
    replacement.window.emit("closed");
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(observed).toEqual(["native_closed"]);
    original.contents.emit("destroyed");
    await completion;
    expect(completed).toBe(true);
    expect(observed).toEqual(["native_closed", "contents_destroyed"]);
    expect(original.window.listenerCount("closed")).toBe(0);
    expect(original.contents.listenerCount("destroyed")).toBe(0);
  });

  it("uses the existing absolute reopen deadline without resetting its remaining budget", async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 10_000;
    const original = inspectorSurfaceRetirementFixture();
    const retirement = observePackagedSmokeWindowRetirement(original);
    original.window.emit("closed");
    await vi.advanceTimersByTimeAsync(7_000);
    const failure = expect(retirement.wait(deadline)).rejects.toThrow("original window surface did not retire");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(original.contents.listenerCount("destroyed")).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(original.window.listenerCount("closed")).toBe(0);
    expect(original.contents.listenerCount("destroyed")).toBe(0);
  });

  it("rejects a late captured destruction even before a delayed timer callback runs", async () => {
    vi.useFakeTimers();
    const original = inspectorSurfaceRetirementFixture();
    const deadline = Date.now() + 10_000;
    const retirement = observePackagedSmokeWindowRetirement(original);
    const failure = expect(retirement.wait(deadline)).rejects.toThrow("original window surface did not retire");
    original.window.emit("closed");
    vi.setSystemTime(deadline + 1);
    original.contents.emit("destroyed");
    await failure;
  });

  it("accepts already-retired exact handles and cancels when an earlier assertion fails", async () => {
    const retired = inspectorSurfaceRetirementFixture();
    retired.window.isDestroyed.mockReturnValue(true);
    retired.contents.isDestroyed.mockReturnValue(true);
    await expect(observePackagedSmokeWindowRetirement(retired).wait(Date.now() + 10_000)).resolves.toBeUndefined();
    const original = inspectorSurfaceRetirementFixture();
    const retirement = observePackagedSmokeWindowRetirement(original);
    const completion = retirement.wait(Date.now() + 10_000);
    retirement.cancel();
    await expect(completion).rejects.toThrow("observation was cancelled");
    expect(original.window.listenerCount("closed")).toBe(0);
    expect(original.contents.listenerCount("destroyed")).toBe(0);
  });
});
