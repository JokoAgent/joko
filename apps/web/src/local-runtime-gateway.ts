import { createClient, type Transport } from "@connectrpc/connect";
import { BackendService, LocalBackendRuntimeState, type LocalBackendRuntime } from "@joko/contracts";
import type { LocalBackendRuntimeView } from "./model.js";

const STATES = new Map<LocalBackendRuntimeState, LocalBackendRuntimeView["state"]>([
  [LocalBackendRuntimeState.NOT_SUPPORTED, "not_supported"], [LocalBackendRuntimeState.NOT_INSTALLED, "not_installed"],
  [LocalBackendRuntimeState.READY, "ready"], [LocalBackendRuntimeState.DOWNLOADING, "downloading"],
  [LocalBackendRuntimeState.EXTRACTING, "extracting"], [LocalBackendRuntimeState.VALIDATING, "validating"],
  [LocalBackendRuntimeState.ACTIVATING, "activating"], [LocalBackendRuntimeState.COMPLETE, "complete"],
  [LocalBackendRuntimeState.FAILED, "failed"], [LocalBackendRuntimeState.CANCELLED, "cancelled"]
]);

function mapRuntime(value: LocalBackendRuntime | undefined, backendId: string): LocalBackendRuntimeView {
  if (value === undefined || value.backendId !== backendId || !STATES.has(value.state)) throw new Error("The service returned an invalid local runtime state.");
  const number = (value: bigint) => {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) throw new Error("The local runtime value is out of range.");
    return result;
  };
  return { backendId, state: STATES.get(value.state)!, instanceGeneration: number(value.instanceGeneration), platform: value.platform,
    expectedVersion: value.expectedVersion, ...(value.installedVersion === undefined ? {} : { installedVersion: value.installedVersion }),
    canInstall: value.canInstall, canRepair: value.canRepair, manualOverride: value.manualOverride,
    receivedBytes: number(value.receivedBytes), totalBytes: number(value.totalBytes),
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }), ...(value.failureCode === undefined ? {} : { failureCode: value.failureCode }) };
}

export function localRuntimeGateway(transport: Transport, refresh: () => Promise<void>) {
  const client = createClient(BackendService, transport);
  return {
    async probe(backendId: string, signal?: AbortSignal): Promise<LocalBackendRuntimeView> {
      return mapRuntime((await client.probeLocalRuntime({ backendId }, signal === undefined ? {} : { signal })).runtime, backendId);
    },
    async *install(backendId: string, requestId: string, expectedGeneration: number, repair: boolean, signal?: AbortSignal): AsyncGenerator<LocalBackendRuntimeView> {
      let sequence = 0n;
      for await (const event of client.installLocalRuntime({ backendId, requestId, expectedInstanceGeneration: BigInt(expectedGeneration), repair }, signal === undefined ? {} : { signal })) {
        if (event.sequence <= sequence) continue;
        sequence = event.sequence;
        const runtime = mapRuntime(event.runtime, backendId);
        if (runtime.state === "complete") await refresh();
        yield runtime;
      }
    },
    async cancel(backendId: string, requestId: string): Promise<boolean> {
      return (await client.cancelLocalRuntimeInstall({ backendId, requestId })).cancelled;
    }
  };
}
