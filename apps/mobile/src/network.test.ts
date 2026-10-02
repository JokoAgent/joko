import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import {
  ArtifactKind,
  ArtifactSchema,
  BlobDisposition,
  BlobRefSchema,
  BlobTransferTicketSchema,
  FileKind,
  FilePreviewSchema,
  FileRevisionSchema,
  PendingBlobUploadSchema,
  ResourceKind,
  ScheduleRunHistorySchema,
  ScheduleSchema,
  SessionMessageSearchMatchSchema,
  SessionResourceSchema,
  TextFilePreviewSchema,
  TransferDirection,
  VoiceInputDictionaryEntrySource,
  VoiceInputDictionaryLearningActionType,
  VoiceInputDictionaryLearningConfidence,
  VoiceInputDictionaryTermType,
  VoiceInputDictionarySnapshotSchema,
  GetVoiceInputDictionaryResponseSchema,
  WatchVoiceInputDictionaryResponseSchema,
  WatchVoiceInputDictionaryPeerStatusResponseSchema,
  WatchVoiceInputDictionaryReadOnlyResponseSchema,
  VoiceInputDictionaryPeerPhase,
  SetVoiceInputDictionarySyncEnabledResponseSchema,
  AddVoiceInputDictionaryTermsResponseSchema,
  EditVoiceInputDictionaryEntryResponseSchema,
  DeleteVoiceInputDictionaryEntryResponseSchema,
  ApplyVoiceInputDictionaryLearningResponseSchema,
  AddVoiceInputDictionaryTermsRequestSchema,
  ApplyVoiceInputDictionaryLearningRequestSchema,
  ConfigureVoiceInputDictionaryListenerResponseSchema,
  ConfigureVoiceInputDictionaryListenerRequestSchema,
  GetVoiceInputDictionaryPeerInvitationResponseSchema,
  GrantVoiceInputDictionaryDirectPeerResponseSchema,
  GrantVoiceInputDictionaryDirectPeerRequestSchema,
  ClearVoiceInputDictionaryPeerRouteResponseSchema,
  ClearVoiceInputDictionaryPeerRouteRequestSchema,
  WorkspaceEntrySchema,
  WorkspaceSearchMatchSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES,
  MOBILE_FILE_SHARE_MAXIMUM_BYTES,
  assertMaterializedWorkspaceBlob,
  assertSessionResourceCatalog,
  assertWorkspaceFilePreview,
  authorizeVerifiedBlobDownload,
  collectArtifactPages,
  collectArtifactReferencePages,
  collectSchedulePages,
  collectTargetWorktreeSourcePages,
  collectSessionMessageSearchPages,
  collectWorkspaceDirectoryPages,
  collectWorkspaceSearchPages,
  downloadVerifiedBlob,
  uploadVerifiedBlob,
  validateScheduleHistoryPage,
  mobileVoiceNetworkTesting,
  mobileNetwork,
  type PairedCredential
} from "./network";
import { projectMobileVoiceDictionarySnapshot, mobileVoiceDictionaryLearningRequest } from "./mobile-voice-dictionary-service";

