import { create, toBinary } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { createHash } from "node:crypto";
import {
  AcknowledgementSchema, ArtifactKind, ArtifactSchema, BackendDescriptorSchema, BackendModelAccessSettingsSchema, BackendSettingsSchema, BlobDisposition, BlobRefSchema,
  CapabilityManifestSchema, CapabilityOptionsSchema, CapabilitySchema, CapabilitySupport, CompactSessionOutcome, ConnectionSchema, ConnectionState,
  ContextUsageSchema, DeviceKind, DevicePresenceState, DeviceSchema, EntityKind, EntityVersionSchema,
  FileKind, FilePreviewSchema, FileRevisionSchema, TargetSchema, WorkspaceDescriptorSchema, WorkspaceEntrySchema, WorkspaceFileChangeKind, WorkspaceFileChangeSchema,
  WorkspaceSearchMatchSchema,
  JOKO_API_VERSION, NativeEntryKind, NativeSessionBindingSchema, NativeSessionTreeNodeSchema, NativeSessionTreeSchema, OperationSchema,
  InputCapabilityOptionsSchema, InteractionKind, InteractionSchema, InteractionState, PermissionDecisionKind, PermissionRisk, PlanReviewDecisionKind,
  EventCursorSchema, EventSchema, ImageRefSchema, MessageRole, ModelDescriptorSchema, ModelInputModality, ModelKeySchema, ModelOutputModality, ModelSelectionSchema,
  OperationMutationSchema, OperationState, OwnerSnapshotScopeSchema, PermissionMode,
  ProviderDescriptorSchema, ProviderKind, RevisionSchema, SessionMessageSearchMatchSchema, SessionSnapshotScopeSchema,
  SettingsSnapshotSchema, SnapshotScopeSchema, UsageSchema,
  QueueControlSchema, QueueDeliveryMode, QueueDispatchState, QueueItemSchema, QueueItemState, QueueSourceKind, ResourceKind,
  ReviewRunSchema, ReviewRunState, RuntimeCommandSchema, RuntimeCommandSource, SessionResourceSchema,
  RunState, ScheduleExecutionMode, ScheduleFireSource, ScheduleMisfirePolicy, ScheduleOverlapPolicy,
  ScheduleGeneratedSessionDisposition,
  ScheduleDeletionResultSchema, ScheduleRunCostAttribution, ScheduleRunHistorySchema, ScheduleRunOutcome, ScheduleRunPhase, ScheduleSchema,
  ScheduleSessionMode, ScheduleSource, ScheduleState, SchedulerRuntimeSnapshotSchema,
  SessionContextStateSchema, SessionMessageSearchSessionStatus, SessionSchema, SessionState, SnapshotSchema,
  TargetState, WorkspaceKind, capabilityNames, nativeSessionTreeWireFields
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileClient, type MobileStorage, type PendingOperation } from "./mobile-client";
import { MobileCredentialStorageError, profileFromCredential } from "./connection-storage";
import type { MobileDiscovery } from "./connection-discovery";
import {
  normalizeNodeOrigin,
  parseNodeIdentity,
  type AuthorizedBlobDownload,
  type MobileNetwork,
  type NodeIdentity,
  type PairedCredential
} from "./network";
import type { Event, Operation, Schedule, ScheduleInput, SessionMessageSearchMatch, Snapshot, WorkspaceEntry, WorkspaceFileChange } from "@joko/contracts";
import type { MobileInteractionDraftIdentity } from "./interaction-draft-store";
import { MobileComposerDraftStore } from "./composer-draft-store";
import { MobileNewTaskDraftStore } from "./new-task-draft-store";
import { MobileAttachmentFiles, type MobileAttachmentFileDriver } from "./mobile-attachment-files";
import {
  MobileMediaPreviewFiles,
  type MobileMediaPreviewFileDriver,
  type MobileMediaPreviewFileSnapshot
} from "./mobile-media-preview";
import {
  MobilePdfPreviewFiles,
  type MobilePdfPreviewFileDriver,
  type MobilePdfPreviewFileSnapshot
} from "./mobile-pdf-preview";
import {
  MobileModelPreviewFiles,
  type MobileModelPreviewFileDriver,
  type MobileModelPreviewFileSnapshot
} from "./mobile-model-preview";
import type { MobileFileShare } from "./mobile-file-share";
import { MobileOfflineCache, type MobileOfflineCacheStorage } from "./mobile-offline-cache";
import type { MobileLocalComposerAttachment } from "./mobile-attachments";
import type { MobilePlainStorageDriver } from "./connection-storage";
import type { MobileVoiceCapability, MobileVoiceSession } from "./mobile-voice-input";
import { timelineRows } from "./timeline";
import {
  insertMobileArtifactMention,
  insertMobileResourceMention,
  insertMobileSessionMention,
  insertMobileStructuredClipboardText,
  insertMobileWorkspaceMention,
  mobileComposerInput,
  plainTextMobileComposerDraft,
  type MobileComposerDraft
} from "./mobile-composer-document";
import { createMobileAutomationDraft } from "./mobile-automation-authoring";

const credential: PairedCredential = {
  profileId: "mobile-profile", origin: "http://192.168.1.20:4318", serverId: "node-1", connectionId: "mobile-connection",
  deviceId: "mobile-device", displayName: "Phone", authKey: "private-key"
};
const node: NodeIdentity = {
  serverId: "node-1", displayName: "Joko", version: "1.0.0", apiVersion: JOKO_API_VERSION, health: 1, pairingEnabled: true
};
const connection = create(ConnectionSchema, {
  connectionId: credential.connectionId, connectionProfileId: credential.profileId, deviceId: credential.deviceId,
  state: ConnectionState.CONNECTED, version: { revision: { value: 4n } }
});
const device = create(DeviceSchema, {
  deviceId: credential.deviceId, displayName: "Phone", kind: DeviceKind.MOBILE, platform: "android",
  connectionIds: [credential.connectionId], presence: DevicePresenceState.ONLINE, version: { revision: { value: 5n } }
});
const otherCredential: PairedCredential = {
  ...credential,
  profileId: "mobile-profile-two",
  connectionId: "mobile-connection-two",
  deviceId: "mobile-device-two",
  displayName: "Tablet",
  authKey: "private-key-two"
};
const otherConnection = create(ConnectionSchema, {
  connectionId: otherCredential.connectionId, connectionProfileId: otherCredential.profileId,
  deviceId: otherCredential.deviceId, displayName: otherCredential.displayName,
  state: ConnectionState.CONNECTED, version: { revision: { value: 6n } }
});
const otherDevice = create(DeviceSchema, {
  deviceId: otherCredential.deviceId, displayName: otherCredential.displayName, kind: DeviceKind.MOBILE,
  platform: "ios", connectionIds: [otherCredential.connectionId], presence: DevicePresenceState.OFFLINE,
  version: { revision: { value: 7n } }
});
const snapshot = create(SnapshotSchema, {
  generation: 1n, resumeCursor: { opaqueToken: "cursor-10", sequence: 10n, generation: 1n },
  server: { serverId: node.serverId, displayName: node.displayName, version: node.version, apiVersion: node.apiVersion,
    health: node.health, pairingEnabled: node.pairingEnabled },
  connections: [connection], devices: [device],
  backends: [{ backendId: "backend", displayName: "Backend", capabilities: {
    capabilities: [{ name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }]
  } }],
  targets: [{ targetId: "target", backendId: "backend", displayName: "Project", state: TargetState.ACTIVE,
    version: { revision: { value: 3n } } }],
  workspaces: [{ workspaceId: "workspace", targetId: "target", displayName: "Project", kind: WorkspaceKind.USER_PROJECT }],
  sessions: [{ sessionId: "session", backendId: "backend", targetId: "target", displayName: "Task", state: SessionState.IDLE,
    nativeBinding: { runtimeGeneration: 8n }, version: { revision: { value: 9n } } }]
});
const automationInterruptedRun = create(ScheduleRunHistorySchema, {
  triggerId: "trigger-interrupted",
  runId: "run-interrupted",
  scheduledFor: { seconds: 10n },
  triggeredAt: { seconds: 11n },
  finishedAt: { seconds: 12n },
  state: RunState.ABORTED,
  outcome: ScheduleRunOutcome.INTERRUPTED,
  costAttribution: ScheduleRunCostAttribution.UNAVAILABLE,
  duration: { seconds: 1n }
});
const automationCompletedRun = create(ScheduleRunHistorySchema, {
  triggerId: "trigger-completed",
  runId: "run-completed",
  sessionId: "session",
  scheduledFor: { seconds: 20n },
  triggeredAt: { seconds: 21n },
  finishedAt: { seconds: 22n },
  state: RunState.SUCCEEDED,
  outcome: ScheduleRunOutcome.SUCCEEDED,
  costAttribution: ScheduleRunCostAttribution.ZERO,
  zeroCost: true,
  duration: { seconds: 1n }
});
const automationSchedule = create(ScheduleSchema, {
  scheduleId: "schedule-one",
  displayName: "Morning check",
  state: ScheduleState.ENABLED,
  backendId: "backend",
  targetId: "target",
  recurrence: { kind: { case: "manual", value: {} } },
  timeZone: "UTC",
  input: { parts: [{ content: { case: "text", value: "Check the build" } }] },
  execution: { executionMode: ScheduleExecutionMode.AGENT, permissionMode: PermissionMode.ASK },
  overlapPolicy: ScheduleOverlapPolicy.QUEUE,
  misfirePolicy: ScheduleMisfirePolicy.RUN_ONCE,
  recentRuns: [automationCompletedRun],
  sessionMode: ScheduleSessionMode.FRESH,
  source: ScheduleSource.USER,
  unreadRunCount: 1,
  version: { revision: { value: 7n, etag: "schedule-r7" }, generation: 2n, updatedAt: { seconds: 23n } }
});
const automationOwnerSnapshot = create(SnapshotSchema, {
  ...snapshot,
  revision: create(RevisionSchema, { value: 12n, etag: "owner-r12" }),
  schedules: [automationSchedule]
});
const automationGeneratedSession = create(SessionSchema, {
  sessionId: "generated-session",
  backendId: "backend",
  targetId: "target",
  displayName: "Generated task",
  state: SessionState.IDLE,
  automationOrigin: { scheduleId: automationSchedule.scheduleId, scheduleName: "Morning check", runId: "run-generated" },
  version: { revision: { value: 2n }, generation: 1n }
});
const automationAuthoringOwnerSnapshot = create(SnapshotSchema, {
  ...automationOwnerSnapshot,
  scope: create(SnapshotScopeSchema, { kind: { case: "owner", value: create(OwnerSnapshotScopeSchema) } }),
  backends: [create(BackendDescriptorSchema, {
    ...snapshot.backends[0]!,
    entityVersion: create(EntityVersionSchema, { revision: create(RevisionSchema, { value: 2n }), generation: 1n })
  })],
  targets: [create(TargetSchema, {
    ...snapshot.targets[0]!,
    workspaceId: "workspace",
    version: create(EntityVersionSchema, {
      revision: create(RevisionSchema, { value: 3n, etag: "target-r3" }), generation: 1n
    })
  })],
  workspaces: [create(WorkspaceDescriptorSchema, {
    ...snapshot.workspaces[0]!,
    serverPathDisplay: "D:\\project",
    trusted: true,
    version: create(EntityVersionSchema, { revision: create(RevisionSchema, { value: 3n }), generation: 1n })
  })],
  sessions: [snapshot.sessions[0]!, automationGeneratedSession],
  settings: create(SettingsSnapshotSchema, {
    revision: { value: 4n },
    backends: [create(BackendSettingsSchema, {
      backendId: "backend",
      enabled: true,
      defaultPermissionMode: PermissionMode.ASK,
      modelAccess: create(BackendModelAccessSettingsSchema)
    })]
  })
});
const automationRuntime = create(SchedulerRuntimeSnapshotSchema, {
  schedulerInstanceId: "scheduler-one",
  inFlight: 1,
  slotsInUse: 1,
  maxConcurrentRuns: 4,
  inFlightRuns: [{
    scheduleId: automationSchedule.scheduleId,
    scheduleName: automationSchedule.displayName,
    runId: "inflight-one",
    source: ScheduleFireSource.AUTOMATIC,
    executionMode: ScheduleExecutionMode.AGENT,
    startedAt: { seconds: 24n },
    phase: ScheduleRunPhase.RUNNING,
    lastProgressAt: { seconds: 25n }
  }]
});
const extendedSnapshot = create(SnapshotSchema, {
  ...snapshot,
  connections: [connection, otherConnection],
  devices: [device, otherDevice]
});
const relatedSession = create(SessionSchema, {
  ...snapshot.sessions[0]!,
  sessionId: "related",
  displayName: "Earlier task",
  nativeBinding: create(NativeSessionBindingSchema, { runtimeGeneration: 6n }),
  version: create(EntityVersionSchema, {
    revision: create(RevisionSchema, { value: 7n, etag: "related-r7" }),
    generation: 6n
  })
});
const sessionMentionSnapshot = create(SnapshotSchema, {
  ...snapshot,
  backends: [create(BackendDescriptorSchema, {
    ...snapshot.backends[0]!,
    version: "backend-v1",
    capabilities: create(CapabilityManifestSchema, {
      schemaVersion: "1",
      revision: create(RevisionSchema, { value: 4n, etag: "capabilities-r4" }),
      capabilities: [
        create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
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
  })],
  sessions: [snapshot.sessions[0]!, relatedSession]
});
const workspaceMentionSnapshot = create(SnapshotSchema, {
  ...snapshot,
  backends: [create(BackendDescriptorSchema, {
    ...snapshot.backends[0]!,
    version: "backend-v1",
    capabilities: create(CapabilityManifestSchema, {
      schemaVersion: "1",
      revision: create(RevisionSchema, { value: 4n, etag: "capabilities-r4" }),
      capabilities: [
        create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
        create(CapabilitySchema, {
          name: capabilityNames.inputMention,
          support: CapabilitySupport.SUPPORTED,
          options: create(CapabilityOptionsSchema, {
            kind: { case: "input", value: create(InputCapabilityOptionsSchema, {
              mediaTypes: ["workspace_file", "workspace_directory", "workspace_line_range"]
            }) }
          })
        })
      ]
    })
  })],
  targets: [create(TargetSchema, { ...snapshot.targets[0]!, workspaceId: "workspace" })]
});
const newTaskMentionSnapshot = create(SnapshotSchema, {
  ...workspaceMentionSnapshot,
  backends: [create(BackendDescriptorSchema, {
    ...workspaceMentionSnapshot.backends[0]!,
    capabilities: create(CapabilityManifestSchema, {
      schemaVersion: workspaceMentionSnapshot.backends[0]!.capabilities?.schemaVersion ?? "",
      revision: workspaceMentionSnapshot.backends[0]!.capabilities?.revision,
      capabilities: [
        create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
        create(CapabilitySchema, {
          name: capabilityNames.inputMention,
          support: CapabilitySupport.SUPPORTED,
          options: create(CapabilityOptionsSchema, {
            kind: { case: "input", value: create(InputCapabilityOptionsSchema, {
              mediaTypes: ["session", "workspace_file", "workspace_directory", "workspace_line_range", "resource", "artifact"]
            }) }
          })
        })
      ]
    })
  })],
  sessions: [snapshot.sessions[0]!, relatedSession]
});
const workspacePathSnapshot = create(SnapshotSchema, {
  ...newTaskMentionSnapshot,
  backends: [create(BackendDescriptorSchema, {
    ...newTaskMentionSnapshot.backends[0]!,
    capabilities: create(CapabilityManifestSchema, {
      ...newTaskMentionSnapshot.backends[0]!.capabilities!,
      capabilities: [
        ...(newTaskMentionSnapshot.backends[0]!.capabilities?.capabilities ?? []),
        create(CapabilitySchema, {
          name: capabilityNames.workspaceFiles,
          support: CapabilitySupport.SUPPORTED
        })
      ]
    })
  })],
  workspaces: [create(WorkspaceDescriptorSchema, {
    ...newTaskMentionSnapshot.workspaces[0]!,
    serverPathDisplay: "D:\\repo",
    version: create(EntityVersionSchema, {
      generation: 8n,
      revision: create(RevisionSchema, { value: 9n, etag: "workspace-r9" })
    })
  })]
});
const runtimeCommandSnapshot = create(SnapshotSchema, {
  ...snapshot,
  backends: [create(BackendDescriptorSchema, {
    ...snapshot.backends[0]!,
    version: "backend-runtime-commands-v1",
    entityVersion: create(EntityVersionSchema, {
      generation: 1n,
      revision: create(RevisionSchema, { value: 5n, etag: "backend-r5" })
    }),
    capabilities: create(CapabilityManifestSchema, {
      schemaVersion: "1",
      revision: create(RevisionSchema, { value: 6n, etag: "capabilities-r6" }),
      capabilities: [
        create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
        create(CapabilitySchema, { name: capabilityNames.runtimeCommands, support: CapabilitySupport.SUPPORTED })
      ]
    })
  })],
  targets: [create(TargetSchema, {
    ...snapshot.targets[0]!,
    version: create(EntityVersionSchema, {
      generation: 1n,
      revision: create(RevisionSchema, { value: 3n, etag: "target-r3" })
    })
  })],
  sessions: [create(SessionSchema, {
    ...snapshot.sessions[0]!,
    nativeBinding: create(NativeSessionBindingSchema, { runtimeGeneration: 8n }),
    version: create(EntityVersionSchema, {
      generation: 8n,
      revision: create(RevisionSchema, { value: 9n, etag: "session-r9" })
    })
  })]
});
const attachmentSnapshot = create(SnapshotSchema, {
  ...snapshot,
  backends: [create(BackendDescriptorSchema, {
    ...snapshot.backends[0]!,
    version: "backend-attachments-v1",
    capabilities: create(CapabilityManifestSchema, {
      schemaVersion: "1",
      revision: create(RevisionSchema, { value: 5n, etag: "capabilities-r5" }),
      capabilities: [
        create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
        create(CapabilitySchema, {
          name: capabilityNames.inputImage,
          support: CapabilitySupport.SUPPORTED,
          options: create(CapabilityOptionsSchema, {
            kind: { case: "input", value: create(InputCapabilityOptionsSchema, {
              mediaTypes: ["image/png"], maximumBytes: 1_024n, maximumItems: 4
            }) }
          })
        }),
        create(CapabilitySchema, {
          name: capabilityNames.inputFile,
          support: CapabilitySupport.SUPPORTED,
          options: create(CapabilityOptionsSchema, {
            kind: { case: "input", value: create(InputCapabilityOptionsSchema, {
              mediaTypes: ["application/pdf"], maximumBytes: 1_024n, maximumItems: 4
            }) }
          })
        })
      ]
    })
  })],
  sessions: [create(SessionSchema, {
    ...snapshot.sessions[0]!,
    model: create(ModelSelectionSchema, {
      model: create(ModelKeySchema, { providerId: "vision-provider", modelId: "vision-model" })
    })
  })],
  providers: [create(ProviderDescriptorSchema, {
    backendId: "backend",
    providerId: "vision-provider",
    displayName: "Vision Provider",
    kind: ProviderKind.SUBSCRIPTION
  })],
  models: [create(ModelDescriptorSchema, {
    backendId: "backend",
    key: create(ModelKeySchema, { providerId: "vision-provider", modelId: "vision-model" }),
    displayName: "Vision model",
    family: "vision",
    inputModalities: [ModelInputModality.TEXT, ModelInputModality.IMAGE],
    outputModalities: [ModelOutputModality.TEXT],
    available: true
  })],
  settings: create(SettingsSnapshotSchema, {
    revision: create(RevisionSchema, { value: 7n, etag: "settings-r7" }),
    backends: [create(BackendSettingsSchema, {
      backendId: "backend",
      enabled: true,
      defaultModel: create(ModelSelectionSchema, {
        model: create(ModelKeySchema, { providerId: "vision-provider", modelId: "vision-model" })
      }),
      modelAccess: create(BackendModelAccessSettingsSchema, {})
    })]
  })
});
const appCommandSnapshot = create(SnapshotSchema, {
  ...attachmentSnapshot,
  backends: [create(BackendDescriptorSchema, {
    ...attachmentSnapshot.backends[0]!,
    version: "backend-app-commands-v1",
    entityVersion: create(EntityVersionSchema, {
      generation: 1n,
      revision: create(RevisionSchema, { value: 6n, etag: "backend-r6" })
    }),
    capabilities: create(CapabilityManifestSchema, {
      ...attachmentSnapshot.backends[0]!.capabilities!,
      revision: create(RevisionSchema, { value: 7n, etag: "capabilities-r7" }),
      capabilities: [
        ...attachmentSnapshot.backends[0]!.capabilities!.capabilities,
        create(CapabilitySchema, { name: capabilityNames.runtimeUserShell, support: CapabilitySupport.SUPPORTED }),
        create(CapabilitySchema, { name: capabilityNames.sessionReset, support: CapabilitySupport.SUPPORTED }),
        create(CapabilitySchema, { name: capabilityNames.reviewIsolated, support: CapabilitySupport.SUPPORTED })
      ]
    })
  })],
  targets: [create(TargetSchema, {
    ...attachmentSnapshot.targets[0]!,
    version: create(EntityVersionSchema, {
      generation: 1n,
      revision: create(RevisionSchema, { value: 3n, etag: "target-r3" })
    })
  })],
  sessions: [
    create(SessionSchema, {
      ...attachmentSnapshot.sessions[0]!,
      nativeBinding: create(NativeSessionBindingSchema, { runtimeGeneration: 8n }),
      version: create(EntityVersionSchema, {
        generation: 8n,
        revision: create(RevisionSchema, { value: 9n, etag: "session-r9" })
      })
    }),
    relatedSession
  ]
});
const workspaceMentionDirectory = create(WorkspaceEntrySchema, {
  workspaceId: "workspace", relativePath: "src", displayName: "src", kind: FileKind.DIRECTORY
});
const workspaceMentionFile = create(WorkspaceEntrySchema, {
  workspaceId: "workspace", relativePath: "src/main.ts", displayName: "main.ts", kind: FileKind.REGULAR
});

function newTaskStructuredInput() {
  const session = insertMobileSessionMention(
    plainTextMobileComposerDraft("Use"),
    { start: 3, end: 3 },
    { sessionId: "related", displayText: "Earlier task" },
    "new-task-session"
  );
  return insertMobileWorkspaceMention(
    session.draft,
    session.selection,
    {
      workspaceId: "workspace",
      relativePath: "src/main.ts",
      displayText: "main.ts",
      directory: false,
      lineRange: { startLine: 2, endLine: 4 }
    },
    "new-task-workspace"
  ).draft;
}

function workspacePathDraft(): MobileComposerDraft {
  return insertMobileStructuredClipboardText(
    plainTextMobileComposerDraft("Open "),
    { start: 5, end: 5 },
    "D:\\repo\\src\\main.ts",
    () => "workspace-path",
    { workspacePath: {
      workspaceId: "workspace",
      serverPathDisplay: "D:\\repo",
      resolutions: [{
        candidateRelativePath: "src/main.ts",
        relativePath: "src/main.ts",
        directory: false
      }]
    } }
  ).draft;
}
const catalogMentionSession = create(SessionSchema, {
  ...snapshot.sessions[0]!,
  version: create(EntityVersionSchema, {
    generation: 8n,
    revision: create(RevisionSchema, { value: 9n, etag: "session-r9" })
  })
});
const catalogMentionSnapshot = create(SnapshotSchema, {
  ...snapshot,
  backends: [create(BackendDescriptorSchema, {
    ...snapshot.backends[0]!,
    version: "backend-v1",
    capabilities: create(CapabilityManifestSchema, {
      schemaVersion: "1",
      revision: create(RevisionSchema, { value: 4n, etag: "capabilities-r4" }),
      capabilities: [
        create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
        create(CapabilitySchema, {
          name: capabilityNames.inputMention,
          support: CapabilitySupport.SUPPORTED,
          options: create(CapabilityOptionsSchema, {
            kind: { case: "input", value: create(InputCapabilityOptionsSchema, {
              mediaTypes: ["resource", "artifact"]
            }) }
          })
        })
      ]
    })
  })],
  sessions: [catalogMentionSession, relatedSession]
});
const catalogMentionResource = create(SessionResourceSchema, {
  sessionId: "session", resourceId: "resource-one", kind: ResourceKind.SKILL, name: "Release helper",
  version: "1.2.3", discoveredRevision: "sha256:resource-one", resourceVersion: 7n, runtimeGeneration: 8n
});
const catalogMentionArtifact = create(ArtifactSchema, {
  artifactId: "artifact-one", sessionId: "related", kind: ArtifactKind.TOOL_RESULT, title: "Release report",
  blob: create(BlobRefSchema, {
    blobId: "blob-artifact-one", fileName: "report.txt", mediaType: "text/plain", byteSize: 42n,
    sha256Hex: "a".repeat(64)
  }),
  createdAt: { seconds: 1n }
});
const filesSnapshot = create(SnapshotSchema, {
  ...snapshot,
  snapshotId: "files-snapshot",
  backends: [create(BackendDescriptorSchema, {
    ...snapshot.backends[0]!,
    capabilities: create(CapabilityManifestSchema, { capabilities: [
      create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.workspaceFiles, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.workspaceFilesWatch, support: CapabilitySupport.SUPPORTED })
    ] })
  })],
  targets: [create(TargetSchema, { ...snapshot.targets[0]!, workspaceId: "workspace" })]
});
const messageEvent = create(EventSchema, {
  eventId: "event-completed",
  identity: { sessionId: "session" },
  cursor: { opaqueToken: "cursor-11", sequence: 11n, generation: 1n },
  payload: { kind: { case: "messageCompleted", value: {
    messageId: "message-1",
    role: MessageRole.ASSISTANT,
    blocks: [{ content: { case: "text", value: "Durable answer" } }]
  } } }
});
const messageActionSnapshot = create(SnapshotSchema, {
  ...snapshot,
  backends: [create(BackendDescriptorSchema, {
    ...snapshot.backends[0]!,
    capabilities: create(CapabilityManifestSchema, { capabilities: [
      create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.sessionMessageDelete, support: CapabilitySupport.SUPPORTED })
    ] })
  })],
  timeline: [messageEvent]
});
const queueOne = create(QueueItemSchema, {
  queueItemId: "queue-1", backendId: "backend", targetId: "target", sessionId: "session",
  sourceKind: QueueSourceKind.UI, deliveryMode: QueueDeliveryMode.FOLLOW_UP,
  state: QueueItemState.ACCEPTED, ordinal: 10n, editLocked: false,
  version: { revision: { value: 11n, etag: "queue-1-r11" }, generation: 1n },
  input: { parts: [
    { content: { case: "text", value: "First queued input" } },
    { content: { case: "sessionMention", value: { sessionId: "related", displayText: "Related task" } } }
  ] }
});
const queueTwo = create(QueueItemSchema, {
  queueItemId: "queue-2", backendId: "backend", targetId: "target", sessionId: "session",
  sourceKind: QueueSourceKind.UI, deliveryMode: QueueDeliveryMode.PROMPT,
  state: QueueItemState.ACCEPTED, ordinal: 20n, editLocked: false,
  version: { revision: { value: 12n, etag: "queue-2-r12" }, generation: 1n },
  input: { parts: [{ content: { case: "text", value: "Second queued input" } }] }
});
const queueControl = create(QueueControlSchema, {
  sessionId: "session", backendId: "backend", targetId: "target",
  dispatchState: QueueDispatchState.PAUSED, queuedItemCount: 2n, interactionLocked: false,
  version: { revision: { value: 21n, etag: "queue-control-r21" }, generation: 1n }
});
const queueSnapshot = create(SnapshotSchema, {
  ...snapshot,
  backends: [create(BackendDescriptorSchema, {
    ...snapshot.backends[0]!,
    capabilities: create(CapabilityManifestSchema, { capabilities: [
      create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.queueCancel, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.queueEdit, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.queueReorder, support: CapabilitySupport.SUPPORTED })
    ] })
  })],
  queueItems: [queueTwo, queueOne],
  queueControls: [queueControl]
});
const permissionInteraction = create(InteractionSchema, {
  interactionId: "interaction-permission",
  kind: InteractionKind.PERMISSION,
  state: InteractionState.PENDING,
  backendId: "backend",
  targetId: "target",
  sessionId: "session",
  generation: 8n,
  createdAt: { seconds: 20n },
  request: { case: "permission", value: {
    risk: PermissionRisk.HIGH,
    title: "Run command",
    allowedDecisions: [PermissionDecisionKind.ALLOW_ONCE, PermissionDecisionKind.DENY_ONCE]
  } },
  version: { revision: { value: 44n, etag: "interaction-r44" }, generation: 8n }
});
const questionInteraction = create(InteractionSchema, {
  interactionId: "interaction-question",
  kind: InteractionKind.QUESTION,
  state: InteractionState.PENDING,
  backendId: "backend",
  targetId: "target",
  sessionId: "session",
  generation: 8n,
  createdAt: { seconds: 10n },
  request: { case: "question", value: {
    title: "Choose",
    fields: [{ fieldId: "answer", label: "Answer", required: true, input: { case: "text", value: {} } }]
  } },
  version: { revision: { value: 45n, etag: "interaction-r45" }, generation: 8n }
});
const planInteraction = create(InteractionSchema, {
  interactionId: "interaction-plan",
  kind: InteractionKind.PLAN_REVIEW,
  state: InteractionState.PENDING,
  backendId: "backend",
  targetId: "target",
  sessionId: "session",
  generation: 8n,
  createdAt: { seconds: 30n },
  request: { case: "planReview", value: {
    title: "Plan",
    markdown: "# Plan",
    steps: [{ stepId: "step-one", title: "First" }],
    allowedDecisions: [PlanReviewDecisionKind.EXECUTE]
  } },
  version: { revision: { value: 46n, etag: "interaction-r46" }, generation: 8n }
});
const interactionSnapshot = create(SnapshotSchema, {
  ...snapshot,
  interactions: [questionInteraction, permissionInteraction, planInteraction]
});
const runtimeSession = create(SessionSchema, {
  ...snapshot.sessions[0]!,
  model: create(ModelSelectionSchema, {
    model: create(ModelKeySchema, { providerId: "alpha", modelId: "a" }), effortId: "low", fastMode: false
  }),
  permissionMode: PermissionMode.ASK,
  planMode: false,
  context: create(ContextUsageSchema, {
    usedTokens: 50_000n,
    contextWindowTokens: 100_000n,
    reservedTokens: 50_000n,
    utilizationRatio: 0.5,
    cumulativeUsage: create(UsageSchema, {
      inputTokens: 40_000n,
      outputTokens: 5_000n,
      cacheReadTokens: 4_000n,
      cacheWriteTokens: 1_000n,
      totalTokens: 50_000n
    }),
    measuredAt: { seconds: 123n }
  }),
  contextState: create(SessionContextStateSchema, { compacting: false, autoCompaction: true }),
  version: create(EntityVersionSchema, { revision: create(RevisionSchema, { value: 9n, etag: "session-r9" }), generation: 8n })
});
const runtimeBackend = create(BackendDescriptorSchema, {
  ...snapshot.backends[0]!,
  entityVersion: create(EntityVersionSchema, { revision: create(RevisionSchema, { value: 3n }), generation: 2n }),
  capabilities: create(CapabilityManifestSchema, {
    schemaVersion: "1",
    revision: create(RevisionSchema, { value: 4n }),
    capabilities: [
      create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.modelList, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "model", value: { providerAware: true } } } }),
      create(CapabilitySchema, { name: capabilityNames.modelSwitch, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "model", value: { providerAware: true, switchDuringSession: true } } } }),
      create(CapabilitySchema, { name: capabilityNames.modelEffort, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "model", value: { providerAware: true, switchDuringSession: true, supportsEffort: true } } } }),
      create(CapabilitySchema, { name: capabilityNames.modelFastMode, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "model", value: { providerAware: true, switchDuringSession: true, supportsFastMode: true } } } }),
      create(CapabilitySchema, { name: capabilityNames.permissionModes, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "permission", value: {
          modes: [PermissionMode.ASK, PermissionMode.AUTO, PermissionMode.BYPASS_PERMISSIONS],
          mutableDuringSession: true
        } } } }),
      create(CapabilitySchema, { name: capabilityNames.permissionChange, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "permission", value: { mutableDuringSession: true } } } }),
      create(CapabilitySchema, { name: capabilityNames.planMode, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.contextUsage, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "context", value: { reportsBoundary: true } } } }),
      create(CapabilitySchema, { name: capabilityNames.contextCompact, support: CapabilitySupport.SUPPORTED,
        options: { kind: { case: "context", value: { manual: true } } } }),
      create(CapabilitySchema, { name: capabilityNames.sessionTree, support: CapabilitySupport.SUPPORTED }),
      create(CapabilitySchema, { name: capabilityNames.sessionRewind, support: CapabilitySupport.SUPPORTED })
    ]
  })
});
const runtimeModels = [
  create(ModelDescriptorSchema, {
    backendId: "backend", key: { providerId: "alpha", modelId: "a" }, displayName: "Alpha",
    family: "alpha", contextWindowTokens: 64_000n, maximumOutputTokens: 8_000n,
    outputModalities: [ModelOutputModality.TEXT], available: true,
    effortLevels: [{ effortId: "low", displayName: "Low", order: 0, defaultLevel: true },
      { effortId: "high", displayName: "High", order: 1 }]
  }),
  create(ModelDescriptorSchema, {
    backendId: "backend", key: { providerId: "beta", modelId: "b" }, displayName: "Beta",
    family: "beta", contextWindowTokens: 128_000n, maximumOutputTokens: 16_000n,
    outputModalities: [ModelOutputModality.TEXT], available: true, supportsFastMode: true,
    effortLevels: [{ effortId: "medium", displayName: "Medium", order: 0, defaultLevel: true },
      { effortId: "high", displayName: "High", order: 1 }]
  })
];
const runtimeProviders = [
  create(ProviderDescriptorSchema, { backendId: "backend", providerId: "alpha", displayName: "Alpha Provider", kind: ProviderKind.SUBSCRIPTION }),
  create(ProviderDescriptorSchema, { backendId: "backend", providerId: "beta", displayName: "Beta Provider", kind: ProviderKind.SUBSCRIPTION })
];

function runtimeControlProjection(currentSession = runtimeSession, detail = false): Snapshot {
  return create(SnapshotSchema, {
    ...snapshot,
    snapshotId: detail ? "runtime-detail" : "runtime-owner",
    scope: create(SnapshotScopeSchema, { kind: detail
      ? { case: "session", value: create(SessionSnapshotScopeSchema, { sessionId: "session", recentTimelineItems: 120 }) }
      : { case: "owner", value: create(OwnerSnapshotScopeSchema, {}) } }),
    revision: create(RevisionSchema, { value: detail ? 31n : 30n, etag: detail ? "detail-r31" : "owner-r30" }),
    sessions: [currentSession],
    backends: [runtimeBackend],
    ...(detail ? {
      connections: [], devices: [], models: [], providers: [], settings: undefined
    } : {
      models: runtimeModels,
      providers: runtimeProviders,
      settings: create(SettingsSnapshotSchema, {
        revision: create(RevisionSchema, { value: 6n }),
        backends: [create(BackendSettingsSchema, {
          backendId: "backend", enabled: true, modelAccess: create(BackendModelAccessSettingsSchema, {})
        })]
      })
    })
  });
}

function offlineOwnerProjection(sessions: readonly Snapshot["sessions"][number][] = [runtimeSession]): Snapshot {
  const base = runtimeControlProjection(sessions[0] ?? runtimeSession, false);
  return create(SnapshotSchema, {
    ...base,
    generation: 0n,
    resumeCursor: create(EventCursorSchema, {
      opaqueToken: base.resumeCursor?.opaqueToken ?? "owner-cursor",
      sequence: base.resumeCursor?.sequence ?? 0n,
      generation: 0n
    }),
    sessions: [...sessions]
  });
}

function offlineDetailProjection(currentSession = runtimeSession): Snapshot {
  const generation = currentSession.nativeBinding?.runtimeGeneration ?? 0n;
  const base = runtimeControlProjection(currentSession, true);
  return create(SnapshotSchema, {
    ...base,
    scope: create(SnapshotScopeSchema, {
      kind: { case: "session", value: create(SessionSnapshotScopeSchema, {
        sessionId: currentSession.sessionId,
        recentTimelineItems: 120
      }) }
    }),
    generation,
    resumeCursor: create(EventCursorSchema, {
      opaqueToken: base.resumeCursor?.opaqueToken ?? "detail-cursor",
      sequence: base.resumeCursor?.sequence ?? 0n,
      generation
    }),
    sessions: [currentSession]
  });
}

function branchTree(revision: bigint, etag: string, activeEntryId: "native-current" | "native-alternate") {
  return create(NativeSessionTreeSchema, {
    sessionId: "session",
    activeEntryId,
    revision: create(RevisionSchema, { value: revision, etag }),
    ...nativeSessionTreeWireFields([{
      ...create(NativeSessionTreeNodeSchema, {
        entryId: "native-root",
        kind: NativeEntryKind.USER_MESSAGE,
        summary: "Initial prompt",
        createdAt: { seconds: 1n }
      }),
      children: [{
        ...create(NativeSessionTreeNodeSchema, {
          entryId: "native-current",
          parentEntryId: "native-root",
          kind: NativeEntryKind.ASSISTANT_MESSAGE,
          summary: "Current answer",
          active: activeEntryId === "native-current",
          createdAt: { seconds: 2n }
        }),
        children: []
      }, {
        ...create(NativeSessionTreeNodeSchema, {
          entryId: "native-alternate",
          parentEntryId: "native-root",
          kind: NativeEntryKind.ASSISTANT_MESSAGE,
          summary: "Alternate answer",
          active: activeEntryId === "native-alternate",
          createdAt: { seconds: 3n }
        }),
        children: []
      }]
    }])
  });
}

function memoryStorage(saved?: PairedCredential | readonly PairedCredential[], automatic: boolean | string = saved !== undefined) {
  const initial = saved === undefined ? [] : Array.isArray(saved) ? [...saved] : [saved];
  let profiles = initial.map(profileFromCredential);
  const keys = new Map(initial.map((item) => [item.profileId, item]));
  let automaticProfileId = typeof automatic === "string" ? automatic : automatic ? initial[0]?.profileId : undefined;
  let pending: PendingOperation[] = [];
  const selections = new Map(initial.map((item) => [item.profileId, "session"]));
  const storage: MobileStorage = {
    loadConnectionIndex: vi.fn(async () => ({ profiles: [...profiles], ...(automaticProfileId ? { automaticProfileId } : {}) })),
    loadCredential: vi.fn(async (profileId) => keys.get(profileId)),
    saveConnection: vi.fn(async (value) => {
      keys.set(value.profileId, value);
      const profile = profileFromCredential(value);
      profiles = [...profiles.filter((item) => item.profileId !== profile.profileId && item.connectionId !== profile.connectionId), profile];
    }),
    deleteCredential: vi.fn(async (profileId) => {
      keys.delete(profileId);
      if (automaticProfileId === profileId) automaticProfileId = undefined;
    }),
    deleteConnection: vi.fn(async (profileId) => {
      keys.delete(profileId);
      profiles = profiles.filter((item) => item.profileId !== profileId);
      if (automaticProfileId === profileId) automaticProfileId = undefined;
    }),
    saveAutomaticProfile: vi.fn(async (profileId) => { automaticProfileId = profileId; }),
    loadPending: vi.fn(async () => pending), savePending: vi.fn(async (items) => { pending = [...items]; }),
    loadSelection: vi.fn(async (profileId) => selections.get(profileId)),
    saveSelection: vi.fn(async (profileId, id) => {
      if (id === undefined) selections.delete(profileId); else selections.set(profileId, id);
    })
  };
  return {
    storage,
    key: (profileId = credential.profileId) => keys.get(profileId),
    automatic: () => automaticProfileId !== undefined,
    automaticProfile: () => automaticProfileId,
    profiles: () => profiles,
    pending: () => pending
  };
}

function memoryOfflineCache(now: () => number = () => 1_500) {
  const values = new Map<string, string>();
  const driver: MobileOfflineCacheStorage = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); },
    async getAllKeys() { return [...values.keys()]; },
    async multiRemove(keys) { for (const key of keys) values.delete(key); }
  };
  let sequence = 0;
  return {
    cache: new MobileOfflineCache(driver, now, () => `cache-${++sequence}`),
    values
  };
}

function fakeNetwork(): MobileNetwork {
  return {
    inspect: vi.fn(async () => node),
    discover: vi.fn(async () => []),
    requestPairing: vi.fn(async () => ({ challengeId: "challenge", identity: node })),
    completePairing: vi.fn(async () => ({ credential, identity: node })),
    readOwner: vi.fn(async () => ({ connection, device, snapshot })),
    readSession: vi.fn(async () => snapshot),
    readNativeSessionTree: vi.fn(async () => create(NativeSessionTreeSchema, {
      sessionId: "session",
      activeEntryId: "native-current",
      revision: create(RevisionSchema, { value: 9n, etag: "session-r9" }),
      ...nativeSessionTreeWireFields([{
        ...create(NativeSessionTreeNodeSchema, {
          entryId: "native-current",
          kind: NativeEntryKind.USER_MESSAGE,
          summary: "Current prompt",
          active: true,
          createdAt: { seconds: 1n }
        }),
        children: []
      }])
    })),
    readHistory: vi.fn(async () => ({ events: [], before: undefined })),
    readAround: vi.fn(async () => []),
    searchSessionMessages: vi.fn(async () => []),
    streamOwner: vi.fn(async function* (_credential, _after, signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
    listWorkspaceDirectory: vi.fn(async () => ({ entries: [], revision: "directory-1" })),
    listWorkspaceFileIndex: vi.fn(async () => ({ paths: [], revision: "index-1", truncated: false })),
    searchWorkspace: vi.fn(async () => ({ matches: [], revision: "search-1", truncated: false, totalFiles: 0 })),
    watchWorkspace: vi.fn(async function* (_credential, _workspaceId, signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }),
    readWorkspaceFile: vi.fn(async () => { throw new Error("No Workspace file fixture was configured."); }),
    materializeWorkspaceFileBlob: vi.fn(async () => { throw new Error("No Workspace Blob fixture was configured."); }),
    listSessionArtifacts: vi.fn(async () => ({ artifacts: [], revision: "artifacts-1" })),
    listRuntimeCommands: vi.fn(async () => []),
    listSessionResources: vi.fn(async () => []),
    listArtifactReferenceCatalog: vi.fn(async () => ({ artifacts: [], revision: "artifact-references-1" })),
    listSchedules: vi.fn(async () => []),
    readSchedule: vi.fn(async () => { throw new Error("No Automation Schedule fixture was configured."); }),
    listScheduleHistory: vi.fn(async () => ({ history: [], nextPageToken: "", totalSize: 0 })),
    readSchedulerRuntime: vi.fn(async () => { throw new Error("No Scheduler runtime fixture was configured."); }),
    probeTargetWorktree: vi.fn(async (_credential, targetId) => ({
      targetId, eligibility: "eligible" as const, canRefreshRemote: true
    })),
    listTargetWorktreeSources: vi.fn(async () => []),
    downloadBlob: vi.fn(async () => { throw new Error("No Blob fixture was configured."); }),
    authorizeBlobDownload: vi.fn(async () => { throw new Error("No Blob authorization fixture was configured."); }),
    uploadBlob: vi.fn(async () => { throw new Error("No Blob upload fixture was configured."); }),
    getVoiceInputCapabilities: vi.fn(async () => { throw new Error("No Voice capability fixture was configured."); }),
    startVoiceInput: vi.fn(async () => { throw new Error("No Voice session fixture was configured."); }),
    appendVoiceAudio: vi.fn(async () => { throw new Error("No Voice session fixture was configured."); }),
    stopVoiceInput: vi.fn(async () => { throw new Error("No Voice session fixture was configured."); }),
    cancelVoiceInput: vi.fn(async () => { throw new Error("No Voice session fixture was configured."); }),
    getVoiceInputSession: vi.fn(async () => { throw new Error("No Voice session fixture was configured."); }),
    prepareTarget: vi.fn(async () => undefined),
    submit: vi.fn(async (_credential, operationId, mutation) => {
      toBinary(OperationMutationSchema, mutation);
      return create(OperationSchema, {
      operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED
      });
    }),
    waitOperation: vi.fn(async (_credential, operationId) => create(OperationSchema, {
      operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED
    })),
    getOperation: vi.fn(async () => undefined)
  };
}

function projectedNetwork(projected: Snapshot): MobileNetwork {
  const network = fakeNetwork();
  network.readOwner = vi.fn(async () => ({ connection, device, snapshot: projected }));
  network.readSession = vi.fn(async () => projected);
  return network;
}

function automationNetwork(): MobileNetwork {
  const network = fakeNetwork();
  network.readOwner = vi.fn(async () => ({ connection, device, snapshot: automationOwnerSnapshot }));
  network.readSession = vi.fn(async () => automationOwnerSnapshot);
  network.listSchedules = vi.fn(async () => [automationSchedule]);
  network.readSchedule = vi.fn(async () => automationSchedule);
  network.listScheduleHistory = vi.fn(async (_credential, _scheduleId, pageToken = "") => pageToken === ""
    ? { history: [automationInterruptedRun], nextPageToken: "history-2", totalSize: 2 }
    : { history: [automationCompletedRun], nextPageToken: "", totalSize: 2 });
  network.readSchedulerRuntime = vi.fn(async () => automationRuntime);
  return network;
}

function authoringAutomationNetwork(initial: readonly Schedule[] = [automationSchedule]): {
  readonly network: MobileNetwork;
  readonly catalog: () => readonly Schedule[];
} {
  const network = fakeNetwork();
  let catalog = [...initial];
  let revision = 20n;
  network.readOwner = vi.fn(async () => ({ connection, device, snapshot: automationAuthoringOwnerSnapshot }));
  network.readSession = vi.fn(async () => automationAuthoringOwnerSnapshot);
  network.listSchedules = vi.fn(async () => [...catalog]);
  network.readSchedule = vi.fn(async (_credential, scheduleId) => {
    const matches = catalog.filter((candidate) => candidate.scheduleId === scheduleId);
    if (matches.length !== 1) throw new Error("No Automation Schedule fixture was configured.");
    return matches[0]!;
  });
  network.listScheduleHistory = vi.fn(async () => ({ history: [], nextPageToken: "", totalSize: 0 }));
  network.readSchedulerRuntime = vi.fn(async () => catalog.some((schedule) => schedule.scheduleId === automationSchedule.scheduleId)
    ? automationRuntime
    : create(SchedulerRuntimeSnapshotSchema, {
      schedulerInstanceId: "scheduler-one", maxConcurrentRuns: 4
    }));
  network.probeTargetWorktree = vi.fn(async (_credential, targetId) => ({
    targetId, eligibility: "eligible" as const, canRefreshRemote: true
  }));
  network.listTargetWorktreeSources = vi.fn(async () => [{
    ref: "refs/heads/main", commit: "abc123", displayName: "main", remote: false, current: true
  }]);
  network.submit = vi.fn(async (_credential, operationId, mutation) => {
    toBinary(OperationMutationSchema, mutation);
    const payload = mutation.payload;
    if (payload.case === "createSchedule") {
      const input = payload.value.schedule!;
      const created = scheduleFromAuthoringInput("schedule-created", input, ScheduleSource.USER, ++revision);
      catalog = [...catalog, created];
      return successfulOperation(operationId, { case: "schedule", value: created });
    }
    if (payload.case === "updateSchedule") {
      const current = catalog.find((candidate) => candidate.scheduleId === payload.value.scheduleId)!;
      const updated = scheduleFromAuthoringInput(
        current.scheduleId,
        payload.value.schedule!,
        current.source,
        ++revision,
        current.source === ScheduleSource.PROJECT
          ? { projectConfigId: current.projectConfigId, projectConfigPath: current.projectConfigPath }
          : undefined
      );
      catalog = catalog.map((candidate) => candidate.scheduleId === current.scheduleId ? updated : candidate);
      return successfulOperation(operationId, { case: "schedule", value: updated });
    }
    if (payload.case === "deleteSchedule") {
      catalog = catalog.filter((candidate) => candidate.scheduleId !== payload.value.scheduleId);
      return successfulOperation(operationId, { case: "scheduleDeletion", value: create(ScheduleDeletionResultSchema, {
        scheduleId: payload.value.scheduleId,
        generatedSessionDisposition: payload.value.generatedSessionDisposition,
        generatedSessionIds: [automationGeneratedSession.sessionId],
        completedSessionIds: [automationGeneratedSession.sessionId],
        failures: [],
        inflightCount: 1
      }) });
    }
    if (payload.case === "promoteScheduleToProject") {
      const current = catalog.find((candidate) => candidate.scheduleId === payload.value.scheduleId)!;
      const promoted = create(ScheduleSchema, {
        ...current,
        scheduleId: "schedule-project",
        source: ScheduleSource.PROJECT,
        projectConfigId: "project-config",
        projectConfigPath: ".joko/automations/project-config.json",
        version: create(EntityVersionSchema, {
          revision: create(RevisionSchema, { value: ++revision, etag: `schedule-r${revision}` }), generation: 2n
        })
      });
      catalog = [...catalog.filter((candidate) => candidate.scheduleId !== current.scheduleId), promoted];
      return successfulOperation(operationId, { case: "schedule", value: promoted });
    }
    if (payload.case === "cloneProjectScheduleToUser") {
      const current = catalog.find((candidate) => candidate.scheduleId === payload.value.scheduleId)!;
      const clone = create(ScheduleSchema, {
        ...current,
        scheduleId: "schedule-clone",
        displayName: payload.value.displayName,
        source: ScheduleSource.USER,
        projectConfigId: "",
        projectConfigPath: "",
        version: create(EntityVersionSchema, {
          revision: create(RevisionSchema, { value: ++revision, etag: `schedule-r${revision}` }), generation: 2n
        })
      });
      catalog = [...catalog, clone];
      return successfulOperation(operationId, { case: "schedule", value: clone });
    }
    if (payload.case === "removeProjectSchedule") {
      const current = catalog.find((candidate) => candidate.scheduleId === payload.value.scheduleId)!;
      catalog = catalog.filter((candidate) => candidate.scheduleId !== current.scheduleId);
      if (!payload.value.keepPersonalCopy) {
        return successfulOperation(operationId, {
          case: "acknowledgement", value: create(AcknowledgementSchema, { accepted: true })
        });
      }
      const copy = create(ScheduleSchema, {
        ...current,
        scheduleId: "schedule-personal-copy",
        source: ScheduleSource.USER,
        projectConfigId: "",
        projectConfigPath: "",
        version: create(EntityVersionSchema, {
          revision: create(RevisionSchema, { value: ++revision, etag: `schedule-r${revision}` }), generation: 2n
        })
      });
      catalog = [...catalog, copy];
      return successfulOperation(operationId, { case: "schedule", value: copy });
    }
    if (payload.case === "reconcileProjectAutomations") {
      return successfulOperation(operationId, {
        case: "acknowledgement", value: create(AcknowledgementSchema, { accepted: true })
      });
    }
    return successfulOperation(operationId, {
      case: "acknowledgement", value: create(AcknowledgementSchema, { accepted: true })
    });
  });
  return { network, catalog: () => catalog };
}

function scheduleFromAuthoringInput(
  scheduleId: string,
  input: ScheduleInput,
  source: ScheduleSource,
  revision: bigint,
  project?: { readonly projectConfigId: string; readonly projectConfigPath: string }
): Schedule {
  return create(ScheduleSchema, {
    scheduleId,
    displayName: input.displayName,
    state: input.enabled ? ScheduleState.ENABLED : ScheduleState.DISABLED,
    backendId: input.backendId,
    targetId: input.targetId,
    sessionId: input.sessionId,
    sessionMode: input.sessionMode,
    recurrence: input.recurrence,
    timeZone: input.timeZone,
    input: input.input,
    execution: input.execution,
    overlapPolicy: input.overlapPolicy,
    misfirePolicy: input.misfirePolicy,
    source,
    ...(project === undefined ? {} : project),
    version: create(EntityVersionSchema, {
      revision: create(RevisionSchema, { value: revision, etag: `schedule-r${revision}` }), generation: 2n
    })
  });
}

function successfulOperation(
  operationId: string,
  payload: NonNullable<Operation["result"]>["payload"]
): Operation {
  return create(OperationSchema, {
    operationId,
    connectionId: credential.connectionId,
    state: OperationState.SUCCEEDED,
    result: { payload }
  });
}

function event(id: string, sequence: bigint, sessionId = "session"): Event {
  return create(EventSchema, { eventId: id, identity: { sessionId },
    cursor: { opaqueToken: `cursor-${sequence}`, sequence, generation: 1n },
    payload: { kind: { case: "statusStream", value: { label: id } } } });
}

function eventFeed(network: MobileNetwork) {
  const queued: Event[] = [];
  let wake: (() => void) | undefined;
  network.streamOwner = vi.fn(async function* (_credential, _after, signal) {
    while (!signal.aborted) {
      if (!queued.length) await new Promise<void>((resolve) => {
        wake = resolve;
        signal.addEventListener("abort", resolve, { once: true });
      });
      if (signal.aborted) return;
      const next = queued.shift();
      if (next) yield next;
    }
  });
  return (item: Event) => { queued.push(item); wake?.(); wake = undefined; };
}

function memoryDraftStores() {
  const values = new Map<string, string>();
  const driver: MobilePlainStorageDriver = {
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { values.set(key, value); },
    async removeItem(key) { values.delete(key); }
  };
  return {
    values,
    newTask: new MobileNewTaskDraftStore(driver),
    composer: new MobileComposerDraftStore(driver)
  };
}

function localAttachmentDraft(text = ""): MobileComposerDraft {
  return {
    ...plainTextMobileComposerDraft(text),
    attachments: [
      {
        state: "local",
        attachmentId: "image-one",
        kind: "image",
        fileName: "pixel.png",
        mediaType: "image/png",
        byteSize: 4,
        sha256Hex: "a".repeat(64),
        capturedAtUnixMs: 100
      },
      {
        state: "local",
        attachmentId: "file-one",
        kind: "file",
        fileName: "proof.pdf",
        mediaType: "application/pdf",
        byteSize: 7,
        sha256Hex: "b".repeat(64),
        capturedAtUnixMs: 101
      }
    ]
  };
}

function annotatedLocalImageDraft(text = ""): MobileComposerDraft {
  const image = localAttachmentDraft(text).attachments[0]!;
  return {
    ...plainTextMobileComposerDraft(text),
    attachments: [{
      ...image,
      annotation: {
        source: {
          storageId: "image-source",
          fileName: "pixel.png",
          mediaType: "image/png",
          byteSize: 4,
          sha256Hex: "a".repeat(64),
          capturedAtUnixMs: 90
        },
        strokes: [{ points: [{ x: 0.25, y: 0.5 }] }]
      }
    }]
  };
}

function attachmentFileFixture(onRemove?: (attachmentId: string) => void) {
  const removed: string[] = [];
  const bytes = new Map<string, Uint8Array>([
    ["image-one", new Uint8Array([1, 1, 1, 1])],
    ["file-one", new Uint8Array([2, 2, 2, 2, 2, 2, 2])]
  ]);
  const driver: MobileAttachmentFileDriver = {
    pick: vi.fn(async () => ({ canceled: true, files: [] })),
    stage: vi.fn(async () => { throw new Error("not used"); }),
    stageBytes: vi.fn(async (profileId, attachmentId, value) => {
      const stored = Uint8Array.from(value);
      bytes.set(attachmentId, stored);
      return {
        uri: `file:///durable/${profileId}/${attachmentId}`,
        byteSize: stored.byteLength,
        bytes: Uint8Array.from(stored)
      };
    }),
    read: vi.fn(async (profileId, attachmentId) => {
      const value = bytes.get(attachmentId);
      if (!value) throw new Error("staged bytes missing");
      return {
        uri: `file:///durable/${profileId}/${attachmentId}`,
        byteSize: value.byteLength,
        bytes: Uint8Array.from(value)
      };
    }),
    remove: vi.fn(async (_profileId, attachmentId) => {
      removed.push(attachmentId);
      bytes.delete(attachmentId);
      onRemove?.(attachmentId);
    }),
    clearProfile: vi.fn(async () => { bytes.clear(); })
  };
  return {
    files: new MobileAttachmentFiles(
      driver,
      async (value) => value[0] === 1 ? "a".repeat(64) : "b".repeat(64)
    ),
    driver,
    removed,
    bytes
  };
}

function mediaPreviewFixture(
  sha256Hex = "c".repeat(64),
  write?: (fileName: string, bytes: Uint8Array) => Promise<MobileMediaPreviewFileSnapshot>
) {
  const stored = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const driver: MobileMediaPreviewFileDriver = {
    prepare: vi.fn(async () => { stored.clear(); }),
    write: vi.fn(async (fileName, bytes) => {
      if (write) return write(fileName, bytes);
      const exact = Uint8Array.from(bytes);
      stored.set(fileName, exact);
      return { uri: `file:///media/${fileName}`, fileName, byteSize: exact.byteLength, bytes: exact };
    }),
    remove: vi.fn(async (snapshot) => {
      removed.push(snapshot.fileName);
      stored.delete(snapshot.fileName);
    })
  };
  return {
    files: new MobileMediaPreviewFiles(driver, async () => sha256Hex),
    driver,
    removed,
    stored
  };
}

function pdfPreviewFixture(
  sha256Hex = "f".repeat(64),
  write?: (fileName: string, bytes: Uint8Array) => Promise<MobilePdfPreviewFileSnapshot>
) {
  const stored = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const driver: MobilePdfPreviewFileDriver = {
    prepare: vi.fn(async () => { stored.clear(); }),
    write: vi.fn(async (fileName, bytes) => {
      if (write) return write(fileName, bytes);
      const exact = Uint8Array.from(bytes);
      stored.set(fileName, exact);
      return { uri: `file:///pdf/${fileName}`, fileName, byteSize: exact.byteLength, bytes: exact };
    }),
    remove: vi.fn(async (snapshot) => {
      removed.push(snapshot.fileName);
      stored.delete(snapshot.fileName);
    })
  };
  return {
    files: new MobilePdfPreviewFiles(driver, async () => sha256Hex),
    driver,
    removed,
    stored
  };
}

function modelPreviewFixture(
  write?: (fileName: string, bytes: Uint8Array) => Promise<MobileModelPreviewFileSnapshot>
) {
  const stored = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const driver: MobileModelPreviewFileDriver = {
    prepare: vi.fn(async () => { stored.clear(); }),
    write: vi.fn(async (fileName, bytes) => {
      if (write) return write(fileName, bytes);
      const exact = Uint8Array.from(bytes);
      stored.set(fileName, exact);
      return { uri: `file:///model/${fileName}`, fileName, byteSize: exact.byteLength, bytes: exact };
    }),
    remove: vi.fn(async (snapshot) => {
      removed.push(snapshot.fileName);
      stored.delete(snapshot.fileName);
    })
  };
  return {
    files: new MobileModelPreviewFiles(driver, async (bytes) => sha256Hex(bytes)),
    driver,
    removed,
    stored
  };
}

function fixedIds(...values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `fallback-${index}`;
}

const renderedPngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function previewMp4Bytes(handler: "soun" | "vide" = "vide"): Uint8Array {
  const bytes = new Uint8Array(48);
  bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
  bytes.set([0x69, 0x73, 0x6f, 0x6d], 16);
  bytes.set([0, 0, 0, 24, 0x68, 0x64, 0x6c, 0x72], 24);
  bytes.set([...handler].map((value) => value.charCodeAt(0)), 40);
  return bytes;
}

const previewWavBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45
]);

function previewPdfBytes(): Uint8Array {
  const body = "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count 0 /Kids [] >>\nendobj\n";
  const xref = new TextEncoder().encode(body).byteLength;
  return new TextEncoder().encode(`${body}xref\n0 3\n0000000000 65535 f \n0000000009 00000 n \n0000000060 00000 n \ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

function previewGltfBytes(input: {
  readonly bufferUri?: string;
  readonly imageUri?: string;
} = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    asset: { version: "2.0" },
    ...(input.bufferUri ? { buffers: [{ uri: input.bufferUri, byteLength: 4 }] } : {}),
    ...(input.imageUri ? { images: [{ uri: input.imageUri }] } : {})
  }));
}

function workspaceModelEntry(
  relativePath: string,
  mediaType: string,
  bytes: Uint8Array,
  opaqueRevision: string
): WorkspaceEntry {
  return create(WorkspaceEntrySchema, {
    workspaceId: "workspace",
    relativePath,
    displayName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    kind: FileKind.REGULAR,
    mediaType,
    revision: create(FileRevisionSchema, {
      opaqueRevision,
      sha256Hex: sha256Hex(bytes),
      byteSize: BigInt(bytes.byteLength)
    })
  });
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function galleryPngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13, 73, 72, 68, 82], 8);
  bytes[16] = width >>> 24 & 0xff;
  bytes[17] = width >>> 16 & 0xff;
  bytes[18] = width >>> 8 & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = height >>> 24 & 0xff;
  bytes[21] = height >>> 16 & 0xff;
  bytes[22] = height >>> 8 & 0xff;
  bytes[23] = height & 0xff;
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0, 0, 0, 0, 73, 69, 78, 68], 33);
  return bytes;
}

function timelineGalleryEvent(bytes: Uint8Array): Event {
  const first = create(BlobRefSchema, {
    blobId: "timeline-image-one", fileName: "first.png", mediaType: "image/png",
    byteSize: BigInt(bytes.byteLength), sha256Hex: "b".repeat(64), disposition: BlobDisposition.INLINE
  });
  const second = create(BlobRefSchema, {
    blobId: "timeline-image-two", fileName: "second.png", mediaType: "image/png",
    byteSize: BigInt(bytes.byteLength), sha256Hex: "b".repeat(64), disposition: BlobDisposition.INLINE
  });
  return create(EventSchema, {
    eventId: "timeline-gallery-event",
    identity: { sessionId: "session" },
    cursor: { opaqueToken: "timeline-gallery-cursor", sequence: 11n, generation: 1n },
    payload: { kind: { case: "messageCompleted", value: {
      messageId: "timeline-gallery-message",
      role: MessageRole.ASSISTANT,
      blocks: [
        { content: { case: "text", value: "Two durable images" } },
        { content: { case: "image", value: create(ImageRefSchema, {
          blob: first, widthPixels: 5, heightPixels: 4, altText: "First image"
        }) } },
        { content: { case: "image", value: create(ImageRefSchema, {
          blob: second, widthPixels: 5, heightPixels: 4, altText: "Second image"
        }) } }
      ]
    } } }
  });
}

function timelinePreviewEvent(
  fileName: string,
  mediaType: string,
  bytes: Uint8Array,
  sha256Hex: string,
  label = "Timeline file"
): Event {
  return create(EventSchema, {
    eventId: "timeline-preview-event",
    identity: { sessionId: "session" },
    cursor: { opaqueToken: `timeline-preview-${fileName}`, sequence: 12n, generation: 1n },
    payload: { kind: { case: "messageCompleted", value: {
      messageId: "timeline-preview-message",
      role: MessageRole.ASSISTANT,
      blocks: [{ content: { case: "artifact", value: {
        label,
        blob: create(BlobRefSchema, {
          blobId: `timeline-${fileName}`,
          fileName,
          mediaType,
          byteSize: BigInt(bytes.byteLength),
          sha256Hex,
          disposition: BlobDisposition.INLINE
        })
      } } }]
    } } }
  });
}

function acceptedTimelineGalleryEvent(bytes: Uint8Array): Event {
  const image = (blobId: string, fileName: string) => create(ImageRefSchema, {
    blob: create(BlobRefSchema, {
      blobId, fileName, mediaType: "image/png", byteSize: BigInt(bytes.byteLength),
      sha256Hex: "b".repeat(64), disposition: BlobDisposition.INLINE
    }),
    widthPixels: 0,
    heightPixels: 0,
    altText: fileName === "first.png" ? "First image" : "Second image"
  });
  return create(EventSchema, {
    eventId: "accepted-timeline-gallery-event",
    identity: { sessionId: "session" },
    cursor: { opaqueToken: "accepted-timeline-gallery-cursor", sequence: 11n, generation: 1n },
    payload: { kind: { case: "messageStarted", value: {
      messageId: "accepted-timeline-gallery-message",
      role: MessageRole.USER,
      userInputAccepted: true,
      userInput: { parts: [
        { content: { case: "image", value: image("timeline-image-one", "first.png") } },
        { content: { case: "image", value: image("timeline-image-two", "second.png") } }
      ] }
    } } }
  });
}

function timelineGallerySnapshot(event: Event): Snapshot {
  return create(SnapshotSchema, {
    ...attachmentSnapshot,
    snapshotId: "timeline-gallery-snapshot",
    resumeCursor: event.cursor,
    timeline: [event]
  });
}

function committedAttachment(attachment: MobileLocalComposerAttachment) {
  return create(BlobRefSchema, {
    blobId: `blob-${attachment.attachmentId}`,
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    byteSize: BigInt(attachment.byteSize),
    sha256Hex: attachment.sha256Hex,
    disposition: BlobDisposition.ATTACHMENT
  });
}

const clients: MobileClient[] = [];
function client(
  network: MobileNetwork,
  storage: MobileStorage,
  discovery?: MobileDiscovery,
  now: () => number = () => 2_000,
  newId: () => string = () => "operation-1",
  clearInteractionDraft?: (identity: MobileInteractionDraftIdentity) => Promise<void>,
  drafts = memoryDraftStores(),
  attachmentFiles?: MobileAttachmentFiles,
  mediaPreviewFiles?: MobileMediaPreviewFiles,
  pdfPreviewFiles?: MobilePdfPreviewFiles,
  modelPreviewFiles?: MobileModelPreviewFiles,
  fileShare?: Pick<MobileFileShare, "perform">,
  offlineCache?: Pick<MobileOfflineCache, "load" | "save" | "clear">
) {
  const instance = new MobileClient(network, storage, discovery ?? { scan: vi.fn(async () => []) }, newId, "android", now,
    clearInteractionDraft, drafts.newTask, drafts.composer, attachmentFiles, mediaPreviewFiles, pdfPreviewFiles,
    modelPreviewFiles, fileShare, offlineCache);
  clients.push(instance);
  return instance;
}

function clientWithOfflineCache(
  network: MobileNetwork,
  storage: MobileStorage,
  offlineCache: Pick<MobileOfflineCache, "load" | "save" | "clear">,
  now: () => number = () => 2_000
) {
  return client(network, storage, undefined, now, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, offlineCache);
}
afterEach(() => { for (const item of clients.splice(0)) item.dispose(); });

describe("native mobile Automation ownership and recovery", () => {
  it("loads exact catalog/detail/history pages and persists Schedule+trigger receipt before dispatch", async () => {
    const network = automationNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();

    await app.openAutomations();
    expect(app.state.automations).toMatchObject({
      open: true,
      status: "ready",
      selectedScheduleId: automationSchedule.scheduleId,
      historyTotalSize: 2,
      historyNextPageToken: "history-2",
      runtime: { inFlightBySchedule: { [automationSchedule.scheduleId]: 1 } }
    });
    expect(app.state.automations.detail?.displayName).toBe("Morning check");
    expect(app.state.automations.history.map((run) => run.triggerId)).toEqual(["trigger-interrupted"]);

    await app.loadMoreAutomationHistory();
    expect(app.state.automations.history.map((run) => run.triggerId)).toEqual([
      "trigger-interrupted", "trigger-completed"
    ]);
    expect(app.state.automations.historyNextPageToken).toBeUndefined();

    let receiptAtDispatch: PendingOperation | undefined;
    vi.mocked(network.submit).mockImplementationOnce(async (_credential, operationId, mutation) => {
      toBinary(OperationMutationSchema, mutation);
      receiptAtDispatch = saved.pending()[0];
      return create(OperationSchema, {
        operationId,
        connectionId: credential.connectionId,
        state: OperationState.SUCCEEDED
      });
    });
    await expect(app.restartAutomationRun(automationSchedule.scheduleId, "trigger-interrupted")).resolves.toBe(true);

    expect(receiptAtDispatch).toMatchObject({
      kind: "schedule-run-restart",
      connectionId: credential.connectionId,
      scheduleId: automationSchedule.scheduleId,
      triggerId: "trigger-interrupted",
      state: "unknown"
    });
    const submitted = vi.mocked(network.submit).mock.calls.at(-1)?.[2];
    expect(submitted?.preconditions[0]).toMatchObject({
      entity: { kind: EntityKind.SCHEDULE, id: automationSchedule.scheduleId },
      expectedRevision: { value: 7n, etag: "schedule-r7" }
    });
    expect(submitted?.payload).toMatchObject({
      case: "restartScheduleRun",
      value: { scheduleId: automationSchedule.scheduleId, triggerId: "trigger-interrupted" }
    });
    expect(saved.pending()).toEqual([]);
    expect(network.listSchedules).toHaveBeenCalledTimes(2);
  });

  it("fails closed when later Automation history cursors cycle", async () => {
    const network = automationNetwork();
    const third = create(ScheduleRunHistorySchema, {
      ...automationCompletedRun,
      triggerId: "trigger-third",
      runId: "run-third"
    });
    network.listScheduleHistory = vi.fn(async (_credential, _scheduleId, pageToken = "") => {
      if (pageToken === "") {
        return { history: [automationInterruptedRun], nextPageToken: "history-2", totalSize: 3 };
      }
      if (pageToken === "history-2") {
        return { history: [automationCompletedRun], nextPageToken: "history-3", totalSize: 3 };
      }
      return { history: [third], nextPageToken: "history-2", totalSize: 3 };
    });
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await app.openAutomations();
    await app.loadMoreAutomationHistory();

    await app.loadMoreAutomationHistory();

    expect(app.state.automations.historyStatus).toBe("error");
    expect(app.state.automations.history.map((run) => run.triggerId)).toEqual([
      "trigger-interrupted", "trigger-completed"
    ]);
    expect(app.state.automations.error).toMatch(/changed while paging/);
  });

  it("retains an unknown receipt, does not optimistically change authority and blocks exact replay", async () => {
    const network = automationNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    await app.openAutomations();
    const before = app.state.automations.schedules;
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("transport closed"));

    await expect(app.runAutomation(automationSchedule.scheduleId)).resolves.toBe(false);

    expect(app.state.automations.schedules).toBe(before);
    expect(saved.pending()).toEqual([expect.objectContaining({
      kind: "schedule-run",
      scheduleId: automationSchedule.scheduleId,
      state: "unknown"
    })]);
    await expect(app.runAutomation(automationSchedule.scheduleId)).rejects.toThrow(/unknown durable result/);
    expect(network.submit).toHaveBeenCalledTimes(1);
  });

  it("rereads Automation authority after a recovered terminal rejection", async () => {
    const network = automationNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    await app.openAutomations();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("transport closed"));
    await app.runAutomation(automationSchedule.scheduleId);
    const readsBeforeRecovery = vi.mocked(network.listSchedules).mock.calls.length;
    vi.mocked(network.getOperation).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "operation-1",
      connectionId: credential.connectionId,
      state: OperationState.FAILED,
      error: { message: "Run was rejected" }
    }));

    await app.reconcile();

    expect(saved.pending()).toEqual([]);
    expect(network.listSchedules).toHaveBeenCalledTimes(readsBeforeRecovery + 1);
    expect(app.state.automations.status).toBe("ready");
    expect(app.state.error).toBe("Run was rejected");
  });

  it("retires late catalog reads and exposes only cached Schedule summaries while inactive", async () => {
    const network = automationNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    let resolveCatalog!: (value: readonly typeof automationSchedule[]) => void;
    vi.mocked(network.listSchedules).mockImplementationOnce(() => new Promise((resolve) => { resolveCatalog = resolve; }));

    const opening = app.openAutomations();
    app.setForeground(false);
    resolveCatalog([create(ScheduleSchema, { ...automationSchedule, displayName: "Late authority" })]);
    await opening;

    expect(app.state.automations.status).toBe("offline");
    expect(app.state.automations.schedules.map((schedule) => schedule.displayName)).toEqual(["Morning check"]);
    expect(app.state.automations.detail).toBeUndefined();
    expect(app.state.automations.history).toEqual([]);
    await expect(app.runAutomation(automationSchedule.scheduleId)).rejects.toThrow(/Reconnect/);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("opens only the run's actual available task and never the Schedule binding", async () => {
    const network = automationNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    await app.openAutomations();
    await app.loadMoreAutomationHistory();

    await app.openAutomationRunTask(automationSchedule.scheduleId, "trigger-completed");

    expect(app.state.automations.open).toBe(false);
    expect(app.state.selectedId).toBe("session");
    await expect(app.openAutomationRunTask(automationSchedule.scheduleId, "trigger-interrupted"))
      .rejects.toThrow(/no task/);
  });

  it("creates and updates a complete Automation behind Target and Schedule revision fences", async () => {
    const fixture = authoringAutomationNetwork();
    const saved = memoryStorage(credential);
    const app = client(fixture.network, saved.storage);
    await app.start();
    await app.openAutomations();
    const submit = vi.mocked(fixture.network.submit).getMockImplementation()!;
    const receipts: PendingOperation[] = [];
    vi.mocked(fixture.network.submit).mockImplementation(async (...args) => {
      receipts.push(saved.pending()[0]!);
      return submit(...args);
    });
    const draft = {
      ...createMobileAutomationDraft(app.state.owner),
      name: "Created on mobile",
      inputText: "Check the release",
      notifyDesktop: false
    };

    const created = await app.saveAutomation(draft);

    expect(created).toMatchObject({
      scheduleId: "schedule-created",
      displayName: "Created on mobile",
      inputText: "Check the release",
      notifyDesktop: false
    });
    expect(receipts[0]).toEqual(expect.objectContaining({
      kind: "schedule-create", targetId: "target", state: "unknown"
    }));
    expect(JSON.stringify(receipts[0])).not.toContain("Check the release");
    const createMutation = vi.mocked(fixture.network.submit).mock.calls[0]?.[2];
    expect(createMutation?.preconditions).toMatchObject([
      { entity: { kind: EntityKind.TARGET, id: "target" }, expectedRevision: { value: 3n } }
    ]);
    expect(createMutation?.payload).toMatchObject({ case: "createSchedule", value: {
      schedule: { displayName: "Created on mobile", targetId: "target" }
    } });

    const editedDraft = {
      ...createMobileAutomationDraft(app.state.owner, created),
      name: "Edited on mobile",
      inputText: "Check the release and notes"
    };
    const updated = await app.saveAutomation(editedDraft, created!.scheduleId);

    expect(updated).toMatchObject({ scheduleId: "schedule-created", displayName: "Edited on mobile" });
    expect(receipts[1]).toEqual(expect.objectContaining({
      kind: "schedule-update", scheduleId: "schedule-created", targetId: "target"
    }));
    const updateMutation = vi.mocked(fixture.network.submit).mock.calls[1]?.[2];
    expect(updateMutation?.preconditions.map((value) => value.entity?.kind)).toEqual([
      EntityKind.TARGET, EntityKind.SCHEDULE
    ]);
  });

  it("keeps an ineligible Worktree probe authoritative without requesting an invalid source catalog", async () => {
    const fixture = authoringAutomationNetwork();
    const app = client(fixture.network, memoryStorage(credential).storage);
    vi.mocked(fixture.network.probeTargetWorktree).mockResolvedValueOnce({
      targetId: "target", eligibility: "notGitRepository", canRefreshRemote: false
    });
    await app.start();
    await app.openAutomations();

    await expect(app.loadAutomationWorktree("target")).resolves.toEqual({
      targetId: "target", eligibility: "notGitRepository", canRefreshRemote: false, sources: []
    });
    expect(fixture.network.listTargetWorktreeSources).not.toHaveBeenCalled();
  });

  it("projects unavailable Worktree service authority so disabled schedules can be retained safely", async () => {
    const fixture = authoringAutomationNetwork();
    const app = client(fixture.network, memoryStorage(credential).storage);
    vi.mocked(fixture.network.probeTargetWorktree).mockRejectedValueOnce(Object.assign(
      new Error("Worktree support is unavailable."),
      { code: Code.Unimplemented }
    ));
    await app.start();
    await app.openAutomations();

    await expect(app.loadAutomationWorktree("target")).resolves.toEqual({
      targetId: "target", eligibility: "unavailable", canRefreshRemote: false, sources: []
    });
    expect(fixture.network.listTargetWorktreeSources).not.toHaveBeenCalled();
  });

  it("surfaces a definitive Automation authoring rejection instead of reporting an unknown result", async () => {
    const fixture = authoringAutomationNetwork();
    const saved = memoryStorage(credential);
    const app = client(fixture.network, saved.storage);
    await app.start();
    await app.openAutomations();
    vi.mocked(fixture.network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "operation-1",
      connectionId: credential.connectionId,
      state: OperationState.FAILED,
      error: { message: "Schedule policy rejected the change" }
    }));
    const draft = {
      ...createMobileAutomationDraft(app.state.owner),
      name: "Rejected schedule",
      inputText: "Run"
    };

    await expect(app.saveAutomation(draft)).rejects.toThrow("Schedule policy rejected the change");
    expect(saved.pending()).toEqual([]);
  });

  it("previews authoritative generated tasks and validates the typed deletion result", async () => {
    const fixture = authoringAutomationNetwork();
    const saved = memoryStorage(credential);
    const app = client(fixture.network, saved.storage);
    await app.start();
    await app.openAutomations();

    const preview = await app.prepareAutomationDeletion(automationSchedule.scheduleId);
    expect(preview).toMatchObject({
      scheduleId: automationSchedule.scheduleId,
      generatedSessionIds: [automationGeneratedSession.sessionId],
      inflightCount: 1
    });
    await expect(app.deleteAutomation(automationSchedule.scheduleId, "archive", {
      ...preview, inflightCount: 0
    })).rejects.toThrow(/preview changed/);
    const outcome = await app.deleteAutomation(automationSchedule.scheduleId, "archive", preview);

    expect(outcome).toMatchObject({
      scheduleId: automationSchedule.scheduleId,
      disposition: "archive",
      completedSessionIds: [automationGeneratedSession.sessionId]
    });
    const mutation = vi.mocked(fixture.network.submit).mock.calls.at(-1)?.[2];
    expect(mutation?.payload).toMatchObject({ case: "deleteSchedule", value: {
      scheduleId: automationSchedule.scheduleId,
      generatedSessionDisposition: ScheduleGeneratedSessionDisposition.ARCHIVE
    } });
    expect(fixture.catalog()).toEqual([]);
  });

  it("uses dedicated typed operations for project promotion, clone, removal and reconcile", async () => {
    const fixture = authoringAutomationNetwork();
    const app = client(fixture.network, memoryStorage(credential).storage);
    await app.start();
    await app.openAutomations();

    const promoted = await app.promoteAutomation(automationSchedule.scheduleId);
    expect(promoted).toMatchObject({ scheduleId: "schedule-project", source: "project" });
    const clone = await app.cloneProjectAutomation(promoted!.scheduleId, "Mobile copy");
    expect(clone).toMatchObject({ scheduleId: "schedule-clone", source: "dialogue", displayName: "Mobile copy" });
    await expect(app.removeProjectAutomation(promoted!.scheduleId, false)).resolves.toBe(true);
    await expect(app.reconcileProjectAutomations("target")).resolves.toBe(true);

    expect(vi.mocked(fixture.network.submit).mock.calls.map((call) => call[2].payload.case)).toEqual([
      "promoteScheduleToProject",
      "cloneProjectScheduleToUser",
      "removeProjectSchedule",
      "reconcileProjectAutomations"
    ]);
  });

  it("retains only a body-free create receipt when dispatch is unknown and blocks related replay", async () => {
    const fixture = authoringAutomationNetwork();
    const saved = memoryStorage(credential);
    const app = client(fixture.network, saved.storage);
    await app.start();
    await app.openAutomations();
    vi.mocked(fixture.network.submit).mockRejectedValueOnce(new Error("transport closed"));
    const draft = {
      ...createMobileAutomationDraft(app.state.owner),
      name: "Secret title",
      inputText: "private scheduled body"
    };

    await expect(app.saveAutomation(draft)).resolves.toBeUndefined();

    expect(saved.pending()).toEqual([expect.objectContaining({
      kind: "schedule-create", targetId: "target", state: "unknown"
    })]);
    expect(JSON.stringify(saved.pending())).not.toContain("private scheduled body");
    await expect(app.saveAutomation(draft)).rejects.toThrow(/unknown durable result/);
    expect(fixture.network.submit).toHaveBeenCalledTimes(1);
  });
});

describe("native mobile connection and operation ownership", () => {
  it("binds Voice Input RPCs to the exact live surface and retains only exact-session cleanup after retirement", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    const voiceCapability: MobileVoiceCapability = {
      support: "supported",
      limits: {
        supportedMimeTypes: ["audio/pcm"],
        maximumAudioChunkBytes: 8_192,
        maximumAudioBytes: 1_048_576,
        maximumAudioChunkDurationMs: 500,
        maximumAudioDurationMs: 60_000,
        maximumLocaleCharacters: 35,
        stableWaitMs: 500,
        maximumConcurrentSessions: 1
      },
      supportsLocale: true,
      supportsLiveDrafts: true,
      supportsRefinement: true
    };
    const voiceSession: MobileVoiceSession = {
      id: "voice-one",
      state: "listening",
      nextChunkSequence: 1n,
      acceptedAudioBytes: 0,
      acceptedAudioDurationMs: 0,
      createdAt: 1_000,
      updatedAt: 1_000,
      recoveryAttempts: 0,
      stallWarning: false
    };
    vi.mocked(network.getVoiceInputCapabilities).mockResolvedValue(voiceCapability);
    vi.mocked(network.startVoiceInput).mockResolvedValue(voiceSession);
    vi.mocked(network.cancelVoiceInput).mockResolvedValue({
      ...voiceSession,
      state: "done",
      outcome: "cancelled",
      updatedAt: 1_001
    });
    await app.start();

    const newTaskVoice = app.newTaskVoiceTransport("target");
    expect(newTaskVoice).toBeDefined();
    expect(newTaskVoice?.isCurrent()).toBe(true);
    await expect(newTaskVoice!.getCapabilities()).resolves.toBe(voiceCapability);
    await expect(newTaskVoice!.start("request-one", "audio/pcm", "en-US")).resolves.toBe(voiceSession);
    expect(network.startVoiceInput).toHaveBeenCalledWith(
      credential,
      "request-one",
      "audio/pcm",
      "en-US",
      undefined
    );

    await app.select("session");
    const taskVoice = app.taskVoiceTransport();
    expect(taskVoice).toBeDefined();
    expect(taskVoice?.surfaceOwnerKey).not.toBe(newTaskVoice?.surfaceOwnerKey);
    app.setForeground(false);
    expect(taskVoice?.isCurrent()).toBe(false);
    await expect(taskVoice!.get("voice-one")).rejects.toThrow(/authority changed/i);
    await expect(taskVoice!.cancel("voice-one")).resolves.toMatchObject({ outcome: "cancelled" });
    expect(network.getVoiceInputSession).not.toHaveBeenCalled();
    expect(network.cancelVoiceInput).toHaveBeenCalledWith(credential, "voice-one", undefined);
  });

  it("accepts only the exact current Joko API identity before any authenticated work", () => {
    expect(parseNodeIdentity(node)).toEqual(node);
    expect(() => parseNodeIdentity({ ...node, apiVersion: "joko.v2" })).toThrow(/supports API joko\.v1/);
    expect(() => parseNodeIdentity({ ...node, apiVersion: "" })).toThrow(/valid Joko node identity/);
  });

  it("rejects public cleartext origins and never places credentials in an origin", () => {
    expect(normalizeNodeOrigin("http://192.168.1.20:4318/")).toBe("http://192.168.1.20:4318");
    expect(normalizeNodeOrigin("http://joko-node:4318/")).toBe("http://joko-node:4318");
    expect(normalizeNodeOrigin("http://joko-node.home.arpa:4318/")).toBe("http://joko-node.home.arpa:4318");
    expect(normalizeNodeOrigin("http://[fd12:3456:789a::20]:4318/")).toBe("http://[fd12:3456:789a::20]:4318");
    expect(() => normalizeNodeOrigin("http://example.com")).toThrow(/private-network/);
    expect(() => normalizeNodeOrigin("http://169.254.169.254:4318")).toThrow(/private-network/);
    expect(() => normalizeNodeOrigin("https://user:secret@example.com")).toThrow(/without credentials/);
    expect(() => normalizeNodeOrigin("https://example.com/path")).toThrow(/only the Joko node origin/);
  });

  it("probes identity anonymously before a credentialed read and preserves a drifted saved profile", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    expect(network.inspect).toHaveBeenCalledBefore(saved.storage.loadCredential as ReturnType<typeof vi.fn>);
    expect(network.inspect).toHaveBeenCalledBefore(network.readOwner as ReturnType<typeof vi.fn>);
    expect(app.state.status).toBe("connected");
    vi.mocked(network.inspect).mockResolvedValueOnce({ ...node, serverId: "other-node" });
    await app.refresh();
    expect(app.state.status).toBe("unpaired");
    expect(saved.key()).toEqual(credential);
    expect(saved.automaticProfile()).toBe(credential.profileId);
    expect(app.state.saved[0]).toMatchObject({ profileId: credential.profileId, credentialState: "identity-conflict" });
    expect(app.state.owner).toBeUndefined();
  });

  it("keeps the exact credential when an authenticated projection cannot prove its saved identity", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.readOwner).mockResolvedValueOnce({
      connection: create(ConnectionSchema, { ...connection, connectionProfileId: "different-profile" }),
      device,
      snapshot
    });

    await app.refresh();

    expect(app.state.status).toBe("unpaired");
    expect(app.state.saved[0]).toMatchObject({
      profileId: credential.profileId,
      credentialState: "identity-conflict"
    });
    expect(saved.key()).toEqual(credential);
    expect(saved.automaticProfile()).toBe(credential.profileId);
    expect(saved.storage.deleteCredential).not.toHaveBeenCalled();
  });

  it("suspends a credential when the authenticated snapshot does not prove the inspected current API", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    vi.mocked(network.readOwner).mockResolvedValueOnce({
      connection,
      device,
      snapshot: create(SnapshotSchema, {
        ...snapshot,
        server: { ...snapshot.server!, apiVersion: "joko.v2" }
      })
    });
    const app = client(network, saved.storage);

    await app.start();

    expect(app.state.status).toBe("unpaired");
    expect(app.state.saved[0]).toMatchObject({ credentialState: "identity-conflict" });
    expect(saved.key()).toEqual(credential);
    expect(saved.storage.deleteCredential).not.toHaveBeenCalled();
  });

  it("invalidates only the exact credential and automatic target after authoritative revocation", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage([credential, otherCredential], credential.profileId);
    await saved.storage.savePending([{
      operationId: "unknown-before-revocation",
      connectionId: credential.connectionId,
      kind: "logout",
      targetConnectionId: credential.connectionId,
      state: "unknown"
    }]);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.readOwner).mockResolvedValueOnce({
      connection: create(ConnectionSchema, { ...connection, state: ConnectionState.DISCONNECTED }),
      device,
      snapshot
    });

    await app.refresh();

    expect(app.state.status).toBe("revoked");
    expect(saved.key()).toBeUndefined();
    expect(saved.key(otherCredential.profileId)).toEqual(otherCredential);
    expect(saved.automaticProfile()).toBeUndefined();
    expect(saved.storage.deleteCredential).toHaveBeenCalledWith(credential.profileId);
    expect(app.state.saved.find((profile) => profile.profileId === credential.profileId)?.pendingOperations)
      .toMatchObject([{ operationId: "unknown-before-revocation", state: "unknown" }]);
  });

  it("keeps a saved mobile node on the connection surface until the user opts into this launch", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential, false);
    const app = client(network, saved.storage);
    await app.start();
    expect(app.state.status).toBe("unpaired");
    expect(app.state.saved[0]).toMatchObject({
      connectionId: credential.connectionId,
      origin: credential.origin,
      automatic: false
    });
    expect(network.inspect).not.toHaveBeenCalled();
    expect(network.readOwner).not.toHaveBeenCalled();

    app.setForeground(false);
    app.setForeground(true);
    await Promise.resolve();
    expect(app.state.status).toBe("unpaired");
    expect(network.inspect).not.toHaveBeenCalled();
    expect(network.readOwner).not.toHaveBeenCalled();

    await app.connectSaved(credential.profileId, true);
    expect(app.state.status).toBe("connected");
    expect(app.state.saved[0]?.automatic).toBe(true);
    expect(saved.automatic()).toBe(true);
    expect(network.inspect).toHaveBeenCalledBefore(network.readOwner as ReturnType<typeof vi.fn>);

    await app.disableAutomaticEntry();
    expect(app.state.status).toBe("connected");
    expect(app.state.saved[0]?.automatic).toBe(false);
    expect(saved.automatic()).toBe(false);
  });

  it("restores only the exact automatic profile even when two credentials share an origin and server", async () => {
    const network = fakeNetwork();
    vi.mocked(network.readOwner).mockImplementation(async (value) => value.profileId === otherCredential.profileId
      ? { connection: otherConnection, device: otherDevice, snapshot: extendedSnapshot }
      : { connection, device, snapshot: extendedSnapshot });
    const saved = memoryStorage([credential, otherCredential], otherCredential.profileId);
    const app = client(network, saved.storage);

    await app.start();

    expect(app.state.status).toBe("connected");
    expect(app.state.activeProfileId).toBe(otherCredential.profileId);
    expect(app.state.automaticProfileId).toBe(otherCredential.profileId);
    expect(saved.storage.loadCredential).toHaveBeenCalledWith(otherCredential.profileId);
    expect(saved.storage.loadCredential).not.toHaveBeenCalledWith(credential.profileId);
    expect(network.readOwner).toHaveBeenCalledWith(otherCredential, expect.any(AbortSignal));
  });

  it("restores a current-v1 task copy before anonymous inspection and retries into authoritative online state", async () => {
    const cachedOwner = offlineOwnerProjection();
    const cachedDetail = offlineDetailProjection();
    const offline = memoryOfflineCache();
    await offline.cache.save(profileFromCredential(credential), node, cachedOwner, cachedDetail);
    const network = fakeNetwork();
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: cachedOwner }));
    network.readSession = vi.fn(async () => cachedDetail);
    let rejectInspect!: (error: Error) => void;
    network.inspect = vi.fn(() => new Promise<NodeIdentity>((_resolve, reject) => { rejectInspect = reject; }));
    const saved = memoryStorage(credential);
    const app = clientWithOfflineCache(network, saved.storage, offline.cache);

    const starting = app.start();
    await vi.waitFor(() => expect(network.inspect).toHaveBeenCalledOnce());
    expect(app.state).toMatchObject({
      status: "connecting",
      activeProfileId: credential.profileId,
      selectedId: "session",
      offlineSnapshotAt: 1_500,
      owner: { snapshotId: "runtime-owner" },
      detail: { snapshotId: "runtime-detail" }
    });
    expect(saved.storage.loadCredential).not.toHaveBeenCalled();

    rejectInspect(new Error("Wi-Fi unavailable"));
    await starting;
    expect(app.state).toMatchObject({ status: "offline", offlineSnapshotAt: 1_500 });
    expect(app.state.error).toContain("Wi-Fi unavailable");
    expect(saved.storage.loadCredential).not.toHaveBeenCalled();

    vi.mocked(network.inspect).mockResolvedValueOnce(node);
    await app.refresh();
    expect(network.inspect).toHaveBeenCalledBefore(saved.storage.loadCredential as ReturnType<typeof vi.fn>);
    expect(app.state).toMatchObject({ status: "connected", activeProfileId: credential.profileId });
    expect(app.state.offlineSnapshotAt).toBeUndefined();
    expect(app.state.owner?.snapshotId).toBe("runtime-owner");
    expect(app.state.detail?.snapshotId).toBe("runtime-detail");

    vi.mocked(network.inspect).mockRejectedValueOnce(new Error("radio slept"));
    await app.refresh();
    expect(app.state.status).toBe("offline");
    app.setForeground(false);
    vi.mocked(network.inspect).mockResolvedValueOnce(node);
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.status).toBe("connected"));
  });

  it("switches between previously cached regular tasks while offline without a credentialed read", async () => {
    const ownerProjection = offlineOwnerProjection([runtimeSession, relatedSession]);
    const firstDetail = offlineDetailProjection();
    const relatedDetail = create(SnapshotSchema, {
      ...offlineDetailProjection(relatedSession),
      snapshotId: "related-detail",
    });
    let clock = 1_500;
    const offline = memoryOfflineCache(() => clock);
    await offline.cache.save(profileFromCredential(credential), node, ownerProjection, firstDetail);
    clock += 1;
    await offline.cache.save(profileFromCredential(credential), node, ownerProjection, relatedDetail);
    const network = fakeNetwork();
    network.inspect = vi.fn(async () => { throw new Error("offline"); });
    const saved = memoryStorage(credential);
    const app = clientWithOfflineCache(network, saved.storage, offline.cache);

    await app.start();
    expect(app.state).toMatchObject({ status: "offline", selectedId: "session" });
    expect(app.state.detail?.snapshotId).toBe("runtime-detail");
    await app.select(relatedSession.sessionId);

    expect(app.state).toMatchObject({ status: "offline", selectedId: relatedSession.sessionId });
    expect(app.state.detail?.snapshotId).toBe("related-detail");
    expect(network.readSession).not.toHaveBeenCalled();
    expect(saved.storage.saveSelection).toHaveBeenCalledWith(credential.profileId, relatedSession.sessionId);
  });

  it("uses a valid cached view when protected storage is temporarily unavailable", async () => {
    const cachedOwner = offlineOwnerProjection();
    const cachedDetail = offlineDetailProjection();
    const offline = memoryOfflineCache();
    await offline.cache.save(profileFromCredential(credential), node, cachedOwner, cachedDetail);
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    vi.mocked(saved.storage.loadCredential).mockRejectedValueOnce(new MobileCredentialStorageError(
      "unavailable",
      "Protected credential storage is unavailable."
    ));
    const app = clientWithOfflineCache(network, saved.storage, offline.cache);

    await app.start();

    expect(network.inspect).toHaveBeenCalledOnce();
    expect(network.readOwner).not.toHaveBeenCalled();
    expect(app.state).toMatchObject({
      status: "offline",
      activeProfileId: credential.profileId,
      offlineSnapshotAt: 1_500
    });
    expect(app.state.saved[0]).toMatchObject({ credentialState: "offline" });
    expect(offline.values.size).toBeGreaterThan(0);
  });

  it("does not label a switched profile with another profile's durable cache age", async () => {
    const offlineCache = {
      load: vi.fn(async () => undefined),
      save: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("offline storage full")),
      clear: vi.fn(async () => undefined)
    };
    const network = fakeNetwork();
    network.readOwner = vi.fn(async (current) => current.profileId === otherCredential.profileId
      ? { connection: otherConnection, device: otherDevice, snapshot: extendedSnapshot }
      : { connection, device, snapshot });
    const saved = memoryStorage([credential, otherCredential], credential.profileId);
    const app = clientWithOfflineCache(network, saved.storage, offlineCache);
    await app.start();
    expect(offlineCache.save).toHaveBeenCalledTimes(1);

    await app.connectSaved(otherCredential.profileId);
    expect(app.state).toMatchObject({ status: "connected", activeProfileId: otherCredential.profileId });
    expect(app.state.error).toContain("offline storage full");
    vi.mocked(network.inspect).mockRejectedValueOnce(new Error("radio unavailable"));

    await app.refresh();

    expect(app.state.status).toBe("offline");
    expect(app.state.offlineSnapshotAt).toBeUndefined();
  });

  it("hides authenticated content before identity-conflict cache cleanup finishes", async () => {
    let releaseClear!: () => void;
    const offlineCache = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      clear: vi.fn(() => new Promise<void>((resolve) => { releaseClear = resolve; }))
    };
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = clientWithOfflineCache(network, saved.storage, offlineCache);
    await app.start();
    vi.mocked(network.inspect).mockResolvedValueOnce({ ...node, serverId: "other-node" });

    const refreshing = app.refresh();
    await vi.waitFor(() => expect(offlineCache.clear).toHaveBeenCalledWith(credential.profileId));
    expect(app.state).toMatchObject({
      status: "unpaired",
      busy: true,
      activeProfileId: undefined,
      owner: undefined,
      detail: undefined,
      offlineSnapshotAt: undefined
    });

    releaseClear();
    await refreshing;
    expect(app.state).toMatchObject({ status: "unpaired", busy: false, owner: undefined });
  });

  it("clears durable offline content on identity conflict, revocation, and local forget", async () => {
    const cache = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined)
    };
    const firstNetwork = fakeNetwork();
    const firstSaved = memoryStorage(credential);
    const first = clientWithOfflineCache(firstNetwork, firstSaved.storage, cache);
    await first.start();
    vi.mocked(firstNetwork.inspect).mockResolvedValueOnce({ ...node, serverId: "other-node" });
    await first.refresh();
    expect(cache.clear).toHaveBeenCalledWith(credential.profileId);
    expect(first.state).toMatchObject({ status: "unpaired", activeProfileId: undefined, owner: undefined });

    cache.clear.mockClear();
    const secondNetwork = fakeNetwork();
    const secondSaved = memoryStorage(credential);
    const second = clientWithOfflineCache(secondNetwork, secondSaved.storage, cache);
    await second.start();
    vi.mocked(secondNetwork.readOwner).mockResolvedValueOnce({
      connection: create(ConnectionSchema, { ...connection, state: ConnectionState.DISCONNECTED }),
      device,
      snapshot
    });
    await second.refresh();
    expect(cache.clear).toHaveBeenCalledWith(credential.profileId);
    expect(second.state.status).toBe("revoked");

    cache.clear.mockClear();
    const thirdSaved = memoryStorage(credential);
    const third = clientWithOfflineCache(fakeNetwork(), thirdSaved.storage, cache);
    await third.start();
    await third.forgetConnection(credential.profileId);
    expect(cache.clear).toHaveBeenCalledWith(credential.profileId);
    expect(third.state).toMatchObject({ status: "unpaired", activeProfileId: undefined, owner: undefined });
  });

  it("keeps the active mobile home authority while a candidate is inspected or a saved switch fails", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage([credential, otherCredential], credential.profileId);
    const app = client(network, saved.storage);
    await app.start();
    const activeStreamSignal = vi.mocked(network.streamOwner).mock.calls[0]?.[2];

    vi.mocked(network.inspect).mockResolvedValueOnce({ ...node, displayName: "Candidate Joko" });
    await app.inspect(otherCredential.origin);
    expect(app.state).toMatchObject({
      status: "connected",
      activeProfileId: credential.profileId,
      node: { displayName: node.displayName },
      candidate: { node: { displayName: "Candidate Joko" } }
    });
    app.cancel();
    expect(app.state.candidate).toBeUndefined();
    expect(app.state.activeProfileId).toBe(credential.profileId);
    expect(activeStreamSignal?.aborted).toBe(false);

    vi.mocked(network.readOwner).mockRejectedValueOnce(new Error("candidate unavailable"));
    await expect(app.connectSaved(otherCredential.profileId, false)).rejects.toThrow(/candidate unavailable/);
    expect(app.state).toMatchObject({
      status: "connected",
      activeProfileId: credential.profileId,
      node: { serverId: node.serverId },
      owner: { generation: snapshot.generation },
      connectionAttemptError: "candidate unavailable"
    });
    expect(app.state.saved.find((item) => item.profileId === otherCredential.profileId)).toMatchObject({
      credentialState: "offline"
    });
    expect(activeStreamSignal?.aborted).toBe(false);
  });

  it("adopts a different saved node only after its identity, credential, and snapshot all succeed", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage([credential, otherCredential], credential.profileId);
    const app = client(network, saved.storage);
    await app.start();
    let resolveCandidate!: (value: { connection: typeof otherConnection; device: typeof otherDevice; snapshot: typeof extendedSnapshot }) => void;
    vi.mocked(network.readOwner).mockImplementationOnce(() => new Promise((resolve) => { resolveCandidate = resolve; }));

    const switching = app.connectSaved(otherCredential.profileId, false);
    await vi.waitFor(() => expect(network.readOwner).toHaveBeenCalledWith(otherCredential, expect.any(AbortSignal)));
    expect(app.state).toMatchObject({
      status: "connected",
      activeProfileId: credential.profileId,
      owner: { generation: snapshot.generation }
    });

    resolveCandidate({ connection: otherConnection, device: otherDevice, snapshot: extendedSnapshot });
    await switching;
    expect(app.state).toMatchObject({
      status: "connected",
      activeProfileId: otherCredential.profileId,
      owner: { generation: extendedSnapshot.generation }
    });
    expect(app.state.candidate).toBeUndefined();
  });

  it("retires a late saved-catalog result before it can read a credential or overwrite an adopted connection", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential, false);
    const app = client(network, saved.storage);
    await app.start();
    let resolveCatalog!: (value: NodeIdentity) => void;
    vi.mocked(network.inspect).mockImplementationOnce(() => new Promise((resolve) => { resolveCatalog = resolve; }));

    const catalog = app.refreshSaved();
    await vi.waitFor(() => expect(network.inspect).toHaveBeenCalledOnce());
    await app.connectSaved(credential.profileId, false);
    resolveCatalog(node);
    await catalog;

    expect(saved.storage.loadCredential).toHaveBeenCalledTimes(1);
    expect(app.state).toMatchObject({ status: "connected", activeProfileId: credential.profileId });
    expect(app.state.saved[0]).toMatchObject({ credentialState: "available" });
  });

  it("keeps the in-memory mobile home projection during a transient reconnect failure", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.inspect).mockRejectedValueOnce(new Error("Wi-Fi changed"));

    await app.refresh();

    expect(app.state.status).toBe("offline");
    expect(app.state.owner).toEqual(snapshot);
    expect(app.state.detail).toEqual(snapshot);
    expect(app.state.error).toContain("Wi-Fi changed");
  });

  it("keeps an exact automatic target suspended when protected storage cannot be read", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    vi.mocked(saved.storage.loadCredential).mockRejectedValueOnce(new MobileCredentialStorageError(
      "unavailable",
      "Protected credential storage is unavailable."
    ));
    const app = client(network, saved.storage);

    await app.start();

    expect(network.inspect).toHaveBeenCalledOnce();
    expect(network.readOwner).not.toHaveBeenCalled();
    expect(saved.storage.deleteCredential).not.toHaveBeenCalled();
    expect(saved.automaticProfile()).toBe(credential.profileId);
    expect(app.state).toMatchObject({ status: "unpaired", automaticProfileId: credential.profileId });
    expect(app.state.saved[0]).toMatchObject({ credentialState: "unavailable", automatic: true });
  });

  it("keeps the last nearby list when a refresh fails and revalidates public identity before display", async () => {
    const network = fakeNetwork();
    const nearby = {
      serverId: node.serverId,
      displayName: "Untrusted announcement label",
      origin: credential.origin,
      version: "announcement-version",
      apiVersion: node.apiVersion,
      pairingEnabled: false,
      lastSeen: 1_000
    };
    const discovery: MobileDiscovery = { scan: vi.fn().mockResolvedValueOnce([nearby]).mockRejectedValueOnce(new Error("Wi-Fi discovery failed")) };
    const app = client(network, memoryStorage().storage, discovery);
    await app.start();

    await app.refreshNearby();
    expect(app.state.discoveryState).toBe("ready");
    expect(app.state.nearby).toEqual([expect.objectContaining({
      serverId: node.serverId,
      displayName: node.displayName,
      version: node.version,
      pairingEnabled: node.pairingEnabled
    })]);
    expect(network.inspect).toHaveBeenCalledWith(credential.origin, expect.any(AbortSignal));

    await app.refreshNearby();
    expect(app.state.discoveryState).toBe("error");
    expect(app.state.nearby).toHaveLength(1);
    expect(app.state.discoveryError).toContain("Wi-Fi discovery failed");
  });

  it("fails closed when a recently displayed server identity moves to another origin", async () => {
    const network = fakeNetwork();
    const first = {
      serverId: node.serverId,
      displayName: node.displayName,
      origin: credential.origin,
      version: node.version,
      apiVersion: node.apiVersion,
      pairingEnabled: true,
      lastSeen: 1_000
    };
    const moved = { ...first, origin: "http://192.168.1.21:4318", lastSeen: 1_500 };
    const discovery: MobileDiscovery = { scan: vi.fn().mockResolvedValueOnce([first]).mockResolvedValueOnce([moved]) };
    const app = client(network, memoryStorage().storage, discovery);
    await app.start();
    await app.refreshNearby();
    expect(app.state.nearby).toHaveLength(1);

    await app.refreshNearby();

    expect(app.state.discoveryState).toBe("ready");
    expect(app.state.nearby).toEqual([]);
  });

  it("forgets only the requested local profile without guessing by origin", async () => {
    const saved = memoryStorage([credential, otherCredential], false);
    const app = client(fakeNetwork(), saved.storage);
    await app.start();

    await app.forgetConnection(otherCredential.profileId);

    expect(saved.storage.deleteConnection).toHaveBeenCalledWith(otherCredential.profileId);
    expect(saved.key(otherCredential.profileId)).toBeUndefined();
    expect(saved.key(credential.profileId)).toEqual(credential);
    expect(app.state.saved.map((profile) => profile.profileId)).toEqual([credential.profileId]);
  });

  it("keeps a failed exact forget operable and does not report a stopped connection as connected", async () => {
    const saved = memoryStorage(credential);
    vi.mocked(saved.storage.deleteConnection).mockRejectedValueOnce(new MobileCredentialStorageError(
      "unavailable",
      "Protected credential storage is unavailable."
    ));
    const app = client(fakeNetwork(), saved.storage);
    await app.start();

    await expect(app.forgetConnection(credential.profileId)).rejects.toThrow(/unavailable/);

    expect(app.state.status).toBe("unpaired");
    expect(app.state.activeProfileId).toBeUndefined();
    expect(app.state.saved[0]).toMatchObject({
      profileId: credential.profileId,
      automatic: true,
      credentialState: "unavailable"
    });
    expect(saved.key()).toEqual(credential);
    expect(saved.automaticProfile()).toBe(credential.profileId);
  });

  it("clears receipts owned by an exact connection when it is forgotten", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
    await app.send(plainTextMobileComposerDraft("hello"));
    expect(saved.pending()).toHaveLength(1);

    await app.forgetConnection(credential.profileId);

    expect(saved.pending()).toEqual([]);
    expect(app.state.pending).toEqual([]);
  });

  it("restarts interrupted storage initialization when a background launch becomes active", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential, false);
    const app = client(network, saved.storage);
    app.setForeground(false);

    await app.start();
    expect(app.state.status).toBe("starting");
    expect(network.inspect).not.toHaveBeenCalled();

    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.status).toBe("unpaired"));
    expect(app.state.saved[0]).toMatchObject({ connectionId: credential.connectionId, automatic: false });
    expect(network.inspect).not.toHaveBeenCalled();
    expect(network.readOwner).not.toHaveBeenCalled();
  });

  it("reloads a newly durable pairing after backgrounding before in-memory adoption", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage();
    const app = client(network, saved.storage);
    await app.start();
    await app.inspect(credential.origin);
    await app.requestPairing(credential.origin, "Phone");
    const saveConnection = vi.mocked(saved.storage.saveConnection);
    const persist = saveConnection.getMockImplementation();
    if (!persist) throw new Error("Expected the in-memory connection writer.");
    saveConnection.mockImplementationOnce(async (value) => {
      await persist(value);
      app.setForeground(false);
    });

    await app.pair(credential.origin, "123456", "Phone", false);
    expect(saved.key()).toEqual(credential);
    expect(app.state.activeProfileId).toBeUndefined();

    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.saved).toHaveLength(1));
    expect(app.state.status).toBe("unpaired");
    expect(app.state.activeProfileId).toBeUndefined();
    expect(app.state.saved[0]).toMatchObject({ profileId: credential.profileId, automatic: false });
    expect(network.readOwner).toHaveBeenCalledTimes(1);
  });

  it("does not persist a cancelled pairing or a mismatched device identity", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage();
    const app = client(network, saved.storage);
    await app.start();
    await app.inspect(credential.origin);
    await app.requestPairing(credential.origin, "Phone");
    let resolve!: (result: { credential: PairedCredential; identity: typeof node }) => void;
    vi.mocked(network.completePairing).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = app.pair(credential.origin, "123456", "Phone");
    app.cancel();
    resolve({ credential, identity: node });
    await pending;
    expect(saved.storage.saveConnection).not.toHaveBeenCalled();

    await app.requestPairing(credential.origin, "Phone");
    vi.mocked(network.readOwner).mockResolvedValueOnce({ connection: create(ConnectionSchema, { ...connection, deviceId: "other" }), device, snapshot });
    await expect(app.pair(credential.origin, "123456", "Phone")).rejects.toThrow();
    expect(saved.storage.saveConnection).not.toHaveBeenCalled();
  });

  it("persists a paired credential before applying the shared automatic-entry choice", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage();
    const app = client(network, saved.storage);
    await app.start();
    await app.inspect(credential.origin);
    await app.requestPairing(credential.origin, "Phone");

    await app.pair(credential.origin, "123456", "Phone", false);

    expect(saved.storage.saveConnection).toHaveBeenCalledBefore(saved.storage.saveAutomaticProfile as ReturnType<typeof vi.fn>);
    expect(saved.storage.saveAutomaticProfile).toHaveBeenCalledWith(undefined);
    expect(app.state.status).toBe("connected");
    expect(app.state.saved[0]?.automatic).toBe(false);
  });

  it("keeps an unknown send receipt across restart and never repeats the mutation under another ID", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
    expect(await app.send(plainTextMobileComposerDraft("hello"))).toBe(false);
    expect(saved.pending()).toMatchObject([{ operationId: "operation-1", kind: "send", sessionId: "session", state: "unknown" }]);
    expect(network.submit).toHaveBeenCalledOnce();
    await expect(app.send(plainTextMobileComposerDraft("hello"))).rejects.toThrow(/unknown result/);
    await app.refresh();
    expect(network.submit).toHaveBeenCalledOnce();
    expect(saved.pending()).toHaveLength(1);
    app.dispose();

    const restored = client(network, saved.storage);
    vi.mocked(network.getOperation).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "operation-1", connectionId: credential.connectionId, state: OperationState.SUCCEEDED
    }));
    await restored.start();
    expect(restored.state.status).toBe("connected");
    expect(saved.pending()).toHaveLength(0);
    expect(network.submit).toHaveBeenCalledOnce();
  });

  it("requires an authenticated authoritative absence before an explicit unknown receipt is cleared", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
    await app.send(plainTextMobileComposerDraft("hello"));
    vi.mocked(network.getOperation).mockRejectedValueOnce(new Error("offline"));
    await expect(app.dismissUnconfirmed("operation-1")).rejects.toThrow("offline");
    expect(saved.pending()).toHaveLength(1);
    await app.dismissUnconfirmed("operation-1");
    expect(saved.pending()).toHaveLength(0);
    expect(network.submit).toHaveBeenCalledOnce();
  });

  it("logs out one exact server connection with its current revision before local cleanup", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const offlineCache = {
      load: vi.fn(async () => undefined), save: vi.fn(async () => undefined), clear: vi.fn(async () => undefined)
    };
    const app = clientWithOfflineCache(network, saved.storage, offlineCache);
    await app.start();

    expect(await app.logoutConnection(credential.connectionId)).toBe(true);

    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{ entity: { kind: EntityKind.CONNECTION, id: credential.connectionId }, expectedRevision: { value: 4n } }],
      payload: { case: "logoutConnection", value: { connectionId: credential.connectionId } }
    });
    expect(saved.storage.deleteConnection).toHaveBeenCalledWith(credential.profileId);
    expect(saved.key()).toBeUndefined();
    expect(offlineCache.clear).toHaveBeenCalledWith(credential.profileId);
    expect(app.state.status).toBe("unpaired");
    expect(app.state.saved).toEqual([]);
  });

  it("preserves the exact credential and unknown receipt when logout acknowledgement is lost", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const offlineCache = {
      load: vi.fn(async () => undefined), save: vi.fn(async () => undefined), clear: vi.fn(async () => undefined)
    };
    const app = clientWithOfflineCache(network, saved.storage, offlineCache);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));

    expect(await app.logoutConnection(credential.connectionId)).toBe(false);

    expect(saved.storage.deleteConnection).not.toHaveBeenCalled();
    expect(saved.key()).toEqual(credential);
    expect(app.state.status).toBe("connected");
    expect(saved.pending()).toMatchObject([{
      kind: "logout",
      targetConnectionId: credential.connectionId,
      state: "unknown"
    }]);
    expect(app.state.saved[0]?.pendingOperations).toMatchObject([{
      kind: "logout",
      targetConnectionId: credential.connectionId,
      state: "unknown"
    }]);
    expect(offlineCache.clear).not.toHaveBeenCalled();
  });

  it("revokes another exact device but requires logout for the current mobile device", async () => {
    const network = fakeNetwork();
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: extendedSnapshot });
    const saved = memoryStorage([credential, otherCredential], credential.profileId);
    const offlineCache = {
      load: vi.fn(async () => undefined), save: vi.fn(async () => undefined), clear: vi.fn(async () => undefined)
    };
    const app = clientWithOfflineCache(network, saved.storage, offlineCache);
    await app.start();

    await expect(app.revokeDevice(credential.deviceId)).rejects.toThrow(/Log out/);
    expect(await app.revokeDevice(otherCredential.deviceId)).toBe(true);

    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{ entity: { kind: EntityKind.DEVICE, id: otherCredential.deviceId }, expectedRevision: { value: 7n } }],
      payload: { case: "revokeDevice", value: { deviceId: otherCredential.deviceId } }
    });
    expect(saved.storage.deleteConnection).toHaveBeenCalledWith(otherCredential.profileId);
    expect(saved.key(otherCredential.profileId)).toBeUndefined();
    expect(offlineCache.clear).toHaveBeenCalledWith(otherCredential.profileId);
    expect(saved.key(credential.profileId)).toEqual(credential);
    expect(app.state.status).toBe("connected");
  });

  it("renames only the current authoritative mobile device with a body-free durable receipt", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockImplementationOnce(async (_credential, operationId, mutation) => create(OperationSchema, {
      operationId,
      connectionId: credential.connectionId,
      state: OperationState.ACCEPTED,
      mutation
    }));
    vi.mocked(network.waitOperation).mockImplementationOnce(async (_credential, operationId) => create(OperationSchema, {
      operationId,
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED,
      result: { payload: { case: "device", value: create(DeviceSchema, {
        ...device,
        displayName: "Field phone",
        version: create(EntityVersionSchema, { revision: create(RevisionSchema, { value: 6n }) })
      }) } }
    }));

    expect(await app.renameCurrentDevice(credential.deviceId, "  Field phone  ")).toBe(true);

    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{ entity: { kind: EntityKind.DEVICE, id: credential.deviceId }, expectedRevision: { value: 5n } }],
      payload: { case: "renameDevice", value: { deviceId: credential.deviceId, displayName: "Field phone" } }
    });
    expect(saved.pending()).toEqual([]);
    expect(network.waitOperation).toHaveBeenCalledWith(credential, "operation-1", expect.any(AbortSignal));
    expect(network.readOwner).toHaveBeenCalledTimes(2);
    await expect(app.renameCurrentDevice(otherCredential.deviceId, "Other phone")).rejects.toThrow(/Only the device/);
    await expect(app.renameCurrentDevice(credential.deviceId, " ")).rejects.toThrow(/between 1 and 128/);
    expect(network.submit).toHaveBeenCalledOnce();
  });

  it("retains an unknown current-device rename receipt without its display name and reconciles it without replay", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));

    expect(await app.renameCurrentDevice(credential.deviceId, "Private phone label")).toBe(false);

    expect(saved.pending()).toMatchObject([{
      operationId: "operation-1",
      kind: "device-rename",
      targetDeviceId: credential.deviceId,
      state: "unknown"
    }]);
    expect(JSON.stringify(saved.pending())).not.toContain("Private phone label");
    expect(network.submit).toHaveBeenCalledOnce();
    vi.mocked(network.getOperation).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "operation-1",
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED
    }));

    await app.reconcile();

    expect(saved.pending()).toEqual([]);
    expect(network.submit).toHaveBeenCalledOnce();
    expect(network.readOwner).toHaveBeenCalledTimes(2);
  });

  it("fails current-device rename closed for ambiguous owner identity or a missing Device revision", async () => {
    const ambiguous = projectedNetwork(create(SnapshotSchema, {
      ...snapshot,
      connections: [connection, create(ConnectionSchema, { ...connection })]
    }));
    const ambiguousApp = client(ambiguous, memoryStorage(credential).storage);
    await ambiguousApp.start();
    expect(ambiguousApp.state.status).toBe("connected");
    await expect(ambiguousApp.renameCurrentDevice(credential.deviceId, "Renamed"))
      .rejects.toThrow(/exact current profile, connection, mobile device, server/);
    expect(ambiguous.submit).not.toHaveBeenCalled();

    const noRevision = projectedNetwork(create(SnapshotSchema, {
      ...snapshot,
      devices: [create(DeviceSchema, { ...device, version: undefined })]
    }));
    const noRevisionApp = client(noRevision, memoryStorage(credential).storage);
    await noRevisionApp.start();
    expect(noRevisionApp.state.status).toBe("connected");
    await expect(noRevisionApp.renameCurrentDevice(credential.deviceId, "Renamed"))
      .rejects.toThrow(/Device revision/);
    expect(noRevision.submit).not.toHaveBeenCalled();
  });

  it("admits only one user mutation while its receipt is being persisted", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    let release!: () => void;
    vi.mocked(saved.storage.savePending).mockImplementationOnce(() => new Promise<void>((done) => { release = done; }));
    const first = app.send(plainTextMobileComposerDraft("one message"));
    await expect(app.send(plainTextMobileComposerDraft("one message")))
      .rejects.toThrow(/unknown result|already being submitted|already in progress/);
    expect(network.submit).not.toHaveBeenCalled();
    release();
    expect(await first).toBe(true);
    expect(network.submit).toHaveBeenCalledOnce();
  });

  it("retains an unsent operation warning when the app backgrounds during receipt persistence", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    let release!: () => void;
    const original = saved.storage.savePending;
    vi.mocked(saved.storage.savePending).mockImplementationOnce(async (items) => {
      await new Promise<void>((done) => { release = done; });
      await original(items);
    });
    const sending = app.send(plainTextMobileComposerDraft("one message"));
    await vi.waitFor(() => expect(saved.storage.savePending).toHaveBeenCalledOnce());
    app.setForeground(false);
    release();
    expect(await sending).toBe(false);
    expect(network.submit).not.toHaveBeenCalled();
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.status).toBe("connected"));
    expect(app.state.pending).toMatchObject([{ operationId: "operation-1", state: "unknown" }]);
    expect(network.getOperation).toHaveBeenCalledWith(credential, "operation-1", expect.any(AbortSignal));
  });

  it("retains a first message, creates with the exact Target revision, and sends with the creation result generation", async () => {
    const network = fakeNetwork();
    const drafts = memoryDraftStores();
    let operation = 0;
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      toBinary(OperationMutationSchema, mutation);
      if (mutation.payload.case === "createSession") {
        return create(OperationSchema, {
          operationId,
          connectionId: credential.connectionId,
          state: OperationState.SUCCEEDED,
          result: { payload: { case: "session", value: snapshot.sessions[0]! } }
        });
      }
      return create(OperationSchema, {
        operationId,
        connectionId: credential.connectionId,
        state: OperationState.SUCCEEDED,
        result: { payload: { case: "queueItem", value: create(QueueItemSchema, {
          queueItemId: "first-message",
          backendId: "backend",
          targetId: "target",
          sessionId: "session",
          state: QueueItemState.ACCEPTED
        }) } }
      });
    });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => `operation-${++operation}`, undefined, drafts);
    await app.start();
    await expect(app.create("target", "Work", plainTextMobileComposerDraft("hello"))).resolves.toEqual({
      sessionId: "session", created: true, sent: true, definitive: true
    });
    expect(network.prepareTarget).toHaveBeenCalledWith(credential, snapshot.targets[0], expect.any(AbortSignal));
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{ entity: { id: "target" }, expectedRevision: { value: 3n } }],
      payload: { case: "createSession", value: { backendId: "backend", targetId: "target", displayName: "Work" } }
    });
    expect(vi.mocked(network.submit).mock.calls[1]?.[2]).toMatchObject({
      preconditions: [{ entity: { id: "session" }, expectedGeneration: 8n }],
      payload: { case: "sendInput", value: { sessionId: "session", input: { parts: [{ content: { case: "text", value: "hello" } }] } } }
    });
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toBeNull();
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
  });

  it("uploads a retained attachment-only first input after creation and sends canonical image/file parts", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const drafts = memoryDraftStores();
    const persistedBeforeRemove: boolean[] = [];
    const fixture = attachmentFileFixture((attachmentId) => {
      const current = drafts.newTask.readSync({ profileId: credential.profileId })?.submission?.input.attachments
        .find((attachment) => attachment.attachmentId === attachmentId);
      persistedBeforeRemove.push(current?.state === "uploaded");
    });
    const input = localAttachmentDraft();
    vi.mocked(network.uploadBlob).mockImplementation(async (_credential, source) => {
      const attachment = input.attachments.find((candidate) => candidate.fileName === source.fileName)!;
      return committedAttachment(attachment as MobileLocalComposerAttachment);
    });
    let operation = 0;
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => mutation.payload.case === "createSession"
      ? create(OperationSchema, {
          operationId,
          connectionId: credential.connectionId,
          state: OperationState.SUCCEEDED,
          result: { payload: { case: "session", value: attachmentSnapshot.sessions[0]! } }
        })
      : create(OperationSchema, {
          operationId,
          connectionId: credential.connectionId,
          state: OperationState.SUCCEEDED,
          result: { payload: { case: "queueItem", value: create(QueueItemSchema, {
            queueItemId: "attachment-first-input",
            backendId: "backend",
            targetId: "target",
            sessionId: "session",
            state: QueueItemState.ACCEPTED
          }) } }
        }));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => `operation-${++operation}`, undefined, drafts, fixture.files);
    await app.start();

    expect(app.newTaskAttachmentControls("target")).toMatchObject({
      profileId: credential.profileId,
      policy: { images: true, files: true, maximumItems: 4, maximumBytes: 1_024 }
    });
    await expect(app.create("target", "Attachments", input)).resolves.toEqual({
      sessionId: "session", created: true, sent: true, definitive: true
    });

    expect(vi.mocked(network.uploadBlob).mock.calls.map((call) => call[1].fileName))
      .toEqual(["pixel.png", "proof.pdf"]);
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      payload: { case: "createSession", value: { model: {
        model: { providerId: "vision-provider", modelId: "vision-model" },
        effortId: "",
        fastMode: false
      } } }
    });
    expect(persistedBeforeRemove).toEqual([true, true]);
    expect(fixture.removed).toEqual(["image-one", "file-one"]);
    const send = vi.mocked(network.submit).mock.calls[1]?.[2];
    expect(send).toMatchObject({
      preconditions: [{ expectedGeneration: 8n }],
      payload: { case: "sendInput", value: { input: { parts: [
        { content: { case: "image", value: { blob: { blobId: "blob-image-one" } } } },
        { content: { case: "file", value: { blobId: "blob-file-one" } } }
      ] } } }
    });
    expect(vi.mocked(network.uploadBlob).mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(network.submit).mock.invocationCallOrder[1]!);
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toBeNull();
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
  });

  it("keeps file input but fails image input closed when the exact receiving model is text-only", async () => {
    const textOnly = create(SnapshotSchema, {
      ...attachmentSnapshot,
      models: [create(ModelDescriptorSchema, {
        ...attachmentSnapshot.models[0]!,
        inputModalities: [ModelInputModality.TEXT]
      })]
    });
    const network = projectedNetwork(textOnly);
    const drafts = memoryDraftStores();
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "unused-operation", undefined, drafts, fixture.files);
    await app.start();

    expect(app.newTaskAttachmentControls("target")?.policy).toMatchObject({ images: false, files: true });
    expect(app.taskAttachmentControls()?.policy).toMatchObject({ images: false, files: true });
    await expect(app.create("target", "Text-only model", localAttachmentDraft()))
      .rejects.toThrow(/image type is not supported/u);
    await expect(app.send(localAttachmentDraft())).rejects.toThrow(/image type is not supported/u);
    expect(network.uploadBlob).not.toHaveBeenCalled();
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("recovers the exact partially committed attachment first input when a later upload fails", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const drafts = memoryDraftStores();
    const fixture = attachmentFileFixture();
    const input = localAttachmentDraft("Keep context");
    vi.mocked(network.uploadBlob).mockImplementation(async (_credential, source) => {
      if (source.fileName === "proof.pdf") throw new Error("upload unavailable");
      return committedAttachment(input.attachments[0] as MobileLocalComposerAttachment);
    });
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      if (mutation.payload.case !== "createSession") throw new Error("first input must not dispatch");
      return create(OperationSchema, {
        operationId,
        connectionId: credential.connectionId,
        state: OperationState.SUCCEEDED,
        result: { payload: { case: "session", value: attachmentSnapshot.sessions[0]! } }
      });
    });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "operation-create", undefined, drafts, fixture.files);
    await app.start();

    await expect(app.create("target", "Attachment recovery", input)).rejects.toThrow("upload unavailable");

    expect(network.submit).toHaveBeenCalledOnce();
    expect(fixture.removed).toEqual(["image-one"]);
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toBeNull();
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" }))
      .toMatchObject({
        text: "Keep context",
        attachments: [
          { attachmentId: "image-one", state: "uploaded", blobId: "blob-image-one" },
          { attachmentId: "file-one", state: "local" }
        ]
      });
  });

  it("re-reads pre-creation Session and Workspace authority and sends their exact typed ranges", async () => {
    const network = projectedNetwork(newTaskMentionSnapshot);
    const drafts = memoryDraftStores();
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspaceId, parentPath) => ({
      entries: parentPath === "src" ? [workspaceMentionFile] : [workspaceMentionDirectory],
      revision: `directory:${parentPath}`
    }));
    let operation = 0;
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      toBinary(OperationMutationSchema, mutation);
      return mutation.payload.case === "createSession"
        ? create(OperationSchema, {
            operationId,
            connectionId: credential.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "session", value: newTaskMentionSnapshot.sessions[0]! } }
          })
        : create(OperationSchema, {
            operationId,
            connectionId: credential.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "queueItem", value: create(QueueItemSchema, {
              queueItemId: "typed-first-message",
              backendId: "backend",
              targetId: "target",
              sessionId: "session",
              state: QueueItemState.ACCEPTED
            }) } }
          });
    });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => `operation-${++operation}`, undefined, drafts);
    await app.start();

    expect(app.newTaskSessionMentionControls("target")?.candidates.map((candidate) => candidate.sessionId))
      .toEqual(["related", "session"]);
    expect(app.newTaskWorkspaceMentionControls("target")).toMatchObject({
      targetId: "target",
      workspaceId: "workspace",
      policy: { files: true, directories: true, lineRanges: true }
    });
    const input = newTaskStructuredInput();
    await expect(app.create("target", "Typed", input)).resolves.toEqual({
      sessionId: "session", created: true, sent: true, definitive: true
    });

    const send = vi.mocked(network.submit).mock.calls.find((call) => call[2].payload.case === "sendInput")?.[2];
    expect(send?.payload.case).toBe("sendInput");
    if (send?.payload.case !== "sendInput") throw new Error("Expected the first input mutation.");
    expect(send.payload.value.input).toEqual(mobileComposerInput(input));
    expect(send.preconditions).toMatchObject([{ expectedGeneration: 8n }]);
    expect(network.listWorkspaceDirectory).toHaveBeenCalledWith(
      credential,
      "workspace",
      "src",
      expect.any(AbortSignal)
    );
    expect(network.listSessionResources).not.toHaveBeenCalled();
    expect(network.listArtifactReferenceCatalog).not.toHaveBeenCalled();
  });

  it("retires a historical Session reference when its owner changes before creation", async () => {
    const network = projectedNetwork(newTaskMentionSnapshot);
    const retired = create(SnapshotSchema, {
      ...newTaskMentionSnapshot,
      sessions: [newTaskMentionSnapshot.sessions[0]!]
    });
    vi.mocked(network.readOwner)
      .mockResolvedValueOnce({ connection, device, snapshot: newTaskMentionSnapshot })
      .mockResolvedValue({ connection, device, snapshot: retired });
    const drafts = memoryDraftStores();
    const sessionInput = insertMobileSessionMention(
      plainTextMobileComposerDraft("Use"),
      { start: 3, end: 3 },
      { sessionId: "related", displayText: "Earlier task" },
      "new-task-session"
    ).draft;
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "operation-create", undefined, drafts);
    await app.start();

    await expect(app.create("target", "Retired", sessionInput)).rejects.toThrow(/Referenced-task authority changed/u);
    expect(network.submit).not.toHaveBeenCalled();
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toMatchObject({ input: sessionInput });
  });

  it("revalidates a new-task absolute Workspace path and sends only its relative wire text", async () => {
    const network = projectedNetwork(workspacePathSnapshot);
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, workspaceId, parentPath) => ({
      entries: workspaceId === "workspace" && parentPath === "src" ? [workspaceMentionFile] : [],
      revision: `directory:${parentPath || "root"}`
    }));
    let operation = 0;
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) =>
      mutation.payload.case === "createSession"
        ? create(OperationSchema, {
            operationId,
            connectionId: credential.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "session", value: workspacePathSnapshot.sessions[0]! } }
          })
        : create(OperationSchema, {
            operationId,
            connectionId: credential.connectionId,
            state: OperationState.SUCCEEDED,
            result: { payload: { case: "queueItem", value: create(QueueItemSchema, {
              queueItemId: "path-first-input",
              backendId: "backend",
              targetId: "target",
              sessionId: "session",
              state: QueueItemState.ACCEPTED
            }) } }
          }));
    const drafts = memoryDraftStores();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => `path-operation-${++operation}`, undefined, drafts);
    await app.start();
    const controls = app.newTaskWorkspacePathPasteControls("target")!;
    await expect(app.validateNewTaskWorkspacePathPasteCandidates(
      "target",
      controls.surfaceOwnerKey,
      ["src/main.ts", "src/missing.ts"]
    )).resolves.toEqual([{
      candidateRelativePath: "src/main.ts",
      relativePath: "src/main.ts",
      directory: false
    }]);

    await expect(app.create("target", "Path", workspacePathDraft())).resolves.toEqual({
      sessionId: "session", created: true, sent: true, definitive: true
    });
    const send = vi.mocked(network.submit).mock.calls.find((call) => call[2].payload.case === "sendInput")?.[2];
    expect(send?.payload.case).toBe("sendInput");
    if (send?.payload.case !== "sendInput") throw new Error("Expected the first input mutation.");
    expect(send.payload.value.input).toMatchObject({
      parts: [{ content: { case: "text", value: "Open @src/main.ts" } }],
      mentionRanges: [],
      pastedTextRanges: []
    });
    expect(JSON.stringify(send.payload.value.input)).not.toContain("D:\\\\repo");
  });

  it("retires an in-flight new-task Workspace selection after Target or Workspace drift", async () => {
    const network = projectedNetwork(newTaskMentionSnapshot);
    const changed = create(SnapshotSchema, {
      ...newTaskMentionSnapshot,
      targets: [create(TargetSchema, {
        ...newTaskMentionSnapshot.targets[0]!,
        workspaceId: "workspace-two",
        version: create(EntityVersionSchema, {
          revision: create(RevisionSchema, { value: 4n, etag: "target-r4" })
        })
      })],
      workspaces: [create(WorkspaceDescriptorSchema, {
        workspaceId: "workspace-two",
        targetId: "target",
        displayName: "Moved project",
        kind: WorkspaceKind.USER_PROJECT
      })]
    });
    vi.mocked(network.readOwner)
      .mockResolvedValueOnce({ connection, device, snapshot: newTaskMentionSnapshot })
      .mockResolvedValueOnce({ connection, device, snapshot: newTaskMentionSnapshot })
      .mockResolvedValue({ connection, device, snapshot: changed });
    vi.mocked(network.listWorkspaceDirectory).mockResolvedValue({
      entries: [workspaceMentionFile],
      revision: "directory:src"
    });
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const controls = app.newTaskWorkspaceMentionControls("target")!;

    await expect(app.validateNewTaskWorkspaceMentionCandidate("target", controls.surfaceOwnerKey, {
      workspaceId: "workspace",
      relativePath: "src/main.ts",
      displayText: "main.ts",
      directory: false
    })).rejects.toThrow(/authority changed/u);
  });

  it("retains an editable new-task draft after a definitive creation failure", async () => {
    const network = fakeNetwork();
    const drafts = memoryDraftStores();
    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "operation-create",
      connectionId: credential.connectionId,
      state: OperationState.FAILED,
      error: { code: "CREATE_REJECTED", message: "The project rejected creation." }
    }));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "operation-create", undefined, drafts);
    await app.start();

    await expect(app.create("target", "Work", plainTextMobileComposerDraft("keep this first message"))).resolves.toEqual({
      created: false, sent: false, definitive: true
    });
    expect(network.submit).toHaveBeenCalledOnce();
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toEqual({
      targetId: "target", name: "Work", input: plainTextMobileComposerDraft("keep this first message")
    });
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
  });

  it("keeps the exact creation receipt and never sends when the server returns a different operation identity", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const drafts = memoryDraftStores();
    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "operation-from-another-request",
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED,
      result: { payload: { case: "session", value: snapshot.sessions[0]! } }
    }));
    const app = client(network, saved.storage, undefined, undefined,
      () => "operation-create", undefined, drafts);
    await app.start();

    await expect(app.create("target", "Identity", plainTextMobileComposerDraft("do not send this twice"))).resolves.toEqual({
      created: false, sent: false, definitive: false
    });
    expect(network.submit).toHaveBeenCalledOnce();
    expect(saved.pending()).toMatchObject([{
      operationId: "operation-create", connectionId: credential.connectionId, kind: "create", state: "unknown"
    }]);
    expect(drafts.newTask.readSync({ profileId: credential.profileId })?.submission).toMatchObject({
      phase: "creating", createOperationId: "operation-create", input: plainTextMobileComposerDraft("do not send this twice")
    });
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
    expect(app.state.error).toMatch(/wrong durable identity/);
  });

  it("reconciles an unknown creation after restart and sends the retained text only once", async () => {
    const saved = memoryStorage(credential);
    const drafts = memoryDraftStores();
    let operation = 0;
    const nextId = () => `operation-${++operation}`;
    const firstNetwork = fakeNetwork();
    vi.mocked(firstNetwork.submit).mockRejectedValueOnce(new Error("creation reply lost"));
    const first = client(firstNetwork, saved.storage, undefined, undefined, nextId, undefined, drafts);
    await first.start();

    await expect(first.create("target", "Recovered", plainTextMobileComposerDraft("resume this exact input"))).resolves.toEqual({
      created: false, sent: false, definitive: false
    });
    expect(saved.pending()).toMatchObject([{ operationId: "operation-1", kind: "create", state: "unknown" }]);
    expect(drafts.newTask.readSync({ profileId: credential.profileId })?.submission).toMatchObject({
      phase: "creating", createOperationId: "operation-1", input: plainTextMobileComposerDraft("resume this exact input")
    });
    first.dispose();

    const recoveredNetwork = fakeNetwork();
    vi.mocked(recoveredNetwork.getOperation).mockImplementation(async (_credential, operationId) => create(OperationSchema, {
      operationId,
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED,
      result: { payload: { case: "session", value: snapshot.sessions[0]! } }
    }));
    vi.mocked(recoveredNetwork.submit).mockImplementation(async (_credential, operationId, mutation) => {
      expect(mutation.payload.case).toBe("sendInput");
      return create(OperationSchema, {
        operationId,
        connectionId: credential.connectionId,
        state: OperationState.SUCCEEDED,
        result: { payload: { case: "queueItem", value: create(QueueItemSchema, {
          queueItemId: "recovered-first-message",
          backendId: "backend",
          targetId: "target",
          sessionId: "session",
          state: QueueItemState.ACCEPTED
        }) } }
      });
    });
    const recovered = client(recoveredNetwork, saved.storage, undefined, undefined, nextId, undefined, drafts);
    await recovered.start();

    expect(recoveredNetwork.submit).toHaveBeenCalledOnce();
    expect(vi.mocked(recoveredNetwork.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{ entity: { id: "session" }, expectedGeneration: 8n }],
      payload: { case: "sendInput", value: { input: { parts: [{ content: { case: "text", value: "resume this exact input" } }] } } }
    });
    expect(saved.pending()).toEqual([]);
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toBeNull();
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
  });

  it("releases a retained creation that could not have been dispatched because no receipt exists", async () => {
    const network = fakeNetwork();
    const drafts = memoryDraftStores();
    await drafts.newTask.beginSubmission({ profileId: credential.profileId }, {
      targetId: "target", name: "Prepared", input: plainTextMobileComposerDraft("still editable")
    }, {
      connectionId: credential.connectionId,
      serverId: credential.serverId,
      backendId: "backend",
      targetRevision: "3",
      model: null,
      createOperationId: "operation-never-dispatched"
    });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "unused-operation", undefined, drafts);

    await app.start();

    expect(network.getOperation).toHaveBeenCalledWith(credential, "operation-never-dispatched", expect.any(AbortSignal));
    expect(network.submit).not.toHaveBeenCalled();
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toEqual({
      targetId: "target", name: "Prepared", input: plainTextMobileComposerDraft("still editable")
    });
    expect(app.state.error).toMatch(/not dispatched/);
  });

  it("keeps the created task composer draft while an unknown first send is reconciled", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const drafts = memoryDraftStores();
    let operation = 0;
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      if (mutation.payload.case === "createSession") {
        return create(OperationSchema, {
          operationId,
          connectionId: credential.connectionId,
          state: OperationState.SUCCEEDED,
          result: { payload: { case: "session", value: snapshot.sessions[0]! } }
        });
      }
      throw new Error("first-message reply lost");
    });
    const app = client(network, saved.storage, undefined, undefined,
      () => `operation-${++operation}`, undefined, drafts);
    await app.start();

    await expect(app.create("target", "Work", plainTextMobileComposerDraft("do not duplicate me"))).resolves.toEqual({
      sessionId: "session", created: true, sent: false, definitive: false
    });
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" }))
      .toEqual(plainTextMobileComposerDraft("do not duplicate me"));
    expect(drafts.newTask.readSync({ profileId: credential.profileId })?.submission).toMatchObject({
      phase: "sending", createOperationId: "operation-1", sendOperationId: "operation-2"
    });
    expect(saved.pending()).toMatchObject([{ operationId: "operation-2", kind: "send", sessionId: "session", state: "unknown" }]);
    expect(JSON.stringify(saved.pending())).not.toContain("do not duplicate me");

    vi.mocked(network.getOperation).mockImplementation(async (_credential, operationId) => create(OperationSchema, {
      operationId,
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED,
      result: { payload: { case: "queueItem", value: create(QueueItemSchema, {
        queueItemId: "confirmed-first-message",
        backendId: "backend",
        targetId: "target",
        sessionId: "session",
        state: QueueItemState.ACCEPTED
      }) } }
    }));
    await app.reconcile();

    expect(network.submit).toHaveBeenCalledTimes(2);
    expect(saved.pending()).toEqual([]);
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toBeNull();
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
  });

  it("never sends the retained first input after the created runtime generation changes", async () => {
    const network = fakeNetwork();
    const drafts = memoryDraftStores();
    const reboundSession = create(SessionSchema, {
      ...snapshot.sessions[0]!,
      nativeBinding: create(NativeSessionBindingSchema, { runtimeGeneration: 9n }),
      version: create(EntityVersionSchema, { revision: create(RevisionSchema, { value: 10n }), generation: 9n })
    });
    const rebound = create(SnapshotSchema, { ...snapshot, sessions: [reboundSession] });
    vi.mocked(network.readOwner)
      .mockResolvedValueOnce({ connection, device, snapshot })
      .mockResolvedValue({ connection, device, snapshot: rebound });
    vi.mocked(network.readSession).mockResolvedValue(rebound);
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      expect(mutation.payload.case).toBe("createSession");
      return create(OperationSchema, {
        operationId,
        connectionId: credential.connectionId,
        state: OperationState.SUCCEEDED,
        result: { payload: { case: "session", value: snapshot.sessions[0]! } }
      });
    });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "operation-create", undefined, drafts);
    await app.start();

    await expect(app.create("target", "Rebound", plainTextMobileComposerDraft("review after reset"))).resolves.toEqual({
      sessionId: "session", created: true, sent: false, definitive: true
    });
    expect(network.submit).toHaveBeenCalledOnce();
    expect(app.state.error).toMatch(/runtime changed/);
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toBeNull();
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" }))
      .toEqual(plainTextMobileComposerDraft("review after reset"));
  });

  it("revalidates the exact Target after preparation and never dispatches creation on revision drift", async () => {
    const network = fakeNetwork();
    const drafts = memoryDraftStores();
    const changedTarget = create(TargetSchema, {
      ...snapshot.targets[0]!,
      version: create(EntityVersionSchema, { revision: create(RevisionSchema, { value: 4n, etag: "target-r4" }) })
    });
    const changed = create(SnapshotSchema, { ...snapshot, targets: [changedTarget] });
    let app!: MobileClient;
    network.prepareTarget = vi.fn(async () => {
      vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: changed });
      await app.refresh();
    });
    app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "operation-create", undefined, drafts);
    await app.start();

    await expect(app.create("target", "Changed", plainTextMobileComposerDraft("retain after drift"))).rejects.toThrow(/changed while.*prepared/i);
    expect(network.submit).not.toHaveBeenCalled();
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toEqual({
      targetId: "target", name: "Changed", input: plainTextMobileComposerDraft("retain after drift")
    });
  });

  it("moves a definitively rejected first message into the created task composer without creating again", async () => {
    const network = fakeNetwork();
    const drafts = memoryDraftStores();
    let operation = 0;
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => mutation.payload.case === "createSession"
      ? create(OperationSchema, {
          operationId,
          connectionId: credential.connectionId,
          state: OperationState.SUCCEEDED,
          result: { payload: { case: "session", value: snapshot.sessions[0]! } }
        })
      : create(OperationSchema, {
          operationId,
          connectionId: credential.connectionId,
          state: OperationState.CONFLICT,
          error: { code: "GENERATION_CONFLICT", message: "The task runtime changed." }
        }));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => `operation-${++operation}`, undefined, drafts);
    await app.start();

    await expect(app.create("target", "Created", plainTextMobileComposerDraft("retry from the task"))).resolves.toEqual({
      sessionId: "session", created: true, sent: false, definitive: true
    });
    expect(network.submit).toHaveBeenCalledTimes(2);
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toBeNull();
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" }))
      .toEqual(plainTextMobileComposerDraft("retry from the task"));
  });

  it("prefixes a rejected structured first input without overwriting a newer created-task draft", async () => {
    const network = projectedNetwork(newTaskMentionSnapshot);
    const drafts = memoryDraftStores();
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspaceId, parentPath) => ({
      entries: parentPath === "src" ? [workspaceMentionFile] : [workspaceMentionDirectory],
      revision: `directory:${parentPath}`
    }));
    let operation = 0;
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      if (mutation.payload.case === "createSession") {
        return create(OperationSchema, {
          operationId,
          connectionId: credential.connectionId,
          state: OperationState.SUCCEEDED,
          result: { payload: { case: "session", value: newTaskMentionSnapshot.sessions[0]! } }
        });
      }
      drafts.composer.save(
        { profileId: credential.profileId, sessionId: "session" },
        plainTextMobileComposerDraft("Newer navigation draft")
      );
      return create(OperationSchema, {
        operationId,
        connectionId: credential.connectionId,
        state: OperationState.CONFLICT,
        error: { code: "GENERATION_CONFLICT", message: "The task runtime changed." }
      });
    });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => `operation-${++operation}`, undefined, drafts);
    await app.start();
    const input = newTaskStructuredInput();

    await expect(app.create("target", "Structured recovery", input)).resolves.toEqual({
      sessionId: "session", created: true, sent: false, definitive: true
    });
    const recovered = drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" });
    expect(recovered?.text).toBe(`${input.text}\n\nNewer navigation draft`);
    expect(recovered?.mentions).toEqual(input.mentions);
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toBeNull();
  });

  it("removes only the recovered prefix when an unknown structured send later succeeds", async () => {
    const network = projectedNetwork(newTaskMentionSnapshot);
    const saved = memoryStorage(credential);
    const drafts = memoryDraftStores();
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspaceId, parentPath) => ({
      entries: parentPath === "src" ? [workspaceMentionFile] : [workspaceMentionDirectory],
      revision: `directory:${parentPath}`
    }));
    let operation = 0;
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      if (mutation.payload.case === "createSession") {
        return create(OperationSchema, {
          operationId,
          connectionId: credential.connectionId,
          state: OperationState.SUCCEEDED,
          result: { payload: { case: "session", value: newTaskMentionSnapshot.sessions[0]! } }
        });
      }
      throw new Error("first-message reply lost");
    });
    const app = client(network, saved.storage, undefined, undefined,
      () => `operation-${++operation}`, undefined, drafts);
    await app.start();
    const input = newTaskStructuredInput();

    await expect(app.create("target", "Unknown structured", input)).resolves.toEqual({
      sessionId: "session", created: true, sent: false, definitive: false
    });
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const recovered = drafts.composer.readSync(identity)!;
    drafts.composer.save(identity, {
      text: `${recovered.text}\n\nKeep this newer draft`,
      mentions: recovered.mentions,
      atoms: recovered.atoms,
      slashCommands: recovered.slashCommands,
      attachments: recovered.attachments
    });
    vi.mocked(network.getOperation).mockImplementation(async (_credential, operationId) => create(OperationSchema, {
      operationId,
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED,
      result: { payload: { case: "queueItem", value: create(QueueItemSchema, {
        queueItemId: "confirmed-structured-first-message",
        backendId: "backend",
        targetId: "target",
        sessionId: "session",
        state: QueueItemState.ACCEPTED
      }) } }
    }));

    await app.reconcile();

    expect(drafts.composer.readSync(identity)).toEqual(plainTextMobileComposerDraft("Keep this newer draft"));
    expect(drafts.newTask.readSync({ profileId: credential.profileId })).toBeNull();
    expect(saved.pending()).toEqual([]);
    expect(network.submit).toHaveBeenCalledTimes(2);
  });

  it("retires a late task navigation read in the background and restores the selected task on foreground", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    await app.select(undefined);
    let resolve!: (value: typeof snapshot) => void;
    vi.mocked(network.readSession).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const selecting = app.select("session");
    await vi.waitFor(() => expect(network.readSession).toHaveBeenCalledTimes(2));
    app.setForeground(false);
    resolve(snapshot);
    await selecting;
    expect(app.state.detail).toBeUndefined();
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.detail?.sessions[0]?.sessionId).toBe("session"));
    expect(app.state.status).toBe("connected");
  });

  it("uses authoritative final message blocks over transient text and preserves other activity", () => {
    const events = [
      create(EventSchema, { eventId: "start", cursor: { sequence: 1n }, payload: { kind: { case: "messageStarted", value: {
        messageId: "message", role: MessageRole.ASSISTANT
      } } } }),
      create(EventSchema, { eventId: "delta", cursor: { sequence: 2n }, payload: { kind: { case: "textDelta", value: {
        messageId: "message", delta: "partial"
      } } } }),
      create(EventSchema, { eventId: "done", cursor: { sequence: 3n }, payload: { kind: { case: "messageCompleted", value: {
        messageId: "message", role: MessageRole.ASSISTANT, blocks: [{ content: { case: "text", value: "final" } }]
      } } } }),
      create(EventSchema, { eventId: "status", cursor: { sequence: 4n }, payload: { kind: { case: "runAborted", value: { runId: "run" } } } })
    ];
    expect(timelineRows([...events, events[2]!])).toMatchObject([
      { id: "message", label: "Assistant", text: "final" },
      { id: "status", label: "Activity", text: "run Aborted" }
    ]);
  });

  it("keeps accepted typed user input canonical and does not elevate untrusted imported references", () => {
    const draft = insertMobileSessionMention(
      plainTextMobileComposerDraft("Use "),
      { start: 4, end: 4 },
      { sessionId: "related", displayText: "Earlier task" },
      "mention"
    ).draft;
    const events = [
      create(EventSchema, { eventId: "accepted-start", cursor: { sequence: 1n }, payload: { kind: { case: "messageStarted", value: {
        messageId: "accepted", role: MessageRole.USER, userInputAccepted: true, userInput: mobileComposerInput(draft)
      } } } }),
      create(EventSchema, { eventId: "accepted-done", cursor: { sequence: 2n }, payload: { kind: { case: "messageCompleted", value: {
        messageId: "accepted", role: MessageRole.USER, blocks: [{ content: { case: "text", value: "native echo" } }]
      } } } }),
      create(EventSchema, { eventId: "imported-start", cursor: { sequence: 3n }, payload: { kind: { case: "messageStarted", value: {
        messageId: "imported", role: MessageRole.USER, userInputAccepted: false,
        userInput: { parts: [
          { content: { case: "text", value: "Imported text" } },
          { content: { case: "sessionMention", value: { sessionId: "related", displayText: "Earlier task" } } }
        ] }
      } } } }),
      create(EventSchema, { eventId: "imported-done", cursor: { sequence: 4n }, payload: { kind: { case: "messageCompleted", value: {
        messageId: "imported", role: MessageRole.USER, blocks: [{ content: { case: "text", value: "native history" } }]
      } } } })
    ];

    expect(timelineRows(events)).toMatchObject([
      { id: "accepted", text: draft.text, completed: true },
      { id: "imported", text: "native history", completed: true }
    ]);
    expect(timelineRows([events[0]!])).toMatchObject([
      { id: "accepted", text: draft.text, completed: true }
    ]);
    expect(timelineRows([events[2]!])).toMatchObject([
      { id: "imported", text: "Imported text\n[Untrusted structured metadata ignored]", completed: false }
    ]);
  });

  it("anchors an exact session event and pages backward without mixing the latest window", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("e6", 6n), event("e7", 7n), event("e8", 8n)]);
    await app.around("e7");
    expect(network.readAround).toHaveBeenCalledWith(credential, "session", "e7", expect.any(AbortSignal));
    expect(app.state.window?.map((item) => item.eventId)).toEqual(["e6", "e7", "e8"]);
    vi.mocked(network.readHistory).mockResolvedValueOnce({ events: [event("e4", 4n), event("e5", 5n)],
      before: event("e4", 4n).cursor });
    await app.older();
    expect(network.readHistory).toHaveBeenCalledWith(credential, "session", event("e6", 6n).cursor, expect.any(AbortSignal));
    expect(app.state.window?.map((item) => item.eventId)).toEqual(["e4", "e5", "e6", "e7", "e8"]);
    vi.mocked(network.readHistory).mockResolvedValueOnce({ events: [event("e3", 3n)], before: event("e4", 4n).cursor });
    await expect(app.older()).rejects.toThrow(/cyclic/);
    app.latest();
    expect(app.state.window).toBeUndefined();
  });

  it("retires an in-flight historic page when returning to the latest window", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("e7", 7n)]);
    await app.around("e7");
    let release!: (page: { events: Event[]; before?: Event["cursor"] }) => void;
    vi.mocked(network.readHistory).mockImplementationOnce(() => new Promise((done) => { release = done; }));
    const oldPage = app.older();
    app.latest();
    release({ events: [event("e5", 5n)], before: event("e5", 5n).cursor });
    await oldPage;
    expect(app.state.window).toBeUndefined();
    expect(app.state.older).toHaveLength(0);
  });

  it("rejects another task in an anchor and retires an old page after a background transition", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("foreign", 7n, "another-session")]);
    await expect(app.around("foreign")).rejects.toThrow(/mismatched/);
    let resolve!: (events: Event[]) => void;
    vi.mocked(network.readAround).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const anchor = app.around("e7");
    app.setForeground(false);
    resolve([event("e7", 7n)]);
    await anchor;
    expect(app.state.window).toBeUndefined();
    expect(app.state.liveStatus).toBe("paused");
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.status).toBe("connected"));
    expect(network.inspect).toHaveBeenCalledTimes(3);
  });

  it("merges only contiguous selected-task events and restores authoritative projections across gaps", async () => {
    const network = fakeNetwork();
    const emit = eventFeed(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    expect(app.state.liveStatus).toBe("verifying");
    emit(event("eleven", 11n));
    await vi.waitFor(() => expect(app.state.live.map((item) => item.eventId)).toEqual(["eleven"]));
    expect(app.state.liveStatus).toBe("streaming");
    emit(event("eleven-duplicate", 11n));
    emit(event("foreign", 12n, "another-session"));
    await vi.waitFor(() => expect(app.state.live).toHaveLength(1));
    emit(event("gap", 14n));
    await vi.waitFor(() => expect(network.inspect).toHaveBeenCalledTimes(2));
    expect(app.state.live).toHaveLength(0);
    expect(vi.mocked(network.streamOwner).mock.calls[0]?.[1]).toMatchObject({ sequence: 10n, generation: 1n });
  });

  it("replaces transient message deltas with final Snapshot content without replaying the input", async () => {
    const network = fakeNetwork();
    const emit = eventFeed(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const started = create(EventSchema, { eventId: "start", identity: { sessionId: "session" },
      cursor: { opaqueToken: "cursor-11", sequence: 11n, generation: 1n }, payload: { kind: { case: "messageStarted", value: {
      messageId: "assistant-message", role: MessageRole.ASSISTANT
    } } } });
    const delta = create(EventSchema, { eventId: "delta", identity: { sessionId: "session" },
      cursor: { opaqueToken: "cursor-12", sequence: 12n, generation: 1n }, payload: { kind: { case: "textDelta", value: {
      messageId: "assistant-message", delta: "partial"
    } } } });
    const completed = create(EventSchema, { eventId: "completed", identity: { sessionId: "session" },
      cursor: { opaqueToken: "cursor-13", sequence: 13n, generation: 1n }, payload: { kind: { case: "messageCompleted", value: {
      messageId: "assistant-message", role: MessageRole.ASSISTANT, blocks: [{ content: { case: "text", value: "final" } }]
    } } } });
    const current = create(SnapshotSchema, { ...snapshot,
      resumeCursor: create(EventCursorSchema, { opaqueToken: "cursor-13", sequence: 13n, generation: 1n }), timeline: [started, delta, completed] });
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: current });
    vi.mocked(network.readSession).mockResolvedValue(current);
    emit(started); emit(delta); emit(completed);
    await vi.waitFor(() => expect(app.state.detail?.timeline.map((item) => item.eventId)).toEqual(["start", "delta", "completed"]));
    expect(app.state.live).toHaveLength(0);
    expect(timelineRows([...(app.state.detail?.timeline ?? []), ...app.state.live])).toMatchObject([
      { id: "assistant-message", text: "final", eventId: "completed", completed: true }
    ]);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("releases the previous stream in background and resumes from a fresh generation without retaining history", async () => {
    const network = fakeNetwork();
    const emit = eventFeed(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("e7", 7n)]);
    await app.around("e7");
    const firstSignal = vi.mocked(network.streamOwner).mock.calls[0]?.[2];
    app.setForeground(false);
    expect(firstSignal?.aborted).toBe(true);
    expect(app.state.window).toBeUndefined();
    expect(app.state.older).toHaveLength(0);
    const restarted = create(SnapshotSchema, { ...snapshot, generation: 2n,
      resumeCursor: create(EventCursorSchema, { opaqueToken: "generation-2", sequence: 1n, generation: 2n }), timeline: [] });
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: restarted });
    vi.mocked(network.readSession).mockResolvedValue(restarted);
    app.setForeground(true);
    await vi.waitFor(() => expect(app.state.owner?.generation).toBe(2n));
    expect(app.state.window).toBeUndefined();
    expect(app.state.live).toHaveLength(0);
    expect(vi.mocked(network.streamOwner).mock.calls[1]?.[1]).toMatchObject({ generation: 2n, sequence: 1n });
    emit(event("old", 11n));
    await vi.waitFor(() => expect(network.inspect).toHaveBeenCalledTimes(3));
    expect(app.state.live).toHaveLength(0);
  });

  it("drops a historic window when a contiguous event changes its visible history", async () => {
    const network = fakeNetwork();
    const emit = eventFeed(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.readAround).mockResolvedValueOnce([event("e7", 7n)]);
    await app.around("e7");
    emit(create(EventSchema, { eventId: "deleted", identity: { sessionId: "session" },
      cursor: { opaqueToken: "cursor-11", sequence: 11n, generation: 1n }, payload: { kind: { case: "messageDeleted", value: {
      productSessionId: "session", requestedEventId: "e7", deletedEventIds: ["e7"]
    } } } }));
    await vi.waitFor(() => expect(app.state.window).toBeUndefined());
    expect(app.state.older).toHaveLength(0);
  });

  it("exposes a degraded polling state when the native stream fails without treating it as live", async () => {
    const network = fakeNetwork();
    network.streamOwner = vi.fn(async function* () { throw new Error("stream transport unavailable"); });
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await vi.waitFor(() => expect(app.state.liveStatus).toBe("polling"));
    expect(app.state.status).toBe("connected");
    expect(app.state.live).toHaveLength(0);
  });
});

describe("mobile Home search and task mutations", () => {
  it("retires late message-search results when query or owner changes", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    let resolveOld!: (value: readonly SessionMessageSearchMatch[]) => void;
    vi.mocked(network.searchSessionMessages)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValueOnce([create(SessionMessageSearchMatchSchema, { sessionId: "session", eventId: "event-new" })]);

    const oldSearch = app.searchHome("old words", "active");
    await vi.waitFor(() => expect(app.state.homeSearchStatus).toBe("searching"));
    await app.searchHome("new words", "all");
    expect(network.searchSessionMessages).toHaveBeenLastCalledWith(
      credential, "new words", SessionMessageSearchSessionStatus.UNSPECIFIED, expect.any(AbortSignal)
    );
    expect(app.state).toMatchObject({
      homeSearchQuery: "new words",
      homeSearchFilter: "all",
      homeSearchStatus: "ready",
      homeSearchSessionIds: ["session"]
    });
    resolveOld([create(SessionMessageSearchMatchSchema, { sessionId: "session", eventId: "event-old" })]);
    await oldSearch;
    expect(app.state.homeSearchQuery).toBe("new words");

    let resolveOwnerSearch!: (value: readonly SessionMessageSearchMatch[]) => void;
    vi.mocked(network.searchSessionMessages).mockImplementationOnce(() => new Promise((resolve) => { resolveOwnerSearch = resolve; }));
    const ownerSearch = app.searchHome("owner", "active");
    await vi.waitFor(() => expect(app.state.homeSearchStatus).toBe("searching"));
    await app.refresh();
    resolveOwnerSearch([create(SessionMessageSearchMatchSchema, { sessionId: "session", eventId: "late" })]);
    await ownerSearch;
    expect(app.state.homeSearchSessionIds).toEqual([]);
    expect(app.state.homeSearchStatus).toBe("idle");

    let resolveClearedSearch!: (value: readonly SessionMessageSearchMatch[]) => void;
    vi.mocked(network.searchSessionMessages).mockImplementationOnce(() => new Promise((resolve) => { resolveClearedSearch = resolve; }));
    const clearedSearch = app.searchHome("clear me", "archived");
    await vi.waitFor(() => expect(app.state.homeSearchStatus).toBe("searching"));
    const clearedSignal = vi.mocked(network.searchSessionMessages).mock.calls.at(-1)?.[3];
    await app.searchHome("", "archived");
    expect(clearedSignal?.aborted).toBe(true);
    expect(app.state).toMatchObject({
      homeSearchQuery: "",
      homeSearchFilter: "archived",
      homeSearchStatus: "idle",
      homeSearchSessionIds: []
    });
    resolveClearedSearch([create(SessionMessageSearchMatchSchema, { sessionId: "session", eventId: "cleared" })]);
    await clearedSearch;
    expect(app.state.homeSearchSessionIds).toEqual([]);
  });

  it("submits every task action with the exact current Session revision", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();

    await expect(app.renameSession("session", "Renamed")).resolves.toBe(true);
    await expect(app.setSessionPinned("session", true)).resolves.toBe(true);
    await expect(app.setSessionArchived("session", true)).resolves.toBe(true);
    await expect(app.deleteSession("session")).resolves.toBe(true);

    const mutations = vi.mocked(network.submit).mock.calls.map((call) => call[2]);
    expect(mutations.map((mutation) => mutation.payload.case)).toEqual([
      "renameSession", "pinSession", "archiveSession", "deleteSession"
    ]);
    for (const mutation of mutations) {
      expect(mutation.preconditions).toHaveLength(1);
      expect(mutation.preconditions[0]?.entity).toMatchObject({ kind: EntityKind.SESSION, id: "session" });
      expect(mutation.preconditions[0]?.expectedRevision?.value).toBe(9n);
    }
    expect(saved.pending()).toEqual([]);
  });

  it("persists an unknown task action before dispatch and never resends it", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));

    await expect(app.setSessionPinned("session", true)).resolves.toBe(false);
    expect(saved.storage.savePending).toHaveBeenCalledBefore(network.submit as ReturnType<typeof vi.fn>);
    expect(app.state.pending).toMatchObject([{ kind: "pin", sessionId: "session", state: "unknown" }]);
    await expect(app.setSessionPinned("session", true)).rejects.toThrow(/still pending/);
    expect(network.submit).toHaveBeenCalledTimes(1);
  });

  it("keeps the authoritative task unchanged and exposes a conflict", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "operation-1",
      connectionId: credential.connectionId,
      state: OperationState.CONFLICT,
      error: { code: "REVISION_CONFLICT", message: "The task changed on another client." }
    }));

    await expect(app.renameSession("session", "Rejected name")).resolves.toBe(false);

    expect(app.state.owner?.sessions.find((item) => item.sessionId === "session")?.displayName).toBe("Task");
    expect(app.state.error).toBe("The task changed on another client.");
    expect(saved.pending()).toEqual([]);
    expect(network.readOwner).toHaveBeenCalledTimes(2);
  });
});

describe("native current-task message and Queue actions", () => {
  const ids = () => {
    let value = 0;
    return () => `mobile-id-${++value}`;
  };

  const sessionMentionDraft = () => {
    const text = "Compare 👋 ";
    return insertMobileSessionMention(
      plainTextMobileComposerDraft(text),
      { start: text.length, end: text.length },
      { sessionId: "related", displayText: "Earlier task" },
      "mention-occurrence-1"
    ).draft;
  };

  const workspaceMentionDraft = () => {
    const text = "Inspect 😀 ";
    const file = insertMobileWorkspaceMention(
      plainTextMobileComposerDraft(text),
      { start: text.length, end: text.length },
      {
        workspaceId: "workspace", relativePath: "src/main.ts", displayText: "main.ts", directory: false,
        lineRange: { startLine: 7, endLine: 12 }
      },
      "workspace-occurrence-1"
    );
    return insertMobileWorkspaceMention(
      file.draft,
      file.selection,
      { workspaceId: "workspace", relativePath: "src", displayText: "src", directory: true },
      "workspace-occurrence-2"
    ).draft;
  };

  const catalogMentionDraft = () => {
    const text = "Use 😀 ";
    const resource = insertMobileResourceMention(
      plainTextMobileComposerDraft(text),
      { start: text.length, end: text.length },
      {
        resourceId: catalogMentionResource.resourceId,
        displayText: catalogMentionResource.name,
        discoveredRevision: catalogMentionResource.discoveredRevision,
        resourceVersion: catalogMentionResource.resourceVersion.toString(10),
        runtimeGeneration: catalogMentionResource.runtimeGeneration.toString(10)
      },
      "resource-occurrence-1"
    );
    return insertMobileArtifactMention(
      resource.draft,
      resource.selection,
      {
        artifactId: catalogMentionArtifact.artifactId,
        sourceSessionId: catalogMentionArtifact.sessionId,
        displayText: catalogMentionArtifact.title
      },
      "artifact-occurrence-1"
    ).draft;
  };

  function configureWorkspaceMentionDirectories(network: MobileNetwork): void {
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, workspaceId, parentPath) => ({
      entries: workspaceId !== "workspace" ? []
        : parentPath === "" ? [workspaceMentionDirectory]
        : parentPath === "src" ? [workspaceMentionFile]
        : [],
      revision: `directory:${parentPath || "root"}`
    }));
    vi.mocked(network.listWorkspaceFileIndex).mockResolvedValue({
      paths: ["src/main.ts"], revision: "index-r1", truncated: false
    });
  }

  function configureCatalogMentions(network: MobileNetwork): void {
    vi.mocked(network.listSessionResources).mockResolvedValue([catalogMentionResource]);
    vi.mocked(network.listArtifactReferenceCatalog).mockResolvedValue({
      artifacts: [catalogMentionArtifact], revision: "artifact-references-r1"
    });
  }

  it("uploads current-task attachments in order, persists each Blob before local deletion, and sends attachment-only input", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const persistedBeforeRemove: boolean[] = [];
    const fixture = attachmentFileFixture((attachmentId) => {
      const attachment = drafts.composer.readSync(identity)?.attachments
        .find((candidate) => candidate.attachmentId === attachmentId);
      persistedBeforeRemove.push(attachment?.state === "uploaded");
    });
    const draft = localAttachmentDraft();
    vi.mocked(network.uploadBlob).mockImplementation(async (_credential, source) => committedAttachment(
      draft.attachments.find((attachment) => attachment.fileName === source.fileName) as MobileLocalComposerAttachment
    ));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      ids(), undefined, drafts, fixture.files);
    await app.start();

    expect(app.taskAttachmentControls()).toMatchObject({
      profileId: credential.profileId,
      policy: { images: true, files: true, maximumItems: 4, maximumBytes: 1_024 }
    });
    await expect(app.send(draft)).resolves.toBe(true);

    expect(vi.mocked(network.uploadBlob).mock.calls.map((call) => call[1].fileName))
      .toEqual(["pixel.png", "proof.pdf"]);
    expect(persistedBeforeRemove).toEqual([true, true]);
    expect(fixture.removed).toEqual(["image-one", "file-one"]);
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{ expectedGeneration: 8n }],
      payload: { case: "sendInput", value: { input: { parts: [
        { content: { case: "image", value: { blob: { blobId: "blob-image-one" } } } },
        { content: { case: "file", value: { blobId: "blob-file-one" } } }
      ] } } }
    });
    expect(vi.mocked(network.uploadBlob).mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(network.submit).mock.invocationCallOrder[0]!);
    expect(drafts.composer.readSync(identity)).toBeNull();
  });

  it("retains an annotation source through upload and removes it only after the exact task draft is accepted and cleared", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const fixture = attachmentFileFixture();
    fixture.bytes.set("image-source", new Uint8Array([1, 1, 1, 1]));
    const draft = annotatedLocalImageDraft();
    vi.mocked(network.uploadBlob).mockImplementation(async () => committedAttachment(
      draft.attachments[0] as MobileLocalComposerAttachment
    ));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      ids(), undefined, drafts, fixture.files);
    await app.start();

    await expect(app.send(draft)).resolves.toBe(true);

    expect(drafts.composer.readSync(identity)).toBeNull();
    expect(fixture.removed).toEqual(["image-one", "image-source"]);
    expect(fixture.bytes.has("image-source")).toBe(false);
  });

  it("retains an uploaded annotation source while the task send result is unknown", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const fixture = attachmentFileFixture();
    fixture.bytes.set("image-source", new Uint8Array([1, 1, 1, 1]));
    const draft = annotatedLocalImageDraft("Review");
    vi.mocked(network.uploadBlob).mockImplementation(async () => committedAttachment(
      draft.attachments[0] as MobileLocalComposerAttachment
    ));
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      ids(), undefined, drafts, fixture.files);
    await app.start();

    await expect(app.send(draft)).resolves.toBe(false);

    expect(drafts.composer.readSync(identity)?.attachments[0]).toMatchObject({
      state: "uploaded",
      blobId: "blob-image-one",
      annotation: { source: { storageId: "image-source" } }
    });
    expect(fixture.removed).toEqual(["image-one"]);
    expect(fixture.bytes.has("image-source")).toBe(true);
  });

  it("retains canonical uploaded attachment identities and body-free receipt when current send is unknown", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const saved = memoryStorage(credential);
    const drafts = memoryDraftStores();
    const fixture = attachmentFileFixture();
    const draft = localAttachmentDraft("Review");
    vi.mocked(network.uploadBlob).mockImplementation(async (_credential, source) => committedAttachment(
      draft.attachments.find((attachment) => attachment.fileName === source.fileName) as MobileLocalComposerAttachment
    ));
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
    const app = client(network, saved.storage, undefined, undefined, ids(), undefined, drafts, fixture.files);
    await app.start();

    await expect(app.send(draft)).resolves.toBe(false);

    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" }))
      .toMatchObject({ attachments: [
        { attachmentId: "image-one", state: "uploaded", blobId: "blob-image-one" },
        { attachmentId: "file-one", state: "uploaded", blobId: "blob-file-one" }
      ] });
    expect(fixture.removed).toEqual(["image-one", "file-one"]);
    expect(saved.pending()).toMatchObject([{ kind: "send", sessionId: "session", state: "unknown" }]);
    expect(JSON.stringify(saved.pending())).not.toContain("pixel.png");
    expect(JSON.stringify(saved.pending())).not.toContain("blob-image-one");
  });

  it("does not overwrite a newer current-task draft or delete staged bytes after an upload CAS conflict", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const drafts = memoryDraftStores();
    const fixture = attachmentFileFixture();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const draft = localAttachmentDraft("Original");
    vi.mocked(network.uploadBlob).mockImplementationOnce(async () => {
      drafts.composer.save(identity, plainTextMobileComposerDraft("Newer navigation draft"));
      return committedAttachment(draft.attachments[0] as MobileLocalComposerAttachment);
    });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      ids(), undefined, drafts, fixture.files);
    await app.start();

    await expect(app.send(draft)).rejects.toThrow(/changed while an attachment was uploading/u);

    expect(network.submit).not.toHaveBeenCalled();
    expect(fixture.removed).toEqual([]);
    expect(drafts.composer.readSync(identity)).toEqual(plainTextMobileComposerDraft("Newer navigation draft"));
  });

  it("commits an image annotation into the exact task slot and restores its isolated original on re-edit", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const original = localAttachmentDraft("Keep the caption");
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("image-source", "editor-one", "rendered-image", "editor-two", "restored-image"),
      undefined, drafts, fixture.files);
    await app.start();

    const editor = await app.openComposerImageEditor({ surface: "task", attachmentId: "image-one" });
    expect(editor).toMatchObject({
      previewUri: "file:///durable/mobile-profile/image-one",
      sourceBase64: "AQEBAQ==",
      sourceMediaType: "image/png",
      fileName: "pixel.png",
      initialStrokes: [],
      annotatable: true,
      maximumBytes: 1_024
    });
    const stroke = { points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.7 }] };
    const committed = await app.commitComposerImageEditor(editor.leaseId, [stroke], {
      bytes: renderedPngBytes,
      mediaType: "image/png",
      width: 320,
      height: 240
    });

    expect(committed.surface).toBe("task");
    expect(committed.draft).toMatchObject({
      text: "Keep the caption",
      attachments: [
        {
          state: "local",
          attachmentId: "rendered-image",
          fileName: "pixel-annotated.png",
          mediaType: "image/png",
          byteSize: renderedPngBytes.byteLength,
          sha256Hex: "b".repeat(64),
          annotation: {
            source: {
              storageId: "image-source",
              fileName: "pixel.png",
              mediaType: "image/png",
              byteSize: 4,
              sha256Hex: "a".repeat(64)
            },
            strokes: [stroke]
          }
        },
        original.attachments[1]
      ]
    });
    expect(await drafts.composer.read(identity)).toEqual(committed.draft);
    expect(fixture.bytes.get("image-source")).toEqual(new Uint8Array([1, 1, 1, 1]));
    expect(fixture.bytes.get("rendered-image")).toEqual(renderedPngBytes);
    expect(fixture.removed).toEqual(["image-one"]);
    expect(network.submit).not.toHaveBeenCalled();
    expect(network.uploadBlob).not.toHaveBeenCalled();

    const reopened = await app.openComposerImageEditor({ surface: "task", attachmentId: "rendered-image" });
    expect(reopened.initialStrokes).toEqual([stroke]);
    expect(reopened.previewUri).toBe("file:///durable/mobile-profile/image-source");
    const restored = await app.commitComposerImageEditor(reopened.leaseId, []);

    expect(restored.draft.attachments).toMatchObject([
      {
        state: "local",
        attachmentId: "restored-image",
        fileName: "pixel.png",
        mediaType: "image/png",
        byteSize: 4,
        sha256Hex: "a".repeat(64)
      },
      original.attachments[1]
    ]);
    expect(restored.draft.attachments[0]?.annotation).toBeUndefined();
    expect(fixture.bytes.has("image-source")).toBe(false);
    expect(fixture.bytes.get("restored-image")).toEqual(new Uint8Array([1, 1, 1, 1]));
    expect(fixture.removed).toEqual(["image-one", "rendered-image", "image-source"]);
  });

  it("revalidates the exact editor source and native static decode before image output", async () => {
    const bytes = galleryPngBytes(6, 4);
    const original = localAttachmentDraft("Keep the draft untouched");
    const image = original.attachments[0]!;
    const draft = {
      ...original,
      attachments: [{ ...image, byteSize: bytes.byteLength, sha256Hex: "b".repeat(64) }, original.attachments[1]!]
    };
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(identity, draft);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    fixture.bytes.set("image-one", bytes);
    const network = projectedNetwork(attachmentSnapshot);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("output-source", "output-editor"), undefined, drafts, fixture.files);
    await app.start();
    const editor = await app.openComposerImageEditor({ surface: "task", attachmentId: "image-one" });

    await expect(app.prepareImageOutput(editor.leaseId, {
      width: 6, height: 4, mediaType: "image/png"
    })).rejects.toThrow(/matching static raster/u);
    await expect(app.prepareImageOutput(editor.leaseId, {
      width: 5, height: 4, mediaType: "image/png", isAnimated: false
    })).rejects.toThrow(/native decoder dimensions/u);
    const output = await app.prepareImageOutput(editor.leaseId, {
      width: 6, height: 4, mediaType: null, isAnimated: false
    });

    expect(output).toMatchObject({
      leaseId: editor.leaseId,
      fileName: "pixel.png",
      mediaType: "image/png",
      byteSize: bytes.byteLength,
      sha256Hex: "b".repeat(64),
      width: 6,
      height: 4
    });
    expect(output.bytes).toEqual(bytes);
    expect(await drafts.composer.read(identity)).toEqual(draft);
    expect(network.submit).not.toHaveBeenCalled();
    expect(network.uploadBlob).not.toHaveBeenCalled();
  });

  it("single-flights duplicate image saves while keeping the exact editor lease retryable", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const original = localAttachmentDraft("Keep one result");
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const originalStageBytes = vi.mocked(fixture.driver.stageBytes).getMockImplementation()!;
    let releaseSource!: () => void;
    const sourceGate = new Promise<void>((resolve) => { releaseSource = resolve; });
    vi.mocked(fixture.driver.stageBytes).mockImplementation(async (...args) => {
      if (args[1] === "single-source") await sourceGate;
      return originalStageBytes(...args);
    });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("single-source", "single-editor", "single-output"), undefined, drafts, fixture.files);
    await app.start();
    const editor = await app.openComposerImageEditor({ surface: "task", attachmentId: "image-one" });
    const stroke = [{ points: [{ x: 0.25, y: 0.5 }] }];

    const first = app.commitComposerImageEditor(editor.leaseId, stroke, {
      bytes: renderedPngBytes, mediaType: "image/png", width: 20, height: 20
    });
    await vi.waitFor(() => expect(fixture.driver.stageBytes).toHaveBeenCalledWith(
      credential.profileId, "single-source", expect.any(Uint8Array)
    ));
    await expect(app.commitComposerImageEditor(editor.leaseId, stroke, {
      bytes: renderedPngBytes, mediaType: "image/png", width: 20, height: 20
    })).rejects.toThrow(/already being saved/u);
    releaseSource();
    await expect(first).resolves.toMatchObject({ draft: { attachments: [
      expect.objectContaining({ attachmentId: "single-output" }),
      original.attachments[1]
    ] } });
  });

  it("rejects an invalid rendered raster before staging and allows a corrected retry", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const original = localAttachmentDraft("Retry the render");
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("retry-source", "retry-editor", "retry-output"), undefined, drafts, fixture.files);
    await app.start();
    const editor = await app.openComposerImageEditor({ surface: "task", attachmentId: "image-one" });
    const strokes = [{ points: [{ x: 0.25, y: 0.5 }] }];

    await expect(app.commitComposerImageEditor(editor.leaseId, strokes, {
      bytes: new Uint8Array([2, 2, 2, 2]), mediaType: "image/png", width: 20, height: 20
    })).rejects.toThrow(/rendered annotation output is invalid/u);
    expect(fixture.driver.stageBytes).not.toHaveBeenCalled();
    await expect(app.commitComposerImageEditor(editor.leaseId, strokes, {
      bytes: renderedPngBytes, mediaType: "image/png", width: 20, height: 20
    })).resolves.toMatchObject({ draft: { attachments: [
      expect.objectContaining({ attachmentId: "retry-output" }),
      original.attachments[1]
    ] } });
  });

  it("restores the exact task draft and cleans new bytes when durable annotation flush fails", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const original = localAttachmentDraft("Keep after storage failure");
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("failed-source", "failed-editor", "failed-output"), undefined, drafts, fixture.files);
    await app.start();
    const editor = await app.openComposerImageEditor({ surface: "task", attachmentId: "image-one" });
    vi.spyOn(drafts.composer.driver, "setItem").mockRejectedValueOnce(new Error("disk unavailable"));

    await expect(app.commitComposerImageEditor(editor.leaseId, [{ points: [{ x: 0.2, y: 0.4 }] }], {
      bytes: renderedPngBytes, mediaType: "image/png", width: 20, height: 20
    })).rejects.toThrow(/could not be written/u);

    expect(await drafts.composer.read(identity)).toEqual(original);
    expect(fixture.removed).toEqual(["failed-output", "failed-source"]);
    expect(fixture.bytes.has("image-one")).toBe(true);
    expect(fixture.bytes.has("failed-output")).toBe(false);
    expect(fixture.bytes.has("failed-source")).toBe(false);
  });

  it("rejects a stale image editor without staging or replacing a concurrently changed task draft", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const original = localAttachmentDraft("Original");
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("stale-source", "stale-editor", "must-not-stage"), undefined, drafts, fixture.files);
    await app.start();
    const editor = await app.openComposerImageEditor({ surface: "task", attachmentId: "image-one" });
    const newer = plainTextMobileComposerDraft("Concurrent navigation draft");
    drafts.composer.save(identity, newer);
    await drafts.composer.flush(identity);

    await expect(app.commitComposerImageEditor(editor.leaseId, [{ points: [{ x: 0.2, y: 0.3 }] }], {
      bytes: renderedPngBytes,
      mediaType: "image/png",
      width: 20,
      height: 20
    })).rejects.toThrow(/composer changed/u);

    expect(await drafts.composer.read(identity)).toEqual(newer);
    expect(fixture.driver.stageBytes).not.toHaveBeenCalled();
    expect(fixture.removed).toEqual([]);
    expect(network.submit).not.toHaveBeenCalled();
    app.cancelComposerImageEditor(editor.leaseId);
  });

  it("CAS-commits a new-task image annotation without creating or sending the task", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId };
    const original = localAttachmentDraft("First input");
    drafts.newTask.save(identity, { targetId: "target", name: "Annotated task", input: original });
    await drafts.newTask.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("new-source", "new-editor", "new-rendered"), undefined, drafts, fixture.files);
    await app.start();

    const editor = await app.openComposerImageEditor({
      surface: "new-task",
      targetId: "target",
      attachmentId: "image-one"
    });
    const result = await app.commitComposerImageEditor(editor.leaseId, [{ points: [{ x: 0.5, y: 0.5 }] }], {
      bytes: renderedPngBytes,
      mediaType: "image/png",
      width: 64,
      height: 64
    });

    expect(result.surface).toBe("new-task");
    const retained = drafts.newTask.readSync(identity);
    expect(retained).toMatchObject({
      targetId: "target",
      name: "Annotated task"
    });
    expect(retained?.input.attachments[0]).toMatchObject({
      attachmentId: "new-rendered",
      annotation: { source: { storageId: "new-source" } }
    });
    expect(network.prepareTarget).not.toHaveBeenCalled();
    expect(network.submit).not.toHaveBeenCalled();
    expect(network.uploadBlob).not.toHaveBeenCalled();
  });

  it("authenticates an uploaded image into an editor lease and retires the lease on backgrounding", async () => {
    const network = projectedNetwork(attachmentSnapshot);
    vi.mocked(network.downloadBlob).mockResolvedValue({
      bytes: new Uint8Array([1, 1, 1, 1]),
      mediaType: "image/png"
    });
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const uploaded: MobileComposerDraft = {
      ...plainTextMobileComposerDraft("Uploaded"),
      attachments: [{
        state: "uploaded",
        attachmentId: "uploaded-image",
        blobId: "blob-uploaded-image",
        kind: "image",
        fileName: "pixel.png",
        mediaType: "image/png",
        byteSize: 4,
        sha256Hex: "a".repeat(64),
        capturedAtUnixMs: 100
      }]
    };
    drafts.composer.save(identity, uploaded);
    await drafts.composer.flush(identity);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("uploaded-source", "uploaded-editor"), undefined, drafts, attachmentFileFixture().files);
    await app.start();

    const editor = await app.openComposerImageEditor({ surface: "task", attachmentId: "uploaded-image" });
    expect(editor.previewUri).toBe("data:image/png;base64,AQEBAQ==");
    expect(network.downloadBlob).toHaveBeenCalledWith(credential, expect.objectContaining({
      blobId: "blob-uploaded-image",
      disposition: BlobDisposition.ATTACHMENT
    }), undefined);
    app.setForeground(false);
    await expect(app.commitComposerImageEditor(editor.leaseId, []))
      .rejects.toThrow(/no longer owns/u);
    expect(await drafts.composer.read(identity)).toEqual(uploaded);
  });

  it("sends a retained Session reference with exact UTF-16 range and body-free receipt", async () => {
    const network = projectedNetwork(sessionMentionSnapshot);
    const saved = memoryStorage(credential);
    const drafts = memoryDraftStores();
    const app = client(network, saved.storage, undefined, undefined, ids(), undefined, drafts);
    await app.start();
    const draft = sessionMentionDraft();

    expect(app.taskSessionMentionControls()?.candidates).toEqual([{
      sessionId: "related", displayText: "Earlier task", state: SessionState.IDLE
    }]);
    await expect(app.send(draft)).resolves.toBe(true);

    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.SESSION, id: "session" },
        expectedGeneration: 8n
      }],
      payload: { case: "sendInput", value: {
        sessionId: "session",
        input: {
          parts: [
            { content: { case: "text", value: draft.text } },
            { content: { case: "sessionMention", value: {
              sessionId: "related", displayText: "Earlier task"
            } } }
          ],
          mentionRanges: [{
            start: draft.mentions[0]!.start,
            end: draft.mentions[0]!.end,
            mentionIndex: 0
          }]
        }
      } }
    });
    expect(JSON.stringify(saved.pending())).not.toContain(draft.text);
    expect(JSON.stringify(saved.pending())).not.toContain("Earlier task");
  });

  it("retains a structured Session-reference draft and a body-free receipt when send is unknown", async () => {
    const network = projectedNetwork(sessionMentionSnapshot);
    const saved = memoryStorage(credential);
    const drafts = memoryDraftStores();
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
    const app = client(network, saved.storage, undefined, undefined, ids(), undefined, drafts);
    await app.start();
    const draft = sessionMentionDraft();

    await expect(app.send(draft)).resolves.toBe(false);

    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toEqual(draft);
    expect(saved.pending()).toMatchObject([{ kind: "send", sessionId: "session", state: "unknown" }]);
    expect(JSON.stringify(saved.pending())).not.toContain(draft.text);
    expect(JSON.stringify(saved.pending())).not.toContain("related");
  });

  it("retains a structured Session-reference draft after a definitive send rejection", async () => {
    const network = projectedNetwork(sessionMentionSnapshot);
    const drafts = memoryDraftStores();
    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "mobile-id-1",
      connectionId: credential.connectionId,
      state: OperationState.CONFLICT,
      error: { code: "GENERATION_CONFLICT", message: "The task runtime changed." }
    }));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids(), undefined, drafts);
    await app.start();
    const draft = sessionMentionDraft();

    await expect(app.send(draft)).resolves.toBe(false);

    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toEqual(draft);
    expect(app.state.error).toMatch(/runtime changed/);
  });

  it("revalidates a referenced Session after durable draft flush and never dispatches a retired source", async () => {
    const network = projectedNetwork(sessionMentionSnapshot);
    const drafts = memoryDraftStores();
    const retired = create(SnapshotSchema, {
      ...sessionMentionSnapshot,
      sessions: [sessionMentionSnapshot.sessions[0]!]
    });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids(), undefined, drafts);
    await app.start();
    const flush = drafts.composer.flush.bind(drafts.composer);
    vi.spyOn(drafts.composer, "flush").mockImplementationOnce(async (identity) => {
      await flush(identity);
      vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: retired });
      vi.mocked(network.readSession).mockResolvedValue(retired);
      await app.refresh();
    });
    const draft = sessionMentionDraft();

    await expect(app.send(draft)).rejects.toThrow(/no longer available/);

    expect(network.submit).not.toHaveBeenCalled();
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toEqual(draft);
  });

  it("revalidates the exact Target authority after durable structured-draft flush", async () => {
    const network = projectedNetwork(sessionMentionSnapshot);
    const drafts = memoryDraftStores();
    const changed = create(SnapshotSchema, {
      ...sessionMentionSnapshot,
      targets: [create(TargetSchema, {
        ...sessionMentionSnapshot.targets[0]!,
        version: create(EntityVersionSchema, {
          revision: create(RevisionSchema, { value: 4n, etag: "target-r4" })
        })
      })]
    });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids(), undefined, drafts);
    await app.start();
    const flush = drafts.composer.flush.bind(drafts.composer);
    vi.spyOn(drafts.composer, "flush").mockImplementationOnce(async (identity) => {
      await flush(identity);
      vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: changed });
      vi.mocked(network.readSession).mockResolvedValue(changed);
      await app.refresh();
    });
    const draft = sessionMentionDraft();

    await expect(app.send(draft)).rejects.toThrow(/task changed/);

    expect(network.submit).not.toHaveBeenCalled();
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toEqual(draft);
  });

  it("loads Workspace reference candidates under the exact owner and never requests an index for directory-only policy", async () => {
    const network = projectedNetwork(workspaceMentionSnapshot);
    configureWorkspaceMentionDirectories(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const controls = app.taskWorkspaceMentionControls()!;

    await expect(app.listTaskWorkspaceMentionDirectory(controls.surfaceOwnerKey, "")).resolves.toMatchObject({
      parentPath: "", entries: [{ relativePath: "src", directory: true }]
    });
    await expect(app.listTaskWorkspaceMentionFileIndex(controls.surfaceOwnerKey)).resolves.toMatchObject({
      paths: ["src/main.ts"], revision: "index-r1"
    });

    const directoryOnly = create(SnapshotSchema, {
      ...workspaceMentionSnapshot,
      backends: [create(BackendDescriptorSchema, {
        ...workspaceMentionSnapshot.backends[0]!,
        capabilities: create(CapabilityManifestSchema, {
          ...workspaceMentionSnapshot.backends[0]!.capabilities!,
          capabilities: [
            create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
            create(CapabilitySchema, {
              name: capabilityNames.inputMention,
              support: CapabilitySupport.SUPPORTED,
              options: create(CapabilityOptionsSchema, {
                kind: { case: "input", value: create(InputCapabilityOptionsSchema, {
                  mediaTypes: ["workspace_directory"]
                }) }
              })
            })
          ]
        })
      })]
    });
    const directoryNetwork = projectedNetwork(directoryOnly);
    configureWorkspaceMentionDirectories(directoryNetwork);
    const directoryApp = client(directoryNetwork, memoryStorage(credential).storage);
    await directoryApp.start();
    const directoryControls = directoryApp.taskWorkspaceMentionControls()!;

    await expect(directoryApp.listTaskWorkspaceMentionDirectory(directoryControls.surfaceOwnerKey, ""))
      .resolves.toMatchObject({ entries: [{ relativePath: "src", directory: true }] });
    await expect(directoryApp.listTaskWorkspaceMentionFileIndex(directoryControls.surfaceOwnerKey))
      .rejects.toThrow(/does not support Workspace file references/u);
    expect(directoryNetwork.listWorkspaceFileIndex).not.toHaveBeenCalled();
  });

  it("sends current Workspace file, line, and directory occurrences with exact wire ranges and a body-free receipt", async () => {
    const network = projectedNetwork(workspaceMentionSnapshot);
    configureWorkspaceMentionDirectories(network);
    const saved = memoryStorage(credential);
    const drafts = memoryDraftStores();
    const app = client(network, saved.storage, undefined, undefined, ids(), undefined, drafts);
    await app.start();
    const draft = workspaceMentionDraft();

    await expect(app.send(draft)).resolves.toBe(true);

    expect(network.listWorkspaceDirectory).toHaveBeenCalledWith(
      credential, "workspace", "src", undefined
    );
    expect(network.listWorkspaceDirectory).toHaveBeenCalledWith(
      credential, "workspace", "", undefined
    );
    expect(vi.mocked(network.listWorkspaceDirectory).mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(network.submit).mock.invocationCallOrder[0]!);
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      payload: { case: "sendInput", value: {
        sessionId: "session",
        input: {
          parts: [
            { content: { case: "text", value: draft.text } },
            { content: { case: "workspaceMention", value: {
              workspaceId: "workspace", relativePath: "src/main.ts", displayText: "main.ts", directory: false,
              lineRange: { startLine: 7, endLine: 12 }
            } } },
            { content: { case: "workspaceMention", value: {
              workspaceId: "workspace", relativePath: "src", displayText: "src", directory: true
            } } }
          ],
          mentionRanges: [
            { start: draft.mentions[0]!.start, end: draft.mentions[0]!.end, mentionIndex: 0 },
            { start: draft.mentions[1]!.start, end: draft.mentions[1]!.end, mentionIndex: 1 }
          ]
        }
      } }
    });
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
    expect(JSON.stringify(saved.pending())).not.toContain(draft.text);
    expect(JSON.stringify(saved.pending())).not.toContain("src/main.ts");
  });

  it("retains a Workspace-reference draft and a body-free receipt for unknown and rejected sends", async () => {
    for (const outcome of ["unknown", "rejected"] as const) {
      const network = projectedNetwork(workspaceMentionSnapshot);
      configureWorkspaceMentionDirectories(network);
      const saved = memoryStorage(credential);
      const drafts = memoryDraftStores();
      if (outcome === "unknown") {
        vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
      } else {
        vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
          operationId: "mobile-id-1", connectionId: credential.connectionId, state: OperationState.CONFLICT,
          error: { code: "GENERATION_CONFLICT", message: "The task runtime changed." }
        }));
      }
      const app = client(network, saved.storage, undefined, undefined, ids(), undefined, drafts);
      await app.start();
      const draft = workspaceMentionDraft();

      await expect(app.send(draft)).resolves.toBe(false);

      expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toEqual(draft);
      expect(JSON.stringify(saved.pending())).not.toContain(draft.text);
      expect(JSON.stringify(saved.pending())).not.toContain("src/main.ts");
      if (outcome === "unknown") expect(saved.pending()).toMatchObject([{ kind: "send", state: "unknown" }]);
      else expect(saved.pending()).toEqual([]);
    }
  });

  it("revalidates a current-task path atom and dispatches no absolute path or typed metadata", async () => {
    const network = projectedNetwork(workspacePathSnapshot);
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, workspaceId, parentPath) => ({
      entries: workspaceId === "workspace" && parentPath === "src" ? [workspaceMentionFile] : [],
      revision: `directory:${parentPath || "root"}`
    }));
    const drafts = memoryDraftStores();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids(), undefined, drafts);
    await app.start();
    const controls = app.taskWorkspacePathPasteControls()!;
    await expect(app.validateTaskWorkspacePathPasteCandidates(
      controls.surfaceOwnerKey,
      ["src/main.ts", "src/missing.ts"]
    )).resolves.toEqual([{
      candidateRelativePath: "src/main.ts",
      relativePath: "src/main.ts",
      directory: false
    }]);
    const draft = workspacePathDraft();

    await expect(app.send(draft)).resolves.toBe(true);

    expect(network.listWorkspaceDirectory).toHaveBeenCalledWith(
      credential, "workspace", "src", expect.any(AbortSignal)
    );
    const mutation = vi.mocked(network.submit).mock.calls[0]?.[2];
    expect(mutation).toMatchObject({
      payload: { case: "sendInput", value: {
        sessionId: "session",
        input: {
          parts: [{ content: { case: "text", value: "Open @src/main.ts" } }],
          mentionRanges: [],
          pastedTextRanges: []
        }
      } }
    });
    expect(JSON.stringify(mutation, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain("D:\\\\repo");
  });

  it("retains a current-task path atom when its directory entry disappears before dispatch", async () => {
    const network = projectedNetwork(workspacePathSnapshot);
    vi.mocked(network.listWorkspaceDirectory).mockResolvedValue({ entries: [], revision: "directory:src" });
    const drafts = memoryDraftStores();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids(), undefined, drafts);
    await app.start();
    const draft = workspacePathDraft();

    await expect(app.send(draft)).rejects.toThrow(/disappeared/u);

    expect(network.submit).not.toHaveBeenCalled();
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toEqual(draft);
  });

  it("retains the Workspace draft when a referenced path disappears or changes kind before dispatch", async () => {
    for (const replacement of [undefined, workspaceMentionDirectory] as const) {
      const network = projectedNetwork(workspaceMentionSnapshot);
      vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspaceId, parentPath) => ({
        entries: parentPath === "" ? [workspaceMentionDirectory]
          : replacement === undefined ? [] : [create(WorkspaceEntrySchema, {
              ...replacement, relativePath: "src/main.ts", displayName: "main.ts"
            })],
        revision: "directory-r2"
      }));
      const drafts = memoryDraftStores();
      const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids(), undefined, drafts);
      await app.start();
      const draft = workspaceMentionDraft();

      await expect(app.send(draft)).rejects.toThrow(/disappeared or changed file type/u);

      expect(network.submit).not.toHaveBeenCalled();
      expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toEqual(draft);
    }
  });

  it("retires a late Workspace candidate listing when its exact capability owner changes", async () => {
    const network = projectedNetwork(workspaceMentionSnapshot);
    let resolveDirectory!: (value: { entries: readonly WorkspaceEntry[]; revision: string }) => void;
    vi.mocked(network.listWorkspaceDirectory).mockImplementationOnce(() => new Promise((resolve) => {
      resolveDirectory = resolve;
    }));
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const controls = app.taskWorkspaceMentionControls()!;
    const loading = app.listTaskWorkspaceMentionDirectory(controls.surfaceOwnerKey, "");
    await vi.waitFor(() => expect(resolveDirectory).toBeDefined());

    const changed = create(SnapshotSchema, {
      ...workspaceMentionSnapshot,
      backends: [create(BackendDescriptorSchema, {
        ...workspaceMentionSnapshot.backends[0]!,
        version: "backend-v2"
      })]
    });
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: changed });
    vi.mocked(network.readSession).mockResolvedValue(changed);
    await app.refresh();
    resolveDirectory({ entries: [workspaceMentionDirectory], revision: "late-r1" });

    await expect(loading).rejects.toThrow(/owner changed/u);
  });

  it("loads Resource and Artifact candidates only from their typed authoritative catalogs", async () => {
    const network = projectedNetwork(catalogMentionSnapshot);
    configureCatalogMentions(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const controls = app.taskCatalogMentionControls()!;

    await expect(app.listTaskCatalogMentionCatalog(controls.surfaceOwnerKey)).resolves.toMatchObject({
      resources: { items: [{
        kind: "resource", resourceId: "resource-one", discoveredRevision: "sha256:resource-one",
        resourceVersion: "7", runtimeGeneration: "8"
      }] },
      artifacts: { revision: "artifact-references-r1", items: [{
        kind: "artifact", artifactId: "artifact-one", sourceSessionId: "related",
        sourceDisplayText: "Earlier task"
      }] }
    });
    expect(network.listSessionResources).toHaveBeenCalledWith(credential, "session", undefined);
    expect(network.listArtifactReferenceCatalog).toHaveBeenCalledWith(credential, "session", 8n, undefined);

    const resourceOnly = create(SnapshotSchema, {
      ...catalogMentionSnapshot,
      backends: [create(BackendDescriptorSchema, {
        ...catalogMentionSnapshot.backends[0]!,
        capabilities: create(CapabilityManifestSchema, {
          ...catalogMentionSnapshot.backends[0]!.capabilities!,
          capabilities: [
            create(CapabilitySchema, { name: capabilityNames.inputText, support: CapabilitySupport.SUPPORTED }),
            create(CapabilitySchema, {
              name: capabilityNames.inputMention,
              support: CapabilitySupport.SUPPORTED,
              options: create(CapabilityOptionsSchema, {
                kind: { case: "input", value: create(InputCapabilityOptionsSchema, { mediaTypes: ["resource"] }) }
              })
            })
          ]
        })
      })]
    });
    const resourceNetwork = projectedNetwork(resourceOnly);
    configureCatalogMentions(resourceNetwork);
    const resourceApp = client(resourceNetwork, memoryStorage(credential).storage);
    await resourceApp.start();
    const resourceControls = resourceApp.taskCatalogMentionControls()!;
    await expect(resourceApp.listTaskCatalogMentionCatalog(resourceControls.surfaceOwnerKey)).resolves.toMatchObject({
      resources: { items: [{ resourceId: "resource-one" }] }
    });
    expect(resourceNetwork.listArtifactReferenceCatalog).not.toHaveBeenCalled();
  });

  it("loads runtime commands only from the exact typed Session catalog and fences it with a fresh generation read", async () => {
    const network = projectedNetwork(runtimeCommandSnapshot);
    vi.mocked(network.listRuntimeCommands).mockResolvedValue([
      create(RuntimeCommandSchema, {
        commandId: "skill-review",
        name: "skill:review",
        description: "Review current changes",
        source: RuntimeCommandSource.SKILL,
        resourceId: "review-skill",
        loaded: true,
        sessionId: "session"
      }),
      create(RuntimeCommandSchema, {
        commandId: "not-loaded",
        name: "future",
        description: "Not loaded",
        source: RuntimeCommandSource.PROMPT,
        loaded: false,
        sessionId: "session"
      })
    ]);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const controls = app.taskRuntimeCommandControls()!;

    await expect(app.listTaskRuntimeCommands(controls.surfaceOwnerKey)).resolves.toMatchObject({
      sessionId: "session",
      runtimeGeneration: "8",
      items: [{
        commandId: "skill-review", name: "skill:review", source: RuntimeCommandSource.SKILL,
        resourceId: "review-skill"
      }]
    });
    expect(network.listRuntimeCommands).toHaveBeenCalledWith(credential, "session", undefined);
    expect(vi.mocked(network.listRuntimeCommands).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(network.readSession).mock.invocationCallOrder.at(-1)!);
  });

  it("retires a runtime command response when the fresh Session generation no longer matches its owner", async () => {
    const network = projectedNetwork(runtimeCommandSnapshot);
    vi.mocked(network.listRuntimeCommands).mockResolvedValue([create(RuntimeCommandSchema, {
      commandId: "review",
      name: "review",
      description: "Review",
      source: RuntimeCommandSource.PROMPT,
      loaded: true,
      sessionId: "session"
    })]);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const controls = app.taskRuntimeCommandControls()!;
    const nextGeneration = create(SnapshotSchema, {
      ...runtimeCommandSnapshot,
      sessions: [create(SessionSchema, {
        ...runtimeCommandSnapshot.sessions[0]!,
        nativeBinding: create(NativeSessionBindingSchema, { runtimeGeneration: 9n }),
        version: create(EntityVersionSchema, {
          generation: 9n,
          revision: create(RevisionSchema, { value: 10n, etag: "session-r10" })
        })
      })]
    });
    vi.mocked(network.readSession).mockResolvedValueOnce(nextGeneration);

    await expect(app.listTaskRuntimeCommands(controls.surfaceOwnerKey)).rejects.toThrow(/runtime changed/u);
  });

  it("retires an in-flight runtime command catalog when the app leaves the foreground", async () => {
    const network = projectedNetwork(runtimeCommandSnapshot);
    let resolveCommands!: (commands: Awaited<ReturnType<MobileNetwork["listRuntimeCommands"]>>) => void;
    vi.mocked(network.listRuntimeCommands).mockReturnValue(new Promise((resolve) => {
      resolveCommands = resolve;
    }));
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const controls = app.taskRuntimeCommandControls()!;
    vi.mocked(network.readSession).mockClear();
    const pending = app.listTaskRuntimeCommands(controls.surfaceOwnerKey);

    app.setForeground(false);
    resolveCommands([create(RuntimeCommandSchema, {
      commandId: "review",
      name: "review",
      description: "Review",
      source: RuntimeCommandSource.PROMPT,
      loaded: true,
      sessionId: "session"
    })]);

    await expect(pending).rejects.toThrow(/Reconnect/u);
    expect(network.readSession).not.toHaveBeenCalled();
    expect(app.taskRuntimeCommandControls()).toBeUndefined();
  });

  it("does not expose runtime command controls without one supported public capability", async () => {
    const missing = create(SnapshotSchema, {
      ...runtimeCommandSnapshot,
      backends: [create(BackendDescriptorSchema, {
        ...runtimeCommandSnapshot.backends[0]!,
        capabilities: create(CapabilityManifestSchema, {
          ...runtimeCommandSnapshot.backends[0]!.capabilities!,
          capabilities: [create(CapabilitySchema, {
            name: capabilityNames.inputText,
            support: CapabilitySupport.SUPPORTED
          })]
        })
      })]
    });
    const network = projectedNetwork(missing);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();

    expect(app.taskRuntimeCommandControls()).toBeUndefined();
    await expect(app.listTaskRuntimeCommands("guessed-owner")).rejects.toThrow(/owner changed/u);
    expect(network.listRuntimeCommands).not.toHaveBeenCalled();
  });

  it("re-reads the exact catalog before selection and rejects retired authorities", async () => {
    const network = projectedNetwork(catalogMentionSnapshot);
    configureCatalogMentions(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const controls = app.taskCatalogMentionControls()!;
    const catalog = await app.listTaskCatalogMentionCatalog(controls.surfaceOwnerKey);
    const resource = catalog.resources!.items[0]!;
    const artifact = catalog.artifacts!.items[0]!;

    await expect(app.validateTaskCatalogMentionCandidate(controls.surfaceOwnerKey, resource)).resolves.toMatchObject({
      resourceId: "resource-one", resourceVersion: "7"
    });
    await expect(app.validateTaskCatalogMentionCandidate(controls.surfaceOwnerKey, artifact)).resolves.toMatchObject({
      artifactId: "artifact-one", sourceSessionId: "related"
    });

    vi.mocked(network.listSessionResources).mockResolvedValueOnce([create(SessionResourceSchema, {
      ...catalogMentionResource, discoveredRevision: "sha256:new", resourceVersion: 8n
    })]);
    await expect(app.validateTaskCatalogMentionCandidate(controls.surfaceOwnerKey, resource))
      .rejects.toThrow(/same runtime identity/u);
    vi.mocked(network.listArtifactReferenceCatalog).mockResolvedValueOnce({
      artifacts: [], revision: "artifact-references-r2"
    });
    await expect(app.validateTaskCatalogMentionCandidate(controls.surfaceOwnerKey, artifact))
      .rejects.toThrow(/original task/u);
  });

  it("sends exact Resource and source-task Artifact wire identities with body-free receipts", async () => {
    const network = projectedNetwork(catalogMentionSnapshot);
    configureCatalogMentions(network);
    const saved = memoryStorage(credential);
    const drafts = memoryDraftStores();
    const app = client(network, saved.storage, undefined, undefined, ids(), undefined, drafts);
    await app.start();
    const draft = catalogMentionDraft();

    await expect(app.send(draft)).resolves.toBe(true);

    expect(vi.mocked(network.listSessionResources).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(network.submit).mock.invocationCallOrder[0]!);
    expect(vi.mocked(network.listArtifactReferenceCatalog).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(network.submit).mock.invocationCallOrder[0]!);
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      payload: { case: "sendInput", value: {
        sessionId: "session",
        input: {
          parts: [
            { content: { case: "text", value: draft.text } },
            { content: { case: "resourceMention", value: {
              resourceId: "resource-one", displayText: "Release helper", discoveredRevision: "sha256:resource-one",
              resourceVersion: 7n, runtimeGeneration: 8n
            } } },
            { content: { case: "artifactMention", value: {
              artifactId: "artifact-one", sourceSessionId: "related", displayText: "Release report"
            } } }
          ],
          mentionRanges: [
            { start: draft.mentions[0]!.start, end: draft.mentions[0]!.end, mentionIndex: 0 },
            { start: draft.mentions[1]!.start, end: draft.mentions[1]!.end, mentionIndex: 1 }
          ]
        }
      } }
    });
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
    expect(JSON.stringify(saved.pending())).not.toContain(draft.text);
    expect(JSON.stringify(saved.pending())).not.toContain("resource-one");
    expect(JSON.stringify(saved.pending())).not.toContain("artifact-one");
  });

  it("retains catalog-reference drafts for stale catalogs, rejected sends, and unknown receipts", async () => {
    for (const outcome of ["stale", "rejected", "unknown"] as const) {
      const network = projectedNetwork(catalogMentionSnapshot);
      configureCatalogMentions(network);
      const saved = memoryStorage(credential);
      const drafts = memoryDraftStores();
      if (outcome === "stale") {
        vi.mocked(network.listSessionResources).mockResolvedValueOnce([create(SessionResourceSchema, {
          ...catalogMentionResource, resourceVersion: 8n
        })]);
      } else if (outcome === "rejected") {
        vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
          operationId: "mobile-id-1", connectionId: credential.connectionId, state: OperationState.CONFLICT,
          error: { code: "GENERATION_CONFLICT", message: "The task runtime changed." }
        }));
      } else {
        vi.mocked(network.submit).mockRejectedValueOnce(new Error("reply lost"));
      }
      const app = client(network, saved.storage, undefined, undefined, ids(), undefined, drafts);
      await app.start();
      const draft = catalogMentionDraft();

      if (outcome === "stale") await expect(app.send(draft)).rejects.toThrow(/same runtime identity/u);
      else await expect(app.send(draft)).resolves.toBe(false);

      expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toEqual(draft);
      if (outcome === "stale") expect(network.submit).not.toHaveBeenCalled();
      expect(JSON.stringify(saved.pending())).not.toContain(draft.text);
      expect(JSON.stringify(saved.pending())).not.toContain("resource-one");
      expect(JSON.stringify(saved.pending())).not.toContain("artifact-one");
      if (outcome === "unknown") expect(saved.pending()).toMatchObject([{ kind: "send", state: "unknown" }]);
    }
  });

  it("retires a late catalog listing when an Artifact source authority changes", async () => {
    const network = projectedNetwork(catalogMentionSnapshot);
    let resolveResources!: (value: readonly (typeof catalogMentionResource)[]) => void;
    vi.mocked(network.listSessionResources).mockImplementationOnce(() => new Promise((resolve) => {
      resolveResources = resolve;
    }));
    vi.mocked(network.listArtifactReferenceCatalog).mockResolvedValue({
      artifacts: [catalogMentionArtifact], revision: "artifact-references-r1"
    });
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const controls = app.taskCatalogMentionControls()!;
    const loading = app.listTaskCatalogMentionCatalog(controls.surfaceOwnerKey);
    await vi.waitFor(() => expect(resolveResources).toBeDefined());

    const changed = create(SnapshotSchema, {
      ...catalogMentionSnapshot,
      sessions: catalogMentionSnapshot.sessions.map((session) => session.sessionId === "related"
        ? create(SessionSchema, {
            ...session,
            state: SessionState.CLOSED,
            version: create(EntityVersionSchema, {
              ...session.version!,
              revision: create(RevisionSchema, { value: 8n, etag: "related-r8" })
            })
          })
        : session)
    });
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: changed });
    vi.mocked(network.readSession).mockResolvedValue(changed);
    await app.refresh();
    resolveResources([catalogMentionResource]);

    await expect(loading).rejects.toThrow(/owner changed/u);
  });

  it("deletes only an exact completed visible message with the current Session generation", async () => {
    const network = projectedNetwork(messageActionSnapshot);
    const saved = memoryStorage(credential);
    let deleted = false;
    network.readAround = vi.fn(async () => [messageEvent]);
    network.readSession = vi.fn(async () => deleted
      ? create(SnapshotSchema, { ...messageActionSnapshot, timeline: [] })
      : messageActionSnapshot);
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      if (mutation.payload.case === "deleteSessionMessage") deleted = true;
      return create(OperationSchema, {
        operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED
      });
    });
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    expect(app.canDeleteMessage(messageEvent.eventId)).toBe(true);
    expect(app.canDeleteMessage("message-1")).toBe(false);
    await app.around(messageEvent.eventId);
    expect(app.state.window?.map((event) => event.eventId)).toEqual([messageEvent.eventId]);
    await expect(app.deleteMessage(messageEvent.eventId)).resolves.toBe(true);
    expect(app.state.window).toBeUndefined();
    expect(app.canDeleteMessage(messageEvent.eventId)).toBe(false);

    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.SESSION, id: "session" },
        expectedGeneration: 8n
      }],
      payload: { case: "deleteSessionMessage", value: {
        sessionId: "session",
        eventId: messageEvent.eventId
      } }
    });
    expect(saved.pending()).toEqual([]);
  });

  it("cancels the exact accepted Queue item at its projected revision", async () => {
    const network = projectedNetwork(queueSnapshot);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids());
    await app.start();

    expect(app.taskQueueCapabilities()).toEqual({ cancel: true, edit: true, reorder: true });
    expect(app.taskQueueItems().map((item) => item.queueItemId)).toEqual(["queue-1", "queue-2"]);
    await expect(app.cancelQueueItem("queue-1")).resolves.toBe(true);

    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.QUEUE_ITEM, id: "queue-1" },
        expectedRevision: { value: 11n, etag: "queue-1-r11" },
        expectedGeneration: 1n
      }],
      payload: { case: "cancelQueueItem", value: { queueItemId: "queue-1" } }
    });
  });

  it("locks, replaces, and unlocks one Queue item while revoking covered reference authority", async () => {
    const network = projectedNetwork(queueSnapshot);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids());
    await app.start();

    const lease = await app.beginQueueEdit("queue-1");
    expect(lease).toMatchObject({
      connectionId: credential.connectionId,
      sessionId: "session",
      queueItemId: "queue-1",
      text: "First queued input",
      replacesStructuredInput: true
    });
    await expect(app.saveQueueEdit(lease, "Revised queued input")).resolves.toBe(true);

    const mutations = vi.mocked(network.submit).mock.calls.map((call) => call[2]);
    expect(mutations).toHaveLength(3);
    expect(mutations[0]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.QUEUE_ITEM, id: "queue-1" },
        expectedRevision: { value: 11n },
        expectedGeneration: 1n
      }],
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1", lockToken: lease.lockToken, locked: true
      } }
    });
    expect(mutations[1]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.QUEUE_ITEM, id: "queue-1" },
        expectedRevision: { value: 11n },
        expectedGeneration: 1n
      }],
      payload: { case: "editQueueItem", value: {
        queueItemId: "queue-1",
        deliveryMode: QueueDeliveryMode.FOLLOW_UP,
        lockToken: lease.lockToken,
        textSplices: [{ start: 0, end: 18, replacementText: "Revised queued input" }],
        input: { parts: [
          { content: { case: "text", value: "Revised queued input" } }
        ], mentionRanges: [] }
      } }
    });
    expect(mutations[2]).toMatchObject({
      preconditions: [],
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1", lockToken: lease.lockToken, locked: false
      } }
    });
  });

  it("unlocks an unchanged queued input without replacing its structured authority", async () => {
    const network = projectedNetwork(queueSnapshot);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids());
    await app.start();

    const lease = await app.beginQueueEdit("queue-1");
    await expect(app.saveQueueEdit(lease, lease.text)).resolves.toBe(true);

    const mutations = vi.mocked(network.submit).mock.calls.map((call) => call[2]);
    expect(mutations).toHaveLength(2);
    expect(mutations[0]?.payload.case).toBe("setQueueItemEditLock");
    expect(mutations[1]).toMatchObject({
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1", lockToken: lease.lockToken, locked: false
      } }
    });
  });

  it("keeps the edit lease retryable when an unlock receipt cannot be persisted", async () => {
    const network = projectedNetwork(queueSnapshot);
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    const lease = await app.beginQueueEdit("queue-1");
    vi.mocked(saved.storage.savePending).mockRejectedValueOnce(new Error("device storage unavailable"));
    await expect(app.cancelQueueEdit(lease)).rejects.toThrow(/device storage unavailable/);
    expect(network.submit).toHaveBeenCalledTimes(1);

    await expect(app.cancelQueueEdit(lease)).resolves.toBeUndefined();
    expect(vi.mocked(network.submit).mock.calls[1]?.[2]).toMatchObject({
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1", lockToken: lease.lockToken, locked: false
      } }
    });
  });

  it("serializes Queue reorder under the exact QueueControl lock and disables edge moves", async () => {
    const network = projectedNetwork(queueSnapshot);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids());
    await app.start();

    await expect(app.moveQueueItem("queue-1", "up")).resolves.toBe(false);
    expect(network.submit).not.toHaveBeenCalled();
    await expect(app.moveQueueItem("queue-2", "up")).resolves.toBe(true);

    const mutations = vi.mocked(network.submit).mock.calls.map((call) => call[2]);
    expect(mutations).toHaveLength(3);
    const firstPayload = mutations[0]?.payload;
    if (firstPayload?.case !== "setQueueInteractionLock") throw new Error("Expected a Queue interaction-lock mutation.");
    const lockToken = firstPayload.value.lockToken;
    expect(mutations[0]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.QUEUE_CONTROL, id: "session" },
        expectedRevision: { value: 21n, etag: "queue-control-r21" },
        expectedGeneration: 1n
      }],
      payload: { case: "setQueueInteractionLock", value: {
        sessionId: "session", locked: true
      } }
    });
    expect(mutations[1]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.QUEUE_ITEM, id: "queue-2" },
        expectedRevision: { value: 12n, etag: "queue-2-r12" },
        expectedGeneration: 1n
      }],
      payload: { case: "reorderQueueItem", value: {
        queueItemId: "queue-2",
        placement: { anchor: { case: "beforeQueueItemId", value: "queue-1" } },
        interactionLockToken: lockToken
      } }
    });
    expect(mutations[2]).toMatchObject({
      preconditions: [],
      payload: { case: "setQueueInteractionLock", value: {
        sessionId: "session", lockToken, locked: false
      } }
    });
  });

  it("best-effort releases the Queue interaction lock after an unknown reorder without replaying it", async () => {
    const network = projectedNetwork(queueSnapshot);
    const saved = memoryStorage(credential);
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => create(OperationSchema, {
      operationId,
      connectionId: credential.connectionId,
      state: mutation.payload.case === "reorderQueueItem" ? OperationState.RUNNING : OperationState.SUCCEEDED
    }));
    vi.mocked(network.waitOperation).mockRejectedValueOnce(new Error("reorder watch disconnected"));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    await expect(app.moveQueueItem("queue-2", "up")).resolves.toBe(false);

    const mutations = vi.mocked(network.submit).mock.calls.map((call) => call[2]);
    expect(mutations).toHaveLength(3);
    const lock = mutations[0]?.payload;
    if (lock?.case !== "setQueueInteractionLock") throw new Error("Expected a Queue interaction-lock mutation.");
    expect(mutations[1]?.payload.case).toBe("reorderQueueItem");
    expect(mutations[2]).toMatchObject({
      payload: { case: "setQueueInteractionLock", value: {
        sessionId: "session", lockToken: lock.value.lockToken, locked: false
      } }
    });
    expect(vi.mocked(network.submit).mock.calls.filter((call) => call[2].payload.case === "reorderQueueItem"))
      .toHaveLength(1);
    expect(saved.pending()).toMatchObject([{
      kind: "queue-reorder", sessionId: "session", queueItemId: "queue-2", state: "accepted"
    }]);
  });

  it("compensates with the same interaction token when backgrounding during reorder-lock acquisition", async () => {
    const network = projectedNetwork(queueSnapshot);
    const saved = memoryStorage(credential);
    let resolveAcquire!: (operation: Operation) => void;
    let acquireOperationId = "";
    vi.mocked(network.submit).mockImplementationOnce((_credential, operationId) => new Promise((resolve) => {
      acquireOperationId = operationId;
      resolveAcquire = resolve;
    }));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    const moving = app.moveQueueItem("queue-2", "up");
    await vi.waitFor(() => expect(network.submit).toHaveBeenCalledTimes(1));
    const acquire = vi.mocked(network.submit).mock.calls[0]?.[2].payload;
    if (acquire?.case !== "setQueueInteractionLock") throw new Error("Expected Queue interaction-lock acquisition.");
    app.setForeground(false);
    await vi.waitFor(() => expect(network.submit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(network.submit).mock.calls[1]?.[2]).toMatchObject({
      payload: { case: "setQueueInteractionLock", value: {
        sessionId: "session", lockToken: acquire.value.lockToken, locked: false
      } }
    });
    resolveAcquire(create(OperationSchema, {
      operationId: acquireOperationId,
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED
    }));
    await expect(moving).rejects.toThrow(/unknown result/);
    await vi.waitFor(() => expect(network.submit).toHaveBeenCalledTimes(3));
    expect(vi.mocked(network.submit).mock.calls[2]?.[2]).toMatchObject({
      payload: { case: "setQueueInteractionLock", value: {
        sessionId: "session", lockToken: acquire.value.lockToken, locked: false
      } }
    });
    await vi.waitFor(() => expect(saved.pending()).toMatchObject([{
      kind: "queue-interaction-lock", sessionId: "session", state: "unknown"
    }]));
  });

  it("waits for a terminal lock result and never replays an unknown Queue mutation", async () => {
    const network = projectedNetwork(queueSnapshot);
    const saved = memoryStorage(credential);
    vi.mocked(network.submit).mockImplementationOnce(async (_credential, operationId) => create(OperationSchema, {
      operationId, connectionId: credential.connectionId, state: OperationState.RUNNING
    }));
    vi.mocked(network.waitOperation).mockRejectedValueOnce(new Error("watch disconnected"));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    await expect(app.beginQueueEdit("queue-1")).rejects.toThrow(/unknown result/);
    expect(saved.storage.savePending).toHaveBeenCalledBefore(network.submit as ReturnType<typeof vi.fn>);
    expect(saved.pending()).toMatchObject([{
      kind: "queue-edit-lock", sessionId: "session", queueItemId: "queue-1", state: "accepted"
    }]);
    await expect(app.beginQueueEdit("queue-1")).rejects.toThrow(/still pending/);
    expect(network.submit).toHaveBeenCalledTimes(2);
    expect(vi.mocked(network.submit).mock.calls.map((call) => call[2].payload)).toMatchObject([
      { case: "setQueueItemEditLock", value: { queueItemId: "queue-1", locked: true } },
      { case: "setQueueItemEditLock", value: { queueItemId: "queue-1", locked: false } }
    ]);
    expect(network.waitOperation).toHaveBeenCalledTimes(1);
  });

  it("releases the exact Queue edit lock when switching tasks or leaving the foreground", async () => {
    const switchNetwork = projectedNetwork(queueSnapshot);
    const switching = client(switchNetwork, memoryStorage(credential).storage, undefined, undefined, ids());
    await switching.start();
    const switchLease = await switching.beginQueueEdit("queue-1");
    await switching.select(undefined);
    expect(vi.mocked(switchNetwork.submit).mock.calls[1]?.[2]).toMatchObject({
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1", lockToken: switchLease.lockToken, locked: false
      } }
    });

    const backgroundNetwork = projectedNetwork(queueSnapshot);
    const saved = memoryStorage(credential);
    const backgrounding = client(backgroundNetwork, saved.storage, undefined, undefined, ids());
    await backgrounding.start();
    const backgroundLease = await backgrounding.beginQueueEdit("queue-1");
    backgrounding.setForeground(false);
    await vi.waitFor(() => expect(backgroundNetwork.submit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(backgroundNetwork.submit).mock.calls[1]?.[2]).toMatchObject({
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1", lockToken: backgroundLease.lockToken, locked: false
      } }
    });
    await vi.waitFor(() => expect(saved.pending()).toEqual([]));
  });

  it("compensates with the same lock token when the app backgrounds during lock acquisition", async () => {
    const network = projectedNetwork(queueSnapshot);
    const saved = memoryStorage(credential);
    let resolveAcquire!: (operation: Operation) => void;
    vi.mocked(network.submit).mockImplementationOnce((_credential, operationId) => new Promise((resolve) => {
      resolveAcquire = resolve;
      expect(operationId).toBe("mobile-id-2");
    }));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    const opening = app.beginQueueEdit("queue-1");
    await vi.waitFor(() => expect(network.submit).toHaveBeenCalledTimes(1));
    const acquirePayload = vi.mocked(network.submit).mock.calls[0]?.[2].payload;
    if (acquirePayload?.case !== "setQueueItemEditLock") throw new Error("Expected Queue edit-lock acquisition.");
    app.setForeground(false);
    await vi.waitFor(() => expect(network.submit).toHaveBeenCalledTimes(2));
    expect(vi.mocked(network.submit).mock.calls[1]?.[2]).toMatchObject({
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1",
        lockToken: acquirePayload.value.lockToken,
        locked: false
      } }
    });
    resolveAcquire(create(OperationSchema, {
      operationId: "mobile-id-2",
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED
    }));
    await expect(opening).rejects.toThrow(/unknown result|task changed/);
    await vi.waitFor(() => expect(network.submit).toHaveBeenCalledTimes(3));
    expect(vi.mocked(network.submit).mock.calls[2]?.[2]).toMatchObject({
      payload: { case: "setQueueItemEditLock", value: {
        queueItemId: "queue-1",
        lockToken: acquirePayload.value.lockToken,
        locked: false
      } }
    });
    await vi.waitFor(() => expect(saved.pending()).toMatchObject([{
      operationId: "mobile-id-2", kind: "queue-edit-lock", queueItemId: "queue-1", state: "unknown"
    }]));
  });
});

describe("native current-task app commands", () => {
  const ids = () => {
    let value = 0;
    return () => `app-command-${++value}`;
  };

  it("consumes local help and exact task navigation without dispatching a service mutation", async () => {
    const network = projectedNetwork(appCommandSnapshot);
    const drafts = memoryDraftStores();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids(), undefined, drafts);
    await app.start();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const controls = app.taskAppCommandControls()!;
    expect(controls.policy).toEqual({
      help: true, jumpSession: true, userShell: true, sessionReset: true, review: true
    });

    await expect(app.executeTaskAppCommand(
      controls.surfaceOwnerKey,
      { kind: "help" },
      plainTextMobileComposerDraft("/help")
    )).resolves.toEqual({ kind: "help", status: "succeeded" });
    expect(drafts.composer.readSync(identity)).toBeNull();

    const jumpControls = app.taskAppCommandControls()!;
    await expect(app.executeTaskAppCommand(
      jumpControls.surfaceOwnerKey,
      { kind: "jumpSession", sessionId: "related" },
      plainTextMobileComposerDraft("/jump-session related")
    )).resolves.toEqual({ kind: "jumpSession", status: "succeeded", sessionId: "related" });
    expect(app.state.selectedId).toBe("related");
    expect(drafts.composer.readSync(identity)).toBeNull();
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("dispatches typed shell, reset, and Review mutations with body-free receipts and conditional draft cleanup", async () => {
    const network = projectedNetwork(appCommandSnapshot);
    const saved = memoryStorage(credential);
    const drafts = memoryDraftStores();
    const fixture = attachmentFileFixture();
    vi.mocked(network.uploadBlob).mockImplementation(async () => committedAttachment(
      localAttachmentDraft().attachments[1] as MobileLocalComposerAttachment
    ));
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      toBinary(OperationMutationSchema, mutation);
      const payload = mutation.payload.case === "executeUserShell"
        ? { case: "acknowledgement" as const, value: { accepted: true } }
        : mutation.payload.case === "resetSession"
          ? { case: "session" as const, value: create(SessionSchema, {
              ...appCommandSnapshot.sessions[0]!,
              nativeBinding: create(NativeSessionBindingSchema, { runtimeGeneration: 9n }),
              version: create(EntityVersionSchema, {
                generation: 9n,
                revision: create(RevisionSchema, { value: 10n, etag: "session-r10" })
              })
            }) }
          : mutation.payload.case === "startReview"
            ? { case: "reviewRun" as const, value: create(ReviewRunSchema, {
                reviewRunId: "review-one",
                sourceSessionId: "session",
                reviewerSessionId: "reviewer-session",
                state: ReviewRunState.RUNNING
              }) }
            : undefined;
      return create(OperationSchema, {
        operationId,
        connectionId: credential.connectionId,
        state: OperationState.SUCCEEDED,
        ...(payload === undefined ? {} : { result: { payload } })
      });
    });
    const app = client(network, saved.storage, undefined, undefined, ids(), undefined, drafts, fixture.files);
    await app.start();
    const identity = { profileId: credential.profileId, sessionId: "session" };

    await expect(app.executeTaskAppCommand(
      app.taskAppCommandControls()!.surfaceOwnerKey,
      { kind: "userShell", command: "pwd" },
      plainTextMobileComposerDraft("/cmd pwd")
    )).resolves.toEqual({ kind: "userShell", status: "succeeded" });
    expect(drafts.composer.readSync(identity)).toBeNull();

    await expect(app.executeTaskAppCommand(
      app.taskAppCommandControls()!.surfaceOwnerKey,
      { kind: "sessionReset" },
      plainTextMobileComposerDraft("/clear")
    )).resolves.toEqual({ kind: "sessionReset", status: "succeeded" });
    expect(drafts.composer.readSync(identity)).toBeNull();

    const reviewAttachment = localAttachmentDraft().attachments[1]!;
    const reviewDraft = { ...plainTextMobileComposerDraft("/review security"), attachments: [reviewAttachment] };
    await expect(app.executeTaskAppCommand(
      app.taskAppCommandControls()!.surfaceOwnerKey,
      { kind: "review", focus: "security" },
      reviewDraft
    )).resolves.toEqual({ kind: "review", status: "succeeded", reviewRunId: "review-one" });

    expect(vi.mocked(network.submit).mock.calls.map((call) => call[2])).toMatchObject([
      {
        preconditions: [{ entity: { kind: EntityKind.SESSION, id: "session" }, expectedGeneration: 8n }],
        payload: { case: "executeUserShell", value: {
          sessionId: "session", command: "pwd", excludeFromContext: false
        } }
      },
      {
        preconditions: [{ entity: { kind: EntityKind.SESSION, id: "session" }, expectedGeneration: 8n }],
        payload: { case: "resetSession", value: { sessionId: "session" } }
      },
      {
        preconditions: [{ entity: { kind: EntityKind.SESSION, id: "session" }, expectedGeneration: 8n }],
        payload: { case: "startReview", value: {
          sourceSessionId: "session",
          focus: "security",
          attachments: [{ displayName: "proof.pdf", blob: { blobId: "blob-file-one" } }]
        } }
      }
    ]);
    expect(saved.storage.savePending).toHaveBeenCalledBefore(network.submit as ReturnType<typeof vi.fn>);
    expect(JSON.stringify(vi.mocked(saved.storage.savePending).mock.calls)).not.toMatch(/pwd|security|proof\.pdf|blob-file-one/u);
    expect(saved.pending()).toEqual([]);
    expect(drafts.composer.readSync(identity)).toBeNull();
    expect(network.uploadBlob).toHaveBeenCalledWith(credential, expect.objectContaining({ fileName: "proof.pdf" }), expect.any(AbortSignal));
    expect(vi.mocked(network.uploadBlob).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(network.submit).mock.invocationCallOrder[2]!);
    expect(fixture.removed).toEqual(["file-one"]);
  });

  it("retains rejected commands and fails closed on malformed shell, reset, and Review terminal results", async () => {
    const network = projectedNetwork(appCommandSnapshot);
    const drafts = memoryDraftStores();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids(), undefined, drafts);
    await app.start();
    const identity = { profileId: credential.profileId, sessionId: "session" };

    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "app-command-1",
      connectionId: credential.connectionId,
      state: OperationState.FAILED
    }));
    const rejected = plainTextMobileComposerDraft("/cmd rejected");
    await expect(app.executeTaskAppCommand(
      app.taskAppCommandControls()!.surfaceOwnerKey,
      { kind: "userShell", command: "rejected" },
      rejected
    )).resolves.toEqual({ kind: "userShell", status: "rejected" });
    expect(drafts.composer.readSync(identity)).toEqual(rejected);

    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      const payload = mutation.payload.case === "executeUserShell"
        ? { case: "acknowledgement" as const, value: { accepted: false } }
        : mutation.payload.case === "resetSession"
          ? { case: "session" as const, value: appCommandSnapshot.sessions[0]! }
          : { case: "reviewRun" as const, value: create(ReviewRunSchema, {
              reviewRunId: "review-invalid",
              sourceSessionId: "session",
              reviewerSessionId: "session",
              state: ReviewRunState.RUNNING
            }) };
      return create(OperationSchema, {
        operationId,
        connectionId: credential.connectionId,
        state: OperationState.SUCCEEDED,
        result: { payload }
      });
    });

    const invalidShell = plainTextMobileComposerDraft("/cmd pwd");
    await expect(app.executeTaskAppCommand(
      app.taskAppCommandControls()!.surfaceOwnerKey,
      { kind: "userShell", command: "pwd" },
      invalidShell
    )).rejects.toThrow(/typed acknowledgement/u);
    expect(drafts.composer.readSync(identity)).toEqual(invalidShell);

    const invalidReset = plainTextMobileComposerDraft("/clear");
    await expect(app.executeTaskAppCommand(
      app.taskAppCommandControls()!.surfaceOwnerKey,
      { kind: "sessionReset" },
      invalidReset
    )).rejects.toThrow(/same product task/u);
    expect(drafts.composer.readSync(identity)).toEqual(invalidReset);

    const invalidReview = plainTextMobileComposerDraft("/review isolation");
    await expect(app.executeTaskAppCommand(
      app.taskAppCommandControls()!.surfaceOwnerKey,
      { kind: "review", focus: "isolation" },
      invalidReview
    )).rejects.toThrow(/valid isolated review task/u);
    expect(drafts.composer.readSync(identity)).toEqual(invalidReview);
  });

  it("retains an unknown shell receipt and exact draft without replaying the command", async () => {
    const network = projectedNetwork(appCommandSnapshot);
    const saved = memoryStorage(credential);
    const drafts = memoryDraftStores();
    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "app-command-1",
      connectionId: credential.connectionId,
      state: OperationState.RUNNING
    }));
    vi.mocked(network.waitOperation).mockRejectedValueOnce(new Error("operation watch disconnected"));
    const app = client(network, saved.storage, undefined, undefined, ids(), undefined, drafts);
    await app.start();
    const controls = app.taskAppCommandControls()!;
    const draft = plainTextMobileComposerDraft("/cmd npm test");

    await expect(app.executeTaskAppCommand(
      controls.surfaceOwnerKey,
      { kind: "userShell", command: "npm test" },
      draft
    )).resolves.toEqual({ kind: "userShell", status: "unknown" });

    expect(saved.pending()).toMatchObject([{
      operationId: "app-command-1", kind: "session-shell", sessionId: "session", state: "accepted"
    }]);
    expect(JSON.stringify(saved.pending())).not.toContain("npm test");
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toEqual(draft);
    await expect(app.executeTaskAppCommand(
      app.taskAppCommandControls()!.surfaceOwnerKey,
      { kind: "userShell", command: "npm test" },
      draft
    )).rejects.toThrow(/still pending/u);
    expect(network.submit).toHaveBeenCalledTimes(1);
  });

  it("allows the exact shell permission Interaction to resolve while the shell operation is waiting", async () => {
    const network = projectedNetwork(appCommandSnapshot);
    let current = appCommandSnapshot;
    let finishShell!: (operation: Operation) => void;
    let shellOperationId = "";
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: current }));
    network.readSession = vi.fn(async () => current);
    const push = eventFeed(network);
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      if (mutation.payload.case === "executeUserShell") {
        shellOperationId = operationId;
        return create(OperationSchema, {
          operationId,
          connectionId: credential.connectionId,
          state: OperationState.RUNNING
        });
      }
      return create(OperationSchema, {
        operationId,
        connectionId: credential.connectionId,
        state: OperationState.SUCCEEDED,
        result: { payload: { case: "acknowledgement", value: { accepted: true } } }
      });
    });
    vi.mocked(network.waitOperation).mockImplementationOnce((_credential, operationId) => new Promise((resolve) => {
      finishShell = (operation) => {
        expect(operation.operationId).toBe(operationId);
        resolve(operation);
      };
    }));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids(), undefined, memoryDraftStores());
    await app.start();
    const controls = app.taskAppCommandControls()!;
    const running = app.executeTaskAppCommand(
      controls.surfaceOwnerKey,
      { kind: "userShell", command: "git status" },
      plainTextMobileComposerDraft("/cmd git status")
    );
    await vi.waitFor(() => expect(network.waitOperation).toHaveBeenCalledOnce());

    current = create(SnapshotSchema, {
      ...appCommandSnapshot,
      resumeCursor: create(EventCursorSchema, { opaqueToken: "cursor-11", sequence: 11n, generation: 1n }),
      interactions: [permissionInteraction]
    });
    push(event("permission-projection", 11n));
    await vi.waitFor(() => expect(app.taskInteractions()).toHaveLength(1));
    await expect(app.resolveInteraction("interaction-permission", {
      kind: "permission", decision: PermissionDecisionKind.ALLOW_ONCE
    })).resolves.toBe(true);

    current = create(SnapshotSchema, {
      ...appCommandSnapshot,
      resumeCursor: create(EventCursorSchema, { opaqueToken: "cursor-11", sequence: 11n, generation: 1n })
    });
    finishShell(create(OperationSchema, {
      operationId: shellOperationId,
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED,
      result: { payload: { case: "acknowledgement", value: { accepted: true } } }
    }));
    await expect(running).resolves.toEqual({ kind: "userShell", status: "succeeded" });
    expect(vi.mocked(network.submit).mock.calls.map((call) => call[2].payload.case))
      .toEqual(["executeUserShell", "resolveInteraction"]);
  });
});

describe("native current-task Interaction ownership", () => {
  const ids = () => {
    let value = 0;
    return () => `interaction-operation-${++value}`;
  };

  it("sorts exact current requests and resolves an advertised decision at revision and generation", async () => {
    const network = projectedNetwork(interactionSnapshot);
    const saved = memoryStorage(credential);
    let settled = false;
    const current = () => settled
      ? create(SnapshotSchema, { ...interactionSnapshot, interactions: [questionInteraction, planInteraction] })
      : interactionSnapshot;
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: current() }));
    network.readSession = vi.fn(async () => current());
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      if (mutation.payload.case === "resolveInteraction") settled = true;
      return create(OperationSchema, { operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED });
    });
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    expect(app.taskInteractions().map((interaction) => interaction.interactionId))
      .toEqual(["interaction-plan", "interaction-permission", "interaction-question"]);
    await expect(app.resolveInteraction(permissionInteraction.interactionId, {
      kind: "permission",
      decision: PermissionDecisionKind.ALLOW_ONCE
    })).resolves.toBe(true);

    expect(saved.storage.savePending).toHaveBeenCalledBefore(network.submit as ReturnType<typeof vi.fn>);
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.INTERACTION, id: permissionInteraction.interactionId },
        expectedRevision: { value: 44n, etag: "interaction-r44" },
        expectedGeneration: 8n
      }],
      payload: { case: "resolveInteraction", value: {
        interactionId: permissionInteraction.interactionId,
        interactionGeneration: 8n,
        resolution: {
          connectionId: credential.connectionId,
          decision: { case: "permission", value: { decision: PermissionDecisionKind.ALLOW_ONCE } }
        }
      } }
    });
    expect(saved.pending()).toEqual([]);
    expect(app.taskInteractions().map((interaction) => interaction.interactionId))
      .toEqual(["interaction-plan", "interaction-question"]);
  });

  it("dismisses only the exact current request and refreshes its authoritative projection", async () => {
    const network = projectedNetwork(interactionSnapshot);
    let dismissed = false;
    const current = () => dismissed
      ? create(SnapshotSchema, { ...interactionSnapshot, interactions: [permissionInteraction, planInteraction] })
      : interactionSnapshot;
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: current() }));
    network.readSession = vi.fn(async () => current());
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      if (mutation.payload.case === "dismissInteraction") dismissed = true;
      return create(OperationSchema, { operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED });
    });
    const clearInteractionDraft = vi.fn(async (_identity: MobileInteractionDraftIdentity) => undefined);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids(), clearInteractionDraft);
    await app.start();

    await expect(app.dismissInteraction(questionInteraction.interactionId)).resolves.toBe(true);
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.INTERACTION, id: questionInteraction.interactionId },
        expectedRevision: { value: 45n },
        expectedGeneration: 8n
      }],
      payload: { case: "dismissInteraction", value: {
        interactionId: questionInteraction.interactionId,
        interactionGeneration: 8n,
        reason: "Dismissed by user on mobile"
      } }
    });
    expect(app.taskInteractions().some((interaction) => interaction.interactionId === questionInteraction.interactionId)).toBe(false);
    expect(clearInteractionDraft).toHaveBeenCalledWith({
      profileId: credential.profileId,
      sessionId: "session",
      interactionId: questionInteraction.interactionId,
      kind: "question",
      generation: 8n,
      revision: 45n
    });
  });

  it("clears the exact saved draft when a succeeded response is reconciled after restart", async () => {
    const network = projectedNetwork(interactionSnapshot);
    const saved = memoryStorage(credential);
    await saved.storage.savePending([{
      operationId: "interaction-operation-before-restart",
      connectionId: credential.connectionId,
      kind: "interaction-resolve",
      sessionId: "session",
      interactionId: planInteraction.interactionId,
      interactionGeneration: "8",
      interactionRevision: "46",
      interactionDraftKind: "plan",
      state: "accepted"
    }]);
    vi.mocked(network.getOperation).mockResolvedValue(create(OperationSchema, {
      operationId: "interaction-operation-before-restart",
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED
    }));
    const clearInteractionDraft = vi.fn(async (_identity: MobileInteractionDraftIdentity) => undefined);
    const app = client(network, saved.storage, undefined, undefined, ids(), clearInteractionDraft);

    await app.start();

    expect(clearInteractionDraft).toHaveBeenCalledWith({
      profileId: credential.profileId,
      sessionId: "session",
      interactionId: planInteraction.interactionId,
      kind: "plan",
      generation: 8n,
      revision: 46n
    });
    expect(saved.pending()).toEqual([]);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("retains one unknown response receipt and never replays that decision", async () => {
    const network = projectedNetwork(interactionSnapshot);
    const saved = memoryStorage(credential);
    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "interaction-operation-1",
      connectionId: credential.connectionId,
      state: OperationState.RUNNING
    }));
    vi.mocked(network.waitOperation).mockRejectedValueOnce(new Error("operation watch disconnected"));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    await expect(app.resolveInteraction(questionInteraction.interactionId, {
      kind: "question",
      answers: { answer: { kind: "text", value: "Keep this draft" } }
    })).resolves.toBe(false);
    expect(saved.pending()).toMatchObject([{
      kind: "interaction-resolve",
      sessionId: "session",
      interactionId: questionInteraction.interactionId,
      state: "accepted"
    }]);
    await expect(app.resolveInteraction(questionInteraction.interactionId, {
      kind: "question",
      answers: { answer: { kind: "text", value: "Do not resend" } }
    })).rejects.toThrow(/still pending/u);
    expect(network.submit).toHaveBeenCalledTimes(1);
    expect(network.waitOperation).toHaveBeenCalledTimes(1);
  });

  it("rejects stale, unadvertised, and cross-generation responses before dispatch", async () => {
    const network = projectedNetwork(interactionSnapshot);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids());
    await app.start();

    await expect(app.resolveInteraction(permissionInteraction.interactionId, {
      kind: "permission",
      decision: PermissionDecisionKind.ALLOW_FOR_SESSION
    })).rejects.toThrow(/not currently available/u);
    await expect(app.resolveInteraction("missing", {
      kind: "permission",
      decision: PermissionDecisionKind.ALLOW_ONCE
    })).rejects.toThrow(/no longer pending/u);
    expect(network.submit).not.toHaveBeenCalled();

    network.readSession = vi.fn(async () => create(SnapshotSchema, {
      ...interactionSnapshot,
      sessions: [create(SessionSchema, { ...interactionSnapshot.sessions[0]!,
        nativeBinding: create(NativeSessionBindingSchema, { runtimeGeneration: 9n }) })]
    }));
    await app.refresh();
    expect(app.taskInteractions()).toEqual([]);
    await expect(app.dismissInteraction(permissionInteraction.interactionId)).rejects.toThrow(/no longer pending/u);
    expect(network.submit).not.toHaveBeenCalled();
  });
});

describe("native current-task runtime controls", () => {
  const ids = () => {
    let value = 0;
    return () => `runtime-control-${++value}`;
  };

  it("applies model, permission, and Plan Mode with exact Session revision and generation receipts", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    let current = runtimeSession;
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(current, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(current, true));
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      const nextRevision = (current.version?.revision?.value ?? 0n) + 1n;
      if (mutation.payload.case === "setSessionModel") {
        current = create(SessionSchema, { ...current, model: mutation.payload.value.model,
          version: create(EntityVersionSchema, {
            revision: create(RevisionSchema, { value: nextRevision, etag: `session-r${nextRevision}` }), generation: 8n
          }) });
      } else if (mutation.payload.case === "setSessionPermission") {
        current = create(SessionSchema, { ...current, permissionMode: mutation.payload.value.permissionMode,
          version: create(EntityVersionSchema, {
            revision: create(RevisionSchema, { value: nextRevision, etag: `session-r${nextRevision}` }), generation: 8n
          }) });
      } else if (mutation.payload.case === "setSessionPlanMode") {
        current = create(SessionSchema, { ...current, planMode: mutation.payload.value.enabled,
          version: create(EntityVersionSchema, {
            revision: create(RevisionSchema, { value: nextRevision, etag: `session-r${nextRevision}` }), generation: 8n
          }) });
      }
      return create(OperationSchema, { operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED });
    });
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    let controls = app.taskRuntimeControls();
    expect(controls).toMatchObject({ canSwitchModel: true, canSetEffort: true, canSetFastMode: true,
      canSetPermission: true, canSetPlanMode: true });
    await expect(app.setTaskModel(controls!.authorityKey, {
      providerId: "beta", modelId: "b", effortId: "high", fastMode: true
    })).resolves.toBe(true);
    expect(saved.storage.savePending).toHaveBeenCalledBefore(network.submit as ReturnType<typeof vi.fn>);
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.SESSION, id: "session" },
        expectedRevision: { value: 9n, etag: "session-r9" },
        expectedGeneration: 8n
      }],
      payload: { case: "setSessionModel", value: {
        sessionId: "session",
        model: { model: { providerId: "beta", modelId: "b" }, effortId: "high", fastMode: true }
      } }
    });

    controls = app.taskRuntimeControls();
    await expect(app.setTaskPermission(controls!.authorityKey, PermissionMode.AUTO)).resolves.toBe(true);
    expect(vi.mocked(network.submit).mock.calls[1]?.[2]).toMatchObject({
      preconditions: [{ expectedRevision: { value: 10n }, expectedGeneration: 8n }],
      payload: { case: "setSessionPermission", value: { sessionId: "session", permissionMode: PermissionMode.AUTO } }
    });

    controls = app.taskRuntimeControls();
    await expect(app.setTaskPlanMode(controls!.authorityKey, true)).resolves.toBe(true);
    expect(vi.mocked(network.submit).mock.calls[2]?.[2]).toMatchObject({
      preconditions: [{ expectedRevision: { value: 11n }, expectedGeneration: 8n }],
      payload: { case: "setSessionPlanMode", value: { sessionId: "session", enabled: true } }
    });
    expect(saved.pending()).toEqual([]);
    expect(app.taskRuntimeControls()?.session).toMatchObject({
      permissionMode: PermissionMode.AUTO,
      planMode: true,
      model: { model: { providerId: "beta", modelId: "b" }, effortId: "high", fastMode: true }
    });
  });

  it("retains an unknown control receipt and never replays the mutation", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(runtimeSession, true));
    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "runtime-control-1",
      connectionId: credential.connectionId,
      state: OperationState.RUNNING
    }));
    vi.mocked(network.waitOperation).mockRejectedValueOnce(new Error("operation watch disconnected"));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();
    const authorityKey = app.taskRuntimeControls()!.authorityKey;

    await expect(app.setTaskPlanMode(authorityKey, true)).resolves.toBe(false);
    expect(saved.pending()).toMatchObject([{
      kind: "session-plan", sessionId: "session", state: "accepted"
    }]);
    await expect(app.setTaskPlanMode(authorityKey, true)).rejects.toThrow(/still pending/u);
    expect(network.submit).toHaveBeenCalledTimes(1);
    expect(network.waitOperation).toHaveBeenCalledTimes(1);
  });

  it("reconciles a saved control receipt after restart without dispatching it again", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    await saved.storage.savePending([{
      operationId: "runtime-before-restart",
      connectionId: credential.connectionId,
      kind: "session-permission",
      sessionId: "session",
      state: "accepted"
    }]);
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(runtimeSession, true));
    vi.mocked(network.getOperation).mockResolvedValue(create(OperationSchema, {
      operationId: "runtime-before-restart",
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED
    }));
    const app = client(network, saved.storage, undefined, undefined, ids());

    await app.start();

    expect(saved.pending()).toEqual([]);
    expect(network.getOperation).toHaveBeenCalledWith(credential, "runtime-before-restart", expect.any(AbortSignal));
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("rejects invalid choices and retired control authority before dispatch", async () => {
    const network = fakeNetwork();
    let detailRevision = 31n;
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => create(SnapshotSchema, {
      ...runtimeControlProjection(runtimeSession, true),
      revision: create(RevisionSchema, { value: detailRevision, etag: `detail-r${detailRevision}` })
    }));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, ids());
    await app.start();
    const staleKey = app.taskRuntimeControls()!.authorityKey;

    await expect(app.setTaskModel(staleKey, {
      providerId: "beta", modelId: "b", effortId: "unknown", fastMode: false
    })).rejects.toThrow(/not advertised/u);
    expect(network.submit).not.toHaveBeenCalled();

    detailRevision = 32n;
    await app.refresh();
    await expect(app.setTaskPermission(staleKey, PermissionMode.AUTO)).rejects.toThrow(/controls changed/u);
    expect(network.submit).not.toHaveBeenCalled();
  });
});

describe("native current-task context usage and compaction", () => {
  const ids = () => {
    let value = 0;
    return () => `context-compact-${++value}`;
  };

  it("projects measured usage and compacts with an exact Session precondition and typed outcome", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    let current = runtimeSession;
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(current, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(current, true));
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId) => {
      current = create(SessionSchema, {
        ...current,
        context: undefined,
        version: create(EntityVersionSchema, {
          revision: create(RevisionSchema, { value: 10n, etag: "session-r10" }), generation: 8n
        })
      });
      return create(OperationSchema, {
        operationId,
        connectionId: credential.connectionId,
        state: OperationState.SUCCEEDED,
        result: { payload: { case: "compactSession", value: { outcome: CompactSessionOutcome.COMPACTED } } }
      });
    });
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    const controls = app.taskContextControls();
    expect(controls).toMatchObject({
      usageSupported: true,
      compactSupported: true,
      canCompact: true,
      usage: {
        usedTokens: 50_000n,
        contextWindowTokens: 100_000n,
        reservedTokens: 50_000n,
        percent: 50,
        measuredAtMs: 123_000,
        cumulative: {
          inputTokens: 40_000n,
          outputTokens: 5_000n,
          cacheReadTokens: 4_000n,
          cacheWriteTokens: 1_000n,
          totalTokens: 50_000n
        }
      }
    });
    await expect(app.compactTaskContext(controls!.authorityKey)).resolves.toBe("compacted");

    expect(saved.storage.savePending).toHaveBeenCalledBefore(network.submit as ReturnType<typeof vi.fn>);
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.SESSION, id: "session" },
        expectedRevision: { value: 9n, etag: "session-r9" },
        expectedGeneration: 8n
      }],
      payload: { case: "compactSession", value: { sessionId: "session", customInstructions: "" } }
    });
    expect(saved.pending()).toEqual([]);
    expect(app.taskContextControls()).toMatchObject({
      usageSupported: true,
      compactSupported: true,
      canCompact: false,
      compactUnavailableReason: "Current context usage is unavailable."
    });
  });

  it("retains an unknown compaction receipt and never replays the mutation", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(runtimeSession, true));
    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "context-compact-1",
      connectionId: credential.connectionId,
      state: OperationState.RUNNING
    }));
    vi.mocked(network.waitOperation).mockRejectedValueOnce(new Error("operation watch disconnected"));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();
    const authorityKey = app.taskContextControls()!.authorityKey;

    await expect(app.compactTaskContext(authorityKey)).resolves.toBeUndefined();
    expect(saved.pending()).toMatchObject([{
      kind: "session-compact", sessionId: "session", state: "accepted"
    }]);
    await expect(app.compactTaskContext(authorityKey)).rejects.toThrow(/still pending/u);
    expect(network.submit).toHaveBeenCalledTimes(1);
    expect(network.waitOperation).toHaveBeenCalledTimes(1);
  });

  it("reconciles a saved compaction receipt after restart without dispatching it again", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    await saved.storage.savePending([{
      operationId: "context-before-restart",
      connectionId: credential.connectionId,
      kind: "session-compact",
      sessionId: "session",
      state: "accepted"
    }]);
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(runtimeSession, true));
    vi.mocked(network.getOperation).mockResolvedValue(create(OperationSchema, {
      operationId: "context-before-restart",
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED,
      result: { payload: { case: "compactSession", value: { outcome: CompactSessionOutcome.NOOP } } }
    }));
    const app = client(network, saved.storage, undefined, undefined, ids());

    await app.start();

    expect(saved.pending()).toEqual([]);
    expect(network.getOperation).toHaveBeenCalledWith(credential, "context-before-restart", expect.any(AbortSignal));
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("rejects retired context authority and fails closed on a missing typed outcome", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    let detailRevision = 31n;
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => create(SnapshotSchema, {
      ...runtimeControlProjection(runtimeSession, true),
      revision: create(RevisionSchema, { value: detailRevision, etag: `detail-r${detailRevision}` })
    }));
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId) => create(OperationSchema, {
      operationId,
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED
    }));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();
    const staleKey = app.taskContextControls()!.authorityKey;

    detailRevision = 32n;
    await app.refresh();
    await expect(app.compactTaskContext(staleKey)).rejects.toThrow(/context changed/u);
    expect(network.submit).not.toHaveBeenCalled();

    await expect(app.compactTaskContext(app.taskContextControls()!.authorityKey))
      .rejects.toThrow(/without a typed outcome/u);
    expect(network.submit).toHaveBeenCalledTimes(1);
    expect(saved.pending()).toEqual([]);
  });

  it("keeps the measured projection when the node rejects compaction", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(runtimeSession, true));
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId) => create(OperationSchema, {
      operationId,
      connectionId: credential.connectionId,
      state: OperationState.FAILED,
      error: { code: "CONFLICT", message: "Context changed before compaction." }
    }));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    await expect(app.compactTaskContext(app.taskContextControls()!.authorityKey))
      .rejects.toThrow("Context changed before compaction.");

    expect(saved.pending()).toEqual([]);
    expect(app.taskContextControls()).toMatchObject({
      canCompact: true,
      usage: { usedTokens: 50_000n, contextWindowTokens: 100_000n, percent: 50 }
    });
    expect(app.state.error).toBe("Context changed before compaction.");
  });
});

describe("native composer task-link resolution", () => {
  function routeNetwork(detailTimeline: readonly Event[] = []): MobileNetwork {
    const network = fakeNetwork();
    network.readOwner = vi.fn(async () => ({
      connection,
      device,
      snapshot: runtimeControlProjection(runtimeSession, false)
    }));
    network.readSession = vi.fn(async () => create(SnapshotSchema, {
      ...runtimeControlProjection(runtimeSession, true),
      timeline: [...detailTimeline]
    }));
    return network;
  }

  it("resolves exact visible task/project titles and a cached message without a history read", async () => {
    const network = routeNetwork([messageEvent]);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();

    await expect(app.resolveComposerRouteReference({
      kind: "session",
      href: "#/tasks/session",
      sessionId: "session"
    })).resolves.toBe("Task");
    await expect(app.resolveComposerRouteReference({
      kind: "project",
      href: "#/projects/target",
      projectId: "target"
    })).resolves.toBe("Project");
    await expect(app.resolveComposerRouteReference({
      kind: "project",
      href: "#/projects/target",
      projectId: "other-target"
    })).resolves.toBeUndefined();
    await expect(app.resolveComposerRouteReference({
      kind: "message",
      href: "#/tasks/session?message=message-1",
      sessionId: "session",
      messageId: "message-1"
    })).resolves.toBe("Durable answer");
    expect(network.readAround).not.toHaveBeenCalled();
    expect(network.readNativeSessionTree).not.toHaveBeenCalled();
  });

  it("uses an exact authenticated around-read and then the validated native tree fallback", async () => {
    const network = routeNetwork();
    vi.mocked(network.readAround).mockResolvedValue([messageEvent]);
    network.readNativeSessionTree = vi.fn(async () => branchTree(9n, "session-r9", "native-current"));
    const app = client(network, memoryStorage(credential).storage);
    await app.start();

    await expect(app.resolveComposerRouteReference({
      kind: "message",
      href: "#/tasks/session?event=event-completed",
      sessionId: "session",
      eventId: "event-completed"
    })).resolves.toBe("Durable answer");
    await expect(app.resolveComposerRouteReference({
      kind: "message",
      href: "#/tasks/session?message=native-current",
      sessionId: "session",
      messageId: "native-current"
    })).resolves.toBe("Current answer");
    expect(network.readAround).toHaveBeenCalledWith(
      credential,
      "session",
      "event-completed",
      expect.any(AbortSignal)
    );
    expect(network.readNativeSessionTree).toHaveBeenCalledWith(
      credential,
      "session",
      expect.any(AbortSignal)
    );
  });

  it("retires an in-flight enrichment when foreground owner authority changes", async () => {
    const network = routeNetwork();
    let finish!: (events: Event[]) => void;
    vi.mocked(network.readAround).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const app = client(network, memoryStorage(credential).storage);
    await app.start();

    const pending = app.resolveComposerRouteReference({
      kind: "message",
      href: "#/tasks/session?event=event-completed",
      sessionId: "session",
      eventId: "event-completed"
    });
    app.setForeground(false);
    finish([messageEvent]);
    await expect(pending).resolves.toBeUndefined();
  });
});

describe("native current-task branch navigation", () => {
  const ids = () => {
    let value = 0;
    return () => `session-branch-${++value}`;
  };

  it("loads the exact tree and navigates with revision, generation, and explicit summary input", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    let current = runtimeSession;
    let activeEntryId: "native-current" | "native-alternate" = "native-current";
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(current, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(current, true));
    network.readNativeSessionTree = vi.fn(async () => branchTree(
      current.version!.revision!.value,
      current.version!.revision!.etag,
      activeEntryId
    ));
    vi.mocked(network.submit).mockImplementation(async (_credential, operationId) => {
      current = create(SessionSchema, {
        ...current,
        version: create(EntityVersionSchema, {
          revision: create(RevisionSchema, { value: 10n, etag: "session-r10" }),
          generation: 8n
        })
      });
      activeEntryId = "native-alternate";
      return create(OperationSchema, {
        operationId,
        connectionId: credential.connectionId,
        state: OperationState.SUCCEEDED,
        result: { payload: { case: "acknowledgement", value: { accepted: true } } }
      });
    });
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();

    const controls = app.taskNativeTreeControls();
    expect(controls).toMatchObject({ canNavigate: true });
    const tree = await app.loadTaskNativeTree(controls!.authorityKey);
    expect(tree.rows.map((row) => row.entryId)).toEqual(["native-root", "native-current", "native-alternate"]);
    expect(tree.activeEntryId).toBe("native-current");

    await expect(app.navigateTaskNativeTree(
      controls!.authorityKey,
      tree,
      "native-alternate",
      true,
      "  Preserve the test evidence  "
    )).resolves.toBe("navigated");

    expect(saved.storage.savePending).toHaveBeenCalledBefore(network.submit as ReturnType<typeof vi.fn>);
    expect(vi.mocked(network.submit).mock.calls[0]?.[2]).toMatchObject({
      preconditions: [{
        entity: { kind: EntityKind.SESSION, id: "session" },
        expectedRevision: { value: 9n, etag: "session-r9" },
        expectedGeneration: 8n
      }],
      payload: { case: "navigateSessionBranch", value: {
        sessionId: "session",
        target: { kind: { case: "nativeEntryId", value: "native-alternate" } },
        summarize: true,
        customInstructions: "Preserve the test evidence"
      } }
    });
    expect(saved.pending()).toEqual([]);
    expect(app.taskNativeTreeControls()?.session.version?.revision).toMatchObject({ value: 10n, etag: "session-r10" });
    const refreshed = await app.loadTaskNativeTree(app.taskNativeTreeControls()!.authorityKey);
    expect(refreshed.activeEntryId).toBe("native-alternate");
  });

  it("retains an unknown branch receipt and never replays navigation", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(runtimeSession, true));
    network.readNativeSessionTree = vi.fn(async () => branchTree(9n, "session-r9", "native-current"));
    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "session-branch-1",
      connectionId: credential.connectionId,
      state: OperationState.RUNNING
    }));
    vi.mocked(network.waitOperation).mockRejectedValueOnce(new Error("operation watch disconnected"));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();
    const controls = app.taskNativeTreeControls()!;
    const tree = await app.loadTaskNativeTree(controls.authorityKey);

    await expect(app.navigateTaskNativeTree(
      controls.authorityKey, tree, "native-alternate", false, "must not persist"
    )).resolves.toBe("unknown");
    expect(saved.pending()).toMatchObject([{
      kind: "session-branch", sessionId: "session", state: "accepted"
    }]);
    await expect(app.navigateTaskNativeTree(
      controls.authorityKey, tree, "native-alternate", false, ""
    )).rejects.toThrow(/still pending/u);
    expect(network.submit).toHaveBeenCalledTimes(1);
    expect(network.waitOperation).toHaveBeenCalledTimes(1);
  });

  it("reconciles a saved branch receipt after restart without dispatching it again", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    await saved.storage.savePending([{
      operationId: "branch-before-restart",
      connectionId: credential.connectionId,
      kind: "session-branch",
      sessionId: "session",
      state: "accepted"
    }]);
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(runtimeSession, true));
    vi.mocked(network.getOperation).mockResolvedValue(create(OperationSchema, {
      operationId: "branch-before-restart",
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED,
      result: { payload: { case: "acknowledgement", value: { accepted: true } } }
    }));
    const app = client(network, saved.storage, undefined, undefined, ids());

    await app.start();

    expect(saved.pending()).toEqual([]);
    expect(network.getOperation).toHaveBeenCalledWith(credential, "branch-before-restart", expect.any(AbortSignal));
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("keeps the loaded tree on rejection and fails closed without a typed acknowledgement", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: runtimeControlProjection(runtimeSession, false) }));
    network.readSession = vi.fn(async () => runtimeControlProjection(runtimeSession, true));
    network.readNativeSessionTree = vi.fn(async () => branchTree(9n, "session-r9", "native-current"));
    const app = client(network, saved.storage, undefined, undefined, ids());
    await app.start();
    const controls = app.taskNativeTreeControls()!;
    const tree = await app.loadTaskNativeTree(controls.authorityKey);

    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "session-branch-1",
      connectionId: credential.connectionId,
      state: OperationState.FAILED,
      error: { code: "CONFLICT", message: "Native tree changed before navigation." }
    }));
    await expect(app.navigateTaskNativeTree(
      controls.authorityKey, tree, "native-alternate", false, ""
    )).resolves.toBe("rejected");
    expect(tree.activeEntryId).toBe("native-current");
    expect(saved.pending()).toEqual([]);

    vi.mocked(network.submit).mockResolvedValueOnce(create(OperationSchema, {
      operationId: "session-branch-2",
      connectionId: credential.connectionId,
      state: OperationState.SUCCEEDED
    }));
    await expect(app.navigateTaskNativeTree(
      app.taskNativeTreeControls()!.authorityKey,
      tree,
      "native-alternate",
      false,
      ""
    )).rejects.toThrow(/typed acknowledgement/u);
    expect(saved.pending()).toEqual([]);
  });
});

describe("native current-task Files ownership", () => {
  const revision = create(FileRevisionSchema, {
    opaqueRevision: "readme-1", sha256Hex: "a".repeat(64), byteSize: 6n,
    modifiedAt: { seconds: 10n, nanos: 2 }
  });
  const readme = create(WorkspaceEntrySchema, {
    workspaceId: "workspace", relativePath: "README.md", displayName: "README.md",
    kind: FileKind.REGULAR, mediaType: "text/markdown", revision
  });
  const sourceDirectory = create(WorkspaceEntrySchema, {
    workspaceId: "workspace", relativePath: "src", displayName: "src", kind: FileKind.DIRECTORY
  });
  const artifact = create(ArtifactSchema, {
    artifactId: "artifact-1", sessionId: "session", kind: ArtifactKind.FILE, title: "Report",
    blob: { blobId: "blob-1", fileName: "report.txt", mediaType: "text/plain", byteSize: 6n,
      sha256Hex: "b".repeat(64) }
  });

  const handoffSnapshot = create(SnapshotSchema, {
    ...attachmentSnapshot,
    snapshotId: "files-handoff-snapshot",
    backends: [create(BackendDescriptorSchema, {
      ...attachmentSnapshot.backends[0]!,
      capabilities: create(CapabilityManifestSchema, {
        schemaVersion: attachmentSnapshot.backends[0]!.capabilities?.schemaVersion ?? "1",
        revision: attachmentSnapshot.backends[0]!.capabilities?.revision,
        capabilities: [
          ...(attachmentSnapshot.backends[0]!.capabilities?.capabilities ?? []),
          create(CapabilitySchema, { name: capabilityNames.workspaceFiles, support: CapabilitySupport.SUPPORTED }),
          create(CapabilitySchema, { name: capabilityNames.workspaceFilesWatch, support: CapabilitySupport.SUPPORTED }),
          create(CapabilitySchema, {
            name: capabilityNames.inputMention,
            support: CapabilitySupport.SUPPORTED,
            options: create(CapabilityOptionsSchema, {
              kind: { case: "input", value: create(InputCapabilityOptionsSchema, {
                mediaTypes: ["workspace_file", "workspace_directory", "artifact"]
              }) }
            })
          })
        ]
      })
    })],
    targets: [create(TargetSchema, { ...attachmentSnapshot.targets[0]!, workspaceId: "workspace" })],
    sessions: [create(SessionSchema, {
      ...attachmentSnapshot.sessions[0]!,
      version: create(EntityVersionSchema, {
        generation: 8n,
        revision: create(RevisionSchema, { value: 9n, etag: "session-r9" })
      })
    })]
  });

  function configureFiles(network: MobileNetwork, projected: Snapshot = filesSnapshot): void {
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: projected });
    vi.mocked(network.readSession).mockResolvedValue(projected);
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspaceId, parentPath) => ({
      entries: parentPath === "" ? [sourceDirectory, readme] : [], revision: `directory:${parentPath || "root"}`
    }));
    vi.mocked(network.listWorkspaceFileIndex).mockResolvedValue({
      paths: ["README.md", "src/App.tsx"], revision: "index-1", truncated: false
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [artifact], revision: "artifacts-1" });
    vi.mocked(network.readWorkspaceFile).mockResolvedValue(create(FilePreviewSchema, {
      entry: readme,
      content: { case: "text", value: {
        utf8Text: "# Joko", languageId: "markdown", startByte: 0n, endByte: 6n, totalLines: 1
      } },
      truncated: false
    }));
  }

  it("opens only for an exact capable Session Workspace and carries the observed revision into preview", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();

    expect(app.canOpenFiles()).toBe(true);
    await app.openFiles();
    expect(app.state.files).toMatchObject({
      open: true,
      status: "ready",
      sessionId: "session",
      location: { kind: "workspace", path: "" },
      entries: [{ relativePath: "src" }, { relativePath: "README.md" }],
      fileIndex: ["README.md", "src/App.tsx"],
      artifacts: [{ artifactId: "artifact-1", sessionId: "session" }],
      watchStatus: "watching"
    });

    await app.searchFiles("report", "name", false);
    expect(app.state.files.searchResults).toMatchObject([{ kind: "artifact", artifact: { artifactId: "artifact-1" } }]);
    await app.searchFiles("readme", "name", false);
    expect(app.state.files.searchResults).toEqual([{ kind: "workspace-name", relativePath: "README.md" }]);
    await app.previewFileSearchResult(app.state.files.searchResults[0]!);

    expect(network.readWorkspaceFile).toHaveBeenCalledWith(
      credential, "workspace", "README.md", revision, expect.any(AbortSignal)
    );
    expect(app.state.files.preview).toMatchObject({
      kind: "text", text: "# Joko", languageId: "markdown", startByte: 0n, endByte: 6n,
      totalLines: 1, truncated: false
    });
  });

  it("materializes, revalidates, and system-shares one exact Workspace file", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const blob = create(BlobRefSchema, {
      blobId: "workspace-share-blob",
      fileName: "README.md",
      mediaType: "text/markdown",
      byteSize: 6n,
      sha256Hex: "a".repeat(64)
    });
    const materializedEntry = create(WorkspaceEntrySchema, {
      ...readme,
      revision: create(FileRevisionSchema, {
        ...revision,
        opaqueRevision: `sha256:${"a".repeat(64)}:6`
      })
    });
    vi.mocked(network.materializeWorkspaceFileBlob).mockResolvedValue({ entry: materializedEntry, blob });
    const authorized: AuthorizedBlobDownload = {
      url: "http://192.168.1.20:4318/v1/blobs/share-ticket",
      headers: { authorization: "Bearer private-key" },
      blobId: blob.blobId,
      fileName: blob.fileName,
      mediaType: blob.mediaType,
      byteSize: 6,
      sha256Hex: blob.sha256Hex
    };
    vi.mocked(network.authorizeBlobDownload).mockResolvedValue(authorized);
    const perform = vi.fn(async (request: Parameters<MobileFileShare["perform"]>[0]) => {
      request.onProgress?.({ phase: "downloading", bytesCompleted: 3, totalBytes: 6 });
      await request.assertCurrent();
      request.onDispatch?.();
    });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, { perform });
    await app.start();
    await app.openFiles();
    const progress = vi.fn();

    await app.shareFilesItem({ kind: "workspace-entry", entry: app.state.files.entries[1]! }, progress);

    expect(network.materializeWorkspaceFileBlob).toHaveBeenCalledWith(
      credential, "workspace", "README.md", revision, expect.any(AbortSignal)
    );
    expect(network.authorizeBlobDownload).toHaveBeenCalledWith(credential, blob, expect.any(AbortSignal));
    expect(perform).toHaveBeenCalledWith(expect.objectContaining({ source: authorized }));
    expect(progress).toHaveBeenCalledWith({ phase: "downloading", bytesCompleted: 3, totalBytes: 6 });
    expect(vi.mocked(network.listWorkspaceDirectory).mock.calls.filter((call) => call[2] === ""))
      .toHaveLength(3);
  });

  it("shares an exact Generated file and does not cancel after the native share sheet dispatches", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const authorized: AuthorizedBlobDownload = {
      url: "http://192.168.1.20:4318/v1/blobs/generated-ticket",
      headers: { authorization: "Bearer private-key" },
      blobId: artifact.blob!.blobId,
      fileName: artifact.blob!.fileName,
      mediaType: artifact.blob!.mediaType,
      byteSize: Number(artifact.blob!.byteSize),
      sha256Hex: artifact.blob!.sha256Hex
    };
    vi.mocked(network.authorizeBlobDownload).mockResolvedValue(authorized);
    let app!: MobileClient;
    const perform = vi.fn(async (request: Parameters<MobileFileShare["perform"]>[0]) => {
      await request.assertCurrent();
      request.onDispatch?.();
      app.setForeground(false);
    });
    app = client(network, memoryStorage(credential).storage, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, { perform });
    await app.start();
    await app.openFiles();

    await expect(app.shareFilesItem({ kind: "artifact", artifact: app.state.files.artifacts[0]! }))
      .resolves.toBeUndefined();

    expect(network.authorizeBlobDownload).toHaveBeenCalledWith(
      credential, artifact.blob, expect.any(AbortSignal)
    );
    expect(perform).toHaveBeenCalledTimes(1);
    expect(network.listSessionArtifacts).toHaveBeenCalledTimes(3);
  });

  it("aborts a pre-dispatch Workspace share when Files closes", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    vi.mocked(network.materializeWorkspaceFileBlob).mockImplementation(async (
      _credential, _workspaceId, _path, _revision, signal
    ) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const perform = vi.fn();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, { perform });
    await app.start();
    await app.openFiles();

    const sharing = app.shareFilesItem({ kind: "workspace-entry", entry: app.state.files.entries[1]! });
    await vi.waitFor(() => expect(network.materializeWorkspaceFileBlob).toHaveBeenCalled());
    app.closeFiles();

    await expect(sharing).rejects.toMatchObject({ name: "AbortError" });
    expect(perform).not.toHaveBeenCalled();
  });

  it("shares a bounded non-preview Timeline Artifact only while its durable event remains exact", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const event = timelinePreviewEvent("bundle.zip", "application/zip", bytes, "d".repeat(64), "Bundle");
    const network = projectedNetwork(timelineGallerySnapshot(event));
    vi.mocked(network.readAround).mockResolvedValue([event]);
    const rowArtifact = timelineRows([event])[0]!.artifacts![0]!;
    expect(rowArtifact.previewKind).toBeUndefined();
    const payload = event.payload?.kind;
    const block = payload?.case === "messageCompleted" ? payload.value.blocks[0] : undefined;
    const blob = block?.content.case === "artifact"
      ? block.content.value.blob!
      : undefined;
    expect(blob).toBeDefined();
    vi.mocked(network.authorizeBlobDownload).mockResolvedValue({
      url: "http://192.168.1.20:4318/v1/blobs/timeline-ticket",
      headers: { authorization: "Bearer private-key" },
      blobId: blob!.blobId,
      fileName: blob!.fileName,
      mediaType: blob!.mediaType,
      byteSize: Number(blob!.byteSize),
      sha256Hex: blob!.sha256Hex
    });
    const perform = vi.fn(async (request: Parameters<MobileFileShare["perform"]>[0]) => {
      await request.assertCurrent();
      request.onDispatch?.();
    });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, { perform });
    await app.start();

    await app.shareTimelineArtifact(rowArtifact);

    expect(network.readAround).toHaveBeenCalledTimes(2);
    expect(network.authorizeBlobDownload).toHaveBeenCalledWith(credential, blob, expect.any(AbortSignal));
    expect(perform).toHaveBeenCalledTimes(1);
  });

  it("materializes an authenticated Generated video into one app-owned preview lease and cleans it on background", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const bytes = previewMp4Bytes();
    const video = create(ArtifactSchema, {
      artifactId: "video-1",
      sessionId: "session",
      kind: ArtifactKind.FILE,
      title: "Demo video",
      blob: {
        blobId: "video-blob",
        fileName: "demo.mp4",
        mediaType: "video/mp4",
        byteSize: BigInt(bytes.byteLength),
        sha256Hex: "c".repeat(64),
        disposition: BlobDisposition.INLINE
      }
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [video], revision: "artifacts-video" });
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "video/mp4" });
    const media = mediaPreviewFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "media-lease-1", undefined, undefined, undefined, media.files);
    await app.start();
    await app.openFiles();

    await app.previewArtifact(app.state.files.artifacts[0]!);

    expect(app.state.files.preview).toMatchObject({
      kind: "media",
      mediaKind: "video",
      mediaType: "video/mp4",
      leaseId: "media-lease-1",
      uri: "file:///media/preview-media-lease-1.mp4",
      sha256Hex: "c".repeat(64)
    });
    expect(network.downloadBlob).toHaveBeenCalledWith(credential, video.blob, expect.any(AbortSignal));
    expect(media.driver.write).toHaveBeenCalledWith("preview-media-lease-1.mp4", bytes);

    app.setForeground(false);
    await vi.waitFor(() => expect(media.removed).toEqual(["preview-media-lease-1.mp4"]));
    expect(app.state.files.preview).toBeUndefined();
  });

  it("previews an exact Workspace audio Blob and rejects a mismatched container before cache write", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const audioRevision = create(FileRevisionSchema, {
      opaqueRevision: "audio-1",
      sha256Hex: "d".repeat(64),
      byteSize: BigInt(previewWavBytes.byteLength)
    });
    const audioEntry = create(WorkspaceEntrySchema, {
      workspaceId: "workspace",
      relativePath: "audio/voice.wav",
      displayName: "voice.wav",
      kind: FileKind.REGULAR,
      mediaType: "audio/wav",
      revision: audioRevision
    });
    const audioBlob = create(BlobRefSchema, {
      blobId: "audio-blob",
      fileName: "voice.wav",
      mediaType: "audio/wav",
      byteSize: BigInt(previewWavBytes.byteLength),
      sha256Hex: "d".repeat(64),
      disposition: BlobDisposition.INLINE
    });
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspaceId, parentPath) => ({
      entries: parentPath === "audio" ? [audioEntry] : [audioEntry],
      revision: `directory:${parentPath || "root"}`
    }));
    vi.mocked(network.listWorkspaceFileIndex).mockResolvedValue({
      paths: [audioEntry.relativePath], revision: "index-audio", truncated: false
    });
    vi.mocked(network.readWorkspaceFile).mockResolvedValue(create(FilePreviewSchema, {
      entry: audioEntry,
      content: { case: "blob", value: audioBlob }
    }));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes: previewWavBytes, mediaType: "audio/wav" });
    const media = mediaPreviewFixture("d".repeat(64));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "audio-lease", undefined, undefined, undefined, media.files);
    await app.start();
    await app.openFiles();

    await app.previewWorkspaceEntry(app.state.files.entries[0]!);
    expect(app.state.files.preview).toMatchObject({
      kind: "media", mediaKind: "audio", leaseId: "audio-lease", mediaType: "audio/wav"
    });

    app.closeFilesPreview();
    vi.mocked(network.downloadBlob).mockResolvedValue({
      bytes: new Uint8Array([0xff, 0xfb, 0x90, 0x64]),
      mediaType: "audio/wav"
    });
    await app.previewWorkspaceEntry(app.state.files.entries[0]!);
    expect(app.state.files.preview).toMatchObject({ kind: "error", reason: expect.stringMatching(/container/u) });
    expect(media.driver.write).toHaveBeenCalledTimes(1);
  });

  it("removes a late media file staged after Files closes and never adopts it into a later owner", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const bytes = previewMp4Bytes();
    const video = create(ArtifactSchema, {
      artifactId: "video-late",
      sessionId: "session",
      kind: ArtifactKind.FILE,
      title: "Late video",
      blob: {
        blobId: "video-late-blob",
        fileName: "late.mp4",
        mediaType: "video/mp4",
        byteSize: BigInt(bytes.byteLength),
        sha256Hex: "e".repeat(64),
        disposition: BlobDisposition.INLINE
      }
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [video], revision: "artifacts-video-late" });
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "video/mp4" });
    let resolveWrite!: (snapshot: MobileMediaPreviewFileSnapshot) => void;
    const media = mediaPreviewFixture("e".repeat(64), async () => new Promise((resolve) => { resolveWrite = resolve; }));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "late-media-lease", undefined, undefined, undefined, media.files);
    await app.start();
    await app.openFiles();

    const preview = app.previewArtifact(app.state.files.artifacts[0]!);
    await vi.waitFor(() => expect(media.driver.write).toHaveBeenCalled());
    app.closeFiles();
    resolveWrite({
      uri: "file:///media/preview-late-media-lease.mp4",
      fileName: "preview-late-media-lease.mp4",
      byteSize: bytes.byteLength,
      bytes
    });
    await preview;

    expect(app.state.files.open).toBe(false);
    expect(app.state.files.preview).toBeUndefined();
    expect(media.removed).toEqual(["preview-late-media-lease.mp4"]);
  });

  it("materializes an authenticated Generated PDF into an app-owned renderer lease and cleans it on background", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const bytes = previewPdfBytes();
    const artifact = create(ArtifactSchema, {
      artifactId: "pdf-1",
      sessionId: "session",
      kind: ArtifactKind.FILE,
      title: "Proof",
      blob: {
        blobId: "pdf-blob",
        fileName: "proof.pdf",
        mediaType: "application/pdf",
        byteSize: BigInt(bytes.byteLength),
        sha256Hex: "f".repeat(64),
        disposition: BlobDisposition.INLINE
      }
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [artifact], revision: "artifacts-pdf" });
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "application/pdf" });
    const pdf = pdfPreviewFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "pdf-lease-1", undefined, undefined, undefined, undefined, pdf.files);
    await app.start();
    await app.openFiles();

    await app.previewArtifact(app.state.files.artifacts[0]!);

    expect(app.state.files.preview).toMatchObject({
      kind: "pdf",
      mediaType: "application/pdf",
      leaseId: "pdf-lease-1",
      uri: "file:///pdf/preview-pdf-lease-1.pdf",
      fileName: "preview-pdf-lease-1.pdf",
      sha256Hex: "f".repeat(64)
    });
    expect(network.downloadBlob).toHaveBeenCalledWith(credential, artifact.blob, expect.any(AbortSignal));
    expect(pdf.driver.write).toHaveBeenCalledWith("preview-pdf-lease-1.pdf", bytes);

    app.setForeground(false);
    await vi.waitFor(() => expect(pdf.removed).toEqual(["preview-pdf-lease-1.pdf"]));
    expect(app.state.files.preview).toBeUndefined();
  });

  it("previews an exact Workspace PDF Blob and rejects malformed structure before cache write", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const bytes = previewPdfBytes();
    const pdfRevision = create(FileRevisionSchema, {
      opaqueRevision: "pdf-revision",
      sha256Hex: "f".repeat(64),
      byteSize: BigInt(bytes.byteLength)
    });
    const pdfEntry = create(WorkspaceEntrySchema, {
      workspaceId: "workspace",
      relativePath: "docs/proof.pdf",
      displayName: "proof.pdf",
      kind: FileKind.REGULAR,
      mediaType: "application/pdf",
      revision: pdfRevision
    });
    const pdfBlob = create(BlobRefSchema, {
      blobId: "workspace-pdf",
      fileName: "proof.pdf",
      mediaType: "application/pdf",
      byteSize: BigInt(bytes.byteLength),
      sha256Hex: "f".repeat(64),
      disposition: BlobDisposition.INLINE
    });
    vi.mocked(network.listWorkspaceDirectory).mockResolvedValue({ entries: [pdfEntry], revision: "directory-pdf" });
    vi.mocked(network.listWorkspaceFileIndex).mockResolvedValue({ paths: [pdfEntry.relativePath], revision: "index-pdf", truncated: false });
    vi.mocked(network.readWorkspaceFile).mockResolvedValue(create(FilePreviewSchema, {
      entry: pdfEntry,
      content: { case: "blob", value: pdfBlob }
    }));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "application/pdf" });
    const pdf = pdfPreviewFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "workspace-pdf-lease", undefined, undefined, undefined, undefined, pdf.files);
    await app.start();
    await app.openFiles();

    await app.previewWorkspaceEntry(app.state.files.entries[0]!);
    expect(app.state.files.preview).toMatchObject({ kind: "pdf", leaseId: "workspace-pdf-lease" });

    app.closeFilesPreview();
    vi.mocked(network.downloadBlob).mockResolvedValue({
      bytes: Uint8Array.from(bytes, (value, index) => index === 1 ? 0x58 : value),
      mediaType: "application/pdf"
    });
    await app.previewWorkspaceEntry(app.state.files.entries[0]!);
    expect(app.state.files.preview).toMatchObject({ kind: "error", reason: expect.stringMatching(/header/u) });
    expect(pdf.driver.write).toHaveBeenCalledTimes(1);
  });

  it("removes a late PDF staged after Files closes without adopting it", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const bytes = previewPdfBytes();
    const artifact = create(ArtifactSchema, {
      artifactId: "pdf-late",
      sessionId: "session",
      kind: ArtifactKind.FILE,
      title: "Late proof",
      blob: { blobId: "pdf-late-blob", fileName: "late.pdf", mediaType: "application/pdf",
        byteSize: BigInt(bytes.byteLength), sha256Hex: "f".repeat(64), disposition: BlobDisposition.INLINE }
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [artifact], revision: "artifacts-pdf-late" });
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "application/pdf" });
    let resolveWrite!: (snapshot: MobilePdfPreviewFileSnapshot) => void;
    const pdf = pdfPreviewFixture("f".repeat(64), async () => new Promise((resolve) => { resolveWrite = resolve; }));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "late-pdf-lease", undefined, undefined, undefined, undefined, pdf.files);
    await app.start();
    await app.openFiles();

    const preview = app.previewArtifact(app.state.files.artifacts[0]!);
    await vi.waitFor(() => expect(pdf.driver.write).toHaveBeenCalled());
    app.closeFiles();
    resolveWrite({ uri: "file:///pdf/preview-late-pdf-lease.pdf", fileName: "preview-late-pdf-lease.pdf",
      byteSize: bytes.byteLength, bytes });
    await preview;

    expect(app.state.files.open).toBe(false);
    expect(app.state.files.preview).toBeUndefined();
    expect(pdf.removed).toEqual(["preview-late-pdf-lease.pdf"]);
  });

  it("materializes an authenticated Generated glTF into one offline model lease", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const bytes = previewGltfBytes();
    const hash = sha256Hex(bytes);
    const artifact = create(ArtifactSchema, {
      artifactId: "model-generated",
      sessionId: "session",
      kind: ArtifactKind.FILE,
      title: "Generated scene",
      blob: { blobId: "model-generated-blob", fileName: "scene.gltf", mediaType: "model/gltf+json",
        byteSize: BigInt(bytes.byteLength), sha256Hex: hash, disposition: BlobDisposition.INLINE }
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [artifact], revision: "artifacts-model" });
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "model/gltf+json" });
    const model = modelPreviewFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "model-generated-lease", undefined, undefined, undefined, undefined, undefined, model.files);
    await app.start();
    await app.openFiles();

    await app.previewArtifact(app.state.files.artifacts[0]!);

    expect(app.state.files.preview).toMatchObject({
      kind: "model", modelKind: "gltf", leaseId: "model-generated-lease", modelPath: "scene.gltf",
      uri: "file:///model/preview-model-generated-lease.joko-model", files: [{ path: "scene.gltf" }]
    });
    expect(model.driver.write).toHaveBeenCalledOnce();
    app.setForeground(false);
    await vi.waitFor(() => expect(model.removed).toEqual(["preview-model-generated-lease.joko-model"]));
    expect(app.state.files.preview).toBeUndefined();
  });

  it("resolves exact same-Workspace glTF dependencies and revalidates every revision before adoption", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const modelBytes = previewGltfBytes({ bufferUri: "assets/mesh.bin", imageUri: "assets/texture.png" });
    const bufferBytes = Uint8Array.from([1, 2, 3, 4]);
    const imageBytes = galleryPngBytes(2, 2);
    const modelEntry = workspaceModelEntry("scene.gltf", "model/gltf+json", modelBytes, "model-r1");
    const bufferEntry = workspaceModelEntry("assets/mesh.bin", "application/octet-stream", bufferBytes, "buffer-r1");
    const imageEntry = workspaceModelEntry("assets/texture.png", "image/png", imageBytes, "image-r1");
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspaceId, parentPath) => ({
      entries: parentPath === "" ? [modelEntry] : parentPath === "assets" ? [bufferEntry, imageEntry] : [],
      revision: `directory:${parentPath || "root"}`
    }));
    vi.mocked(network.listWorkspaceFileIndex).mockResolvedValue({
      paths: [modelEntry.relativePath, bufferEntry.relativePath, imageEntry.relativePath],
      revision: "index-model", truncated: false
    });
    vi.mocked(network.readWorkspaceFile).mockImplementation(async (_credential, _workspaceId, path) => {
      const entry = path === modelEntry.relativePath ? modelEntry
        : path === bufferEntry.relativePath ? bufferEntry : imageEntry;
      const blobId = path === modelEntry.relativePath ? "workspace-model"
        : path === bufferEntry.relativePath ? "workspace-buffer" : "workspace-image";
      const blob = create(BlobRefSchema, {
        blobId, fileName: path.slice(path.lastIndexOf("/") + 1), mediaType: entry.mediaType,
        byteSize: entry.revision!.byteSize, sha256Hex: entry.revision!.sha256Hex,
        disposition: BlobDisposition.INLINE
      });
      return create(FilePreviewSchema, {
        entry,
        content: path === imageEntry.relativePath
          ? { case: "image", value: { blob, altText: "Texture" } }
          : { case: "blob", value: blob }
      });
    });
    vi.mocked(network.downloadBlob).mockImplementation(async (_credential, blob) => {
      if (blob.blobId === "workspace-model") return { bytes: modelBytes, mediaType: "model/gltf+json" };
      if (blob.blobId === "workspace-buffer") return { bytes: bufferBytes, mediaType: "application/octet-stream" };
      return { bytes: imageBytes, mediaType: "image/png" };
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [], revision: "artifacts-model" });
    const model = modelPreviewFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "workspace-model-lease", undefined, undefined, undefined, undefined, undefined, model.files);
    await app.start();
    await app.openFiles();

    await app.previewWorkspaceEntry(app.state.files.entries[0]!);

    expect(app.state.files.preview).toMatchObject({
      kind: "model", leaseId: "workspace-model-lease", modelPath: "scene.gltf",
      files: [
        { path: "scene.gltf", byteOffset: 0 },
        { path: "assets/mesh.bin" },
        { path: "assets/texture.png" }
      ],
      references: [
        { uri: "assets/mesh.bin", path: "assets/mesh.bin", kind: "buffer", fileIndex: 1 },
        { uri: "assets/texture.png", path: "assets/texture.png", kind: "image", fileIndex: 2 }
      ]
    });
    expect(network.readWorkspaceFile).toHaveBeenCalledWith(
      credential, "workspace", "assets/mesh.bin", bufferEntry.revision, expect.any(AbortSignal)
    );
    expect(network.readWorkspaceFile).toHaveBeenCalledWith(
      credential, "workspace", "assets/texture.png", imageEntry.revision, expect.any(AbortSignal)
    );
    expect(vi.mocked(network.listWorkspaceDirectory).mock.calls.filter((call) => call[2] === "")).toHaveLength(2);
    expect(vi.mocked(network.listWorkspaceDirectory).mock.calls.filter((call) => call[2] === "assets")).toHaveLength(3);
  });

  it("removes a staged Workspace model when its main revision drifts before adoption", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const bytes = previewGltfBytes();
    const stable = workspaceModelEntry("scene.gltf", "model/gltf+json", bytes, "model-r1");
    const changed = create(WorkspaceEntrySchema, {
      ...stable,
      revision: create(FileRevisionSchema, {
        opaqueRevision: "model-r2",
        sha256Hex: stable.revision!.sha256Hex,
        byteSize: stable.revision!.byteSize,
        modifiedAt: stable.revision!.modifiedAt
      })
    });
    let rootReads = 0;
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspaceId, parentPath) => ({
      entries: parentPath === "" ? [++rootReads === 1 ? stable : changed] : [],
      revision: `directory-${rootReads}`
    }));
    vi.mocked(network.listWorkspaceFileIndex).mockResolvedValue({ paths: [stable.relativePath],
      revision: "index-model", truncated: false });
    const blob = create(BlobRefSchema, { blobId: "workspace-model", fileName: "scene.gltf",
      mediaType: stable.mediaType, byteSize: stable.revision!.byteSize,
      sha256Hex: stable.revision!.sha256Hex, disposition: BlobDisposition.INLINE });
    vi.mocked(network.readWorkspaceFile).mockResolvedValue(create(FilePreviewSchema, {
      entry: stable, content: { case: "blob", value: blob }
    }));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "model/gltf+json" });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [], revision: "artifacts-model" });
    const model = modelPreviewFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "workspace-drift-lease", undefined, undefined, undefined, undefined, undefined, model.files);
    await app.start();
    await app.openFiles();

    await app.previewWorkspaceEntry(app.state.files.entries[0]!);

    expect(app.state.files.preview).toMatchObject({ kind: "error", reason: expect.stringMatching(/changed/u) });
    expect(model.removed).toEqual(["preview-workspace-drift-lease.joko-model"]);
  });

  it("previews an embedded durable Timeline glTF and rejects unattached external dependencies", async () => {
    const embedded = previewGltfBytes();
    const event = timelinePreviewEvent("scene.gltf", "model/gltf+json", embedded, sha256Hex(embedded), "Scene");
    const network = projectedNetwork(timelineGallerySnapshot(event));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes: embedded, mediaType: "model/gltf+json" });
    const model = modelPreviewFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "timeline-model-lease", undefined, undefined, undefined, undefined, undefined, model.files);
    await app.start();
    const artifact = timelineRows(app.state.detail?.timeline ?? [])[0]!.artifacts![0]!;

    await app.previewTimelineArtifact(artifact);
    expect(app.state.timelinePreview).toMatchObject({
      kind: "model", title: "Scene", leaseId: "timeline-model-lease", modelPath: "scene.gltf"
    });
    app.closeTimelinePreview();
    await vi.waitFor(() => expect(model.removed).toEqual(["preview-timeline-model-lease.joko-model"]));

    const external = previewGltfBytes({ bufferUri: "mesh.bin" });
    const externalEvent = timelinePreviewEvent(
      "external.gltf", "model/gltf+json", external, sha256Hex(external), "External scene"
    );
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: timelineGallerySnapshot(externalEvent) });
    vi.mocked(network.readSession).mockResolvedValue(timelineGallerySnapshot(externalEvent));
    await app.refresh();
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes: external, mediaType: "model/gltf+json" });
    const externalArtifact = timelineRows(app.state.detail?.timeline ?? [])[0]!.artifacts![0]!;
    await app.previewTimelineArtifact(externalArtifact);
    expect(app.state.timelinePreview).toMatchObject({
      kind: "error", reason: expect.stringMatching(/external dependency files are unavailable/u)
    });
    expect(model.driver.write).toHaveBeenCalledTimes(1);
  });

  it("previews an exact durable Timeline video and removes its lease when closed", async () => {
    const bytes = previewMp4Bytes();
    const event = timelinePreviewEvent("demo.mp4", "video/mp4", bytes, "c".repeat(64), "Demo video");
    const network = projectedNetwork(timelineGallerySnapshot(event));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "video/mp4" });
    const media = mediaPreviewFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "timeline-media-lease", undefined, undefined, undefined, media.files);
    await app.start();
    const artifact = timelineRows(app.state.detail?.timeline ?? [])[0]!.artifacts![0]!;

    await app.previewTimelineArtifact(artifact);

    expect(app.state.timelinePreview).toMatchObject({
      kind: "media",
      mediaKind: "video",
      title: "Demo video",
      leaseId: "timeline-media-lease",
      uri: "file:///media/preview-timeline-media-lease.mp4"
    });
    expect(network.downloadBlob).toHaveBeenCalledWith(
      credential,
      expect.objectContaining({ blobId: "timeline-demo.mp4", sha256Hex: "c".repeat(64) }),
      expect.any(AbortSignal)
    );
    app.closeTimelinePreview();
    await vi.waitFor(() => expect(media.removed).toEqual(["preview-timeline-media-lease.mp4"]));
    expect(app.state.timelinePreview).toBeUndefined();
  });

  it("previews an exact durable Timeline PDF and retires it on background", async () => {
    const bytes = previewPdfBytes();
    const event = timelinePreviewEvent("proof.pdf", "application/pdf", bytes, "f".repeat(64), "Proof");
    const network = projectedNetwork(timelineGallerySnapshot(event));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "application/pdf" });
    const pdf = pdfPreviewFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "timeline-pdf-lease", undefined, undefined, undefined, undefined, pdf.files);
    await app.start();
    const artifact = timelineRows(app.state.detail?.timeline ?? [])[0]!.artifacts![0]!;

    await app.previewTimelineArtifact(artifact);
    expect(app.state.timelinePreview).toMatchObject({
      kind: "pdf", title: "Proof", leaseId: "timeline-pdf-lease",
      uri: "file:///pdf/preview-timeline-pdf-lease.pdf"
    });

    app.setForeground(false);
    await vi.waitFor(() => expect(pdf.removed).toEqual(["preview-timeline-pdf-lease.pdf"]));
    expect(app.state.timelinePreview).toBeUndefined();
  });

  it("cleans a late Timeline stage after the exact source window changes", async () => {
    const bytes = previewMp4Bytes();
    const event = timelinePreviewEvent("late.mp4", "video/mp4", bytes, "e".repeat(64), "Late video");
    const replacement = timelinePreviewEvent("replacement.mp4", "video/mp4", bytes, "d".repeat(64), "Replacement");
    const network = projectedNetwork(timelineGallerySnapshot(event));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "video/mp4" });
    vi.mocked(network.readAround).mockResolvedValue([replacement]);
    let resolveWrite!: (snapshot: MobileMediaPreviewFileSnapshot) => void;
    const media = mediaPreviewFixture("e".repeat(64), async () => new Promise((resolve) => { resolveWrite = resolve; }));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "timeline-late-lease", undefined, undefined, undefined, media.files);
    await app.start();
    const artifact = timelineRows(app.state.detail?.timeline ?? [])[0]!.artifacts![0]!;

    const preview = app.previewTimelineArtifact(artifact);
    await vi.waitFor(() => expect(media.driver.write).toHaveBeenCalled());
    await app.around(event.eventId);
    resolveWrite({
      uri: "file:///media/preview-timeline-late-lease.mp4",
      fileName: "preview-timeline-late-lease.mp4",
      byteSize: bytes.byteLength,
      bytes
    });
    await preview;

    expect(app.state.timelinePreview).toBeUndefined();
    expect(media.removed).toEqual(["preview-timeline-late-lease.mp4"]);
  });

  it("adds an authenticated Workspace Blob as an exact-profile attachment without replacing structured draft state", async () => {
    const network = fakeNetwork();
    configureFiles(network, handoffSnapshot);
    const imageRevision = create(FileRevisionSchema, {
      opaqueRevision: "image-1", sha256Hex: "a".repeat(64), byteSize: 4n
    });
    const imageEntry = create(WorkspaceEntrySchema, {
      workspaceId: "workspace", relativePath: "images/pixel.png", displayName: "pixel.png",
      kind: FileKind.REGULAR, mediaType: "image/png", revision: imageRevision
    });
    const imageBlob = create(BlobRefSchema, {
      blobId: "workspace-image", fileName: "pixel.png", mediaType: "image/png", byteSize: 4n,
      sha256Hex: "a".repeat(64), disposition: BlobDisposition.INLINE
    });
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspaceId, parentPath) => ({
      entries: parentPath === "" ? [sourceDirectory, readme]
        : parentPath === "images" ? [imageEntry] : [],
      revision: `directory:${parentPath || "root"}`
    }));
    vi.mocked(network.listWorkspaceFileIndex).mockResolvedValue({
      paths: ["README.md", "images/pixel.png"], revision: "index-image", truncated: false
    });
    vi.mocked(network.readWorkspaceFile).mockResolvedValue(create(FilePreviewSchema, {
      entry: imageEntry,
      content: { case: "image", value: { blob: imageBlob, altText: "Pixel" } }
    }));
    vi.mocked(network.downloadBlob).mockResolvedValue({
      bytes: new Uint8Array([1, 1, 1, 1]), mediaType: "image/png"
    });
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const structured = insertMobileWorkspaceMention(
      plainTextMobileComposerDraft("Keep this"),
      { start: 9, end: 9 },
      { workspaceId: "workspace", relativePath: "README.md", displayText: "README.md", directory: false },
      "existing-reference"
    ).draft;
    const original: MobileComposerDraft = {
      ...structured,
      attachments: [{
        state: "local", attachmentId: "existing-file", kind: "file", fileName: "keep.pdf",
        mediaType: "application/pdf", byteSize: 1, sha256Hex: "b".repeat(64), capturedAtUnixMs: 1
      }]
    };
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    let sequence = 0;
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => `files-handoff-${++sequence}`, undefined, drafts, fixture.files);
    await app.start();
    await app.openFiles();
    await app.openFilesDirectory("images");

    await expect(app.addFilesItemToComposer({
      kind: "workspace-entry",
      entry: app.state.files.entries[0]!
    })).resolves.toBe("attachment");

    const retained = await drafts.composer.read(identity);
    expect(retained?.text).toBe(original.text);
    expect(retained?.mentions).toEqual(original.mentions);
    expect(retained?.attachments).toEqual([
      original.attachments[0],
      expect.objectContaining({
        state: "local", attachmentId: "files-handoff-1", kind: "image", fileName: "pixel.png",
        mediaType: "image/png", byteSize: 4, sha256Hex: "a".repeat(64)
      })
    ]);
    expect(fixture.driver.stageBytes).toHaveBeenCalledWith(
      credential.profileId, "files-handoff-1", new Uint8Array([1, 1, 1, 1])
    );
    expect(network.submit).not.toHaveBeenCalled();
    expect(network.uploadBlob).not.toHaveBeenCalled();
  });

  it("freezes a same-directory raster gallery and appends only its decoded authenticated page", async () => {
    const network = fakeNetwork();
    configureFiles(network, handoffSnapshot);
    const bytes = galleryPngBytes(3, 2);
    const firstRevision = create(FileRevisionSchema, {
      opaqueRevision: "image-a", sha256Hex: "b".repeat(64), byteSize: BigInt(bytes.byteLength)
    });
    const secondRevision = create(FileRevisionSchema, {
      opaqueRevision: "image-b", sha256Hex: "b".repeat(64), byteSize: BigInt(bytes.byteLength)
    });
    const entries = [
      create(WorkspaceEntrySchema, {
        workspaceId: "workspace", relativePath: "images/a.png", displayName: "a.png",
        kind: FileKind.REGULAR, mediaType: "image/png", revision: firstRevision
      }),
      create(WorkspaceEntrySchema, {
        workspaceId: "workspace", relativePath: "images/b.png", displayName: "b.png",
        kind: FileKind.REGULAR, mediaType: "image/png", revision: secondRevision
      }),
      create(WorkspaceEntrySchema, {
        workspaceId: "workspace", relativePath: "images/moving.gif", displayName: "moving.gif",
        kind: FileKind.REGULAR, mediaType: "image/gif", revision: firstRevision
      })
    ];
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspaceId, parentPath) => ({
      entries: parentPath === "" ? [sourceDirectory] : parentPath === "images" ? entries : [],
      revision: `directory:${parentPath || "root"}`
    }));
    vi.mocked(network.listWorkspaceFileIndex).mockResolvedValue({
      paths: entries.map((entry) => entry.relativePath), revision: "gallery-index", truncated: false
    });
    vi.mocked(network.readWorkspaceFile).mockImplementation(async (_credential, _workspaceId, relativePath, exactRevision) => {
      const entry = entries.find((candidate) => candidate.relativePath === relativePath)!;
      return create(FilePreviewSchema, {
        entry: create(WorkspaceEntrySchema, { ...entry, revision: exactRevision }),
        content: { case: "image", value: { blob: {
          blobId: `blob-${relativePath}`, fileName: entry.displayName, mediaType: entry.mediaType,
          byteSize: BigInt(bytes.byteLength), sha256Hex: "b".repeat(64), disposition: BlobDisposition.INLINE
        }, widthPixels: 3, heightPixels: 2, altText: entry.displayName } }
      });
    });
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/png" });
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(identity, plainTextMobileComposerDraft("Keep this text"));
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("gallery-lease", "gallery-load", "gallery-attachment"), undefined, drafts, fixture.files);
    await app.start();
    await app.openFiles();
    await app.openFilesDirectory("images");

    const descriptor = await app.openFilesImageGallery({ kind: "workspace-entry", entry: app.state.files.entries[1]! });
    expect(descriptor).toMatchObject({
      sourceKind: "workspace", initialIndex: 1,
      pages: [{ title: "a.png" }, { title: "b.png" }]
    });
    const page = await app.loadImageGalleryPage(descriptor.leaseId, descriptor.initialIndex);
    expect(page).toMatchObject({
      pageIndex: 1, pageCount: 2, expectedWidthPixels: 3, expectedHeightPixels: 2,
      addable: true, annotatable: true
    });
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, {
      width: 3, height: 2, mediaType: "image/png", isAnimated: false
    });
    const output = await app.prepareImageOutput(page.leaseId, {
      width: 3, height: 2, mediaType: "image/png", isAnimated: false
    });
    expect(output).toMatchObject({
      leaseId: page.leaseId,
      fileName: "b.png",
      mediaType: "image/png",
      byteSize: bytes.byteLength,
      sha256Hex: "b".repeat(64),
      width: 3,
      height: 2
    });
    expect(output.bytes).toEqual(bytes);
    const committed = await app.addImageGalleryPageToComposer(descriptor.leaseId, page.leaseId);

    expect(committed.text).toBe("Keep this text");
    expect(committed.attachments).toEqual([expect.objectContaining({
      state: "local", attachmentId: "gallery-attachment", kind: "image", fileName: "b.png",
      mediaType: "image/png", byteSize: bytes.byteLength, sha256Hex: "b".repeat(64)
    })]);
    expect(await drafts.composer.read(identity)).toEqual(committed);
    expect(fixture.driver.stageBytes).toHaveBeenCalledWith(
      credential.profileId, "gallery-attachment", bytes
    );
    await expect(app.addImageGalleryPageToComposer(descriptor.leaseId, page.leaseId))
      .rejects.toThrow(/no longer owns/u);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("freezes the current Generated catalog order and excludes non-raster and duplicate pages", async () => {
    const network = fakeNetwork();
    configureFiles(network, handoffSnapshot);
    const bytes = galleryPngBytes(3, 2);
    const first = create(ArtifactSchema, {
      artifactId: "generated-image-one", sessionId: "session", kind: ArtifactKind.IMAGE, title: "First generated image",
      blob: create(BlobRefSchema, {
        blobId: "generated-blob-one", fileName: "one.png", mediaType: "image/png",
        byteSize: BigInt(bytes.byteLength), sha256Hex: "b".repeat(64)
      })
    });
    const duplicate = create(ArtifactSchema, {
      artifactId: "generated-image-duplicate", sessionId: "session", kind: ArtifactKind.IMAGE, title: "First generated image duplicate",
      blob: create(BlobRefSchema, {
        blobId: "generated-blob-one", fileName: "duplicate.png", mediaType: "image/png",
        byteSize: BigInt(bytes.byteLength), sha256Hex: "b".repeat(64)
      })
    });
    const second = create(ArtifactSchema, {
      artifactId: "generated-image-two", sessionId: "session", kind: ArtifactKind.IMAGE, title: "Second generated image",
      blob: create(BlobRefSchema, {
        blobId: "generated-blob-two", fileName: "two.png", mediaType: "image/png",
        byteSize: BigInt(bytes.byteLength), sha256Hex: "b".repeat(64)
      })
    });
    const ignored = create(ArtifactSchema, {
      artifactId: "generated-text", sessionId: "session", kind: ArtifactKind.FILE, title: "Not an image",
      blob: create(BlobRefSchema, {
        blobId: "generated-text-blob", fileName: "notes.txt", mediaType: "text/plain",
        byteSize: 4n, sha256Hex: "c".repeat(64)
      })
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({
      artifacts: [first, duplicate, second, ignored], revision: "generated-gallery-r1"
    });
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/png" });
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(identity, plainTextMobileComposerDraft("Generated"));
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("generated-gallery", "generated-load", "generated-output"), undefined, drafts, fixture.files);
    await app.start();
    await app.openFiles();
    app.openGeneratedFiles();
    const selected = app.state.files.artifacts.find((candidate) => candidate.artifactId === second.artifactId)!;

    const descriptor = await app.openFilesImageGallery({ kind: "artifact", artifact: selected });
    expect(descriptor).toMatchObject({
      sourceKind: "generated", initialIndex: 1,
      pages: [{ title: "First generated image" }, { title: "Second generated image" }]
    });
    const page = await app.loadImageGalleryPage(descriptor.leaseId, descriptor.initialIndex);
    expect(page).toMatchObject({ fileName: "two.png", pageIndex: 1, pageCount: 2 });
  });

  it("appends a gallery annotation with an isolated source and refuses an unconfirmed decode", async () => {
    const network = fakeNetwork();
    configureFiles(network, handoffSnapshot);
    const bytes = galleryPngBytes(4, 3);
    const imageRevision = create(FileRevisionSchema, {
      opaqueRevision: "gallery-image", sha256Hex: "b".repeat(64), byteSize: BigInt(bytes.byteLength)
    });
    const imageEntry = create(WorkspaceEntrySchema, {
      workspaceId: "workspace", relativePath: "image.png", displayName: "image.png",
      kind: FileKind.REGULAR, mediaType: "image/png", revision: imageRevision
    });
    vi.mocked(network.listWorkspaceDirectory).mockResolvedValue({ entries: [imageEntry], revision: "gallery-directory" });
    vi.mocked(network.listWorkspaceFileIndex).mockResolvedValue({ paths: ["image.png"], revision: "gallery-index", truncated: false });
    vi.mocked(network.readWorkspaceFile).mockResolvedValue(create(FilePreviewSchema, {
      entry: imageEntry,
      content: { case: "image", value: { blob: {
        blobId: "gallery-blob", fileName: "image.png", mediaType: "image/png",
        byteSize: BigInt(bytes.byteLength), sha256Hex: "b".repeat(64), disposition: BlobDisposition.INLINE
      }, widthPixels: 4, heightPixels: 3 } }
    }));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/png" });
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(identity, plainTextMobileComposerDraft("Annotate"));
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("annotation-gallery", "annotation-load", "annotation-source", "annotation-output"),
      undefined, drafts, fixture.files);
    await app.start();
    await app.openFiles();
    const descriptor = await app.openFilesImageGallery({ kind: "workspace-entry", entry: app.state.files.entries[0]! });
    const page = await app.loadImageGalleryPage(descriptor.leaseId, 0);
    await expect(app.commitImageGalleryPageToComposer(
      descriptor.leaseId,
      page.leaseId,
      [{ points: [{ x: 0.25, y: 0.5 }] }],
      { bytes, mediaType: "image/png", width: 4, height: 3 }
    )).rejects.toThrow(/decoded gallery image/u);
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, {
      width: 4, height: 3, mediaType: "image/png"
    });

    const committed = await app.commitImageGalleryPageToComposer(
      descriptor.leaseId,
      page.leaseId,
      [{ points: [{ x: 0.25, y: 0.5 }] }],
      { bytes, mediaType: "image/png", width: 4, height: 3 }
    );

    expect(committed.attachments).toEqual([expect.objectContaining({
      attachmentId: "annotation-output",
      fileName: "image-annotated.png",
      annotation: {
        source: expect.objectContaining({ storageId: "annotation-source", fileName: "image.png" }),
        strokes: [{ points: [{ x: 0.25, y: 0.5 }] }]
      }
    })]);
    expect(fixture.driver.stageBytes).toHaveBeenNthCalledWith(1, credential.profileId, "annotation-source", bytes);
    expect(fixture.driver.stageBytes).toHaveBeenNthCalledWith(2, credential.profileId, "annotation-output", bytes);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("opens only the selected durable message gallery and appends its authenticated decoded page", async () => {
    const bytes = galleryPngBytes(5, 4);
    const accepted = acceptedTimelineGalleryEvent(bytes);
    const network = projectedNetwork(timelineGallerySnapshot(accepted));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/png" });
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(identity, plainTextMobileComposerDraft("Keep timeline draft"));
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("timeline-gallery", "timeline-load", "timeline-output"), undefined, drafts, fixture.files);
    await app.start();
    const row = timelineRows(app.state.detail?.timeline ?? [])[0]!;
    expect(row.images).toMatchObject([{ title: "First image" }, { title: "Second image" }]);

    const descriptor = await app.openTimelineImageGallery(row.eventId, row.images![1]!.pageId);
    expect(descriptor).toMatchObject({ sourceKind: "timeline", sourceLabel: "Your message", initialIndex: 1, pages: [{}, {}] });
    const page = await app.loadImageGalleryPage(descriptor.leaseId, descriptor.initialIndex);
    expect(page).toMatchObject({ fileName: "second.png", pageIndex: 1, pageCount: 2, addable: true, annotatable: true });
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, {
      width: 5, height: 4, mediaType: "image/png", isAnimated: false
    });
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, {
      width: 5, height: 4, mediaType: "image/png", isAnimated: false
    });

    const committed = await app.addImageGalleryPageToComposer(descriptor.leaseId, page.leaseId);
    expect(committed).toMatchObject({
      text: "Keep timeline draft",
      attachments: [{ attachmentId: "timeline-output", fileName: "second.png", kind: "image" }]
    });
    expect(network.downloadBlob).toHaveBeenCalledWith(
      credential,
      expect.objectContaining({ blobId: "timeline-image-two", sha256Hex: "b".repeat(64) }),
      undefined
    );
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("rejects gallery composer drift before staging managed bytes", async () => {
    const bytes = galleryPngBytes(5, 4);
    const completed = timelineGalleryEvent(bytes);
    const network = projectedNetwork(timelineGallerySnapshot(completed));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/png" });
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(identity, plainTextMobileComposerDraft("Original"));
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("drift-gallery", "drift-load", "must-not-stage"), undefined, drafts, fixture.files);
    await app.start();
    const row = timelineRows(app.state.detail?.timeline ?? [])[0]!;
    const descriptor = await app.openTimelineImageGallery(row.eventId, row.images![0]!.pageId);
    const page = await app.loadImageGalleryPage(descriptor.leaseId, 0);
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, {
      width: 5, height: 4, mediaType: "image/png"
    });
    const newer = plainTextMobileComposerDraft("Newer draft");
    drafts.composer.save(identity, newer);
    await drafts.composer.flush(identity);

    await expect(app.addImageGalleryPageToComposer(descriptor.leaseId, page.leaseId))
      .rejects.toThrow(/composer changed/u);
    expect(fixture.driver.stageBytes).not.toHaveBeenCalled();
    expect(await drafts.composer.read(identity)).toEqual(newer);
  });

  it("restores the exact draft and removes staged gallery bytes when durable flush fails", async () => {
    const bytes = galleryPngBytes(5, 4);
    const completed = timelineGalleryEvent(bytes);
    const network = projectedNetwork(timelineGallerySnapshot(completed));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/png" });
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const original = plainTextMobileComposerDraft("Retain me");
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("flush-gallery", "flush-load", "flush-output"), undefined, drafts, fixture.files);
    await app.start();
    const row = timelineRows(app.state.detail?.timeline ?? [])[0]!;
    const descriptor = await app.openTimelineImageGallery(row.eventId, row.images![0]!.pageId);
    const page = await app.loadImageGalleryPage(descriptor.leaseId, 0);
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, {
      width: 5, height: 4, mediaType: "image/png"
    });
    vi.spyOn(drafts.composer, "flush").mockRejectedValueOnce(new Error("durable write failed"));

    await expect(app.addImageGalleryPageToComposer(descriptor.leaseId, page.leaseId))
      .rejects.toThrow("durable write failed");
    expect(await drafts.composer.read(identity)).toEqual(original);
    expect(fixture.removed).toContain("flush-output");
    expect(fixture.bytes.has("flush-output")).toBe(false);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("does not adopt a late gallery download after the app backgrounds", async () => {
    const bytes = galleryPngBytes(5, 4);
    const completed = timelineGalleryEvent(bytes);
    const network = projectedNetwork(timelineGallerySnapshot(completed));
    let resolveDownload!: (value: { bytes: Uint8Array; mediaType: string }) => void;
    vi.mocked(network.downloadBlob).mockImplementation(() => new Promise((resolve) => { resolveDownload = resolve; }));
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(identity, plainTextMobileComposerDraft("Stay unchanged"));
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("late-gallery", "late-load", "late-output"), undefined, drafts, fixture.files);
    await app.start();
    const row = timelineRows(app.state.detail?.timeline ?? [])[0]!;
    const descriptor = await app.openTimelineImageGallery(row.eventId, row.images![0]!.pageId);
    const loading = app.loadImageGalleryPage(descriptor.leaseId, 0);
    await vi.waitFor(() => expect(network.downloadBlob).toHaveBeenCalledTimes(1));
    app.setForeground(false);
    resolveDownload({ bytes, mediaType: "image/png" });

    await expect(loading).rejects.toThrow();
    expect(fixture.driver.stageBytes).not.toHaveBeenCalled();
    expect(await drafts.composer.read(identity)).toEqual(plainTextMobileComposerDraft("Stay unchanged"));
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("falls back to validated Workspace and Artifact mentions without auto-sending", async () => {
    const network = fakeNetwork();
    configureFiles(network, handoffSnapshot);
    vi.mocked(network.listArtifactReferenceCatalog).mockResolvedValue({
      artifacts: [artifact], revision: "artifact-references-1"
    });
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(identity, plainTextMobileComposerDraft("Keep"));
    await drafts.composer.flush(identity);
    let sequence = 0;
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => `files-reference-${++sequence}`, undefined, drafts, attachmentFileFixture().files);
    await app.start();
    await app.openFiles();

    await expect(app.addFilesItemToComposer({
      kind: "workspace-entry",
      entry: app.state.files.entries.find((entry) => entry.relativePath === "src")!
    })).resolves.toBe("reference");
    await app.searchFiles("readme", "name", false);
    await expect(app.addFilesItemToComposer({
      kind: "search-result",
      result: app.state.files.searchResults[0]!
    })).resolves.toBe("reference");
    vi.mocked(network.searchWorkspace).mockResolvedValueOnce({
      matches: [create(WorkspaceSearchMatchSchema, {
        relativePath: "README.md", revision, linePreview: "# Joko"
      })],
      revision: "search-content-1",
      truncated: false,
      totalFiles: 1
    });
    await app.searchFiles("Joko", "content", false);
    await expect(app.addFilesItemToComposer({
      kind: "search-result",
      result: app.state.files.searchResults[0]!
    })).resolves.toBe("reference");
    await app.searchFiles("report", "name", false);
    await expect(app.addFilesItemToComposer({
      kind: "search-result",
      result: app.state.files.searchResults[0]!
    })).resolves.toBe("reference");

    const retained = await drafts.composer.read(identity);
    expect(retained?.text.startsWith("Keep")).toBe(true);
    expect(retained?.mentions.map((mention) => ({ kind: mention.kind, id: mention.mentionId }))).toEqual([
      { kind: "workspace", id: "files-reference-1" },
      { kind: "workspace", id: "files-reference-2" },
      { kind: "workspace", id: "files-reference-3" },
      { kind: "artifact", id: "files-reference-4" }
    ]);
    expect(retained?.attachments).toEqual([]);
    expect(network.downloadBlob).not.toHaveBeenCalled();
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("removes staged bytes and retains a concurrently changed draft when the Files CAS loses", async () => {
    const network = fakeNetwork();
    configureFiles(network, handoffSnapshot);
    const pdfArtifact = create(ArtifactSchema, {
      ...artifact,
      artifactId: "artifact-pdf",
      title: "Proof",
      blob: create(BlobRefSchema, {
        blobId: "blob-pdf", fileName: "proof.pdf", mediaType: "application/pdf", byteSize: 6n,
        sha256Hex: "b".repeat(64), disposition: BlobDisposition.ARTIFACT
      })
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [pdfArtifact], revision: "artifacts-pdf" });
    let resolveDownload!: (value: Awaited<ReturnType<MobileNetwork["downloadBlob"]>>) => void;
    vi.mocked(network.downloadBlob).mockImplementation(async () => new Promise((resolve) => {
      resolveDownload = resolve;
    }));
    const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(identity, plainTextMobileComposerDraft("Original"));
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "files-cas-attachment", undefined, drafts, fixture.files);
    await app.start();
    await app.openFiles();

    const adding = app.addFilesItemToComposer({ kind: "artifact", artifact: app.state.files.artifacts[0]! });
    await vi.waitFor(() => expect(network.downloadBlob).toHaveBeenCalled());
    drafts.composer.save(identity, plainTextMobileComposerDraft("Concurrent change"));
    await drafts.composer.flush(identity);
    resolveDownload({ bytes: new Uint8Array([2, 2, 2, 2, 2, 2]), mediaType: "application/pdf" });

    await expect(adding).rejects.toThrow(/composer changed/u);
    expect(await drafts.composer.read(identity)).toEqual(plainTextMobileComposerDraft("Concurrent change"));
    expect(fixture.removed).toEqual(["files-cas-attachment"]);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("rolls back the draft and removes staged bytes when durable draft storage fails", async () => {
    const network = fakeNetwork();
    configureFiles(network, handoffSnapshot);
    const pdfArtifact = create(ArtifactSchema, {
      ...artifact,
      artifactId: "artifact-storage",
      blob: create(BlobRefSchema, {
        blobId: "blob-storage", fileName: "storage.pdf", mediaType: "application/pdf", byteSize: 6n,
        sha256Hex: "b".repeat(64), disposition: BlobDisposition.ARTIFACT
      })
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [pdfArtifact], revision: "artifacts-storage" });
    vi.mocked(network.downloadBlob).mockResolvedValue({
      bytes: new Uint8Array([2, 2, 2, 2, 2, 2]), mediaType: "application/pdf"
    });
    const values = new Map<string, string>();
    let failNextWrite = false;
    const driver: MobilePlainStorageDriver = {
      async getItem(key) { return values.get(key) ?? null; },
      async setItem(key, value) {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("forced draft storage failure");
        }
        values.set(key, value);
      },
      async removeItem(key) { values.delete(key); }
    };
    const drafts = {
      values,
      newTask: new MobileNewTaskDraftStore(driver),
      composer: new MobileComposerDraftStore(driver)
    };
    const identity = { profileId: credential.profileId, sessionId: "session" };
    const original = plainTextMobileComposerDraft("Original durable draft");
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    failNextWrite = true;
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "files-storage-attachment", undefined, drafts, fixture.files);
    await app.start();
    await app.openFiles();

    await expect(app.addFilesItemToComposer({
      kind: "artifact", artifact: app.state.files.artifacts[0]!
    })).rejects.toThrow(/could not be written/u);

    expect(await drafts.composer.read(identity)).toEqual(original);
    expect(fixture.removed).toEqual(["files-storage-attachment"]);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("rejects Workspace revision, Generated catalog, and Blob-owner drift before changing the draft", async () => {
    const workspaceNetwork = fakeNetwork();
    configureFiles(workspaceNetwork, handoffSnapshot);
    vi.mocked(workspaceNetwork.searchWorkspace).mockResolvedValue({
      matches: [create(WorkspaceSearchMatchSchema, {
        relativePath: "README.md", revision, linePreview: "# Joko"
      })],
      revision: "search-before-drift",
      truncated: false,
      totalFiles: 1
    });
    const changedReadme = create(WorkspaceEntrySchema, {
      ...readme,
      revision: create(FileRevisionSchema, {
        ...revision,
        opaqueRevision: "readme-2",
        sha256Hex: "c".repeat(64)
      })
    });
    const workspaceDrafts = memoryDraftStores();
    const workspaceApp = client(workspaceNetwork, memoryStorage(credential).storage, undefined, undefined,
      () => "workspace-drift", undefined, workspaceDrafts, attachmentFileFixture().files);
    await workspaceApp.start();
    await workspaceApp.openFiles();
    await workspaceApp.searchFiles("Joko", "content", false);
    vi.mocked(workspaceNetwork.listWorkspaceDirectory).mockResolvedValue({
      entries: [sourceDirectory, changedReadme], revision: "directory-changed"
    });
    await expect(workspaceApp.addFilesItemToComposer({
      kind: "search-result", result: workspaceApp.state.files.searchResults[0]!
    })).rejects.toThrow(/search result changed/u);
    expect(await workspaceDrafts.composer.read({
      profileId: credential.profileId, sessionId: "session"
    })).toBeNull();

    const catalogNetwork = fakeNetwork();
    configureFiles(catalogNetwork, handoffSnapshot);
    const pdfArtifact = create(ArtifactSchema, {
      ...artifact,
      artifactId: "artifact-drift",
      blob: create(BlobRefSchema, {
        blobId: "blob-before", fileName: "drift.pdf", mediaType: "application/pdf", byteSize: 6n,
        sha256Hex: "b".repeat(64), disposition: BlobDisposition.ARTIFACT
      })
    });
    vi.mocked(catalogNetwork.listSessionArtifacts)
      .mockResolvedValueOnce({ artifacts: [pdfArtifact], revision: "artifacts-before" })
      .mockResolvedValueOnce({ artifacts: [pdfArtifact], revision: "artifacts-after" });
    const catalogApp = client(catalogNetwork, memoryStorage(credential).storage, undefined, undefined,
      () => "catalog-drift", undefined, memoryDraftStores(), attachmentFileFixture().files);
    await catalogApp.start();
    await catalogApp.openFiles();
    await expect(catalogApp.addFilesItemToComposer({
      kind: "artifact", artifact: catalogApp.state.files.artifacts[0]!
    })).rejects.toThrow(/Generated catalog changed/u);
    expect(catalogNetwork.downloadBlob).not.toHaveBeenCalled();

    const blobNetwork = fakeNetwork();
    configureFiles(blobNetwork, handoffSnapshot);
    const replacedArtifact = create(ArtifactSchema, {
      ...pdfArtifact,
      blob: create(BlobRefSchema, { ...pdfArtifact.blob!, blobId: "blob-after" })
    });
    vi.mocked(blobNetwork.listSessionArtifacts)
      .mockResolvedValueOnce({ artifacts: [pdfArtifact], revision: "artifacts-stable" })
      .mockResolvedValueOnce({ artifacts: [replacedArtifact], revision: "artifacts-stable" });
    const blobApp = client(blobNetwork, memoryStorage(credential).storage, undefined, undefined,
      () => "blob-drift", undefined, memoryDraftStores(), attachmentFileFixture().files);
    await blobApp.start();
    await blobApp.openFiles();
    await expect(blobApp.addFilesItemToComposer({
      kind: "artifact", artifact: blobApp.state.files.artifacts[0]!
    })).rejects.toThrow(/Generated file changed/u);
    expect(blobNetwork.downloadBlob).not.toHaveBeenCalled();
  });

  it("rejects a late Blob result after the selected task retires without staging or mutating a later draft", async () => {
    const network = fakeNetwork();
    configureFiles(network, handoffSnapshot);
    const pdfArtifact = create(ArtifactSchema, {
      ...artifact,
      artifactId: "artifact-late",
      blob: create(BlobRefSchema, {
        blobId: "blob-late", fileName: "late.pdf", mediaType: "application/pdf", byteSize: 6n,
        sha256Hex: "b".repeat(64), disposition: BlobDisposition.ARTIFACT
      })
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [pdfArtifact], revision: "artifacts-late" });
    let resolveDownload!: (value: Awaited<ReturnType<MobileNetwork["downloadBlob"]>>) => void;
    vi.mocked(network.downloadBlob).mockImplementation(async () => new Promise((resolve) => {
      resolveDownload = resolve;
    }));
    const drafts = memoryDraftStores();
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      () => "files-late-attachment", undefined, drafts, fixture.files);
    await app.start();
    await app.openFiles();

    const adding = app.addFilesItemToComposer({ kind: "artifact", artifact: app.state.files.artifacts[0]! });
    await vi.waitFor(() => expect(network.downloadBlob).toHaveBeenCalled());
    await app.select(undefined);
    resolveDownload({ bytes: new Uint8Array([2, 2, 2, 2, 2, 2]), mediaType: "application/pdf" });

    await expect(adding).rejects.toThrow(/authority changed/u);
    expect(fixture.driver.stageBytes).not.toHaveBeenCalled();
    expect(await drafts.composer.read({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
  });

  it("retires late directory and content-search results after foreground or Session ownership changes", async () => {
    const directoryNetwork = fakeNetwork();
    configureFiles(directoryNetwork);
    const directoryApp = client(directoryNetwork, memoryStorage(credential).storage);
    await directoryApp.start();
    await directoryApp.openFiles();
    let resolveDirectory!: (value: { entries: readonly WorkspaceEntry[]; revision: string }) => void;
    let directorySignal: AbortSignal | undefined;
    vi.mocked(directoryNetwork.listWorkspaceDirectory).mockImplementationOnce((_credential, _workspaceId, _path, signal) => {
      directorySignal = signal;
      return new Promise((resolve) => { resolveDirectory = resolve; });
    });
    const directoryRead = directoryApp.openFilesDirectory("src");
    await vi.waitFor(() => expect(directorySignal).toBeDefined());
    directoryApp.setForeground(false);
    expect(directorySignal?.aborted).toBe(true);
    resolveDirectory({ entries: [create(WorkspaceEntrySchema, {
      workspaceId: "workspace", relativePath: "src/late.ts", kind: FileKind.REGULAR,
      revision: { opaqueRevision: "late" }
    })], revision: "late-directory" });
    await directoryRead;
    expect(directoryApp.state.files.status).toBe("offline");
    expect(directoryApp.state.files.entries).toEqual([]);

    const searchNetwork = fakeNetwork();
    configureFiles(searchNetwork);
    const searchApp = client(searchNetwork, memoryStorage(credential).storage);
    await searchApp.start();
    await searchApp.openFiles();
    let resolveSearch!: (value: Awaited<ReturnType<MobileNetwork["searchWorkspace"]>>) => void;
    let searchSignal: AbortSignal | undefined;
    vi.mocked(searchNetwork.searchWorkspace).mockImplementationOnce((_credential, _workspaceId, _query, _caseSensitive, signal) => {
      searchSignal = signal;
      return new Promise((resolve) => { resolveSearch = resolve; });
    });
    const search = searchApp.searchFiles("late", "content", false);
    await vi.waitFor(() => expect(searchSignal).toBeDefined());
    await searchApp.select(undefined);
    expect(searchSignal?.aborted).toBe(true);
    resolveSearch({ matches: [], revision: "late-search", truncated: false, totalFiles: 0 });
    await search;
    expect(searchApp.state.files.authorityKey).toBeUndefined();
    expect(searchApp.state.files.searchResults).toEqual([]);
  });

  it("cancels Blob bytes on close and never adopts them into a later Files owner", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const imageArtifact = create(ArtifactSchema, {
      ...artifact,
      artifactId: "image-1",
      title: "Image",
      blob: { ...artifact.blob!, blobId: "image-blob", fileName: "image.png", mediaType: "image/png" }
    });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [imageArtifact], revision: "artifacts-image" });
    let resolveBlob!: (value: Awaited<ReturnType<MobileNetwork["downloadBlob"]>>) => void;
    let blobSignal: AbortSignal | undefined;
    vi.mocked(network.downloadBlob).mockImplementationOnce((_credential, _blob, signal) => {
      blobSignal = signal;
      return new Promise((resolve) => { resolveBlob = resolve; });
    });
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await app.openFiles();

    const preview = app.previewArtifact(app.state.files.artifacts[0]!);
    await vi.waitFor(() => expect(blobSignal).toBeDefined());
    app.closeFiles();
    expect(blobSignal?.aborted).toBe(true);
    resolveBlob({ bytes: new Uint8Array([1, 2, 3, 4, 5, 6]), mediaType: "image/png" });
    await preview;
    expect(app.state.files.open).toBe(false);
    expect(app.state.files.preview).toBeUndefined();
  });

  it("invalidates preview and refreshes current directory, index and Artifacts after a Workspace watch event", async () => {
    const network = fakeNetwork();
    configureFiles(network);
    const queued: WorkspaceFileChange[] = [];
    let wake: (() => void) | undefined;
    network.watchWorkspace = vi.fn(async function* (_credential, _workspaceId, signal) {
      while (!signal.aborted) {
        if (queued.length === 0) await new Promise<void>((resolve) => {
          wake = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
        if (signal.aborted) return;
        const change = queued.shift();
        if (change) yield change;
      }
    });
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await app.openFiles();
    await app.previewWorkspaceEntry(app.state.files.entries.find((entry) => entry.relativePath === "README.md")!);
    expect(app.state.files.preview?.kind).toBe("text");

    queued.push(create(WorkspaceFileChangeSchema, {
      workspaceId: "workspace", kind: WorkspaceFileChangeKind.MODIFIED, relativePath: "README.md",
      sequence: 1n, streamRevision: "watch-1"
    }));
    wake?.();
    wake = undefined;

    await vi.waitFor(() => expect(app.state.files.preview).toBeUndefined());
    await vi.waitFor(() => expect(network.listWorkspaceDirectory).toHaveBeenCalledTimes(2));
    expect(network.listWorkspaceFileIndex).toHaveBeenCalledTimes(2);
    expect(network.listSessionArtifacts).toHaveBeenCalledTimes(2);
  });
});
