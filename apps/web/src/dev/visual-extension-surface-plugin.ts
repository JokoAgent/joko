import type { Plugin } from "vite";

import { VISUAL_EXTENSION_MAIN_VIEW_ENDPOINT } from "./visual-extension-surface-contract.js";

const DIRECTORY = VISUAL_EXTENSION_MAIN_VIEW_ENDPOINT.slice(0, VISUAL_EXTENSION_MAIN_VIEW_ENDPOINT.lastIndexOf("/") + 1);
const POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors *",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'none'"
].join("; ");

/** Exact DEV-only response used to exercise the production iframe host and its opaque sandbox. */
export function visualExtensionSurfacePlugin(): Plugin {
  return {
    name: "joko-visual-extension-surface",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (pathname !== VISUAL_EXTENSION_MAIN_VIEW_ENDPOINT && pathname !== `${DIRECTORY}app.js`) {
          next();
          return;
        }
        setSurfaceHeaders(response);
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.statusCode = 405;
          response.setHeader("allow", "GET, HEAD");
          response.end();
          return;
        }
        const script = pathname.endsWith("/app.js");
        const content = script ? SCRIPT : HTML;
        response.statusCode = 200;
        response.setHeader("content-type", script ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8");
        response.setHeader("content-length", String(new TextEncoder().encode(content).byteLength));
        response.end(request.method === "HEAD" ? undefined : content);
      });
    }
  };
}

function setSurfaceHeaders(response: { setHeader(name: string, value: string): unknown }): void {
  response.setHeader("access-control-allow-origin", "null");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", POLICY);
  response.setHeader("cross-origin-resource-policy", "cross-origin");
  response.setHeader("permissions-policy", "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Workspace overview</title>
  <style>
    :root { color-scheme: light; font-family: Inter, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f7f6f2; color: #1d211e; }
    main { min-height: 100vh; padding: clamp(20px, 5vw, 64px); background: radial-gradient(circle at top right, #dff3e6, transparent 44%), #f7f6f2; }
    article { max-width: 760px; margin: 0 auto; padding: clamp(24px, 5vw, 52px); border: 1px solid #ced9d0; border-radius: 24px; background: rgba(255,255,255,.9); box-shadow: 0 20px 60px rgba(39,72,50,.12); }
    p { color: #526158; line-height: 1.55; }
    .eyebrow { margin: 0 0 12px; color: #287449; font-size: 12px; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(30px, 7vw, 52px); letter-spacing: -.045em; }
    .grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; margin-top: 32px; }
    .grid div { padding: 18px; border-radius: 16px; background: #edf5ef; }
    strong { display: block; margin-bottom: 7px; font-size: 21px; }
    span { color: #5a695f; font-size: 13px; }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main><article>
    <p class="eyebrow">Managed extension</p>
    <h1>Workspace overview</h1>
    <p>This isolated package view is bound to one installed Resource generation. It cannot access Joko APIs, credentials, navigation, downloads, or the network.</p>
    <div class="grid"><div><strong>48</strong><span>tracked files</span></div><div><strong>3</strong><span>active branches</span></div><div><strong>0</strong><span>unsafe paths</span></div></div>
    <p data-runtime>Waiting for the declared package script…</p>
  </article></main>
  <script type="module" src="./app.js"></script>
</body>
</html>`;

const SCRIPT = `document.documentElement.dataset.extensionRuntime = "ready";
const status = document.querySelector("[data-runtime]");
if (status) status.textContent = "Declared package script active.";
`;
