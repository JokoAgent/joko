import { PassThrough } from "node:stream";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { bindResponseLifetime } from "./http-response-lifetime.js";

it("retires a capability's in-flight HTTP bytes and refuses its next response", async () => {
  const server = Fastify(), lifetime = new AbortController(), bytes = new PassThrough();
  server.get("/private-capability", (_request, reply) => {
    if (!bindResponseLifetime(reply, lifetime.signal)) return reply.code(410).send();
    return reply.header("content-length", "2").send(bytes);
  });
  const url = await server.listen({ host: "127.0.0.1", port: 0 });
  bytes.write(Buffer.from([1]));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${url}/private-capability`); reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    const pending = reader.read(); lifetime.abort();
    await expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(bytes.destroyed).toBe(true));
    expect((await fetch(`${url}/private-capability`)).status).toBe(410);
  } finally { lifetime.abort(); bytes.destroy(); await reader?.cancel().catch(() => {}); await server.close(); }
});
