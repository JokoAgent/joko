import {
  AndroidAutomationRuntimeFactory,
  AndroidToolProvider,
  type AndroidAutomationRuntime,
  type AndroidAutomationRuntimeConfiguration,
  type AndroidRuntimeStatus
} from "@joko/tool-android";

import type {
  AndroidAutomationConfiguration,
  AndroidAutomationIssueKind,
  AndroidAutomationProbe,
  AndroidAutomationRuntimeController
} from "./android-automation-settings.js";

/** Safely swaps the concrete runtime while keeping one stable bridge facade. */
export class AndroidRuntimeSupervisor implements AndroidAutomationRuntimeController {
  readonly #factory: AndroidAutomationRuntimeFactory;
  #runtime: AndroidAutomationRuntime;
  #provider: AndroidToolProvider;
  #configurationKey: string;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(input: {
    readonly factory: AndroidAutomationRuntimeFactory;
    readonly initialConfiguration?: AndroidAutomationConfiguration;
  }) {
    this.#factory = input.factory;
    const configuration = runtimeConfiguration(input.initialConfiguration ?? {});
    this.#runtime = this.#factory.create(configuration);
    this.#provider = new AndroidToolProvider({ runtime: this.#runtime });
    this.#configurationKey = configurationKey(configuration);
  }

  provider(): AndroidToolProvider {
    this.#assertOpen();
    return this.#provider;
  }

  applyConfiguration(configuration: AndroidAutomationConfiguration, signal?: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertOpen();
      const next = runtimeConfiguration(configuration);
      const key = configurationKey(next);
      if (key === this.#configurationKey) return;
      const replacement = await this.#factory.reconfigure(this.#runtime, next, signal);
      this.#runtime = replacement;
      this.#provider = new AndroidToolProvider({ runtime: replacement });
      this.#configurationKey = key;
    });
  }

  prepare(signal?: AbortSignal): Promise<void> {
    return this.#enqueue(async () => {
      this.#assertOpen();
      await this.#runtime.prepare(signal);
    });
  }

  status(options?: {
    readonly fresh?: boolean;
    readonly allowPreparation?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<AndroidAutomationProbe> {
    return this.#enqueue(async () => {
      this.#assertOpen();
      return mapRuntimeStatus(await this.#runtime.probe({
        fresh: options?.fresh === true,
        allowPreparation: options?.allowPreparation !== false,
        signal: options?.signal
      }));
    });
  }

  closeSession(sessionId: string): void {
    if (this.#closed) return;
    this.#runtime.closeSession(sessionId);
  }

  async dispose(signal?: AbortSignal): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail.catch(() => undefined);
    await this.#runtime.dispose(signal);
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.#tail.then(work, work);
    this.#tail = task.then(() => undefined, () => undefined);
    return task;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Android runtime supervisor is closed.");
  }
}

function mapRuntimeStatus(status: AndroidRuntimeStatus): AndroidAutomationProbe {
  const preparation = status.installation.preparation;
  return {
    support: status.supported ? "supported" : "platformLimited",
    supportReason: status.supported ? "" : "Android automation is unavailable on this platform.",
    adbAvailable: status.installation.state === "installed",
    adbPath: status.installation.executablePath,
    adbPathSource: status.installation.pathSource,
    preparationSupported: preparation?.supported ?? false,
    preparationReady: preparation?.ready ?? false,
    preparationError: preparation?.error,
    adbVersion: status.installation.version,
    devices: status.devices.map((device) => ({
      deviceSerial: device.serial,
      state: device.state,
      product: device.product,
      model: device.model,
      device: device.device,
      transportId: device.transportId,
      usb: device.usb
    })),
    defaultDeviceSerial: status.selectedDeviceSerial,
    issue: mapIssue(status.issue),
    failureReason: status.error,
    platform: status.platform
  };
}

function mapIssue(issue: AndroidRuntimeStatus["issue"]): AndroidAutomationIssueKind {
  switch (issue) {
    case "adb_not_found": return "adbNotFound";
    case "device_offline": return "deviceOffline";
    case "device_unauthorized": return "deviceUnauthorized";
    case "multiple_devices": return "multipleDevices";
    case "no_device": return "noDevice";
    case "unsupported_platform": return "driverError";
    case undefined: return "unspecified";
  }
}

function runtimeConfiguration(
  value: AndroidAutomationConfiguration
): AndroidAutomationRuntimeConfiguration {
  return {
    ...(value.defaultDeviceSerial === undefined ? {} : { defaultDeviceSerial: value.defaultDeviceSerial }),
    ...(value.adbPathOverride === undefined ? {} : { adbPathOverride: value.adbPathOverride })
  };
}

function configurationKey(value: AndroidAutomationRuntimeConfiguration): string {
  return JSON.stringify([value.defaultDeviceSerial ?? null, value.adbPathOverride ?? null]);
}
