import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import {
  ClaudeFreshContextOwner, ClaudeFreshContextOwnerError,
  type ClaudeFreshContextIdentity
} from "./fresh-context-owner.js";

const roots: string[] = [];
const retirement = { retirementConfirmed: true } as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ClaudeFreshContextOwner", () => {
  it("persists an exact unused child and claims its trusted Host binding after complete retirement", async () => {
    const { identity, owner, createOwner } = await fixture();
    const reserved = owner.reserve(identity);
    expect(reserved).toMatchObject({ backendGeneration: 1, lifecycle: "reserved", dispatch: "never_dispatched", sourceRetired: false });
    expect(Object.isFrozen(reserved)).toBe(true);
    expect(Object.isFrozen(reserved.binding)).toBe(true);
    expect(owner.reserve(identity)).toEqual(reserved);
    expect(owner.getForOperation(identity.operationId)).toEqual(reserved);
    expect(owner.hasPendingSource(identity)).toBe(true);
    owner.markSourceRetired(identity);
    expect(owner.hasPendingSource(identity)).toBe(false);
    const adopted = owner.adopt(identity, retirement);
    expect(adopted).toMatchObject({ lifecycle: "adopted", sourceRetired: true });

    const nextOwner = createOwner(4);
    const hostBinding = { ...identity, binding: { ...identity.binding, generation: 5 } };
    expect(nextOwner.getForBinding(hostBinding)).toEqual(adopted);
    expect(() => nextOwner.claim(hostBinding, { retirementConfirmed: false } as unknown as typeof retirement))
      .toThrowError(expect.objectContaining({ code: "INVALID_ACCESS" }));
    const claimed = nextOwner.claim(hostBinding, retirement);
    expect(claimed).toMatchObject({ backendGeneration: 4, binding: { generation: 5 }, dispatch: "never_dispatched" });
    expect(nextOwner.getForBinding(hostBinding)).toEqual(claimed);
    expect(() => owner.markDispatching(adopted)).toThrowError(expect.objectContaining({ code: "INVALID_ACCESS" }));
    expect(() => nextOwner.getForBinding(identity)).toThrowError(expect.objectContaining({ code: "INVALID_ACCESS" }));
  });

  it("commits the first dispatch before returning and never resets it on recovery or cleanup", async () => {
    const { identity, owner, createOwner } = await fixture();
    owner.reserve(identity);
    const adopted = owner.adopt(identity, retirement);
    const dispatched = owner.markDispatching(adopted);
    expect(dispatched.dispatch).toBe("dispatching");
    expect(owner.markDispatching(adopted)).toEqual(dispatched);
    const nextOwner = createOwner(2);
    const hostBinding = { ...identity, binding: { ...identity.binding, generation: 3 } };
    const claimed = nextOwner.claim(hostBinding, retirement);
    expect(claimed.dispatch).toBe("dispatching");
    expect(nextOwner.cleanup(claimed, retirement)).toEqual(claimed);
    expect(createOwner(2).getForBinding(hostBinding)?.dispatch).toBe("dispatching");
  });

  it("rejects mismatched operation, source, product, Target, workspace and native binding authorities", async () => {
    const { identity, owner } = await fixture();
    owner.reserve(identity);
    const wrongIdentities: ClaudeFreshContextIdentity[] = [
      { ...identity, operationId: randomUUID() },
      { ...identity, sourceSessionId: "session.other" },
      { ...identity, sourceBinding: { ...identity.sourceBinding, opaqueRef: "native.other" } },
      { ...identity, sourceBinding: { ...identity.sourceBinding, nativeSessionId: randomUUID() } },
      { ...identity, sessionId: "session.other" },
      { ...identity, targetId: "target.other" },
      { ...identity, workspaceAuthority: "workspace.other" },
      { ...identity, workspaceRoot: join(identity.workspaceRoot, "other") },
      { ...identity, binding: { ...identity.binding, opaqueRef: "native.other" } },
      { ...identity, binding: { ...identity.binding, nativeSessionId: randomUUID() } }
    ];
    for (const wrong of wrongIdentities) {
      expect(() => owner.adopt(wrong, retirement)).toThrow(ClaudeFreshContextOwnerError);
      expect(() => owner.cleanup(wrong, retirement)).toThrow(ClaudeFreshContextOwnerError);
    }
    expect(owner.getForBinding({ ...identity, binding: { opaqueRef: `native:${randomUUID()}`, nativeSessionId: randomUUID(), generation: 2 } }))
      .toBeUndefined();
    for (const wrong of wrongIdentities.filter((value) => value.operationId === identity.operationId
      && value.sourceSessionId === identity.sourceSessionId && value.sourceBinding === identity.sourceBinding)) {
      expect(() => owner.getForBinding(wrong)).toThrowError(expect.objectContaining({ code: "INVALID_ACCESS" }));
    }
    expect(() => owner.reserve({ ...identity, binding: { ...identity.binding, generation: 3 } }))
      .toThrowError(expect.objectContaining({ code: "INVALID_ACCESS" }));
    expect(() => owner.reserve({ ...identity, operationId: randomUUID() }))
      .toThrowError(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("recovers and cleans only the exact unadopted reservation after source retirement", async () => {
    const { identity, owner, createOwner } = await fixture();
    const reserved = owner.reserve(identity);
    expect(() => owner.markDispatching(reserved)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    const nextOwner = createOwner(2);
    expect(() => nextOwner.adopt(identity, retirement)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => nextOwner.recover({ ...identity, sourceSessionId: "session.other" }, retirement))
      .toThrowError(expect.objectContaining({ code: "INVALID_ACCESS" }));
    const recovered = nextOwner.recover(identity, retirement);
    expect(recovered).toMatchObject({ lifecycle: "reserved", backendGeneration: 2, sourceRetired: true });
    const cleaned = nextOwner.cleanup(identity, retirement);
    expect(cleaned).toMatchObject({ lifecycle: "cleaned", dispatch: "never_dispatched" });
    expect(nextOwner.cleanup(identity, retirement)).toEqual(cleaned);
    expect(() => nextOwner.adopt(identity, retirement)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(() => nextOwner.claim(identity, retirement)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("cleans an unused reservation across Backend generations without claiming source retirement", async () => {
    const { identity, owner, createOwner } = await fixture();
    const exact = { ...identity, operationId: "navigate-to-start" };
    owner.reserve(exact);
    const nextOwner = createOwner(2);
    expect(nextOwner.getForOperation(exact.operationId)?.lifecycle).toBe("reserved");
    const cleaned = nextOwner.cleanup(exact, retirement);
    expect(cleaned).toMatchObject({ backendGeneration: 2, lifecycle: "cleaned", dispatch: "never_dispatched", sourceRetired: false });
    expect(nextOwner.cleanup(exact, retirement)).toEqual(cleaned);
    expect(() => owner.cleanup(exact, retirement)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("deletes only a retired adopted empty binding and preserves consumed identities", async () => {
    const { identity, owner, createOwner } = await fixture();
    const reserved = owner.reserve(identity);
    expect(() => owner.deleteEmptyBinding(reserved, retirement)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    owner.adopt(identity, retirement);
    const nextOwner = createOwner(2);
    const hostBinding = { ...identity, binding: { ...identity.binding, generation: 3 } };
    expect(() => nextOwner.deleteEmptyBinding({ ...hostBinding, targetId: "target.other" }, retirement))
      .toThrowError(expect.objectContaining({ code: "INVALID_ACCESS" }));
    const deleted = nextOwner.deleteEmptyBinding(hostBinding, retirement);
    expect(deleted).toMatchObject({ backendGeneration: 2, lifecycle: "cleaned", dispatch: "never_dispatched", sourceRetired: true });
    expect(deleted.sourceBinding).toEqual(identity.sourceBinding);
    expect(nextOwner.deleteEmptyBinding(hostBinding, retirement)).toEqual(deleted);
    expect(createOwner(2).getForBinding(hostBinding)).toEqual(deleted);
    expect(() => nextOwner.claim(hostBinding, retirement)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));

    const consumedNativeId = randomUUID();
    const consumed = { ...identity, operationId: "delete-consumed", binding: {
      opaqueRef: `native:${consumedNativeId}`, nativeSessionId: consumedNativeId, generation: 2
    } };
    owner.reserve(consumed);
    owner.markDispatching(owner.adopt(consumed, retirement));
    expect(() => nextOwner.deleteEmptyBinding(consumed, retirement)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(nextOwner.getForBinding(consumed)?.dispatch).toBe("dispatching");
  });

  it("does not rebuild a missing initialized database or follow a linked owner root", async () => {
    const { identity, owner, root, createOwner } = await fixture();
    owner.reserve(identity);
    const directory = join(root, "claude-fresh-context-owner-v1");
    const database = (await readdir(directory)).find((name) => name.endsWith(".sqlite"))!;
    await unlink(join(directory, database));
    expect(() => createOwner(2).getForBinding(identity)).toThrowError(expect.objectContaining({ code: "CORRUPT", stateMayHaveChanged: false }));
    const linked = join(root, "linked");
    const external = await mkdtemp(join(tmpdir(), "joko-fresh-context-external-"));
    roots.push(external);
    await symlink(external, linked, process.platform === "win32" ? "junction" : "dir");
    const linkedOwner = new ClaudeFreshContextOwner({ rootDirectory: linked, namespace: "owner.test", generation: 1 });
    expect(() => linkedOwner.reserve(identity)).toThrowError(expect.objectContaining({ code: "INVALID_AUTHORITY" }));
    expect(await readdir(external)).toEqual([]);
  });
});

async function fixture(): Promise<{
  root: string; identity: ClaudeFreshContextIdentity; owner: ClaudeFreshContextOwner;
  createOwner: (generation: number) => ClaudeFreshContextOwner;
}> {
  const root = await mkdtemp(join(tmpdir(), "joko-fresh-context-"));
  roots.push(root);
  const sourceNativeId = randomUUID();
  const nativeId = randomUUID();
  const identity: ClaudeFreshContextIdentity = {
    operationId: randomUUID(), sourceSessionId: "session.source",
    sourceBinding: { opaqueRef: `native:${sourceNativeId}`, nativeSessionId: sourceNativeId, generation: 1 },
    sessionId: "session.child", binding: { opaqueRef: `native:${nativeId}`, nativeSessionId: nativeId, generation: 2 },
    targetId: "target.test", workspaceAuthority: "workspace.test", workspaceRoot: root
  };
  const createOwner = (generation: number): ClaudeFreshContextOwner => new ClaudeFreshContextOwner({
    rootDirectory: root, namespace: "owner.test", generation
  });
  return { root, identity, owner: createOwner(1), createOwner };
}
