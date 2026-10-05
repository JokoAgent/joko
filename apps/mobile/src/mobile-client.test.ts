import { clone, create, toBinary } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  AcknowledgementSchema, ArtifactKind, ArtifactSchema, BackendDescriptorSchema, BackendModelAccessSettingsSchema, BackendSettingsSchema, BlobDisposition, BlobRefSchema,
  CapabilityManifestSchema, CapabilityOptionsSchema, CapabilitySchema, CapabilitySupport, CompactSessionOutcome, ConnectionSchema, ConnectionState,
  ContextUsageSchema, DeviceKind, DevicePresenceState, DeviceSchema, EntityKind, EntityVersionSchema,
  FileKind, FilePreviewSchema, FileRevisionSchema, TargetSchema, WorkspaceDescriptorSchema, WorkspaceEntrySchema, WorkspaceFileChangeKind, WorkspaceFileChangeSchema,
  WorkspaceSearchMatchSchema, WorkspaceChangeSetSchema, WorkspaceRewindPreviewSchema, WorkspaceRewindResultSchema, RewindSafety, FileChangeKind,
  JOKO_API_VERSION, NativeEntryKind, NativeSessionBindingSchema, NativeSessionTreeNodeSchema, NativeSessionTreeSchema, OperationSchema,
  ListPartnerSessionsResponseSchema, PartnerSessionRole,
  InputCapabilityOptionsSchema, InteractionKind, InteractionSchema, InteractionState, PermissionDecisionKind, PermissionRisk, PlanReviewDecisionKind, ImageThumbnailSchema,
  EventCursorSchema, EventSchema, ImageRefSchema, MessageInputDelivery, MessageRole, ModelDescriptorSchema, ModelInputModality, ModelKeySchema, ModelOutputModality, ModelSelectionSchema,
  OperationMutationSchema, OperationState, OwnerSnapshotScopeSchema, PermissionMode,
  ProviderDescriptorSchema, ProviderKind, RevisionSchema, SessionMessageSearchMatchSchema, SessionSnapshotScopeSchema,
  SettingsSnapshotSchema, SnapshotScopeSchema, UsageSchema,
  VoiceInputServiceSettingsSchema, VoiceInputServiceSettingsPatchSchema, VoiceInputTranscriptionProtocol,
  VoiceInputSaucSettingsSchema, VoiceInputSaucMode, VoiceInputSaucAuthentication,
  QueueControlSchema, QueueDeliveryMode, QueueDispatchState, QueueItemSchema, QueueItemState, QueueSourceKind, ResourceKind,
  ReviewRunSchema, ReviewRunState, RuntimeCommandSchema, RuntimeCommandSource, SessionResourceSchema,
  RunState, ScheduleExecutionMode, ScheduleFireSource, ScheduleMisfirePolicy, ScheduleOverlapPolicy,
  ScheduleGeneratedSessionDisposition,
  ScheduleDeletionResultSchema, ScheduleRunCostAttribution, ScheduleRunHistorySchema, ScheduleRunOutcome, ScheduleRunPhase, ScheduleSchema,
  ScheduleSessionMode, ScheduleSource, ScheduleState, SchedulerRuntimeSnapshotSchema,
  SessionContextStateSchema, SessionDerivationKind, SessionDerivationOriginSchema, SessionMessageSearchSessionStatus, SessionSchema, SessionState, SnapshotSchema,
  SessionWorktreeSchema, TargetState, ToolCallOutputMode, WorkspaceKind, WorkspaceLocationSchema, capabilityNames, nativeSessionTreeWireFields
} from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileClient, type MobileStorage, type PendingOperation } from "./mobile-client";
import { MobileCredentialStorageError, profileFromCredential } from "./connection-storage";
import { producedArtifactEvent, producedImageEvent, toolMediaEvent } from "./test/timeline-media";
import { animatedPngBytes, gifBytes, svgBytes, bmpBytes, tiffBytes, isoImageBytes, iconBytes, iconDibBytes } from "./test/image-formats";
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
import { EMPTY_MOBILE_VOICE_DICTIONARY } from "./mobile-voice-dictionary";
import { dictionaryWatchFixture, idleDictionaryWatch } from "./test/voice-dictionary-watch";
import { readOnlyValue } from "./test/voice-dictionary-readonly";
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
  insertMobilePastedText,
  insertMobileStructuredClipboardText,
  insertMobileWorkspaceMention,
  mobileComposerInput,
  plainTextMobileComposerDraft,
  type MobileComposerDraft
} from "./mobile-composer-document";
import { createMobileAutomationDraft } from "./mobile-automation-authoring";
import { parseMobileNativeIntent } from "./mobile-native-intent";

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
    location: create(WorkspaceLocationSchema, { kind: { case: "serviceNode", value: {} } }),
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
    listPartners: vi.fn(async () => []),
    listPartnerSessions: vi.fn(async () => create(ListPartnerSessionsResponseSchema, { sessions: [] })),
    listPartnerPrivateThreads: vi.fn(async () => []),
    getPartnerPrivateThread: vi.fn(async () => { throw new Error("No private thread fixture was configured."); }),
    markPartnerPrivateThreadRead: vi.fn(async () => { throw new Error("No private read fixture was configured."); }),
    getMobilePushCapability: vi.fn(async () => ({ supported: true })),
    registerMobilePush: vi.fn(async (_credential, input) => ({
      registrationId: input.ticket.registrationId,
      connectionId: credential.connectionId,
      deviceId: credential.deviceId,
      environment: input.environment,
      locale: input.locale,
      expiresAt: Date.now() + 86_400_000,
      revision: 1n,
      ticket: input.ticket
    })),
    unregisterMobilePush: vi.fn(async () => undefined),
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
    listWorkspaceChangeSets: vi.fn(async () => []),
    previewWorkspaceRewind: vi.fn(async () => { throw new Error("No Workspace rewind fixture was configured."); }),
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
    readImageThumbnail: vi.fn(async () => undefined),
    authorizeBlobDownload: vi.fn(async () => { throw new Error("No Blob authorization fixture was configured."); }),
    uploadBlob: vi.fn(async () => { throw new Error("No Blob upload fixture was configured."); }),
    getVoiceInputCapabilities: vi.fn(async () => { throw new Error("No Voice capability fixture was configured."); }),
    getVoiceInputServiceSettings: vi.fn(async () => { throw new Error("No Voice settings fixture was configured."); }),
    uploadVoiceInputSecret: vi.fn(async () => "voice-ticket"),
    testVoiceInputConnection: vi.fn(async () => { throw new Error("No Voice settings fixture was configured."); }),
    getVoiceInputDictionary: vi.fn(async () => { throw new Error("No Voice dictionary fixture was configured."); }),
    getVoiceInputDictionaryReadOnly: vi.fn(async () => { throw new Error("No read-only dictionary fixture was configured."); }),
    watchVoiceInputDictionaryReadOnly: vi.fn((_credential: PairedCredential, signal: AbortSignal) => idleDictionaryWatch(signal)),
    watchVoiceInputDictionary: vi.fn((_credential: PairedCredential, signal: AbortSignal) => idleDictionaryWatch(signal)),
    getVoiceInputDictionaryPeerStatus: vi.fn(async () => { throw new Error("No dictionary sharing fixture was configured."); }),
    watchVoiceInputDictionaryPeerStatus: vi.fn((_credential: PairedCredential, signal: AbortSignal) => idleDictionaryWatch(signal)),
    grantVoiceInputDictionaryPeer: vi.fn(async () => { throw new Error("No dictionary sharing fixture was configured."); }),
    revokeVoiceInputDictionaryPeer: vi.fn(async () => { throw new Error("No dictionary sharing fixture was configured."); }),
    syncVoiceInputDictionaryNow: vi.fn(async () => { throw new Error("No dictionary sharing fixture was configured."); }),
    configureVoiceInputDictionaryListener: vi.fn(async () => { throw new Error("No dictionary sharing fixture was configured."); }),
    getVoiceInputDictionaryPeerInvitation: vi.fn(async () => { throw new Error("No dictionary sharing fixture was configured."); }),
    grantVoiceInputDictionaryDirectPeer: vi.fn(async () => { throw new Error("No dictionary sharing fixture was configured."); }),
    clearVoiceInputDictionaryPeerRoute: vi.fn(async () => { throw new Error("No dictionary sharing fixture was configured."); }),
    setVoiceInputDictionarySyncEnabled: vi.fn(async () => { throw new Error("No Voice dictionary fixture was configured."); }),
    addVoiceInputDictionaryTerms: vi.fn(async () => { throw new Error("No Voice dictionary fixture was configured."); }),
    editVoiceInputDictionaryEntry: vi.fn(async () => { throw new Error("No Voice dictionary fixture was configured."); }),
    deleteVoiceInputDictionaryEntry: vi.fn(async () => { throw new Error("No Voice dictionary fixture was configured."); }),
    applyVoiceInputDictionaryLearning: vi.fn(async () => { throw new Error("No Voice dictionary fixture was configured."); }),
    adviseVoiceInputDictionaryEdit: vi.fn(async () => ({ actions: [] })),
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

