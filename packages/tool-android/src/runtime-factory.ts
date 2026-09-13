import {
  AndroidAutomationRuntime,
  type AndroidRuntimeOptions
} from "./runtime.js";

export interface AndroidAutomationRuntimeConfiguration {
  readonly defaultDeviceSerial?: string | null;
  readonly adbPathOverride?: string | null;
}

export type AndroidAutomationRuntimeFactoryOptions = Omit<
  AndroidRuntimeOptions,
  "adapter" | "defaultDeviceSerial" | "executablePath" | "pathSource"
>;

export class AndroidAutomationRuntimeFactory {
  readonly #options: AndroidAutomationRuntimeFactoryOptions;

  constructor(options: AndroidAutomationRuntimeFactoryOptions = {}) {
    this.#options = { ...options };
  }

  create(configuration: AndroidAutomationRuntimeConfiguration = {}): AndroidAutomationRuntime {
    const defaultDeviceSerial = normalizedSetting(configuration.defaultDeviceSerial);
    const adbPathOverride = normalizedSetting(configuration.adbPathOverride);
    return new AndroidAutomationRuntime({
      ...this.#options,
      ...(defaultDeviceSerial === undefined ? {} : { defaultDeviceSerial }),
      ...(adbPathOverride === undefined ? {} : {
        executablePath: adbPathOverride,
        pathSource: "custom" as const
      })
    });
  }

  async reconfigure(
    current: AndroidAutomationRuntime,
    configuration: AndroidAutomationRuntimeConfiguration,
    signal?: AbortSignal
  ): Promise<AndroidAutomationRuntime> {
    signal?.throwIfAborted();
    const replacement = this.create(configuration);
    try {
      await current.dispose();
    } catch (error) {
      await replacement.dispose().catch(() => undefined);
      throw error;
    }
    return replacement;
  }
}

function normalizedSetting(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}
