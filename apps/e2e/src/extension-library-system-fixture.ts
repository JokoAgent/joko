import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import {
  ExtensionPackageAction,
  OperationMutationSchema,
  OperationState,
  type ExtensionCatalogEntry
} from "@joko/contracts";
import {
  createOrchestratorApplication,
  createPublicServer,
  type OrchestratorApplication,
  type OrchestratorConfig
} from "@joko/orchestrator";

import {
  createE2eClients,
  type E2eClients,
  type PairedClient
} from "./connect-clients.js";
import { submit } from "./operations.js";

export const LIBRARY_PACKAGE_NAME = "@joko-e2e/library-surface";
export const LIBRARY_EXTENSION_LABEL = "Library Surface";

export interface ExtensionLibrarySystemFixtureOptions {
  readonly rootDirectory?: string;
  readonly webDirectory?: string;
  readonly keepRoot?: boolean;
}

/**
 * Production Store/Host/Connect composition for Extension Library product-chain
 * evidence. No fake manager or direct service handler participates in this fixture.
 */
export class ExtensionLibrarySystemFixture {
  readonly rootDirectory: string;
  readonly workspaceDirectory: string;
  readonly catalogDirectory: string;
  readonly baseUrl: string;
  readonly application: OrchestratorApplication;
  readonly anonymous: E2eClients;
  readonly #publicServer: Awaited<ReturnType<typeof createPublicServer>>;
  readonly #pairingCodes: ReadonlyMap<string, string>;
  readonly #removePairingListener: () => void;
  readonly #removeRootOnClose: boolean;
  #closed = false;

  private constructor(input: {
    readonly rootDirectory: string;
    readonly workspaceDirectory: string;
    readonly catalogDirectory: string;
    readonly baseUrl: string;
    readonly application: OrchestratorApplication;
    readonly publicServer: Awaited<ReturnType<typeof createPublicServer>>;
    readonly pairingCodes: ReadonlyMap<string, string>;
    readonly removePairingListener: () => void;
    readonly removeRootOnClose: boolean;
  }) {
    this.rootDirectory = input.rootDirectory;
    this.workspaceDirectory = input.workspaceDirectory;
    this.catalogDirectory = input.catalogDirectory;
    this.baseUrl = input.baseUrl;
    this.application = input.application;
    this.#publicServer = input.publicServer;
    this.#pairingCodes = input.pairingCodes;
    this.#removePairingListener = input.removePairingListener;
    this.#removeRootOnClose = input.removeRootOnClose;
    this.anonymous = createE2eClients(input.baseUrl, undefined, 60_000);
  }

