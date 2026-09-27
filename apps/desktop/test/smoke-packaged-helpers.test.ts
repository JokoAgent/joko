/// <reference types="node" />

import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    readonly cleanupTemporaryDirectory: () => Promise<void> | void;
    readonly retainFailure: boolean;
    readonly reportRetained: () => void;
    readonly emitSuccess: (payload: unknown) => Promise<void> | void;
  }) => Promise<unknown>;
  readonly managedRuntimeCleanupDecision: (
    endpoint: "matchedLive" | "mismatchedLive" | "stopped" | "unreachable",
    processIdentity: "matched" | "mismatched" | "absent" | "unavailable"
  ) => "terminate" | "identityFailure" | "complete";
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
      cleanupTemporaryDirectory: () => { order.push("cleanup"); },
      retainFailure: false,
      reportRetained: vi.fn(),
      emitSuccess: () => { order.push("success"); }
    });

    expect(result).toEqual({ event: "ok" });
    expect(order).toEqual(["journey", "cleanup", "success"]);

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
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
