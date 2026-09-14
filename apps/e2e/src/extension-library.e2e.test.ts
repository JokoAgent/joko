import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  ExtensionLibraryCallSchema,
  ExtensionLibraryState,
  OperationMutationSchema,
  OperationState,
  type ExtensionLibraryCall,
  type ExtensionLibraryCallResult
} from "@joko/contracts";
import { rm } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import type { E2eClients } from "./connect-clients.js";
import {
  ExtensionLibrarySystemFixture,
  installLibraryExtension,
  requireInstalledLibraryExtension
} from "./extension-library-system-fixture.js";
import { submit } from "./operations.js";

describe("production Extension Library chain", () => {
  let fixture: ExtensionLibrarySystemFixture | undefined;
  let rootDirectory: string | undefined;

  afterEach(async () => {
    await fixture?.close().catch(() => undefined);
    fixture = undefined;
    if (rootDirectory !== undefined) {
      await rm(rootDirectory, { recursive: true, force: true, maxRetries: 3 });
      rootDirectory = undefined;
    }
  });

  it("persists file, stream, and isolated SQLite state across a production restart and revokes it on disable", async () => {
    fixture = await ExtensionLibrarySystemFixture.start({ keepRoot: true });
    rootDirectory = fixture.rootDirectory;
    await expect(fixture.anonymous.extension.listExtensions({ page: { pageSize: 10 } }))
      .rejects.toMatchObject({ code: Code.Unauthenticated });

    const paired = await fixture.pair("Extension Library HTTP owner");
    const installed = await installLibraryExtension(fixture, paired);
    const revision = requiredRevision(installed);
    const overview = await paired.clients.extension.getExtensionLibraryOverview({
      extensionId: installed.extensionId,
      expectedRevision: { value: revision }
    });
    expect(overview.library).toMatchObject({
      extensionId: installed.extensionId,
      state: ExtensionLibraryState.READY,
      files: 0,
      bytes: 0n
    });

    const opened = await paired.clients.extension.openExtensionLibrary({
      extensionId: installed.extensionId,
      expectedRevision: { value: revision }
    });
    const sessionId = opened.library?.sessionId;
    if (sessionId === undefined) throw new Error("The production service returned no Library session.");
    expect(opened.library).not.toHaveProperty("path");

    const text = new TextEncoder().encode("durable HTTP file");
    const written = await libraryCall(paired.clients.extension, sessionId, {
      case: "write",
      value: { path: "notes/owner.txt", content: text, ifNotExists: true }
    });
    expect(written.result).toMatchObject({ case: "write", value: { path: "notes/owner.txt", bytes: BigInt(text.byteLength) } });

    const streamed = new TextEncoder().encode("streamed payload");
    const begun = await libraryCall(paired.clients.extension, sessionId, {
      case: "writeBegin",
      value: { path: "notes/stream.txt", totalBytes: BigInt(streamed.byteLength), ifNotExists: true }
    });
    if (begun.result.case !== "stream") throw new Error("The production service returned no write stream.");
    const streamId = begun.result.value.streamId;
    await libraryCall(paired.clients.extension, sessionId, {
      case: "writeChunk",
      value: { streamId, sequence: 0, content: streamed }
    });
    await libraryCall(paired.clients.extension, sessionId, {
      case: "writeCommit",
      value: { streamId }
    });
    const listed = await libraryCall(paired.clients.extension, sessionId, {
      case: "list",
      value: { path: "notes", recursive: true, limit: 100 }
    });
    expect(listed.result).toMatchObject({
      case: "list",
      value: { entries: [
        expect.objectContaining({ path: "notes/owner.txt" }),
        expect.objectContaining({ path: "notes/stream.txt" })
      ] }
    });

    const database = await libraryCall(paired.clients.extension, sessionId, {
      case: "sqlOpen",
      value: { path: "state.sqlite", create: true, readOnly: false }
    });
    if (database.result.case !== "sqlHandle") throw new Error("The production service returned no SQLite handle.");
    const handleId = database.result.value.handleId;
    const migrated = await libraryCall(paired.clients.extension, sessionId, {
      case: "sqlMigrate",
      value: {
        handleId,
        migrations: [{
          version: 1,
          statements: ["CREATE TABLE cards(id INTEGER PRIMARY KEY, title TEXT NOT NULL)"]
        }]
      }
    });
    expect(migrated.result).toMatchObject({ case: "sqlVersion", value: { userVersion: 1 } });
    const batched = await libraryCall(paired.clients.extension, sessionId, {
      case: "sqlBatch",
      value: {
        handleId,
        statements: ["first", "second"].map((title) => ({
          sql: "INSERT INTO cards(title) VALUES (?)",
          parameters: [{ value: { case: "textValue" as const, value: title } }]
        }))
      }
    });
    expect(batched.result).toMatchObject({
      case: "sqlBatch",
      value: { results: [{ changes: "1" }, { changes: "1" }] }
    });
    await libraryCall(paired.clients.extension, sessionId, { case: "sqlClose", value: { handleId } });
    expect((await paired.clients.extension.closeExtensionLibrary({ sessionId })).closed).toBe(true);

    await fixture.close({ removeRoot: false });
    fixture = undefined;
    fixture = await ExtensionLibrarySystemFixture.start({ rootDirectory, keepRoot: true });
    const restarted = await fixture.pair("Extension Library restart owner");
    const restored = requireInstalledLibraryExtension(await restarted.clients.extension.listExtensions({
      page: { pageSize: 100 }
    }));
    expect(restored.extensionId).toBe(installed.extensionId);
    const restoredRevision = requiredRevision(restored);
    const reopened = await restarted.clients.extension.openExtensionLibrary({
      extensionId: restored.extensionId,
      expectedRevision: { value: restoredRevision }
    });
    const restartedSessionId = reopened.library?.sessionId;
    if (restartedSessionId === undefined) throw new Error("The restarted service returned no Library session.");
    const read = await libraryCall(restarted.clients.extension, restartedSessionId, {
      case: "read",
      value: { path: "notes/owner.txt" }
    });
    if (read.result.case !== "read") throw new Error("The restarted service returned no file content.");
    expect(new TextDecoder().decode(read.result.value.content)).toBe("durable HTTP file");

    const reopenedDatabase = await libraryCall(restarted.clients.extension, restartedSessionId, {
      case: "sqlOpen",
      value: { path: "state.sqlite", create: false, readOnly: true }
    });
    if (reopenedDatabase.result.case !== "sqlHandle") throw new Error("The restarted service returned no SQLite handle.");
    const selected = await libraryCall(restarted.clients.extension, restartedSessionId, {
      case: "sqlExecute",
      value: {
        handleId: reopenedDatabase.result.value.handleId,
        statement: { sql: "SELECT id, title FROM cards ORDER BY id", parameters: [] }
      }
    });
    expect(selected.result).toMatchObject({
      case: "sqlResult",
      value: { rows: [
        { cells: [
          { name: "id", value: { value: { case: "integerValue", value: "1" } } },
          { name: "title", value: { value: { case: "textValue", value: "first" } } }
        ] },
        { cells: [
          { name: "id", value: { value: { case: "integerValue", value: "2" } } },
          { name: "title", value: { value: { case: "textValue", value: "second" } } }
        ] }
      ] }
    });

    const disabled = await submit(restarted.clients.operation, restarted.connectionId, create(OperationMutationSchema, {
      payload: {
        case: "setExtensionEnabled",
        value: {
          extensionId: restored.extensionId,
          enabled: false,
          expectedRevision: { value: restoredRevision }
        }
      }
    }));
    expect(disabled.state).toBe(OperationState.SUCCEEDED);
    await expect(libraryCall(restarted.clients.extension, restartedSessionId, {
      case: "read",
      value: { path: "notes/owner.txt" }
    })).rejects.toMatchObject({ code: Code.NotFound });
    const disabledEntry = (await restarted.clients.extension.getExtension({ extensionId: restored.extensionId })).extension;
    expect(disabledEntry).toMatchObject({ installed: true, enabled: false });
  }, 90_000);
});

async function libraryCall(
  client: E2eClients["extension"],
  sessionId: string,
  operation: { readonly case: string; readonly value: unknown }
): Promise<ExtensionLibraryCallResult> {
  const response = await client.callExtensionLibrary({
    sessionId,
    call: create(ExtensionLibraryCallSchema, {
      operation: operation as ExtensionLibraryCall["operation"]
    })
  });
  if (response.result === undefined) throw new Error("Extension Library call returned no result.");
  return response.result;
}

function requiredRevision(entry: { readonly revision?: { readonly value: bigint } }): bigint {
  const revision = entry.revision?.value;
  if (revision === undefined) throw new Error("Extension entry returned no revision.");
  return revision;
}
