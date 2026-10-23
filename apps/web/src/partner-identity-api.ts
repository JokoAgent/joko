import { createClient, type Client, type Transport } from "@connectrpc/connect";
import { PartnerIdentityService } from "@joko/contracts";
export type PartnerIdentityApi = Client<typeof PartnerIdentityService>;
export function createPartnerIdentityApi(transport: Transport, lifetime: AbortSignal, assertCurrent: () => void): PartnerIdentityApi {
  const client = createClient(PartnerIdentityService, transport);
  return Object.fromEntries(Object.entries(client).map(([name, method]) => [name, async (request: never, options?: { readonly signal?: AbortSignal }) => {
    const signal = options?.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
    signal.throwIfAborted(); assertCurrent(); const result = await method(request, { signal }); signal.throwIfAborted(); assertCurrent(); return result;
  }])) as PartnerIdentityApi;
}
