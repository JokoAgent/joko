import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { capabilityNames, RunState } from "@joko/contracts";
import type { AdapterContext, PromptInput } from "@joko/core";
import { PI_LIKE_PROFILE } from "@joko/testkit";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

class PdfTaskAdapter extends InstrumentedFakeAdapter {
  override async send(_input: PromptInput, context: AdapterContext): Promise<void> {
    await context.emit({ type: "message_complete", role: "assistant", blocks: [
      { kind: "text", text: "[Reference PDF](./docs/manual.pdf)" }
    ] });
    await context.emit({ type: "done", outcome: "completed" });
  }
}

async function observePdfTask(): Promise<void> {
  if (!process.send || !process.connected) throw new Error("The iOS PDF fixture requires its owned supervisor.");
  const disconnected = once(process, "disconnect");
  const setupStep = (step: string): void => {
    if (process.connected) process.send?.({ kind: "setupStep", step });
  };
  setupStep("child-started");
  const profile = { ...PI_LIKE_PROFILE, capabilities: [
    ...PI_LIKE_PROFILE.capabilities,
    { key: capabilityNames.workspaceFiles, supported: true as const }
  ] };
  let openedForSimulator = false;
  const fixture = await OrchestratorE2eFixture.start({ profiles: [profile], serverId: "ios-workspace-pdf", webRtc: true,
    createAdapter: entry => new PdfTaskAdapter(entry),
    observeIdentityTransport: (effect, status) => {
      if (openedForSimulator && process.connected) process.send?.({ kind: "simulatorIdentityTransport", effect, status });
    }
  });
  let observePairing: ReturnType<typeof setInterval> | undefined;
  let removePairingListener: (() => void) | undefined;
  const openForSimulator = (message: unknown): void => {
    if (openedForSimulator || !process.connected || !message || typeof message !== "object"
      || !("kind" in message) || message.kind !== "openSimulatorPairingWindow") return;
    openedForSimulator = true;
    const previouslyOpen = fixture.application.connections.pairingEnabled;
    fixture.application.connections.openPairingWindow();
    process.send?.({ kind: "simulatorPairingWindow", previouslyOpen, open: fixture.application.connections.pairingEnabled });
  };
  try {
    if (!process.connected) return;
    setupStep("node-started");
    const { application } = fixture;
    const publicKey = application.linkspanIdentity?.publicKey;
    if (!publicKey) throw new Error("The owned PDF node did not publish a Linkspan public key.");
    const targetId = fixture.targetId(profile.id);
    const docs = join(application.store.getTarget(targetId).descriptor.workspaceRoot, "docs");
    const bytes = pdfPage();
    await mkdir(docs);
    await writeFile(join(docs, "manual.pdf"), bytes);
    const manager = await fixture.pair("PDF fixture manager");
    setupStep("manager-paired");
    const index = await manager.clients.workspace.listWorkspaceFiles({ workspaceId: "workspace-main" });
    if (!index.relativePaths.includes("docs/manual.pdf")) throw new Error("The paired Workspace index did not include the original PDF.");
    setupStep("workspace-index-ready");
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId: profile.id, targetId, displayName: "Original workspace PDF task" })));
    const generation = BigInt(application.store.getSession(sessionId).descriptor.binding.generation);
    await submit(manager.clients.operation, manager.connectionId,
      sendInputMutation(sessionId, generation, "Show the original Workspace PDF."));
    await waitFor(async () => {
      const runs = application.store.listRuns({ sessionId });
      return runs.length === 1
        && (await manager.clients.run.getRun({ runId: runs[0]!.descriptor.id })).run?.state === RunState.SUCCEEDED;
    }, (succeeded) => succeeded, "the original PDF task's completed message");

    if (!process.connected) return;
    setupStep("original-task-completed");
    removePairingListener = application.connections.onPairingIssued(({ code }) => {
      if (process.connected) process.send?.({ kind: "pairingCode", code });
    });
    observePairing = setInterval(() => {
      const ios = application.store.listDevices().filter((device) => device.kind === "mobile" && device.platform.toLowerCase() === "ios");
      if (ios.length !== 1 || !process.connected) return;
      if (application.store.listConnections().filter((connection) => connection.deviceId === ios[0]!.id
        && connection.state === "active").length !== 1) return;
      clearInterval(observePairing);
      process.send?.({ kind: "paired" });
    }, 150);
    process.on("message", openForSimulator);
    process.send({ kind: "ready", origin: fixture.baseUrl, publicKey, pdfSha256: createHash("sha256").update(bytes).digest("hex") });
    await disconnected;
  } finally {
    clearInterval(observePairing);
    process.off("message", openForSimulator);
    removePairingListener?.();
    fixture.dropPublicConnections();
    await fixture.close();
  }
}

function pdfPage(): Buffer {
  const text = "BT /F1 30 Tf 60 660 Td (Quartz) Tj 0 -52 Td (River) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const rows = offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${body}xref\n0 6\n0000000000 65535 f \n${rows}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`, "ascii");
}

await observePdfTask().catch((error: unknown) => {
  console.error("The owned iOS PDF fixture failed:", error instanceof Error ? error.message : String(error));
  if (process.connected) process.disconnect?.();
  process.exitCode = 1;
});
