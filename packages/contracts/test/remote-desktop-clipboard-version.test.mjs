import { strict as assert } from "node:assert";
import test from "node:test";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { isRemoteDesktopClipboardVersion, RemoteDesktopClipboardVersionResultSchema } from "../dist/index.js";

test("current clipboard counters and content fingerprints round trip as opaque versions", () => {
  for (const version of ["0", "9".repeat(128), "ab0123456789cdef".repeat(4)]) {
    assert.equal(isRemoteDesktopClipboardVersion(version), true);
    const message = create(RemoteDesktopClipboardVersionResultSchema, { version });
    assert.equal(fromBinary(RemoteDesktopClipboardVersionResultSchema,
      toBinary(RemoteDesktopClipboardVersionResultSchema, message)).version, version);
  }
  for (const version of [undefined, 1, "", "1".repeat(129), "a".repeat(63), "a".repeat(65),
    "A".repeat(64), "g".repeat(64), "1:2", " 123", "123\n"]) {
    assert.equal(isRemoteDesktopClipboardVersion(version), false);
  }
});
