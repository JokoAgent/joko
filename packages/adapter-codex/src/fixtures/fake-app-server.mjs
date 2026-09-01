import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  if (line.length === 0) return;
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "late") {
    setTimeout(() => write({ id: message.id, result: { late: true } }), 60);
    return;
  }
  if (message.method === "oversize") {
    write({ id: message.id, result: { value: "x".repeat(32_000) } });
    return;
  }
  if (message.method === "malformed-response") {
    write({ id: message.id });
    return;
  }
  if (message.method === "ordered-notifications") {
    write({ method: "fixture/event", params: { sequence: 1 } });
    write({ method: "fixture/event", params: { sequence: 2 } });
    write({ id: message.id, result: {} });
    return;
  }
  if (message.method === "hang-on-close") {
    process.on("SIGTERM", () => undefined);
    setInterval(() => undefined, 1_000).unref?.();
    // Keep one referenced handle alive after stdin closes so POSIX graceful
    // retirement must escalate to a hard stop.
    globalThis.__fixtureKeepAlive = setInterval(() => undefined, 1_000);
    write({ id: message.id, result: { pid: process.pid } });
    return;
  }
  if (message.method === "read-environment") {
    const names = Array.isArray(message.params?.names)
      ? message.params.names.filter((name) => typeof name === "string").slice(0, 32)
      : [];
    write({
      id: message.id,
      result: Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]))
    });
    return;
  }
  write({ id: message.id, result: { method: message.method, params: message.params ?? null } });
});

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
