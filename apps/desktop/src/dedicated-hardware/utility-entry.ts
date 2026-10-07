import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { ParentPort } from "electron";

import {
  dedicatedHardwareSdkEntryPath,
  reverifyDedicatedHardwareSdkIdentity
} from "../dedicated-hardware-sdk.js";
import type { DedicatedHardwareSdkIdentity } from "./protocol.js";
import { reverifyDedicatedHardwareRuntime } from "../dedicated-hardware-runtime.js";
import { createDedicatedHardwareNativeUsbAdapter } from "./native-usb-adapter.js";
import { createDedicatedHardwareKeymapBackupStore } from "./keymap-backup-store.js";
import {
  createDedicatedHardwareUtilityRequestHandler,
  type DedicatedHardwareUtilityAdapter,
  type DedicatedHardwareUtilityAdapterSink
} from "./utility-handler.js";
import { createDedicatedHardwareVendorAdapter } from "./vendor-adapter.js";

export async function loadDedicatedHardwareStagedAdapter(
  identity: Extract<DedicatedHardwareSdkIdentity, { kind: "staged" }>,
  sink: DedicatedHardwareUtilityAdapterSink
): Promise<DedicatedHardwareUtilityAdapter> {
  const verified = await reverifyDedicatedHardwareSdkIdentity(identity);
  if (verified === undefined) throw new Error("The staged hardware adapter identity could not be reverified.");
  const entryUrl = pathToFileURL(dedicatedHardwareSdkEntryPath(verified));
  entryUrl.searchParams.set("joko-sdk-manifest", verified.manifest.manifestIntegrity);
  const loaded: unknown = await import(entryUrl.href);
  return createDedicatedHardwareVendorAdapter({ sdk: loaded, sink, platform: process.platform });
}

export async function loadDedicatedHardwareAdapter(
  identity: Exclude<DedicatedHardwareSdkIdentity, { kind: "unavailable" }>,
  sink: DedicatedHardwareUtilityAdapterSink
): Promise<DedicatedHardwareUtilityAdapter> {
  if (identity.kind === "staged") return loadDedicatedHardwareStagedAdapter(identity, sink);
  if (!await reverifyDedicatedHardwareRuntime(identity)) throw new Error("The hardware runtime changed before loading.");
  if (identity.kind === "native-usb") {
    return createDedicatedHardwareNativeUsbAdapter({ executablePath: identity.executablePath, sink,
      onFatalError: () => { setImmediate(() => process.exit(1)); } });
  }
  const loaded: unknown = createRequire(import.meta.url)(identity.entryPath);
  return createDedicatedHardwareVendorAdapter({ sdk: loaded, sink, platform: process.platform });
}

export function startDedicatedHardwareUtility(port: ParentPort): void {
  const handler = createDedicatedHardwareUtilityRequestHandler({
    postMessage: (message) => port.postMessage(message),
    loadAdapter: loadDedicatedHardwareAdapter,
    openKeymapBackupStore: async (directory) => createDedicatedHardwareKeymapBackupStore({ directory })
  });
  let exiting = false;
  const exit = (code: number): void => {
    if (exiting) return;
    exiting = true;
    setImmediate(() => process.exit(code));
  };
  port.on("message", (event) => {
    if (exiting) return;
    void handler.handle(event.data).then((result) => {
      if (result === "stopped") exit(0);
      if (result === "terminate") exit(1);
    }).catch(() => exit(1));
  });
}

const utilityPort = (process as NodeJS.Process & { readonly parentPort?: ParentPort | null }).parentPort;
if (utilityPort !== undefined && utilityPort !== null) startDedicatedHardwareUtility(utilityPort);
