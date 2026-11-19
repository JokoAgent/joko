import { randomUUID } from "node:crypto";
import { lstat, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nativeFileActionRequestId, workspaceFileMetadataRevision } from "@joko/contracts";
import { expect, it, vi } from "vitest";
import type { DesktopWorkspaceFileSourceRequest } from "../src/channels.js";
import { NativeWorkspaceFileSource } from "../src/native-workspace-file-source.js";
import { mkdtemp } from "./test-paths.js";

it("opens the verified original PDF and its folder only while the same source and window are current", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-native-workspace-pdf-")));
  try {
    const path = join(root, "manual.pdf");
    await writeFile(path, "%PDF-1.7\n%%EOF\n");
    let managedAuthorityCurrent = true;
    let focused = true;
    const source = {
      path,
      metadataRevision: workspaceFileMetadataRevision(await lstat(path)),
      isCurrent: () => managedAuthorityCurrent
    };
    const resolveSource = vi.fn(async () => source);
    const openPath = vi.fn(async () => "");
    const native = new NativeWorkspaceFileSource({ resolveSource, openPath });
    const scope = { id: randomUUID(), isCurrent: () => true };
    const request = (ordinal: number, action: DesktopWorkspaceFileSourceRequest["action"]): DesktopWorkspaceFileSourceRequest => ({
      requestId: nativeFileActionRequestId(ordinal, randomUUID()),
      profileId: "managed-local",
      serverId: "orchestrator-owner",
      workspaceId: "project",
      path: "manual.pdf",
      revision: "fixture-revision",
      action
    });
    const isFocused = () => focused;
    const open = request(1, "open");
    await expect(native.execute(open, scope, isFocused)).resolves.toEqual({ status: "opened" });
    await expect(native.execute(open, scope, isFocused)).resolves.toEqual({ status: "opened" });
    await expect(native.execute(request(2, "reveal"), scope, isFocused)).resolves.toEqual({ status: "revealed" });
    expect(openPath.mock.calls).toEqual([[path], [dirname(path)]]);
    expect(resolveSource).toHaveBeenCalledTimes(2);

    resolveSource.mockImplementationOnce(async () => { focused = false; return source; });
    await expect(native.execute(request(3, "open"), scope, isFocused)).resolves.toEqual({ status: "cancelled" });
    focused = true;
    resolveSource.mockImplementationOnce(async () => { managedAuthorityCurrent = false; return source; });
    await expect(native.execute(request(4, "reveal"), scope, isFocused)).resolves.toEqual({ status: "cancelled" });
    managedAuthorityCurrent = true;
    await writeFile(path, "%PDF-1.7\n% changed original\n%%EOF\n");
    await expect(native.execute(request(5, "open"), scope, isFocused)).resolves.toEqual({ status: "unavailable" });
    expect(openPath).toHaveBeenCalledTimes(2);
    native.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