describe("mobile voice ephemeral requests", () => {
  it("uses generated direct-route requests with separate revision and fingerprint confirmation and validates the public invitation", async () => {
    const listener = { listenPort: 43_121, host: "self.example", port: 44_121 };
    const status = { available: true, configurationRevision: 4n, nodeId: "node-a", fingerprint: "a".repeat(64), enabled: true,
      phase: VoiceInputDictionaryPeerPhase.WAITING, listener,
      peers: [{ peerId: "node-b", revision: 3n, displayName: "Peer", fingerprint: "b".repeat(64), online: false,
        grantedAt: { seconds: 1n }, route: { host: "peer.example", port: 43_121 } }] };
    let invitation = JSON.stringify({ version: 1, nodeId: "node-a", displayName: "Node", publicKey: "MCowBQYDK2VuAyEA" + "A".repeat(43) + "=",
      fingerprint: "a".repeat(64), host: listener.host, port: listener.port });
    const calls: Array<{ method: string; body: Uint8Array }> = [];
    const credential: PairedCredential = { profileId: "direct-profile", origin: "https://node.example", serverId: "node-a", connectionId: "direct-connection",
      deviceId: "direct-phone", displayName: "Phone", authKey: "direct-test-key" };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer direct-test-key");
      const method = request.url.slice(request.url.lastIndexOf("/") + 1);
      calls.push({ method, body: new Uint8Array(await request.arrayBuffer()) });
      const responses = {
        ConfigureVoiceInputDictionaryListener: toBinary(ConfigureVoiceInputDictionaryListenerResponseSchema, create(ConfigureVoiceInputDictionaryListenerResponseSchema, { status })),
        GetVoiceInputDictionaryPeerInvitation: toBinary(GetVoiceInputDictionaryPeerInvitationResponseSchema, create(GetVoiceInputDictionaryPeerInvitationResponseSchema, { invitation })),
        GrantVoiceInputDictionaryDirectPeer: toBinary(GrantVoiceInputDictionaryDirectPeerResponseSchema, create(GrantVoiceInputDictionaryDirectPeerResponseSchema, { status })),
        ClearVoiceInputDictionaryPeerRoute: toBinary(ClearVoiceInputDictionaryPeerRouteResponseSchema, create(ClearVoiceInputDictionaryPeerRouteResponseSchema, { status }))
      };
      const bytes = responses[method as keyof typeof responses];
      if (!bytes) throw new Error("Unexpected direct dictionary RPC.");
      return new Response(bytes, { status: 200, headers: { "content-type": "application/proto" } });
    });
    try {
      await expect(mobileNetwork.configureVoiceInputDictionaryListener(credential, 3n, listener)).resolves.toMatchObject({ listener, peers: [{ online: false, route: { host: "peer.example", port: 43_121 } }] });
      await expect(mobileNetwork.getVoiceInputDictionaryPeerInvitation(credential)).resolves.toBe(invitation);
      await mobileNetwork.grantVoiceInputDictionaryDirectPeer(credential, 4n, invitation, "a".repeat(64));
      await mobileNetwork.clearVoiceInputDictionaryPeerRoute(credential, 4n, "node-b");
      await mobileNetwork.configureVoiceInputDictionaryListener(credential, 4n, undefined);
      expect(fromBinary(ConfigureVoiceInputDictionaryListenerRequestSchema, calls[0]!.body)).toMatchObject({ expectedConfigurationRevision: 3n, listener });
      expect(fromBinary(GrantVoiceInputDictionaryDirectPeerRequestSchema, calls[2]!.body)).toMatchObject({ expectedConfigurationRevision: 4n, invitation, expectedFingerprint: "a".repeat(64) });
      expect(fromBinary(ClearVoiceInputDictionaryPeerRouteRequestSchema, calls[3]!.body)).toMatchObject({ expectedConfigurationRevision: 4n, peerId: "node-b" });
      expect(fromBinary(ConfigureVoiceInputDictionaryListenerRequestSchema, calls[4]!.body).listener).toBeUndefined();
      invitation = JSON.stringify({ version: 1, authKey: "private" });
      await expect(mobileNetwork.getVoiceInputDictionaryPeerInvitation(credential)).rejects.toThrow(/invalid/u);
    } finally { fetch.mockRestore(); }
  });
  it.each(["content", "sharing", "readonly"] as const)("decodes the generated %s stream and cancels its HTTP owner after a duplicate sequence or consumer return", async (kind) => {
    const signals: AbortSignal[] = [];
    const credential: PairedCredential = { profileId: "voice-profile", origin: "https://node.example", serverId: "voice-server", connectionId: "voice-connection", deviceId: "voice-device", displayName: "Voice phone", authKey: "voice-test-key" };
    const content = create(WatchVoiceInputDictionaryResponseSchema, { sequence: 1n, dictionary: dictionaryWireSnapshot() });
    const sharing = create(WatchVoiceInputDictionaryPeerStatusResponseSchema, { sequence: 1n, status: { available: true,
      configurationRevision: 3n, nodeId: "voice-server", fingerprint: "a".repeat(64), enabled: true, phase: VoiceInputDictionaryPeerPhase.WAITING } });
    const readonly = create(WatchVoiceInputDictionaryReadOnlyResponseSchema, { sequence: 1n, dictionary: {
      revision: 4n, syncEnabled: false, entries: [], stateVector: { versions: [{ nodeId: "a", stamp: "0000000001.0000.a" }] }
    } });
    const message = kind === "content" ? toBinary(WatchVoiceInputDictionaryResponseSchema, content)
      : kind === "sharing" ? toBinary(WatchVoiceInputDictionaryPeerStatusResponseSchema, sharing)
        : toBinary(WatchVoiceInputDictionaryReadOnlyResponseSchema, readonly);
    const frame = new Uint8Array(5 + message.byteLength);
    new DataView(frame.buffer).setUint32(1, message.byteLength); frame.set(message, 5);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init); signals.push(request.signal);
      expect(request.headers.get("authorization")).toBe("Bearer voice-test-key");
      expect(request.url).toMatch(kind === "content" ? /\/WatchVoiceInputDictionary$/u
        : kind === "sharing" ? /\/WatchVoiceInputDictionaryPeerStatus$/u : /\/WatchVoiceInputDictionaryReadOnly$/u);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(frame); controller.enqueue(frame);
        request.signal.addEventListener("abort", () => controller.close(), { once: true });
      } }), { status: 200, headers: { "content-type": "application/connect+proto" } });
    });
    const request = new AbortController();
    const watch = () => kind === "content" ? mobileNetwork.watchVoiceInputDictionary(credential, request.signal)
      : kind === "sharing" ? mobileNetwork.watchVoiceInputDictionaryPeerStatus(credential, request.signal)
        : mobileNetwork.watchVoiceInputDictionaryReadOnly(credential, request.signal);
    try {
      const stream = watch()[Symbol.asyncIterator]();
      await expect(stream.next()).resolves.toMatchObject({ done: false, value: kind === "sharing" ? { configurationRevision: 3n } : { revision: 4n } });
      await expect(stream.next()).rejects.toThrow(/invalid/u);
      expect(signals[0]!.aborted).toBe(true);
      const resumed = watch()[Symbol.asyncIterator]();
      await expect(resumed.next()).resolves.toMatchObject({ done: false });
      await resumed.return?.();
      expect(signals[1]!.aborted).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally { request.abort(); fetch.mockRestore(); }
  });
  it("maps all generated dictionary RPCs with one credential and semantic expected revisions", async () => {
    const dictionary = dictionaryWireSnapshot();
    const responses = [
      ["GetVoiceInputDictionary", toBinary(GetVoiceInputDictionaryResponseSchema, create(GetVoiceInputDictionaryResponseSchema, { dictionary }))],
      ["SetVoiceInputDictionarySyncEnabled", toBinary(SetVoiceInputDictionarySyncEnabledResponseSchema, create(SetVoiceInputDictionarySyncEnabledResponseSchema, { dictionary }))],
      ["AddVoiceInputDictionaryTerms", toBinary(AddVoiceInputDictionaryTermsResponseSchema, create(AddVoiceInputDictionaryTermsResponseSchema, { dictionary }))],
      ["EditVoiceInputDictionaryEntry", toBinary(EditVoiceInputDictionaryEntryResponseSchema, create(EditVoiceInputDictionaryEntryResponseSchema, { dictionary }))],
      ["DeleteVoiceInputDictionaryEntry", toBinary(DeleteVoiceInputDictionaryEntryResponseSchema, create(DeleteVoiceInputDictionaryEntryResponseSchema, { dictionary }))],
      ["ApplyVoiceInputDictionaryLearning", toBinary(ApplyVoiceInputDictionaryLearningResponseSchema, create(ApplyVoiceInputDictionaryLearningResponseSchema, { dictionary }))]
    ] as const;
    const requests: Array<{ method: string; body: Uint8Array }> = [];
    const credential: PairedCredential = { profileId: "voice-profile", origin: "https://node.example", serverId: "voice-server", connectionId: "voice-connection", deviceId: "voice-device", displayName: "Voice phone", authKey: "voice-test-key" };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer voice-test-key");
      const response = responses.find(([method]) => request.url.endsWith(`/${method}`));
      if (!response) throw new Error("Unexpected dictionary RPC.");
      requests.push({ method: response[0], body: new Uint8Array(await request.arrayBuffer()) });
      return new Response(response[1], { status: 200, headers: { "content-type": "application/proto" } });
    });
    const actions = [{ action: "addCandidate", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high" }] as const;
    try {
      await expect(mobileNetwork.getVoiceInputDictionary(credential)).resolves.toMatchObject({
        revision: 4n, syncEnabled: true, dictionary: { entries: [{ id: "dictionary-one", text: "Joko", source: "manual", frequency: 2 }] }, refinementTerms: ["Joko"]
      });
      await mobileNetwork.setVoiceInputDictionarySyncEnabled(credential, 4n, false);
      await mobileNetwork.addVoiceInputDictionaryTerms(credential, 4n, ["Joko Core"]);
      await mobileNetwork.editVoiceInputDictionaryEntry(credential, 4n, "dictionary-one", "Joko Core", ["jo ko"]);
      await mobileNetwork.deleteVoiceInputDictionaryEntry(credential, 4n, "dictionary-one");
      await mobileNetwork.applyVoiceInputDictionaryLearning(credential, 4n, actions);
      expect(requests.map((request) => request.method)).toEqual(responses.map(([method]) => method));
      expect(fromBinary(AddVoiceInputDictionaryTermsRequestSchema, requests[2]!.body)).toMatchObject({ expectedRevision: 4n, terms: ["Joko Core"] });
      const learning = fromBinary(ApplyVoiceInputDictionaryLearningRequestSchema, requests[5]!.body);
      expect(learning).toMatchObject({ expectedRevision: 4n, actions: [{ action: VoiceInputDictionaryLearningActionType.ADD_CANDIDATE, termType: VoiceInputDictionaryTermType.PRODUCT_NAME, confidence: VoiceInputDictionaryLearningConfidence.HIGH }] });
      expect(Object.keys(learning).sort()).toEqual(["$typeName", "actions", "expectedRevision"]);
    } finally { fetch.mockRestore(); }
  });

  it.each(["missing", "revision", "source", "count", "timestamp", "duplicate", "refinement", "canonical"] as const)("rejects a service dictionary with invalid %s", (invalid) => {
    const value = dictionaryWireSnapshot();
    if (invalid === "revision") value.revision = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    if (invalid === "source") value.entries[0]!.source = VoiceInputDictionaryEntrySource.UNSPECIFIED;
    if (invalid === "count") value.entries[0]!.frequency = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    if (invalid === "timestamp") value.entries[0]!.updatedAt = undefined;
    if (invalid === "duplicate") value.entries.push(value.entries[0]!);
    if (invalid === "refinement") value.refinementTerms = ["NotInDictionary"];
    if (invalid === "canonical") value.entries[0]!.text = " Joko ";
    expect(() => projectMobileVoiceDictionarySnapshot(invalid === "missing" ? undefined : value)).toThrow(/dictionary/u);
  });

  it("preserves manual intent under automatic suppression and rejects malformed learning actions", () => {
    const value = dictionaryWireSnapshot(); value.suppressedAutomaticTerms = ["Joko"];
    expect(projectMobileVoiceDictionarySnapshot(value).dictionary).toMatchObject({ entries: [{ text: "Joko", source: "manual" }], suppressedAutomaticTexts: ["Joko"] });
    expect(() => mobileVoiceDictionaryLearningRequest([])).toThrow(/action count/u);
    const action = { action: "addEntry", term: "Joko", aliases: [], type: "productName", confidence: "high" } as const;
    expect(() => mobileVoiceDictionaryLearningRequest([action, action, action, action])).toThrow(/action count/u);
    expect(() => mobileVoiceDictionaryLearningRequest([{ ...action, action: "constructor" as typeof action.action }])).toThrow(/learning action/u);
  });

  it("projects ephemeral evidence and instructions without a client dictionary override", () => {
    expect(mobileVoiceNetworkTesting.adviceRequest({
      beforeText: "voice kit",
      afterText: "VoiceKit",
      rawTranscriptText: "voice kid",
      locale: "en-US",
      existingEntries: [{ term: "Existing", source: "automatic", frequency: 2,
        aliases: [{ text: "existing", count: 1 }] }],
      existingCandidates: [{ term: "Candidate", evidenceCount: 3, aliases: [] }]
    })).toEqual({
      beforeText: "voice kit",
      afterText: "VoiceKit",
      rawTranscriptText: "voice kid",
      locale: "en-US",
      existingEntries: [{ term: "Existing", source: VoiceInputDictionaryEntrySource.AUTOMATIC, frequency: 2,
        aliases: [{ text: "existing", count: 1 }] }],
      existingCandidates: [{ term: "Candidate", evidenceCount: 3, aliases: [] }]
    });
    expect(mobileVoiceNetworkTesting.startRequest("request", "audio/pcm", "en-US", {
      instructions: "Keep commands verbatim."
    })).toEqual({
      requestId: "request", mimeType: "audio/pcm", locale: "en-US",
      refinementInstructions: "Keep commands verbatim."
    });
    expect(mobileVoiceNetworkTesting.startRequest("request", "audio/pcm", undefined, undefined))
      .toEqual({ requestId: "request", mimeType: "audio/pcm" });
  });

  it("fails closed on malformed or unspecified advisor actions", () => {
    expect(mobileVoiceNetworkTesting.projectAction({
      action: VoiceInputDictionaryLearningActionType.ADD_ENTRY,
      term: " VoiceKit ",
      aliases: [" voice kit "],
      termType: VoiceInputDictionaryTermType.PRODUCT_NAME,
      confidence: VoiceInputDictionaryLearningConfidence.HIGH
    })).toEqual({
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    });
    expect(() => mobileVoiceNetworkTesting.projectAction({
      action: VoiceInputDictionaryLearningActionType.UNSPECIFIED,
      term: "VoiceKit",
      aliases: ["voice kit"],
      termType: VoiceInputDictionaryTermType.PRODUCT_NAME,
      confidence: VoiceInputDictionaryLearningConfidence.HIGH
    })).toThrow(/unspecified voice dictionary action/i);
    expect(() => mobileVoiceNetworkTesting.projectAction({
      action: VoiceInputDictionaryLearningActionType.ADD_ENTRY,
      term: "VoiceKit",
      aliases: [],
      termType: VoiceInputDictionaryTermType.PRODUCT_NAME,
      confidence: VoiceInputDictionaryLearningConfidence.HIGH
    })).toThrow(/invalid voice dictionary aliases/i);
    expect(() => mobileVoiceNetworkTesting.projectAction({
      action: 99 as VoiceInputDictionaryLearningActionType,
      term: "VoiceKit",
      aliases: ["voice kit"],
      termType: VoiceInputDictionaryTermType.PRODUCT_NAME,
      confidence: VoiceInputDictionaryLearningConfidence.HIGH
    })).toThrow(/invalid voice dictionary action/i);
    expect(() => mobileVoiceNetworkTesting.adviceRequest({
      beforeText: "b".repeat(2_001), afterText: "VoiceKit", existingEntries: [], existingCandidates: []
    })).toThrow(/ephemeral request limit/i);
  });

  it("accepts only bounded advisor actions grounded in the exact correction", () => {
    const draft = {
      beforeText: "Use voice kit today", afterText: "Use VoiceKit today",
      rawTranscriptText: "use voice kid today", existingEntries: [], existingCandidates: []
    } as const;
    const action = {
      action: VoiceInputDictionaryLearningActionType.ADD_ENTRY,
      term: "VoiceKit",
      aliases: ["voice kit"],
      termType: VoiceInputDictionaryTermType.PRODUCT_NAME,
      confidence: VoiceInputDictionaryLearningConfidence.HIGH
    } as const;
    expect(mobileVoiceNetworkTesting.projectAdvice([action], draft)).toMatchObject([{ term: "VoiceKit" }]);
    expect(() => mobileVoiceNetworkTesting.projectAdvice([{ ...action, term: "Other" }], draft))
      .toThrow(/ungrounded voice dictionary evidence/i);
    expect(() => mobileVoiceNetworkTesting.projectAdvice([{ ...action, aliases: ["unheard"] }], draft))
      .toThrow(/ungrounded voice dictionary evidence/i);
    expect(() => mobileVoiceNetworkTesting.projectAdvice([action, action, action, action], draft))
      .toThrow(/too many voice dictionary actions/i);
  });
});

