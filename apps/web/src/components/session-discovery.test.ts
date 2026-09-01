import { describe, expect, it } from "vitest";

import { nativeSessionDiscoveryAvailability } from "./session-discovery.js";

describe("native session discovery capability profiles", () => {
  it.each([
    {
      profile: "discoverable and resumable fake",
      capabilities: new Map([
        ["session.discovery", { supported: true }],
        ["session.resume", { supported: true }]
      ]),
      expected: { visible: true, attachEnabled: true }
    },
    {
      profile: "discoverable but non-resumable fake",
      capabilities: new Map([
        ["session.discovery", { supported: true }],
        ["session.resume", { supported: false }]
      ]),
      expected: { visible: true, attachEnabled: false }
    },
    {
      profile: "non-discoverable fake",
      capabilities: new Map([
        ["session.discovery", { supported: false }],
        ["session.resume", { supported: true }]
      ]),
      expected: { visible: false, attachEnabled: false }
    }
  ])("keeps $profile visibility and disabled state capability-driven", ({ capabilities, expected }) => {
    expect(nativeSessionDiscoveryAvailability(capabilities)).toEqual(expected);
  });
});
