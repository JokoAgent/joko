import { createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ConnectionService, DesktopDevelopmentCommandKind, DesktopPersonalDevelopmentHostService, PersonalDevelopmentDirectoryKind, type DesktopDevelopmentRuntime } from "@joko/contracts";
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from "@joko/contracts/desktop-bootstrap";
import type { DesktopManagedOrchestratorConnection } from "./channels.js";
import type { DesktopPersonalDevelopmentVersions } from "./personal-development-native-versions.js";
import type { PersonalNativeRuntime } from "./personal-development-native-runtime.js";

function nativeRuntime(value: DesktopDevelopmentRuntime | undefined): PersonalNativeRuntime {
  if (!value || !["original", "personal"].includes(value.id)) throw new Error("Native development command has no runtime identity.");
  return { id: value.id as "original" | "personal", generation: value.generation, executable: value.executable, runtimeDirectory: value.runtimeDirectory,
    runtimeDigest: value.runtimeDigest, compatibilityIdentity: value.compatibilityIdentity, version: value.version, development: value.development };
}
type HostClient = Client<typeof DesktopPersonalDevelopmentHostService>;

/** A Main-only consumer of the exact committed managed Desktop host mailbox. */
export class DesktopPersonalDevelopmentHost {
  #connection: DesktopManagedOrchestratorConnection | undefined;
  #controller: AbortController | undefined;
  constructor(readonly options: { readonly versions: DesktopPersonalDevelopmentVersions;
    readonly readAuthKey: (profileId: string) => Promise<string | undefined>;
    readonly readHostKey: (profileId: string) => Promise<string | undefined>;
    readonly isAuthorityCurrent: (connection: DesktopManagedOrchestratorConnection) => boolean | Promise<boolean> }) {}

  setConnection(connection: DesktopManagedOrchestratorConnection | undefined): void {
    if (JSON.stringify(connection) === JSON.stringify(this.#connection)) return;
    this.#controller?.abort(); this.#controller = undefined; this.#connection = connection;
    if (!connection) return;
    const controller = new AbortController(); this.#controller = controller;
    void this.#run(connection, controller.signal).catch(() => undefined);
  }
  close(): void { this.setConnection(undefined); }
  async #client(connection: DesktopManagedOrchestratorConnection, signal: AbortSignal): Promise<HostClient> {
    const identity = await createClient(ConnectionService, createConnectTransport({ baseUrl: connection.origin, httpVersion: "1.1", defaultTimeoutMs: 5_000 }))
      .getServerInfo({}, { signal });
    if (identity.server?.serverId !== connection.serverId || !await this.options.isAuthorityCurrent(connection)) throw new Error("Native host service identity changed.");
    const auth = await this.options.readAuthKey(connection.profileId), host = await this.options.readHostKey(connection.profileId);
    if (!auth || !host || !await this.options.isAuthorityCurrent(connection)) throw new Error("Native host authorization is unavailable.");
    const authorize: Interceptor = next => async request => {
      if (signal.aborted || !await this.options.isAuthorityCurrent(connection)) throw new Error("Native host connection has retired.");
      request.header.set("authorization", `Bearer ${auth}`); request.header.set(DESKTOP_HOST_AUTHORIZATION_HEADER, `Bearer ${host}`);
      return next(request);
    };
    return createClient(DesktopPersonalDevelopmentHostService, createConnectTransport({ baseUrl: connection.origin, httpVersion: "1.1", interceptors: [authorize], defaultTimeoutMs: 20_000 }));
  }
  async #run(connection: DesktopManagedOrchestratorConnection, signal: AbortSignal): Promise<void> {
    let retry = 250;
    while (!signal.aborted) {
      try {
        const client = await this.#client(connection, signal);
        while (!signal.aborted) {
          if (!await this.options.isAuthorityCurrent(connection)) return;
          const snapshot = await this.options.versions.snapshot();
          const registered = await client.registerDesktopDevelopmentHost(snapshot, { signal });
          this.options.versions.acknowledgeRegistration(snapshot.launchTicketId);
          const request = { hostInstanceId: snapshot.hostInstanceId, hostGeneration: registered.hostGeneration };
          const response = await client.pollDesktopDevelopmentCommand(request, { signal });
          if (!await this.options.isAuthorityCurrent(connection)) return;
          const command = response.command; if (!command) continue;
          const complete = (status: string, receipt = "", observedCurrent?: PersonalNativeRuntime) => client.completeDesktopDevelopmentCommand({ ...request,
            commandId: command.commandId, status, receipt, ...(observedCurrent === undefined ? {} : { observedCurrent }) }, { signal });
          try {
            switch (command.kind) {
              case DesktopDevelopmentCommandKind.REVEAL:
                await this.options.versions.reveal(command.path, signal); await complete("revealed"); break;
              case DesktopDevelopmentCommandKind.OPEN_DIRECTORY: {
                const directory = command.directory === PersonalDevelopmentDirectoryKind.SOURCE ? "source" : command.directory === PersonalDevelopmentDirectoryKind.TOOLS ? "tools" : undefined;
                if (directory === undefined) throw new Error("Native directory command is invalid.");
                await this.options.versions.openDirectory(directory, signal); await complete("opened"); break;
              }
              case DesktopDevelopmentCommandKind.HANDOFF: {
                await this.options.versions.prepareHandoff(command.ticketId, nativeRuntime(command.target), signal);
                const accepted = await complete("prepared", command.ticketId);
                if (accepted.accepted && accepted.executeHandoff && !signal.aborted && await this.options.isAuthorityCurrent(connection)) {
                  await this.options.versions.executeHandoff(command.ticketId, signal);
                }
                break;
              }
              case DesktopDevelopmentCommandKind.TEST_START:
                await complete("running", await this.options.versions.startTest({ taskId: command.taskId, sessionId: command.sessionId,
                  completionId: command.completionId, target: nativeRuntime(command.target) }, signal)); break;
              case DesktopDevelopmentCommandKind.TEST_STOP:
                await complete(await this.options.versions.stopTest(command.receipt, signal), command.receipt); break;
              case DesktopDevelopmentCommandKind.TEST_FIND: {
                const result = await this.options.versions.findTest(command.taskId, command.completionId);
                await complete(result.status, result.receipt); break;
              }
              default: await complete("failed");
            }
          } catch {
            if (command.kind === DesktopDevelopmentCommandKind.HANDOFF) await this.options.versions.abandonHandoff(command.ticketId).catch(() => undefined);
            if (!signal.aborted) await complete("unknown").catch(() => undefined);
          }
          retry = 250;
        }
      } catch {
        if (!signal.aborted) await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, retry); timer.unref(); signal.addEventListener("abort", done, { once: true });
        });
        retry = Math.min(retry * 2, 5_000);
      }
    }
  }
}
