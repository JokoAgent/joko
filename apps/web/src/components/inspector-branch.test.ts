import { create } from "@bufbuild/protobuf";
import {
  NativeEntryKind,
  nativeSessionTreeRoots,
  NativeSessionTreeNodeSchema,
  NativeSessionTreeSchema,
  type NativeSessionTreeNestedNode,
  type NativeSessionTreeNode
} from "@joko/contracts";
import { describe, expect, it } from "vitest";

import { mapNativeTreeNode } from "../gateway.js";
import type { NativeSessionTreeNodeView } from "../model.js";
import { canForkNativeTreeNode, containsActiveTreeNode } from "./Inspector.js";

describe("native branch actions", () => {
  it("offers Pi-compatible forking only for projected user messages", () => {
    expect(canForkNativeTreeNode(true, { role: "user" })).toBe(true);
    expect(canForkNativeTreeNode(true, { role: "assistant" })).toBe(false);
    expect(canForkNativeTreeNode(true, { role: "tool" })).toBe(false);
    expect(canForkNativeTreeNode(true, {})).toBe(false);
    expect(canForkNativeTreeNode(false, { role: "user" })).toBe(false);
  });

  it("derives fork gating from the typed native role while retaining preview and parent", () => {
    const user = mapNativeTreeNode(singleRoot(create(NativeSessionTreeNodeSchema, {
      entryId: "user-entry",
      parentEntryId: "parent-entry",
      kind: NativeEntryKind.USER_MESSAGE,
      summary: "bounded preview",
      active: false,
      childCount: 0
    })));
    const assistant = mapNativeTreeNode(singleRoot(create(NativeSessionTreeNodeSchema, {
      entryId: "assistant-entry",
      parentEntryId: "user-entry",
      kind: NativeEntryKind.ASSISTANT_MESSAGE,
      summary: "assistant preview",
      active: true,
      childCount: 0
    })));

    expect(user).toMatchObject({
      id: "user-entry",
      parentId: "parent-entry",
      kind: "message",
      role: "user",
      text: "bounded preview",
      summary: "bounded preview"
    });
    expect(canForkNativeTreeNode(true, user)).toBe(true);
    expect(canForkNativeTreeNode(true, assistant)).toBe(false);
  });

  it("maps and searches a 10001-node linear tree without synchronous recursion", () => {
    const flatNodes = Array.from({ length: 10_001 }, (_, index) => nativeNode(
      `entry-${index}`,
      index === 10_000 ? 0 : 1,
      index === 10_000
    ));
    const roots = nativeSessionTreeRoots(create(NativeSessionTreeSchema, { flatNodes, rootCount: 1 }));
    const mapped = mapNativeTreeNode(roots[0]!);
    let current: NativeSessionTreeNodeView | undefined = mapped;
    let count = 0;
    while (current !== undefined) {
      count += 1;
      expect(current.children.length).toBeLessThanOrEqual(1);
      if (current.children.length === 0) expect(current.active).toBe(true);
      current = current.children[0];
    }
    expect(count).toBe(10_001);
    expect(containsActiveTreeNode(mapped)).toBe(true);
  });

  it("rejects repeated flat wire entries and safely searches cyclic view data", () => {
    const wire = create(NativeSessionTreeSchema, {
      flatNodes: [nativeNode("cycle", 1, false), nativeNode("cycle", 0, false)],
      rootCount: 1
    });
    expect(() => nativeSessionTreeRoots(wire)).toThrow(/cycle or repeated/u);

    const viewChildren: NativeSessionTreeNodeView[] = [];
    const view: NativeSessionTreeNodeView = {
      id: "cycle",
      kind: "custom",
      text: "cycle",
      active: false,
      children: viewChildren
    };
    viewChildren.push(view);
    expect(containsActiveTreeNode(view)).toBe(false);
  });
});

function nativeNode(
  entryId: string,
  childCount: number,
  active: boolean
): NativeSessionTreeNode {
  return {
    $typeName: "joko.v1.NativeSessionTreeNode",
    entryId,
    parentEntryId: "",
    kind: NativeEntryKind.CUSTOM,
    summary: entryId,
    active,
    childCount
  };
}

function singleRoot(node: NativeSessionTreeNode): NativeSessionTreeNestedNode {
  return nativeSessionTreeRoots(create(NativeSessionTreeSchema, { flatNodes: [node], rootCount: 1 }))[0]!;
}
