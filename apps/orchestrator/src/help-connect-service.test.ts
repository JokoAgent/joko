import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionManager } from "./connection-manager.js";
import type { HelpAssistant } from "./help-assistant.js";
import { HelpFeedbackStore } from "./help-feedback-store.js";
import { createHelpConnectService } from "./help-connect-service.js";

const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
const context = () => ({ requestHeader: new Headers({ authorization: "Bearer allowed" }), signal: new AbortController().signal }) as HandlerContext;

describe("HelpService", () => {
  it("uses generated answer/no-answer contracts, rejects unauthenticated requests and retires revoked responses", async () => {
    let revoked = false; const listeners = new Set<() => void>();
    const connections = { authenticate: (header: string) => { if (header !== "Bearer allowed") throw new ConnectError("Unauthorized", Code.Unauthenticated); return { id: "owner" }; },
      onRevoked: (_id: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      fence: () => { if (revoked) throw new ConnectError("Revoked", Code.PermissionDenied); } } as unknown as ConnectionManager;
    const ask = vi.fn().mockResolvedValue({ text: "Open settings", settingsSection: "general" });
    const service = createHelpConnectService({ ask } as unknown as HelpAssistant, undefined, connections);
    const request = fromBinary(contract.AskHelpRequestSchema, toBinary(contract.AskHelpRequestSchema,
      create(contract.AskHelpRequestSchema, { messages: [{ role: contract.HelpRole.USER, content: "Help" }], locale: "en" })));
    await expect(service.askHelp(request, context())).resolves.toMatchObject({ result: { case: "answer", value: { text: "Open settings", settingsSection: "general" } } });
    ask.mockResolvedValueOnce(undefined);
    await expect(service.askHelp(request, context())).resolves.toMatchObject({ result: { case: "noAnswer" } });
    await expect(service.askHelp(request, { ...context(), requestHeader: new Headers() })).rejects.toMatchObject({ code: Code.Unauthenticated });
    let resolve!: (value: undefined) => void;
    ask.mockImplementationOnce(() => new Promise(accept => { resolve = accept; }));
    const pending = service.askHelp(request, context()); revoked = true; for (const listener of listeners) listener(); resolve(undefined);
    await expect(pending).rejects.toBeDefined(); expect(listeners.size).toBe(0);
  });

  it("atomically saves private drafts, replays the same request after restart and preserves corrupt files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-help-feedback-")); paths.push(directory);
    const feedback = new HelpFeedbackStore(directory);
    const input = { requestId: randomUUID(), question: "Private question", answer: "", title: "Documentation gap", body: "Private description", locale: "en" };
    const [first, concurrent] = await Promise.all([feedback.create("owner", input, () => {}), feedback.create("owner", input, () => {})]);
    expect(first).toBe(concurrent);
    expect(await new HelpFeedbackStore(directory).create("owner", input, () => {})).toBe(first);
    expect(await readdir(directory)).toEqual([`${input.requestId}.json`]);
    const saved = JSON.parse(await readFile(join(directory, `${input.requestId}.json`), "utf8"));
    expect(saved).toMatchObject({ format: 1, ownerId: "owner", id: first, input });
    await expect(feedback.create("other-owner", input, () => {})).rejects.toThrow();
    await expect(feedback.create("owner", { ...input, body: "Changed" }, () => {})).rejects.toThrow();
    const broken = { ...input, requestId: randomUUID() }, path = join(directory, `${broken.requestId}.json`);
    await writeFile(path, "{broken");
    await expect(feedback.create("owner", broken, () => {})).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{broken");
    await expect(feedback.create("owner", { ...input, requestId: "../outside" }, () => {})).rejects.toThrow();
    await expect(feedback.create("owner", { ...input, requestId: randomUUID() }, () => { throw new Error("retired"); })).rejects.toThrow("retired");
  });

  it("replays a private draft after a connection changes while retaining the authenticated Device scope", async () => {
    const directory = await mkdtemp(join(tmpdir(), "joko-help-feedback-device-")); paths.push(directory);
    let connectionId = "connection-a";
    const connections = { authenticate: () => ({ id: connectionId, deviceId: "stable-device" }), fence: () => {}, onRevoked: () => () => {} } as unknown as ConnectionManager;
    const service = createHelpConnectService(undefined, new HelpFeedbackStore(directory), connections);
    const input = create(contract.CreateHelpFeedbackDraftRequestSchema, { requestId: randomUUID(), question: "Question", answer: "", title: "Gap", body: "Description", locale: "en" });
    const first = await service.createHelpFeedbackDraft(input, context()); connectionId = "connection-b";
    const replay = await service.createHelpFeedbackDraft(input, context());
    expect(replay.draftId).toBe(first.draftId);
    expect(JSON.parse(await readFile(join(directory, `${input.requestId}.json`), "utf8")).ownerId).toBe("stable-device");
  });
});
