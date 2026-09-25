import { createServer, type Server } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { SimulatorMjpegParser, parseSimulatorMjpegBoundary, streamSimulatorMjpeg } from "./mjpeg-stream.js";

const JPEG = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
const encoder = new TextEncoder();
const servers: Server[] = [];

function part(bytes = JPEG, length = bytes.length): Uint8Array {
  const head = encoder.encode(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${length}\r\n\r\n`);
  const result = new Uint8Array(head.length + bytes.length + 2);
  result.set(head);
  result.set(bytes, head.length);
  result.set([13, 10], head.length + bytes.length);
  return result;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

it("parses arbitrary multipart chunk boundaries without scanning JPEG payload for delimiters", () => {
  expect(parseSimulatorMjpegBoundary('multipart/x-mixed-replace; boundary="--frame"')).toBe("frame");
  const parser = new SimulatorMjpegParser("frame");
  const payload = part();
  const frames: Uint8Array[] = [];
  for (const byte of payload) frames.push(...parser.push(new Uint8Array([byte])));
  expect(frames).toEqual([JPEG]);
  parser.finish();
  expect(parser.push(encoder.encode("--frame--"))).toEqual([]);
});

it("fails closed on malformed content type, frame length, oversized header and non-JPEG body", () => {
  expect(() => parseSimulatorMjpegBoundary("image/jpeg")).toThrow();
  expect(() => parseSimulatorMjpegBoundary("multipart/x-mixed-replace; boundary=bad\r\n"))
    .toThrow();
  expect(() => new SimulatorMjpegParser("frame", { maxFrameBytes: 4 }).push(part()))
    .toThrowError(expect.objectContaining({ code: "STREAM_TOO_LARGE" }));
  expect(() => new SimulatorMjpegParser("frame", { maxHeaderBytes: 8 }).push(part()))
    .toThrowError(expect.objectContaining({ code: "STREAM_TOO_LARGE" }));
  expect(() => new SimulatorMjpegParser("frame").push(part(new Uint8Array([1, 2, 3, 4]))))
    .toThrowError(expect.objectContaining({ code: "STREAM_INVALID" }));
  expect(() => new SimulatorMjpegParser("frame").push(part(JPEG, 0)))
    .toThrowError(expect.objectContaining({ code: "STREAM_INVALID" }));
});

it("reads only fixed loopback MJPEG, enforces stream budget and closes on cancellation", async () => {
  let closed = false;
  const server = createServer((_request, response) => {
    response.on("close", () => { closed = true; });
    response.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    response.write(part());
    response.write(part());
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port.");
  const controller = new AbortController();
  const stream = streamSimulatorMjpeg(address.port, { signal: controller.signal });
  expect((await stream.next()).value?.bytes).toEqual(JPEG);
  controller.abort();
  expect((await stream.next()).done).toBe(true);
  await vi.waitFor(() => expect(closed).toBe(true));
  await expect(async () => {
    for await (const _frame of streamSimulatorMjpeg(address.port, { maxStreamBytes: 2 })) { /* budget */ }
  }).rejects.toMatchObject({ code: "STREAM_TOO_LARGE" });
  await expect(async () => {
    for await (const _frame of streamSimulatorMjpeg(80)) { /* port admission */ }
  }).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
});

it("cuts off a stalled owned MJPEG connection without exposing host output", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "multipart/x-mixed-replace; boundary=frame" });
    response.flushHeaders();
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback port.");
  const stream = streamSimulatorMjpeg(address.port, { idleTimeoutMs: 25 });
  await expect(stream.next()).rejects.toMatchObject({ code: "STREAM_TIMEOUT" });
});
