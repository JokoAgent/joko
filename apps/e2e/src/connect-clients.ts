import { createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  ArtifactService,
  BackendService,
  BrowserService,
  CollaborationService,
  ConnectionService,
  ContactService,
  DevicePeerService,
  EventService,
  HistoryMaintenanceService,
  ExtensionService,
  InteractionService,
  MessagingService,
  OperationService,
  ObjectiveService,
  PartnerService,
  PartnerGroupService,
  PartnerRoutineService,
  PartnerImportService,
  PiService,
  PortableSessionService,
  QueueService,
  RunService,
  SchedulerService,
  SessionService,
  SettingsService,
  SkillService,
  TargetService,
  TerminalService,
  ToolService,
  VoiceInputService,
  WorktreeService,
  WorkspaceService as WorkspaceContractService
} from "@joko/contracts";

import { rpcTimeoutMs } from "./test-deadlines.js";

export interface E2eClients {
  readonly connection: Client<typeof ConnectionService>;
  readonly collaboration: Client<typeof CollaborationService>;
  readonly contact: Client<typeof ContactService>;
  readonly devicePeer: Client<typeof DevicePeerService>;
  readonly event: Client<typeof EventService>;
  readonly extension: Client<typeof ExtensionService>;
  readonly operation: Client<typeof OperationService>;
  readonly objective: Client<typeof ObjectiveService>;
  readonly partner: Client<typeof PartnerService>;
  readonly partnerGroup: Client<typeof PartnerGroupService>;
  readonly partnerRoutine: Client<typeof PartnerRoutineService>;
  readonly partnerImport: Client<typeof PartnerImportService>;
  readonly backend: Client<typeof BackendService>;
  readonly target: Client<typeof TargetService>;
  readonly session: Client<typeof SessionService>;
  readonly portableSession: Client<typeof PortableSessionService>;
  readonly settings: Client<typeof SettingsService>;
  readonly skill: Client<typeof SkillService>;
  readonly run: Client<typeof RunService>;
  readonly queue: Client<typeof QueueService>;
  readonly scheduler: Client<typeof SchedulerService>;
  readonly interaction: Client<typeof InteractionService>;
  readonly messaging: Client<typeof MessagingService>;
  readonly workspace: Client<typeof WorkspaceContractService>;
  readonly artifact: Client<typeof ArtifactService>;
  readonly historyMaintenance: Client<typeof HistoryMaintenanceService>;
  readonly tool: Client<typeof ToolService>;
  readonly voiceInput: Client<typeof VoiceInputService>;
  readonly browser: Client<typeof BrowserService>;
  readonly pi: Client<typeof PiService>;
  readonly terminal: Client<typeof TerminalService>;
  readonly worktree: Client<typeof WorktreeService>;
}

export interface PairedClient {
  readonly authKey: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly clients: E2eClients;
}

export function createE2eClients(baseUrl: string, authKey?: string, timeoutMs = rpcTimeoutMs): E2eClients {
  const interceptors: Interceptor[] = authKey === undefined ? [] : [
    (next) => (request) => {
      request.header.set("authorization", `Bearer ${authKey}`);
      return next(request);
    }
  ];
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: "1.1",
    useBinaryFormat: true,
    interceptors,
    defaultTimeoutMs: timeoutMs
  });
  return {
    connection: createClient(ConnectionService, transport),
    collaboration: createClient(CollaborationService, transport),
    contact: createClient(ContactService, transport),
    devicePeer: createClient(DevicePeerService, transport),
    event: createClient(EventService, transport),
    extension: createClient(ExtensionService, transport),
    operation: createClient(OperationService, transport),
    objective: createClient(ObjectiveService, transport),
    partner: createClient(PartnerService, transport),
    partnerGroup: createClient(PartnerGroupService, transport),
    partnerRoutine: createClient(PartnerRoutineService, transport),
    partnerImport: createClient(PartnerImportService, transport),
    backend: createClient(BackendService, transport),
    target: createClient(TargetService, transport),
    session: createClient(SessionService, transport),
    portableSession: createClient(PortableSessionService, transport),
    settings: createClient(SettingsService, transport),
    skill: createClient(SkillService, transport),
    run: createClient(RunService, transport),
    queue: createClient(QueueService, transport),
    scheduler: createClient(SchedulerService, transport),
    interaction: createClient(InteractionService, transport),
    messaging: createClient(MessagingService, transport),
    workspace: createClient(WorkspaceContractService, transport),
    artifact: createClient(ArtifactService, transport),
    historyMaintenance: createClient(HistoryMaintenanceService, transport),
    tool: createClient(ToolService, transport),
    voiceInput: createClient(VoiceInputService, transport),
    browser: createClient(BrowserService, transport),
    pi: createClient(PiService, transport),
    terminal: createClient(TerminalService, transport),
    worktree: createClient(WorktreeService, transport)
  };
}
