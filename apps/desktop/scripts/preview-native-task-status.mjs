import { createServer } from "node:http";

import { renderNativeTaskStatusDocument } from "../dist/mac-native-task-status-host.js";

const settings = Object.freeze({
  enabled: true,
  display: Object.freeze({ mode: "all" }),
  layout: "normal",
  sounds: Object.freeze({
    enabled: true,
    sounds: Object.freeze({
      start: Object.freeze({ type: "builtin", id: "startup-chime" }),
      attention: Object.freeze({ type: "builtin", id: "secret-chime" }),
      complete: Object.freeze({ type: "builtin", id: "gem-collect" }),
      error: Object.freeze({ type: "builtin", id: "error-buzz" }),
      select: Object.freeze({ type: "builtin", id: "none" })
    })
  })
});

const running = Object.freeze({
  sessionId: "running",
  title: "Implement desktop preview",
  detail: "Building the real Task Status surface",
  phase: "running",
  activityLines: Object.freeze([
    Object.freeze({ id: "running-user", kind: "user", text: "Check visual consistency" }),
    Object.freeze({ id: "running-assistant", kind: "assistant", text: "Aligning semantic tokens and icons" }),
    Object.freeze({ id: "running-tool", kind: "tool", text: "Running focused verification" })
  ]),
  updatedAt: 12
});
const permission = Object.freeze({
  sessionId: "permission",
  title: "Update workspace files",
  detail: "Needs permission to run a guarded action",
  phase: "interaction",
  interactionKind: "permission",
  permission: Object.freeze({
    interactionId: "interaction-1",
    generation: "4",
    allow: true,
    allowForSession: true,
    deny: true
  }),
  activityLines: Object.freeze([
    Object.freeze({ id: "permission-assistant", kind: "assistant", text: "Waiting for your decision" })
  ]),
  updatedAt: 14
});
const completed = Object.freeze({
  sessionId: "completed",
  title: "Desktop checks passed",
  detail: "Focused tests completed successfully",
  phase: "completed",
  activityLines: Object.freeze([]),
  updatedAt: 11
});
const failed = Object.freeze({
  sessionId: "failed",
  title: "Packaging needs attention",
  detail: "Signing identity is unavailable on this machine",
  phase: "error",
  activityLines: Object.freeze([]),
  updatedAt: 13
});

const emptyCounts = counts(0);
const cards = Object.freeze([
  card("Idle compact · Light", 340, 46, {
    mode: "compact", policy: "peek", sessions: Object.freeze([]), counts: emptyCounts
  }, "en", "light"),
  card("Running compact · Light", 420, 46, {
    mode: "compact", policy: "peek", current: running,
    sessions: Object.freeze([running]), counts: counts(1, 1)
  }, "en", "light"),
  card("Idle expanded · Light", 420, 210, {
    mode: "expanded", policy: "manual", sessions: Object.freeze([]), counts: emptyCounts
  }, "en", "light"),
  card("Permission expanded · Light", 440, 300, {
    mode: "expanded", policy: "blocking", current: permission,
    sessions: Object.freeze([permission, running]), counts: counts(2, 1, 1)
  }, "en", "light"),
  card("Terminal list · Dark", 440, 300, {
    mode: "expanded", policy: "manual", current: failed,
    sessions: Object.freeze([failed, completed, running]), counts: counts(3, 1, 0, 1, 1)
  }, "en", "dark"),
  card("运行中紧凑态 · Dark", 420, 46, {
    mode: "compact", policy: "peek", current: running,
    sessions: Object.freeze([running]), counts: counts(1, 1)
  }, "zh-CN", "dark")
]);

const previewDocument = renderPreviewDocument(cards);
const port = previewPort(process.env["JOKO_DESKTOP_TASK_STATUS_PREVIEW_PORT"]);
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`).pathname;
  if (path === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  if ((request.method !== "GET" && request.method !== "HEAD") || path !== "/") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return;
  }
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(request.method === "HEAD" ? undefined : previewDocument);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`Joko Task Status preview: http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

function counts(total, running = 0, interaction = 0, completedCount = 0, error = 0) {
  return Object.freeze({ total, running, interaction, completed: completedCount, error });
}

function card(label, width, height, surface, locale, theme) {
  const document = renderNativeTaskStatusDocument(surface, settings, locale);
  return Object.freeze({ label, width, height, document: forcePreviewTheme(document, theme) });
}

function forcePreviewTheme(document, theme) {
  const light = document.match(/<style>\s*:root \{ ([^}]*) \}/u)?.[1];
  const dark = document.match(/@media \(prefers-color-scheme:dark\) \{ :root \{ ([^}]*) \} \}/u)?.[1];
  const tokens = theme === "dark" ? dark : light;
  if (tokens === undefined) throw new Error(`Task Status ${theme} theme tokens are unavailable.`);
  return document.replace("</head>", `<style>:root{${tokens};color-scheme:${theme}}</style></head>`);
}

function renderPreviewDocument(previewCards) {
  const cases = previewCards.map((previewCard) => `<section class="case">
    <strong>${escapeHtml(previewCard.label)}</strong>
    <div class="stage${previewCard.height === 46 ? " stage--compact" : ""}">
      <iframe title="${escapeHtml(previewCard.label)}" width="${previewCard.width}" height="${previewCard.height}" sandbox srcdoc="${escapeAttribute(previewCard.document)}"></iframe>
    </div>
  </section>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Joko Task Status visual QA</title><style>
    *{box-sizing:border-box}body{margin:0;padding:28px;background:#666;color:#fff;font:13px/1.4 system-ui,sans-serif}h1{margin:0 0 22px;font-size:20px}.grid{display:grid;grid-template-columns:repeat(2,minmax(480px,1fr));gap:24px}.case{min-width:0;padding:16px;border:1px solid rgb(255 255 255/.22);border-radius:18px;background:rgb(0 0 0/.16)}.case>strong{display:block;margin-bottom:12px}.stage{min-height:330px;display:grid;place-items:start center;padding:22px;border-radius:12px;background:repeating-conic-gradient(#666 0 25%,#707070 0 50%) 0/18px 18px}.stage--compact{min-height:110px;align-content:center}iframe{border:0;background:transparent}@media(max-width:1040px){.grid{grid-template-columns:1fr}}@media(max-width:540px){body{padding:14px}.case{overflow:auto}.stage{width:max-content;min-width:100%}}
  </style></head><body><h1>Joko Task Status visual consistency matrix</h1><main class="grid">${cases}</main></body></html>`;
}

function previewPort(value) {
  if (value === undefined) return 4321;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1024 || parsed > 65_535 || String(parsed) !== value) {
    throw new Error("JOKO_DESKTOP_TASK_STATUS_PREVIEW_PORT must be an integer from 1024 through 65535.");
  }
  return parsed;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
