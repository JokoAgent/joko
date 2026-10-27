import { Code, ConnectError, type Client } from '@connectrpc/connect';
import { ServerAccessService, type GetServerAccessSettingsResponse, type SaveServerAccessEntryRequest, type ChangeServerAccessEntryRequest } from '@joko/contracts';

export interface ServerAccessClient {
  read(requestId?: string): Promise<GetServerAccessSettingsResponse>;
  save(input: ServerAccessSave): Promise<void>;
  change(input: ServerAccessChange): Promise<void>;
}
// Only original public request IDs survive a settings remount/reconnection.
// The owner key contains the verified server and Connection, never a locator.
const pending = new Map<string, string>();
export function serverAccessClient(client: Client<typeof ServerAccessService>, assertCurrent: () => void, owner: string): ServerAccessClient {
  const mutate = async (input: { requestId?: string; action?: string }, call: () => Promise<unknown>) => {
    assertCurrent();
    if (!input.requestId || pending.has(owner) && !['stop', 'reconcile', 'resource_status'].includes(input.action ?? '')) throw new Error('query_original_operation');
    pending.set(owner, input.requestId);
    try { await call(); assertCurrent(); }
    catch (error) {
      if (error instanceof ConnectError && [Code.InvalidArgument, Code.PermissionDenied, Code.Unauthenticated, Code.Aborted, Code.AlreadyExists, Code.FailedPrecondition, Code.NotFound, Code.ResourceExhausted].includes(error.code)) pending.delete(owner);
      throw error;
    }
  };
  return {
    async read(requestId) {
      assertCurrent(); const original = requestId || pending.get(owner) || '';
      const result = await client.getServerAccessSettings({ requestId: original }); assertCurrent();
      if (original && ['completed', 'failed', 'missing', 'outcome_unknown'].includes(result.operationState) && pending.get(owner) === original) pending.delete(owner);
      return result;
    },
    save: input => mutate(input, () => client.saveServerAccessEntry(input)),
    change: input => mutate(input, () => client.changeServerAccessEntry(input))
  };
}
export type ServerAccessSave = Omit<SaveServerAccessEntryRequest, '$typeName'>;
export type ServerAccessChange = Omit<ChangeServerAccessEntryRequest, '$typeName'>;