  static async start(options: ExtensionLibrarySystemFixtureOptions = {}): Promise<ExtensionLibrarySystemFixture> {
    const ownsRoot = options.rootDirectory === undefined;
    const requestedRoot = options.rootDirectory ?? await mkdtemp(join(tmpdir(), "joko-extension-library-system-e2e-"));
    const rootDirectory = process.env.GITHUB_ACTIONS === "true" ? await realpath(requestedRoot) : requestedRoot;
    const workspaceDirectory = join(rootDirectory, "workspace");
    const dataDirectory = join(rootDirectory, "data");
    const catalogDirectory = join(rootDirectory, "catalog");
    let application: OrchestratorApplication | undefined;
    let publicServer: Awaited<ReturnType<typeof createPublicServer>> | undefined;
    let removePairingListener: (() => void) | undefined;
    try {
      await Promise.all([
        mkdir(workspaceDirectory, { recursive: true }),
        mkdir(dataDirectory, { recursive: true })
      ]);
      await writeFile(join(workspaceDirectory, "README.md"), "# Extension Library system E2E\n", { flag: "a" });
      await writeLibraryPackageCatalog(catalogDirectory);
      const config: OrchestratorConfig = {
        host: "127.0.0.1",
        port: 0,
        internalPort: 4317,
        publicOrigin: "http://127.0.0.1",
        internalOrigin: "http://127.0.0.1:4317",
        dataDirectory,
        databasePath: join(dataDirectory, "orchestrator.db"),
        allowInsecureLoopback: true,
        allowInsecureLan: false,
        lanDiscoveryEnabled: false,
        piAgentHome: join(dataDirectory, "pi-agent-home"),
        workspace: {
          id: "workspace-extension-library-e2e",
          root: workspaceDirectory,
          displayName: "Extension Library system E2E",
          trusted: true
        },
        artifactDirectory: join(dataDirectory, "artifacts"),
        webDirectory: options.webDirectory ?? join(rootDirectory, "web-not-used-by-connect-e2e"),
        corsOrigins: []
      };
      application = await createOrchestratorApplication(config);
      const pairingCodes = new Map<string, string>();
      removePairingListener = application.connections.onPairingIssued((challenge) => {
        pairingCodes.set(challenge.id, challenge.code);
      });
      application.connections.openPairingWindow();
      publicServer = await createPublicServer(application);
      publicServer.log.level = "silent";
      await publicServer.listen({ host: "127.0.0.1", port: 0 });
      const address = publicServer.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Orchestrator did not expose an ephemeral TCP port.");
      }
      return new ExtensionLibrarySystemFixture({
        rootDirectory,
        workspaceDirectory,
        catalogDirectory,
        baseUrl: `http://127.0.0.1:${address.port}`,
        application,
        publicServer,
        pairingCodes,
        removePairingListener,
        removeRootOnClose: ownsRoot && options.keepRoot !== true
      });
    } catch (error) {
      removePairingListener?.();
      await publicServer?.close().catch(() => undefined);
      await application?.close().catch(() => undefined);
      if (ownsRoot) await rm(rootDirectory, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      throw error;
    }
  }

  clients(authKey: string): E2eClients {
    return createE2eClients(this.baseUrl, authKey, 60_000);
  }

  async pair(displayName = "Extension Library system E2E"): Promise<PairedClient> {
    const begun = await this.anonymous.connection.beginPairing({ deviceDisplayName: displayName });
    const challenge = begun.challenge;
    if (challenge === undefined) throw new Error("Orchestrator returned no pairing challenge.");
    const code = this.#pairingCodes.get(challenge.challengeId);
    if (code === undefined) throw new Error("The trusted pairing observer did not receive the out-of-band code.");
    const completed = await this.anonymous.connection.completePairing({
      challengeId: challenge.challengeId,
      humanCode: code,
      deviceDisplayName: displayName
    });
    const authKey = completed.result?.authKey;
    const connectionId = completed.result?.connection?.connectionId;
    const deviceId = completed.result?.device?.deviceId;
    if (!authKey || !connectionId || !deviceId) throw new Error("Orchestrator returned no paired Connection authority.");
    return { authKey, connectionId, deviceId, clients: this.clients(authKey) };
  }

  pairingCode(challengeId: string): string {
    const code = this.#pairingCodes.get(challengeId);
    if (code === undefined) throw new Error(`The fixture did not observe pairing challenge ${challengeId}.`);
    return code;
  }

  async close(options: { readonly removeRoot?: boolean } = {}): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#removePairingListener();
    await this.#publicServer.close();
    await this.application.close();
    if (options.removeRoot ?? this.#removeRootOnClose) {
      await rm(this.rootDirectory, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

export async function installLibraryExtension(
  fixture: ExtensionLibrarySystemFixture,
  paired: PairedClient
): Promise<ExtensionCatalogEntry> {
  const sourceCatalog = await paired.clients.extension.listExtensionSources({ page: { pageSize: 100 } });
  const catalogRevision = sourceCatalog.catalogRevision?.value;
  if (catalogRevision === undefined) throw new Error("Extension source catalog returned no revision.");
  const added = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
    payload: {
      case: "addExtensionSource",
      value: {
        source: { kind: { case: "local", value: { path: fixture.catalogDirectory } } },
        expectedCatalogRevision: { value: catalogRevision }
      }
    }
  }), randomUUID());
  requireSucceeded(added.state, "add the local Extension source");

