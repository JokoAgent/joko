import assert from "node:assert/strict";
import { test } from "node:test";
import { selectSimulatorHidArchitectures } from "./native-simulator-hid-build-policy.mjs";

test("builds a universal helper when SimulatorKit has both slices", () => {
  assert.deepEqual(selectSimulatorHidArchitectures("arm64e x86_64", "arm64"), {
    architectures: ["arm64", "x86_64"], manifestArchitecture: "universal"
  });
});

test("builds only the host slice when SimulatorKit lacks the other slice", () => {
  assert.deepEqual(selectSimulatorHidArchitectures("arm64e", "arm64"), {
    architectures: ["arm64"], manifestArchitecture: "arm64"
  });
  assert.deepEqual(selectSimulatorHidArchitectures("x86_64", "x64"), {
    architectures: ["x86_64"], manifestArchitecture: "x86_64"
  });
});

test("does not advertise a helper when the host slice is unavailable", () => {
  assert.deepEqual(selectSimulatorHidArchitectures("arm64e", "x64"), {
    architectures: [], manifestArchitecture: "x86_64"
  });
  assert.deepEqual(selectSimulatorHidArchitectures("", "arm64"), {
    architectures: [], manifestArchitecture: "arm64"
  });
});
