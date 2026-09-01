import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";

import * as contract from "../dist/index.js";

function fields(schema) {
  return [...schema.fields];
}

function field(schema, name) {
  const result = fields(schema).find((candidate) => candidate.name === name);
  assert.ok(result, `${schema.typeName}.${name} is missing`);
  return result;
}

function fieldNames(schema) {
  return new Set(fields(schema).map((candidate) => candidate.name));
}

function methodNames(service) {
  return new Set([...service.methods].map((method) => method.localName));
}

function assertNoFields(schemas, names) {
  for (const schema of schemas) {
    const actual = fieldNames(schema);
    for (const name of names) {
      assert.equal(actual.has(name), false, `${schema.typeName} must not expose ${name}`);
    }
  }
}

function oneofMembers(schema, name) {
  assert.ok(schema.oneofs?.some((oneof) => oneof.name === name), `${schema.typeName}.${name} is missing`);
  return fields(schema)
    .filter((candidate) => candidate.oneof?.name === name)
    .map((candidate) => candidate.name);
}

function roundTrip(schema, value) {
  return fromBinary(schema, toBinary(schema, create(schema, value)));
}

test("the browser-safe root and Node-only bootstrap remain separate entry points", async () => {
  const rootEntry = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.doesNotMatch(rootEntry, /desktop-bootstrap/u);
  assert.doesNotMatch(rootEntry, /node:/u);
  assert.equal("DesktopBootstrapGrant" in contract, false);

  const bootstrap = await import("../dist/desktop-bootstrap.js");
  assert.equal(typeof bootstrap.DesktopBootstrapGrant, "function");
  assert.equal(typeof bootstrap.createDesktopBootstrapRequest, "function");
});

test("machine-facing capability identifiers remain exact and globally unique", () => {
  const expected = {
    sessionDiscovery: "session.discovery",
    sessionCatalog: "session.catalog",
    sessionMessageDelete: "session.message_delete",
    sessionReset: "session.reset",
    reviewIsolated: "review.isolated",
    voiceInput: "input.voice",
    backgroundTasks: "background.tasks",
    backgroundTasksCancel: "background.tasks.cancel",
    subagentsList: "subagents.list",
    subagentsDetail: "subagents.detail",
    subagentsTranscript: "subagents.transcript",
    subagentsStop: "subagents.stop",
    subagentsSteer: "subagents.steer",
    subagentsFollowUp: "subagents.follow_up",
    subagentsResume: "subagents.resume",
    remoteHostCatalog: "remote_host.catalog",
    remoteHostManagement: "remote_host.management",
    remoteHostConnectionControl: "remote_host.connection_control",
    remoteHostConnectionTest: "remote_host.connection_test",
    remoteHostTrustReset: "remote_host.trust_reset",
    workspaceFilesWatch: "workspace.files.watch",
    workspaceFilesWrite: "workspace.files.write",
    workspaceGeneratedFiles: "workspace.generated_files",
    workspaceDiffSources: "workspace.diff.sources",
    workspaceDiffImagePreview: "workspace.diff.image_preview",
    workspaceDiffCommit: "workspace.diff.commit",
    workspaceDiffPush: "workspace.diff.push",
    toolAndroid: "tool.android"
  };
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(contract.capabilityNames[name], value, name);
  }
  const values = Object.values(contract.capabilityNames);
  assert.equal(new Set(values).size, values.length, "capability identifiers must be unique");
});

test("Backend and native-session discovery surfaces stay capability-neutral", () => {
  assertNoFields([contract.BackendDescriptorSchema], [
    "adapter_kind", "backend_kind", "executable", "process_id", "transport_kind"
  ]);
  assert.equal(methodNames(contract.SessionService).has("discoverNativeSessions"), true);
  assert.equal(methodNames(contract.SessionService).has("scanNativeSessionCatalog"), true);
  assert.equal(methodNames(contract.PiService).has("listNativeSessions"), false);
  assertNoFields([contract.NativeSessionCandidateSchema, contract.NativeSessionCatalogEntrySchema], [
    "backend_id", "adapter_kind", "runtime_kind"
  ]);
});

