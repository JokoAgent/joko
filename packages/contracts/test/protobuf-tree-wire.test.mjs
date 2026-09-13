import assert from "node:assert/strict";
import test from "node:test";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import {
  NativeEntryKind,
  NativeSessionTreeNodeSchema,
  NativeSessionTreeSchema,
  PiSessionEntryKind,
  PiSessionTreeNodeSchema,
  PiSessionTreeUpdateSchema,
  ProtobufTreeWireError,
  nativeSessionTreeRoots,
  nativeSessionTreeWireFields,
  piSessionTreeRoots,
  piSessionTreeWireFields
} from "../dist/index.js";

test("Pi Session trees retain 10001 levels through binary wire encoding", () => {
  const roots = [linearPiTree(10_001)];
  const wire = create(PiSessionTreeUpdateSchema, {
    nativeSessionId: "native-deep",
    activeLeafId: "pi-entry-10000",
    ...piSessionTreeWireFields(roots)
  });

  assert.equal(wire.flatNodes.length, 10_001);
  assert.equal(wire.rootCount, 1);
  const decoded = fromBinary(
    PiSessionTreeUpdateSchema,
    toBinary(PiSessionTreeUpdateSchema, wire)
  );
  const decodedRoots = piSessionTreeRoots(decoded);
  assert.equal(linearDepth(decodedRoots[0]), 10_001);
  assert.equal(linearLeaf(decodedRoots[0]).entryId, "pi-entry-10000");
});

test("Native Session trees retain 10001 levels through binary wire encoding", () => {
  const roots = [linearNativeTree(10_001)];
  const wire = create(NativeSessionTreeSchema, {
    sessionId: "session-deep",
    activeEntryId: "native-entry-10000",
    ...nativeSessionTreeWireFields(roots)
  });

  assert.equal(wire.flatNodes.length, 10_001);
  assert.equal(wire.rootCount, 1);
  const decoded = fromBinary(
    NativeSessionTreeSchema,
    toBinary(NativeSessionTreeSchema, wire)
  );
  const decodedRoots = nativeSessionTreeRoots(decoded);
  assert.equal(linearDepth(decodedRoots[0]), 10_001);
  assert.equal(linearLeaf(decodedRoots[0]).entryId, "native-entry-10000");
});

test("shallow trees use the same flat wire representation", () => {
  const fields = piSessionTreeWireFields([linearPiTree(2)]);
  assert.equal(fields.flatNodes.length, 2);
  assert.equal(fields.flatNodes[0].childCount, 1);
  assert.equal(fields.flatNodes[1].childCount, 0);
  assert.equal(fields.rootCount, 1);
});

test("wire preparation rejects cycles and repeated entries with a typed error", () => {
  const cycle = {
    ...create(PiSessionTreeNodeSchema, {
    entryId: "cycle",
    kind: PiSessionEntryKind.MESSAGE
    }),
    children: []
  };
  cycle.children.push(cycle);
  assert.throws(
    () => piSessionTreeWireFields([cycle]),
    (error) => error instanceof ProtobufTreeWireError && error.code === "invalid_tree"
  );

  const first = {
    ...create(PiSessionTreeNodeSchema, {
    entryId: "repeated",
    kind: PiSessionEntryKind.MESSAGE
    }),
    children: []
  };
  const second = {
    ...create(PiSessionTreeNodeSchema, {
    entryId: "repeated",
    kind: PiSessionEntryKind.MESSAGE
    }),
    children: []
  };
  assert.throws(
    () => piSessionTreeWireFields([first, second]),
    (error) => error instanceof ProtobufTreeWireError && error.code === "invalid_tree"
  );
});

test("wire materialization rejects incomplete flat encodings", () => {
  const flat = create(PiSessionTreeNodeSchema, {
    entryId: "flat",
    kind: PiSessionEntryKind.MESSAGE,
    childCount: 1
  });
  assert.throws(
    () => piSessionTreeRoots(create(PiSessionTreeUpdateSchema, {
      flatNodes: [flat],
      rootCount: 1
    })),
    (error) => error instanceof ProtobufTreeWireError && error.code === "invalid_flat_encoding"
  );
});

function linearPiTree(depth) {
  let root;
  for (let index = depth - 1; index >= 0; index -= 1) {
    root = {
      ...create(PiSessionTreeNodeSchema, {
      entryId: `pi-entry-${index}`,
      parentId: index === 0 ? "" : `pi-entry-${index - 1}`,
      kind: PiSessionEntryKind.MESSAGE,
      role: index % 2 === 0 ? "user" : "assistant",
      active: index === depth - 1
      }),
      children: root === undefined ? [] : [root]
    };
  }
  return root;
}

function linearNativeTree(depth) {
  let root;
  for (let index = depth - 1; index >= 0; index -= 1) {
    root = {
      ...create(NativeSessionTreeNodeSchema, {
      entryId: `native-entry-${index}`,
      parentEntryId: index === 0 ? "" : `native-entry-${index - 1}`,
      kind: index % 2 === 0 ? NativeEntryKind.USER_MESSAGE : NativeEntryKind.ASSISTANT_MESSAGE,
      active: index === depth - 1
      }),
      children: root === undefined ? [] : [root]
    };
  }
  return root;
}

function linearDepth(root) {
  let depth = 0;
  let current = root;
  while (current !== undefined) {
    assert.ok(current.children.length <= 1);
    depth += 1;
    current = current.children[0];
  }
  return depth;
}

function linearLeaf(root) {
  let current = root;
  while (current.children[0] !== undefined) current = current.children[0];
  return current;
}