  const availableCatalog = await paired.clients.extension.listExtensions({
    query: LIBRARY_EXTENSION_LABEL,
    page: { pageSize: 100 }
  });
  const available = availableCatalog.extensions.find((entry) =>
    entry.owner?.kind.case === "source" && entry.library !== undefined && entry.mainView !== undefined);
  const availableRevision = available?.revision?.value;
  if (available === undefined || availableRevision === undefined) {
    throw new Error("The local source did not publish the Library Extension.");
  }
  const previewResponse = await paired.clients.extension.getExtensionPackagePreview({
    extensionId: available.extensionId,
    expectedRevision: { value: availableRevision },
    backendId: "pi"
  });
  const preview = previewResponse.preview;
  const previewRevision = preview?.extensionRevision?.value;
  if (preview === undefined || previewRevision === undefined || preview.action !== ExtensionPackageAction.INSTALL) {
    throw new Error("The Library Extension did not produce an install preview.");
  }
  const adopted = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
    payload: {
      case: "adoptExtensionPackage",
      value: {
        extensionId: preview.extensionId,
        expectedRevision: { value: previewRevision },
        backendId: preview.backendId,
        expectedAction: preview.action,
        expectedCurrentResourceId: "",
        allowSourceReplacement: false
      }
    }
  }), randomUUID());
  requireSucceeded(adopted.state, "install the Library Extension package");
  let installed = requireInstalledLibraryExtension(await paired.clients.extension.listExtensions({
    page: { pageSize: 100 }
  }));
  if (!installed.enabled) {
    const installedRevision = installed.revision?.value;
    if (installedRevision === undefined) throw new Error("The installed Library Extension returned no revision.");
    const enabled = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: {
        case: "setExtensionEnabled",
        value: {
          extensionId: installed.extensionId,
          enabled: true,
          expectedRevision: { value: installedRevision }
        }
      }
    }), randomUUID());
    requireSucceeded(enabled.state, "enable the Library Extension");
    const response = await paired.clients.extension.getExtension({ extensionId: installed.extensionId });
    if (response.extension === undefined) throw new Error("The enabled Library Extension disappeared from the catalog.");
    installed = response.extension;
  }
  if (!installed.enabled) throw new Error("The installed Library Extension did not become enabled.");
  return installed;
}

export function requireInstalledLibraryExtension(catalog: {
  readonly extensions: readonly ExtensionCatalogEntry[];
}): ExtensionCatalogEntry {
  const installed = catalog.extensions.find((entry) => entry.owner?.kind.case === "resource"
    && entry.installed && entry.library !== undefined && entry.mainView !== undefined);
  if (installed === undefined || installed.revision === undefined) {
    const summary = catalog.extensions.map((entry) => ({
      id: entry.extensionId,
      name: entry.name,
      owner: entry.owner?.kind.case,
      installed: entry.installed,
      enabled: entry.enabled,
      library: entry.library !== undefined,
      mainView: entry.mainView !== undefined,
      installState: entry.installState,
      error: entry.error
    }));
    throw new Error(`The production catalog did not expose the installed Library Extension: ${JSON.stringify(summary)}`);
  }
  return installed;
}