function dictionaryWireSnapshot() {
  return create(VoiceInputDictionarySnapshotSchema, {
    revision: 4n, syncEnabled: true,
    entries: [{ entryId: "dictionary-one", text: "Joko", source: VoiceInputDictionaryEntrySource.MANUAL, frequency: 2n,
      aliases: [{ text: "jo ko", count: 1n, lastSeenAt: { seconds: 1n, nanos: 0 } }],
      createdAt: { seconds: 1n, nanos: 0 }, updatedAt: { seconds: 2n, nanos: 0 } }],
    candidates: [], suppressedAutomaticTerms: [], refinementTerms: ["Joko"]
  });
}

function matches(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => create(SessionMessageSearchMatchSchema, {
    sessionId: `session-${offset + index}`,
    eventId: `event-${offset + index}`
  }));
}

describe("mobile message-search paging", () => {
  it("collects every authoritative page in order", async () => {
    const readPage = vi.fn(async (pageToken: string) => pageToken === ""
      ? { matches: matches(100), nextPageToken: "page-2", totalSize: 101n }
      : { matches: matches(1, 100), nextPageToken: "", totalSize: 101n });

    const result = await collectSessionMessageSearchPages(readPage);

    expect(readPage.mock.calls).toEqual([[""], ["page-2"]]);
    expect(result).toHaveLength(101);
    expect(result[100]?.sessionId).toBe("session-100");
  });

  it("rejects repeated cursors instead of looping or accepting partial results", async () => {
    const readPage = vi.fn(async (pageToken: string) => ({
      matches: matches(100, pageToken === "" ? 0 : 100),
      nextPageToken: "repeat",
      totalSize: 201n
    }));

    await expect(collectSessionMessageSearchPages(readPage)).rejects.toThrow("invalid message-search page sequence");
    expect(readPage).toHaveBeenCalledTimes(2);
  });
});

