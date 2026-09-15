import { join } from "node:path";
import { atomicWriteFile } from "./config.js";
import { managedRuntimeFactorySource } from "./managed-runtime-factory-source.js";
import { createPiModelCatalogAdditionsFactory } from "./model-catalog-additions.js";

export const MANAGED_MODEL_CATALOG_RUNTIME_SOURCE = managedRuntimeFactorySource(
  "createPiModelCatalogAdditions",
  createPiModelCatalogAdditionsFactory
);

export async function provisionManagedModelCatalogRuntime(agentHome: string): Promise<void> {
  await atomicWriteFile(join(agentHome, "managed", "joko-managed-model-catalog.mjs"), MANAGED_MODEL_CATALOG_RUNTIME_SOURCE);
}