test("remote-host requests derive owner identity from authentication", () => {
  const requests = [
    contract.GetRemoteHostCapabilitiesRequestSchema,
    contract.ListRemoteHostsRequestSchema,
    contract.GetRemoteHostRequestSchema,
    contract.WatchRemoteHostsRequestSchema,
    contract.RefreshRemoteHostCatalogRequestSchema,
    contract.CreateRemoteHostRequestSchema,
    contract.UpdateRemoteHostRequestSchema,
    contract.DeleteRemoteHostRequestSchema,
    contract.ConnectRemoteHostRequestSchema,
    contract.DisconnectRemoteHostRequestSchema,
    contract.TestRemoteHostConnectionRequestSchema,
    contract.ClearRemoteHostTrustRequestSchema
  ];
  for (const schema of requests) {
    assert.equal(fieldNames(schema).has("target_id"), true, `${schema.typeName} must be target-scoped`);
  }
  assertNoFields(requests, ["owner_id", "backend_id"]);
});

test("portable import keeps its password outside durable drafts and results", () => {
  assert.equal(field(contract.ExportPortableSessionRequestSchema, "password").proto.proto3Optional, true);
  assertNoFields([
    contract.PortableSessionImportDraftSchema,
    contract.PortableSessionImportPreviewSchema,
    contract.PortableSessionImportResultSchema,
    contract.CommitPortableSessionImportRequestSchema,
    contract.CommitPortableSessionImportResponseSchema
  ], ["password", "password_hash", "password_digest"]);
});

test("Review evidence projections expose digests rather than private content", () => {
  assertNoFields([
    contract.ReviewEvidenceSummarySchema,
    contract.ReviewSourceRevisionSchema
  ], [
    "absolute_path", "relative_path", "body", "content", "blob", "credential",
    "credential_reference_id", "raw_payload"
  ]);
});

test("remote-host public projections exclude raw authority and private diagnostics", () => {
  assertNoFields([
    contract.RemoteHostSchema,
    contract.RemoteHostTrustPinSchema,
    contract.RemoteHostStatusSnapshotSchema,
    contract.RemoteHostFailureSchema,
    contract.RemoteHostCatalogSnapshotSchema,
    contract.RemoteHostChangeSchema,
    contract.RemoteHostConnectionTestResultSchema
  ], [
    "owner_id", "backend_id", "credential_value", "password", "private_key", "private_path",
    "raw_error", "error_message", "raw_command", "command", "presented_key", "key_bytes",
    "details", "message"
  ]);
});

test("voice input remains an ephemeral capability surface", () => {
  assertNoFields([contract.VoiceInputSessionSchema, contract.VoiceInputFailureSchema], [
    "audio", "credential", "provider_id", "backend_id", "message"
  ]);
  assert.equal(fieldNames(contract.EventPayloadSchema).has("voice_input"), false);
  assert.equal(fieldNames(contract.SnapshotSchema).has("voice_input"), false);
});

test("discovery metadata is a closed public allowlist", () => {
  assert.deepEqual(fields(contract.DiscoveredNodeSchema).map((candidate) => candidate.name), [
    "server_id", "display_name", "origin", "version", "api_version", "pairing_enabled", "last_seen"
  ]);
  assert.deepEqual(fields(contract.LanDiscoveryDatagramSchema).map((candidate) => candidate.name), [
    "magic", "protocol_version", "nonce", "kind", "node"
  ]);
});

test("LAN discovery performs bounded binary round trips on administratively scoped multicast", () => {
  const nonce = Uint8Array.from(
    { length: contract.LAN_DISCOVERY_NONCE_BYTES },
    (_, index) => index
  );
  assert.deepEqual(
    contract.decodeLanDiscoveryDatagram(contract.encodeLanDiscoveryQuery(nonce), 1),
    { kind: "query", nonce }
  );

  const announced = {
    serverId: "node-1",
    displayName: "Local node",
    origin: "http://192.168.10.12:43180",
    version: "1.0.0",
    apiVersion: "v1",
    pairingEnabled: true,
    lastSeen: 10
  };
  const bytes = contract.encodeLanDiscoveryAnnouncement(nonce, announced);
  assert.ok(bytes.byteLength <= contract.LAN_DISCOVERY_MAX_DATAGRAM_BYTES);
  assert.deepEqual(contract.decodeLanDiscoveryDatagram(bytes, 20), {
    kind: "announce",
    nonce,
    node: { ...announced, lastSeen: 20 }
  });
  assert.match(contract.LAN_DISCOVERY_GROUP, /^239\.(?:\d{1,3}\.){2}\d{1,3}$/u);
});

