import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Image as NativeImage, Platform, StyleSheet, View } from "react-native";
import Svg, { Image as SvgImage, Rect, SvgXml, Text as SvgText, TSpan } from "react-native-svg";
import { mobileConnectionAppIcon } from "./connection-artwork";
import { createConversationShareAssetGate } from "./mobile-conversation-share-asset-gate";
import {
  buildConversationShareSvgLayout, conversationShareSvgRenderSize, type MobileConversationShareColors
} from "./mobile-conversation-share-layout";
import type { MobileConversationShareSnapshot } from "./mobile-conversation-share";
import { decodeMobileBase64 } from "./mobile-image-annotation";
import type { MobileConversationShareRendererHandle } from "./mobile-conversation-share-export";

export const MobileConversationShareSvg = forwardRef<MobileConversationShareRendererHandle, {
  readonly snapshot: MobileConversationShareSnapshot;
  readonly colors: MobileConversationShareColors;
  readonly width: number;
  readonly dark: boolean;
}>(function MobileConversationShareSvg({ snapshot, colors, width, dark }, ref) {
  const svg = useRef<Svg | null>(null);
  const original = useMemo(() => buildConversationShareSvgLayout({
    allShareableIds: snapshot.allShareableIds, colors, messages: snapshot.messages, width
  }), [colors, snapshot, width]);
  const [keys] = useState(() => {
    const map = new Map<string, string[]>();
    original.images.forEach((image, index) => map.set(image.uri, [...(map.get(image.uri) ?? []), `image-${index}`]));
    return map;
  });
  const [gate] = useState(() => createConversationShareAssetGate([...keys.values()].flat()));
  const [ready, setReady] = useState<ReadonlySet<string>>();
  const layout = useMemo(() => ready ? buildConversationShareSvgLayout({
    allShareableIds: snapshot.allShareableIds, colors, width,
    messages: snapshot.messages.map((message) => ({ ...message,
      images: new Map([...(message.images ?? [])].filter(([, image]) => keys.get(image.uri)?.every((key) => ready.has(key))))
    }))
  }) : original, [colors, keys, original, ready, snapshot, width]);
  const size = useMemo(() => conversationShareSvgRenderSize(layout), [layout]);
  const images = useMemo(() => {
    const occurrences = new Map<string, number>();
    return layout.images.map((image) => {
      const ordinal = occurrences.get(image.uri) ?? 0;
      occurrences.set(image.uri, ordinal + 1);
      return { ...image, key: keys.get(image.uri)![ordinal]! };
    });
  }, [keys, layout]);
  const job = useRef<{ cancel(): void; capture(sourceTooLarge: boolean): void; promise: Promise<Uint8Array> } | undefined>(undefined);
  useEffect(() => () => { job.current?.cancel(); gate.finish(); }, [gate]);
  useImperativeHandle(ref, () => ({
    exportPng(signal) {
      signal.throwIfAborted();
      if (job.current) return job.current.promise;
      if (size.sourceTooLarge) return Promise.reject(new Error("The selected messages are too large. Select fewer messages."));
      let cancel: () => void = () => {};
      let capture: (sourceTooLarge: boolean) => void = () => {};
      const promise = new Promise<Uint8Array>((resolve, reject) => {
        let phase: "decoding" | "layout" | "capture" | "done" = "decoding";
        const finish = (failure?: Error, base64?: string) => {
          if (phase === "done") return;
          phase = "done";
          clearTimeout(timeout); clearTimeout(decodeTimeout);
          signal.removeEventListener("abort", cancel);
          gate.finish();
          if (failure) { reject(failure); return; }
          try { resolve(decodeMobileBase64(base64!, 20 * 1_024 * 1_024)); }
          catch (error) { reject(error); }
        };
        const prepare = () => {
          if (phase !== "decoding") return;
          phase = "layout";
          clearTimeout(decodeTimeout);
          setReady(gate.finish());
        };
        const timeout = setTimeout(() => finish(new Error("The message image export timed out.")), 20_000);
        const decodeTimeout = setTimeout(prepare, 15_000);
        cancel = () => finish(new Error("The message image export was cancelled."));
        signal.addEventListener("abort", cancel, { once: true });
        capture = (sourceTooLarge) => {
          if (phase !== "layout") return;
          phase = "capture";
          if (sourceTooLarge) { finish(new Error("The selected messages are too large. Select fewer messages.")); return; }
          if (signal.aborted || !svg.current) { cancel(); return; }
          try { svg.current.toDataURL((base64) => {
            if (!base64) finish(new Error("The message image export was empty."));
            else finish(undefined, base64);
          }); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
        };
        void gate.waitUntilSettled().then(prepare);
      });
      job.current = { promise, cancel, capture };
      return promise;
    }
  }), [gate, size.sourceTooLarge]);
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={[styles.hidden, { width: size.width, height: size.height }]}>
    {!size.sourceTooLarge && [...keys.entries()].map(([uri, imageKeys]) => <NativeImage key={imageKeys[0]}
      source={{ uri }} resizeMethod="none" fadeDuration={0} style={styles.probe}
      onLoad={() => {
        if (Platform.OS !== "android") return;
        const cached = NativeImage.queryCache?.([uri]);
        if (!cached) { imageKeys.forEach(gate.markFailed); return; }
        void cached.then((cache) => imageKeys.forEach(cache[uri]?.includes("memory") ? gate.markReady : gate.markFailed),
          () => imageKeys.forEach(gate.markFailed));
      }} onError={() => imageKeys.forEach(gate.markFailed)} />)}
    <Svg ref={svg} width={size.width} height={size.height} viewBox={`0 0 ${layout.width} ${layout.height}`}>
      <Rect fill={colors.background} x={0} y={0} width={layout.width} height={layout.height} />
      {!size.sourceTooLarge && <>
        {layout.bubbles.map((bubble, index) => <ViewlessBubble key={index} bubble={bubble} />)}
        {images.map((image) => <SvgImage key={image.key} href={{ uri: image.uri }} x={image.x} y={image.y}
          width={image.width} height={image.height} preserveAspectRatio="xMidYMid meet"
          onLoad={() => { if (Platform.OS !== "android") gate.markReady(image.key); }} />)}
        {layout.gaps.map((gap, index) => <SvgText key={index} x={layout.width / 2} y={gap.y}
          fill={gap.color} fontSize={15} textAnchor="middle" letterSpacing={4}>⋯</SvgText>)}
        <SvgXml xml={mobileConnectionAppIcon(dark ? "dark" : "light")} x={layout.width / 2 - 40}
          y={layout.footerY} width={24} height={24} />
        <SvgText x={layout.width / 2 - 10} y={layout.footerY + 18} fontFamily="Arial"
          fontSize={17} fill={colors.textPrimary}>Joko</SvgText>
      </>}
    </Svg>
    {ready && <View collapsable={false} style={styles.probe} onLayout={() => job.current?.capture(size.sourceTooLarge)} />}
  </View>;
});

function ViewlessBubble({ bubble }: { readonly bubble: ReturnType<typeof buildConversationShareSvgLayout>["bubbles"][number] }) {
  return <>
    {(bubble.fill || bubble.stroke) && <Rect x={bubble.x} y={bubble.y} width={bubble.width} height={bubble.height}
      rx={12} fill={bubble.fill ?? "none"} stroke={bubble.stroke} strokeWidth={bubble.stroke ? 1 : undefined} />}
    {bubble.textBlocks.map((block, index) => <SvgText key={index} x={block.x} y={block.y}
      fill={block.color} fontSize={block.fontSize} fontFamily="Arial">
      {block.lines.map((line, lineIndex) => <TSpan key={lineIndex} x={block.x} dy={lineIndex === 0 ? 0 : block.lineHeight}>{line || " "}</TSpan>)}
    </SvgText>)}
  </>;
}

const styles = StyleSheet.create({ hidden: { position: "absolute", left: -100_000, top: 0, opacity: 0 },
  probe: { position: "absolute", width: 1, height: 1, left: 0, top: 0 } });
