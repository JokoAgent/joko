import { join } from "node:path";
import { atomicWriteFile } from "./config.js";
import { createPiHostedExecutor } from "./hosted-executor.js";
import { managedRuntimeFactorySource } from "./managed-runtime-factory-source.js";

export const MANAGED_HOSTED_EXECUTOR_RUNTIME_SOURCE = managedRuntimeFactorySource("createPiHostedExecutor", createPiHostedExecutor);

export async function provisionHostedExecutorRuntime(agentHome: string): Promise<void> {
  await atomicWriteFile(join(agentHome, "managed", "joko-managed-hosted-executor.mjs"), MANAGED_HOSTED_EXECUTOR_RUNTIME_SOURCE);
}
