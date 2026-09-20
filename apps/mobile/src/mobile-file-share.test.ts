import { describe, expect, it, vi } from "vitest";

vi.mock("expo-crypto", () => ({ randomUUID: () => "native-id" }));

import {
  MobileFileShare,
  type MobileFileShareDriver,
  type MobileFileShareTemporaryFile
} from "./mobile-file-share";
import {
  MOBILE_FILE_SHARE_MAXIMUM_BYTES,
  type AuthorizedBlobDownload
} from "./network";

const hash = "a".repeat(64);
const temporary: MobileFileShareTemporaryFile = {
  uri: "file:///cache/joko-file-share/op/report.txt",
  directoryUri: "file:///cache/joko-file-share/op",
  fileName: "report.txt",
  byteSize: 4
};

describe("mobile generic file sharing", () => {
  it("downloads, incrementally verifies, revalidates, and retains one dispatched file", async () => {
    const calls: string[] = [];
    const driver = createDriver({
      download: vi.fn(async (_source, _fileName, _operationId, onProgress) => {
        calls.push("download");
        onProgress(2);
        onProgress(4);
        return temporary;
      }),
      verify: vi.fn(async (_file, _maximumBytes, onProgress) => {
        calls.push("verify");
        onProgress(2);
        onProgress(4);
        return { byteSize: 4, sha256Hex: hash };
      }),
      share: vi.fn(async () => { calls.push("share"); })
    });
    const share = new MobileFileShare(driver, () => "op");
    const progress = vi.fn();

    await share.perform({
      source: authorized(),
      assertCurrent: async () => { calls.push("current"); },
      onProgress: progress,
      onDispatch: () => { calls.push("dispatch"); }
    });

    expect(calls).toEqual(["download", "verify", "current", "dispatch", "share"]);
    expect(driver.download).toHaveBeenCalledWith(
      authorized(), "report.txt", "op", expect.any(Function), undefined
    );
    expect(driver.verify).toHaveBeenCalledWith(temporary, 4, expect.any(Function), undefined);
    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { phase: "downloading", bytesCompleted: 0, totalBytes: 4 },
      { phase: "downloading", bytesCompleted: 2, totalBytes: 4 },
      { phase: "downloading", bytesCompleted: 4, totalBytes: 4 },
      { phase: "verifying", bytesCompleted: 0, totalBytes: 4 },
      { phase: "verifying", bytesCompleted: 2, totalBytes: 4 },
      { phase: "verifying", bytesCompleted: 4, totalBytes: 4 },
      { phase: "dispatching", bytesCompleted: 4, totalBytes: 4 }
    ]);
    expect(driver.remove).not.toHaveBeenCalled();
  });

  it("treats app inactivity after dispatch begins as expected share-sheet behavior", async () => {
    const controller = new AbortController();
    const driver = createDriver();
    const share = new MobileFileShare(driver, () => "op");

    await share.perform({
      source: authorized(),
      assertCurrent: () => undefined,
      onDispatch: () => controller.abort(),
      signal: controller.signal
    });

    expect(driver.share).toHaveBeenCalledTimes(1);
    expect(driver.remove).not.toHaveBeenCalled();
  });

  it("shares an authenticated empty file with the standard empty SHA-256", async () => {
    const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const file = { ...temporary, fileName: "empty.txt", uri: "file:///cache/joko-file-share/op/empty.txt", byteSize: 0 };
    const driver = createDriver({
      download: vi.fn(async () => file),
      verify: vi.fn(async () => ({ byteSize: 0, sha256Hex: emptyHash }))
    });

    await expect(new MobileFileShare(driver, () => "op").perform({
      source: authorized({ fileName: "empty.txt", byteSize: 0, sha256Hex: emptyHash }),
      assertCurrent: () => undefined
    })).resolves.toBeUndefined();
    expect(driver.share).toHaveBeenCalledWith(file, "text/plain");
  });

  it("removes pre-dispatch files after verification, authority, cancellation, or native failures", async () => {
    const mismatched = createDriver({
      verify: vi.fn(async () => ({ byteSize: 4, sha256Hex: "b".repeat(64) }))
    });
    await expect(new MobileFileShare(mismatched, () => "op").perform({
      source: authorized(), assertCurrent: () => undefined
    })).rejects.toThrow(/size or SHA-256/u);
    expect(mismatched.remove).toHaveBeenCalledWith(temporary);
    expect(mismatched.share).not.toHaveBeenCalled();

    const drifted = createDriver();
    await expect(new MobileFileShare(drifted, () => "op").perform({
      source: authorized(), assertCurrent: () => { throw new Error("source changed"); }
    })).rejects.toThrow(/source changed/u);
    expect(drifted.remove).toHaveBeenCalledWith(temporary);
    expect(drifted.share).not.toHaveBeenCalled();

    const controller = new AbortController();
    const cancelled = createDriver({
      verify: vi.fn(async (_file, _maximumBytes, onProgress, signal) => {
        onProgress(2);
        signal?.throwIfAborted();
        return { byteSize: 4, sha256Hex: hash };
      })
    });
    await expect(new MobileFileShare(cancelled, () => "op").perform({
      source: authorized(),
      assertCurrent: () => undefined,
      signal: controller.signal,
      onProgress: (progress) => {
        if (progress.phase === "verifying" && progress.bytesCompleted === 2) controller.abort();
      }
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled.remove).toHaveBeenCalledWith(temporary);
    expect(cancelled.share).not.toHaveBeenCalled();

    const failedShare = createDriver({
      share: vi.fn(async () => { throw new Error("native share failed"); })
    });
    await expect(new MobileFileShare(failedShare, () => "op").perform({
      source: authorized(), assertCurrent: () => undefined
    })).rejects.toThrow(/native share failed/u);
    expect(failedShare.remove).toHaveBeenCalledWith(temporary);
  });

  it("checks availability before downloading and permits only one action at a time", async () => {
    const unavailable = createDriver({ sharingAvailable: vi.fn(async () => false) });
    await expect(new MobileFileShare(unavailable, () => "op").perform({
      source: authorized(), assertCurrent: () => undefined
    })).rejects.toThrow(/unavailable/u);
    expect(unavailable.download).not.toHaveBeenCalled();

    let release: (() => void) | undefined;
    const concurrent = createDriver({
      download: vi.fn(() => new Promise<MobileFileShareTemporaryFile>((resolve) => {
        release = () => resolve(temporary);
      }))
    });
    const share = new MobileFileShare(concurrent, () => "op");
    const first = share.perform({ source: authorized(), assertCurrent: () => undefined });
    await vi.waitFor(() => expect(concurrent.download).toHaveBeenCalledTimes(1));
    await expect(share.perform({ source: authorized(), assertCurrent: () => undefined }))
      .rejects.toThrow(/already in progress/u);
    release?.();
    await first;
  });

  it("serializes maintenance and fails closed on unsafe or unbounded metadata", async () => {
    let release: (() => void) | undefined;
    const driver = createDriver({
      maintain: vi.fn(() => new Promise<void>((resolve) => { release = resolve; }))
    });
    const share = new MobileFileShare(driver, () => "op");
    const first = share.maintain();
    const second = share.maintain();
    expect(driver.maintain).toHaveBeenCalledTimes(1);
    release?.();
    await Promise.all([first, second]);

    for (const source of [
      authorized({ fileName: "../report.txt" }),
      authorized({ fileName: " report.txt" }),
      authorized({ fileName: "bad\nname.txt" }),
      authorized({ byteSize: MOBILE_FILE_SHARE_MAXIMUM_BYTES + 1 }),
      authorized({ url: "file:///secret" }),
      authorized({ headers: { authorization: "Bearer secret", extra: "value" } })
    ]) {
      await expect(new MobileFileShare(createDriver(), () => "op").perform({
        source, assertCurrent: () => undefined
      })).rejects.toThrow(/source is invalid/u);
    }
  });
});

function authorized(overrides: Partial<AuthorizedBlobDownload> = {}): AuthorizedBlobDownload {
  return {
    url: "https://node.example/v1/blobs/ticket",
    headers: { authorization: "Bearer secret" },
    blobId: "blob-one",
    fileName: "report.txt",
    mediaType: "text/plain",
    byteSize: 4,
    sha256Hex: hash,
    ...overrides
  };
}

function createDriver(overrides: Partial<MobileFileShareDriver> = {}): MobileFileShareDriver & {
  [K in keyof MobileFileShareDriver]: ReturnType<typeof vi.fn>;
} {
  return {
    maintain: vi.fn(async () => undefined),
    sharingAvailable: vi.fn(async () => true),
    download: vi.fn(async () => temporary),
    verify: vi.fn(async () => ({ byteSize: 4, sha256Hex: hash })),
    remove: vi.fn(async () => undefined),
    share: vi.fn(async () => undefined),
    ...overrides
  } as MobileFileShareDriver & {
    [K in keyof MobileFileShareDriver]: ReturnType<typeof vi.fn>;
  };
}
