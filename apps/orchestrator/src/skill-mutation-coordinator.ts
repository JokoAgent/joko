import { randomUUID } from "node:crypto";

export interface SkillMutationLease {
  readonly id: string;
  readonly keys: readonly string[];
  readonly assertActive: () => void;
  readonly release: () => void;
}

/**
 * Process-local fail-fast ownership shared by every Skill content writer.
 * Resource/Target revisions and durable filesystem journals remain the final
 * authority; this coordinator prevents two valid preparations from racing the
 * same install slot before either one reaches that boundary.
 */
export class SkillMutationCoordinator {
  readonly #holders = new Map<string, { readonly id: string; readonly token: symbol }>();

  acquire(keys: readonly string[]): SkillMutationLease | undefined {
    const normalized = skillMutationKeys(keys);
    if (normalized.length === 0) throw new Error("Skill mutation requires at least one ownership key.");
    if (normalized.some((key) => this.#holders.has(key))) return undefined;

    const id = `skill_mutation_${randomUUID().replaceAll("-", "")}`;
    const token = Symbol(id);
    for (const key of normalized) this.#holders.set(key, { id, token });
    let active = true;
    return Object.freeze({
      id,
      keys: normalized,
      assertActive: () => {
        if (!active || normalized.some((key) => this.#holders.get(key)?.token !== token)) {
          throw new Error("Skill mutation lease is no longer active.");
        }
      },
      release: () => {
        if (!active) return;
        active = false;
        for (const key of normalized) {
          if (this.#holders.get(key)?.token === token) this.#holders.delete(key);
        }
      }
    });
  }
}

export function skillMutationKeys(keys: readonly string[]): readonly string[] {
  return [...new Set(keys.map((key) => {
    const value = key.trim().toLocaleLowerCase("en-US");
    if (value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error("Skill mutation ownership key is invalid.");
    }
    return value;
  }))].sort((left, right) => left.localeCompare(right, "en"));
}

export function skillResourceMutationKey(resourceId: string): string {
  return `resource:${resourceId}`;
}

export function skillInstallSlotMutationKey(input: {
  readonly backendId: string;
  readonly targetId?: string;
  readonly scope: "global" | "project";
  readonly parentKey?: string;
  readonly name: string;
}): string {
  const owner = input.scope === "global" ? "global" : `project:${input.targetId ?? ""}`;
  return `slot:${input.backendId}:${owner}:${input.parentKey ?? ""}:${input.name}`;
}
