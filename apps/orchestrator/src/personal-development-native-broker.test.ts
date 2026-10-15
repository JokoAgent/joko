import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import type { HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "./connection-manager.js";
import { PersonalDevelopmentNativeBroker, type DesktopDevelopmentHostValue } from "./personal-development-native-broker.js";
import { createPersonalDevelopmentNativeConnectService } from "./personal-development-native-connect-service.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "joko-native-development-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new OperationalStore(":memory:"); cleanups.push(() => store.close());
  const connections = new ConnectionManager(store), hostKey = "h".repeat(43), authorization = `Bearer ${hostKey}`;
  const issued = connections.issueTrustedDesktopConnection({ desktopInstanceId: randomUUID(), desktopDeviceId: randomUUID(),
    defaultDeviceName: "Local Desktop", platform: "win32", appVersion: "0.1.0", desktopHostAuthKey: hostKey });
  const broker = new PersonalDevelopmentNativeBroker({ directory, connections }); await broker.initialize(); cleanups.push(() => broker.close());
  const original = { id: "original" as const, generation: "", runtimeDirectory: join(directory, "original"), executable: join(directory, "original", "app.exe"),
    runtimeDigest: "a".repeat(64), compatibilityIdentity: "b".repeat(64), version: "0.1.0", development: false };
  const target = { ...original, id: "personal" as const, generation: randomUUID(), runtimeDirectory: join(directory, "personal"),
    executable: join(directory, "personal", "app.exe"), runtimeDigest: "c".repeat(64) };
  const info: DesktopDevelopmentHostValue = { hostInstanceId: randomUUID(), profileIdentity: "d".repeat(64), original, current: original, busy: false, launchTicketId: "" };
  const context = (host = authorization, bearer = `Bearer ${issued.authKey}`): HandlerContext => ({ requestHeader: new Headers({
    authorization: bearer, [DESKTOP_HOST_AUTHORIZATION_HEADER]: host }), signal: new AbortController().signal }) as HandlerContext;
  const commit = () => connections.confirmTrustedDesktopConnection(issued.connection.id, issued.authKey);
  const register = () => broker.register(issued.connection, authorization, info);
  const disk = async () => JSON.parse(await readFile(join(directory, "state.json"), "utf8")) as { tickets: Record<string, { phase: string }> };
  return { directory, store, connections, issued, authorization, broker, target, info, context, commit, register, disk };
}
async function expectNoCommand(broker: PersonalDevelopmentNativeBroker, input: Awaited<ReturnType<typeof setup>>, generation: number) {
  const controller = new AbortController();
  const pending = broker.poll(input.issued.connection, input.authorization, input.info.hostInstanceId, generation, controller.signal);
  queueMicrotask(() => controller.abort()); await expect(pending).rejects.toBeDefined();
}

