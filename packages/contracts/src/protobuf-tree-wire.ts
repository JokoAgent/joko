import type { PiSessionTreeNode, PiSessionTreeUpdate } from "./gen/joko/v1/pi_pb.js";
import type { NativeSessionTree, NativeSessionTreeNode } from "./gen/joko/v1/runtime_pb.js";

const MAXIMUM_UINT32 = 0xffff_ffff;

type NestedTreeNode<Node> = {
  readonly entryId: string;
  readonly children: readonly Node[];
};

type FlatTreeNode = {
  readonly entryId: string;
  readonly childCount: number;
};

export type PiSessionTreeNestedNode = Omit<PiSessionTreeNode, "children"> & {
  readonly children: PiSessionTreeNestedNode[];
};

export type NativeSessionTreeNestedNode = Omit<NativeSessionTreeNode, "children"> & {
  readonly children: NativeSessionTreeNestedNode[];
};

export type ProtobufTreeWireErrorCode = "invalid_flat_encoding" | "invalid_tree";

export class ProtobufTreeWireError extends Error {
  readonly code: ProtobufTreeWireErrorCode;

  constructor(code: ProtobufTreeWireErrorCode, message: string) {
    super(message);
    this.name = "ProtobufTreeWireError";
    this.code = code;
  }
}

export interface PiSessionTreeWireFields {
  readonly flatNodes: PiSessionTreeNode[];
  readonly rootCount: number;
}

export interface NativeSessionTreeWireFields {
  readonly flatNodes: NativeSessionTreeNode[];
  readonly rootCount: number;
}

export function piSessionTreeWireFields(
  roots: readonly PiSessionTreeNestedNode[]
): PiSessionTreeWireFields {
  return prepareTreeForWire(roots, "Pi Session", (node, childCount) => {
    const { children: _children, ...flatNode } = node;
    return { ...flatNode, childCount };
  });
}

export function nativeSessionTreeWireFields(
  roots: readonly NativeSessionTreeNestedNode[]
): NativeSessionTreeWireFields {
  return prepareTreeForWire(roots, "Native Session", (node, childCount) => {
    const { children: _children, ...flatNode } = node;
    return { ...flatNode, childCount };
  });
}

export function piSessionTreeRoots(tree: PiSessionTreeUpdate): PiSessionTreeNestedNode[] {
  return materializeTreeRoots(
    tree.flatNodes,
    tree.rootCount,
    "Pi Session",
    (node, children) => ({ ...node, childCount: 0, children })
  );
}

export function nativeSessionTreeRoots(tree: NativeSessionTree): NativeSessionTreeNestedNode[] {
  return materializeTreeRoots(
    tree.flatNodes,
    tree.rootCount,
    "Native Session",
    (node, children) => ({ ...node, childCount: 0, children })
  );
}

