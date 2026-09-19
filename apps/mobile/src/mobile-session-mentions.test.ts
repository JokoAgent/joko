import { create } from "@bufbuild/protobuf";
import {
  BackendDescriptorSchema,
  CapabilityOptionsSchema,
  CapabilityManifestSchema,
  CapabilitySchema,
  CapabilitySupport,
  EntityVersionSchema,
  InputCapabilityOptionsSchema,
  RevisionSchema,
  SessionSchema,
  SessionState,
  SnapshotSchema,
  capabilityNames
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { insertMobileSessionMention, plainTextMobileComposerDraft } from "./mobile-composer-document";
import {
  assertMobileSessionMentionDraft,
  backendSupportsSessionMentions,
  createMobileSessionMentionControls,
  filterMobileSessionMentionCandidates
} from "./mobile-session-mentions";

const version = create(EntityVersionSchema, {
  revision: create(RevisionSchema, { value: 3n, etag: "r3" }),
  generation: 7n
});
const current = create(SessionSchema, {
  sessionId: "current",
  backendId: "backend",
  targetId: "target",
  displayName: "Current",
  state: SessionState.IDLE,
  version
});
const source = create(SessionSchema, {
  sessionId: "source",
  backendId: "backend",
  targetId: "target",
  displayName: "Prior work",
  state: SessionState.IDLE,
  version
});

function backend(options: readonly string[] = ["session"]) {
  return create(BackendDescriptorSchema, {
    backendId: "backend",
    version: "backend-v1",
    capabilities: create(CapabilityManifestSchema, {
      revision: create(RevisionSchema, { value: 4n, etag: "capabilities-r4" }),
      capabilities: [create(CapabilitySchema, {
        name: capabilityNames.inputMention,
        support: CapabilitySupport.SUPPORTED,
        options: create(CapabilityOptionsSchema, {
          kind: {
            case: "input",
            value: create(InputCapabilityOptionsSchema, { mediaTypes: [...options] })
          }
        })
      })]
    })
  });
}

describe("mobile Session mention controls", () => {
  it("uses only one explicit typed capability and stable non-current candidates", () => {
    const descriptor = backend();
    const owner = create(SnapshotSchema, {
      sessions: [
        source,
        current,
        create(SessionSchema, { ...source, sessionId: "closed", displayName: "Closed", state: SessionState.CLOSED }),
        create(SessionSchema, { ...source, sessionId: " malformed", displayName: "Malformed" }),
        create(SessionSchema, { ...source, sessionId: "zeta", displayName: "Zeta" })
      ]
    });
    const controls = createMobileSessionMentionControls("authority", owner, current, descriptor);
    expect(controls?.candidates).toEqual([
      { sessionId: "source", displayText: "Prior work", state: SessionState.IDLE },
      { sessionId: "zeta", displayText: "Zeta", state: SessionState.IDLE }
    ]);
    expect(filterMobileSessionMentionCandidates(controls?.candidates ?? [], "prior")).toMatchObject([{ sessionId: "source" }]);
    expect(controls?.surfaceOwnerKey).toContain("authority");
  });

  it("fails closed for absent, empty, duplicate, or ambiguous capability declarations", () => {
    expect(backendSupportsSessionMentions(backend([]))).toBe(false);
    expect(backendSupportsSessionMentions(backend(["session", "session"]))).toBe(false);
    expect(backendSupportsSessionMentions(create(BackendDescriptorSchema, {
      ...backend(),
      capabilities: create(CapabilityManifestSchema, {
        capabilities: [
          ...backend().capabilities!.capabilities,
          create(CapabilitySchema, {
            name: capabilityNames.inputMention,
            support: CapabilitySupport.SUPPORTED,
            options: create(CapabilityOptionsSchema, {
              kind: {
                case: "input",
                value: create(InputCapabilityOptionsSchema, { mediaTypes: ["session"] })
              }
            })
          })
        ]
      })
    }))).toBe(false);
  });

  it("retains the draft when a referenced source task retires", () => {
    const draft = insertMobileSessionMention(
      plainTextMobileComposerDraft("Use "),
      { start: 4, end: 4 },
      { sessionId: "source", displayText: "Prior work" },
      "mention"
    ).draft;
    const owner = create(SnapshotSchema, { sessions: [current, source] });
    const controls = createMobileSessionMentionControls("authority", owner, current, backend());
    expect(assertMobileSessionMentionDraft(controls, draft)).toEqual(draft);

    const retired = createMobileSessionMentionControls("authority", create(SnapshotSchema, { sessions: [current] }), current, backend());
    expect(() => assertMobileSessionMentionDraft(retired, draft)).toThrow(/no longer available/);
  });
});