describe("local Desktop personal-development mailbox", () => {
  it("carries directory choices as a closed generated enum with no renderer-supplied path", async () => {
    const s = await setup(); s.commit(); const generation = await s.register();
    const service = createPersonalDevelopmentNativeConnectService(s.broker, s.connections), signal = new AbortController().signal;
    await expect(s.broker.openDirectory("other" as "source", signal)).rejects.toBeDefined();
    for (const directory of ["source", "tools"] as const) {
      const opened = s.broker.openDirectory(directory, signal);
      const response = await service.pollDesktopDevelopmentCommand(create(contract.PollDesktopDevelopmentCommandRequestSchema,
        { hostInstanceId: s.info.hostInstanceId, hostGeneration: BigInt(generation) }), s.context());
      expect(response.command).toMatchObject({ kind: contract.DesktopDevelopmentCommandKind.OPEN_DIRECTORY,
        directory: directory === "source" ? contract.PersonalDevelopmentDirectoryKind.SOURCE : contract.PersonalDevelopmentDirectoryKind.TOOLS });
      expect(response.command?.path).toBe(""); expect(response.command?.target).toBeUndefined();
      await service.completeDesktopDevelopmentCommand(create(contract.CompleteDesktopDevelopmentCommandRequestSchema,
        { hostInstanceId: s.info.hostInstanceId, hostGeneration: BigInt(generation), commandId: response.command!.commandId, status: "opened" }), s.context());
      await expect(opened).resolves.toBeUndefined();
    }
  });

  it("requires committed ordinary and Main-only authorization and rejects paired clients", async () => {
    const s = await setup(), service = createPersonalDevelopmentNativeConnectService(s.broker, s.connections);
    const request = create(contract.RegisterDesktopDevelopmentHostRequestSchema, s.info);
    await expect(service.registerDesktopDevelopmentHost(request, s.context())).rejects.toBeDefined();
    s.commit(); await expect(service.registerDesktopDevelopmentHost(request, s.context(""))).rejects.toBeDefined();
    await expect(service.registerDesktopDevelopmentHost(request, s.context(s.authorization, "Bearer wrong"))).rejects.toBeDefined();
    await expect(service.registerDesktopDevelopmentHost(request, s.context())).resolves.toMatchObject({ hostGeneration: expect.any(BigInt) });
    const pairing = s.connections.issuePairing("Browser"), remote = s.connections.completePairing({ challengeId: pairing.id, code: pairing.code, connectionName: "Browser" });
    await expect(service.registerDesktopDevelopmentHost(request, s.context(s.authorization, `Bearer ${remote.authKey}`))).rejects.toBeDefined();
    expect(() => s.broker.assertLocalDesktopConnection(remote.connection)).toThrow();
    expect(() => s.broker.assertLocalDesktopConnection(s.issued.connection)).not.toThrow();
    const persisted = await readFile(join(s.directory, "state.json"), "utf8");
    expect(persisted).not.toContain(s.issued.authKey); expect(persisted).not.toContain(s.authorization);
    s.connections.revoke(s.issued.connection.id); expect(s.broker.availability().available).toBe(false);
  });

  it("durably queues before activation, acknowledges preparation, and never redispatches an unknown restart", async () => {
    const s = await setup(); s.commit(); const generation = await s.register();
    const operationId = randomUUID(), ticket = await s.broker.nativeVersions.handoff({ ...s.target, operationId }, new AbortController().signal);
    expect(ticket.status).toBe("queued"); if (ticket.status !== "queued") throw new Error("Missing handoff ticket.");
    expect((await s.disk()).tickets[ticket.ticketId]?.phase).toBe("queued"); await expectNoCommand(s.broker, s, generation);
    await s.broker.nativeVersions.activateHandoff!(ticket.ticketId);
    const command = await s.broker.poll(s.issued.connection, s.authorization, s.info.hostInstanceId, generation, new AbortController().signal);
    expect(command).toMatchObject({ kind: "handoff", ticketId: ticket.ticketId, target: s.target });
    await expect(s.broker.complete(s.issued.connection, s.authorization, s.info.hostInstanceId, generation, ticket.ticketId,
      { status: "prepared", receipt: ticket.ticketId })).resolves.toEqual({ accepted: true, executeHandoff: true });
    expect((await s.disk()).tickets[ticket.ticketId]?.phase).toBe("prepared"); await s.broker.close();
    const recovered = new PersonalDevelopmentNativeBroker({ directory: s.directory, connections: s.connections });
    await recovered.initialize(); cleanups.push(() => recovered.close()); const reconcile = vi.fn().mockResolvedValue(undefined); recovered.setVersionReconciler(reconcile);
    const recoveredGeneration = await recovered.register(s.issued.connection, s.authorization, s.info);
    expect((await s.disk()).tickets[ticket.ticketId]?.phase).toBe("unknown"); await expectNoCommand(recovered, s, recoveredGeneration);
    await recovered.register(s.issued.connection, s.authorization, { ...s.info, hostInstanceId: randomUUID(), current: s.target, launchTicketId: ticket.ticketId });
    expect(reconcile).toHaveBeenCalledExactlyOnceWith({ ticketId: ticket.ticketId, outcome: "ready", current: { id: "personal", generation: s.target.generation }, operationId: ticket.ticketId });
    expect((await s.disk()).tickets[ticket.ticketId]?.phase).toBe("ready"); expect(await recovered.nativeVersions.busy()).toBe(false);
    await recovered.nativeVersions.handoff({ ...s.target, operationId }, new AbortController().signal);
    expect((await s.disk()).tickets[ticket.ticketId]?.phase).toBe("ready");
  });

  it("keeps the current host when a new ready proof is invalid and accepts exact previous-runtime failure", async () => {
    const s = await setup(); s.commit(); const generation = await s.register();
    const reconciler = vi.fn().mockResolvedValue(undefined); s.broker.setVersionReconciler(reconciler);
    const ticket = await s.broker.nativeVersions.handoff({ ...s.target, operationId: randomUUID() }, new AbortController().signal);
    if (ticket.status !== "queued") throw new Error("Missing handoff ticket.");
    await s.broker.nativeVersions.activateHandoff!(ticket.ticketId);
    await s.broker.poll(s.issued.connection, s.authorization, s.info.hostInstanceId, generation, new AbortController().signal);
    await expect(s.broker.register(s.issued.connection, s.authorization, { ...s.info, hostInstanceId: randomUUID(),
      current: { ...s.target, runtimeDigest: "e".repeat(64) }, launchTicketId: ticket.ticketId })).rejects.toThrow("does not match");
    expect(s.broker.metadata()?.current).toEqual({ id: "original" }); expect(s.broker.availability().available).toBe(true);
    await expect(s.broker.complete(s.issued.connection, s.authorization, s.info.hostInstanceId, generation, ticket.ticketId,
      { status: "unknown", receipt: "" })).resolves.toEqual({ accepted: true, executeHandoff: false });
    await s.broker.register(s.issued.connection, s.authorization, { ...s.info, launchTicketId: ticket.ticketId });
    expect(reconciler).toHaveBeenCalledExactlyOnceWith({ ticketId: ticket.ticketId, outcome: "failed", current: { id: "original" }, operationId: `${ticket.ticketId}-failed` });
    expect((await s.disk()).tickets[ticket.ticketId]?.phase).toBe("failed");
  });
});
