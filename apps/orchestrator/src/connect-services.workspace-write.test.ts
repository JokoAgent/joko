import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OrchestratorApplication } from "./application.js";
import { createConnectServices } from "./connect-services.js";
import {
  WORKSPACE_TEXT_FILE_MAXIMUM_BYTES,
  WorkspaceService,
  WorkspaceTextFileWriteError
} from "./workspace-service.js";

const connection = {
  id: "connection-workspace-write",
  name: "Workspace write tests",
  authKeyDigest: "digest",
  state: "active" as const,
  pairedAt: 1,
  revision: 1n
};

function context(): unknown {
  return {
    requestHeader: new Headers({ authorization: "Bearer workspace-write-test" }),
    signal: new AbortController().signal
  };
}

function application(workspaces: unknown, workspaceId: string, supportsWrite: boolean): OrchestratorApplication {
  return {
    config: { publicOrigin: "https://orchestrator.example.test" },
    store: {
      listTargets: () => [{
        descriptor: { id: "target-workspace-write", backendId: "backend-workspace-write" },
        metadata: { workspaceId }
      }],
      getBackend: () => ({
        descriptor: {
          capabilities: new Map([["workspace.files.write", {
            key: "workspace.files.write",
            supported: supportsWrite
          }]])
        }
      })
    },
    connections: { authenticate: () => connection },
    sessionHost: {},
    workspaces,
    workspaceChanges: {},
    artifacts: {},
    blobTransfers: {},
    artifactRepository: {},
    scheduler: {},
    adapters: [],
    browserActivity: [],
    close: async () => undefined
  } as unknown as OrchestratorApplication;
}

async function invoke(
  workspaces: unknown,
  request: contract.WriteWorkspaceTextFileRequest,
  supportsWrite = true
): Promise<contract.WriteWorkspaceTextFileResponse> {
  const handler = createConnectServices(application(workspaces, request.workspaceId, supportsWrite)).workspace.writeWorkspaceTextFile as unknown as (
    value: contract.WriteWorkspaceTextFileRequest,
    handlerContext: unknown
  ) => Promise<contract.WriteWorkspaceTextFileResponse>;
  return handler(request, context());
}

function request(
  workspaceId: string,
  relativePath: string,
  utf8Text: string,
  opaqueRevision: string
): contract.WriteWorkspaceTextFileRequest {
  return create(contract.WriteWorkspaceTextFileRequestSchema, {
    workspaceId,
    relativePath,
    utf8Text,
    expectedRevision: create(contract.FileRevisionSchema, { opaqueRevision })
  });
}