test("proto3 optional scalars preserve absent values separately from explicit zero values", () => {
  const cases = [
    [contract.RetryChangedEventSchema, "maxAttempts", "max_attempts", 0],
    [contract.BackgroundTaskSchema, "progressRatio", "progress_ratio", 0],
    [contract.SessionContextStateSchema, "compacting", "compacting", false],
    [contract.MoveSessionProjectMutationSchema, "projectId", "project_id", ""],
    [contract.NativeSessionCatalogEntrySchema, "workingDirectory", "working_directory", ""],
    [contract.NativeSessionCatalogEntrySchema, "existingSessionId", "existing_session_id", ""]
  ];
  for (const [schema, property, wireName, explicitZero] of cases) {
    assert.equal(field(schema, wireName).proto.proto3Optional, true);
    const absent = roundTrip(schema, {});
    const present = roundTrip(schema, { [property]: explicitZero });
    assert.equal(Object.hasOwn(absent, property), false, `${schema.typeName}.${property} absent`);
    assert.equal(present[property], explicitZero, `${schema.typeName}.${property} explicit zero`);
    assert.equal(Object.hasOwn(present, property), true, `${schema.typeName}.${property} present`);
    assert.ok(toBinary(schema, present).byteLength > 0);
  }
});

test("typed unions retain their exact branch membership", () => {
  const cases = [
    [contract.CapabilityOptionsSchema, "kind", [
      "session", "turn", "input", "model", "permission", "context", "workspace", "interaction", "runtime", "tool"
    ]],
    [contract.InteractionSchema, "request", ["permission", "question", "plan_review", "extension_ui"]],
    [contract.PermissionSubjectSchema, "kind", ["file", "command", "mcp", "browser", "custom_tool", "resource"]],
    [contract.DisplayArgumentSchema, "value", ["text", "number", "integer", "boolean", "blob", "null", "composite"]],
    [contract.QuestionFieldSchema, "input", ["text", "single_choice", "multiple_choice", "boolean"]],
    [contract.InteractionResolutionSchema, "decision", [
      "permission", "question", "plan_review", "extension_ui", "dismissal"
    ]],
    [contract.QuestionAnswerSchema, "value", ["text", "choice_id", "choice_ids", "boolean", "sensitive"]],
    [contract.ExtensionUiResolutionSchema, "result", ["value", "confirmed", "cancelled"]],
    [contract.WatchRemoteHostsResponseSchema, "update", ["snapshot", "change"]],
    [contract.BrowserTakeoverActionMutationSchema, "action", [
      "mouse_click", "scroll", "key_press", "text_input", "navigate", "navigation_command", "mouse_move", "mouse_drag"
    ]],
    [contract.FilePreviewSchema, "content", ["text", "image", "blob", "binary"]],
    [contract.SearchSessionMessagesRequestSchema, "scope", ["session_id", "target_id", "owner"]],
    [contract.ResourceAcquisitionSourceSchema, "source", ["local", "npm", "git"]],
    [contract.AndroidDeviceSelectionSchema, "choice", ["automatic", "device_serial"]],
    [contract.AndroidAdbPathSelectionSchema, "choice", ["automatic", "server_path"]],
    [contract.PiEventMetadataSchema, "payload", [
      "rpc_acknowledgement", "native_state", "message_lifecycle", "tool_lifecycle", "bash_update",
      "queue_update", "compaction_update", "retry_update", "session_identity_update", "session_tree_update",
      "command_catalog_update", "extension_ui_effect", "resource_update", "model_update", "diagnostic"
    ]]
  ];
  for (const [schema, name, expected] of cases) {
    assert.deepEqual(oneofMembers(schema, name), expected, `${schema.typeName}.${name}`);
  }
});

