import type { SubagentRunView } from "../model.js";

export interface SubagentTreeNode {
  readonly run: SubagentRunView;
  readonly depth: number;
  readonly children: readonly SubagentTreeNode[];
}

export function buildSubagentTree(runs: readonly SubagentRunView[]): readonly SubagentTreeNode[] {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const children = new Map<string, SubagentRunView[]>();
  const roots: SubagentRunView[] = [];
  for (const run of runs) {
    const parentId = run.parentSubagentRunId;
    if (parentId === undefined || parentId === run.id || !byId.has(parentId)) {
      roots.push(run);
      continue;
    }
    const bucket = children.get(parentId) ?? [];
    bucket.push(run);
    children.set(parentId, bucket);
  }
  const visited = new Set<string>();
  const result: SubagentTreeNode[] = [];
  for (const run of sortRuns(roots)) {
    if (!visited.has(run.id)) result.push(buildTreeNode(run, 0, children, visited));
  }
  for (const run of sortRuns(runs)) {
    if (!visited.has(run.id)) result.push(buildTreeNode(run, 0, children, visited));
  }
  return result;
}

export function flattenSubagentTree(nodes: readonly SubagentTreeNode[]): readonly SubagentTreeNode[] {
  const flattened: SubagentTreeNode[] = [];
  const pending = [...nodes].reverse();
  while (pending.length > 0) {
    const node = pending.pop()!;
    flattened.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(node.children[index]!);
  }
  return flattened;
}

function buildTreeNode(
  run: SubagentRunView,
  depth: number,
  childrenByParent: ReadonlyMap<string, readonly SubagentRunView[]>,
  visited: Set<string>
): SubagentTreeNode {
  interface MutableNode {
    readonly run: SubagentRunView;
    readonly depth: number;
    readonly children: SubagentTreeNode[];
  }
  interface Frame {
    readonly node: MutableNode;
    readonly candidates: readonly SubagentRunView[];
    nextIndex: number;
  }

  const root: MutableNode = { run, depth, children: [] };
  const activePath = new Set<string>([run.id]);
  const stack: Frame[] = [{ node: root, candidates: sortRuns(childrenByParent.get(run.id) ?? []), nextIndex: 0 }];
  visited.add(run.id);

  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    const child = frame.candidates[frame.nextIndex];
    if (child === undefined) {
      activePath.delete(frame.node.run.id);
      stack.pop();
      continue;
    }
    frame.nextIndex += 1;
    if (activePath.has(child.id) || visited.has(child.id)) continue;

    const childNode: MutableNode = { run: child, depth: frame.node.depth + 1, children: [] };
    frame.node.children.push(childNode);
    activePath.add(child.id);
    visited.add(child.id);
    stack.push({
      node: childNode,
      candidates: sortRuns(childrenByParent.get(child.id) ?? []),
      nextIndex: 0
    });
  }
  return root;
}

function sortRuns(runs: readonly SubagentRunView[]): SubagentRunView[] {
  return [...runs].sort((left, right) => {
    const leftActive = left.state === "queued" || left.state === "running";
    const rightActive = right.state === "queued" || right.state === "running";
    if (leftActive !== rightActive) return leftActive ? -1 : 1;
    return right.updatedAt - left.updatedAt || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  });
}