async function writeLibraryPackageCatalog(catalogDirectory: string): Promise<void> {
  const packageDirectory = join(catalogDirectory, "packages", "library-surface");
  const viewDirectory = join(packageDirectory, "view");
  await Promise.all([
    mkdir(join(catalogDirectory, ".agents", "plugins"), { recursive: true }),
    mkdir(join(packageDirectory, "extensions"), { recursive: true }),
    mkdir(viewDirectory, { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(catalogDirectory, ".agents", "plugins", "marketplace.json"), JSON.stringify({
      name: "joko-e2e-library",
      displayName: "Joko E2E Library catalog",
      plugins: [{ name: LIBRARY_EXTENSION_LABEL, source: "packages/library-surface" }]
    }), "utf8"),
    writeFile(join(packageDirectory, "package.json"), JSON.stringify({
      name: LIBRARY_PACKAGE_NAME,
      version: "1.0.0",
      author: "Joko E2E",
      description: "Production Extension Library and main-view bridge fixture",
      pi: { extensions: ["extensions/index.js"] },
      joko: {
        extensionSurfaces: {
          schemaVersion: 1,
          extensions: [{
            entry: "extensions/index.js",
            mainView: { html: "view/index.html", title: "Library chain", icon: "layout" },
            library: { schemaVersion: 1 }
          }]
        }
      }
    }), "utf8"),
    writeFile(join(packageDirectory, "extensions", "index.js"), "export default function setup() {}\n", "utf8"),
    writeFile(join(viewDirectory, "index.html"), [
      "<!doctype html>",
      "<html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
      "<title>Library chain</title><link rel=\"stylesheet\" href=\"style.css\"><script defer src=\"app.js\"></script></head>",
      "<body><main><h1>Extension Library bridge</h1><output id=\"bridge-result\">starting</output></main></body></html>"
    ].join("\n"), "utf8"),
    writeFile(join(viewDirectory, "style.css"), [
      ":root { color-scheme: light dark; font-family: system-ui, sans-serif; }",
      "* { box-sizing: border-box; }",
      "body { margin: 0; min-width: 0; background: Canvas; color: CanvasText; }",
      "main { width: 100%; min-width: 0; padding: 24px; overflow-wrap: anywhere; }",
      "h1 { margin: 0 0 12px; font-size: clamp(18px, 4vw, 28px); }",
      "output { display: block; border: 1px solid GrayText; border-radius: 10px; padding: 12px; }"
    ].join("\n"), "utf8"),
    writeFile(join(viewDirectory, "app.js"), MAIN_VIEW_SCRIPT, "utf8")
  ]);
}

const MAIN_VIEW_SCRIPT = `
const output = document.querySelector("#bridge-result");
const call = async (operation) => {
  const response = await window.joko.library(operation);
  if (response.ok !== true) throw new Error(response.errorCode + ":" + response.message);
  return response;
};
const run = async () => {
  const capabilities = await call({ kind: "capabilities" });
  if (!capabilities.operations.includes("sqlMigrate")) throw new Error("missing-sql-capability");
  const opened = await call({ kind: "open" });
  await call({ kind: "write", path: "bridge/result.txt", content: new TextEncoder().encode("mounted-bridge"), ifNotExists: false });
  const read = await call({ kind: "read", path: "bridge/result.txt" });
  const database = await call({ kind: "sqlOpen", path: "bridge.sqlite", create: true, readOnly: false });
  await call({ kind: "sqlMigrate", handleId: database.handleId, migrations: [{ version: 1, statements: ["CREATE TABLE checks(id INTEGER PRIMARY KEY, value TEXT NOT NULL)"] }] });
  await call({ kind: "sqlExecute", handleId: database.handleId, statement: { sql: "INSERT OR REPLACE INTO checks(id, value) VALUES(1, ?)", parameters: [{ kind: "text", value: "chromium" }] } });
  const selected = await call({ kind: "sqlExecute", handleId: database.handleId, statement: { sql: "SELECT value FROM checks WHERE id = 1" } });
  await call({ kind: "sqlClose", handleId: database.handleId });
  const text = new TextDecoder().decode(read.content);
  const cell = selected.value.rows[0].cells[0].value.value;
  output.textContent = "bridge-ready:" + text + ":" + cell + ":" + opened.extensionId;
  document.documentElement.dataset.bridgeReady = "true";
};
setTimeout(() => { run().catch((error) => {
  output.textContent = "bridge-error:" + String(error && error.message || error);
  document.documentElement.dataset.bridgeError = "true";
}); }, 100);
`;

function requireSucceeded(state: OperationState, action: string): void {
  if (state !== OperationState.SUCCEEDED) throw new Error(`Production Connect operation failed to ${action}.`);
}