test("durable and cross-process field numbers remain stable", () => {
  const expected = [
    [contract.InputContentSchema, "quotes_encoded", 2],
    [contract.InputContentSchema, "pasted_text_ranges", 3],
    [contract.MessageStartedEventSchema, "quotes_encoded", 5],
    [contract.MessageStartedEventSchema, "automation_origin", 6],
    [contract.MessageCompletedEventSchema, "usage", 4],
    [contract.MessageCompletedEventSchema, "generation_duration_ms", 6],
    [contract.MessageCompletedEventSchema, "generation_reliable", 7],
    [contract.MessageCompletedEventSchema, "blocks", 9],
    [contract.NativeSessionCatalogEntrySchema, "native_session_id", 1],
    [contract.NativeSessionCatalogEntrySchema, "native_reference", 2],
    [contract.NativeSessionCatalogEntrySchema, "working_directory", 4],
    [contract.NativeSessionCatalogEntrySchema, "project_directory", 5],
    [contract.NativeSessionCatalogEntrySchema, "placement", 8],
    [contract.NativeSessionCatalogEntrySchema, "target_id", 9],
    [contract.NativeSessionCatalogEntrySchema, "project_target_id", 10],
    [contract.NativeSessionCatalogEntrySchema, "existing_session_id", 11],
    [contract.ScanNativeSessionCatalogRequestSchema, "backend_id", 1],
    [contract.ScanNativeSessionCatalogRequestSchema, "force", 2],
    [contract.ScanNativeSessionCatalogResponseSchema, "entries", 1],
    [contract.ScanNativeSessionCatalogResponseSchema, "rejected_count", 2],
    [contract.ScanNativeSessionCatalogResponseSchema, "existing_count", 3],
    [contract.SettingsSnapshotSchema, "personalization", 13],
    [contract.SettingsSnapshotSchema, "language_tools", 24],
    [contract.SettingsSnapshotSchema, "agent_resource", 25],
    [contract.SettingsSnapshotSchema, "collaboration", 26],
    [contract.SettingsSnapshotSchema, "git_safety", 27],
    [contract.OperationMutationSchema, "update_personalization_settings", 144],
    [contract.OperationMutationSchema, "update_language_tool_settings", 161],
    [contract.OperationMutationSchema, "update_agent_resource_settings", 163],
    [contract.OperationMutationSchema, "update_collaboration_settings", 164],
    [contract.OperationMutationSchema, "update_git_safety_settings", 165],
    [contract.OperationMutationSchema, "cleanup_git_safety_savepoints", 166]
  ];
  for (const [schema, name, number] of expected) {
    assert.equal(field(schema, name).number, number, `${schema.typeName}.${name}`);
  }
});