describe("mobile Automation paging", () => {
  it("collects every Schedule page with one stable total and unique identity", async () => {
    const first = create(ScheduleSchema, { scheduleId: "schedule-1" });
    const second = create(ScheduleSchema, { scheduleId: "schedule-2" });
    const readPage = vi.fn(async (token: string) => token === ""
      ? { schedules: [first], nextPageToken: "next", totalSize: 2n }
      : { schedules: [second], nextPageToken: "", totalSize: 2n });

    await expect(collectSchedulePages(readPage)).resolves.toEqual([first, second]);
    expect(readPage.mock.calls).toEqual([[""], ["next"]]);
  });

  it("rejects Schedule cursor cycles, total drift, duplicates and incomplete results", async () => {
    const value = create(ScheduleSchema, { scheduleId: "schedule" });
    await expect(collectSchedulePages(async (token) => ({
      schedules: [token === "" ? value : create(ScheduleSchema, { scheduleId: "other" })],
      nextPageToken: "repeat",
      totalSize: 3n
    }))).rejects.toThrow(/cyclic Automation catalog/);
    await expect(collectSchedulePages(async (token) => token === ""
      ? { schedules: [value], nextPageToken: "next", totalSize: 2n }
      : { schedules: [create(ScheduleSchema, { scheduleId: "other" })], nextPageToken: "", totalSize: 3n }))
      .rejects.toThrow(/changed while paging/);
    await expect(collectSchedulePages(async () => ({
      schedules: [value, value], nextPageToken: "", totalSize: 2n
    }))).rejects.toThrow(/duplicate or missing/);
    await expect(collectSchedulePages(async () => ({
      schedules: [value], nextPageToken: "", totalSize: 2n
    }))).rejects.toThrow(/incomplete Automation catalog/);
    await expect(collectSchedulePages(async () => ({
      schedules: [value], nextPageToken: "bad\u0001cursor", totalSize: 2n
    }))).rejects.toThrow(/invalid Automation catalog metadata/);
  });

  it("validates history cursor metadata and page-local trigger identity", () => {
    const item = create(ScheduleRunHistorySchema, { triggerId: "trigger" });
    expect(validateScheduleHistoryPage("schedule", "", {
      history: [item], nextPageToken: "next", totalSize: 2n
    })).toEqual({ history: [item], nextPageToken: "next", totalSize: 2 });
    expect(() => validateScheduleHistoryPage("schedule", "next", {
      history: [item], nextPageToken: "next", totalSize: 2n
    })).toThrow(/invalid Automation history page metadata/);
    expect(() => validateScheduleHistoryPage("schedule", "", {
      history: [item, item], nextPageToken: "", totalSize: 2n
    })).toThrow(/duplicate or missing/);
    expect(() => validateScheduleHistoryPage("schedule", "", {
      history: [item], nextPageToken: "x".repeat(4_097), totalSize: 2n
    })).toThrow(/invalid Automation history page metadata/);
  });

  it("collects complete Worktree sources and rejects duplicate refs", async () => {
    const first = { ref: "refs/heads/main", commit: "abc", displayName: "main", remote: false, current: true };
    const second = { ref: "refs/remotes/origin/release", commit: "def", displayName: "origin/release", remote: true, current: false };
    await expect(collectTargetWorktreeSourcePages(async (token) => token === ""
      ? { sources: [first], nextPageToken: "next", totalSize: 2n }
      : { sources: [second], nextPageToken: "", totalSize: 2n })).resolves.toEqual([first, second]);
    await expect(collectTargetWorktreeSourcePages(async () => ({
      sources: [first, first], nextPageToken: "", totalSize: 2n
    }))).rejects.toThrow(/duplicate or invalid Worktree source/);
  });
});

