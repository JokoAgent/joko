import { createClient, type Client, type Transport } from "@connectrpc/connect";
import { PartnerNetworkService } from "@joko/contracts";

export type MobilePartnerNetworkApi = Client<typeof PartnerNetworkService> & { readonly ownerKey: string };
export function createMobilePartnerNetworkApi(transport: Transport, ownerKey: string, assertCurrent: (signal: AbortSignal) => void): MobilePartnerNetworkApi {
  const client = createClient(PartnerNetworkService, transport);
  return { ownerKey, ...Object.fromEntries(Object.entries(client).map(([name, method]) => [name,
    async (request: never, options?: { readonly signal?: AbortSignal }) => {
      const signal = options?.signal ?? new AbortController().signal;
      signal.throwIfAborted(); assertCurrent(signal); const result = await method(request, { signal }); signal.throwIfAborted(); assertCurrent(signal); return result;
    }
  ])) } as MobilePartnerNetworkApi;
}
