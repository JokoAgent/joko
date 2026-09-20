import { create } from "@bufbuild/protobuf";
import {
  BackendDescriptorSchema,
  CapabilityManifestSchema,
  CapabilitySchema,
  CapabilitySupport,
  EntityVersionSchema,
  ReviewRunSchema,
  RevisionSchema,
  RunSchema,
  RunState,
  RuntimeCommandSource,
  SessionSchema,
  SessionState,
  SnapshotSchema,
  TargetSchema,
  TargetState,
  capabilityNames,
  type Snapshot
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  appendMobileSelectionQuote,
  insertMobileSessionMention,
  plainTextMobileComposerDraft
} from "./mobile-composer-document";
import {
  assertMobileAppCommandCandidate,
  assertMobileAppCommandInvocation,
  createMobileAppCommandControls,
  filterMobileCommandPaletteCandidates,
  mergeMobileCommandPaletteCandidates,
  mobileAppCommandCandidates,
  mobileAppCommandIntent,
  mobileAppCommandTesting,
  parseMobileAppCommand
} from "./mobile-app-commands";

function capability(name: string, support = CapabilitySupport.SUPPORTED) {
  return create(CapabilitySchema, { name, support });
}

function snapshot(patch: { readonly capabilities?: readonly ReturnType<typeof capability>[]; readonly reviewReadOnly?: boolean } = {}): Snapshot {
  const version = create(EntityVersionSchema, {
    generation: 7n,
    revision: create(RevisionSchema, { value: 9n, etag: "r9" })
  });
  const current = create(SessionSchema, {
    sessionId: "session", backendId: "backend", targetId: "target", displayName: "Task",
    state: SessionState.IDLE, nativeBinding: { runtimeGeneration: 7n }, version
  });
  return create(SnapshotSchema, {
    generation: 3n,
    backends: [create(BackendDescriptorSchema, {
      backendId: "backend",
      version: "backend-v1",
      entityVersion: version,
      capabilities: create(CapabilityManifestSchema, {
        revision: create(RevisionSchema, { value: 4n, etag: "cap-r4" }),
        capabilities: [...(patch.capabilities ?? [
          capability(capabilityNames.runtimeUserShell),
          capability(capabilityNames.sessionReset),
          capability(capabilityNames.reviewIsolated)
        ])]
      })
    })],
    targets: [create(TargetSchema, {
      targetId: "target", backendId: "backend", state: TargetState.ACTIVE, version
    })],
    sessions: [
      current,
      create(SessionSchema, {
        sessionId: "other", backendId: "backend", targetId: "target", displayName: "Other",
        state: SessionState.IDLE, nativeBinding: { runtimeGeneration: 7n }, version
      }),
      create(SessionSchema, {
        sessionId: "closed", backendId: "backend", targetId: "target", displayName: "Closed",
        state: SessionState.CLOSED, nativeBinding: { runtimeGeneration: 7n }, version
      })
    ],
    ...(patch.reviewReadOnly ? { reviewRuns: [create(ReviewRunSchema, {
      reviewRunId: "review", sourceSessionId: "source", reviewerSessionId: "session"
    })] } : {})
  });
}

