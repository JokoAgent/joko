import { createClient, type Client, type Transport } from "@connectrpc/connect";
import { PartnerIdentityService } from "@joko/contracts";
export type MobilePartnerIdentityApi = Client<typeof PartnerIdentityService> & { readonly ownerKey: string };
export function createMobilePartnerIdentityApi(transport: Transport, ownerKey: string, assertCurrent: (signal: AbortSignal) => void): MobilePartnerIdentityApi {
  const client = createClient(PartnerIdentityService, transport);
  return { ownerKey, ...Object.fromEntries(Object.entries(client).map(([name, method]) => [name, async (request: never, options?: { readonly signal?: AbortSignal }) => {
    const signal = options?.signal ?? new AbortController().signal;
    signal.throwIfAborted(); assertCurrent(signal); const result = await method(request, { signal }); signal.throwIfAborted(); assertCurrent(signal); return result;
  }])) } as MobilePartnerIdentityApi;
}