function localAttachmentDraft(text = "", imageBytes?: Uint8Array): MobileComposerDraft {
  return {
    ...plainTextMobileComposerDraft(text),
    attachments: [
      {
        state: "local",
        attachmentId: "image-one",
        kind: "image",
        fileName: "pixel.png",
        mediaType: "image/png",
        byteSize: imageBytes?.byteLength ?? 4,
        sha256Hex: (imageBytes ? "b" : "a").repeat(64),
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

function attachmentFileFixture(onRemove?: (attachmentId: string) => void, imageBytes?: Uint8Array) {
  const removed: string[] = [];
  const bytes = new Map<string, Uint8Array>([
    ["image-one", imageBytes ?? new Uint8Array([1, 1, 1, 1])],
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
const editorSourcePngBytes = galleryPngBytes(1, 1);

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

const timelineFileSources = [
  { kind: "message", project: (event: Event) => event },
  { kind: "tool", project: (event: Event) => toolMediaEvent(event) },
  { kind: "artifactProduced", project: producedArtifactEvent }
] as const;

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

function timelineToolAppendEvents(bytes: Uint8Array): readonly Event[] {
  const first = timelineGalleryEvent(bytes);
  const second = timelineGalleryEvent(bytes);
  if (first.payload?.kind.case !== "messageCompleted" || second.payload?.kind.case !== "messageCompleted") throw new Error("fixture");
  first.payload.kind.value.blocks = first.payload.kind.value.blocks.slice(1, 2);
  second.payload.kind.value.blocks = second.payload.kind.value.blocks.slice(2, 3);
  second.eventId = "timeline-appended-image";
  second.cursor!.sequence = 12n;
  return [toolMediaEvent(first, "toolCallStarted"), toolMediaEvent(second, "toolCallUpdated", ToolCallOutputMode.APPEND)];
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
  offlineCache?: Pick<MobileOfflineCache, "load" | "save" | "clear">,
  readOnlyDictionaryCache?: { clear(profileId: string): Promise<void> }
) {
  const instance = new MobileClient(network, storage, discovery ?? { scan: vi.fn(async () => []) }, newId, "android", now,
    clearInteractionDraft, drafts.newTask, drafts.composer, attachmentFiles, mediaPreviewFiles, pdfPreviewFiles,
    modelPreviewFiles, fileShare, offlineCache, readOnlyDictionaryCache);
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

function iosClient(network: MobileNetwork, storage: MobileStorage): MobileClient {
  const instance = new MobileClient(
    network,
    storage,
    { scan: vi.fn(async () => []) },
    () => "operation-1",
    "ios"
  );
  clients.push(instance);
  return instance;
}
afterEach(() => { for (const item of clients.splice(0)) item.dispose(); vi.useRealTimers(); });

describe("mobile Partner private authority", () => {
  it("revalidates a task preview against its exact canonical Partner Session and target participant", async () => {
    const network = fakeNetwork();
    network.listPartners = vi.fn(async () => [{ partnerId: "partner-a", displayName: "A", avatar: "standard",
      lifecycle: "active" as const, initializationState: "ready" as const, profileVersion: 1,
      canonicalSessionId: "session" }]);
    network.listPartnerSessions = vi.fn(async () => create(ListPartnerSessionsResponseSchema, {
      sessions: [{ partnerId: "partner-a", sessionId: "session", role: PartnerSessionRole.CANONICAL,
        available: true, readOnly: false, deleted: false, archived: false }]
    }));
    network.listPartnerPrivateThreads = vi.fn(async () => [{
      threadId: "private-thread", firstPartnerId: "partner-a", secondPartnerId: "partner-b",
      otherPartnerId: "partner-b", status: "active" as const, messageCount: 0, maxMessages: 12,
      createdAt: 1_000, updatedAt: 1_000, expiresAt: 900_000
    }]);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await app.openPartnerPrivateFromSession("session", "private-thread", "partner-c");
    expect(network.listPartnerSessions).toHaveBeenCalledWith(credential, "partner-a", expect.any(AbortSignal));
    expect(network.getPartnerPrivateThread).not.toHaveBeenCalled();
    expect(app.state.partnerPrivate.detailStatus).toBe("error");
  });

  it("opens authenticated detail without marking read and retires a late visible-read response on background", async () => {
    const network = fakeNetwork();
    const thread = {
      threadId: "private-thread", firstPartnerId: "partner-a", secondPartnerId: "partner-b",
      otherPartnerId: "partner-b", status: "active" as const, messageCount: 1, maxMessages: 12,
      createdAt: 1_000, updatedAt: 2_000, expiresAt: 900_000
    };
    const detail = {
      thread,
      messages: [{ messageId: "private-message", threadId: thread.threadId, sequence: 1,
        senderPartnerId: "partner-a", recipientPartnerId: "partner-b", content: "Private text",
        deliveryStatus: "pending" as const, createdAt: 2_000 }]
    };
    network.listPartners = vi.fn(async () => [{ partnerId: "partner-a", displayName: "A", avatar: "standard",
      lifecycle: "active" as const, initializationState: "ready" as const, profileVersion: 1,
      canonicalSessionId: "session" }]);
    network.listPartnerPrivateThreads = vi.fn(async () => [thread]);
    network.getPartnerPrivateThread = vi.fn(async () => detail);
    let resolveRead!: (value: Awaited<ReturnType<MobileNetwork["markPartnerPrivateThreadRead"]>>) => void;
    let readSignal: AbortSignal | undefined;
    network.markPartnerPrivateThreadRead = vi.fn((_credential, _partnerId, _threadId, _through, _maximum, signal) => {
      readSignal = signal;
      return new Promise<Awaited<ReturnType<MobileNetwork["markPartnerPrivateThreadRead"]>>>(
        (resolve) => { resolveRead = resolve; }
      );
    });
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await app.openPartnerDirectory();
    await app.selectPartnerPrivatePartner("partner-a");
    await app.openPartnerPrivateThread("partner-a", thread.threadId);
    expect(app.state.partnerPrivate.detail?.messages[0]?.content).toBe("Private text");
    expect(network.markPartnerPrivateThreadRead).not.toHaveBeenCalled();
    const mark = app.markPartnerPrivateVisible("partner-a", thread.threadId, 1);
    await vi.waitFor(() => expect(readSignal).toBeDefined());
    app.setForeground(false);
    expect(readSignal?.aborted).toBe(true);
    resolveRead({ threadId: thread.threadId, partnerId: "partner-a", throughSequence: 1, updatedAt: 3_000 });
    await mark;
    expect(app.state.partnerPrivate.detail).toBeUndefined();
    expect(app.state.partnerPrivate.status).toBe("offline");
  });
});

describe("native mobile push authority", () => {
  it("binds registration to the exact current iOS profile, Connection, Device revision, and late-response fence", async () => {
    const iosDevice = create(DeviceSchema, { ...device, platform: "ios" });
    const iosSnapshot = create(SnapshotSchema, { ...snapshot, devices: [iosDevice] });
    const network = fakeNetwork();
    network.readOwner = vi.fn(async () => ({ connection, device: iosDevice, snapshot: iosSnapshot }));
    network.readSession = vi.fn(async () => iosSnapshot);
    const saved = memoryStorage(credential);
    const app = iosClient(network, saved.storage);
    await app.start();

    const owner = app.mobilePushAuthority();
    expect(owner).toMatchObject({
      profileId: credential.profileId,
      origin: credential.origin,
      serverId: credential.serverId,
      connectionId: credential.connectionId,
      deviceId: credential.deviceId,
      deviceRevision: 5n
    });
    expect(await app.getMobilePushCapability(owner!)).toEqual({ supported: true });
    const ticket = { serverId: credential.serverId, registrationId: "registration-1", secret: "s".repeat(43) };
    await app.registerMobilePush(owner!, {
      environment: "sandbox",
      locale: "en",
      deviceToken: "native-token",
      ticket
    });
    expect(network.registerMobilePush).toHaveBeenLastCalledWith(credential, {
      expectedDeviceRevision: 5n,
      environment: "sandbox",
      locale: "en",
      deviceToken: "native-token",
      ticket
    }, undefined);

    let finish!: (value: Awaited<ReturnType<MobileNetwork["registerMobilePush"]>>) => void;
    network.registerMobilePush = vi.fn<MobileNetwork["registerMobilePush"]>(
      () => new Promise<Awaited<ReturnType<MobileNetwork["registerMobilePush"]>>>((resolve) => { finish = resolve; })
    );
    const late = app.registerMobilePush(owner!, {
      environment: "sandbox",
      locale: "ja",
      deviceToken: "rotated-token",
      ticket
    });
    await vi.waitFor(() => expect(network.registerMobilePush).toHaveBeenCalled());
    app.setForeground(false);
    finish({
      registrationId: ticket.registrationId,
      connectionId: credential.connectionId,
      deviceId: credential.deviceId,
      environment: "sandbox",
      locale: "ja",
      expiresAt: 99_999,
      revision: 2n,
      ticket
    });
    await expect(late).rejects.toThrow(/owner changed/u);
    await app.unregisterMobilePush(credential.origin, ticket);
    expect(network.unregisterMobilePush).toHaveBeenCalledWith(credential.origin, ticket, undefined);
  });
});

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
  it("reads a second paired dictionary with its exact proof and credential without replacing the active task, then cancels on background", async () => {
    const network = fakeNetwork();
    const remote = { ...otherCredential, origin: "http://192.168.1.21:4318", serverId: "node-2" };
    const saved = memoryStorage([credential, remote]);
    const remoteNode = { ...node, serverId: remote.serverId, displayName: "Office" };
    const remoteOwner = { connection: otherConnection, device: otherDevice,
      snapshot: create(SnapshotSchema, { ...snapshot, server: { ...snapshot.server!, serverId: remote.serverId },
        connections: [otherConnection], devices: [otherDevice] }) };
    vi.mocked(network.inspect).mockImplementation(async (origin) => origin === remote.origin ? remoteNode : node);
    vi.mocked(network.readOwner).mockImplementation(async (value) => value.serverId === remote.serverId ? remoteOwner : { connection, device, snapshot });
    vi.mocked(network.getVoiceInputDictionaryReadOnly).mockResolvedValue(readOnlyValue());
    const updates = dictionaryWatchFixture<ReturnType<typeof readOnlyValue>>();
    vi.mocked(network.watchVoiceInputDictionaryReadOnly).mockImplementation((_credential, signal) => updates.watch(signal));
    const app = client(network, saved.storage); await app.start();
    const active = app.state.owner; const selected = app.state.selectedId;
    const request = new AbortController();
    const transport = await app.voiceDictionaryReadOnlyTransport(remote.profileId, request.signal);
    expect(transport.profile.displayName).toBe("Office");
    expect(vi.mocked(network.inspect).mock.invocationCallOrder.at(-1)!).toBeLessThan(vi.mocked(saved.storage.loadCredential).mock.invocationCallOrder.at(-1)!);
    await expect(transport.getVoiceInputDictionaryReadOnly()).resolves.toEqual(readOnlyValue());
    expect(network.getVoiceInputDictionaryReadOnly).toHaveBeenCalledWith(remote, expect.any(AbortSignal));
    expect(app.state.owner).toBe(active); expect(app.state.selectedId).toBe(selected); expect(app.state.activeProfileId).toBe(credential.profileId);
    const iterator = transport.watchVoiceInputDictionaryReadOnly(request.signal)[Symbol.asyncIterator]();
    const initial = iterator.next(); updates.push(readOnlyValue()); await initial;
    const waiting = iterator.next(); const stopped = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    app.setForeground(false);
    expect(vi.mocked(network.watchVoiceInputDictionaryReadOnly).mock.calls[0]![1].aborted).toBe(true);
    await stopped; expect(updates.count).toBe(0); expect(transport.isCurrent()).toBe(false);
  });

  it("rejects an identity-drift dictionary source before protected reads and clears only that source cache", async () => {
    const network = fakeNetwork(); const saved = memoryStorage(credential, false);
    const clear = vi.fn(async (_profileId: string) => undefined);
    const app = client(network, saved.storage, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, { clear });
    await app.start(); vi.mocked(saved.storage.loadCredential).mockClear();
    vi.mocked(network.inspect).mockResolvedValue({ ...node, serverId: "drift" });
    await expect(app.voiceDictionaryReadOnlyTransport(credential.profileId, new AbortController().signal)).rejects.toThrow();
    expect(saved.storage.loadCredential).not.toHaveBeenCalled(); expect(network.getVoiceInputDictionaryReadOnly).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledExactlyOnceWith(credential.profileId);
    expect(app.state.saved[0]?.credentialState).toBe("identity-conflict"); expect(saved.key()).toEqual(credential);
  });

  it("rechecks a normally ended idle readonly stream, clears a revoked pair and retires a late GET without touching the active node", async () => {
    const network = fakeNetwork(); const saved = memoryStorage([credential, otherCredential]);
    const clear = vi.fn(async (_profileId: string) => undefined);
    const app = client(network, saved.storage, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, { clear });
    await app.start(); const active = app.state.owner;
    const updates = dictionaryWatchFixture<ReturnType<typeof readOnlyValue>>();
    vi.mocked(network.watchVoiceInputDictionaryReadOnly).mockImplementation((_credential, signal) => updates.watch(signal));
    vi.mocked(network.readOwner).mockImplementation(async (value) => value.profileId === otherCredential.profileId
      ? { connection: otherConnection, device: otherDevice, snapshot: create(SnapshotSchema, { ...snapshot, connections: [otherConnection], devices: [otherDevice] }) }
      : { connection, device, snapshot });
    const transport = await app.voiceDictionaryReadOnlyTransport(otherCredential.profileId, new AbortController().signal);
    let finish!: (value: ReturnType<typeof readOnlyValue>) => void;
    vi.mocked(network.getVoiceInputDictionaryReadOnly).mockImplementation(async () => await new Promise((resolve) => { finish = resolve; }));
    const reading = transport.getVoiceInputDictionaryReadOnly(); const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
    const iterator = transport.watchVoiceInputDictionaryReadOnly(new AbortController().signal)[Symbol.asyncIterator]();
    const initial = iterator.next(); updates.push(readOnlyValue()); await initial;
    vi.mocked(network.readOwner).mockImplementation(async (value) => {
      if (value.profileId === otherCredential.profileId) throw { code: Code.Unauthenticated };
      return { connection, device, snapshot };
    });
    const ended = iterator.next(); const revoked = expect(ended).rejects.toMatchObject({ code: Code.Unauthenticated });
    updates.end(); await revoked;
    finish(readOnlyValue(99n)); await rejected;
    expect(clear).toHaveBeenCalledExactlyOnceWith(otherCredential.profileId); expect(saved.key(otherCredential.profileId)).toBeUndefined();
    expect(saved.key()).toEqual(credential); expect(app.state.owner).toBe(active); expect(app.state.status).toBe("connected");
  });

  it("binds both dictionary streams to their original credential and cancels an idle stream on foreground retirement", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    const content = dictionaryWatchFixture<Awaited<ReturnType<MobileNetwork["getVoiceInputDictionary"]>>>();
    const peers = dictionaryWatchFixture<Awaited<ReturnType<MobileNetwork["getVoiceInputDictionaryPeerStatus"]>>>();
    vi.mocked(network.watchVoiceInputDictionary).mockImplementation((_credential, signal) => content.watch(signal));
    vi.mocked(network.watchVoiceInputDictionaryPeerStatus).mockImplementation((_credential, signal) => peers.watch(signal));
    await app.start();
    const api = app.voiceDictionaryTransport()!;
    const request = new AbortController();
    const dictionary = api.watchVoiceInputDictionary(request.signal)[Symbol.asyncIterator]();
    const sharing = api.watchVoiceInputDictionaryPeerStatus(request.signal)[Symbol.asyncIterator]();
    const firstDictionary = dictionary.next(); const firstSharing = sharing.next();
    const value = { revision: 4n, syncEnabled: true, dictionary: EMPTY_MOBILE_VOICE_DICTIONARY, refinementTerms: [] };
    const status = { available: true, configurationRevision: 3n, nodeId: "node-a", fingerprint: "a".repeat(64), enabled: true,
      phase: "waiting" as const, peers: [], candidates: [] };
    content.push(value); peers.push(status);
    await expect(firstDictionary).resolves.toEqual({ done: false, value });
    await expect(firstSharing).resolves.toEqual({ done: false, value: status });
    expect(network.watchVoiceInputDictionary).toHaveBeenCalledExactlyOnceWith(credential, expect.any(AbortSignal));
    expect(network.watchVoiceInputDictionaryPeerStatus).toHaveBeenCalledExactlyOnceWith(credential, expect.any(AbortSignal));
    const waitingDictionary = dictionary.next(); const rejectedDictionary = expect(waitingDictionary).rejects.toThrow(/authority changed|cancelled/u);
    const waitingSharing = sharing.next(); const rejectedSharing = expect(waitingSharing).rejects.toThrow(/authority changed|cancelled/u);
    app.setForeground(false);
    expect(vi.mocked(network.watchVoiceInputDictionary).mock.calls[0]![1]!.aborted).toBe(true);
    expect(vi.mocked(network.watchVoiceInputDictionaryPeerStatus).mock.calls[0]![1]!.aborted).toBe(true);
    await rejectedDictionary; await rejectedSharing;
    expect(content.count).toBe(0); expect(peers.count).toBe(0);
    app.setForeground(true);
    await vi.waitFor(() => expect(app.voiceDictionaryTransport()?.isCurrent()).toBe(true));
    expect(api.isCurrent()).toBe(false);
    await expect(api.watchVoiceInputDictionary(new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow(/authority changed/u);
    expect(network.watchVoiceInputDictionary).toHaveBeenCalledOnce();
  });
  it("binds voice settings to the node, uploads primary and fallback secrets before a durable public CAS operation", async () => {
    const network = fakeNetwork(); const saved = memoryStorage(credential); const app = client(network, saved.storage);
    const settings = create(VoiceInputServiceSettingsSchema, { protocol: VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC,
      fallbackProtocol: VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC, endpoint: "wss://speech.example/api/v3/sauc/bigmodel_async",
      fallbackEndpoint: "wss://fallback.example/api/v3/sauc/bigmodel_async", credentialConfigured: true,
      sauc: { mode: VoiceInputSaucMode.ASYNC_TWO_PASS, authentication: VoiceInputSaucAuthentication.API_KEY },
      fallbackSauc: { mode: VoiceInputSaucMode.ASYNC_TWO_PASS, authentication: VoiceInputSaucAuthentication.API_KEY }, version: { revision: { value: 4n } } });
    vi.mocked(network.getVoiceInputServiceSettings).mockResolvedValue(settings);
    await app.start(); const api = app.voiceInputSettingsTransport()!; await app.select("session");
    await expect(api.get()).resolves.toBe(settings); expect(api.isCurrent()).toBe(true); expect(api.ownerKey).not.toContain(credential.authKey);
    const patch = create(VoiceInputServiceSettingsPatchSchema, { expectedRevision: { value: 4n },
      sauc: { mode: VoiceInputSaucMode.STREAM_INPUT, authentication: VoiceInputSaucAuthentication.ACCESS_TOKEN, appId: "public-app" } });
    await expect(api.save(patch)).rejects.toThrow(/Replace or clear/u);
    await api.save(patch, { primary: "private-primary", fallback: "private-fallback" });
    expect(network.uploadVoiceInputSecret).toHaveBeenNthCalledWith(1, credential, "private-primary", false, expect.any(AbortSignal));
    expect(network.uploadVoiceInputSecret).toHaveBeenNthCalledWith(2, credential, "private-fallback", true, expect.any(AbortSignal));
    const mutation = vi.mocked(network.submit).mock.calls[0]![2];
    expect(mutation.payload).toMatchObject({ case: "updateVoiceInputServiceSettings", value: { patch: {
      expectedRevision: { value: 4n }, credentialUploadTicketId: "voice-ticket", fallbackCredentialUploadTicketId: "voice-ticket",
      sauc: { mode: VoiceInputSaucMode.STREAM_INPUT, authentication: VoiceInputSaucAuthentication.ACCESS_TOKEN, appId: "public-app" }
    } } });
    expect(JSON.stringify(vi.mocked(saved.storage.savePending).mock.calls)).not.toContain("private-");
    expect(new TextDecoder().decode(toBinary(OperationMutationSchema, mutation))).not.toContain("private-");
  });

  it("retains an unknown voice settings receipt and checks it without reuploading or resending the draft", async () => {
    const network = fakeNetwork(); const saved = memoryStorage(credential); const app = client(network, saved.storage);
    vi.mocked(network.getVoiceInputServiceSettings).mockResolvedValue(create(VoiceInputServiceSettingsSchema, {
      protocol: VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH, fallbackProtocol: VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH,
      version: { revision: { value: 4n } } }));
    vi.mocked(network.submit).mockRejectedValueOnce(new Error("connection lost"));
    await app.start(); const api = app.voiceInputSettingsTransport()!;
    const patch = create(VoiceInputServiceSettingsPatchSchema, { expectedRevision: { value: 4n }, enabled: true });
    await expect(api.save(patch, { primary: "private-value" })).rejects.toThrow(/unknown/u);
    expect(saved.pending()).toEqual([{ operationId: "operation-1", connectionId: credential.connectionId, kind: "voice-settings", state: "unknown" }]);
    await expect(api.save(patch, { primary: "private-value" })).rejects.toThrow(/receipt/u);
    expect(network.submit).toHaveBeenCalledOnce(); expect(network.uploadVoiceInputSecret).toHaveBeenCalledOnce();
    vi.mocked(network.getOperation).mockResolvedValue(create(OperationSchema, { operationId: "operation-1", connectionId: credential.connectionId, state: OperationState.SUCCEEDED }));
    await api.reconcile(); expect(saved.pending()).toHaveLength(0); expect(network.submit).toHaveBeenCalledOnce();
  });

  it("aborts an old voice settings upload on foreground retirement before any operation dispatch", async () => {
    const network = fakeNetwork(); const app = client(network, memoryStorage(credential).storage);
    vi.mocked(network.getVoiceInputServiceSettings).mockResolvedValue(create(VoiceInputServiceSettingsSchema, {
      protocol: VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH, fallbackProtocol: VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH,
      version: { revision: { value: 4n } } }));
    let release!: (value: string) => void;
    vi.mocked(network.uploadVoiceInputSecret).mockImplementation(async () => new Promise<string>((resolve) => { release = resolve; }));
    await app.start(); const api = app.voiceInputSettingsTransport()!;
    const save = api.save(create(VoiceInputServiceSettingsPatchSchema, { expectedRevision: { value: 4n } }), { primary: "private-value" });
    const rejected = expect(save).rejects.toThrow(/aborted|cancelled/u);
    await vi.waitFor(() => expect(network.uploadVoiceInputSecret).toHaveBeenCalledOnce());
    app.setForeground(false);
    expect(vi.mocked(network.uploadVoiceInputSecret).mock.calls[0]![3]!.aborted).toBe(true);
    release("voice-ticket"); await rejected; expect(network.submit).not.toHaveBeenCalled(); expect(api.isCurrent()).toBe(false);
  });

  it("binds dictionary reads and semantic mutations to a node owner independently of the selected task", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    const dictionary = { revision: 4n, syncEnabled: true, dictionary: { entries: [], candidates: [], suppressedAutomaticTexts: [] }, refinementTerms: [] };
    const methods = ["getVoiceInputDictionary", "setVoiceInputDictionarySyncEnabled", "addVoiceInputDictionaryTerms",
      "editVoiceInputDictionaryEntry", "deleteVoiceInputDictionaryEntry", "applyVoiceInputDictionaryLearning"] as const;
    for (const method of methods) vi.mocked(network[method]).mockResolvedValue(dictionary);
    const sharing = { available: true, configurationRevision: 3n, nodeId: "node-a", fingerprint: "a".repeat(64),
      enabled: true, phase: "waiting" as const, peers: [], candidates: [] };
    const sharingMethods = ["getVoiceInputDictionaryPeerStatus", "grantVoiceInputDictionaryPeer", "revokeVoiceInputDictionaryPeer", "syncVoiceInputDictionaryNow",
      "configureVoiceInputDictionaryListener", "grantVoiceInputDictionaryDirectPeer", "clearVoiceInputDictionaryPeerRoute"] as const;
    for (const method of sharingMethods) vi.mocked(network[method]).mockResolvedValue(sharing);
    const invitation = JSON.stringify({ version: 1, nodeId: "node-b", displayName: "Peer", publicKey: "MCowBQYDK2VuAyEA" + "A".repeat(43) + "=",
      fingerprint: "b".repeat(64), host: "peer.example", port: 43_121 });
    vi.mocked(network.getVoiceInputDictionaryPeerInvitation).mockResolvedValue(invitation);
    expect(app.voiceDictionaryTransport()).toBeUndefined();
    await app.start();
    const api = app.voiceDictionaryTransport()!;
    expect(api.ownerKey).not.toContain(credential.authKey);
    const request = new AbortController();
    await expect(api.getVoiceInputDictionary(request.signal)).resolves.toBe(dictionary);
    await app.select("session");
    expect(api.isCurrent()).toBe(true);
    await api.setVoiceInputDictionarySyncEnabled(4n, false, request.signal);
    await api.addVoiceInputDictionaryTerms(4n, ["Joko"], request.signal);
    await api.editVoiceInputDictionaryEntry(4n, "dictionary-one", "Joko Core", ["jo ko"], request.signal);
    await api.deleteVoiceInputDictionaryEntry(4n, "dictionary-one", request.signal);
    const actions = [{ action: "addCandidate", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high" }] as const;
    await api.applyVoiceInputDictionaryLearning(4n, actions, request.signal);
    expect(network.getVoiceInputDictionary).toHaveBeenCalledExactlyOnceWith(credential, request.signal);
    expect(network.setVoiceInputDictionarySyncEnabled).toHaveBeenCalledExactlyOnceWith(credential, 4n, false, request.signal);
    expect(network.addVoiceInputDictionaryTerms).toHaveBeenCalledExactlyOnceWith(credential, 4n, ["Joko"], request.signal);
    expect(network.editVoiceInputDictionaryEntry).toHaveBeenCalledExactlyOnceWith(credential, 4n, "dictionary-one", "Joko Core", ["jo ko"], request.signal);
    expect(network.deleteVoiceInputDictionaryEntry).toHaveBeenCalledExactlyOnceWith(credential, 4n, "dictionary-one", request.signal);
    expect(network.applyVoiceInputDictionaryLearning).toHaveBeenCalledExactlyOnceWith(credential, 4n, actions, request.signal);
    await expect(api.getVoiceInputDictionaryPeerStatus(request.signal)).resolves.toBe(sharing);
    await api.grantVoiceInputDictionaryPeer(3n, "node-b", "b".repeat(64), request.signal);
    await api.revokeVoiceInputDictionaryPeer("node-b", 2n, request.signal);
    await api.syncVoiceInputDictionaryNow(3n, "node-b", request.signal);
    await api.configureVoiceInputDictionaryListener(3n, { listenPort: 43_121, host: "self.example", port: 44_121 }, request.signal);
    await expect(api.getVoiceInputDictionaryPeerInvitation(request.signal)).resolves.toBe(invitation);
    await api.grantVoiceInputDictionaryDirectPeer(3n, invitation, "b".repeat(64), request.signal);
    await api.clearVoiceInputDictionaryPeerRoute(3n, "node-b", request.signal);
    expect(network.getVoiceInputDictionaryPeerStatus).toHaveBeenCalledExactlyOnceWith(credential, request.signal);
    expect(network.grantVoiceInputDictionaryPeer).toHaveBeenCalledExactlyOnceWith(credential, 3n, "node-b", "b".repeat(64), request.signal);
    expect(network.revokeVoiceInputDictionaryPeer).toHaveBeenCalledExactlyOnceWith(credential, "node-b", 2n, request.signal);
    expect(network.syncVoiceInputDictionaryNow).toHaveBeenCalledExactlyOnceWith(credential, 3n, "node-b", request.signal);
    expect(network.configureVoiceInputDictionaryListener).toHaveBeenCalledExactlyOnceWith(credential, 3n, { listenPort: 43_121, host: "self.example", port: 44_121 }, request.signal);
    expect(network.getVoiceInputDictionaryPeerInvitation).toHaveBeenCalledExactlyOnceWith(credential, request.signal);
    expect(network.grantVoiceInputDictionaryDirectPeer).toHaveBeenCalledExactlyOnceWith(credential, 3n, invitation, "b".repeat(64), request.signal);
    expect(network.clearVoiceInputDictionaryPeerRoute).toHaveBeenCalledExactlyOnceWith(credential, 3n, "node-b", request.signal);
    app.setForeground(false);
    expect(api.isCurrent()).toBe(false);
    await expect(api.addVoiceInputDictionaryTerms(4n, ["RetiredTerm"])).rejects.toThrow(/authority changed/u);
    expect(network.addVoiceInputDictionaryTerms).toHaveBeenCalledOnce();
    await expect(api.grantVoiceInputDictionaryPeer(3n, "retired", "c".repeat(64))).rejects.toThrow(/authority changed/u);
    expect(network.grantVoiceInputDictionaryPeer).toHaveBeenCalledOnce();
    await expect(api.clearVoiceInputDictionaryPeerRoute(3n, "node-b")).rejects.toThrow(/authority changed/u);
    expect(network.clearVoiceInputDictionaryPeerRoute).toHaveBeenCalledOnce();
    app.setForeground(true);
    await vi.waitFor(() => expect(app.voiceDictionaryTransport()?.isCurrent()).toBe(true));
    expect(api.isCurrent()).toBe(false);
  });

  it.each(["cancel", "generation", "revocation"] as const)("rejects a late dictionary projection after %s", async (change) => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const api = app.voiceDictionaryTransport()!;
    let finish!: (value: Awaited<ReturnType<MobileNetwork["getVoiceInputDictionary"]>>) => void;
    vi.mocked(network.getVoiceInputDictionary).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const request = new AbortController();
    const result = api.getVoiceInputDictionary(request.signal);
    if (change === "cancel") request.abort();
    else {
      const current = app.state.owner!;
      const updatedDevice = create(DeviceSchema, { ...device, revoked: change === "revocation" });
      const updated = create(SnapshotSchema, { ...current, generation: change === "generation" ? current.generation + 1n : current.generation,
        devices: [updatedDevice] });
      vi.mocked(network.readOwner).mockResolvedValue({ connection, device: updatedDevice, snapshot: updated });
      vi.mocked(network.readSession).mockResolvedValue(updated);
      await app.refresh();
    }
    finish({ revision: 4n, syncEnabled: true, dictionary: { entries: [], candidates: [], suppressedAutomaticTexts: [] }, refinementTerms: [] });
    await expect(result).rejects.toThrow(/authority changed|cancelled/u);
    if (change !== "cancel") {
      await expect(api.deleteVoiceInputDictionaryEntry(4n, "retired")).rejects.toThrow(/authority changed/u);
      expect(network.deleteVoiceInputDictionaryEntry).not.toHaveBeenCalled();
    }
  });

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
      supportsRefinement: true,
      supportsRecognitionContext: true, recognitionContextMaximumItems: 20,
      recognitionContextMaximumItemBytes: 2_048, recognitionContextMaximumBytes: 8_192, supportedLocales: []
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
    const refinement = { instructions: "Keep commands verbatim." };
    await expect(newTaskVoice!.start("request-one", "audio/pcm", "en-US", refinement)).resolves.toBe(voiceSession);
    expect(network.startVoiceInput).toHaveBeenCalledWith(
      credential,
      "request-one",
      "audio/pcm",
      "en-US",
      refinement,
      undefined
    );
    const adviceDraft = {
      beforeText: "voice kit",
      afterText: "VoiceKit",
      existingEntries: [],
      existingCandidates: []
    };
    await expect(newTaskVoice!.adviseVoiceInputDictionaryEdit(adviceDraft)).resolves.toEqual({ actions: [] });
    expect(network.adviseVoiceInputDictionaryEdit).toHaveBeenCalledWith(credential, adviceDraft, undefined);
    const dictionary = { revision: 3n, syncEnabled: true, dictionary: EMPTY_MOBILE_VOICE_DICTIONARY, refinementTerms: [] };
    vi.mocked(network.getVoiceInputDictionary).mockResolvedValue(dictionary);
    vi.mocked(network.applyVoiceInputDictionaryLearning).mockResolvedValue({ ...dictionary, revision: 4n });
    await expect(newTaskVoice!.getVoiceInputDictionary()).resolves.toBe(dictionary);
    await newTaskVoice!.applyVoiceInputDictionaryLearning(3n, []);
    expect(network.getVoiceInputDictionary).toHaveBeenCalledWith(credential, undefined);
    expect(network.applyVoiceInputDictionaryLearning).toHaveBeenCalledWith(credential, 3n, [], undefined);

    await app.select("session");
    const taskVoice = app.taskVoiceTransport();
    expect(taskVoice).toBeDefined();
    expect(taskVoice?.surfaceOwnerKey).not.toBe(newTaskVoice?.surfaceOwnerKey);
    app.setForeground(false);
    expect(taskVoice?.isCurrent()).toBe(false);
    await expect(taskVoice!.applyVoiceInputDictionaryLearning(3n, [])).rejects.toThrow(/authority changed/i);
    expect(network.applyVoiceInputDictionaryLearning).toHaveBeenCalledTimes(1);
    await expect(taskVoice!.get("voice-one")).rejects.toThrow(/authority changed/i);
    await expect(taskVoice!.cancel("voice-one")).resolves.toMatchObject({ outcome: "cancelled" });
    expect(network.getVoiceInputSession).not.toHaveBeenCalled();
    expect(network.cancelVoiceInput).toHaveBeenCalledWith(credential, "voice-one", undefined);

    let resolveInspection!: (identity: NodeIdentity) => void;
    vi.mocked(network.inspect).mockImplementationOnce(() => new Promise<NodeIdentity>((resolve) => {
      resolveInspection = resolve;
    }));
    const resumed = taskVoice!.waitUntilCurrent!();
    let resumedSettled = false;
    void resumed.then(() => { resumedSettled = true; });
    app.setForeground(true);
    expect(app.state.status).toBe("connecting");
    await Promise.resolve();
    expect(resumedSettled).toBe(false);
    resolveInspection(node);
    await expect(resumed).resolves.toBe(true);
    expect(taskVoice?.isCurrent()).toBe(true);
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

  it("retires a half-open observation and re-reads the exact active owner after a network path change", async () => {
    const network = fakeNetwork();
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    vi.mocked(network.inspect).mockClear();
    vi.mocked(network.readOwner).mockClear();

    app.notifyNetworkChanged();

    await vi.waitFor(() => expect(network.readOwner).toHaveBeenCalledOnce());
    expect(network.inspect).toHaveBeenCalledWith(credential.origin, expect.any(AbortSignal));
    expect(network.readOwner).toHaveBeenCalledWith(credential, expect.any(AbortSignal));
    expect(app.state.status).toBe("connected");
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

  it("exposes the exact send identity to presentation immediately before durable submit", async () => {
    const network = fakeNetwork();
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start();
    const draft = plainTextMobileComposerDraft("one visible message");
    const ownerKey = app.taskPresentationOwnerKey();
    expect(ownerKey).toBeTruthy();
    const order: string[] = [];
    vi.mocked(network.submit).mockImplementationOnce(async (_credential, operationId, mutation) => {
      order.push("submit");
      expect(operationId).toBe("visible-operation");
      expect(saved.pending()).toMatchObject([{ operationId: "visible-operation", kind: "send", state: "unknown" }]);
      return create(OperationSchema, {
        operationId,
        connectionId: credential.connectionId,
        state: OperationState.SUCCEEDED,
        mutation
      });
    });

    await expect(app.send(draft, {
      operationId: "visible-operation",
      onDispatch: (dispatched) => {
        order.push("presentation");
        expect(app.taskPresentationOwnerKey()).toBe(ownerKey);
        expect(dispatched).toEqual(draft);
        expect(saved.pending()).toEqual([]);
        expect(network.submit).not.toHaveBeenCalled();
      }
    })).resolves.toBe(true);

    expect(order).toEqual(["presentation", "submit"]);
    expect(app.taskPresentationOwnerKey()).toBe(ownerKey);
    expect(saved.pending()).toEqual([]);
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

  it.each(["cursor", "snapshot-only"] as const)("preserves a degraded polling connection with %s observations without treating it as live", async (mode) => {
    vi.useFakeTimers();
    const network = fakeNetwork();
    network.streamOwner = vi.fn(async function* () { throw new Error("stream transport unavailable"); });
    if (mode === "snapshot-only") {
      const projected = create(SnapshotSchema, { ...snapshot, resumeCursor: undefined });
      vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: projected });
      vi.mocked(network.readSession).mockResolvedValue(projected);
    }
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(app.state.liveStatus).toBe("polling");
    expect(app.state.status).toBe("connected");
    expect(app.state.live).toHaveLength(0);
    const observed: string[] = [];
    app.subscribe((state) => observed.push(state.status));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(observed).not.toContain("connecting");
    expect(app.state.status).toBe("connected");
    expect(network.inspect).toHaveBeenCalledTimes(2);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it.each(["identity", "api", "generation", "runtime", "revoked"] as const)("retires stale task resources when a scheduled snapshot detects %s drift", async (drift) => {
    vi.useFakeTimers();
    const network = fakeNetwork();
    network.streamOwner = vi.fn(async function* () { throw new Error("stream transport unavailable"); });
    vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: filesSnapshot });
    vi.mocked(network.readSession).mockResolvedValue(filesSnapshot);
    const saved = memoryStorage(credential);
    const app = client(network, saved.storage);
    await app.start(); await app.openFiles(); await vi.advanceTimersByTimeAsync(0);
    const authority = app.filesAuthorityKey();
    expect(authority).toBeDefined();
    vi.mocked(network.readOwner).mockClear(); vi.mocked(network.readSession).mockClear();
    if (drift === "identity" || drift === "api") {
      vi.mocked(network.inspect).mockResolvedValue({ ...node,
        ...(drift === "identity" ? { serverId: "different-node" } : { apiVersion: node.apiVersion + "-different" }) });
    } else if (drift === "revoked") vi.mocked(network.readOwner).mockRejectedValue({ code: Code.Unauthenticated });
    else {
      const next = create(SnapshotSchema, { ...filesSnapshot,
        ...(drift === "generation" ? { generation: 2n,
          resumeCursor: create(EventCursorSchema, { opaqueToken: "generation-2", generation: 2n, sequence: 1n }) }
          : { sessions: filesSnapshot.sessions.map((session) => create(SessionSchema, { ...session,
            nativeBinding: create(NativeSessionBindingSchema, { ...session.nativeBinding!,
              runtimeGeneration: session.nativeBinding!.runtimeGeneration + 1n }) })) }) });
      vi.mocked(network.readOwner).mockResolvedValue({ connection, device, snapshot: next });
      vi.mocked(network.readSession).mockResolvedValue(next);
    }
    await vi.advanceTimersByTimeAsync(4_000);
    expect(app.filesAuthorityKey()).not.toBe(authority);
    expect(app.state.files.status).not.toBe("ready");
    if (drift === "identity" || drift === "api") {
      expect(app.state.status).toBe("unpaired");
      expect(network.readOwner).not.toHaveBeenCalled(); expect(network.readSession).not.toHaveBeenCalled();
      expect(saved.storage.deleteCredential).not.toHaveBeenCalled();
    } else if (drift === "revoked") {
      expect(app.state.status).toBe("revoked"); expect(saved.storage.deleteCredential).toHaveBeenCalledWith(credential.profileId);
    }
    expect(network.submit).not.toHaveBeenCalled();
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
    const original = localAttachmentDraft("Keep the caption", editorSourcePngBytes);
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture(undefined, editorSourcePngBytes);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("image-source", "editor-one", "rendered-image", "editor-two", "restored-image"),
      undefined, drafts, fixture.files);
    await app.start();

    const editor = await app.openComposerImageEditor({ surface: "task", attachmentId: "image-one" });
    expect(editor).toMatchObject({
      previewUri: "file:///durable/mobile-profile/image-one",
      sourceBase64: Buffer.from(editorSourcePngBytes).toString("base64"),
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
              byteSize: editorSourcePngBytes.byteLength,
              sha256Hex: "b".repeat(64)
            },
            strokes: [stroke]
          }
        },
        original.attachments[1]
      ]
    });
    expect(await drafts.composer.read(identity)).toEqual(committed.draft);
    expect(fixture.bytes.get("image-source")).toEqual(editorSourcePngBytes);
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
        byteSize: editorSourcePngBytes.byteLength,
        sha256Hex: "b".repeat(64)
      },
      original.attachments[1]
    ]);
    expect(restored.draft.attachments[0]?.annotation).toBeUndefined();
    expect(fixture.bytes.has("image-source")).toBe(false);
    expect(fixture.bytes.get("restored-image")).toEqual(editorSourcePngBytes);
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
    const original = localAttachmentDraft("Keep one result", editorSourcePngBytes);
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture(undefined, editorSourcePngBytes);
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
    const original = localAttachmentDraft("Retry the render", editorSourcePngBytes);
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture(undefined, editorSourcePngBytes);
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
    const original = localAttachmentDraft("Keep after storage failure", editorSourcePngBytes);
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture(undefined, editorSourcePngBytes);
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
    const original = localAttachmentDraft("Original", editorSourcePngBytes);
    drafts.composer.save(identity, original);
    await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture(undefined, editorSourcePngBytes);
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
    const original = localAttachmentDraft("First input", editorSourcePngBytes);
    drafts.newTask.save(identity, { targetId: "target", name: "Annotated task", input: original });
    await drafts.newTask.flush(identity);
    const fixture = attachmentFileFixture(undefined, editorSourcePngBytes);
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
      bytes: editorSourcePngBytes,
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
        byteSize: editorSourcePngBytes.byteLength,
        sha256Hex: "b".repeat(64),
        capturedAtUnixMs: 100
      }]
    };
    drafts.composer.save(identity, uploaded);
    await drafts.composer.flush(identity);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined,
      fixedIds("uploaded-source", "uploaded-editor"), undefined, drafts, attachmentFileFixture().files);
    await app.start();

    const editor = await app.openComposerImageEditor({ surface: "task", attachmentId: "uploaded-image" });
    expect(editor.previewUri).toBe("data:image/png;base64," + Buffer.from(editorSourcePngBytes).toString("base64"));
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

describe("native current-task cloning", () => {
  function fixture() {
    const state = {
      session: runtimeSession,
      backend: create(BackendDescriptorSchema, { ...runtimeBackend, capabilities: create(CapabilityManifestSchema, {
        ...runtimeBackend.capabilities!, capabilities: [...runtimeBackend.capabilities!.capabilities,
          create(CapabilitySchema, { name: capabilityNames.sessionClone, support: CapabilitySupport.SUPPORTED })]
      }) }),
      reviews: [] as Snapshot["reviewRuns"],
      derived: undefined as Snapshot["sessions"][number] | undefined
    };
    const network = fakeNetwork();
    const projection = (detail: boolean) => create(SnapshotSchema, { ...runtimeControlProjection(state.session, detail),
      backends: [state.backend], reviewRuns: state.reviews,
      ...(!detail && state.derived ? { sessions: [state.session, state.derived] } : {}) });
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: projection(false) }));
    network.readSession = vi.fn(async () => projection(true));
    const child = () => create(SessionSchema, { ...runtimeSession, sessionId: "cloned-task",
      nativeBinding: create(NativeSessionBindingSchema, { ...runtimeSession.nativeBinding!, backendId: "backend", opaqueReference: "cloned-native" }),
      derivationOrigin: create(SessionDerivationOriginSchema, { kind: SessionDerivationKind.CLONE, sourceSessionId: "session" }) });
    const operation = (operationId: string, derived = child()) => create(OperationSchema, {
      operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED,
      result: { payload: { case: "session", value: derived } }
    });
    return { state, network, child, operation };
  }

  it("clones an active task through a preconditioned typed operation after saving a body-free receipt", async () => {
    const f = fixture();
    f.state.session = create(SessionSchema, { ...runtimeSession, state: SessionState.RUNNING });
    const saved = memoryStorage(credential);
    vi.mocked(f.network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      expect(saved.pending()).toEqual([{ operationId, connectionId: credential.connectionId,
        kind: "session-clone", sessionId: "session", state: "unknown" }]);
      expect(mutation).toMatchObject({ preconditions: [{ entity: { kind: EntityKind.SESSION, id: "session" },
        expectedGeneration: 8n, expectedRevision: { value: 9n } }],
      payload: { case: "cloneSession", value: { sourceSessionId: "session", newDisplayName: "My copy" } } });
      f.state.derived = f.child();
      return f.operation(operationId);
    });
    const app = client(f.network, saved.storage, undefined, undefined, () => "clone-operation");
    await app.start();
    expect(app.taskCloneControls()?.canClone).toBe(true);
    await expect(app.cloneTask(app.taskCloneControls()!.authorityKey, " My copy "))
      .resolves.toEqual({ kind: "cloned", sessionId: "cloned-task" });
    expect(saved.pending()).toEqual([]);
    expect(app.state.selectedId).toBe("session");
    expect(app.state.owner?.sessions.map((session) => session.sessionId)).toEqual(["session", "cloned-task"]);
  });

  it("blocks unsupported, duplicate capability, read-only, worktree and stale confirmation owners before dispatch", async () => {
    const f = fixture();
    const app = client(f.network, memoryStorage(credential).storage);
    await app.start();
    const key = app.taskCloneControls()!.authorityKey;
    f.state.backend.capabilities!.capabilities.push(create(CapabilitySchema, { name: capabilityNames.sessionClone, support: CapabilitySupport.SUPPORTED }));
    await app.refresh();
    expect(app.taskCloneControls()?.canClone).toBe(false);
    await expect(app.cloneTask(key, "Copy")).rejects.toThrow(/owner changed/u);
    f.state.backend.capabilities!.capabilities.pop();
    f.state.session = create(SessionSchema, { ...runtimeSession, worktree: create(SessionWorktreeSchema, { leaseId: "lease", workspaceId: "owned" }) });
    await app.refresh();
    expect(app.taskCloneControls()?.canClone).toBe(false);
    f.state.session = runtimeSession;
    f.state.reviews = [create(ReviewRunSchema, { reviewerSessionId: "session" })];
    await app.refresh();
    expect(app.taskCloneControls()?.canClone).toBe(false);
    f.state.reviews = [];
    f.state.backend.capabilities!.capabilities = f.state.backend.capabilities!.capabilities.filter((capability) => capability.name !== capabilityNames.sessionClone);
    await app.refresh();
    expect(app.taskCloneControls()?.canClone).toBe(false);
    expect(f.network.submit).not.toHaveBeenCalled();
  });

  it("retains unknown cloning across reconciliation and never dispatches a duplicate", async () => {
    const f = fixture();
    const saved = memoryStorage(credential);
    vi.mocked(f.network.submit).mockRejectedValue(new Error("response lost"));
    const app = client(f.network, saved.storage, undefined, undefined, () => "unknown-clone");
    await app.start();
    const key = app.taskCloneControls()!.authorityKey;
    await expect(app.cloneTask(key, "Copy")).resolves.toEqual({ kind: "unknown" });
    expect(saved.pending()).toMatchObject([{ kind: "session-clone", state: "unknown" }]);
    expect(app.taskCloneControls()?.canClone).toBe(false);
    await expect(app.cloneTask(key, "Again")).rejects.toThrow(/owner changed/u);
    vi.mocked(f.network.getOperation).mockResolvedValue(f.operation("unknown-clone"));
    await app.reconcile();
    expect(saved.pending()).toEqual([]);
    expect(f.network.submit).toHaveBeenCalledTimes(1);
  });

  it("refuses a foreign terminal Session and ignores a late result after background retirement", async () => {
    const f = fixture();
    const app = client(f.network, memoryStorage(credential).storage, undefined, undefined, fixedIds("bad-clone", "late-clone"));
    await app.start();
    const foreign = f.child();
    foreign.derivationOrigin!.sourceSessionId = "foreign";
    vi.mocked(f.network.submit).mockResolvedValueOnce(f.operation("bad-clone", foreign));
    await expect(app.cloneTask(app.taskCloneControls()!.authorityKey, "Copy")).rejects.toThrow(/derived Session identity/u);
    let finish!: (operation: Operation) => void;
    vi.mocked(f.network.submit).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = app.cloneTask(app.taskCloneControls()!.authorityKey, "Late copy");
    await vi.waitFor(() => expect(f.network.submit).toHaveBeenCalledTimes(2));
    app.setForeground(false);
    finish(f.operation("late-clone"));
    await expect(pending).resolves.toEqual({ kind: "retired" });
    expect(app.state.selectedId).toBe("session");
  });
});

