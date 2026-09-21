import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type ReactElement,
  type RefAttributes
} from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import {
  buildMobileAnnotationBurnHtml,
  buildMobileAnnotationBurnInvocation,
  parseMobileAnnotationBurnMessage,
  type MobileImageAnnotationStroke
} from "./mobile-image-annotation";

export interface MobileAnnotationBurnInput {
  readonly base64: string;
  readonly mediaType: string;
  readonly strokes: readonly MobileImageAnnotationStroke[];
}

export interface MobileAnnotationBurnResult {
  readonly base64: string;
  readonly mediaType: "image/jpeg" | "image/png";
  readonly width: number;
  readonly height: number;
}

interface BurnJob {
  readonly id: string;
  readonly input: MobileAnnotationBurnInput;
  readonly resolve: (result: MobileAnnotationBurnResult) => void;
  readonly reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

const readyTimeoutMilliseconds = 10_000;
const burnTimeoutMilliseconds = 30_000;
const burnBaseUrl = "https://joko-mobile.invalid";

interface MobileAnnotationWebViewHandle {
  injectJavaScript(script: string): void;
}

// react-native-webview's root declaration still models a pre-React-19 class.
// The native component is forward-ref compatible; keep that compatibility shim
// isolated at this boundary instead of weakening application JSX types.
const MobileAnnotationWebView = WebView as unknown as ForwardRefExoticComponent<
  WebViewProps & RefAttributes<MobileAnnotationWebViewHandle>
>;

export function useMobileAnnotationBurn(): {
  readonly burnIn: (input: MobileAnnotationBurnInput) => Promise<MobileAnnotationBurnResult>;
  readonly host: ReactElement | null;
} {
  const [mounted, setMounted] = useState(false);
  const jobs = useRef<BurnJob[]>([]);
  const ready = useRef(false);
  const webView = useRef<MobileAnnotationWebViewHandle | null>(null);
  const sequence = useRef(0);
  const alive = useRef(true);
  const dispatchRef = useRef<(job: BurnJob) => void>(() => undefined);

  const failAll = useCallback((error: Error) => {
    for (const job of jobs.current.splice(0)) {
      if (job.timer) clearTimeout(job.timer);
      job.reject(error);
    }
    ready.current = false;
    if (alive.current) setMounted(false);
  }, []);

  useEffect(() => {
    if (!mounted || ready.current) return undefined;
    const timer = setTimeout(() => {
      if (!ready.current && jobs.current.length > 0) {
        failAll(new Error("The image annotation renderer did not initialize."));
      }
    }, readyTimeoutMilliseconds);
    return () => clearTimeout(timer);
  }, [failAll, mounted]);

  useEffect(() => () => {
    alive.current = false;
    failAll(new Error("The image annotation renderer was closed."));
  }, [failAll]);

  const settle = useCallback((complete: (job: BurnJob) => void) => {
    const job = jobs.current.shift();
    if (!job) return;
    if (job.timer) clearTimeout(job.timer);
    complete(job);
    const next = jobs.current[0];
    if (next && ready.current) dispatchRef.current(next);
    else if (!next) {
      ready.current = false;
      setMounted(false);
    }
  }, []);

  const dispatch = useCallback((job: BurnJob) => {
    if (job.timer) return;
    const target = webView.current;
    if (!target) {
      failAll(new Error("The image annotation renderer is unavailable."));
      return;
    }
    job.timer = setTimeout(() => {
      failAll(new Error("The image annotation renderer timed out."));
    }, burnTimeoutMilliseconds);
    target.injectJavaScript(buildMobileAnnotationBurnInvocation({
      id: job.id,
      base64: job.input.base64,
      mediaType: job.input.mediaType,
      strokes: job.input.strokes
    }));
  }, [failAll]);
  dispatchRef.current = dispatch;

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const response = parseMobileAnnotationBurnMessage(event.nativeEvent.data);
    if (!response) return;
    if ("ready" in response) {
      const job = jobs.current[0];
      if (!job) {
        ready.current = false;
        return;
      }
      ready.current = true;
      if (!job.timer) dispatch(job);
      return;
    }
    const active = jobs.current[0];
    if (!active || active.id !== response.id) return;
    if (response.ok) {
      settle((job) => job.resolve({
        base64: response.base64,
        mediaType: response.mediaType,
        width: response.width,
        height: response.height
      }));
    } else {
      settle((job) => job.reject(new Error(`The image annotation could not be rendered: ${response.error}`)));
    }
  }, [dispatch, settle]);

  const burnIn = useCallback((input: MobileAnnotationBurnInput) => new Promise<MobileAnnotationBurnResult>(
    (resolve, reject) => {
      const job: BurnJob = { id: `burn-${++sequence.current}`, input, resolve, reject };
      jobs.current.push(job);
      if (jobs.current.length === 1) {
        if (ready.current) dispatch(job);
        else setMounted(true);
      }
    }
  ), [dispatch]);

  const host = useMemo<ReactElement | null>(() => mounted ? <View pointerEvents="none" style={styles.hidden}>
    <MobileAnnotationWebView
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      cacheEnabled={false}
      javaScriptEnabled
      mixedContentMode="never"
      onContentProcessDidTerminate={() => failAll(new Error("The image annotation renderer was reclaimed by the system."))}
      onError={() => failAll(new Error("The image annotation renderer failed to load."))}
      onMessage={onMessage}
      onRenderProcessGone={() => {
        failAll(new Error("The image annotation renderer process ended."));
        return true;
      }}
      onShouldStartLoadWithRequest={(request: { readonly url: string }) => request.url === burnBaseUrl || request.url === `${burnBaseUrl}/`
        || request.url === "about:blank"}
      originWhitelist={[burnBaseUrl, "about:blank"]}
      ref={webView}
      scrollEnabled={false}
      setSupportMultipleWindows={false}
      source={{ html: buildMobileAnnotationBurnHtml(), baseUrl: burnBaseUrl }}
      style={styles.webView}
    />
  </View> : null, [failAll, mounted, onMessage]);

  return { burnIn, host };
}

export const mobileAnnotationBurnTesting = {
  burnBaseUrl,
  burnTimeoutMilliseconds,
  readyTimeoutMilliseconds
};

const styles = StyleSheet.create({
  hidden: {
    height: 1,
    left: 0,
    opacity: 0,
    position: "absolute",
    top: 0,
    width: 1
  },
  webView: { height: 1, width: 1 }
});
