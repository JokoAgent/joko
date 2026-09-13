import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { RotateCw } from "lucide-react";
import type { AppController } from "../controller.js";
import type { TerminalCapabilitiesView, TerminalView } from "../model.js";
import { readTerminalAppearance } from "../terminal-appearance.js";
import { randomUuid } from "../web-crypto.js";
import { Button, Pill } from "./ui.js";
import type { Translator } from "./types.js";

export function InteractiveTerminalPanel({ controller, sessionId, terminalId, active, capabilities, t, onState }: {
  readonly controller: AppController;
  readonly sessionId: string;
  readonly terminalId: string;
  readonly active: boolean;
  readonly capabilities: TerminalCapabilitiesView;
  readonly t: Translator;
  readonly onState: (terminal: TerminalView) => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<() => void>(() => undefined);
  const latest = useRef({ controller, active, onState, capabilities, t });
  latest.current = { controller, active, onState, capabilities, t };
  const [descriptor, setDescriptor] = useState<TerminalView>();
  const descriptorRef = useRef<TerminalView | undefined>(undefined);
  const [connection, setConnection] = useState<"connecting" | "ready" | "reconnecting" | "error">("connecting");
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const [error, setError] = useState<string>();
  const [inputNotice, setInputNotice] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [restarting, setRestarting] = useState(false);
  const restartAttemptRef = useRef<{ readonly scope: string; readonly generation: bigint; readonly id: string; pending: boolean } | undefined>(undefined);
  const cursorRef = useRef<{ generation: bigint; sequence: bigint } | undefined>(undefined);
  const parsingRef = useRef(Promise.resolve());
  const restoringScreenRef = useRef(false);
  const dimensionsRef = useRef("");
  const overridesRef = useRef("");
  const displayAbortRef = useRef(new AbortController());
  const appearanceRef = useRef<{ signal: AbortSignal; viewId: string; synchronize: (focus: boolean) => Promise<void>; cancelFocus: () => void; captureControl: () => { readonly signal: AbortSignal; readonly ready: Promise<void> } } | undefined>(undefined);
  const connectionOwner = controller.watchTerminal;
  const writerRef = useRef({ id: randomUuid(), sequence: 0n, generation: 0n, blocked: false, chain: Promise.resolve() });
  const scope = `${controller.state.activeProfile?.serverId ?? ""}\u0000${controller.state.activeProfile?.id ?? ""}\u0000${sessionId}\u0000${terminalId}`;
  const connected = controller.state.connectionState === "connected";
  const policyDisabled = capabilities.support === "disabledByPolicy";
  const scopeRef = useRef<string | undefined>(scope);
  scopeRef.current = scope;
  const focusAfterConnectRef = useRef<{ readonly scope: string; readonly element: Element | null } | undefined>(undefined);
  useLayoutEffect(() => { if (!active) appearanceRef.current?.cancelFocus(); }, [active]);
  useLayoutEffect(() => {
    if (policyDisabled) {
      appearanceRef.current?.cancelFocus();
      if (terminalRef.current !== undefined) terminalRef.current.options.disableStdin = true;
    } else if (connectionRef.current === "ready") {
      fitRef.current();
      void appearanceRef.current?.synchronize(false).catch(() => undefined);
    }
  }, [policyDisabled]);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    const ownerWindow = slot?.ownerDocument.defaultView;
    if (slot === null || ownerWindow === null || ownerWindow === undefined) return;
    scopeRef.current = scope;
    let alive = true;
    const api = controller;
    const displayAbort = new AbortController();
    displayAbortRef.current = displayAbort;
    overridesRef.current = "";
    const terminal = new Terminal({ cursorBlink: true, scrollback: 1_000, disableStdin: true, theme: readTerminalAppearance(slot).theme, linkHandler: { activate: (_event, uri) => { void latest.current.controller.openHttpLink(uri, { forceExternal: true }).catch(() => undefined); } } });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => { void latest.current.controller.openHttpLink(uri, { forceExternal: true }).catch(() => undefined); }));
    terminal.open(slot);
    terminalRef.current = terminal;
    cursorRef.current = undefined;
    parsingRef.current = Promise.resolve();
    restoringScreenRef.current = false;
    dimensionsRef.current = "";
    descriptorRef.current = undefined;
    restartAttemptRef.current = undefined;
    writerRef.current = { id: randomUuid(), sequence: 0n, generation: 0n, blocked: false, chain: Promise.resolve() };
    setDescriptor(undefined);
    setRestarting(false);
    setError(undefined);
    setInputNotice(undefined);
    focusAfterConnectRef.current = undefined;
    const queries = suppressTerminalQueryReplies(terminal);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && event.code === "KeyC" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing && terminal.hasSelection()) {
        event.preventDefault();
        void ownerWindow.navigator.clipboard?.writeText(terminal.getSelection()).catch(() => undefined);
        return false;
      }
      return true;
    });
    const input = terminal.onData((data) => {
      const current = descriptorRef.current;
      if (current === undefined || current.status !== "running" || connectionRef.current !== "ready" || !latest.current.active || latest.current.capabilities.support === "disabledByPolicy" || latest.current.controller.state.connectionState !== "connected") return;
      if (data === "") return;
      const maximumInputBytes = latest.current.capabilities.maximumInputBytes;
      if (terminalInputByteLength(data) > maximumInputBytes) {
        setInputNotice(latest.current.t("terminal.inputTooLarge", { maximum: maximumInputBytes }));
        return;
      }
      setInputNotice(undefined);
      const appearance = appearanceRef.current;
      if (appearance === undefined || appearance.signal.aborted) return;
      if (writerRef.current.generation !== current.generation || writerRef.current.id !== appearance.viewId) writerRef.current = { id: appearance.viewId, sequence: 0n, generation: current.generation, blocked: false, chain: Promise.resolve() };
      const writer = writerRef.current;
      if (writer.blocked) return;
      const admission = appearance.captureControl();
      void admission.ready.catch(() => undefined);
      let sent = false;
      writer.chain = writer.chain.then(async () => {
        if (writer.blocked || !alive || writerRef.current !== writer || descriptorRef.current?.generation !== current.generation) return;
        try { await admission.ready; }
        catch (failure) {
          if (!(failure instanceof DOMException && failure.name === "AbortError") && !appearance.signal.aborted) writer.blocked = true;
          return;
        }
        if (appearance.signal.aborted || appearanceRef.current !== appearance || writerRef.current !== writer) return;
        if (admission.signal.aborted || latest.current.capabilities.support === "disabledByPolicy") {
          if (sent) { writer.blocked = true; terminal.options.disableStdin = true; setError(latest.current.t("terminal.inputUncertain")); }
          return;
        }
        const sequence = ++writer.sequence;
        sent = true;
        await api.writeTerminal(sessionId, terminalId, current.generation, writer.id, sequence, data, admission.signal);
      }).catch(() => {
        writer.blocked = true;
        if (!alive || scopeRef.current !== scope || writerRef.current !== writer || descriptorRef.current?.generation !== current.generation) return;
        terminal.options.disableStdin = true;
        setError(latest.current.t("terminal.inputUncertain"));
      });
    });
    let frame: number | undefined;
    let resizeChain = Promise.resolve();
    const fitTerminal = (): void => {
      if (frame !== undefined) return;
      frame = ownerWindow.requestAnimationFrame(() => {
        frame = undefined;
        if (!alive || restoringScreenRef.current || !latest.current.active || slot.clientWidth <= 0 || slot.clientHeight <= 0) return;
        const style = ownerWindow.getComputedStyle(slot);
        terminal.options.fontFamily = style.fontFamily;
        terminal.options.fontSize = Number.parseFloat(style.fontSize) || 14;
        fit.fit();
        const columns = Math.max(2, Math.min(terminal.cols, latest.current.capabilities.maximumColumns));
        const rows = Math.max(1, Math.min(terminal.rows, latest.current.capabilities.maximumRows));
        if (columns !== terminal.cols || rows !== terminal.rows) terminal.resize(columns, rows);
        const current = descriptorRef.current;
        if (current === undefined || current.status !== "running" || latest.current.capabilities.support === "disabledByPolicy" || latest.current.controller.state.connectionState !== "connected") return;
        const appearance = appearanceRef.current;
        if (appearance === undefined || appearance.signal.aborted || slot.ownerDocument.visibilityState !== "visible"
          || !slot.ownerDocument.hasFocus() || !slot.contains(slot.ownerDocument.activeElement)) return;
        const admission = appearance.captureControl();
        const nextDimensions = `${current.generation}:${columns}:${rows}`;
        if (dimensionsRef.current === nextDimensions) return;
        dimensionsRef.current = nextDimensions;
        resizeChain = resizeChain.then(async () => {
          if (!alive || latest.current.capabilities.support === "disabledByPolicy" || latest.current.controller.state.connectionState !== "connected") { dimensionsRef.current = ""; return; }
          await admission.ready;
          if (admission.signal.aborted || appearanceRef.current !== appearance) { dimensionsRef.current = ""; return; }
          await api.resizeTerminal(sessionId, terminalId, current.generation, appearance.viewId, columns, rows, admission.signal);
        }).catch(() => { dimensionsRef.current = ""; });
      });
    };
    fitRef.current = fitTerminal;
    const resizeObserver = new ownerWindow.ResizeObserver(fitTerminal);
    resizeObserver.observe(slot);
    const refreshTheme = (): void => {
      const parsed = parsingRef.current.then(async () => {
        if (!alive) return;
        terminal.options.theme = readTerminalAppearance(slot).theme;
        await writeTerminalScreen(terminal, overridesRef.current, displayAbort.signal);
      });
      parsingRef.current = parsed.catch(() => undefined);
      void parsed.then(() => appearanceRef.current?.synchronize(false)).catch((failure: unknown) => {
        if (!alive || failure instanceof DOMException && failure.name === "AbortError") return;
        terminal.options.disableStdin = true;
        setError(failure instanceof Error ? failure.message : latest.current.t("terminal.disconnected"));
      });
      fitTerminal();
    };
    const themeObserver = new ownerWindow.MutationObserver(refreshTheme);
    themeObserver.observe(slot.ownerDocument.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    const colorScheme = ownerWindow.matchMedia?.("(prefers-color-scheme: dark)");
    colorScheme?.addEventListener("change", refreshTheme);
    ownerWindow.addEventListener("pageshow", refreshTheme);
    void slot.ownerDocument.fonts?.ready.then(() => { if (alive) fitTerminal(); });
    fitTerminal();
    return () => {
      alive = false;
      displayAbort.abort();
      scopeRef.current = undefined;
      if (frame !== undefined) ownerWindow.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      colorScheme?.removeEventListener("change", refreshTheme);
      ownerWindow.removeEventListener("pageshow", refreshTheme);
      input.dispose();
      queries.forEach((query) => query.dispose());
      terminal.dispose();
      terminalRef.current = undefined;
      fitRef.current = () => undefined;
    };
  }, [scope, connectionOwner]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const slot = slotRef.current;
    const ownerWindow = slot?.ownerDocument.defaultView;
    if (terminal === undefined || slot === null || ownerWindow === undefined || ownerWindow === null) return;
    if (!connected) { terminal.options.disableStdin = true; setConnection("reconnecting"); return; }
    const request = new AbortController();
    const ownerDocument = slot.ownerDocument;
    let retry: number | undefined;
    let failures = 0;
    const restoreRequestedFocus = (): void => {
      const focus = focusAfterConnectRef.current;
      if (focus === undefined) return;
      focusAfterConnectRef.current = undefined;
      ownerWindow.requestAnimationFrame(() => {
        const document = slotRef.current?.ownerDocument;
        if (request.signal.aborted || document === undefined || scopeRef.current !== focus.scope || !latest.current.active) return;
        if (document.activeElement === document.body || document.activeElement === focus.element) terminal.focus();
      });
    };
    const accept = (value: TerminalView): void => {
      if (value.columns !== terminal.cols || value.rows !== terminal.rows) dimensionsRef.current = "";
      const attempt = restartAttemptRef.current;
      if (attempt?.scope === scope && attempt.generation !== value.generation) {
        restartAttemptRef.current = undefined;
        setRestarting(false);
      }
      descriptorRef.current = value;
      setDescriptor(value);
      latest.current.onState(value);
      if (value.status !== "running") terminal.options.disableStdin = true;
    };
    const api = controller;
    let currentWatch: AbortController | undefined;
    const focused = (): boolean => latest.current.active && latest.current.controller.watchTerminal === connectionOwner
      && latest.current.controller.state.connectionState === "connected" && slot.ownerDocument.visibilityState === "visible"
      && slot.ownerDocument.hasFocus() && slot.contains(slot.ownerDocument.activeElement);
    const focus = (): void => {
      if (focused()) void appearanceRef.current?.synchronize(true).then(() => fitRef.current()).catch(() => undefined);
    };
    const blur = (): void => { if (!focused()) appearanceRef.current?.cancelFocus(); };
    slot.addEventListener("focusin", focus);
    slot.addEventListener("focusout", blur);
    ownerWindow.addEventListener("blur", blur);
    ownerWindow.addEventListener("focus", focus);
    slot.ownerDocument.addEventListener("visibilitychange", focus);
    slot.ownerDocument.addEventListener("visibilitychange", blur);
    const pagehide = (): void => { request.abort(); terminal.options.disableStdin = true; };
    const pageshow = (): void => {
      if (request.signal.aborted && terminalRef.current === terminal && slot.isConnected && slot.ownerDocument === ownerDocument
        && !ownerWindow.closed && ownerWindow.document === ownerDocument && latest.current.controller.watchTerminal === connectionOwner
        && latest.current.controller.state.connectionState === "connected") setRevision((value) => value + 1);
    };
    ownerWindow.addEventListener("pagehide", pagehide, { once: true });
    ownerWindow.addEventListener("pageshow", pageshow);
    const watch = async (): Promise<void> => {
      currentWatch?.abort();
      const lifetime = new AbortController();
      currentWatch = lifetime;
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      const current = (): boolean => !signal.aborted && terminalRef.current === terminal && currentWatch === lifetime
        && slot.isConnected && slot.ownerDocument === ownerDocument && !ownerWindow.closed && ownerWindow.document === ownerDocument
        && latest.current.controller.watchTerminal === connectionOwner;
      let focusLifetime = new AbortController();
      const cancelFocus = (): void => { focusLifetime.abort(); focusLifetime = new AbortController(); };
      let registered = false;
      let viewRevision = 1n;
      let appearanceRevision = 0n;
      let appearanceChain = Promise.resolve();
      let appearancePending = 0;
      let appearanceFailed = false;
      let confirmed: { readonly revision: bigint; readonly palette: string; readonly ownsDefaults: boolean } | undefined;
      const viewId = randomUuid();
      setConnection(cursorRef.current === undefined ? "connecting" : "reconnecting");
      connectionRef.current = cursorRef.current === undefined ? "connecting" : "reconnecting";
      terminal.options.disableStdin = true;
      try {
        await parsingRef.current;
        if (!current()) return;
        const value = await api.getTerminal(sessionId, terminalId, 0n, signal);
        if (!current()) return;
        accept(value);
        writerRef.current = { id: viewId, sequence: 0n, generation: value.generation, blocked: false, chain: Promise.resolve() };
        if (cursorRef.current?.generation !== value.generation) cursorRef.current = undefined;
        const synchronize = (claim: boolean): Promise<void> => {
          const claimSignal = claim ? AbortSignal.any([signal, focusLifetime.signal]) : signal;
          appearancePending += 1;
          if (current() && registered) terminal.options.disableStdin = true;
          const task = appearanceChain.then(async () => {
            if (!current() || !registered || claimSignal.aborted) throw new DOMException("Terminal view retired.", "AbortError");
            if (latest.current.capabilities.support === "disabledByPolicy") throw new DOMException("Terminal view is read-only.", "AbortError");
            if (descriptorRef.current?.status !== "running") {
              if (claim) throw new DOMException("Terminal view retired.", "AbortError");
              return;
            }
            if (claim && !focused()) throw new DOMException("Terminal view is not focused.", "AbortError");
            const palette = readTerminalAppearance(slot).palette;
            const paletteKey = JSON.stringify(palette);
            if (confirmed?.revision === appearanceRevision && confirmed.palette === paletteKey && (!claim || confirmed.ownsDefaults)) return;
            let revision = ++viewRevision;
            for (let attempt = 0; attempt < 4; attempt += 1) {
              if (!current() || claimSignal.aborted || claim && !focused()) throw new DOMException("Terminal appearance retired.", "AbortError");
              const result = await api.updateTerminalAppearance(sessionId, terminalId, value.generation, { viewId, viewRevision: revision, palette }, claim, claim ? appearanceRevision : 0n, claimSignal).catch((failure: unknown) => {
                if (claimSignal.aborted || !current() || claim && !focused()) throw new DOMException("Terminal appearance retired.", "AbortError");
                throw failure;
              });
              if (!current() || claimSignal.aborted || claim && !focused()) throw new DOMException("Terminal appearance retired.", "AbortError");
              appearanceRevision = appearanceRevision > result.appearanceRevision ? appearanceRevision : result.appearanceRevision;
              if (result.accepted) {
                if (claim && !result.ownsDefaults) { revision = ++viewRevision; continue; }
                confirmed = { revision: result.appearanceRevision, palette: paletteKey, ownsDefaults: result.ownsDefaults };
                appearanceFailed = false;
                return;
              }
            }
            throw new Error(latest.current.t("terminal.disconnected"));
          });
          appearanceChain = task.catch(() => undefined);
          void task.catch((failure: unknown) => {
            if (!current() || failure instanceof DOMException && failure.name === "AbortError") return;
            appearanceFailed = true;
            terminal.options.disableStdin = true;
            setError(failure instanceof Error ? failure.message : latest.current.t("terminal.disconnected"));
          }).finally(() => {
            appearancePending -= 1;
            if (current() && registered && !appearanceFailed && appearancePending === 0 && descriptorRef.current?.status === "running" && !writerRef.current.blocked && latest.current.capabilities.support !== "disabledByPolicy") terminal.options.disableStdin = false;
          });
          return task;
        };
        const appearance = { signal, viewId, synchronize, cancelFocus, captureControl: () => ({ signal: AbortSignal.any([signal, focusLifetime.signal]), ready: synchronize(true) }) };
        appearanceRef.current = appearance;
        const initialAppearance = { viewId, viewRevision, palette: readTerminalAppearance(slot).palette };
        await api.watchTerminal(sessionId, terminalId, value.generation, initialAppearance, async (update) => {
          if (!current()) return;
          const parsed = parsingRef.current.then(async () => {
            if (terminalRef.current !== terminal) return;
            if (update.kind === "reset") {
              restoringScreenRef.current = true;
              dimensionsRef.current = "";
              overridesRef.current = "";
              terminal.resize(update.terminal.columns, update.terminal.rows);
              terminal.options.theme = readTerminalAppearance(slot).theme;
              terminal.reset();
            }
            await writeTerminalScreen(terminal, update.data, displayAbortRef.current.signal);
            if (terminalRef.current !== terminal) return;
            if (update.activeColorOverrides !== undefined) overridesRef.current = update.activeColorOverrides;
            restoringScreenRef.current = false;
            cursorRef.current = { generation: value.generation, sequence: update.sequence };
          });
          parsingRef.current = parsed.catch(() => undefined);
          await parsed;
          if (!current()) return;
          appearanceRevision = appearanceRevision > update.appearanceRevision ? appearanceRevision : update.appearanceRevision;
          if (update.terminal !== undefined) accept(update.terminal);
          if (!registered) {
            registered = true;
            try { if (latest.current.capabilities.support !== "disabledByPolicy") await synchronize(focused()); }
            catch (failure) {
              if (!current() || !(failure instanceof DOMException && failure.name === "AbortError")) throw failure;
              if (latest.current.capabilities.support !== "disabledByPolicy") await synchronize(false);
            }
            if (!current()) return;
          }
          failures = 0;
          setConnection("ready");
          connectionRef.current = "ready";
          terminal.options.disableStdin = descriptorRef.current?.status !== "running" || writerRef.current.blocked || appearanceFailed || appearancePending > 0 || latest.current.capabilities.support === "disabledByPolicy";
          if (!writerRef.current.blocked && !appearanceFailed) setError(undefined);
          fitRef.current();
          restoreRequestedFocus();
        }, cursorRef.current?.sequence, signal);
        if (!current() || descriptorRef.current?.status !== "running") return;
        throw new Error(latest.current.t("terminal.disconnected"));
      } catch (failure) {
        if (!current()) return;
        terminal.options.disableStdin = true;
        setConnection("error");
        setError(failure instanceof Error ? failure.message : latest.current.t("terminal.disconnected"));
        retry = ownerWindow.setTimeout(() => { void watch(); }, Math.min(5_000, 250 * 2 ** Math.min(failures++, 5)));
      } finally {
        lifetime.abort();
        if (appearanceRef.current?.signal === signal) appearanceRef.current = undefined;
      }
    };
    void watch();
    return () => {
      request.abort(); currentWatch?.abort();
      slot.removeEventListener("focusin", focus);
      slot.removeEventListener("focusout", blur);
      ownerWindow.removeEventListener("blur", blur);
      ownerWindow.removeEventListener("focus", focus);
      ownerDocument.removeEventListener("visibilitychange", focus);
      ownerDocument.removeEventListener("visibilitychange", blur);
      ownerWindow.removeEventListener("pagehide", pagehide);
      ownerWindow.removeEventListener("pageshow", pageshow);
      if (retry !== undefined) ownerWindow.clearTimeout(retry);
    };
  }, [connected, revision, scope, connectionOwner]);

  useEffect(() => {
    if (!active) return;
    fitRef.current();
    terminalRef.current?.focus();
  }, [active, scope]);

  const reconnect = (): void => {
    focusAfterConnectRef.current ??= { scope, element: slotRef.current?.ownerDocument.activeElement ?? null };
    writerRef.current = { id: "", sequence: 0n, generation: descriptorRef.current?.generation ?? 0n, blocked: false, chain: Promise.resolve() };
    setError(undefined);
    setInputNotice(undefined);
    setRevision((value) => value + 1);
  };
  const restart = async (): Promise<void> => {
    const current = descriptorRef.current;
    if (current === undefined || !current.exitConfirmed || current.status === "running" || current.status === "closed" || restarting || !connected || latest.current.capabilities.support === "disabledByPolicy") return;
    const previous = restartAttemptRef.current;
    const attempt = previous?.scope === scope && previous.generation === current.generation
      ? previous
      : { scope, generation: current.generation, id: randomUuid(), pending: false };
    if (attempt.pending) return;
    restartAttemptRef.current = attempt;
    attempt.pending = true;
    const isCurrentAttempt = (): boolean => scopeRef.current === scope && restartAttemptRef.current === attempt && descriptorRef.current?.generation === attempt.generation;
    focusAfterConnectRef.current = { scope, element: slotRef.current?.ownerDocument.activeElement ?? null };
    setRestarting(true);
    try {
      await latest.current.controller.restartTerminal(sessionId, terminalId, attempt.generation, attempt.id);
      if (!isCurrentAttempt()) return;
      reconnect();
    } catch (failure) { if (isCurrentAttempt()) { focusAfterConnectRef.current = undefined; setError(failure instanceof Error ? failure.message : String(failure)); } }
    finally { attempt.pending = false; if (isCurrentAttempt()) setRestarting(false); }
  };
  return <section className="interactive-terminal" aria-label={t("terminal.title")}>
    <header><span title={descriptor?.cwd}>{descriptor?.shellLabel ?? t("terminal.title")}</span><Pill tone={descriptor?.status === "running" ? "accent" : "neutral"}>{descriptor?.status === "running" ? t("terminal.running") : descriptor?.status === "closed" ? t("terminal.closed") : descriptor?.status === "failed" ? t(descriptor.failureCode === "TERMINAL_UNKNOWN" && !descriptor.exitConfirmed ? "terminal.stateUnknown" : "terminal.failed") : descriptor?.status === "exited" ? descriptor.exitSignal !== undefined && descriptor.exitSignal !== 0 ? t("terminal.signalled", { signal: descriptor.exitSignal }) : t("terminal.exited", { code: descriptor.exitCode ?? t("terminal.exitUnknown") }) : t("terminal.connecting")}</Pill></header>
    <div ref={slotRef} className="interactive-terminal__screen" aria-label={t("terminal.screen")} />
    {(connection !== "ready" || error !== undefined || inputNotice !== undefined || descriptor?.status !== "running" || policyDisabled) && <div className="interactive-terminal__status" role="status">
      {policyDisabled && <p>{capabilities.reason ?? t("terminal.unavailable")}</p>}
      {error !== undefined ? <p>{error}</p> : connection !== "ready" ? <p>{t(connected ? connection === "connecting" ? "terminal.connecting" : "terminal.reconnecting" : "terminal.disconnected")}</p> : null}
      {inputNotice !== undefined && <p>{inputNotice}</p>}
      {descriptor !== undefined && descriptor.status !== "running" && descriptor.status !== "closed" && !descriptor.exitConfirmed && <p>{t(descriptor.failureCode === "TERMINAL_UNKNOWN" ? "terminal.transportUnconfirmed" : "terminal.exitUnconfirmed")}</p>}
      {descriptor !== undefined && descriptor.status !== "running" && descriptor.status !== "closed" && descriptor.exitConfirmed && <Button disabled={restarting || !connected || policyDisabled} onClick={() => void restart()}><RotateCw aria-hidden="true" />{t("terminal.restart")}</Button>}
      {(error !== undefined || descriptor !== undefined && descriptor.status !== "running" && descriptor.status !== "closed" && !descriptor.exitConfirmed) && <Button disabled={restarting || !connected} onClick={reconnect}>{t("terminal.reconnect")}</Button>}
    </div>}
  </section>;
}

function writeTerminalScreen(terminal: Terminal, data: string, signal: AbortSignal): Promise<void> {
  if (data === "" || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => { signal.removeEventListener("abort", done); resolve(); };
    signal.addEventListener("abort", done, { once: true });
    terminal.write(data, done);
  });
}

function suppressTerminalQueryReplies(terminal: Terminal) {
  const csi = [{ final: "c" }, { prefix: ">", final: "c" }, { final: "n" }, { prefix: "?", final: "n" }, { intermediates: "$", final: "p" }, { prefix: "?", intermediates: "$", final: "p" }];
  return [
    ...csi.map((identifier) => terminal.parser.registerCsiHandler(identifier, () => true)),
    terminal.parser.registerCsiHandler({ final: "t" }, (parameters) => parameters[0] === 18),
    terminal.parser.registerDcsHandler({ intermediates: "$", final: "q" }, () => true),
    ...[4, 10, 11, 12].map((identifier) => terminal.parser.registerOscHandler(identifier, (data) => data.split(";").includes("?")))
  ];
}

function terminalInputByteLength(data: string): number {
  let size = 0;
  for (const character of data) {
    const code = character.codePointAt(0)!;
    const bytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    size += bytes;
  }
  return size;
}