describe("native derivation origin navigation", () => {
  function fixture() {
    const state = {
      child: create(SessionSchema, { ...runtimeSession, nativeBinding: create(NativeSessionBindingSchema, {
        backendId: "backend", opaqueReference: "child-native", runtimeGeneration: 8n }),
        derivationOrigin: create(SessionDerivationOriginSchema, { kind: SessionDerivationKind.FORK, sourceSessionId: "source", sourceMessageId: "origin-message",
          sourceEventId: "origin-event", sourceSessionAvailable: true, sourceMessageAvailable: true }) }),
      source: create(SessionSchema, { ...runtimeSession, sessionId: "source", nativeBinding: create(NativeSessionBindingSchema, {
        backendId: "backend", opaqueReference: "source-native", runtimeGeneration: 21n }) })
    };
    const network = fakeNetwork();
    const owner = () => clone(SnapshotSchema, create(SnapshotSchema, { ...runtimeControlProjection(state.child), sessions: [state.child, state.source] }));
    const detail = (id: string) => clone(SnapshotSchema, create(SnapshotSchema, { ...runtimeControlProjection(state.child, true),
      scope: create(SnapshotScopeSchema, { kind: { case: "session", value: { sessionId: id } } }),
      sessions: [id === "session" ? state.child : state.source] }));
    const event = create(EventSchema, { eventId: "origin-event", identity: { sessionId: "source" },
      cursor: { opaqueToken: "origin-cursor", generation: 1n, sequence: 20n },
      payload: { kind: { case: "messageCompleted", value: { messageId: "origin-message", role: MessageRole.ASSISTANT } } } });
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: owner() }));
    network.readSession = vi.fn(async (_credential, id) => detail(id));
    network.readAround = vi.fn(async () => [event]);
    return { state, network, event, owner, detail };
  }

  it("reauthorizes a fork message or clone source with current generated reads and an exact profile handoff without changing drafts or dispatching", async () => {
    const f = fixture(); const saved = memoryStorage(credential); const drafts = memoryDraftStores();
    const input = plainTextMobileComposerDraft("retained source draft");
    await drafts.composer.save({ profileId: credential.profileId, sessionId: "source" }, input);
    const app = client(f.network, saved.storage, undefined, undefined, undefined, undefined, drafts);
    await app.start();
    expect(app.state).toMatchObject({ status: "connected", selectedId: "session" });
    const saveCalls = vi.mocked(saved.storage.saveSelection).mock.calls.length;
    expect(app.taskDerivationOriginControls()?.canOpen).toBe(true);
    const url = await app.prepareTaskDerivationOrigin(app.taskDerivationOriginControls()!.authorityKey!);
    expect(parseMobileNativeIntent(url)).toEqual({ kind: "session", profileId: credential.profileId,
      sessionId: "source", messageId: "origin-message", messageEventId: "origin-event" });
    expect(f.network.readAround).toHaveBeenCalledExactlyOnceWith(credential, "source", "origin-event", expect.any(AbortSignal));
    expect(app.state.selectedId).toBe("session"); expect(saved.pending()).toEqual([]);
    expect(saved.storage.saveSelection).toHaveBeenCalledTimes(saveCalls);
    expect(await drafts.composer.read({ profileId: credential.profileId, sessionId: "source" })).toEqual(input);
    expect(f.network.submit).not.toHaveBeenCalled();
    const accepted = create(EventSchema, { eventId: f.event.eventId, identity: f.event.identity, cursor: f.event.cursor,
      payload: { kind: { case: "messageStarted", value: { messageId: "origin-message", role: MessageRole.USER,
        userInputAccepted: true, nativeIdentity: { entryId: "user-entry" } } } } });
    const completed = create(EventSchema, { eventId: "completed-origin", identity: f.event.identity,
      cursor: { opaqueToken: "completed-cursor", generation: 1n, sequence: 21n },
      payload: { kind: { case: "messageCompleted", value: { messageId: "origin-message", role: MessageRole.USER,
        nativeIdentity: { entryId: "user-entry" } } } } });
    vi.mocked(f.network.readAround).mockResolvedValueOnce([accepted, completed]);
    expect(parseMobileNativeIntent(await app.prepareTaskDerivationOrigin(app.taskDerivationOriginControls()!.authorityKey!)))
      .toMatchObject({ messageId: "origin-message", messageEventId: "completed-origin" });
    const conflicting = clone(EventSchema, completed);
    if (conflicting.payload?.kind.case === "messageCompleted") conflicting.payload.kind.value.nativeIdentity!.entryId = "different-user";
    vi.mocked(f.network.readAround).mockResolvedValueOnce([accepted, conflicting]);
    expect(await app.prepareTaskDerivationOrigin(app.taskDerivationOriginControls()!.authorityKey!)).toBeUndefined();
    f.state.child.derivationOrigin = create(SessionDerivationOriginSchema, { kind: SessionDerivationKind.CLONE,
      sourceSessionId: "source", sourceSessionAvailable: true });
    await app.refresh(); vi.mocked(f.network.readAround).mockClear();
    const cloneUrl = await app.prepareTaskDerivationOrigin(app.taskDerivationOriginControls()!.authorityKey!);
    expect(parseMobileNativeIntent(cloneUrl)).toEqual({ kind: "session", profileId: credential.profileId, sessionId: "source" });
    expect(f.network.readAround).not.toHaveBeenCalled();
  });

  it("refuses missing, ambiguous or wrong message Events and service availability revoked during authenticated around", async () => {
    const f = fixture(); const app = client(f.network, memoryStorage(credential).storage);
    await app.start(); const key = app.taskDerivationOriginControls()!.authorityKey!;
    const foreign = clone(EventSchema, f.event); foreign.identity!.sessionId = "foreign";
    const wrong = clone(EventSchema, f.event);
    if (wrong.payload?.kind.case === "messageCompleted") wrong.payload.kind.value.messageId = "wrong";
    const unaccepted = create(EventSchema, { eventId: f.event.eventId, identity: f.event.identity, cursor: f.event.cursor,
      payload: { kind: { case: "messageStarted", value: { messageId: "origin-message", role: MessageRole.USER } } } });
    for (const events of [[], [f.event, f.event], [foreign], [wrong], [unaccepted]]) {
      vi.mocked(f.network.readAround).mockResolvedValueOnce(events);
      try { expect(await app.prepareTaskDerivationOrigin(key)).toBeUndefined(); }
      catch (error) { expect(String(error)).toMatch(/mismatched or cyclic/u); }
    }
    vi.mocked(f.network.readAround).mockImplementationOnce(async () => {
      f.state.child.derivationOrigin!.sourceMessageAvailable = false; return [f.event];
    });
    expect(await app.prepareTaskDerivationOrigin(key)).toBeUndefined();
    expect(app.state.selectedId).toBe("session"); expect(f.network.submit).not.toHaveBeenCalled();
  });

  it("rejects foreign owner and native generation drift instead of trusting saved lineage identity", async () => {
    const f = fixture(); const app = client(f.network, memoryStorage(credential).storage);
    await app.start(); const key = app.taskDerivationOriginControls()!.authorityKey!;
    vi.mocked(f.network.readOwner).mockResolvedValueOnce({ connection, device,
      snapshot: create(SnapshotSchema, { ...f.owner(), server: { ...f.owner().server!, serverId: "foreign-node" } }) });
    await expect(app.prepareTaskDerivationOrigin(key)).rejects.toThrow(/node identity/u);
    vi.mocked(f.network.readSession).mockResolvedValueOnce(create(SnapshotSchema, { ...f.detail("session"),
      scope: create(SnapshotScopeSchema, { kind: { case: "session", value: { sessionId: "foreign-session" } } }) }));
    expect(await app.prepareTaskDerivationOrigin(key)).toBeUndefined();
    vi.mocked(f.network.readSession).mockImplementationOnce(async () => create(SnapshotSchema, {
      ...f.detail("session"), sessions: [create(SessionSchema, { ...f.state.child,
        nativeBinding: { ...f.state.child.nativeBinding!, runtimeGeneration: 9n } })] }));
    expect(await app.prepareTaskDerivationOrigin(key)).toBeUndefined();
    vi.mocked(f.network.readSession).mockImplementationOnce(async () => f.detail("session"));
    vi.mocked(f.network.readSession).mockImplementationOnce(async () => create(SnapshotSchema, {
      ...f.detail("source"), sessions: [create(SessionSchema, { ...f.state.source, archived: true })] }));
    expect(await app.prepareTaskDerivationOrigin(key)).toBeUndefined();
    app.setForeground(false);
    expect(app.taskDerivationOriginControls()).toMatchObject({ kind: "fork", canOpen: false });
    expect(f.network.submit).not.toHaveBeenCalled();
  });

  it("retires a pending origin read on cancellation, background or later task selection", async () => {
    const f = fixture(); const app = client(f.network, memoryStorage(credential).storage);
    await app.start(); const key = app.taskDerivationOriginControls()!.authorityKey!;
    let finish!: (events: Event[]) => void;
    vi.mocked(f.network.readAround).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const signal = new AbortController(); const pending = app.prepareTaskDerivationOrigin(key, signal.signal);
    await vi.waitFor(() => expect(f.network.readAround).toHaveBeenCalledOnce());
    signal.abort(); finish([f.event]); expect(await pending).toBeUndefined();
    vi.mocked(f.network.readAround).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const background = app.prepareTaskDerivationOrigin(key);
    await vi.waitFor(() => expect(f.network.readAround).toHaveBeenCalledTimes(2));
    app.setForeground(false); finish([f.event]); expect(await background).toBeUndefined();
    app.setForeground(true); await app.refresh();
    vi.mocked(f.network.readAround).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const later = app.prepareTaskDerivationOrigin(app.taskDerivationOriginControls()!.authorityKey!);
    await vi.waitFor(() => expect(f.network.readAround).toHaveBeenCalledTimes(3));
    await app.select("source"); finish([f.event]); expect(await later).toBeUndefined();
    expect(app.state.selectedId).toBe("source"); expect(f.network.submit).not.toHaveBeenCalled();
  });
});