function prepareTreeForWire<NestedNode extends NestedTreeNode<NestedNode>, WireNode>(
  roots: readonly NestedNode[],
  label: string,
  flatten: (node: NestedNode, childCount: number) => WireNode
): { readonly flatNodes: WireNode[]; readonly rootCount: number } {
  if (!Array.isArray(roots) || roots.length > MAXIMUM_UINT32) {
    throw new ProtobufTreeWireError("invalid_tree", `${label} tree has an invalid root list.`);
  }
  const seenNodes = new Set<object>();
  const seenEntryIds = new Set<string>();
  const flatNodes: WireNode[] = [];
  const stack: NestedNode[] = [];
  for (let index = roots.length - 1; index >= 0; index -= 1) stack.push(roots[index]!);
  while (stack.length > 0) {
    const node = stack.pop()!;
    const children = checkedNestedNode(node, seenNodes, seenEntryIds, label);
    if (children.length > MAXIMUM_UINT32) {
      throw new ProtobufTreeWireError("invalid_tree", `${label} tree node has too many children.`);
    }
    flatNodes.push(flatten(node, children.length));
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
  return { flatNodes, rootCount: roots.length };
}

function materializeTreeRoots<WireNode extends FlatTreeNode, NestedNode>(
  flatNodes: readonly WireNode[],
  rootCount: number,
  label: string,
  nest: (node: WireNode, children: NestedNode[]) => NestedNode
): NestedNode[] {
  if (!Array.isArray(flatNodes)) {
    throw new ProtobufTreeWireError("invalid_tree", `${label} tree has invalid wire fields.`);
  }
  if (flatNodes.length === 0) {
    if (rootCount !== 0) {
      throw new ProtobufTreeWireError("invalid_flat_encoding", `${label} tree declares roots without flat nodes.`);
    }
    return [];
  }
  if (!Number.isInteger(rootCount) || rootCount <= 0 || rootCount > flatNodes.length) {
    throw new ProtobufTreeWireError("invalid_flat_encoding", `${label} tree has an invalid flat root count.`);
  }

  const materializedRoots: NestedNode[] = [];
  const seenNodes = new Set<object>();
  const seenEntryIds = new Set<string>();
  const parents: Array<{ readonly children: NestedNode[]; remaining: number }> = [];
  for (const flatNode of flatNodes) {
    checkedFlatNode(flatNode, seenNodes, seenEntryIds, label);
    const childCount = flatNode.childCount;
    if (!Number.isInteger(childCount) || childCount < 0 || childCount > MAXIMUM_UINT32) {
      throw new ProtobufTreeWireError("invalid_flat_encoding", `${label} flat tree node has an invalid child count.`);
    }
    while (parents.at(-1)?.remaining === 0) parents.pop();
    const parent = parents.at(-1);
    const nestedChildren: NestedNode[] = [];
    const nestedNode = nest(flatNode, nestedChildren);
    if (parent === undefined) {
      if (materializedRoots.length >= rootCount) {
        throw new ProtobufTreeWireError("invalid_flat_encoding", `${label} flat tree contains more roots than declared.`);
      }
      materializedRoots.push(nestedNode);
    } else {
      parent.children.push(nestedNode);
      parent.remaining -= 1;
    }
    if (childCount > 0) parents.push({ children: nestedChildren, remaining: childCount });
  }
  while (parents.at(-1)?.remaining === 0) parents.pop();
  if (parents.length !== 0 || materializedRoots.length !== rootCount) {
    throw new ProtobufTreeWireError(
      "invalid_flat_encoding",
      `${label} flat tree child counts do not describe a complete tree.`
    );
  }
  return materializedRoots;
}

function checkedNestedNode<Node extends NestedTreeNode<Node>>(
  node: Node,
  seenNodes: Set<object>,
  seenEntryIds: Set<string>,
  label: string
): readonly Node[] {
  if (
    typeof node !== "object" ||
    node === null ||
    typeof node.entryId !== "string" ||
    node.entryId.length === 0 ||
    !Array.isArray(node.children)
  ) {
    throw new ProtobufTreeWireError("invalid_tree", `${label} tree contains an invalid node.`);
  }
  checkedIdentity(node, node.entryId, seenNodes, seenEntryIds, label, "invalid_tree");
  return node.children;
}

function checkedFlatNode(
  node: FlatTreeNode,
  seenNodes: Set<object>,
  seenEntryIds: Set<string>,
  label: string
): void {
  if (typeof node !== "object" || node === null || typeof node.entryId !== "string" || node.entryId.length === 0) {
    throw new ProtobufTreeWireError("invalid_flat_encoding", `${label} flat tree contains an invalid node.`);
  }
  checkedIdentity(node, node.entryId, seenNodes, seenEntryIds, label, "invalid_flat_encoding");
}

function checkedIdentity(
  node: object,
  entryId: string,
  seenNodes: Set<object>,
  seenEntryIds: Set<string>,
  label: string,
  code: ProtobufTreeWireErrorCode
): void {
  if (seenNodes.has(node) || seenEntryIds.has(entryId)) {
    throw new ProtobufTreeWireError(code, `${label} tree contains a cycle or repeated entry.`);
  }
  seenNodes.add(node);
  seenEntryIds.add(entryId);
}