describe("mobile Workspace and Artifact paging", () => {
  it("collects a complete stable hidden-inclusive document directory", async () => {
    const first = create(WorkspaceEntrySchema, {
      workspaceId: "workspace", relativePath: ".hidden", displayName: ".hidden",
      kind: FileKind.REGULAR, hidden: true, revision: { opaqueRevision: "file-1", byteSize: 1n }
    });
    const second = create(WorkspaceEntrySchema, {
      workspaceId: "workspace", relativePath: "folder", displayName: "folder", kind: FileKind.DIRECTORY
    });
    const readPage = vi.fn(async (token: string) => token === ""
      ? { entries: [first], nextPageToken: "second", totalSize: 2n, revision: "directory-4" }
      : { entries: [second], nextPageToken: "", totalSize: 2n, revision: "directory-4" });

    await expect(collectWorkspaceDirectoryPages("workspace", "", readPage)).resolves.toEqual({
      entries: [first, second], revision: "directory-4"
    });
    expect(readPage.mock.calls).toEqual([[""], ["second"]]);
  });

  it("rejects directory revision drift, duplicate paths and incomplete pagination", async () => {
    const entry = create(WorkspaceEntrySchema, {
      workspaceId: "workspace", relativePath: "file.txt", kind: FileKind.REGULAR,
      revision: { opaqueRevision: "file-1" }
    });
    await expect(collectWorkspaceDirectoryPages("workspace", "", async (token) => token === ""
      ? { entries: [entry], nextPageToken: "next", totalSize: 2n, revision: "one" }
      : { entries: [entry], nextPageToken: "", totalSize: 2n, revision: "two" }))
      .rejects.toThrow(/changed while paging/);
    await expect(collectWorkspaceDirectoryPages("workspace", "", async () => ({
      entries: [entry], nextPageToken: "", totalSize: 2n, revision: "one"
    }))).rejects.toThrow(/incomplete workspace directory/);
    await expect(collectWorkspaceDirectoryPages("workspace", "", async () => ({
      entries: [entry, entry], nextPageToken: "", totalSize: 2n, revision: "one"
    }))).rejects.toThrow(/invalid workspace directory/);
  });

  it("collects literal content matches only under one stable revision and cursor sequence", async () => {
    const revision = create(FileRevisionSchema, { opaqueRevision: "file-7", byteSize: 12n });
    const match = create(WorkspaceSearchMatchSchema, { relativePath: "src/a+b.ts", revision, linePreview: "a+b" });
    const result = await collectWorkspaceSearchPages("workspace", async () => ({
      matches: [match], nextPageToken: "", totalSize: 1n, revision: "search-8", truncated: true, totalFiles: 1n
    }));
    expect(result).toEqual({ matches: [match], revision: "search-8", truncated: true, totalFiles: 1 });

    await expect(collectWorkspaceSearchPages("workspace", async () => ({
      matches: [match], nextPageToken: "same", totalSize: 2n, revision: "search-8", truncated: false, totalFiles: 2n
    }))).rejects.toThrow(/cyclic workspace-search page token/);
  });

  it("accepts only canonical Artifacts owned by the requested task", async () => {
    const artifact = create(ArtifactSchema, {
      artifactId: "artifact-1", sessionId: "session", kind: ArtifactKind.FILE, title: "Export"
    });
    await expect(collectArtifactPages("session", async () => ({
      artifacts: [artifact], nextPageToken: "", totalSize: 1n, revision: "artifacts-1"
    }))).resolves.toEqual({ artifacts: [artifact], revision: "artifacts-1" });
    await expect(collectArtifactPages("other", async () => ({
      artifacts: [artifact], nextPageToken: "", totalSize: 1n, revision: "artifacts-1"
    }))).rejects.toThrow(/invalid Artifact catalog/);
  });

  it("accepts only exact unique live-task Resource catalog identities", () => {
    const resource = create(SessionResourceSchema, {
      sessionId: "session", resourceId: "resource", kind: ResourceKind.SKILL, name: "Skill", version: "1.0.0",
      discoveredRevision: "sha256:resource", resourceVersion: 7n, runtimeGeneration: 9n
    });
    expect(assertSessionResourceCatalog("session", [resource])).toEqual([resource]);
    expect(() => assertSessionResourceCatalog("other", [resource])).toThrow(/invalid task Resource catalog/);
    expect(() => assertSessionResourceCatalog("session", [resource, resource])).toThrow(/invalid task Resource catalog/);
    expect(() => assertSessionResourceCatalog("session", [create(SessionResourceSchema, {
      ...resource, discoveredRevision: " revision"
    })])).toThrow(/invalid task Resource catalog/);
    expect(() => assertSessionResourceCatalog("session", [create(SessionResourceSchema, {
      ...resource, kind: ResourceKind.THEME
    })])).toThrow(/invalid task Resource catalog/);
  });

  it("collects a stable cross-task Artifact reference catalog and filters expired entries", async () => {
    const active = artifactReference("active", "source-one", { seconds: 100n });
    const expired = artifactReference("expired", "source-two", { seconds: 9n });
    const result = await collectArtifactReferencePages(async () => ({
      artifacts: [active, expired], nextPageToken: "", totalSize: 2n, revision: "references-4"
    }), 10_000);

    expect(result).toEqual({ artifacts: [active], revision: "references-4" });
  });

  it("retries Artifact reference revision drift once and rejects cycles and duplicate exact identities", async () => {
    const first = artifactReference("first", "source");
    const second = artifactReference("second", "source");
    let attempt = 0;
    const readPage = vi.fn(async (token: string) => {
      if (token === "") {
        attempt += 1;
        return { artifacts: [first], nextPageToken: "next", totalSize: 2n, revision: `revision-${attempt}` };
      }
      return { artifacts: [second], nextPageToken: "", totalSize: 2n,
        revision: attempt === 1 ? "drifted" : `revision-${attempt}` };
    });
    await expect(collectArtifactReferencePages(readPage)).resolves.toEqual({
      artifacts: [first, second], revision: "revision-2"
    });
    expect(readPage.mock.calls).toEqual([[""], ["next"], [""], ["next"]]);

    await expect(collectArtifactReferencePages(async () => ({
      artifacts: [first], nextPageToken: "repeat", totalSize: 3n, revision: "stable"
    }))).rejects.toThrow(/cyclic Artifact reference catalog page token/);
    await expect(collectArtifactReferencePages(async () => ({
      artifacts: [first, first], nextPageToken: "", totalSize: 2n, revision: "stable"
    }))).rejects.toThrow(/invalid Artifact reference catalog identity/);
  });

  it("requires the response to match every field of the observed FileRevision", () => {
    const revision = create(FileRevisionSchema, {
      opaqueRevision: "file-9", sha256Hex: "a".repeat(64), byteSize: 4n,
      modifiedAt: { seconds: 10n, nanos: 12 }
    });
    const preview = create(FilePreviewSchema, {
      entry: { workspaceId: "workspace", relativePath: "src/file.txt", kind: FileKind.REGULAR,
        mediaType: "text/plain", revision },
      content: { case: "text", value: { utf8Text: "test", startByte: 0n, endByte: 4n, totalLines: 1 } }
    });
    expect(assertWorkspaceFilePreview("workspace", "src/file.txt", revision, preview)).toBe(preview);
    expect(() => assertWorkspaceFilePreview("workspace", "src/file.txt", create(FileRevisionSchema, {
      ...revision, byteSize: 5n
    }), preview)).toThrow(/mismatched workspace file preview/);

    const listed = create(FileRevisionSchema, {
      opaqueRevision: "meta:listed", byteSize: 4n, modifiedAt: revision.modifiedAt
    });
    const digest = "b".repeat(64);
    const contentRevision = create(FileRevisionSchema, {
      opaqueRevision: `sha256:${digest}:4`, sha256Hex: digest, byteSize: 4n,
      modifiedAt: revision.modifiedAt
    });
    const upgraded = create(FilePreviewSchema, {
      entry: create(WorkspaceEntrySchema, { ...preview.entry!, revision: contentRevision }),
      content: preview.content
    });
    expect(assertWorkspaceFilePreview("workspace", "src/file.txt", listed, upgraded)).toBe(upgraded);
    expect(() => assertWorkspaceFilePreview("workspace", "src/file.txt", listed, create(FilePreviewSchema, {
      entry: create(WorkspaceEntrySchema, {
        ...preview.entry!,
        revision: create(FileRevisionSchema, {
          ...contentRevision,
          opaqueRevision: `sha256:${"d".repeat(64)}:4`
        })
      }),
      content: preview.content
    }))).toThrow(/mismatched workspace file preview/);
    expect(() => assertWorkspaceFilePreview("workspace", "src/file.txt", create(FileRevisionSchema, {
      ...listed, sha256Hex: "c".repeat(64)
    }), upgraded)).toThrow(/mismatched workspace file preview/);
  });

  it("accepts only a complete content-addressed Workspace Blob", () => {
    const digest = "b".repeat(64);
    const listed = create(FileRevisionSchema, {
      opaqueRevision: "meta:listed", byteSize: 4n, modifiedAt: { seconds: 10n }
    });
    const contentRevision = create(FileRevisionSchema, {
      opaqueRevision: `sha256:${digest}:4`, sha256Hex: digest, byteSize: 4n,
      modifiedAt: listed.modifiedAt
    });
    const blob = create(BlobRefSchema, {
      blobId: "blob-workspace", fileName: "file.txt", mediaType: "text/plain",
      byteSize: 4n, sha256Hex: digest
    });
    const preview = create(FilePreviewSchema, {
      entry: {
        workspaceId: "workspace", relativePath: "src/file.txt", displayName: "file.txt",
        kind: FileKind.REGULAR, mediaType: "text/plain", revision: contentRevision
      },
      content: { case: "blob", value: blob }
    });

    expect(assertMaterializedWorkspaceBlob("workspace", "src/file.txt", listed, preview)).toEqual({
      entry: preview.entry,
      blob
    });
    expect(() => assertMaterializedWorkspaceBlob("workspace", "src/file.txt", listed, create(FilePreviewSchema, {
      ...preview,
      truncated: true
    }))).toThrow(/mismatched complete Workspace Blob/);
    expect(() => assertMaterializedWorkspaceBlob("workspace", "src/file.txt", listed, create(FilePreviewSchema, {
      ...preview,
      content: { case: "text", value: create(TextFilePreviewSchema, {
        utf8Text: "test", startByte: 0n, endByte: 4n, totalLines: 1
      }) }
    }))).toThrow(/mismatched complete Workspace Blob/);
    expect(() => assertMaterializedWorkspaceBlob("workspace", "src/file.txt", listed, create(FilePreviewSchema, {
      ...preview,
      content: { case: "blob", value: create(BlobRefSchema, { ...blob, mediaType: "application/json" }) }
    }))).toThrow(/mismatched complete Workspace Blob/);
  });
});

