import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import * as contract from '@joko/contracts';
import { DESKTOP_HOST_AUTHORIZATION_HEADER } from '@joko/contracts/desktop-bootstrap';
import type { ConnectionManager } from '../connection-manager.js';
import { SpeechError } from './speech-error.js';
import type { DesktopVoiceConversationManager } from './manager.js';

/** No Device, task guest or plugin bearer can acquire this Desktop-only route. */
export function createDesktopVoiceConversationService(manager: DesktopVoiceConversationManager | undefined,
  connections: ConnectionManager): ServiceImpl<typeof contract.DesktopVoiceConversationService> {
  return { controlDesktopVoiceConversation: async (request, context) => {
    const connection = connections.authenticate(context.requestHeader.get('authorization') ?? undefined);
    const proof = context.requestHeader.get(DESKTOP_HOST_AUTHORIZATION_HEADER) ?? '';
    const assertAuthority = () => { connections.authenticateDesktopHost(connection, proof); };
    assertAuthority(); context.signal.throwIfAborted();
    if (!manager) throw new ConnectError('Desktop voice conversation is unavailable.', Code.Unavailable);
    try {
      const result = await manager.control(request, { connection, assertCurrent: assertAuthority });
      assertAuthority(); context.signal.throwIfAborted(); return result;
    } catch (error) {
      if (error instanceof ConnectError) throw error;
      if (context.signal.aborted) throw new ConnectError('Desktop voice request was cancelled.', Code.Canceled);
      if (error instanceof SpeechError && error.code === 'timeout') throw new ConnectError('Speech response timed out.', Code.DeadlineExceeded);
      throw new ConnectError('Desktop voice conversation could not complete. Retry explicitly.', Code.FailedPrecondition);
    }
  } };
}
