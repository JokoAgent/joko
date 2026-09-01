import { createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import {
  ArtifactService,
  BackendService,
  BrowserService,
  ConnectionService,
  EventService,
  InteractionService,
  OperationService,
  PiService,
  QueueService,
  RunService,
  SchedulerService,
  SessionService,
  TargetService,
  ToolService,
  WorkspaceService as WorkspaceContractService
} from "@joko/contracts";

export interface E2eClients {
  readonly connection: Client<typeof ConnectionService>;
  readonly event: Client<typeof EventService>;
  readonly operation: Client<typeof OperationService>;
  readonly backend: Client<typeof BackendService>;
  readonly target: Client<typeof TargetService>;
  readonly session: Client<typeof SessionService>;
  readonly run: Client<typeof RunService>;
  readonly queue: Client<typeof QueueService>;
  readonly scheduler: Client<typeof SchedulerService>;
  readonly interaction: Client<typeof InteractionService>;
  readonly workspace: Client<typeof WorkspaceContractService>;
  readonly artifact: Client<typeof ArtifactService>;
  readonly tool: Client<typeof ToolService>;
  readonly browser: Client<typeof BrowserService>;
  readonly pi: Client<typeof PiService>;
}

export interface PairedClient {
  readonly authKey: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly clients: E2eClients;
}

export function createE2eClients(baseUrl: string, authKey?: string, timeoutMs = 10_000): E2eClients {
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
    event: createClient(EventService, transport),
    operation: createClient(OperationService, transport),
    backend: createClient(BackendService, transport),
    target: createClient(TargetService, transport),
    session: createClient(SessionService, transport),
    run: createClient(RunService, transport),
    queue: createClient(QueueService, transport),
    scheduler: createClient(SchedulerService, transport),
    interaction: createClient(InteractionService, transport),
    workspace: createClient(WorkspaceContractService, transport),
    artifact: createClient(ArtifactService, transport),
    tool: createClient(ToolService, transport),
    browser: createClient(BrowserService, transport),
    pi: createClient(PiService, transport)
  };
}
