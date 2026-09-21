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
    remoteHostBackendRuntimeSetup: "remote_host.backend_runtime_setup",
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
    contract.ClearRemoteHostTrustRequestSchema,
    contract.ProbeRemoteBackendRuntimeRequestSchema,
    contract.InstallRemoteBackendRuntimeRequestSchema,
    contract.UninstallRemoteBackendRuntimeRequestSchema
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
    contract.RemoteHostConnectionTestResultSchema,
    contract.RemoteBackendRuntimeSchema,
    contract.RemoteBackendRuntimeFailureSchema,
    contract.InstallRemoteBackendRuntimeResponseSchema
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

test("Contacts exposes revision-fenced local and explicit device-sync authority without secret transport fields", () => {
  assert.deepEqual([...methodNames(contract.ContactService)], [
    "getContactDirectory",
    "setContactDirectoryEnabled",
    "listContacts",
    "getContact",
    "findSimilarContacts",
    "createContact",
    "updateContact",
    "confirmContact",
    "deleteContact",
    "addContactIdentity",
    "removeContactIdentity",
    "appendContactEvent",
    "removeContactEvent",
    "listContactGroups",
    "createContactGroup",
    "updateContactGroup",
    "deleteContactGroup",
    "setContactGroupMembership",
    "addContactRelation",
    "updateContactRelation",
    "removeContactRelation",
    "scanContactDuplicates",
    "mergeContacts",
    "previewContactVCardImport",
    "commitContactVCardImport",
    "exportContactsVCard",
    "getContactSyncStatus",
    "setContactSyncEnabled",
    "grantContactSyncPeer",
    "revokeContactSyncPeer",
    "syncContactsNow"
  ]);
  assertNoFields([
    contract.ContactDirectorySchema,
    contract.ContactSummarySchema,
    contract.ContactProfileSchema,
    contract.ContactIdentitySchema,
    contract.ContactVCardImportPreviewEntrySchema,
    contract.ExportContactsVCardResponseSchema,
    contract.ContactSyncStatusSchema,
    contract.ContactSyncPeerSchema,
    contract.ContactSyncCandidateSchema,
    contract.GrantContactSyncPeerRequestSchema,
    contract.RevokeContactSyncPeerRequestSchema,
    contract.SyncContactsNowRequestSchema
  ], [
    "absolute_path", "database_path", "credential", "credential_reference_id",
    "device_contact_id", "system_contact_id", "permission_token", "public_key", "private_key",
    "sealed_private_key", "proof", "challenge", "ciphertext", "state_json", "projection_json",
    "address", "port"
  ]);
  assert.equal(field(contract.ContactPatchSchema, "display_name").proto.proto3Optional, true);
  assert.equal(field(contract.ContactVCardImportDecisionSchema, "target_contact_id").proto.proto3Optional, true);
});