function artifactReference(
  artifactId: string,
  sessionId: string,
  expiresAt?: { readonly seconds: bigint; readonly nanos?: number }
) {
  return create(ArtifactSchema, {
    artifactId,
    sessionId,
    kind: ArtifactKind.TOOL_RESULT,
    title: `${artifactId}.txt`,
    blob: create(BlobRefSchema, {
      blobId: `blob-${artifactId}`,
      fileName: `${artifactId}.txt`,
      mediaType: "text/plain",
      byteSize: 4n,
      sha256Hex: "a".repeat(64)
    }),
    createdAt: { seconds: 1n },
    ...(expiresAt === undefined ? {} : { expiresAt })
  });
}

describe("authenticated mobile Blob downloads", () => {
  const hash = "b".repeat(64);
  const blob = create(BlobRefSchema, {
    blobId: "blob-1", fileName: "image.png", mediaType: "image/png", byteSize: 4n, sha256Hex: hash
  });
  const ticket = create(BlobTransferTicketSchema, {
    ticketId: "ticket-1", blobId: blob.blobId, direction: TransferDirection.DOWNLOAD,
    relativeEndpoint: "/v1/blobs/ticket-1", maximumBytes: blob.byteSize, requiredMediaType: blob.mediaType,
    expiresAt: { seconds: 4_102_444_800n }
  });
  const response = (body = new Uint8Array([1, 2, 3, 4]), mediaType = "image/png", length = "4") => new Response(body, {
    status: 200, headers: { "content-type": mediaType, "content-length": length }
  });

  it("uses an authenticated same-origin one-time endpoint and verifies length, MIME and SHA-256", async () => {
    const fetcher = vi.fn(async () => response());
    const result = await downloadVerifiedBlob(
      { origin: "https://node.example", authKey: "secret" },
      blob,
      ticket,
      undefined,
      fetcher as unknown as typeof fetch,
      async () => hash
    );

    expect(result).toEqual({ bytes: new Uint8Array([1, 2, 3, 4]), mediaType: "image/png" });
    expect(fetcher).toHaveBeenCalledWith("https://node.example/v1/blobs/ticket-1", expect.objectContaining({
      headers: { authorization: "Bearer secret" }, cache: "no-store"
    }));
  });

  it("fails closed before display for ticket, endpoint, response and digest mismatches", async () => {
    const fetcher = vi.fn(async () => response());
    await expect(downloadVerifiedBlob({ origin: "https://node.example", authKey: "secret" }, blob,
      create(BlobTransferTicketSchema, { ...ticket, blobId: "other" }), undefined,
      fetcher as unknown as typeof fetch, async () => hash)).rejects.toThrow(/mismatched Blob download ticket/);
    await expect(downloadVerifiedBlob({ origin: "https://node.example", authKey: "secret" }, blob,
      create(BlobTransferTicketSchema, { ...ticket, relativeEndpoint: "//evil.example/blob" }), undefined,
      fetcher as unknown as typeof fetch, async () => hash)).rejects.toThrow(/non-root-relative Blob endpoint/);
    await expect(downloadVerifiedBlob({ origin: "https://node.example", authKey: "secret" }, blob, ticket, undefined,
      vi.fn(async () => response(undefined, "text/plain")) as unknown as typeof fetch, async () => hash))
      .rejects.toThrow(/media type/);
    await expect(downloadVerifiedBlob({ origin: "https://node.example", authKey: "secret" }, blob, ticket, undefined,
      vi.fn(async () => response(undefined, "image/png", "5")) as unknown as typeof fetch, async () => hash))
      .rejects.toThrow(/response length/);
    await expect(downloadVerifiedBlob({ origin: "https://node.example", authKey: "secret" }, blob, ticket, undefined,
      fetcher as unknown as typeof fetch, async () => "c".repeat(64))).rejects.toThrow(/SHA-256/);
  });

  it("rejects oversized Blob metadata without issuing a request", async () => {
    const fetcher = vi.fn(async () => response());
    const oversized = create(BlobRefSchema, {
      ...blob, byteSize: BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES) + 1n
    });
    await expect(downloadVerifiedBlob({ origin: "https://node.example", authKey: "secret" }, oversized,
      create(BlobTransferTicketSchema, { ...ticket, maximumBytes: oversized.byteSize }), undefined,
      fetcher as unknown as typeof fetch, async () => hash)).rejects.toThrow(/bounded download metadata/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("authorizes a bounded streaming share without buffering the Blob", () => {
    const shareBlob = create(BlobRefSchema, {
      ...blob,
      fileName: "archive.bin",
      mediaType: "application/octet-stream",
      byteSize: BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES) + 1n
    });
    const shareTicket = create(BlobTransferTicketSchema, {
      ...ticket,
      blobId: shareBlob.blobId,
      maximumBytes: shareBlob.byteSize,
      requiredMediaType: shareBlob.mediaType
    });

    expect(authorizeVerifiedBlobDownload(
      { origin: "https://node.example", authKey: "secret" }, shareBlob, shareTicket
    )).toEqual({
      url: "https://node.example/v1/blobs/ticket-1",
      headers: { authorization: "Bearer secret" },
      blobId: shareBlob.blobId,
      fileName: "archive.bin",
      mediaType: "application/octet-stream",
      byteSize: Number(shareBlob.byteSize),
      sha256Hex: hash
    });
  });

  it("fails closed before sharing for oversized, mismatched, expired, or unsafe tickets", () => {
    const oversized = create(BlobRefSchema, {
      ...blob, byteSize: BigInt(MOBILE_FILE_SHARE_MAXIMUM_BYTES) + 1n
    });
    expect(() => authorizeVerifiedBlobDownload(
      { origin: "https://node.example", authKey: "secret" }, oversized,
      create(BlobTransferTicketSchema, { ...ticket, maximumBytes: oversized.byteSize })
    )).toThrow(/bounded file-sharing metadata/);
    expect(() => authorizeVerifiedBlobDownload(
      { origin: "https://node.example", authKey: "secret" }, blob,
      create(BlobTransferTicketSchema, { ...ticket, maximumBytes: 5n })
    )).toThrow(/mismatched limits or media type/);
    expect(() => authorizeVerifiedBlobDownload(
      { origin: "https://node.example", authKey: "secret" }, blob,
      create(BlobTransferTicketSchema, { ...ticket, relativeEndpoint: "//evil.example/blob" })
    )).toThrow(/non-root-relative Blob endpoint/);
    expect(() => authorizeVerifiedBlobDownload(
      { origin: "https://node.example", authKey: "secret" }, blob,
      create(BlobTransferTicketSchema, { ...ticket, expiresAt: create(TimestampSchema, { seconds: 1n }) })
    )).toThrow(/expired Blob download ticket/);
  });
});

describe("authenticated mobile Blob uploads", () => {
  const hash = "c".repeat(64);
  const source = {
    uri: "file:///durable/profile/attachment-one",
    fileName: "proof.pdf",
    mediaType: "application/pdf",
    byteSize: 4,
    sha256Hex: hash
  };
  const pending = create(PendingBlobUploadSchema, {
    uploadId: "upload-one",
    expectedSha256Hex: hash,
    expectedByteSize: 4n,
    ticket: create(BlobTransferTicketSchema, {
      ticketId: "ticket-one",
      blobId: "",
      direction: TransferDirection.UPLOAD,
      relativeEndpoint: "/v1/blob-uploads/ticket-one",
      maximumBytes: 4n,
      requiredMediaType: "application/pdf",
      expiresAt: { seconds: 4_102_444_800n }
    })
  });
  const committed = create(BlobRefSchema, {
    blobId: "blob-one",
    fileName: source.fileName,
    mediaType: source.mediaType,
    byteSize: 4n,
    sha256Hex: hash,
    disposition: BlobDisposition.ATTACHMENT
  });

  it("uses the authenticated root-relative ticket, then completes the exact upload identity", async () => {
    const calls: string[] = [];
    const uploader = vi.fn(async () => { calls.push("put"); return { status: 204 }; });
    const complete = vi.fn(async () => { calls.push("complete"); return committed; });

    await expect(uploadVerifiedBlob(
      { origin: "https://node.example", authKey: "secret" },
      source,
      pending,
      complete,
      undefined,
      uploader
    )).resolves.toEqual(committed);

    expect(calls).toEqual(["put", "complete"]);
    expect(uploader).toHaveBeenCalledWith(
      "https://node.example/v1/blob-uploads/ticket-one",
      source.uri,
      { authorization: "Bearer secret", "content-type": "application/octet-stream" },
      undefined
    );
    expect(complete).toHaveBeenCalledWith("upload-one", undefined);
  });

  it("fails closed before PUT for mismatched ticket metadata, expiry, and unsafe endpoints", async () => {
    const uploader = vi.fn(async () => ({ status: 204 }));
    const complete = vi.fn(async () => committed);
    const verify = async (candidate: typeof pending, pattern: RegExp) => {
      await expect(uploadVerifiedBlob(
        { origin: "https://node.example", authKey: "secret" }, source, candidate, complete, undefined, uploader
      )).rejects.toThrow(pattern);
    };

    await verify(create(PendingBlobUploadSchema, { ...pending, expectedSha256Hex: "d".repeat(64) }), /mismatched/u);
    await verify(create(PendingBlobUploadSchema, { ...pending, uploadId: "upload\nwrong" }), /mismatched/u);
    await verify(create(PendingBlobUploadSchema, {
      ...pending,
      ticket: create(BlobTransferTicketSchema, { ...pending.ticket!, ticketId: " ticket-one" })
    }), /mismatched/u);
    await verify(create(PendingBlobUploadSchema, {
      ...pending,
      ticket: create(BlobTransferTicketSchema, { ...pending.ticket!, maximumBytes: 5n })
    }), /mismatched/u);
    await verify(create(PendingBlobUploadSchema, {
      ...pending,
      ticket: create(BlobTransferTicketSchema, { ...pending.ticket!, direction: TransferDirection.DOWNLOAD })
    }), /mismatched/u);
    await verify(create(PendingBlobUploadSchema, {
      ...pending,
      ticket: create(BlobTransferTicketSchema, { ...pending.ticket!, blobId: "existing-blob" })
    }), /mismatched/u);
    await verify(create(PendingBlobUploadSchema, {
      ...pending,
      ticket: create(BlobTransferTicketSchema, { ...pending.ticket!, relativeEndpoint: "//evil.example/upload" })
    }), /non-root-relative/u);
    await verify(create(PendingBlobUploadSchema, {
      ...pending,
      ticket: create(BlobTransferTicketSchema, { ...pending.ticket!, expiresAt: create(TimestampSchema, { seconds: 1n }) })
    }), /expired/u);
    expect(uploader).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("never completes a failed PUT and rejects a mismatched committed Blob", async () => {
    const complete = vi.fn(async () => committed);
    await expect(uploadVerifiedBlob(
      { origin: "https://node.example", authKey: "secret" }, source, pending, complete, undefined,
      vi.fn(async () => ({ status: 413 }))
    )).rejects.toThrow(/upload failed \(413\)/u);
    expect(complete).not.toHaveBeenCalled();

    const mismatched = create(BlobRefSchema, { ...committed, sha256Hex: "d".repeat(64) });
    await expect(uploadVerifiedBlob(
      { origin: "https://node.example", authKey: "secret" }, source, pending,
      vi.fn(async () => mismatched), undefined, vi.fn(async () => ({ status: 204 }))
    )).rejects.toThrow(/committed a mismatched attachment Blob/u);
  });

  it("honors cancellation before PUT and between PUT and completion", async () => {
    const before = new AbortController();
    before.abort();
    const uploader = vi.fn(async () => ({ status: 204 }));
    await expect(uploadVerifiedBlob(
      { origin: "https://node.example", authKey: "secret" }, source, pending,
      vi.fn(async () => committed), before.signal, uploader
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(uploader).not.toHaveBeenCalled();

    const during = new AbortController();
    const complete = vi.fn(async () => committed);
    await expect(uploadVerifiedBlob(
      { origin: "https://node.example", authKey: "secret" }, source, pending, complete, during.signal,
      vi.fn(async () => { during.abort(); return { status: 204 }; })
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(complete).not.toHaveBeenCalled();
  });
});
