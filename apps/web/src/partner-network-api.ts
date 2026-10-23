import { createClient, type Client, type Transport } from "@connectrpc/connect";
import { PartnerNetworkService } from "@joko/contracts";

export type PartnerNetworkApi = Client<typeof PartnerNetworkService>;

/** The normal authenticated connection owns this generated, room-limited client. */
export function createPartnerNetworkApi(transport: Transport, lifetime: AbortSignal, assertCurrent: () => void): PartnerNetworkApi {
  const rpc = createClient(PartnerNetworkService, transport);
  return Object.fromEntries(Object.entries(rpc).map(([name, method]) => [name,
    async (request: never, options?: { readonly signal?: AbortSignal }) => {
      const signal = options?.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
      signal.throwIfAborted(); assertCurrent(); const result = await method(request, { signal }); signal.throwIfAborted(); assertCurrent(); return result;
    }
  ])) as PartnerNetworkApi;
}