describe("mobile app command authority and palette", () => {
  it("binds exact Session, Target, Backend, and capability revisions without requiring runtime.commands", () => {
    const owner = snapshot();
    expect(createMobileAppCommandControls("authority", owner, owner, "session")).toMatchObject({
      authorityKey: "authority",
      session: { sessionId: "session" },
      runtimeGeneration: "7",
      jumpSessionIds: ["session", "other"],
      policy: { help: true, jumpSession: true, userShell: true, sessionReset: true, review: true }
    });
    const duplicate = snapshot({ capabilities: [
      capability(capabilityNames.runtimeUserShell),
      capability(capabilityNames.runtimeUserShell),
      capability(capabilityNames.sessionReset),
      capability(capabilityNames.reviewIsolated)
    ] });
    expect(createMobileAppCommandControls("authority", duplicate, duplicate, "session")?.policy.userShell).toBe(false);
    const reviewer = snapshot({ reviewReadOnly: true });
    expect(createMobileAppCommandControls("authority", reviewer, reviewer, "session")?.policy).toEqual({
      help: true, jumpSession: true, userShell: false, sessionReset: false, review: false
    });
    const working = create(SnapshotSchema, {
      ...owner,
      runs: [create(RunSchema, { runId: "run", sessionId: "session", state: RunState.RUNNING })]
    });
    expect(createMobileAppCommandControls("authority", working, working, "session")?.policy).toEqual({
      help: true, jumpSession: true, userShell: false, sessionReset: false, review: false
    });
    const running = create(SnapshotSchema, {
      ...owner,
      sessions: owner.sessions.map((session) => session.sessionId === "session"
        ? create(SessionSchema, { ...session, state: SessionState.RUNNING }) : session)
    });
    expect(createMobileAppCommandControls("authority", running, running, "session")?.policy.userShell).toBe(false);
    expect(createMobileAppCommandControls("authority", owner, { ...owner, generation: 4n }, "session")).toBeUndefined();
  });

  it("keeps app-owned commands first and prevents a runtime command from shadowing them", () => {
    const controls = createMobileAppCommandControls("authority", snapshot(), snapshot(), "session")!;
    expect(mobileAppCommandCandidates(controls).map((candidate) => candidate.name)).toEqual([
      "help", "jump-session", "cmd", "clear", "review"
    ]);
    const merged = mergeMobileCommandPaletteCandidates(controls, [
      { commandId: "runtime-help", name: "HELP", description: "spoof", source: RuntimeCommandSource.BACKEND },
      { commandId: "runtime-deploy", name: "deploy", description: "Deploy", source: RuntimeCommandSource.PROMPT }
    ]);
    expect(merged.map((candidate) => candidate.commandId)).toEqual([
      "builtin:help", "builtin:jump-session", "builtin:cmd", "builtin:clear", "builtin:review", "runtime-deploy"
    ]);
    expect(assertMobileAppCommandCandidate(controls, mobileAppCommandCandidates(controls)[0]!)).toMatchObject({ name: "help" });
    expect(() => assertMobileAppCommandCandidate({ ...controls, policy: { ...controls.policy, userShell: false } },
      mobileAppCommandCandidates(controls)[2]!)).toThrow(/no longer available/u);
    const withoutShell = { ...controls, policy: { ...controls.policy, userShell: false } };
    expect(mergeMobileCommandPaletteCandidates(withoutShell, [
      { commandId: "runtime-cmd", name: "cmd", description: "spoof", source: RuntimeCommandSource.BACKEND }
    ]).some((candidate) => candidate.commandId === "runtime-cmd")).toBe(false);
  });

  it("filters the merged catalog with stable order and a bounded visible result count", () => {
    const controls = createMobileAppCommandControls("authority", snapshot(), snapshot(), "session")!;
    const candidates = mergeMobileCommandPaletteCandidates(controls, [
      { commandId: "release", name: "release", description: "Review a release", source: RuntimeCommandSource.PROMPT }
    ]);
    expect(filterMobileCommandPaletteCandidates(candidates, "re").items.map((candidate) => candidate.name)).toEqual([
      "review", "release"
    ]);
    expect(filterMobileCommandPaletteCandidates(candidates, "", 2)).toMatchObject({
      items: [{ name: "help" }, { name: "jump-session" }],
      truncated: true
    });
    expect(mobileAppCommandTesting.maximumVisibleResults).toBe(20);
  });
});

