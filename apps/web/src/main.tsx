import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/jetbrains-mono";
import { App } from "./App.js";
import "./styles.css";
import {
  connectDesktopActivationClickPreference,
  installCurrentWindowActivationClickGuard
} from "./window-activation-click.js";

const disposeActivationClickGuard = installCurrentWindowActivationClickGuard(window);
const disconnectActivationClickPreference = connectDesktopActivationClickPreference(window.jokoDesktop, window);
window.addEventListener("pagehide", () => {
  disposeActivationClickGuard();
  disconnectActivationClickPreference();
}, { once: true });

const root = document.getElementById("root");
if (root === null) throw new Error("Missing application root.");

if (new URLSearchParams(window.location.search).get("globalVoiceOverlay") === "1") {
  void import("./components/GlobalVoiceOverlay.js").then(({ GlobalVoiceOverlay }) => {
    const fixture = import.meta.env.DEV ? globalVoiceOverlayFixture(new URLSearchParams(window.location.search).get("fixture")) : undefined;
    createRoot(root).render(<StrictMode><GlobalVoiceOverlay initialStatus={fixture} /></StrictMode>);
  });
} else if (import.meta.env.DEV && window.location.pathname === "/__visual-harness__") {
  void import("./dev/VisualHarness.js").then(({ VisualHarness }) => {
    createRoot(root).render(<StrictMode><VisualHarness /></StrictMode>);
  });
} else {
  createRoot(root).render(<StrictMode><App /></StrictMode>);
}

function globalVoiceOverlayFixture(value: string | null): JokoDesktopGlobalVoiceStatus | undefined {
  if (value === "listening") return { state: "listening", transcript: "This transcription stays on one line while the active application keeps focus." };
  if (value === "submitting") return { state: "submitting", transcript: "Finishing the current transcription…" };
  if (value === "error") return { state: "error", errorKind: "insertion" };
  return undefined;
}
