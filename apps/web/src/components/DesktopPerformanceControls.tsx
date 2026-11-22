import { useEffect, useRef, useState, type JSX } from "react";
import { Activity } from "lucide-react";
import { Button, IconButton, Modal } from "./ui.js";
import type { Translator } from "./types.js";

type Api = NonNullable<NonNullable<Window["jokoDesktop"]>["performanceRecording"]>;
type Phase = Awaited<ReturnType<Api["run"]>>;

export function DesktopPerformanceControls({ api, profileId, nativeMenu, t }: {
  readonly api: Api;
  readonly profileId: string;
  readonly nativeMenu: boolean;
  readonly t: Translator;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>();
  const [failed, setFailed] = useState(false);
  const [running, setRunning] = useState(false);
  const request = useRef(0);
  const commandInFlight = useRef(false);
  useEffect(() => {
    const release = api.onOpen(() => setOpen(true));
    return () => {
      release();
      request.current++;
      void api.run("retire", profileId).catch(() => undefined);
    };
  }, [api, profileId]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = () => {
      if (commandInFlight.current) return;
      const current = ++request.current;
      void api.run("state", profileId).then(next => {
        if (active && request.current === current) setPhase(next);
      }, () => {
        if (active && request.current === current) setFailed(true);
      });
    };
    refresh();
    const interval = setInterval(refresh, 700);
    return () => { active = false; clearInterval(interval); };
  }, [open, api, profileId]);

  async function run(command: "start" | "stop" | "reveal"): Promise<void> {
    if (commandInFlight.current) return;
    commandInFlight.current = true;
    const current = ++request.current;
    setRunning(true);
    setFailed(false);
    try {
      const next = await api.run(command, profileId);
      if (request.current === current) setPhase(next);
    } catch {
      if (request.current === current) setFailed(true);
    } finally {
      commandInFlight.current = false;
      if (request.current === current) setRunning(false);
    }
  }

  return <>
    {!nativeMenu && <IconButton label={t("desktop.performance.title")} onClick={() => setOpen(true)}><Activity aria-hidden="true" /></IconButton>}
    <Modal open={open} title={t("desktop.performance.title")} size="small" showClose onClose={() => setOpen(false)}>
      {failed && <p role="alert">{t("desktop.performance.failed")}</p>}
      <p role="status">{phase === "recording" ? t("desktop.performance.recording") : phase === "busy"
        ? t("desktop.performance.busy") : phase === "ready" ? t("desktop.performance.ready")
          : phase === undefined ? t("common.loading") : t("desktop.performance.description")}</p>
      <div className="modal__actions">
        {phase === "ready" && <Button disabled={running} onClick={() => void run("reveal")}>{t("desktop.performance.reveal")}</Button>}
        {phase === "recording" && <Button tone="primary" disabled={running} onClick={() => void run("stop")}>{t("desktop.performance.stop")}</Button>}
        {(phase === "idle" || phase === "ready") && <Button tone="primary" disabled={running} onClick={() => void run("start")}>{t("desktop.performance.start")}</Button>}
      </div>
    </Modal>
  </>;
}