describe("native message rewinds", () => {
  function fixture(boundary = true) {
    let input = insertMobileSessionMention(plainTextMobileComposerDraft("Discuss "), { start: 8, end: 8 },
      { sessionId: "related", displayText: "Related" }, "rewind-mention").draft;
    input = insertMobilePastedText(input, { start: input.text.length, end: input.text.length }, "😀 evidence\n".repeat(30), "rewind-paste").draft;
    const nativeIdentity = { entryId: "user-entry", parentEntryId: "parent-is-not-boundary",
      ...(boundary ? { rewindBefore: { kind: { case: "nativeEntryId" as const, value: "public-boundary" } } } : {}) };
    const started = create(EventSchema, { eventId: "rewind-start", identity: { sessionId: "session", runId: "round-run" },
      cursor: { generation: 1n, sequence: 20n }, payload: { kind: { case: "messageStarted", value: {
        messageId: "rewind-message", role: MessageRole.USER, userInputAccepted: true, nativeIdentity, userInput: mobileComposerInput(input)
      } } } });
    const completed = create(EventSchema, { eventId: "rewind-complete", identity: { sessionId: "session", runId: "round-run" },
      cursor: { generation: 1n, sequence: 21n }, payload: { kind: { case: "messageCompleted", value: {
        messageId: "rewind-message", role: MessageRole.USER, nativeIdentity, blocks: [{ content: { case: "text", value: "Compact display" } }]
      } } } });
    const state = { source: create(SessionSchema, { ...runtimeSession, state: SessionState.IDLE,
      nativeBinding: create(NativeSessionBindingSchema, { backendId: "backend", opaqueReference: "native-task", runtimeGeneration: 8n }) }),
      events: [started, completed] };
    const backend = create(BackendDescriptorSchema, { ...runtimeBackend, capabilities: create(CapabilityManifestSchema, {
      ...runtimeBackend.capabilities!, capabilities: [...runtimeBackend.capabilities!.capabilities,
        create(CapabilitySchema, { name: "workspace.rewind", support: CapabilitySupport.SUPPORTED })]
    }) });
    const workspace = create(WorkspaceDescriptorSchema, { workspaceId: "rewind-workspace", targetId: "target", serverPathDisplay: "D:\\project",
      location: { kind: { case: "serviceNode", value: {} } }, version: { revision: { value: 3n }, generation: 1n } });
    const target = create(TargetSchema, { ...snapshot.targets[0]!, workspaceId: workspace.workspaceId });
    const projection = (detail: boolean) => create(SnapshotSchema, { ...runtimeControlProjection(state.source, detail),
      backends: [backend], targets: [target], workspaces: [workspace], ...(detail ? { timeline: state.events } : {}) });
    const network = fakeNetwork(); network.readOwner = vi.fn(async () => ({ connection, device, snapshot: projection(false) }));
    network.readSession = vi.fn(async () => projection(true));
    network.listWorkspaceChangeSets = vi.fn(async () => [create(WorkspaceChangeSetSchema, { workspaceId: workspace.workspaceId,
      sessionId: "session", changeSetId: "checkpoint", runId: "round-run", capturedAt: { seconds: 1n } })]);
    const files = create(WorkspaceRewindPreviewSchema, { previewId: "preview", workspaceId: workspace.workspaceId, changeSetId: "checkpoint",
      safety: RewindSafety.SAFE, expiresAt: { seconds: 100n }, inverseChanges: [{ relativePath: "src/main.ts", kind: FileChangeKind.UPDATED }] });
    network.previewWorkspaceRewind = vi.fn(async () => files);
    const operation = (operationId: string, mode: "dialogue" | "files" = "dialogue") => create(OperationSchema, {
      operationId, connectionId: credential.connectionId, state: OperationState.SUCCEEDED, result: { payload: mode === "dialogue"
        ? { case: "acknowledgement", value: create(AcknowledgementSchema, { accepted: true }) }
        : { case: "workspaceRewind", value: create(WorkspaceRewindResultSchema, { workspaceId: workspace.workspaceId,
          changeSetId: "checkpoint", restoredPaths: ["src/main.ts"], filesRewound: true, dialogueRewound: false }) } }
    });
    const advance = () => {
      state.source = create(SessionSchema, { ...state.source,
        nativeBinding: create(NativeSessionBindingSchema, { ...state.source.nativeBinding!, runtimeGeneration: 9n }),
        version: create(EntityVersionSchema, { revision: { value: 10n }, generation: 9n }) }); state.events = [];
    };
    return { state, backend, workspace, files, network, operation, advance, input };
  }
  async function preview(app: MobileClient) {
    const controls = app.taskMessageRewindControls("rewind-complete")!;
    return (await app.loadTaskMessageRewindPreview(controls.authorityKey, "rewind-complete", new AbortController().signal))!;
  }

  it("persists approved input and body-free receipt before native dialogue rewind, then merges the draft before receipt clearance and refreshes new history", async () => {
    const f = fixture(); const saved = memoryStorage(credential); const drafts = memoryDraftStores();
    const identity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(identity, plainTextMobileComposerDraft("Keep newer input")); await drafts.composer.flush(identity);
    vi.mocked(f.network.submit).mockImplementationOnce(async (_credential, operationId, mutation) => {
      expect(saved.pending()).toEqual([{ kind: "session-rewind", operationId, connectionId: credential.connectionId,
        sessionId: "session", eventId: "rewind-complete", backendId: "backend", targetId: "target", sourceGeneration: "8", state: "unknown" }]);
      expect(await drafts.composer.readOperationInput(identity, operationId)).toMatchObject({ mentions: [{ sessionId: "related" }] });
      expect(mutation).toMatchObject({ preconditions: [{ expectedGeneration: 8n, expectedRevision: { value: 9n } }],
        payload: { case: "navigateSessionBranch", value: { sessionId: "session", target: { kind: { case: "nativeEntryId", value: "public-boundary" } }, summarize: false, customInstructions: "" } } });
      f.advance(); return f.operation(operationId);
    });
    const save = saved.storage.savePending;
    saved.storage.savePending = vi.fn(async (items) => {
      if (!items.length) expect(await drafts.composer.readDurable(identity)).toMatchObject({ mentions: [{ sessionId: "related" }], atoms: [{ kind: "pasted-text" }] });
      await save(items);
    });
    const app = client(f.network, saved.storage, undefined, undefined, undefined, undefined, drafts); await app.start();
    await expect(app.commitTaskMessageRewind(await preview(app), "dialogue", new AbortController().signal))
      .resolves.toEqual({ kind: "rewound", mode: "dialogue" });
    expect((await drafts.composer.readDurable(identity))?.text).toContain("Keep newer input");
    expect(saved.pending()).toEqual([]); expect(app.state.detail!.sessions[0]!.nativeBinding!.runtimeGeneration).toBe(9n);
    expect(timelineRows(app.state.detail!.timeline)).toEqual([]); expect(app.state.restoredComposerDraft).toMatchObject(identity);
    await expect(drafts.composer.readOperationInput(identity, "operation-1")).resolves.toBeNull();
    expect(f.network.readAround).not.toHaveBeenCalled(); expect(f.network.submit).toHaveBeenCalledOnce();
  });

  it("restores files independently at the exact Workspace/Run checkpoint when the backend lacks the message dialogue boundary", async () => {
    const f = fixture(false); const saved = memoryStorage(credential); const drafts = memoryDraftStores();
    f.workspace.workspaceId = "owned-workspace";
    f.state.source.worktree = create(SessionWorktreeSchema, { workspaceId: "owned-workspace", leaseId: "owned-lease" });
    const identity = { profileId: credential.profileId, sessionId: "session" }; drafts.composer.save(identity, plainTextMobileComposerDraft("Keep draft"));
    vi.mocked(f.network.submit).mockImplementationOnce(async (_credential, operationId, mutation) => {
      expect(mutation).toMatchObject({ preconditions: [{ expectedGeneration: 8n, expectedRevision: { value: 9n } }],
        payload: { case: "executeWorkspaceRewind", value: { workspaceId: "owned-workspace", previewId: "preview", changeSetId: "checkpoint",
          confirmFileRestore: true, allowDialogueOnly: false } } });
      expect(saved.pending()).toMatchObject([{ kind: "workspace-rewind", workspaceId: "owned-workspace", changeSetId: "checkpoint" }]);
      return f.operation(operationId, "files");
    });
    f.files.workspaceId = "owned-workspace";
    const app = client(f.network, saved.storage, undefined, undefined, undefined, undefined, drafts); await app.start();
    expect(app.taskMessageRewindControls("rewind-complete")).toMatchObject({ canDialogue: false, canFiles: true });
    const value = await preview(app);
    await expect(app.commitTaskMessageRewind(value, "dialogue", new AbortController().signal)).rejects.toThrow(/preview changed/u);
    await expect(app.commitTaskMessageRewind(value, "files", new AbortController().signal)).resolves.toEqual({ kind: "rewound", mode: "files" });
    expect(f.network.listWorkspaceChangeSets).toHaveBeenCalledWith(credential, "owned-workspace", "session", expect.any(AbortSignal));
    expect(f.network.previewWorkspaceRewind).toHaveBeenCalledWith(credential, "owned-workspace", "checkpoint", expect.any(AbortSignal));
    expect(drafts.composer.readSync(identity)?.text).toBe("Keep draft"); expect(saved.pending()).toEqual([]);
  });

  it("reconciles a lost response after restart from private retained input when the original Event is gone, without resending", async () => {
    const f = fixture(); const saved = memoryStorage(credential); const drafts = memoryDraftStores();
    vi.mocked(f.network.submit).mockRejectedValueOnce(new Error("response lost"));
    const app = client(f.network, saved.storage, undefined, undefined, undefined, undefined, drafts); await app.start();
    await expect(app.commitTaskMessageRewind(await preview(app), "dialogue", new AbortController().signal)).resolves.toEqual({ kind: "unknown" });
    expect(app.taskMessageRewindControls("rewind-complete")?.canRewind).toBe(false); app.dispose(); f.advance();
    vi.mocked(f.network.getOperation).mockResolvedValue(f.operation("operation-1"));
    const driver: MobilePlainStorageDriver = { async getItem(key) { return drafts.values.get(key) ?? null; },
      async setItem(key, value) { drafts.values.set(key, value); }, async removeItem(key) { drafts.values.delete(key); } };
    const restartedDrafts = { values: drafts.values, composer: new MobileComposerDraftStore(driver), newTask: new MobileNewTaskDraftStore(driver) };
    const restarted = client(f.network, saved.storage, undefined, undefined, undefined, undefined, restartedDrafts); await restarted.start();
    const restored = await restartedDrafts.composer.readDurable({ profileId: credential.profileId, sessionId: "session" });
    expect(mobileComposerInput(restored!)).toEqual(mobileComposerInput(f.input)); expect(restored!.attachments).toEqual([]);
    expect(saved.pending()).toEqual([]); expect(f.network.submit).toHaveBeenCalledOnce(); expect(f.network.readAround).not.toHaveBeenCalled();
  });

  it("keeps a known native effect pending during a draft CAS conflict, preserves newer input, and recovers through its original operation", async () => {
    const f = fixture(); const saved = memoryStorage(credential); const drafts = memoryDraftStores();
    vi.mocked(f.network.submit).mockImplementationOnce(async (_credential, operationId) => { f.advance(); return f.operation(operationId); });
    const save = drafts.composer.saveIfRevision.bind(drafts.composer);
    vi.spyOn(drafts.composer, "saveIfRevision").mockImplementationOnce((identity, draft, revision) => {
      drafts.composer.save(identity, plainTextMobileComposerDraft("Newer edit")); return save(identity, draft, revision);
    });
    const app = client(f.network, saved.storage, undefined, undefined, undefined, undefined, drafts); await app.start();
    await expect(app.commitTaskMessageRewind(await preview(app), "dialogue", new AbortController().signal)).resolves.toEqual({ kind: "unknown" });
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })?.text).toBe("Newer edit");
    expect(saved.pending()).toMatchObject([{ kind: "session-rewind", state: "unknown" }]);
    vi.mocked(f.network.getOperation).mockResolvedValueOnce(f.operation("operation-1")); await app.reconcile();
    expect(saved.pending()).toEqual([]); expect(app.state.restoredComposerDraft).toMatchObject({ sessionId: "session" });
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })?.text).toContain("Newer edit");
    expect(f.network.submit).toHaveBeenCalledOnce();
  });

  it("retains receipt and input for malformed terminal outcomes or a foreign adopted native binding, then recovers the exact task", async () => {
    const f = fixture(); const saved = memoryStorage(credential); const drafts = memoryDraftStores();
    vi.mocked(f.network.submit).mockImplementationOnce(async (_credential, operationId) => {
      f.advance(); const operation = f.operation(operationId);
      if (operation.result?.payload.case === "acknowledgement") operation.result.payload.value.accepted = false;
      return operation;
    });
    const app = client(f.network, saved.storage, undefined, undefined, undefined, undefined, drafts); await app.start();
    await expect(app.commitTaskMessageRewind(await preview(app), "dialogue", new AbortController().signal)).resolves.toEqual({ kind: "unknown" });
    vi.mocked(f.network.getOperation).mockResolvedValue(f.operation("operation-1"));
    f.state.source.nativeBinding!.backendId = "foreign-backend"; await app.reconcile();
    expect(saved.pending()).toMatchObject([{ kind: "session-rewind" }]);
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
    f.state.source.nativeBinding!.backendId = "backend"; await app.reconcile();
    expect(saved.pending()).toEqual([]); expect(f.network.submit).toHaveBeenCalledOnce();
  });

  it("rejects blocked, expired and stale confirmations, and retires a late terminal response after background without restoring input", async () => {
    const f = fixture(); const saved = memoryStorage(credential); const drafts = memoryDraftStores();
    const app = client(f.network, saved.storage, undefined, undefined, undefined, undefined, drafts); await app.start();
    let value = await preview(app);
    f.files.safety = RewindSafety.BLOCKED;
    await expect(app.commitTaskMessageRewind(value, "files", new AbortController().signal)).rejects.toThrow(/blocked or expired/u);
    f.files.safety = RewindSafety.SAFE; f.files.expiresAt!.seconds = 1n;
    await expect(app.commitTaskMessageRewind(value, "files", new AbortController().signal)).rejects.toThrow(/blocked or expired/u);
    f.files.expiresAt!.seconds = 100n;
    const controller = new AbortController(); controller.abort();
    await expect(app.commitTaskMessageRewind(value, "dialogue", controller.signal)).rejects.toThrow(/preview changed/u);
    expect(f.network.submit).not.toHaveBeenCalled();
    f.state.source = create(SessionSchema, { ...f.state.source, version: create(EntityVersionSchema, { revision: { value: 10n }, generation: 8n }) });
    await app.refresh();
    await expect(app.commitTaskMessageRewind(value, "dialogue", new AbortController().signal)).rejects.toThrow(/preview changed/u);
    value = await preview(app);
    let finish!: (operation: Operation) => void;
    vi.mocked(f.network.submit).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = app.commitTaskMessageRewind(value, "dialogue", new AbortController().signal);
    await vi.waitFor(() => expect(f.network.submit).toHaveBeenCalledOnce()); app.setForeground(false); f.advance(); finish(f.operation("operation-1"));
    await expect(pending).resolves.toEqual({ kind: "retired" }); expect(saved.pending()).toMatchObject([{ kind: "session-rewind" }]);
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "session" })).toBeNull();
  });
});