test("Partners exposes revision-fenced durable profiles without private home or runtime authority", () => {
  assert.deepEqual([...methodNames(contract.PartnerService)], [
    "getPartnerDirectory",
    "listPartners",
    "getPartner",
    "createPartner",
    "updatePartner",
    "setPartnerLifecycle",
    "retryPartnerInitialization",
    "updatePartnerDefaults",
    "listPartnerSessions",
    "markPartnerRead",
    "listPartnerPrivateThreads",
    "getPartnerPrivateThread",
    "markPartnerPrivateThreadRead",
    "listPartnerDelegations",
    "getPartnerDelegation",
    "cancelPartnerDelegation"
  ]);
  assertNoFields([
    contract.PartnerDirectorySchema,
    contract.PartnerProfileSchema,
    contract.PartnerTemplateSchema,
    contract.PartnerDraftSchema,
    contract.PartnerPatchSchema,
    contract.PartnerActivitySchema,
    contract.PartnerSessionSchema,
    contract.PartnerPrivateThreadSchema,
    contract.PartnerPrivateMessageSchema,
    contract.PartnerPrivateThreadReadStateSchema,
    contract.PartnerDelegationSchema
  ], [
    "absolute_path", "workspace_root", "database_path", "credential", "credential_reference_id",
    "auth_key", "operation_id", "create_operation_id", "enqueue_operation_id", "raw_error", "error_message",
    "sender_session_id", "recipient_session_id"
  ]);
  assert.equal(field(contract.PartnerProfileSchema, "canonical_session_id").proto.proto3Optional, true);
  assert.equal(field(contract.PartnerPatchSchema, "display_name").proto.proto3Optional, true);
  assert.equal(field(contract.PartnerPatchSchema, "permission_mode").proto.proto3Optional, true);
  assert.equal(field(contract.PartnerPatchSchema, "uses_directory_defaults").proto.proto3Optional, true);
  assert.equal(field(contract.PartnerSessionSchema, "delegation_id").proto.proto3Optional, true);
  assert.equal(field(contract.PartnerPrivateThreadSchema, "close_reason").proto.proto3Optional, true);
  assert.equal(field(contract.PartnerPrivateMessageSchema, "delivered_at").proto.proto3Optional, true);
  assert.equal(field(contract.PartnerDelegationSchema, "child_session_id").proto.proto3Optional, true);
  assert.equal(field(contract.PartnerDelegationSchema, "result_summary").proto.proto3Optional, true);
  assert.equal(field(contract.PartnerDelegationSchema, "error").proto.proto3Optional, true);
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
    apiVersion: contract.JOKO_API_VERSION,
    pairingEnabled: true,
    lastSeen: 10
  };
  const bytes = contract.encodeLanDiscoveryAnnouncement(nonce, announced);
  assert.ok(bytes.byteLength <= contract.LAN_DISCOVERY_MAX_DATAGRAM_BYTES);
  assert.equal(contract.JOKO_API_VERSION, "joko.v1");
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
    [contract.NativeSessionCatalogEntrySchema, "existingSessionId", "existing_session_id", ""],
    [contract.QuestionSingleChoiceInputSchema, "allowOther", "allow_other", false],
    [contract.QuestionMultipleChoiceInputSchema, "allowOther", "allow_other", false],
    [contract.QuestionMultipleChoiceAnswerSchema, "otherText", "other_text", ""],
    [contract.BackendMemorySettingsSchema, "entryCount", "entry_count", 0n],
    [contract.MemoryResetResultSchema, "removedEntries", "removed_entries", 0n],
    [contract.MemoryResetResultSchema, "removedTargets", "removed_targets", 0n]
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
    [contract.QuestionAnswerSchema, "value", ["text", "boolean", "single_choice", "multiple_choice"]],
    [contract.QuestionSingleChoiceAnswerSchema, "selection", ["choice_id", "other_text"]],
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

test("retired question-answer tags cannot decode as current typed selections", () => {
  const oldSingleChoice = fromBinary(
    contract.QuestionAnswerSchema,
    Uint8Array.from([0x5a, 0x04, 0x66, 0x61, 0x73, 0x74])
  );
  const oldMultipleChoice = fromBinary(
    contract.QuestionAnswerSchema,
    Uint8Array.from([0x62, 0x05, 0x0a, 0x03, 0x77, 0x65, 0x62])
  );
  assert.equal(oldSingleChoice.value.case, undefined);
  assert.equal(oldMultipleChoice.value.case, undefined);
});

test("durable and cross-process field numbers remain stable", () => {
  const expected = [
    [contract.InputContentSchema, "quotes_encoded", 2],
    [contract.InputContentSchema, "pasted_text_ranges", 3],
    [contract.InputContentSchema, "mention_ranges", 4],
    [contract.MessageStartedEventSchema, "automation_origin", 6],
    [contract.MessageStartedEventSchema, "user_input_accepted", 11],
    [contract.EditQueueItemMutationSchema, "text_splices", 5],
    [contract.MessageCompletedEventSchema, "usage", 4],
    [contract.MessageCompletedEventSchema, "generation_duration_ms", 6],
    [contract.MessageCompletedEventSchema, "generation_reliable", 7],
    [contract.MessageCompletedEventSchema, "blocks", 9],
    [contract.QuestionAnswerSchema, "single_choice", 15],
    [contract.QuestionAnswerSchema, "multiple_choice", 16],
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
    [contract.SettingsSnapshotSchema, "auxiliary_text", 30],
    [contract.OperationMutationSchema, "update_auxiliary_text_settings", 179],
    [contract.OperationMutationSchema, "update_personalization_settings", 144],
    [contract.OperationMutationSchema, "update_language_tool_settings", 161],
    [contract.OperationMutationSchema, "update_agent_resource_settings", 163],
    [contract.OperationMutationSchema, "update_collaboration_settings", 164],
    [contract.OperationMutationSchema, "update_git_safety_settings", 165],
    [contract.OperationMutationSchema, "cleanup_git_safety_savepoints", 166],
    [contract.OperationMutationSchema, "start_extension_package_export", 194],
    [contract.OperationMutationSchema, "cancel_extension_package_export", 195],
    [contract.OperationMutationSchema, "apply_skill_draft", 196],
    [contract.OperationMutationSchema, "set_skill_enabled", 197],
    [contract.OperationMutationSchema, "delete_skill", 198],
    [contract.OperationMutationSchema, "add_skill_market_source", 199],
    [contract.OperationMutationSchema, "refresh_skill_market_source", 200],
    [contract.OperationMutationSchema, "remove_skill_market_source", 201],
    [contract.OperationMutationSchema, "install_skill_market_plan", 202],
    [contract.OperationMutationSchema, "enable_skill_market_sync", 203],
    [contract.OperationMutationSchema, "disable_skill_market_sync", 204],
    [contract.OperationMutationSchema, "enqueue_skill_market_sync", 205],
    [contract.OperationMutationSchema, "cancel_skill_market_sync", 206],
    [contract.OperationMutationSchema, "retry_skill_market_sync", 207],
    [contract.OperationResultSchema, "skill", 35],
    [contract.ListSkillFilesRequestSchema, "page", 3],
    [contract.ListSkillFilesResponseSchema, "page", 2],
    [contract.ListSkillRecoveriesRequestSchema, "page", 1],
    [contract.ListSkillRecoveriesResponseSchema, "page", 2],
    [contract.ExtensionCatalogEntrySchema, "library", 22]
  ];
  for (const [schema, name, number] of expected) {
    assert.equal(field(schema, name).number, number, `${schema.typeName}.${name}`);
  }
});

test("Extension package export contracts preserve exact local authority and durable control", () => {
  const methods = methodNames(contract.ExtensionService);
  assert.equal(methods.has("getExtensionPackageExportPreview"), true);
  assert.equal(methods.has("listExtensionPackageExports"), true);
  assert.equal(methods.has("getExtensionPackageExport"), true);
  const authority = {
    extensionId: "extension_0123456789abcdef0123456789abcdef",
    extensionRevision: { value: 7n },
    resourceId: "resource-package",
    resourceRevision: { value: 5n },
    discoveredRevision: `sha256:${"a".repeat(64)}`,
    backendId: "pi",
    backendRevision: { value: 9n },
    backendGeneration: 3n,
    packageName: "@sample/exportable",
    packageVersion: "1.2.3"
  };
  const preview = roundTrip(contract.ExtensionPackageExportPreviewSchema, {
    authority,
    archiveFormat: "npm-tar-gzip",
    fileName: "sample-exportable-1.2.3.tgz",
    maximumEntries: 10_000,
    maximumUncompressedBytes: 67_108_864n,
    localOnly: true
  });
  assert.equal(preview.authority.backendGeneration, 3n);
  assert.equal(preview.authority.discoveredRevision, authority.discoveredRevision);
  assert.equal(preview.localOnly, true);

  const start = roundTrip(contract.OperationMutationSchema, {
    payload: { case: "startExtensionPackageExport", value: {
      extensionId: authority.extensionId,
      expectedExtensionRevision: authority.extensionRevision,
      resourceId: authority.resourceId,
      expectedResourceRevision: authority.resourceRevision,
      backendId: authority.backendId,
      expectedBackendRevision: authority.backendRevision,
      expectedBackendGeneration: authority.backendGeneration
    } }
  });
  assert.equal(start.payload.case, "startExtensionPackageExport");
  assert.equal(start.payload.value.expectedBackendGeneration, 3n);
  const cancel = roundTrip(contract.OperationMutationSchema, {
    payload: { case: "cancelExtensionPackageExport", value: { exportId: "export-1", expectedRevision: { value: 4n } } }
  });
  assert.equal(cancel.payload.case, "cancelExtensionPackageExport");
  assert.equal(cancel.payload.value.expectedRevision.value, 4n);
});

test("Extension Library keeps management paths separate from sandboxed relative-key operations", () => {
  const methods = methodNames(contract.ExtensionService);
  for (const name of [
    "getExtensionLibraryOverview",
    "validateExtensionLibraryLocation",
    "relocateExtensionLibrary",
    "rebindExtensionLibrary",
    "unbindExtensionLibrary",
    "repairExtensionLibraryState",
    "repairExtensionLibraryMetadata",
    "trashExtensionLibrary",
    "listExtensionLibraryTrash",
    "restoreExtensionLibraryTrash",
    "purgeExtensionLibraryTrash",
    "listExtensionLibraryGrace",
    "rollbackExtensionLibrary",
    "purgeExpiredExtensionLibraries",
    "openExtensionLibrary",
    "callExtensionLibrary",
    "closeExtensionLibrary"
  ]) assert.equal(methods.has(name), true, name);

  assert.deepEqual(oneofMembers(contract.ExtensionLibraryCallSchema, "operation"), [
    "read", "write", "stat", "list", "mkdir", "delete", "rename",
    "write_begin", "write_chunk", "write_commit", "write_abort",
    "sql_open", "sql_execute", "sql_batch", "sql_migrate", "sql_backup", "sql_check", "sql_close"
  ]);
  assert.deepEqual(oneofMembers(contract.ExtensionLibrarySqlValueSchema, "value"), [
    "null_value", "number_value", "integer_value", "text_value", "blob_value"
  ]);
  assertNoFields([
    contract.ExtensionLibrarySessionSchema,
    contract.ExtensionLibraryCallSchema,
    contract.ExtensionLibraryCallResultSchema,
    contract.OpenExtensionLibraryRequestSchema,
    contract.CallExtensionLibraryRequestSchema
  ], ["absolute_path", "library_root", "owner_id", "binding_path", "credential"]);

  const call = roundTrip(contract.ExtensionLibraryCallSchema, {
    operation: { case: "sqlExecute", value: {
      handleId: "db-1",
      statement: {
        sql: "SELECT ?, ?",
        parameters: [
          { value: { case: "integerValue", value: "9223372036854775807" } },
          { value: { case: "blobValue", value: Uint8Array.from([1, 2, 3]) } }
        ]
      }
    } }
  });
  assert.equal(call.operation.case, "sqlExecute");
  assert.equal(call.operation.value.statement.parameters[0].value.value, "9223372036854775807");
  assert.deepEqual([...call.operation.value.statement.parameters[1].value.value], [1, 2, 3]);
});

test("Skill management is path-private and mutations retain exact revision authority", () => {
  const methods = methodNames(contract.SkillService);
  for (const name of [
    "listSkills", "openSkill", "listSkillFiles", "readSkillFile", "getSkillDiff",
    "prepareSkillFileEdit", "prepareSkillRename", "listSkillRecoveries", "closeSkill"
  ]) assert.equal(methods.has(name), true, name);

  assertNoFields([
    contract.SkillDescriptorSchema,
    contract.SkillMetadataSchema,
    contract.SkillFileEntrySchema,
    contract.SkillDiffChangeSchema,
    contract.SkillSessionSchema,
    contract.SkillDraftSchema,
    contract.SkillRecoverySchema,
    contract.SkillMutationResultSchema,
    contract.ListSkillsRequestSchema,
    contract.OpenSkillRequestSchema,
    contract.ListSkillFilesRequestSchema,
    contract.ReadSkillFileRequestSchema,
    contract.GetSkillDiffRequestSchema,
    contract.PrepareSkillRenameRequestSchema,
    contract.CloseSkillRequestSchema
  ], [
    "path", "absolute_path", "local_path", "source_path", "root", "workspace_root",
    "candidate_path", "recovery_path", "owner_id", "credential", "credential_value"
  ]);

  const descriptor = {
    skillId: "resource-skill",
    backendId: "pi",
    scope: contract.ResourceScope.GLOBAL,
    name: "review-helper",
    sourceLabel: "review-helper",
    state: contract.ResourceState.LOADED,
    enabled: true,
    canToggle: true,
    contentAvailable: true,
    canEdit: true,
    canDelete: true,
    entityVersion: { revision: { value: 9007199254740993n }, generation: 0n },
    approvedRevision: `sha256:${"a".repeat(64)}`
  };
  const session = roundTrip(contract.SkillSessionSchema, {
    sessionId: "skill_session_0123456789abcdef0123456789abcdef",
    skill: descriptor,
    observedRevision: `sha256:${"b".repeat(64)}`,
    dirty: true,
    baselineAvailable: true,
    diff: { available: true, changes: [{ key: "SKILL.md", kind: contract.SkillDiffChangeKind.MODIFIED, unifiedDiff: "-old\n+new\n" }] }
  });
  assert.equal(session.skill.entityVersion.revision.value, 9007199254740993n);
  assert.equal(fieldNames(contract.SkillSessionSchema).has("files"), false);
  const listing = roundTrip(contract.ListSkillFilesResponseSchema, {
    files: [{ key: "references/guide.md", name: "guide.md", kind: contract.SkillFileKind.FILE, size: 42n, editable: true }],
    page: { totalSize: 1n }
  });
  assert.equal(listing.files[0].key, "references/guide.md");

  const apply = roundTrip(contract.OperationMutationSchema, {
    payload: { case: "applySkillDraft", value: { draftId: "skill_draft_0123456789abcdef0123456789abcdef" } }
  });
  const toggle = roundTrip(contract.OperationMutationSchema, {
    payload: { case: "setSkillEnabled", value: {
      skillId: descriptor.skillId,
      expectedResourceRevision: descriptor.entityVersion.revision,
      enabled: false
    } }
  });
  const remove = roundTrip(contract.OperationMutationSchema, {
    payload: { case: "deleteSkill", value: { sessionId: session.sessionId, confirmation: descriptor.name } }
  });
  assert.equal(apply.payload.case, "applySkillDraft");
  assert.equal(toggle.payload.value.expectedResourceRevision.value, 9007199254740993n);
  assert.equal(remove.payload.value.confirmation, descriptor.name);
});

test("Skill market contracts preserve exact source, install, and durable sync authority without leaking service paths", () => {
  const methods = methodNames(contract.SkillService);
  for (const name of [
    "getSkillMarketGitPreflight", "listSkillMarketSources", "listSkillMarketCatalog", "getSkillMarketEntry",
    "openSkillMarketPreview", "listSkillMarketPreviewFiles", "readSkillMarketPreviewFile", "closeSkillMarketPreview",
    "createSkillMarketInstallPlan", "getSkillMarketInstallPlan", "closeSkillMarketInstallPlan",
    "listSkillMarketSyncPolicies", "listSkillMarketSyncJobs", "getSkillMarketSyncJob"
  ]) assert.equal(methods.has(name), true, name);

  assertNoFields([
    contract.SkillMarketSourceDescriptorSchema,
    contract.SkillMarketEntrySchema,
    contract.SkillMarketPreviewSchema,
    contract.SkillMarketPreviewFileSchema,
    contract.SkillMarketInstallPlanSchema,
    contract.SkillMarketInstallPreviewSchema,
    contract.SkillMarketCurrentResourceSchema,
    contract.SkillMarketSyncPolicySchema,
    contract.SkillMarketSyncJobSchema,
    contract.ListSkillMarketSourcesResponseSchema,
    contract.ListSkillMarketCatalogResponseSchema,
    contract.OpenSkillMarketPreviewResponseSchema,
    contract.CreateSkillMarketInstallPlanResponseSchema
  ], [
    "path", "server_path", "absolute_path", "source_path", "archive_path", "cache_root",
    "generation", "generation_path", "candidate_path", "workspace_root", "credential", "credential_value"
  ]);

  const identity = {
    sourceId: "skill_market_source_0123456789abcdef0123456789abcdef",
    sourceRevision: { value: 9007199254740993n },
    entryId: "skill_market_entry_0123456789abcdef0123456789abcdef",
    entryRevision: { value: 9007199254740995n },
    contentRevision: `sha256:${"a".repeat(64)}`
  };
  const entry = roundTrip(contract.SkillMarketEntrySchema, {
    identity,
    slug: "writer",
    name: "Writer",
    description: "Writing helper",
    category: "Writing",
    tags: ["writing"],
    version: "1.2.3",
    downloads: 42n,
    trendScore: 3.5,
    archiveBytes: 1024n,
    sourceName: "team-skills",
    sourceState: contract.SkillMarketSourceState.READY
  });
  assert.equal(entry.identity.sourceRevision.value, 9007199254740993n);
  assert.equal(entry.identity.entryRevision.value, 9007199254740995n);

  const globalTarget = roundTrip(contract.SkillMarketInstallTargetSchema, {
    backendId: "pi",
    scope: contract.ResourceScope.GLOBAL
  });
  assert.equal(globalTarget.targetId, undefined);
  assert.equal(globalTarget.relativeParent, undefined);
  const customTarget = roundTrip(contract.SkillMarketInstallTargetSchema, {
    backendId: "pi",
    scope: contract.ResourceScope.PROJECT,
    targetId: "target-a",
    relativeParent: ".joko/skills"
  });
  assert.equal(customTarget.relativeParent, ".joko/skills");

  const mutations = [
    { case: "addSkillMarketSource", value: { source: { kind: { case: "local", value: { serverPath: "D:/selected/skills" } } }, expectedCatalogRevision: { value: 1n } } },
    { case: "refreshSkillMarketSource", value: { sourceId: identity.sourceId, expectedRevision: identity.sourceRevision } },
    { case: "removeSkillMarketSource", value: { sourceId: identity.sourceId, expectedRevision: identity.sourceRevision } },
    { case: "installSkillMarketPlan", value: { planId: "skill_market_install_0123456789abcdef0123456789abcdef", expectedCandidateRevision: identity.contentRevision, confirmReplacement: true } },
    { case: "enableSkillMarketSync", value: { resourceId: "resource-skill", expectedResourceRevision: { value: 7n }, target: customTarget } },
    { case: "disableSkillMarketSync", value: { resourceId: "resource-skill", expectedPolicyRevision: { value: 8n } } },
    { case: "enqueueSkillMarketSync", value: { resourceId: "resource-skill", expectedPolicyRevision: { value: 8n } } },
    { case: "cancelSkillMarketSync", value: { jobId: "skill_sync_0123456789abcdef0123456789abcdef", expectedRevision: { value: 9n } } },
    { case: "retrySkillMarketSync", value: { jobId: "skill_sync_0123456789abcdef0123456789abcdef", expectedRevision: { value: 10n } } }
  ];
  for (const payload of mutations) {
    const decoded = roundTrip(contract.OperationMutationSchema, { payload });
    assert.equal(decoded.payload.case, payload.case);
  }
});

test("auxiliary routing preserves ordered exact routes and independent revisions", () => {
  const models = [
    { backendId: "backend-a", providerId: "provider", modelId: "model" },
    { backendId: "backend-b", providerId: "provider", modelId: "model" }
  ];
  const value = roundTrip(contract.AuxiliaryTextSettingsSchema, {
    models, automaticModels: [models[1]],
    options: [{ route: models[0], available: false, unavailableReason: "Credentials are unavailable." }],
    revision: { value: 9007199254740993n }, runtimeRevision: "service-incarnation:7"
  });
  assert.deepEqual(value.models.map(({ backendId, providerId, modelId }) => ({ backendId, providerId, modelId })), models);
  assert.equal(value.revision.value, 9007199254740993n);
  assert.equal(value.runtimeRevision, "service-incarnation:7");
  assert.equal(value.options[0].available, false);
  const reset = roundTrip(contract.OperationMutationSchema, {
    payload: { case: "updateAuxiliaryTextSettings", value: { models: [], expectedRevision: { value: 8n } } }
  });
  assert.equal(reset.payload.case, "updateAuxiliaryTextSettings");
  assert.deepEqual(reset.payload.value.models, []);
  assert.equal(reset.payload.value.expectedRevision.value, 8n);
});

test("Browser page-open mutations carry one exact presentation target", () => {
  const target = field(contract.OpenBrowserPageMutationSchema, "presentation_target");
  assert.equal(target.number, 9);
  assert.equal(target.enum?.typeName, "joko.v1.BrowserAutomationTarget");
  const omitted = roundTrip(contract.OpenBrowserPageMutationSchema, {
    browserProviderId: "browser",
    sessionId: "session"
  });
  assert.equal(omitted.presentationTarget, contract.BrowserAutomationTarget.UNSPECIFIED);
  const external = roundTrip(contract.OpenBrowserPageMutationSchema, {
    browserProviderId: "browser",
    sessionId: "session",
    presentationTarget: contract.BrowserAutomationTarget.EXTERNAL
  });
  assert.equal(external.presentationTarget, contract.BrowserAutomationTarget.EXTERNAL);
});

test("public enum wire numbers remain stable", () => {
  const cases = [
    [contract.CapabilitySupport, {
      SUPPORTED: 1, UPSTREAM_MISSING: 2, NOT_IMPLEMENTED: 3, PLATFORM_LIMITED: 4,
      DISABLED_BY_POLICY: 5, TEMPORARILY_UNAVAILABLE: 6
    }],
    [contract.QueueDeliveryMode, { PROMPT: 1, STEER: 2, FOLLOW_UP: 3 }],
    [contract.QueueItemState, {
      ACCEPTED: 1, DISPATCHING: 2, BACKEND_ACCEPTED: 3, DISPATCH_UNKNOWN: 4,
      COMPLETED: 5, CANCELLED: 6, FAILED: 7
    }],
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
    [contract.ResourceAcquisitionKind, { LOCAL: 1, NPM: 2, GIT: 3, EXTENSION_SOURCE: 4, SKILL_MARKET: 5 }],
    [contract.SkillMarketSourceKind, { LOCAL: 1, GIT: 2 }],
    [contract.SkillMarketSort, { TRENDING: 1, DOWNLOADS: 2, UPDATED: 3, CREATED: 4 }],
    [contract.SkillMarketInstallAction, { INSTALL: 1, UPDATE: 2, REPLACE: 3 }],
    [contract.SkillMarketSyncJobState, {
      PENDING_REVALIDATION: 1, RUNNING: 2, CANCELLING: 3, SUCCEEDED: 4,
      UP_TO_DATE: 5, BLOCKED: 6, FAILED: 7, CANCELLED: 8
    }],
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
