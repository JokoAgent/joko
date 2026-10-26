import type { FastifyReply } from "fastify";

/** Bind an already authorized capability response to its original owner. */
export function bindResponseLifetime(reply: FastifyReply, signal: AbortSignal | undefined): boolean {
  if (reply.raw.destroyed) return false;
  if (signal === undefined) return true;
  if (signal.aborted) return false;
  const retire = () => reply.raw.destroy();
  const dispose = () => { signal.removeEventListener("abort", retire); reply.raw.removeListener("finish", dispose); reply.raw.removeListener("close", dispose); };
  signal.addEventListener("abort", retire, { once: true });
  reply.raw.once("finish", dispose); reply.raw.once("close", dispose);
  return true;
}