describe("Connect Workspace text writes", () => {
  it("writes text and round-trips the complete expected opaque revision into old/new response fences", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-connect-workspace-write-"));
    const filePath = join(root, "Makefile");
    await writeFile(filePath, "before\n", "utf8");
    const workspaces = new WorkspaceService();
    await workspaces.register({ id: "workspace-write", root, displayName: "Write", trusted: true });
    const original = await workspaces.preview("workspace-write", "Makefile", 2);
    const writeSpy = vi.spyOn(workspaces, "writeTextFile");
    const expectedRevision = create(contract.FileRevisionSchema, {
      sha256Hex: "a".repeat(64),
      byteSize: 7n,
      modifiedAt: create(TimestampSchema, { seconds: 123n, nanos: 456 }),
      opaqueRevision: original.entry.revision
    });

    const response = await invoke(workspaces, create(contract.WriteWorkspaceTextFileRequestSchema, {
      workspaceId: "workspace-write",
      relativePath: "Makefile",
      utf8Text: "first\r\nsecond",
      expectedRevision
    }));

    expect(writeSpy).toHaveBeenCalledWith("workspace-write", {
      path: "Makefile",
      text: "first\r\nsecond",
      expectedRevision: original.entry.revision
    });
    expect(await readFile(filePath, "utf8")).toBe("first\r\nsecond");
    expect(response.previousRevision).toMatchObject({
      sha256Hex: expectedRevision.sha256Hex,
      byteSize: expectedRevision.byteSize,
      modifiedAt: { seconds: 123n, nanos: 456 },
      opaqueRevision: original.entry.revision
    });
    expect(response.entry).toMatchObject({
      workspaceId: "workspace-write",
      relativePath: "Makefile",
      mediaType: "text/plain",
      revision: { opaqueRevision: response.newRevision?.opaqueRevision }
    });
    expect(response.newRevision?.opaqueRevision).toMatch(/^sha256:[0-9a-f]{64}:13$/u);
    expect(response.newRevision?.opaqueRevision).not.toBe(original.entry.revision);
    expect((await workspaces.preview("workspace-write", "Makefile")).entry.revision).toBe(response.newRevision?.opaqueRevision);
  });

  it("maps a real stale revision fence to Aborted without exposing replacement text", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-connect-workspace-stale-"));
    const filePath = join(root, "stale.txt");
    await writeFile(filePath, "before\n", "utf8");
    const workspaces = new WorkspaceService();
    await workspaces.register({ id: "workspace-stale", root, displayName: "Stale", trusted: true });
    const original = await workspaces.preview("workspace-stale", "stale.txt");
    await writeFile(filePath, "external\n", "utf8");
    const sensitiveText = "SENSITIVE_STALE_REPLACEMENT_DO_NOT_EXPOSE";

    const error = await invoke(workspaces, request(
      "workspace-stale",
      "stale.txt",
      sensitiveText,
      original.entry.revision
    )).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConnectError);
    expect(error).toMatchObject({ code: Code.Aborted });
    expect(String(error)).not.toContain(sensitiveText);
    expect(await readFile(filePath, "utf8")).toBe("external\n");
  });

  it("accepts exactly 2 MiB, rejects the next byte, and never includes request text in the error", async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-connect-workspace-limit-"));
    const filePath = join(root, "limit.txt");
    await writeFile(filePath, "before\n", "utf8");
    const workspaces = new WorkspaceService();
    await workspaces.register({ id: "workspace-limit", root, displayName: "Limit", trusted: true });
    const original = await workspaces.preview("workspace-limit", "limit.txt");
    const maximumText = "x".repeat(WORKSPACE_TEXT_FILE_MAXIMUM_BYTES);

    const accepted = await invoke(workspaces, request(
      "workspace-limit",
      "limit.txt",
      maximumText,
      original.entry.revision
    ));
    expect(accepted.newRevision?.byteSize).toBe(BigInt(WORKSPACE_TEXT_FILE_MAXIMUM_BYTES));
    expect((await stat(filePath)).size).toBe(WORKSPACE_TEXT_FILE_MAXIMUM_BYTES);

    const marker = "SENSITIVE_OVERSIZED_BODY_DO_NOT_EXPOSE";
    const error = await invoke(workspaces, request(
      "workspace-limit",
      "limit.txt",
      `${marker}${"x".repeat(WORKSPACE_TEXT_FILE_MAXIMUM_BYTES)}`,
      accepted.newRevision?.opaqueRevision ?? ""
    )).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConnectError);
    expect(error).toMatchObject({ code: Code.ResourceExhausted });
    expect(String(error)).not.toContain(marker);
    expect((await stat(filePath)).size).toBe(WORKSPACE_TEXT_FILE_MAXIMUM_BYTES);
  });

  it.each([
    ["invalid", Code.InvalidArgument],
    ["stale", Code.Aborted],
    ["unsupported", Code.FailedPrecondition],
    ["too_large", Code.ResourceExhausted],
    ["write_failed", Code.Internal]
  ] as const)("maps %s Workspace write errors to the stable Connect code", async (kind, code) => {
    const workspaces = {
      writeTextFile: vi.fn(async () => {
        throw new WorkspaceTextFileWriteError("Workspace text save failed safely.", kind);
      })
    };
    const error = await invoke(workspaces, request(
      "workspace-errors",
      "safe.txt",
      "SENSITIVE_REQUEST_BODY",
      "opaque-revision"
    )).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConnectError);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("SENSITIVE_REQUEST_BODY");
  });

  it("does not dispatch when workspace.files.write is not advertised", async () => {
    const writeTextFile = vi.fn(async () => {
      throw new Error("must not run");
    });
    const error = await invoke({ writeTextFile }, request(
      "workspace-capability",
      "safe.txt",
      "request text",
      "opaque-revision"
    ), false).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConnectError);
    expect(error).toMatchObject({ code: Code.FailedPrecondition });
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("redacts unknown write failures instead of forwarding their message", async () => {
    const secret = "SENSITIVE_UNKNOWN_FAILURE";
    const workspaces = {
      writeTextFile: vi.fn(async () => {
        throw new Error(secret);
      })
    };
    const error = await invoke(workspaces, request(
      "workspace-errors",
      "safe.txt",
      "request text",
      "opaque-revision"
    )).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConnectError);
    expect(error).toMatchObject({ code: Code.Internal });
    expect(String(error)).not.toContain(secret);
  });
});
