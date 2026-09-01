import { PassThrough } from "node:stream";

import {
  DesktopBootstrapFrameDecoder,
  DesktopBootstrapGrant,
  createDesktopBootstrapCommit,
  createDesktopBootstrapRequest,
  decodeDesktopBootstrapCommittedPayload,
  decodeDesktopBootstrapResponsePayload,
  encodeDesktopBootstrapCommitFrame,
  encodeDesktopBootstrapRequestFrame
} from "@joko/contracts/desktop-bootstrap";
import { describe, expect, it } from "vitest";

import {
  receiveDesktopBootstrapRequest,
  sendDesktopBootstrapCommitted,
  sendDesktopBootstrapResponse
} from "./desktop-bootstrap-pipe.js";

const INSTANCE_ID = "4e56f4d8-c6ee-4a17-9a89-56e059b7e592";
const DEVICE_ID = "d6a365ef-ef33-4fb7-a0f1-a02eb57fef75";

describe("Desktop bootstrap pipe", () => {
  it("receives one split frame and retains the request pipe as parent liveness", async () => {
    const pipe = new PassThrough();
    const request = createRequest();
    const frame = encodeDesktopBootstrapRequestFrame(request);
    const receivedPromise = receiveDesktopBootstrapRequest(pipe);
    pipe.write(frame.subarray(0, 3));
    await new Promise((resolve) => setTimeout(resolve, 5));
    pipe.write(frame.subarray(3, 19));
    await new Promise((resolve) => setTimeout(resolve, 5));
    pipe.write(frame.subarray(19));

    const received = await receivedPromise;
    expect(received.request).toEqual(request);
    let disconnected = false;
    void received.parentDisconnected.then(() => { disconnected = true; });
    await Promise.resolve();
    expect(disconnected).toBe(false);
    pipe.end();
    await received.parentDisconnected;
    expect(disconnected).toBe(true);
  });

  it("keeps both pipes through a bounded persistence commit and then confirms it", async () => {
    const request = createRequest();
    const grant = DesktopBootstrapGrant.accept(request, { expectedParentPid: 321, now: () => 1_001 });
    const response = grant.exchange({
      serverId: "orchestrator-node",
      origin: "http://127.0.0.1:4318",
      issueConnection: () => ({
        connection: { id: `desktop-connection_${INSTANCE_ID}`, deviceId: DEVICE_ID },
        authKey: Buffer.alloc(32, 9).toString("base64url")
      })
    });
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));

    await sendDesktopBootstrapResponse(output, response);

    const decoder = new DesktopBootstrapFrameDecoder();
    const [payload] = decoder.push(Buffer.concat(chunks));
    decoder.finish();
    expect(decodeDesktopBootstrapResponsePayload(payload!)).toEqual(response);

    const input = new PassThrough();
    const receivedPromise = receiveDesktopBootstrapRequest(input);
    input.write(encodeDesktopBootstrapRequestFrame(request));
    const received = await receivedPromise;
    const commit = createDesktopBootstrapCommit(request, response, { now: () => 1_002 });
    const commitPromise = received.receiveCommit();
    input.write(encodeDesktopBootstrapCommitFrame(commit));
    const committed = grant.confirmCommit(await commitPromise);
    const finalChunks: Buffer[] = [];
    const finalOutput = new PassThrough();
    finalOutput.on("data", (chunk: Buffer) => finalChunks.push(Buffer.from(chunk)));
    await sendDesktopBootstrapCommitted(finalOutput, committed);
    const finalDecoder = new DesktopBootstrapFrameDecoder();
    const [finalPayload] = finalDecoder.push(Buffer.concat(finalChunks));
    finalDecoder.finish();
    expect(decodeDesktopBootstrapCommittedPayload(finalPayload!)).toEqual(committed);
    received.close();
  });

  it("rejects premature EOF, malformed extra data, and unbounded timeouts without secret-bearing errors", async () => {
    const eofPipe = new PassThrough();
    const eofResult = receiveDesktopBootstrapRequest(eofPipe);
    eofPipe.end();
    await expect(eofResult).rejects.toThrow("private Desktop bootstrap pipe is unavailable");

    const malformedPipe = new PassThrough();
    const malformedResult = receiveDesktopBootstrapRequest(malformedPipe);
    const frame = encodeDesktopBootstrapRequestFrame(createRequest());
    malformedPipe.write(Buffer.concat([Buffer.from(frame), Buffer.of(0)]));
    await expect(malformedResult).rejects.toThrow("private Desktop bootstrap pipe is unavailable");

    await expect(receiveDesktopBootstrapRequest(new PassThrough(), { timeoutMs: 30_001 }))
      .rejects.toThrow("private Desktop bootstrap pipe is unavailable");
  });
});

function createRequest() {
  return createDesktopBootstrapRequest({
    parentPid: 321,
    instanceId: INSTANCE_ID,
    deviceId: DEVICE_ID,
    deviceName: "Joko Desktop",
    platform: "win32",
    appVersion: "0.1.0"
  }, {
    now: () => 1_000,
    randomBytes: () => Uint8Array.from({ length: 32 }, () => 7)
  });
}
