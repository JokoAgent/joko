import { fileURLToPath } from "node:url";
import type { ApprovedSkillSeed, RuntimeCommand } from "@joko/core";

export const PLUGIN_CREATOR_SKILL_ID = "plugin_creator" as const;
export const PLUGIN_CREATOR_SKILL_NAME = "joko-plugin-creator";
const shippedSkills = [
  { id: PLUGIN_CREATOR_SKILL_ID, name: PLUGIN_CREATOR_SKILL_NAME },
  { id: "skill_creator", name: "joko-skill-creator" }
] as const;
export interface BuiltinSkillInspection { readonly canonicalPath: string; readonly revision: string }
type Bundle = (typeof shippedSkills)[number] & { readonly inspection: BuiltinSkillInspection };

export function builtinSkillResourceId({ id, revision }: NonNullable<RuntimeCommand["builtinSkill"]>): string {
  return `builtin:${id}:${revision.slice(7)}`;
}

/** Only this service-owned package tree can attest a built-in native Skill. */
export class BuiltinSkillCatalog {
  private constructor(private readonly bundles: readonly Bundle[],
    private readonly inspect: (path: string, maximumFiles: number, maximumBytes: number, signal?: AbortSignal) => Promise<BuiltinSkillInspection>) {}

  static async load(inspect: BuiltinSkillCatalog["inspect"]): Promise<BuiltinSkillCatalog> {
    const bundles = await Promise.all(shippedSkills.map(async skill => ({ ...skill,
      inspection: await inspect(fileURLToPath(new URL(`./system-skills/${skill.name}`, import.meta.url)), 256, 2 * 1024 * 1024)
    })));
    return new BuiltinSkillCatalog(bundles, inspect);
  }

  async snapshot(assertOwner: () => void, signal: AbortSignal, includeSkillCreator: boolean): Promise<readonly ApprovedSkillSeed[]> {
    signal.throwIfAborted();
    assertOwner();
    const selected = this.bundles.filter(bundle => bundle.id !== "skill_creator" || includeSkillCreator);
    return Promise.all(selected.map(async ({ id, name, inspection }) => {
      const { canonicalPath, revision } = inspection;
      const source = await this.inspect(canonicalPath, 256, 2 * 1024 * 1024, signal);
      if (source.canonicalPath !== canonicalPath || source.revision !== revision) throw new Error("The shipped Skill bundle changed. Restart this service before using it.");
      signal.throwIfAborted();
      assertOwner();
      const identity = Object.freeze({ id, revision });
      return Object.freeze({ sourcePath: canonicalPath, assertCurrent: assertOwner, resource: Object.freeze({
        id: builtinSkillResourceId(identity), kind: "skill" as const, name,
        source: "builtin", state: "approved" as const, revision, resourceVersion: 1n,
        trustedBuiltin: identity
      }) });
    }));
  }
}
