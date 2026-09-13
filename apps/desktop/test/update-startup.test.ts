import { describe, expect, it, vi } from "vitest";

import type { DesktopUpdateCheckResult, DesktopUpdateStatus } from "../src/channels.js";
import {
  runDesktopUpdateStartupCheck,
  type DesktopUpdateStartupService
} from "../src/update-startup.js";

describe("desktop cold-start update selection", () => {
  it("releases development builds without touching the updater", async () => {
    const service = fakeStartupService({ status: "idle", availability: "available" });
    await expect(runDesktopUpdateStartupCheck({
      service,
      isPackaged: false,
      currentVersion: "1.0.0",
      fetchManifestVersion: vi.fn(async () => "2.0.0")
    })).resolves.toEqual({ kind: "release" });
    expect(service.initialize).not.toHaveBeenCalled();
    expect(service.checkForExpectedVersion).not.toHaveBeenCalled();
  });

  it("uses a locally verified newer installer when the bounded manifest is offline", async () => {
    const service = fakeStartupService({ status: "ready", version: "2.0.0" });
    await expect(run(service, null)).resolves.toEqual({ kind: "ready", version: "2.0.0" });
    expect(service.checkForExpectedVersion).not.toHaveBeenCalled();
    expect(service.quarantineReady).not.toHaveBeenCalled();
  });

  it("applies an online local installer only when it exactly matches latest", async () => {
    const service = fakeStartupService({ status: "ready", version: "2.0.0" });
    await expect(run(service, "2.0.0")).resolves.toEqual({ kind: "ready", version: "2.0.0" });
    expect(service.checkForExpectedVersion).not.toHaveBeenCalled();
  });

  it("quarantines stale local ready and acquires the exact newer latest", async () => {
    const service = fakeStartupService({ status: "ready", version: "2.0.0" });
    vi.mocked(service.checkForExpectedVersion).mockImplementationOnce(async () => {
      service.setStatus({ status: "ready", version: "3.0.0" });
      return { status: "available", version: "3.0.0" };
    });

    await expect(run(service, "3.0.0")).resolves.toEqual({ kind: "ready", version: "3.0.0" });
    expect(service.quarantineReady).toHaveBeenCalledWith("2.0.0");
    expect(service.checkForExpectedVersion).toHaveBeenCalledWith("3.0.0");
  });

  it("keeps the startup gate retryable when exact acquisition fails or reports up-to-date", async () => {
    const failed = fakeStartupService({ status: "ready", version: "2.0.0" });
    vi.mocked(failed.checkForExpectedVersion).mockImplementationOnce(async () => {
      failed.setStatus({ status: "error", errorKind: "check" });
      return { status: "failed", errorKind: "check" };
    });
    await expect(run(failed, "3.0.0")).resolves.toEqual({ kind: "download-failed" });

    const upToDate = fakeStartupService({ status: "ready", version: "2.0.0" });
    vi.mocked(upToDate.checkForExpectedVersion).mockImplementationOnce(async () => {
      upToDate.setStatus({ status: "idle", availability: "available" });
      return { status: "up-to-date" };
    });
    await expect(run(upToDate, "3.0.0")).resolves.toEqual({ kind: "download-failed" });

    const rejected = fakeStartupService({ status: "idle", availability: "available" });
    vi.mocked(rejected.checkForExpectedVersion).mockRejectedValueOnce(new Error("renderer observer failed"));
    await expect(run(rejected, "3.0.0")).resolves.toEqual({ kind: "download-failed" });
  });

  it("quarantines an unexpected second-manifest version instead of exposing or auto-applying it", async () => {
    const service = fakeStartupService({ status: "ready", version: "2.0.0" });
    vi.mocked(service.checkForExpectedVersion).mockImplementationOnce(async () => {
      service.setStatus({ status: "ready", version: "4.0.0" });
      return { status: "available", version: "4.0.0" };
    });

    await expect(run(service, "3.0.0")).resolves.toEqual({ kind: "download-failed" });
    expect(service.quarantineReady).toHaveBeenNthCalledWith(1, "2.0.0");
    expect(service.quarantineReady).toHaveBeenNthCalledWith(2, "4.0.0");
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
  });

  it("allows a lower-than-cache but newer-than-installed feed candidate to replace quarantined rollback", async () => {
    const service = fakeStartupService({ status: "ready", version: "3.0.0" });
    vi.mocked(service.checkForExpectedVersion).mockImplementationOnce(async () => {
      service.setStatus({ status: "ready", version: "2.0.0" });
      return { status: "available", version: "2.0.0" };
    });

    await expect(run(service, "2.0.0")).resolves.toEqual({ kind: "ready", version: "2.0.0" });
    expect(service.quarantineReady).toHaveBeenCalledWith("3.0.0");
  });

  it("hides a withdrawn cached installer when latest is no newer than installed", async () => {
    const service = fakeStartupService({ status: "ready", version: "3.0.0" });
    await expect(run(service, "1.0.0")).resolves.toEqual({ kind: "release" });
    expect(service.quarantineReady).toHaveBeenCalledWith("3.0.0");
    expect(service.getStatus()).toEqual({ status: "idle", availability: "available" });
    expect(service.checkForExpectedVersion).not.toHaveBeenCalled();
  });

  it("fails closed when durable quarantine cannot be committed", async () => {
    const service = fakeStartupService({ status: "ready", version: "2.0.0" });
    vi.mocked(service.quarantineReady).mockResolvedValueOnce(false);
    await expect(run(service, "3.0.0")).resolves.toEqual({ kind: "download-failed" });
    expect(service.checkForExpectedVersion).not.toHaveBeenCalled();
  });
});

function run(service: FakeStartupService, latest: string | null) {
  return runDesktopUpdateStartupCheck({
    service,
    isPackaged: true,
    currentVersion: "1.0.0",
    fetchManifestVersion: vi.fn(async () => latest)
  });
}

interface FakeStartupService extends DesktopUpdateStartupService {
  readonly initialize: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly getStatus: ReturnType<typeof vi.fn<() => DesktopUpdateStatus>>;
  readonly check: ReturnType<typeof vi.fn<() => Promise<DesktopUpdateCheckResult>>>;
  readonly checkForExpectedVersion: ReturnType<typeof vi.fn<(version: string) => Promise<DesktopUpdateCheckResult>>>;
  readonly quarantineReady: ReturnType<typeof vi.fn<(version: string) => Promise<boolean>>>;
  readonly setStatus: (status: DesktopUpdateStatus) => void;
}

function fakeStartupService(initialStatus: DesktopUpdateStatus): FakeStartupService {
  let status = initialStatus;
  const initialize = vi.fn(async () => undefined);
  const getStatus = vi.fn(() => status);
  const check = vi.fn(async (): Promise<DesktopUpdateCheckResult> => ({ status: "up-to-date" }));
  const checkForExpectedVersion = vi.fn(async (_version: string): Promise<DesktopUpdateCheckResult> => ({
    status: "up-to-date"
  }));
  const quarantineReady = vi.fn(async (version: string) => {
    if (status.status !== "ready" || status.version !== version) return false;
    status = { status: "idle", availability: "available" };
    return true;
  });
  return {
    initialize,
    getStatus,
    check,
    checkForExpectedVersion,
    quarantineReady,
    setStatus: (next) => { status = next; }
  };
}
