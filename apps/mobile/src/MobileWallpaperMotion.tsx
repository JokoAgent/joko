import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";
import { useVideoPlayer, VideoView } from "expo-video";

export default function MobileWallpaperMotion({ uri }: { uri: string }) {
  const [ready, setReady] = useState(false);
  const player = useVideoPlayer(uri, instance => {
    instance.muted = true;
    instance.loop = true;
    instance.audioMixingMode = "mixWithOthers";
    instance.keepScreenOnWhilePlaying = false;
    instance.allowsExternalPlayback = false;
    instance.play();
  });
  useEffect(() => {
    const listener = player.addListener("statusChange", ({ status }) => { if (status === "error") setReady(false); });
    return () => listener.remove();
  }, [player]);
  return <VideoView player={player} contentFit="cover" allowsVideoFrameAnalysis={false} nativeControls={false}
    onFirstFrameRender={() => setReady(true)} style={[StyleSheet.absoluteFill, { opacity: ready ? 1 : 0 }]} />;
}
