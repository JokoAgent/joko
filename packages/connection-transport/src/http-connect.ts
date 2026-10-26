import type { ByteChannel, OperationOptions } from '@jokoagent/linkspan-core';
import { LinkspanError } from '@jokoagent/linkspan-core';
import type { StreamCarrier } from '@jokoagent/linkspan-core/stream';
import type { EndpointTransport } from './endpoint-transport.js';

type Address = Extract<EndpointTransport, { kind: 'http-connect' }>;
type CarrierFactory = (address: Address, options: OperationOptions) => Promise<StreamCarrier>;
let factory: CarrierFactory | undefined;

/** Node installs a lazy carrier factory; browser code never imports Node sockets. */
export function setHttpConnectCarrierFactory(value: CarrierFactory): void { factory = value; }

export async function connectHttpConnectEndpoint(address: Address, options: OperationOptions & { readonly expectedPublicKey: string }): Promise<ByteChannel> {
  if (factory === undefined) throw new LinkspanError('unavailable', 'HTTP CONNECT requires an installed native connection binding.');
  options.signal?.throwIfAborted();
  const { expectedPublicKey, ...operation } = options;
  const carrier = await factory(address, operation);
  try {
    const { connectStream } = await import('@jokoagent/linkspan-noise');
    options.signal?.throwIfAborted();
    return await connectStream(carrier, { ...operation, expectedPublicKey });
  } catch (error) { carrier.abort(error); throw error; }
}
