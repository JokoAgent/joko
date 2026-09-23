import { Code, ConnectError } from "@connectrpc/connect";
import type { RemoteFileTransportPort } from "@joko/remote-ssh";
import { expect, it, vi } from "vitest";

import { inspectRemoteHostDirectory, listRemoteHostDirectories, validateRemoteHostDirectoryPath } from "./remote-host-directory-browser.js";

const signal = new AbortController().signal;
const stat = { kind: "directory" as const, size: 0, modifiedAt: 0, mode: 0o755 };

it("starts at the SSH home, lists only directories, resolves directory links, and preserves parent navigation", async () => {
  const files = {
    realpath: vi.fn(async (path: string) => path === "." ? "/home/maker" : path === "/home/maker/shared" ? "/srv/shared" : path),
    stat: vi.fn(async (path: string) => path === "/home/maker/file" ? { ...stat, kind: "file" as const } : stat),
    list: vi.fn(async () => [
      { name: "zeta", kind: "directory" as const },
      { name: "file", kind: "file" as const },
      { name: "shared", kind: "symbolic_link" as const },
      { name: "alpha", kind: "directory" as const }
    ])
  } as unknown as RemoteFileTransportPort;
  const assertCurrent = vi.fn();
  await expect(listRemoteHostDirectories(files, "", signal, assertCurrent)).resolves.toEqual({
    path: "/home/maker", parentPath: "/home", truncated: false,
    directories: [
      { name: "alpha", path: "/home/maker/alpha" },
      { name: "shared", path: "/srv/shared" },
      { name: "zeta", path: "/home/maker/zeta" }
    ]
  });
  expect(files.realpath).toHaveBeenCalledWith(".", signal);
  expect(assertCurrent).toHaveBeenCalled();
  await expect(listRemoteHostDirectories(files, "/", signal, assertCurrent)).resolves.toMatchObject({ path: "/", parentPath: "/" });
});

it("rejects malformed paths before transport effects and caps directory output", async () => {
  for (const path of ["relative", "/bad/../path", "/bad\u0000path"]) {
    expect(() => validateRemoteHostDirectoryPath(path)).toThrow(ConnectError);
  }
  const files = {
    realpath: vi.fn(async (path: string) => path),
    stat: vi.fn(async () => stat),
    list: vi.fn(async () => Array.from({ length: 220 }, (_, index) => ({ name: `folder-${String(index).padStart(3, "0")}`, kind: "directory" as const })))
  } as unknown as RemoteFileTransportPort;
  await expect(listRemoteHostDirectories(files, "relative", signal, () => undefined)).rejects.toMatchObject({ code: Code.InvalidArgument });
  expect(files.realpath).not.toHaveBeenCalled();
  const listing = await listRemoteHostDirectories(files, "/home/maker", signal, () => undefined);
  expect(listing.directories).toHaveLength(200);
  expect(listing.truncated).toBe(true);
});

it("checks the captured authority after delayed transport work", async () => {
  let finish!: (path: string) => void;
  const files = {
    realpath: () => new Promise<string>(resolve => { finish = resolve; }),
    stat: vi.fn(async () => stat),
    list: vi.fn(async () => [])
  } as unknown as RemoteFileTransportPort;
  let current = true;
  const pending = listRemoteHostDirectories(files, "", signal, () => {
    if (!current) throw new ConnectError("Host changed", Code.Aborted);
  });
  current = false;
  finish("/home/maker");
  await expect(pending).rejects.toMatchObject({ code: Code.Aborted });
  expect(files.stat).not.toHaveBeenCalled();
});

it("classifies only an absent SSH entry as missing and keeps existing directories canonical", async () => {
  const list = vi.fn(async (path: string) => ({
    "/": [{ name: "home", kind: "directory" }],
    "/home": [{ name: "maker", kind: "directory" }],
    "/home/maker": [{ name: "link", kind: "symbolic_link" }, { name: "file", kind: "file" }]
  } as Record<string, readonly { name: string; kind: "directory" | "symbolic_link" | "file" }[]>)[path] ?? []);
  const files = {
    realpath: vi.fn(async (path: string) => path === "/home/maker/link" ? "/srv/shared" : path),
    stat: vi.fn(async () => stat),
    list
  } as unknown as RemoteFileTransportPort;
  await expect(inspectRemoteHostDirectory(files, "/home/maker/link", signal, () => undefined))
    .resolves.toEqual({ exists: true, path: "/srv/shared" });
  await expect(inspectRemoteHostDirectory(files, "/home/maker/new/sub", signal, () => undefined))
    .resolves.toEqual({ exists: false, path: "/home/maker/new/sub" });
  await expect(inspectRemoteHostDirectory(files, "/home/maker/file", signal, () => undefined))
    .rejects.toMatchObject({ code: Code.FailedPrecondition });
  list.mockRejectedValueOnce(new Error("Permission denied"));
  await expect(inspectRemoteHostDirectory(files, "/home/maker/new", signal, () => undefined))
    .rejects.toThrow("Permission denied");
  expect(files.realpath).not.toHaveBeenCalledWith("/home/maker/new", signal);
});