test("public enum wire numbers remain stable", () => {
  const cases = [
    [contract.CapabilitySupport, {
      SUPPORTED: 1, UPSTREAM_MISSING: 2, NOT_IMPLEMENTED: 3, PLATFORM_LIMITED: 4,
      DISABLED_BY_POLICY: 5, TEMPORARILY_UNAVAILABLE: 6
    }],
    [contract.QueueDeliveryMode, { PROMPT: 1, STEER: 2, FOLLOW_UP: 3 }],
    [contract.PermissionMode, { ASK: 1, AUTO: 2, BYPASS_PERMISSIONS: 3 }],
    [contract.SessionAttentionAcknowledgementIntent, { VIEWED: 1, EXPLICIT: 2 }],
    [contract.ReviewFreshnessState, { CURRENT: 1, STALE: 2, UNAVAILABLE: 3 }],
    [contract.RemoteHostCapabilityKind, {
      CATALOG: 1, MANAGEMENT: 2, CONNECTION_CONTROL: 3, CONNECTION_TEST: 4, TRUST_RESET: 5
    }],
    [contract.RemoteHostStatus, { DISCONNECTED: 1, CONNECTING: 2, AUTHENTICATING: 3, READY: 4, FAILED: 5 }],
    [contract.RemoteHostFailureCode, {
      ABORTED: 1, AUTHENTICATION_FAILED: 2, CONNECTION_FAILED: 3, CONNECTION_TIMEOUT: 4,
      CONNECTOR_PROTOCOL: 5, CONNECTOR_UNAVAILABLE: 6, HOST_KEY_CHANGED: 7, HOST_KEY_CONFLICT: 8,
      HOST_KEY_INVALID: 9, HOST_KEY_MISSING: 10, HOST_KEY_STORE_CORRUPT: 11,
      HOST_KEY_STORE_MISSING: 12, HOST_KEY_STORE_UNREADABLE: 13, HOST_KEY_STORE_WRITE_FAILED: 14
    }],
    [contract.RemoteHostChangeKind, { UPSERTED: 1, DELETED: 2 }],
    [contract.CompactionState, { STARTED: 1, COMPLETED: 2, NO_OP: 3, ABORTED: 4, FAILED: 5 }],
    [contract.CompactSessionOutcome, { COMPACTED: 1, NOOP: 2 }],
    [contract.EntityKind, { DEVICE_CONTROL_RELATION: 23 }],
    [contract.GitDiffSource, { UNSTAGED: 1, STAGED: 2, COMMIT: 3, BRANCH: 4, LAST_TURN: 5, TURN_SET: 6 }],
    [contract.WorkspaceDiffAction, { STAGE: 1, UNSTAGE: 2, REVERT: 3 }],
    [contract.ResourceAcquisitionKind, { LOCAL: 1, NPM: 2, GIT: 3 }],
    [contract.ResourceKind, { THEME: 5 }],
    [contract.ResourceCompatibility, { SUPPORTED: 1, PARTIAL: 2, UNSUPPORTED: 3, UNKNOWN: 4 }],
    [contract.ResourcePackageWarning, { LIFECYCLE_SCRIPTS_DISABLED: 4 }],
    [contract.NativeSessionCandidateState, { READY: 1, ERROR: 2 }],
    [contract.NativeSessionPlacement, { PROJECT: 1, DIALOGUE: 2 }],
    [contract.ToolProviderKind, { ANDROID: 6 }],
    [contract.AndroidAutomationRuntimeState, { CHECKING: 2, PREPARING: 3 }],
    [contract.BrowserBackendStatus, { READY: 1, RECOVERING: 2, DISCONNECTED: 3, UNAVAILABLE: 4, ERROR: 5 }],
    [contract.BrowserBackendFailureReason, {
      DISPOSING: 1, HOST_UNAVAILABLE: 2, START_FAILED: 3, STATUS_FAILED: 4, RECOVERY_FAILED: 5
    }],
    [contract.ComputerAutomationUpdatePhase, { DOWNLOADING: 1, INSTALLING: 2, DONE: 3 }],
    [contract.WorkspaceEntryListingPolicy, { UNSPECIFIED: 0, DEFAULT: 1, DOCUMENT_TREE: 2 }],
    [contract.WorkspaceFileChangeKind, { CREATED: 1, MODIFIED: 2, DELETED: 3, RENAMED: 4, OVERFLOW: 5, RESYNC: 6 }],
    [contract.SessionMessageSearchRole, { USER: 1, ASSISTANT: 2 }],
    [contract.SessionMessageSearchKind, { TEXT_MESSAGE: 1 }],
    [contract.SessionMessageSearchSemanticMode, { HYBRID: 1, KEYWORD: 2 }],
    [contract.SessionMessageSearchSessionStatus, { ACTIVE: 1, ARCHIVED: 2 }],
    [contract.PiStateObservationSource, { DURABLE_RPC: 1, LIVE_RPC: 2 }],
    [contract.PiStateObservationCompleteness, { UNOBSERVED: 1, PARTIAL: 2, COMPLETE: 3, STALE: 4 }]
  ];
  for (const [actual, expected] of cases) {
    for (const [name, number] of Object.entries(expected)) {
      assert.equal(actual[name], number, name);
    }
  }
});

test("public messages use typed fields instead of maps, Struct, or Any", () => {
  for (const [exportName, descriptor] of Object.entries(contract)) {
    if (!exportName.endsWith("Schema") || descriptor?.kind !== "message") continue;
    for (const candidate of descriptor.fields) {
      assert.notEqual(candidate.fieldKind, "map", `${descriptor.typeName}.${candidate.name} uses a map`);
      if (candidate.message !== undefined) {
        assert.notEqual(candidate.message.typeName, "google.protobuf.Struct");
        assert.notEqual(candidate.message.typeName, "google.protobuf.Any");
      }
    }
  }
});
