import { join } from "node:path";
import { createPiAutoReviewer } from "./auto-review.js";
import { atomicWriteFile } from "./config.js";

export const MANAGED_AUTO_REVIEW_FILE_NAME = "joko-managed-auto-review.mjs";

/**
 * Self-contained ESM provisioned beside the managed Pi bridge. The serialized
 * factory is closure-free and therefore needs neither the Joko workspace nor
 * runtime package resolution.
 */
export const MANAGED_AUTO_REVIEW_RUNTIME_SOURCE = [
  "/*",
  " * Auto-review policy with Apache-2.0 licensed portions.",
  " * Copyright 2026 XD Inc.",
  " * SPDX-License-Identifier: Apache-2.0",
  " */",
  `export const createPiAutoReviewer = ${createPiAutoReviewer.toString()};`,
  "",
].join("\n");

export async function provisionManagedAutoReviewRuntime(agentHome: string): Promise<string> {
  const path = join(agentHome, "managed", MANAGED_AUTO_REVIEW_FILE_NAME);
  await atomicWriteFile(path, MANAGED_AUTO_REVIEW_RUNTIME_SOURCE);
  return path;
}
