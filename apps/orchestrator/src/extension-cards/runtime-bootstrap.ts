// The isolated page receives literal JavaScript, independent of Node/TS loaders.
// Adapted from the fixed extension host bridge; see NOTICE / LICENSE.cindy.
export const EXTENSION_CARD_RUNTIME_BOOTSTRAP_SOURCE = String.raw`(capabilities) => {
  const target = window;
  const transport = target.__jokoExtensionRequest.bind(window);
  const request = payload => {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error("Invalid extension message.");
    return transport(JSON.parse(serialized));
  };
  const handlers = new Map(), listeners = [], calls = new Map();
  Object.defineProperty(window, "joko", { value: Object.freeze({
    send: payload => request(payload),
    onHostMessage: listener => { if (typeof listener !== "function" || listeners.length >= 64) throw new Error("Invalid event listener."); listeners.push(listener); },
    tools: Object.freeze({ register: (name, handler) => { if (typeof name !== "string" || typeof handler !== "function" || handlers.has(name) || handlers.size >= 64) throw new Error("Invalid tool handler."); handlers.set(name, handler); } }),
    card: Object.freeze({ update: payload => request({ ...payload, type: "card-update", version: 1 }) }),
    ...(capabilities.network ? { network: Object.freeze({ fetch: payload => request({ ...payload, type: "fetch-request" }),
      connections: key => request({ type: "connections-list", key }) }) } : {}),
    ...(capabilities.agent ? { agent: Object.freeze({ run: payload => request({ ...payload, type: "agent-run" }) }) } : {})
  }), writable: false, configurable: false });
  target.__jokoRuntime = {
    async tool(input) {
      const handler = handlers.get(input.name); if (!handler) throw new Error("Tool handler unavailable.");
      const controller = new AbortController(); calls.set(input.callId, controller);
      try { return await handler({ ...input, signal: controller.signal }); } finally { calls.delete(input.callId); }
    },
    event(event) {
      // Acknowledge synchronous capture; provider writes and send countdowns
      // outlive this delivery and retain their own original Connection guard.
      for (const listener of listeners) { try { void Promise.resolve(listener(event)).catch(() => undefined); } catch {} }
    },
    cancel(id) { calls.get(id)?.abort(); }
  };
}`;