describe("mobile app command invocation", () => {
  const controls = createMobileAppCommandControls("authority", snapshot(), snapshot(), "session")!;

  it("recognizes only complete capability-applicable invocations and retains usage errors", () => {
    expect(parseMobileAppCommand(plainTextMobileComposerDraft("/HELP  "), controls)).toEqual({ kind: "help" });
    expect(parseMobileAppCommand(plainTextMobileComposerDraft("/jump-session other"), controls)).toEqual({
      kind: "jumpSession", sessionId: "other"
    });
    expect(parseMobileAppCommand(plainTextMobileComposerDraft("/cmd"), controls)).toEqual({
      kind: "userShell", command: ""
    });
    expect(parseMobileAppCommand(plainTextMobileComposerDraft("/review auth\nand data loss"), controls)).toEqual({
      kind: "review", focus: "auth\nand data loss"
    });
    expect(parseMobileAppCommand(plainTextMobileComposerDraft("  /clear  "), controls)).toEqual({ kind: "sessionReset" });
    expect(parseMobileAppCommand(plainTextMobileComposerDraft("/CLEAR"), controls)).toBeUndefined();
    expect(parseMobileAppCommand(plainTextMobileComposerDraft("/help now"), controls)).toBeUndefined();
    expect(parseMobileAppCommand(plainTextMobileComposerDraft(" /review"), controls)).toBeUndefined();
    expect(mobileAppCommandIntent(plainTextMobileComposerDraft(" /review"))).toBe("review");
    expect(mobileAppCommandIntent(plainTextMobileComposerDraft("/help now"))).toBe("help");
    expect(mobileAppCommandIntent(plainTextMobileComposerDraft("/CLEAR"))).toBe("sessionReset");
  });

  it("fails closed for missing targets, empty shell, and structured or incompatible attachments", () => {
    expect(() => assertMobileAppCommandInvocation(controls, plainTextMobileComposerDraft("/jump-session"), {
      kind: "jumpSession", sessionId: ""
    })).toThrow(/Usage/u);
    expect(() => assertMobileAppCommandInvocation(controls, plainTextMobileComposerDraft("/jump-session missing"), {
      kind: "jumpSession", sessionId: "missing"
    })).toThrow(/does not exist/u);
    expect(() => assertMobileAppCommandInvocation(controls, plainTextMobileComposerDraft("/cmd"), {
      kind: "userShell", command: ""
    })).toThrow(/Usage/u);

    const mention = insertMobileSessionMention(plainTextMobileComposerDraft("/help"), { start: 0, end: 5 }, {
      sessionId: "other", displayText: "Other"
    }, "mention").draft;
    expect(() => assertMobileAppCommandInvocation(controls, mention, { kind: "help" })).toThrow(/references/u);

    const quoted = appendMobileSelectionQuote(plainTextMobileComposerDraft("/review "), {
      sourceSessionId: "session", sourceMessageId: "message", sourceEventId: "event",
      sourceRole: "assistant", text: "evidence"
    }, "quote").draft;
    expect(() => assertMobileAppCommandInvocation(controls, quoted, parseMobileAppCommand(quoted, controls)!)).toThrow(/structured message items/u);

    const attachment = {
      attachmentId: "attachment", kind: "file" as const, state: "uploaded" as const,
      fileName: "notes.txt", mediaType: "text/plain", byteSize: 5, sha256Hex: "a".repeat(64),
      capturedAtUnixMs: 1, blobId: "blob"
    };
    const shell = { ...plainTextMobileComposerDraft("/cmd pwd"), attachments: [attachment] };
    expect(() => assertMobileAppCommandInvocation(controls, shell, { kind: "userShell", command: "pwd" }))
      .toThrow(/Remove attachments/u);
  });

  it("bounds Review focus by Unicode characters", () => {
    const allowed = "/review " + "😀".repeat(mobileAppCommandTesting.maximumReviewFocusCharacters);
    expect(assertMobileAppCommandInvocation(controls, plainTextMobileComposerDraft(allowed), {
      kind: "review", focus: "😀".repeat(mobileAppCommandTesting.maximumReviewFocusCharacters)
    })).toMatchObject({ kind: "review" });
    const rejected = "/review " + "😀".repeat(mobileAppCommandTesting.maximumReviewFocusCharacters + 1);
    expect(() => assertMobileAppCommandInvocation(controls, plainTextMobileComposerDraft(rejected), {
      kind: "review", focus: "😀".repeat(mobileAppCommandTesting.maximumReviewFocusCharacters + 1)
    })).toThrow(/4000/u);
  });
});
