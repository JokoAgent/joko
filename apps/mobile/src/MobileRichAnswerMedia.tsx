import { useCallback, useEffect, useState } from "react";
import { AppState, Linking, Pressable, Text, View } from "react-native";
import { Image } from "expo-image";
import { randomUUID } from "expo-crypto";
import { WebView } from "react-native-webview";
import { richLabel, richMarkdown, richMediaNetworkUrl, richMediaSource, youtubeVideo, type RichNode } from "@joko/contracts";
import type { ReactNode } from "react";
import type { MobileMarkdownColors } from "./mobile-markdown-rich-html";
import type { MobileSupportedLocale } from "./mobile-locale-preference";
import type { MobileMarkdownResourceDescriptor } from "./mobile-markdown-resources";
import { MobileMediaPlayer } from "./MobileMediaPlayer";
import { mobileMessage } from "./mobile-messages";
import { useMobilePreviewResourceLifecycle } from "./use-mobile-preview-resource-lifecycle";

export function MobileRichAnswerMedia({ node, colors, locale, resources, fallback }: {
  readonly node: RichNode; readonly colors: MobileMarkdownColors; readonly locale: MobileSupportedLocale;
  readonly resources?: MobileMarkdownResourceDescriptor; readonly fallback: (text: string) => ReactNode;
}) {
  const source = richMediaSource(node);
  const network = source ? richMediaNetworkUrl(source) : undefined;
  const site = node.kind === "video" && source ? youtubeVideo(source) : null;
  const reference = source ? resources?.references.get(JSON.stringify([node.kind === "image" ? "image" : "media", ...(node.kind === "image" ? [] : [node.kind]), source])) : undefined;
  const [instanceId] = useState(() => randomUUID());
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  useEffect(() => { const listener = AppState.addEventListener("change", state => setForeground(state === "active")); return () => listener.remove(); }, []);
  const title = richLabel(node, {}) || "";
  if (site) return <MobileVideoSite site={site} title={title || "YouTube"} colors={colors} locale={locale} />;
  if (!source || !foreground) return <Text style={{ color: colors.muted }}>{title}</Text>;
  if (node.kind === "image") {
    if (network) return <PublicImage key={network} uri={network} title={title} colors={colors} />;
    return <>{fallback(richMarkdown(node) ?? title)}</>;
  }
  const media = reference?.media;
  if ((node.kind === "audio" || node.kind === "video") && (network || media?.kind === node.kind)) return <MobileMediaPlayer
    key={JSON.stringify([source, resources?.leaseId])} instanceId={instanceId} kind={node.kind} locale={locale}
    title={title} uri={network ?? media!.uri} mediaType={network ? "" : media!.mediaType} networkSource={!!network}
    background={colors.background} border={colors.border} ink={colors.ink} surface={colors.surface}
    style={{ height: node.kind === "video" ? 260 : 128, width: "100%" }} />;
  return <>{fallback(richMarkdown(node) ?? title)}</>;
}

function PublicImage({ uri, title, colors }: { readonly uri: string; readonly title: string; readonly colors: MobileMarkdownColors }) {
  const [ratio, setRatio] = useState(16 / 9);
  const [failed, setFailed] = useState(false);
  return failed ? <Text style={{ color: colors.muted }}>{title}</Text> : <Image source={{ uri }} accessibilityLabel={title}
    contentFit="contain" style={{ width: "100%", aspectRatio: ratio }} onError={() => setFailed(true)}
    onLoad={event => { const { width, height } = event.source; if (width > 0 && height > 0) setRatio(width / height); }} />;
}

function MobileVideoSite({ site, title, colors, locale }: {
  readonly site: NonNullable<ReturnType<typeof youtubeVideo>>; readonly title: string;
  readonly colors: MobileMarkdownColors; readonly locale: MobileSupportedLocale;
}) {
  const [active, setActive] = useState(false);
  const release = useCallback(() => setActive(false), []);
  const resource = useMobilePreviewResourceLifecycle({ ownerKey: site.embed, releaseRenderer: release, reportFailure: release });
  const navigation = (url: string) => { try { const value = new URL(url); return value.protocol === "https:" && ["www.youtube.com", "youtube.com", "accounts.google.com", "consent.youtube.com"].includes(value.hostname); } catch { return url === "about:blank"; } };
  return <View style={{ gap: 8 }}>
    {active && resource.rendererMounted ? <WebView key={resource.rendererToken} source={{ uri: site.embed }} style={{ width: "100%", aspectRatio: 16 / 9 }}
      allowsInlineMediaPlayback allowsFullscreenVideo javaScriptEnabled mediaPlaybackRequiresUserAction
      allowFileAccess={false} allowUniversalAccessFromFileURLs={false} geolocationEnabled={false}
      mediaCapturePermissionGrantType="deny" mixedContentMode="never" setSupportMultipleWindows={false}
      onShouldStartLoadWithRequest={request => navigation(request.url)}
      onLoad={() => resource.onRendererReady(resource.rendererToken)} onError={() => setActive(false)}
      onContentProcessDidTerminate={() => resource.onRendererProcessLost(resource.rendererToken)}
      onRenderProcessGone={() => resource.onRendererProcessLost(resource.rendererToken)} />
      : <Pressable accessibilityRole="button" accessibilityLabel={mobileMessage(locale, "preview.mediaPlay")}
        onPress={() => { if (AppState.currentState === "active") setActive(true); }} style={{ width: "100%", aspectRatio: 16 / 9 }}>
        <Image source={{ uri: site.poster }} style={{ width: "100%", height: "100%" }} contentFit="cover" />
        <Text style={{ position: "absolute", bottom: 12, left: 12, color: "white", backgroundColor: "#0009", padding: 8 }}>▶ {title}</Text>
      </Pressable>}
    <Text accessibilityRole="link" style={{ color: colors.accent }} onPress={() => { if (AppState.currentState === "active") void Linking.openURL(site.watch).catch(() => undefined); }}>YouTube ↗</Text>
  </View>;
}