describe("native message forks", () => {
  function fixture() {
    let inputDraft = insertMobileSessionMention(plainTextMobileComposerDraft("Discuss "), { start: 8, end: 8 },
      { sessionId: "related", displayText: "Related" }, "fork-mention").draft;
    inputDraft = insertMobilePastedText(inputDraft, { start: inputDraft.text.length, end: inputDraft.text.length },
      "😀 evidence\n".repeat(30), "fork-paste").draft;
    const started = create(EventSchema, { eventId: "fork-start", identity: { sessionId: "session" },
      cursor: { generation: 1n, sequence: 20n }, payload: { kind: { case: "messageStarted", value: {
        messageId: "fork-user", role: MessageRole.USER, userInputAccepted: true, inputDelivery: MessageInputDelivery.PROMPT,
        nativeIdentity: { entryId: "user-native", parentEntryId: "parent-native" }, userInput: mobileComposerInput(inputDraft)
      } } } });
    const completed = create(EventSchema, { eventId: "fork-complete", identity: { sessionId: "session" },
      cursor: { generation: 1n, sequence: 21n }, payload: { kind: { case: "messageCompleted", value: {
        messageId: "fork-user", role: MessageRole.USER,
        nativeIdentity: { entryId: "user-native", parentEntryId: "parent-native" },
        blocks: [{ content: { case: "text", value: "Compact display" } }]
      } } } });
    const state = { source: runtimeSession, events: [started, completed], child: undefined as Snapshot["sessions"][number] | undefined };
    const backend = create(BackendDescriptorSchema, { ...runtimeBackend, capabilities: create(CapabilityManifestSchema, {
      ...runtimeBackend.capabilities!, capabilities: [...runtimeBackend.capabilities!.capabilities,
        create(CapabilitySchema, { name: capabilityNames.sessionFork, support: CapabilitySupport.SUPPORTED })]
    }) });
    const projection = (detail: boolean) => create(SnapshotSchema, { ...runtimeControlProjection(state.source, detail), backends: [backend],
      ...(detail ? { timeline: state.events } : { sessions: [state.source, ...(state.child ? [state.child] : [])] }) });
    const network = fakeNetwork();
    network.readOwner = vi.fn(async () => ({ connection, device, snapshot: projection(false) }));
    network.readSession = vi.fn(async () => projection(true));
    network.readAround = vi.fn(async () => state.events);
    const child = () => create(SessionSchema, { ...runtimeSession, sessionId: "forked-task",
      nativeBinding: create(NativeSessionBindingSchema, { ...runtimeSession.nativeBinding!, backendId: "backend", opaqueReference: "forked-native" }),
      derivationOrigin: create(SessionDerivationOriginSchema, { kind: SessionDerivationKind.FORK, sourceSessionId: "session",
        sourceMessageId: "fork-user", sourceEventId: "fork-complete" }) });
    const operation = (operationId: string, value = child()) => create(OperationSchema, { operationId,
      connectionId: credential.connectionId, state: OperationState.SUCCEEDED, result: { payload: { case: "session", value } } });
    return { state, network, backend, child, operation, inputDraft };
  }

  it("forks stable active input at its exact parent, persists the receipt first and the new draft before terminal receipt clearance", async () => {
    const f = fixture(); f.state.source = create(SessionSchema, { ...runtimeSession, state: SessionState.RUNNING });
    const saved = memoryStorage(credential); const drafts = memoryDraftStores();
    const sourceIdentity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(sourceIdentity, plainTextMobileComposerDraft("Keep source draft"));
    await drafts.composer.flush(sourceIdentity);
    vi.mocked(f.network.submit).mockImplementation(async (_credential, operationId, mutation) => {
      expect(saved.pending()).toEqual([{ operationId, connectionId: credential.connectionId,
        kind: "session-fork", sessionId: "session", eventId: "fork-complete", state: "unknown" }]);
      expect(mutation).toMatchObject({ preconditions: [{ expectedGeneration: 8n, expectedRevision: { value: 9n } }],
        payload: { case: "forkSession", value: { sourceSessionId: "session", nativeEntryId: "parent-native",
          sourceMessageId: "fork-user", sourceEventId: "fork-complete", newDisplayName: "Branch" } } });
      f.state.child = f.child(); return f.operation(operationId);
    });
    const savePending = saved.storage.savePending;
    saved.storage.savePending = vi.fn(async (items) => {
      if (items.length === 0) expect(await drafts.composer.readDurable({ ...sourceIdentity, sessionId: "forked-task" }))
        .toMatchObject({ mentions: [{ sessionId: "related" }], atoms: [{ text: "😀 evidence\n".repeat(30) }] });
      await savePending(items);
    });
    const app = client(f.network, saved.storage, undefined, undefined, () => "fork-operation", undefined, drafts);
    await app.start();
    const controls = app.taskMessageForkControls("fork-complete")!;
    expect(controls.canFork).toBe(true);
    await expect(app.forkTaskMessage(controls.authorityKey, "fork-complete", "Branch"))
      .resolves.toEqual({ kind: "forked", sessionId: "forked-task", draftRestored: true });
    expect(saved.pending()).toEqual([]); expect(app.state.selectedId).toBe("session");
    await expect(drafts.composer.readDurable(sourceIdentity)).resolves.toMatchObject({ text: "Keep source draft" });
  });

  it("reconciles an unknown fork after restart from its exact canonical source without dispatching again", async () => {
    const f = fixture(); const saved = memoryStorage(credential); const drafts = memoryDraftStores();
    vi.mocked(f.network.submit).mockRejectedValueOnce(new Error("response lost"));
    const app = client(f.network, saved.storage, undefined, undefined, () => "unknown-fork", undefined, drafts);
    await app.start();
    await expect(app.forkTaskMessage(app.taskMessageForkControls("fork-complete")!.authorityKey, "fork-complete", "Branch"))
      .resolves.toEqual({ kind: "unknown" });
    expect(app.taskMessageForkControls("fork-complete")?.canFork).toBe(false);
    app.dispose();
    f.state.child = f.child(); vi.mocked(f.network.getOperation).mockResolvedValue(f.operation("unknown-fork"));
    const restarted = client(f.network, saved.storage, undefined, undefined, () => "should-not-dispatch", undefined, drafts);
    await restarted.start();
    expect(saved.pending()).toEqual([]); expect(f.network.submit).toHaveBeenCalledOnce();
    expect(f.network.readAround).toHaveBeenCalledWith(credential, "session", "fork-complete", expect.any(AbortSignal));
    const restored = await drafts.composer.readDurable({ profileId: credential.profileId, sessionId: "forked-task" });
    expect(restored?.attachments).toEqual([]);
    expect(mobileComposerInput(restored!)).toEqual(mobileComposerInput(f.inputDraft));
    expect(restarted.state.selectedId).toBe("session");
  });

  it("rejects a stale source confirmation and leaves a foreign derived Session receipt unresolved", async () => {
    const f = fixture(); const saved = memoryStorage(credential);
    const app = client(f.network, saved.storage);
    await app.start(); const old = app.taskMessageForkControls("fork-complete")!;
    const original = clone(EventSchema, f.state.events[1]!);
    const changed = clone(EventSchema, original);
    if (changed.payload?.kind.case === "messageCompleted") changed.payload.kind.value.nativeIdentity!.parentEntryId = "different-parent";
    f.state.events = [f.state.events[0]!, changed]; await app.refresh();
    await expect(app.forkTaskMessage(old.authorityKey, "fork-complete", "Branch")).rejects.toThrow(/boundary changed/u);
    expect(f.network.submit).not.toHaveBeenCalled();
    f.state.events = [f.state.events[0]!, original]; await app.refresh();
    const foreign = f.child(); foreign.derivationOrigin!.sourceEventId = "foreign-event";
    vi.mocked(f.network.submit).mockImplementationOnce(async (_credential, operationId) => f.operation(operationId, foreign));
    await expect(app.forkTaskMessage(app.taskMessageForkControls("fork-complete")!.authorityKey, "fork-complete", "Branch"))
      .rejects.toThrow(/derived Session identity/u);
    expect(saved.pending()).toMatchObject([{ kind: "session-fork", state: "unknown" }]);
  });

  it("reports a draft CAS conflict without repeating native work or replacing a newer draft", async () => {
    const f = fixture(); const saved = memoryStorage(credential); const drafts = memoryDraftStores();
    vi.mocked(f.network.submit).mockImplementationOnce(async (_credential, operationId) => {
      f.state.child = f.child(); return f.operation(operationId);
    });
    const saveIfRevision = drafts.composer.saveIfRevision.bind(drafts.composer);
    vi.spyOn(drafts.composer, "saveIfRevision").mockImplementationOnce((identity, draft, revision) => {
      drafts.composer.save(identity, plainTextMobileComposerDraft("Newer draft"));
      return saveIfRevision(identity, draft, revision);
    });
    const app = client(f.network, saved.storage, undefined, undefined, undefined, undefined, drafts); await app.start();
    await expect(app.forkTaskMessage(app.taskMessageForkControls("fork-complete")!.authorityKey, "fork-complete", "Branch"))
      .resolves.toEqual({ kind: "forked", sessionId: "forked-task", draftRestored: false });
    await drafts.composer.flush({ profileId: credential.profileId, sessionId: "forked-task" });
    await expect(drafts.composer.readDurable({ profileId: credential.profileId, sessionId: "forked-task" }))
      .resolves.toMatchObject({ text: "Newer draft" });
    expect(saved.pending()).toEqual([]); expect(f.network.submit).toHaveBeenCalledOnce();
  });

  it("retires a late native fork result in background and preserves its unknown receipt without touching any new draft", async () => {
    const f = fixture(); const saved = memoryStorage(credential); const drafts = memoryDraftStores();
    let finish!: (operation: Operation) => void;
    vi.mocked(f.network.submit).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const app = client(f.network, saved.storage, undefined, undefined, undefined, undefined, drafts); await app.start();
    const pending = app.forkTaskMessage(app.taskMessageForkControls("fork-complete")!.authorityKey, "fork-complete", "Branch");
    await vi.waitFor(() => expect(f.network.submit).toHaveBeenCalledOnce());
    app.setForeground(false); finish(f.operation("operation-1"));
    await expect(pending).resolves.toEqual({ kind: "retired" });
    expect(saved.pending()).toMatchObject([{ kind: "session-fork", state: "unknown" }]);
    expect(drafts.composer.readSync({ profileId: credential.profileId, sessionId: "forked-task" })).toBeNull();
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
  it("freezes conversation images from authenticated canonical sources and rejects deletion before sharing", async () => {
    const bytes = galleryPngBytes(5, 4);
    const event = timelineGalleryEvent(bytes);
    if (event.payload?.kind.case !== "messageCompleted") throw new Error("message fixture missing");
    for (const block of event.payload.kind.value.blocks) {
      if (block.content.case === "image") block.content.value.blob!.sha256Hex = sha256Hex(bytes);
    }
    event.payload.kind.value.blocks.push({ $typeName: "joko.v1.MessageBlock", content: { case: "text", value: "![Untrusted](https://untrusted.invalid/a.png)" } });
    const network = projectedNetwork(timelineGallerySnapshot(event));
    vi.mocked(network.downloadBlob).mockResolvedValueOnce({ bytes, mediaType: "image/png" }).mockRejectedValueOnce(new Error("unreadable"));
    vi.mocked(network.readAround).mockResolvedValue([create(EventSchema, { ...event,
      cursor: create(EventCursorSchema, { sequence: event.cursor!.sequence, generation: event.cursor!.generation,
        opaqueToken: "a-new-history-ticket", issuedAt: { seconds: 12n } }) })]);
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const selected = timelineRows(app.state.detail?.timeline ?? [])[0]!;
    const prepared = await app.prepareConversationShare([selected.id], new AbortController().signal);
    expect(prepared.messages[0]!.images?.size).toBe(1);
    expect(prepared.messages[0]!.bodyParts.map((part) => part.kind)).toEqual(["text", "image", "image", "text"]);
    expect(network.downloadBlob).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(prepared)).not.toContain(credential.authKey);
    await app.revalidateConversationShare(prepared.leaseId, new AbortController().signal);
    vi.mocked(network.readAround).mockResolvedValue([]);
    await expect(app.revalidateConversationShare(prepared.leaseId, new AbortController().signal)).rejects.toThrow(/removed/u);
    expect(network.submit).not.toHaveBeenCalled(); expect(network.uploadBlob).not.toHaveBeenCalled();
    app.releaseConversationShare(prepared.leaseId);
  });

  it("retires conversation image preparation on background without adopting a late download", async () => {
    const bytes = galleryPngBytes(5, 4);
    const event = timelineGalleryEvent(bytes);
    const network = projectedNetwork(timelineGallerySnapshot(event));
    let finish!: (value: { bytes: Uint8Array; mediaType: string }) => void;
    vi.mocked(network.downloadBlob).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const app = client(network, memoryStorage(credential).storage);
    await app.start();
    const selected = timelineRows(app.state.detail?.timeline ?? [])[0]!;
    const controller = new AbortController();
    const preparing = app.prepareConversationShare([selected.id], controller.signal);
    const retired = expect(preparing).rejects.toThrow(/changed|cancelled|aborted/u);
    await vi.waitFor(() => expect(network.downloadBlob).toHaveBeenCalledTimes(1));
    app.setForeground(false); controller.abort(); await retired;
    finish({ bytes, mediaType: "image/png" });
    expect(network.submit).not.toHaveBeenCalled(); expect(app.conversationShareOwnerKey()).toBeUndefined();
  });

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

  it("renders current Workspace image and document miniatures, reauthorizes cached pixels and retires them with directory navigation", async () => {
    const bytes = await sharp({ create: { width: 512, height: 256, channels: 4, background: "orange" } }).png().toBuffer();
    const derivative = await sharp(bytes).resize(256, 128).webp().toBuffer();
    const observedRevision = create(FileRevisionSchema, { opaqueRevision: "picture-r1", byteSize: BigInt(bytes.length), modifiedAt: { seconds: 100n } });
    const entry = create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "picture.png", kind: FileKind.REGULAR, mediaType: "image/png", revision: observedRevision });
    const blob = create(BlobRefSchema, { blobId: "picture", fileName: "picture.png", mediaType: "image/png", byteSize: BigInt(bytes.length), sha256Hex: sha256Hex(bytes) });
    const materialized = create(WorkspaceEntrySchema, { ...entry, revision: { ...observedRevision, opaqueRevision: `sha256:${blob.sha256Hex}:${bytes.length}`, sha256Hex: blob.sha256Hex } });
    const thumbnail = create(ImageThumbnailSchema, { data: derivative, mediaType: "image/webp", sha256Hex: sha256Hex(derivative), widthPixels: 256, heightPixels: 128, sourceWidthPixels: 512, sourceHeightPixels: 256 });
    const network = fakeNetwork(); configureFiles(network, handoffSnapshot);
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspace, parent) => ({ entries: parent === "" ? [entry, readme, sourceDirectory] : [], revision: `directory:${parent || "root"}` }));
    vi.mocked(network.materializeWorkspaceFileBlob).mockResolvedValue({ entry: materialized, blob }); vi.mocked(network.readImageThumbnail).mockResolvedValue(thumbnail);
    const app = client(network, memoryStorage(credential).storage); await app.start(); await app.openFiles(); const owner = app.filesAuthorityKey()!;
    const source = { kind: "workspace-entry" as const, entry: app.state.files.entries.find((item) => item.relativePath === "picture.png")! };
    const first = await app.prepareFilesThumbnail(owner, source, new AbortController().signal);
    expect(first.content).toMatchObject({ kind: "image", width: 256, height: 128, mediaType: "image/webp" });
    app.confirmFilesThumbnail(first.leaseId, { width: 256, height: 128, mediaType: "image/webp", isAnimated: false }); app.releaseFilesThumbnail(first.leaseId);
    const cached = await app.prepareFilesThumbnail(owner, source, new AbortController().signal); expect(network.materializeWorkspaceFileBlob).toHaveBeenCalledOnce();
    expect(network.readImageThumbnail).toHaveBeenCalledExactlyOnceWith(credential, blob, 256, expect.any(AbortSignal)); expect(network.listWorkspaceDirectory).toHaveBeenCalledTimes(3);
    const doc = await app.prepareFilesThumbnail(owner, { kind: "workspace-entry", entry: readme }, new AbortController().signal); expect(doc.content).toEqual({ kind: "text", text: "# Joko" });
    expect(app.state.files.preview).toBeUndefined(); expect(network.downloadBlob).not.toHaveBeenCalled(); expect(network.submit).not.toHaveBeenCalled();
    await app.openFilesDirectory("src"); expect(() => app.confirmFilesThumbnail(cached.leaseId, { width: 256, height: 128 })).toThrow(/released/u);
    await expect(app.prepareFilesThumbnail(owner, source, new AbortController().signal)).rejects.toThrow(/source/u);
  });

  it("renders only current Generated miniatures, rejects changed catalogs and never falls back after thumbnail authentication fails", async () => {
    const bytes = new TextEncoder().encode("actual generated document\n42"); const textBlob = create(BlobRefSchema, { blobId: "mini-doc", fileName: "report.txt", mediaType: "text/plain", byteSize: BigInt(bytes.length), sha256Hex: sha256Hex(bytes) });
    const doc = create(ArtifactSchema, { ...artifact, blob: textBlob });
    const imageBytes = await sharp({ create: { width: 20, height: 10, channels: 3, background: "orange" } }).webp().toBuffer();
    const imageBlob = create(BlobRefSchema, { blobId: "mini-picture", fileName: "picture.webp", mediaType: "image/webp", byteSize: BigInt(imageBytes.length), sha256Hex: sha256Hex(imageBytes) });
    const photo = create(ArtifactSchema, { ...artifact, artifactId: "mini-photo", kind: ArtifactKind.IMAGE, blob: imageBlob });
    const thumbnail = create(ImageThumbnailSchema, { data: imageBytes, mediaType: "image/webp", sha256Hex: imageBlob.sha256Hex, widthPixels: 20, heightPixels: 10, sourceWidthPixels: 20, sourceHeightPixels: 10 });
    const network = fakeNetwork(); configureFiles(network, handoffSnapshot); vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [doc, photo], revision: "artifacts-1" });
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "text/plain" }); vi.mocked(network.readImageThumbnail).mockRejectedValue(new Error("Thumbnail authorization failed"));
    const app = client(network, memoryStorage(credential).storage); await app.start(); await app.openFiles(); app.openGeneratedFiles(); const owner = app.filesAuthorityKey()!;
    const text = await app.prepareFilesThumbnail(owner, { kind: "artifact", artifact: doc }, new AbortController().signal); expect(text.content).toEqual({ kind: "text", text: "actual generated document\n42" }); app.releaseFilesThumbnail(text.leaseId);
    const source = { kind: "artifact" as const, artifact: photo };
    await expect(app.prepareFilesThumbnail(owner, source, new AbortController().signal)).rejects.toThrow(/authorization failed/u); expect(network.downloadBlob).toHaveBeenCalledOnce();
    vi.mocked(network.readImageThumbnail).mockResolvedValue(thumbnail); const current = await app.prepareFilesThumbnail(owner, source, new AbortController().signal);
    expect(current.content?.kind).toBe("image"); vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [doc, photo], revision: "changed-catalog" });
    await expect(app.prepareFilesThumbnail(owner, source, new AbortController().signal)).rejects.toThrow(/catalog changed/u); expect(network.readImageThumbnail).toHaveBeenCalledTimes(2);
    app.setForeground(false); expect(() => app.confirmFilesThumbnail(current.leaseId, { width: 20, height: 10 })).toThrow(/released/u);
    expect(network.submit).not.toHaveBeenCalled(); expect(network.materializeWorkspaceFileBlob).not.toHaveBeenCalled();
  });

  it("copies only an observed relative Files path or canonical Generated filename and retires the lease with its surface", async () => {
    const network = fakeNetwork(); configureFiles(network, handoffSnapshot);
    const app = client(network, memoryStorage(credential).storage); await app.start(); await app.openFiles();
    const displayed = app.state.files;
    const root = app.prepareFilesPathCopy(app.state.files); expect(root).toMatchObject({ text: ".", kind: "path" }); root.assertCurrent();
    const entry = app.state.files.entries.find((value) => value.relativePath === "README.md")!;
    const file = app.prepareFilesPathCopy(app.state.files, { kind: "workspace-entry", entry }); expect(file.text).toBe("README.md");
    await app.openFilesDirectory("src"); expect(() => root.assertCurrent()).toThrow(); expect(() => file.assertCurrent()).toThrow();
    expect(() => app.prepareFilesPathCopy(displayed)).toThrow();
    const directory = app.prepareFilesPathCopy(app.state.files); expect(directory.text).toBe("src"); await app.refreshFiles(); expect(() => directory.assertCurrent()).toThrow();
    app.openGeneratedFiles(); expect(() => app.prepareFilesPathCopy(app.state.files)).toThrow();
    const generated = app.prepareFilesPathCopy(app.state.files, { kind: "artifact", artifact: app.state.files.artifacts[0]! });
    expect(generated).toMatchObject({ text: "report.txt", kind: "file-name" }); generated.assertCurrent();
    expect(network.readWorkspaceFile).not.toHaveBeenCalled(); expect(network.downloadBlob).not.toHaveBeenCalled(); expect(network.submit).not.toHaveBeenCalled();
    await app.openFiles(); expect(() => generated.assertCurrent()).toThrow();
    const selected = app.state.files.entries.find((value) => value.relativePath === "README.md")!;
    const beforePreview = app.prepareFilesPathCopy(app.state.files, { kind: "workspace-entry", entry: selected });
    await app.previewWorkspaceEntry(selected); expect(() => beforePreview.assertCurrent()).toThrow(); expect(() => app.prepareFilesPathCopy(app.state.files)).toThrow();
    app.closeFilesPreview(); const beforeBackground = app.prepareFilesPathCopy(app.state.files); app.setForeground(false);
    expect(() => beforeBackground.assertCurrent()).toThrow(); expect(() => app.prepareFilesPathCopy(app.state.files)).toThrow();
  });

  it("opens current completed Markdown resources in Files and the gallery, and shares the same authorized inline image", async () => {
    vi.useFakeTimers();
    const bytes = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    const body = "![Inline picture](images/pixel.png) `README.md:2:1` [source](src/) ![external](https://example.invalid/no.png)";
    const event = create(EventSchema, { eventId: messageEvent.eventId, identity: messageEvent.identity, cursor: messageEvent.cursor,
      payload: { kind: { case: "messageCompleted", value: {
      messageId: "markdown-completed", role: MessageRole.ASSISTANT, blocks: [{ content: { case: "text", value: body } }]
    } } } });
    const projected = create(SnapshotSchema, { ...filesSnapshot, timeline: [event], resumeCursor: event.cursor,
      workspaces: [create(WorkspaceDescriptorSchema, { ...filesSnapshot.workspaces[0]!, serverPathDisplay: "D:\\repo" })] });
    const network = fakeNetwork(); configureFiles(network, projected);
    network.streamOwner = vi.fn(async function* () { throw new Error("stream transport unavailable"); });
    const imageRevision = create(FileRevisionSchema, { opaqueRevision: "pixel-r1", sha256Hex: sha256Hex(bytes), byteSize: BigInt(bytes.length) });
    const imageEntry = create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "images/pixel.png", kind: FileKind.REGULAR, mediaType: "image/png", revision: imageRevision });
    const imageBlob = create(BlobRefSchema, { blobId: "markdown-pixel", fileName: "pixel.png", mediaType: "image/png", byteSize: imageRevision.byteSize, sha256Hex: imageRevision.sha256Hex });
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspace, parent) => ({
      entries: parent === "" ? [readme, sourceDirectory] : parent === "images" ? [imageEntry] : [], revision: "directory-" + parent
    }));
    vi.mocked(network.readWorkspaceFile).mockImplementation(async (_credential, _workspace, path) => path === imageEntry.relativePath
      ? create(FilePreviewSchema, { entry: imageEntry, content: { case: "image", value: { blob: imageBlob, widthPixels: 1, heightPixels: 1 } } })
      : create(FilePreviewSchema, { entry: readme, content: { case: "text", value: { utf8Text: "#A\n#B\n", totalLines: 3, startByte: 0n, endByte: 6n } } }));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/png" });
    vi.mocked(network.readAround).mockResolvedValue([event]);
    let nextId = 0;
    const attachmentFiles = new MobileAttachmentFiles(attachmentFileFixture().driver, async (value) => sha256Hex(value));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, () => "resource-" + ++nextId,
      undefined, undefined, attachmentFiles);
    await app.start();
    const prepared = await app.prepareMarkdownResources("markdown-completed", body, new AbortController().signal);
    const imageKey = JSON.stringify(["image", "images/pixel.png"]); const fileKey = JSON.stringify(["code", "README.md:2:1"]);
    expect(prepared.references.get(imageKey)?.image).toMatchObject({ width: 1, height: 1 });
    expect(network.downloadBlob).toHaveBeenCalledWith(credential, imageBlob, expect.any(AbortSignal));
    expect(await app.openMarkdownPath(prepared.leaseId, fileKey, new AbortController().signal)).toMatchObject({ kind: "workspace-entry", entry: readme });
    expect(app.state.files.preview).toMatchObject({ kind: "text", text: "#A\n#B\n", focusLine: 2, focusColumn: 1 });
    const filePreview = app.state.files.preview;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(app.state.files.preview).toBe(filePreview);
    expect(() => app.assertMarkdownResourcesCurrent(prepared.leaseId)).not.toThrow();
    await app.openMarkdownPath(prepared.leaseId, JSON.stringify(["link", "src/"]), new AbortController().signal);
    expect(app.state.files.location).toEqual({ kind: "workspace", path: "src" });
    const gallery = await app.openMarkdownImageGallery(prepared.leaseId, imageKey, new AbortController().signal);
    app.releaseMarkdownResources(prepared.leaseId);
    const page = await app.loadImageGalleryPage(gallery.leaseId, 0, new AbortController().signal);
    expect(page).toMatchObject({ expectedWidthPixels: 1, expectedHeightPixels: 1, pageCount: 1 });
    await vi.advanceTimersByTimeAsync(4_000);
    app.confirmImageGalleryPageDecoded(gallery.leaseId, page.leaseId, page.pageId, { width: 1, height: 1, mediaType: "image/png", isAnimated: false });
    expect((await app.prepareImageOutput(page.leaseId, { width: 1, height: 1, mediaType: "image/png", isAnimated: false }, new AbortController().signal)).bytes).toEqual(bytes);
    app.cancelImageGallery(gallery.leaseId);
    expect(() => app.assertMarkdownResourcesCurrent(prepared.leaseId)).toThrow(/released/u);
    const shared = await app.prepareConversationShare(["markdown-completed"], new AbortController().signal);
    expect(shared.messages[0]!.images?.get("images/pixel.png")?.uri).toBe("data:image/png;base64," + Buffer.from(bytes).toString("base64"));
    expect(shared.messages[0]!.images?.has("https://example.invalid/no.png")).toBe(false);
    await app.revalidateConversationShare(shared.leaseId, new AbortController().signal);
    vi.mocked(network.listWorkspaceDirectory).mockImplementation(async (_credential, _workspace, parent) => ({
      entries: parent === "images" ? [create(WorkspaceEntrySchema, { ...imageEntry, revision: create(FileRevisionSchema, { ...imageRevision, opaqueRevision: "pixel-r2" }) })] : [],
      revision: "changed-directory"
    }));
    await expect(app.revalidateConversationShare(shared.leaseId, new AbortController().signal)).rejects.toThrow(/changed/u);
    app.releaseConversationShare(shared.leaseId);
    expect(network.uploadBlob).not.toHaveBeenCalled(); expect(network.submit).not.toHaveBeenCalled();
  });

  it("rejects spoofed Markdown text and server-deleted messages before any path opens", async () => {
    const event = create(EventSchema, { eventId: messageEvent.eventId, identity: messageEvent.identity, cursor: messageEvent.cursor,
      payload: { kind: { case: "messageCompleted", value: {
      messageId: "markdown-completed", role: MessageRole.ASSISTANT, blocks: [{ content: { case: "text", value: "`README.md:1`" } }]
    } } } });
    const network = fakeNetwork(); configureFiles(network, create(SnapshotSchema, { ...filesSnapshot, timeline: [event], resumeCursor: event.cursor,
      workspaces: [create(WorkspaceDescriptorSchema, { ...filesSnapshot.workspaces[0]!, serverPathDisplay: "D:\\repo" })] }));
    const app = client(network, memoryStorage(credential).storage); await app.start();
    await expect(app.prepareMarkdownResources("markdown-completed", "`private.md`", new AbortController().signal)).rejects.toThrow(/authority/u);
    expect(network.listWorkspaceDirectory).not.toHaveBeenCalled();
    const prepared = await app.prepareMarkdownResources("markdown-completed", "`README.md:1`", new AbortController().signal);
    vi.mocked(network.readAround).mockResolvedValue([]);
    await expect(app.openMarkdownPath(prepared.leaseId, JSON.stringify(["code", "README.md:1"]), new AbortController().signal)).rejects.toThrow(/removed/u);
    expect(app.state.files.open).toBe(false); expect(network.readWorkspaceFile).not.toHaveBeenCalled();
    app.setForeground(false);
    expect(() => app.assertMarkdownResourcesCurrent(prepared.leaseId)).toThrow(/released/u);
  });

  it("cancels a pending Markdown Files handoff without adopting a late directory result", async () => {
    const body = "`README.md:1`";
    const event = create(EventSchema, { eventId: messageEvent.eventId, identity: messageEvent.identity, cursor: messageEvent.cursor,
      payload: { kind: { case: "messageCompleted", value: { messageId: "markdown-completed", role: MessageRole.ASSISTANT,
        blocks: [{ content: { case: "text", value: body } }] } } } });
    const network = fakeNetwork(); configureFiles(network, create(SnapshotSchema, { ...filesSnapshot, timeline: [event], resumeCursor: event.cursor,
      workspaces: [create(WorkspaceDescriptorSchema, { ...filesSnapshot.workspaces[0]!, serverPathDisplay: "D:\\repo" })] }));
    vi.mocked(network.readAround).mockResolvedValue([event]);
    const app = client(network, memoryStorage(credential).storage); await app.start();
    const resources = await app.prepareMarkdownResources("markdown-completed", body, new AbortController().signal);
    let finish!: (value: { entries: readonly WorkspaceEntry[]; revision: string }) => void;
    vi.mocked(network.listWorkspaceDirectory).mockResolvedValueOnce({ entries: [readme], revision: "current" })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const controller = new AbortController();
    const opening = app.openMarkdownPath(resources.leaseId, JSON.stringify(["code", "README.md:1"]), controller.signal);
    const retired = expect(opening).rejects.toThrow(/cancel|abort/u);
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(app.state.files.open).toBe(true);
    controller.abort(); await retired;
    expect(app.state.files.open).toBe(false);
    finish({ entries: [readme], revision: "late-directory" }); await Promise.resolve();
    expect(app.state.files.open).toBe(false); expect(network.readWorkspaceFile).not.toHaveBeenCalled();
    app.releaseMarkdownResources(resources.leaseId);
  });

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

  it.each(timelineFileSources)("shares a bounded non-preview $kind file only while its durable event remains exact", async ({ project }) => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const original = timelinePreviewEvent("bundle.zip", "application/zip", bytes, "d".repeat(64), "Bundle");
    const event = project(original);
    const network = projectedNetwork(timelineGallerySnapshot(event));
    vi.mocked(network.readAround).mockResolvedValue([event]);
    const rowArtifact = timelineRows([event])[0]!.artifacts![0]!;
    expect(rowArtifact.previewKind).toBeUndefined();
    const payload = original.payload?.kind;
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
    vi.mocked(network.readAround).mockResolvedValue([]);
    await expect(app.shareTimelineArtifact(rowArtifact)).rejects.toThrow(/changed/u);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(network.authorizeBlobDownload).toHaveBeenCalledTimes(1);
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

  it.each(timelineFileSources)("previews an exact durable $kind video and removes its lease when closed", async ({ project }) => {
    const bytes = previewMp4Bytes();
    const event = project(timelinePreviewEvent("demo.mp4", "video/mp4", bytes, "c".repeat(64), "Demo video"));
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

  it.each(timelineFileSources)("cleans a late $kind stage after the exact source window changes", async ({ project }) => {
    const bytes = previewMp4Bytes();
    const event = project(timelinePreviewEvent("late.mp4", "video/mp4", bytes, "e".repeat(64), "Late video"));
    const replacement = project(timelinePreviewEvent("replacement.mp4", "video/mp4", bytes, "d".repeat(64), "Replacement"));
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

  it("freezes a same-directory image gallery and appends only its decoded authenticated page", async () => {
    const network = fakeNetwork();
    configureFiles(network, handoffSnapshot);
    const bytes = galleryPngBytes(3, 2);
    const firstRevision = create(FileRevisionSchema, {
      opaqueRevision: "image-a", sha256Hex: "b".repeat(64), byteSize: BigInt(bytes.byteLength), modifiedAt: { seconds: 10n, nanos: 0 }
    });
    const secondRevision = create(FileRevisionSchema, {
      opaqueRevision: "image-b", sha256Hex: "b".repeat(64), byteSize: BigInt(bytes.byteLength), modifiedAt: { seconds: 20n, nanos: 0 }
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

    const descriptor = await app.openFilesImageGallery({ kind: "workspace-entry", entry: app.state.files.entries[1]! }, undefined, "mtime");
    expect(descriptor).toMatchObject({
      sourceKind: "workspace", initialIndex: 0,
      pages: [{ title: "b.png" }, { title: "a.png" }, { title: "moving.gif" }]
    });
    const page = await app.loadImageGalleryPage(descriptor.leaseId, descriptor.initialIndex);
    expect(page).toMatchObject({
      pageIndex: 0, pageCount: 3, expectedWidthPixels: 3, expectedHeightPixels: 2,
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
      createdAt: { seconds: 1n, nanos: 0 },
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
      createdAt: { seconds: 2n, nanos: 0 },
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
    const sorted = await app.openFilesImageGallery({ kind: "artifact", artifact: selected }, undefined, "mtime");
    expect(sorted).toMatchObject({ initialIndex: 0, pages: [{ title: "Second generated image" }, { title: "First generated image" }] });
    await expect(app.loadImageGalleryPage(descriptor.leaseId, 0)).rejects.toThrow();
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

  it.each([
    { format: "static GIF", fileName: "still.gif", mediaType: "image/gif", bytes: gifBytes(), animated: false, width: 1, height: 1 },
    { format: "animated GIF", fileName: "moving.gif", mediaType: "image/gif", bytes: gifBytes(true), animated: true, width: 1, height: 1 },
    { format: "SVG", fileName: "vector.svg", mediaType: "image/svg+xml", bytes: svgBytes(), animated: false, width: 40, height: 20 },
    { format: "animated PNG", fileName: "moving.png", mediaType: "image/png", bytes: animatedPngBytes(), animated: true, width: 1, height: 1 },
    { format: "registered APNG", fileName: "moving.apng", mediaType: "image/apng", bytes: animatedPngBytes(), animated: true, width: 1, height: 1 },
    { format: "ICO", fileName: "icon.ico", mediaType: "image/x-icon", bytes: iconBytes([{ bytes: iconDibBytes(3, 2), width: 3, height: 2 }]), animated: false, width: 3, height: 2 },
    { format: "static TIFF", fileName: "scan.tiff", mediaType: "image/tiff", bytes: tiffBytes(3, 2), animated: false, width: 3, height: 2 }
  ])("previews canonical $format, system-shares and appends original bytes, and rejects static rendering", async ({ fileName, mediaType, bytes, animated, width, height }) => {
    const message = timelinePreviewEvent(fileName, mediaType, bytes, "b".repeat(64));
    const projected = clone(SnapshotSchema, timelineGallerySnapshot(message));
    const input = projected.backends[0]!.capabilities!.capabilities.find((item) => item.name === capabilityNames.inputImage)!.options!.kind;
    if (input.case !== "input") throw new Error("fixture"); input.value.mediaTypes.push(mediaType);
    const network = projectedNetwork(projected);
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType });
    vi.mocked(network.readAround).mockResolvedValue([message]);
    const blob = message.payload!.kind.case === "messageCompleted" ? message.payload!.kind.value.blocks[0]!.content : undefined;
    if (blob?.case !== "artifact" || !blob.value.blob) throw new Error("fixture");
    const canonical = blob.value.blob;
    const authorized: AuthorizedBlobDownload = { url: credential.origin + "/v1/blobs/ticket", headers: { authorization: "Bearer private-key" },
      blobId: canonical.blobId, fileName, mediaType, byteSize: bytes.byteLength, sha256Hex: canonical.sha256Hex };
    vi.mocked(network.authorizeBlobDownload).mockResolvedValue(authorized);
    const dispatch = vi.fn();
    const perform = vi.fn(async (request: Parameters<MobileFileShare["perform"]>[0]) => {
      await request.assertCurrent(); expect(dispatch).not.toHaveBeenCalled(); request.onDispatch?.();
    });
    const drafts = memoryDraftStores(); const identity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(identity, plainTextMobileComposerDraft("Keep the input")); await drafts.composer.flush(identity);
    const fixture = attachmentFileFixture();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, fixedIds("format-gallery", "format-load", "format-output", "format-edit-source", "format-editor"),
      undefined, drafts, fixture.files, undefined, undefined, undefined, { perform });
    await app.start();
    const selected = timelineRows(app.state.detail?.timeline ?? [])[0]!.images![0]!;
    const descriptor = await app.openTimelineImageGallery(selected.sourceEventId!, selected.pageId);
    const page = await app.loadImageGalleryPage(descriptor.leaseId, 0);
    expect(page).toMatchObject({ sourceMediaType: mediaType, expectedWidthPixels: width, expectedHeightPixels: height,
      expectedAnimated: animated, annotatable: false, addable: true, sourceBase64: Buffer.from(bytes).toString("base64") });
    if (mediaType === "image/svg+xml") expect(Buffer.from(page.previewUri.split(",")[1]!, "base64").toString()).toContain('viewBox="0 0 40 20"');
    expect(() => app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId,
      { width: mediaType === "image/gif" && !animated ? width + 1 : width, height, mediaType, isAnimated: !animated })).toThrow(/decoded image/u);
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, { width, height, mediaType: page.previewMediaType ?? mediaType, isAnimated: mediaType === "image/gif" || animated });
    await expect(app.prepareImageOutput(page.leaseId, { width, height, mediaType, isAnimated: false })).rejects.toThrow(/Animated|static image format|signature or dimensions/u);
    await expect(app.commitImageGalleryPageToComposer(descriptor.leaseId, page.leaseId, [{ points: [{ x: 0.5, y: 0.5 }] }],
      { bytes: renderedPngBytes, mediaType: "image/png", width, height })).rejects.toThrow(/cannot be rendered/u);
    await app.shareImageGalleryPageOriginal(descriptor.leaseId, page.leaseId, undefined, dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(perform).toHaveBeenCalledOnce(); expect(perform.mock.calls[0]![0].source).toEqual(authorized);
    expect(network.readAround).toHaveBeenCalledTimes(2); expect(fixture.driver.stageBytes).not.toHaveBeenCalled();
    const committed = await app.addImageGalleryPageToComposer(descriptor.leaseId, page.leaseId);
    expect(committed).toMatchObject({ text: "Keep the input", attachments: [{ attachmentId: "format-output", fileName, mediaType, byteSize: bytes.byteLength }] });
    expect(fixture.bytes.get("format-output")).toEqual(bytes);
    const editor = await app.openComposerImageEditor({ surface: "task", attachmentId: "format-output" });
    expect(editor.annotatable).toBe(false);
    expect(network.submit).not.toHaveBeenCalled(); expect(network.uploadBlob).not.toHaveBeenCalled();
  });

  it.each([
    { fileName: "photo.bmp", mediaType: "image/bmp", bytes: bmpBytes(3, 2), originalOnly: false },
    { fileName: "photo.avif", mediaType: "image/avif", bytes: isoImageBytes(["avif"], 3, 2, { thumbnail: { width: 20, height: 10 } }), originalOnly: false },
    { fileName: "photo.heic", mediaType: "image/heic", bytes: isoImageBytes(["heic", "mif1"], 3, 2), originalOnly: false },
    { fileName: "photo.heif", mediaType: "image/heif", bytes: isoImageBytes(["mif1"], 3, 2), originalOnly: false },
    { fileName: "scan.tiff", mediaType: "image/tiff", bytes: tiffBytes(3, 2), originalOnly: false },
    { fileName: "icon.ico", mediaType: "image/x-icon", bytes: iconBytes([{ bytes: iconDibBytes(1, 1), width: 1, height: 1 }, { bytes: iconDibBytes(3, 2), width: 3, height: 2 }]), originalOnly: true }
  ])("opens canonical $mediaType Files and Generated images with exact primary dimensions and original output bytes", async ({ fileName, mediaType, bytes, originalOnly }) => {
    const network = fakeNetwork(); configureFiles(network, handoffSnapshot);
    const revision = create(FileRevisionSchema, { opaqueRevision: "container-image", sha256Hex: "b".repeat(64), byteSize: BigInt(bytes.length) });
    const entry = create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: fileName, displayName: fileName,
      mediaType, kind: FileKind.REGULAR, revision });
    const blob = create(BlobRefSchema, { blobId: "container-blob", fileName, mediaType, byteSize: BigInt(bytes.length), sha256Hex: "b".repeat(64), disposition: BlobDisposition.INLINE });
    const artifact = create(ArtifactSchema, { artifactId: "container-artifact", sessionId: "session", kind: ArtifactKind.IMAGE, title: "Image", blob });
    vi.mocked(network.listWorkspaceDirectory).mockResolvedValue({ entries: [entry], revision: "container-directory" });
    vi.mocked(network.listWorkspaceFileIndex).mockResolvedValue({ paths: [fileName], revision: "container-index", truncated: false });
    vi.mocked(network.readWorkspaceFile).mockResolvedValue(create(FilePreviewSchema, { entry, content: { case: "image", value: { blob } } }));
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [artifact], revision: "container-catalog" });
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, fixedIds("container-gallery", "container-load"),
      undefined, memoryDraftStores(), attachmentFileFixture().files);
    await app.start(); await app.openFiles(); await app.previewWorkspaceEntry(entry);
    expect(app.state.files.preview).toMatchObject({ kind: "image", mediaType, widthPixels: 3, heightPixels: 2 });
    if (mediaType === "image/x-icon") expect(app.state.files.preview?.kind === "image" && app.state.files.preview.dataUri.startsWith("data:image/png;")).toBe(true);
    const descriptor = await app.openFilesImageGallery({ kind: "workspace-entry", entry }); const page = await app.loadImageGalleryPage(descriptor.leaseId, 0);
    expect(page).toMatchObject({ sourceMediaType: mediaType, expectedWidthPixels: 3, expectedHeightPixels: 2, originalOnly,
      sourceBase64: Buffer.from(bytes).toString("base64") });
    expect(() => app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId,
      { width: 20, height: 10, mediaType, isAnimated: false })).toThrow(/decoded image/u);
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, { width: 3, height: 2, mediaType: page.previewMediaType ?? mediaType, isAnimated: false });
    if (!originalOnly) {
      const output = await app.prepareImageOutput(page.leaseId, { width: 3, height: 2, mediaType, isAnimated: false });
      expect(output).toMatchObject({ mediaType, width: 3, height: 2 }); expect(output.bytes).toEqual(bytes);
    }
    app.cancelImageGallery(descriptor.leaseId); app.openGeneratedFiles(); await app.previewArtifact(artifact);
    expect(app.state.files.preview).toMatchObject({ kind: "image", mediaType, widthPixels: 3, heightPixels: 2 });
    expect(network.materializeWorkspaceFileBlob).not.toHaveBeenCalled(); expect(network.submit).not.toHaveBeenCalled();
  });

  it("retires original gallery sharing on cancellation and rejects fresh source drift before native dispatch", async () => {
    const bytes = gifBytes(true); const message = timelinePreviewEvent("moving.gif", "image/gif", bytes, "b".repeat(64));
    const network = projectedNetwork(timelineGallerySnapshot(message));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/gif" });
    vi.mocked(network.readAround).mockResolvedValue([message]);
    vi.mocked(network.authorizeBlobDownload).mockResolvedValue({ url: credential.origin + "/v1/blobs/ticket", headers: { authorization: "Bearer private-key" },
      blobId: "timeline-moving.gif", fileName: "moving.gif", mediaType: "image/gif", byteSize: bytes.byteLength, sha256Hex: "b".repeat(64) });
    let request!: Parameters<MobileFileShare["perform"]>[0]; let finish!: () => void;
    const perform = vi.fn(async (value: typeof request) => { request = value; await new Promise<void>((resolve) => { finish = resolve; }); await request.assertCurrent(); });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, fixedIds("cancel-gallery", "cancel-page", "fresh-gallery", "fresh-page"), undefined, undefined, attachmentFileFixture().files,
      undefined, undefined, undefined, { perform });
    await app.start();
    const selected = timelineRows(app.state.detail!.timeline)[0]!.images![0]!;
    const descriptor = await app.openTimelineImageGallery(selected.sourceEventId!, selected.pageId);
    const page = await app.loadImageGalleryPage(descriptor.leaseId, 0);
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, { width: 1, height: 1, isAnimated: true });
    const sharing = app.shareImageGalleryPageOriginal(descriptor.leaseId, page.leaseId); const rejected = expect(sharing).rejects.toThrow();
    await vi.waitFor(() => expect(perform).toHaveBeenCalledOnce());
    await expect(app.shareImageGalleryPageOriginal(descriptor.leaseId, page.leaseId)).rejects.toThrow(/no longer owns/u);
    app.cancelImageGallery(descriptor.leaseId); expect(request.signal!.aborted).toBe(true); finish(); await rejected;
    const next = await app.openTimelineImageGallery(selected.sourceEventId!, selected.pageId);
    const nextPage = await app.loadImageGalleryPage(next.leaseId, 0);
    app.confirmImageGalleryPageDecoded(next.leaseId, nextPage.leaseId, nextPage.pageId, { width: 1, height: 1, isAnimated: true });
    vi.mocked(network.readAround).mockResolvedValue([]);
    await expect(app.shareImageGalleryPageOriginal(next.leaseId, nextPage.leaseId)).rejects.toThrow(/Timeline image changed/u);
    expect(perform).toHaveBeenCalledOnce(); expect(network.authorizeBlobDownload).toHaveBeenCalledOnce();
  });

  it.each(["Workspace", "Generated"])("previews and shares a canonical %s SVG through its exact typed Blob and rejects a changed source", async (origin) => {
    const bytes = svgBytes(); const network = fakeNetwork(); configureFiles(network, handoffSnapshot);
    const imageRevision = create(FileRevisionSchema, { opaqueRevision: "svg-r1", byteSize: BigInt(bytes.byteLength), sha256Hex: "b".repeat(64) });
    const entry = create(WorkspaceEntrySchema, { workspaceId: "workspace", relativePath: "vector.svg", displayName: "vector.svg",
      mediaType: "image/svg+xml", kind: FileKind.REGULAR, revision: imageRevision });
    const blob = create(BlobRefSchema, { blobId: "svg-blob", fileName: "vector.svg", mediaType: "image/svg+xml", byteSize: BigInt(bytes.byteLength),
      sha256Hex: "b".repeat(64), disposition: BlobDisposition.INLINE });
    const artifact = create(ArtifactSchema, { artifactId: "vector-artifact", sessionId: "session", kind: ArtifactKind.IMAGE, title: "Vector", blob });
    vi.mocked(network.listWorkspaceDirectory).mockResolvedValue({ entries: [entry], revision: "svg-directory" });
    vi.mocked(network.listWorkspaceFileIndex).mockResolvedValue({ paths: ["vector.svg"], revision: "svg-index", truncated: false });
    vi.mocked(network.readWorkspaceFile).mockResolvedValue(create(FilePreviewSchema, { entry, content: { case: "text", value: {
      utf8Text: new TextDecoder().decode(bytes), startByte: 0n, endByte: BigInt(bytes.byteLength), totalLines: 1, languageId: "xml" } } }));
    vi.mocked(network.materializeWorkspaceFileBlob).mockResolvedValue({ entry, blob });
    vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [artifact], revision: "svg-catalog" });
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/svg+xml" });
    const authorized: AuthorizedBlobDownload = { url: credential.origin + "/v1/blobs/svg-ticket", headers: { authorization: "Bearer private-key" },
      blobId: blob.blobId, fileName: blob.fileName, mediaType: blob.mediaType, byteSize: bytes.byteLength, sha256Hex: blob.sha256Hex };
    vi.mocked(network.authorizeBlobDownload).mockResolvedValue(authorized);
    const perform = vi.fn(async (request: Parameters<MobileFileShare["perform"]>[0]) => { await request.assertCurrent(); });
    const drafts = memoryDraftStores(); const identity = { profileId: credential.profileId, sessionId: "session" };
    drafts.composer.save(identity, plainTextMobileComposerDraft("Read only")); await drafts.composer.flush(identity);
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, fixedIds("svg-gallery", "svg-load"),
      undefined, drafts, attachmentFileFixture().files, undefined, undefined, undefined, { perform });
    await app.start(); await app.openFiles();
    const source = origin === "Workspace" ? { kind: "workspace-entry" as const, entry } : { kind: "artifact" as const, artifact };
    if (origin === "Workspace") {
      await app.previewWorkspaceEntry(entry);
      expect(network.materializeWorkspaceFileBlob).toHaveBeenCalledWith(credential, "workspace", "vector.svg", imageRevision, expect.any(AbortSignal));
    } else { app.openGeneratedFiles(); await app.previewArtifact(artifact); }
    expect(app.state.files.preview).toMatchObject({ kind: "image", mediaType: "image/svg+xml", widthPixels: 40, heightPixels: 20 });
    const descriptor = await app.openFilesImageGallery(source); const page = await app.loadImageGalleryPage(descriptor.leaseId, 0);
    expect(page).toMatchObject({ annotatable: false, addable: false, sourceMediaType: "image/svg+xml", expectedAnimated: false });
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, { width: 40, height: 20, mediaType: "image/svg+xml", isAnimated: false });
    await app.shareImageGalleryPageOriginal(descriptor.leaseId, page.leaseId);
    expect(perform).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: authorized }));
    if (origin === "Workspace") vi.mocked(network.listWorkspaceDirectory).mockResolvedValue({ entries: [{ ...entry, revision: { ...imageRevision, opaqueRevision: "svg-r2" } }], revision: "svg-directory-next" });
    else vi.mocked(network.listSessionArtifacts).mockResolvedValue({ artifacts: [artifact], revision: "svg-catalog-next" });
    await expect(app.shareImageGalleryPageOriginal(descriptor.leaseId, page.leaseId)).rejects.toThrow(/image changed/u);
    expect(perform).toHaveBeenCalledOnce(); expect(network.authorizeBlobDownload).toHaveBeenCalledOnce();
    expect(await drafts.composer.read(identity)).toEqual(plainTextMobileComposerDraft("Read only"));
  });

  it("prepares canonical inline images independently of Gallery and reauthorizes their cached source", async () => {
    const bytes = iconBytes([{ bytes: iconDibBytes(3, 2), width: 3, height: 2 }]);
    const message = timelinePreviewEvent("icon.ico", "image/x-icon", bytes, createHash("sha256").update(bytes).digest("hex"));
    const network = projectedNetwork(timelineGallerySnapshot(message));
    vi.mocked(network.readAround).mockResolvedValue([message]); vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/x-icon" });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, fixedIds("inline-gallery", "original-page"), undefined, memoryDraftStores());
    await app.start(); const selected = timelineRows(app.state.detail!.timeline)[0]!.images![0]!;
    const preview = await app.prepareTimelineImagePreview(selected.sourceEventId!, selected.pageId, new AbortController().signal);
    expect(preview).toMatchObject({ width: 3, height: 2, mediaType: "image/png" });
    app.confirmTimelineImagePreview(preview.leaseId, { width: 3, height: 2, mediaType: "image/png", isAnimated: false }); app.releaseTimelineImagePreview(preview.leaseId);
    const cached = await app.prepareTimelineImagePreview(selected.sourceEventId!, selected.pageId, new AbortController().signal);
    expect(network.downloadBlob).toHaveBeenCalledOnce(); expect(network.readAround).toHaveBeenCalledTimes(2);
    const gallery = await app.openTimelineImageGallery(selected.sourceEventId!, selected.pageId);
    const original = await app.loadImageGalleryPage(gallery.leaseId, 0);
    expect(original.sourceBase64).toBe(Buffer.from(bytes).toString("base64")); expect(network.downloadBlob).toHaveBeenCalledTimes(2);
    app.setForeground(false); expect(app.timelineImagePreviewOwnerKey()).toBeUndefined();
    expect(() => app.confirmTimelineImagePreview(cached.leaseId, { width: 3, height: 2 })).toThrow(/released|owner/u);
    expect(network.submit).not.toHaveBeenCalled();
  });

  it("uses a generated thumbnail only for inline presentation and keeps authentication failures out of original fallback", async () => {
    const bytes = Uint8Array.from(await sharp({ create: { width: 1, height: 1, channels: 3, background: "orange" } }).webp().toBuffer());
    const message = timelinePreviewEvent("one.webp", "image/webp", bytes, sha256Hex(bytes));
    const network = projectedNetwork(timelineGallerySnapshot(message)); vi.mocked(network.readAround).mockResolvedValue([message]);
    vi.mocked(network.readImageThumbnail).mockResolvedValue(create(ImageThumbnailSchema, { data: bytes, mediaType: "image/webp", sha256Hex: sha256Hex(bytes),
      widthPixels: 1, heightPixels: 1, sourceWidthPixels: 1, sourceHeightPixels: 1 }));
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, fixedIds("thumbnail-gallery", "thumbnail-original"), undefined, memoryDraftStores());
    await app.start(); const selected = timelineRows(app.state.detail!.timeline)[0]!.images![0]!;
    const preview = await app.prepareTimelineImagePreview(selected.sourceEventId!, selected.pageId, new AbortController().signal);
    expect(network.readImageThumbnail).toHaveBeenCalledExactlyOnceWith(credential, expect.objectContaining({ blobId: "timeline-one.webp" }), 1024, expect.any(AbortSignal));
    expect(network.downloadBlob).not.toHaveBeenCalled(); app.releaseTimelineImagePreview(preview.leaseId);
    const gallery = await app.openTimelineImageGallery(selected.sourceEventId!, selected.pageId); vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/webp" });
    await app.loadImageGalleryPage(gallery.leaseId, 0); expect(network.downloadBlob).toHaveBeenCalledOnce(); expect(network.readImageThumbnail).toHaveBeenCalledOnce();
    app.releaseImageGalleryPreview(gallery.leaseId, preview.leaseId, true);
    // A new source/cache miss cannot hide a revoked or malformed thumbnail RPC behind an original download.
    app.setForeground(false); app.setForeground(true); await app.refresh();
    vi.mocked(network.readImageThumbnail).mockRejectedValueOnce(new Error("thumbnail connection revoked"));
    await expect(app.prepareTimelineImagePreview(selected.sourceEventId!, selected.pageId, new AbortController().signal)).rejects.toThrow(/revoked/u);
    expect(network.downloadBlob).toHaveBeenCalledOnce();
  });

  it("pins an exact cached gallery preview independently of the inline view and retires original actions during page replacement", async () => {
    const bytes = iconBytes([{ bytes: iconDibBytes(3, 2), width: 3, height: 2 }]);
    const message = timelinePreviewEvent("icon.ico", "image/x-icon", bytes, sha256Hex(bytes));
    const network = projectedNetwork(timelineGallerySnapshot(message));
    vi.mocked(network.readAround).mockResolvedValue([message]); vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/x-icon" });
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, fixedIds("pinned-gallery", "original-one", "original-two"), undefined, memoryDraftStores());
    await app.start(); const selected = timelineRows(app.state.detail!.timeline)[0]!.images![0]!;
    const controller = new AbortController(); const inline = await app.prepareTimelineImagePreview(selected.sourceEventId!, selected.pageId, controller.signal);
    const gallery = await app.openTimelineImageGallery(selected.sourceEventId!, selected.pageId); expect(app.imageGalleryCurrent(gallery.leaseId)).toBe(true);
    const preview = await app.pinImageGalleryCachedPreview(gallery.leaseId, 0, new AbortController().signal);
    expect(preview?.uri).toBe(inline.uri); expect(preview?.leaseId).not.toBe(inline.leaseId); expect(network.downloadBlob).toHaveBeenCalledOnce();
    controller.abort(); app.confirmTimelineImagePreview(preview!.leaseId, { width: 3, height: 2, mediaType: "image/png", isAnimated: false });
    const original = await app.loadImageGalleryPage(gallery.leaseId, 0);
    app.confirmImageGalleryPageDecoded(gallery.leaseId, original.leaseId, original.pageId, { width: 3, height: 2, mediaType: "image/png", isAnimated: false });
    vi.mocked(network.downloadBlob).mockRejectedValueOnce(new Error("fetch failed"));
    await expect(app.loadImageGalleryPage(gallery.leaseId, 0)).rejects.toThrow("fetch failed");
    expect(() => app.confirmImageGalleryPageDecoded(gallery.leaseId, original.leaseId, original.pageId, { width: 3, height: 2 })).toThrow(/decoded|gallery/u);
    await expect(app.addImageGalleryPageToComposer(gallery.leaseId, original.leaseId)).rejects.toThrow(/decoded gallery/u);
    app.setForeground(false); expect(app.imageGalleryCurrent(gallery.leaseId)).toBe(false);
    expect(() => app.confirmTimelineImagePreview(preview!.leaseId, { width: 3, height: 2 })).toThrow(/released/u);
    expect(await app.pinImageGalleryCachedPreview(gallery.leaseId, 0, new AbortController().signal)).toBeUndefined();
  });

  it("rejects remote Tool replacement before inline download and cancels a late inline result on background", async () => {
    const bytes = gifBytes(); const message = timelinePreviewEvent("old.gif", "image/gif", bytes, createHash("sha256").update(bytes).digest("hex"));
    const tool = toolMediaEvent(message, "toolCallStarted");
    const replacementMessage = timelinePreviewEvent("new.gif", "image/gif", bytes, createHash("sha256").update(bytes).digest("hex"));
    replacementMessage.eventId = "new-tool-output"; replacementMessage.cursor!.sequence = 13n;
    const replacement = toolMediaEvent(replacementMessage, "toolCallUpdated");
    const network = projectedNetwork(timelineGallerySnapshot(tool)); vi.mocked(network.readAround).mockResolvedValue([tool, replacement]);
    const app = client(network, memoryStorage(credential).storage); await app.start(); const selected = timelineRows(app.state.detail!.timeline)[0]!.images![0]!;
    await expect(app.prepareTimelineImagePreview(selected.sourceEventId!, selected.pageId, new AbortController().signal)).rejects.toThrow(/authenticated inline/u);
    expect(network.downloadBlob).not.toHaveBeenCalled(); vi.mocked(network.readAround).mockResolvedValue([tool]);
    let finish!: (value: { bytes: Uint8Array; mediaType: string }) => void;
    vi.mocked(network.downloadBlob).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const loading = app.prepareTimelineImagePreview(selected.sourceEventId!, selected.pageId, new AbortController().signal); const rejected = expect(loading).rejects.toThrow(/cancelled/u);
    await vi.waitFor(() => expect(network.downloadBlob).toHaveBeenCalledOnce()); app.setForeground(false); await rejected;
    finish({ bytes, mediaType: "image/gif" });
  });

  it("refuses original gallery sharing when authenticated history has replaced the selected tool occurrence", async () => {
    const bytes = gifBytes(true);
    const started = toolMediaEvent(timelinePreviewEvent("moving.gif", "image/gif", bytes, "b".repeat(64)), "toolCallStarted");
    const replacementMessage = timelinePreviewEvent("replacement.gif", "image/gif", bytes, "b".repeat(64));
    replacementMessage.eventId = "replacement-event"; replacementMessage.cursor!.sequence = 13n;
    const replacement = toolMediaEvent(replacementMessage, "toolCallUpdated");
    const network = projectedNetwork(timelineGallerySnapshot(started));
    vi.mocked(network.downloadBlob).mockResolvedValue({ bytes, mediaType: "image/gif" });
    vi.mocked(network.readAround).mockResolvedValue([started, replacement]);
    const perform = vi.fn();
    const app = client(network, memoryStorage(credential).storage, undefined, undefined, fixedIds("tool-gallery", "tool-page"), undefined,
      undefined, attachmentFileFixture().files, undefined, undefined, undefined, { perform });
    await app.start(); const selected = timelineRows(app.state.detail!.timeline)[0]!.images![0]!;
    const descriptor = await app.openTimelineImageGallery(selected.sourceEventId!, selected.pageId);
    const page = await app.loadImageGalleryPage(descriptor.leaseId, 0);
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, { width: 1, height: 1, isAnimated: true });
    await expect(app.shareImageGalleryPageOriginal(descriptor.leaseId, page.leaseId)).rejects.toThrow(/source|image/u);
    expect(network.authorizeBlobDownload).not.toHaveBeenCalled(); expect(perform).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "accepted message", label: "Your message", events: (bytes: Uint8Array) => [acceptedTimelineGalleryEvent(bytes)] },
    { kind: "tool result", label: "Tool result", events: (bytes: Uint8Array) => [toolMediaEvent(timelineGalleryEvent(bytes))] },
    { kind: "appended tool result", label: "Tool result", events: timelineToolAppendEvents },
    { kind: "produced artifact", label: "Generated file", events: (bytes: Uint8Array) => [producedArtifactEvent(timelineGalleryEvent(bytes))] },
    { kind: "produced image", label: "Task message", events: (bytes: Uint8Array) => [producedImageEvent(timelineGalleryEvent(bytes))] }
  ])("opens only the selected durable $kind gallery and appends its authenticated decoded page", async ({ label, events: sourceEvents }) => {
    const bytes = galleryPngBytes(5, 4);
    const events = sourceEvents(bytes);
    const network = projectedNetwork(create(SnapshotSchema, { ...timelineGallerySnapshot(events[0]!), timeline: [...events] }));
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
    const initialIndex = row.images!.length - 1;
    const selectedImage = row.images![initialIndex]!;
    const fileName = initialIndex === 1 ? "second.png" : "first.png";
    expect(row.images).toMatchObject(initialIndex === 1 ? [{ title: "First image" }, { title: "Second image" }] : [{ title: "First image" }]);
    const descriptor = await app.openTimelineImageGallery(selectedImage.sourceEventId!, selectedImage.pageId);
    expect(descriptor).toMatchObject({ sourceKind: "timeline", sourceLabel: label, initialIndex });
    expect(descriptor.pages).toHaveLength(row.images!.length);
    const page = await app.loadImageGalleryPage(descriptor.leaseId, descriptor.initialIndex);
    expect(page).toMatchObject({ fileName, pageIndex: initialIndex, pageCount: row.images!.length, addable: true, annotatable: true });
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, {
      width: 5, height: 4, mediaType: "image/png", isAnimated: false
    });
    app.confirmImageGalleryPageDecoded(descriptor.leaseId, page.leaseId, page.pageId, {
      width: 5, height: 4, mediaType: "image/png", isAnimated: false
    });

    const committed = await app.addImageGalleryPageToComposer(descriptor.leaseId, page.leaseId);
    expect(committed).toMatchObject({
      text: "Keep timeline draft",
      attachments: [{ attachmentId: "timeline-output", fileName, kind: "image" }]
    });
    expect(network.downloadBlob).toHaveBeenCalledWith(
      credential,
      expect.objectContaining({ blobId: initialIndex === 1 ? "timeline-image-two" : "timeline-image-one", sha256Hex: "b".repeat(64) }),
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
