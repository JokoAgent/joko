import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import { SlackSocketClient } from "./socket.js";

describe("Slack Socket connection ownership", () => {
  it("retires an unacknowledged envelope on disconnect before the close event and preserves its successor", async () => {
    const fixture = socketFixture();
    try {
      await fixture.client.connect();
      const first = fixture.sockets[0]!;
      first.envelope("lost-before-ack");
      expect((await fixture.client.poll({ cursor: null, timeoutSeconds: 0 })).envelopeId).toBe("lost-before-ack");
      first.receive({ type: "disconnect", reason: "refresh_requested" });
      expect(first.readyState).toBe(WebSocket.CLOSING);
      expect((await fixture.client.poll({ cursor: null, timeoutSeconds: 0 })).envelopeId).toBeNull();
      expect(fixture.sockets).toHaveLength(2);

      const second = fixture.sockets[1]!;
      second.envelope("successor");
      first.finishClose();
      first.envelope("stale");
      expect((await fixture.client.poll({ cursor: null, timeoutSeconds: 0 })).envelopeId).toBe("successor");
      await expect(fixture.client.acknowledge("lost-before-ack")).rejects.toMatchObject({ code: "invalid_input" });
      await fixture.client.acknowledge("successor");
      await fixture.client.acknowledge("successor");
      expect(second.sent).toEqual([{ envelope_id: "successor" }]);
      expect((await fixture.client.poll({ cursor: null, timeoutSeconds: 0 })).nextCursor).toBe("slack:successor");

      second.receive({ type: "disconnect", reason: "link_disabled" });
      await expect(fixture.client.poll({ cursor: null, timeoutSeconds: 0 })).rejects.toMatchObject({ code: "invalid_credential" });
      expect(fixture.openUrl).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.close();
    }
  });

  it("does not apply an old connection's delayed ACK to the reconnected pending envelope", async () => {
    const fixture = socketFixture();
    try {
      await fixture.client.connect();
      const first = fixture.sockets[0]!;
      first.envelope("first");
      first.deferAck = true;
      const acknowledged = fixture.client.acknowledge("first").then(() => "accepted", (error: unknown) => error);
      first.receive({ type: "disconnect", reason: "refresh_requested" });
      expect((await fixture.client.poll({ cursor: null, timeoutSeconds: 0 })).envelopeId).toBeNull();
      const second = fixture.sockets[1]!;
      second.envelope("second");
      first.finishAck();
      expect(await acknowledged).toMatchObject({ code: "network" });
      expect((await fixture.client.poll({ cursor: null, timeoutSeconds: 0 })).envelopeId).toBe("second");
      await fixture.client.acknowledge("second");
      expect((await fixture.client.poll({ cursor: null, timeoutSeconds: 0 })).nextCursor).toBe("slack:second");
    } finally {
      await fixture.close();
    }
  });
});

class ControlledSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  deferAck = false;
  readonly sent: unknown[] = [];
  #ack?: () => void;

  receive(packet: unknown): void { this.emit("message", Buffer.from(JSON.stringify(packet))); }
  envelope(envelopeId: string): void { this.receive({ type: "events_api", envelope_id: envelopeId, payload: {} }); }
  send(bytes: string, complete: (error?: Error) => void): void {
    this.sent.push(JSON.parse(bytes));
    if (this.deferAck) this.#ack = () => complete();
    else complete();
  }
  finishAck(): void { this.#ack?.(); this.#ack = undefined; }
  close(): void { this.readyState = WebSocket.CLOSING; }
  finishClose(): void { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  terminate(): void { this.finishClose(); }
}

function socketFixture() {
  const sockets: ControlledSocket[] = [];
  const openUrl = vi.fn(async () => "ws://127.0.0.1/socket");
  const client = new SlackSocketClient({
    openUrl,
    createSocket: () => {
      const socket = new ControlledSocket();
      sockets.push(socket);
      queueMicrotask(() => socket.receive({ type: "hello" }));
      return socket as unknown as WebSocket;
    }
  });
  return {
    sockets,
    client,
    openUrl,
    close: async () => {
      const closing = client.close();
      for (const socket of sockets) socket.finishClose();
      await closing;
    }
  };
}
