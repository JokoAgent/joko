import { fileURLToPath } from "node:url";
import type { ApprovedSkillSeed } from "@joko/core";

export const PLUGIN_CREATOR_SKILL_ID = "plugin_creator" as const;
export const PLUGIN_CREATOR_SKILL_NAME = "joko-plugin-creator";
const shippedRoot = fileURLToPath(new URL("./system-skills/joko-plugin-creator", import.meta.url));
export interface BuiltinSkillInspection { readonly canonicalPath: string; readonly revision: string }

/** Only this service-owned package tree can attest a built-in native Skill. */
export class BuiltinSkillCatalog {
  private constructor(private readonly root: string, private readonly revision: string,
    private readonly inspect: (path: string, maximumFiles: number, maximumBytes: number, signal?: AbortSignal) => Promise<BuiltinSkillInspection>) {}

  static async load(inspect: BuiltinSkillCatalog["inspect"]): Promise<BuiltinSkillCatalog> {
    const source = await inspect(shippedRoot, 256, 2 * 1024 * 1024);
    return new BuiltinSkillCatalog(source.canonicalPath, source.revision, inspect);
  }

  async snapshot(assertOwner: () => void, signal: AbortSignal): Promise<readonly ApprovedSkillSeed[]> {
    signal.throwIfAborted(); assertOwner();
    const source = await this.inspect(this.root, 256, 2 * 1024 * 1024, signal);
    if (source.canonicalPath !== this.root || source.revision !== this.revision) throw new Error("The shipped Skill bundle changed. Restart this service before using it.");
    const assertCurrent = () => { assertOwner(); };
    assertCurrent();
    return [Object.freeze({ sourcePath: this.root, assertCurrent, resource: Object.freeze({
      id: `builtin:${PLUGIN_CREATOR_SKILL_ID}:${this.revision.slice(7)}`, kind: "skill" as const, name: PLUGIN_CREATOR_SKILL_NAME,
      source: "builtin", state: "approved" as const, revision: this.revision, resourceVersion: 1n,
      trustedBuiltin: Object.freeze({ id: PLUGIN_CREATOR_SKILL_ID, revision: this.revision })
    }) })];
  }
}
