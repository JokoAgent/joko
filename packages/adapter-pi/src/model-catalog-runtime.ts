import { join } from "node:path";
import { atomicWriteFile } from "./config.js";
import { createPiModelCatalogAdditionsFactory } from "./model-catalog-additions.js";

export const MANAGED_MODEL_CATALOG_RUNTIME_SOURCE = `export const createPiModelCatalogAdditions = ${createPiModelCatalogAdditionsFactory.toString()};\n`;

export async function provisionManagedModelCatalogRuntime(agentHome: string): Promise<void> {
  await atomicWriteFile(join(agentHome, "managed", "joko-managed-model-catalog.mjs"), MANAGED_MODEL_CATALOG_RUNTIME_SOURCE);
}
