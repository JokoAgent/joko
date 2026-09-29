import {
  desktopInboundOpenIntentFromArgv,
  isPortableSessionPath,
  parseDesktopDeepLink,
  type DesktopInboundOpenIntent
} from "./deep-link.js";

export interface DesktopOpenIntentEvent {
  preventDefault(): void;
}

export interface DesktopOpenIntentEventSource {
  listenOpenUrl(listener: (event: DesktopOpenIntentEvent, url: string) => void): void;
  listenOpenFile(listener: (event: DesktopOpenIntentEvent, path: string) => void): void;
  listenSecondInstance(listener: (event: unknown, argv: readonly string[]) => void): void;
}

export interface DesktopOpenIntentIngress {
  activateSingleInstance(argv: readonly string[]): void;
}

export type DesktopOpenIntentIngressSource = "coldArgv" | "secondInstance" | "openUrl" | "openFile";

/**
 * Bind the OS entry points before Electron finishes launching, then activate
 * the argv/second-instance half only after this process owns the singleton.
 */
export function bindDesktopOpenIntentIngress(options: {
  readonly source: DesktopOpenIntentEventSource;
  readonly platform: NodeJS.Platform;
  readonly dispatch: (intent: DesktopInboundOpenIntent, source: DesktopOpenIntentIngressSource) => void;
  readonly showMainWindow: () => void;
}): DesktopOpenIntentIngress {
  options.source.listenOpenUrl((event, url) => {
    event.preventDefault();
    const intent = parseDesktopDeepLink(url);
    if (intent !== undefined) options.dispatch(intent, "openUrl");
  });
  options.source.listenOpenFile((event, path) => {
    if (!isPortableSessionPath(path, options.platform)) return;
    event.preventDefault();
    options.dispatch(Object.freeze({ kind: "portableFile", path }), "openFile");
  });

  let activated = false;
  return Object.freeze({
    activateSingleInstance: (argv: readonly string[]): void => {
      if (activated) throw new Error("Desktop open-intent singleton ingress is already active.");
      activated = true;
      const coldIntent = desktopInboundOpenIntentFromArgv(argv, options.platform);
      if (coldIntent !== undefined) options.dispatch(coldIntent, "coldArgv");
      options.source.listenSecondInstance((_event, nextArgv) => {
        options.showMainWindow();
        const intent = desktopInboundOpenIntentFromArgv(nextArgv, options.platform);
        if (intent !== undefined) options.dispatch(intent, "secondInstance");
      });
    }
  });
}
