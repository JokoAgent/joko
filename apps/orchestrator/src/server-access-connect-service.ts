import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { ServerAccessService } from '@joko/contracts';
import type { OrchestratorApplication } from './application.js';

export function createServerAccessConnectService(application: OrchestratorApplication): ServiceImpl<typeof ServerAccessService> {
  const owner = (context: HandlerContext) => {
    context.signal.throwIfAborted();
    try { return application.connections.authenticate(context.requestHeader.get('authorization') ?? undefined); }
    catch { throw new ConnectError('A normal authorized node connection is required.', Code.Unauthenticated); }
  };
  const manager = () => { if (!application.serverAccess) throw new ConnectError('Server access management is unavailable.', Code.Unavailable); return application.serverAccess; };
  return {
    getServerAccessSettings: (request, context) => { const connection = owner(context); return manager().read(connection, request.requestId); },
    saveServerAccessEntry: (request, context) => { const connection = owner(context); return manager().save(connection, request, context.signal); },
    changeServerAccessEntry: (request, context) => { const connection = owner(context); return manager().change(connection, request); }
  };
}
