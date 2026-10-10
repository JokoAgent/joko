import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Image, StyleSheet, View } from "react-native";
import type { MobilePartnersColors } from "./MobilePartnersScreen";
import type { MobilePartnerAvatarDraft, MobilePartnerAvatarIdentity, MobilePartnerAvatarTransport } from "./mobile-partner-avatar";

const AvatarOwner = createContext<MobilePartnerAvatarTransport | undefined>(undefined);

export function MobilePartnerAvatarProvider({ transport, children }: { readonly transport?: MobilePartnerAvatarTransport; readonly children: ReactNode }) {
  const requests = useRef(new Map<string, { readonly abort: AbortController; readonly promise: Promise<string>; readonly bytes: number }>());
  const active = useRef(new Set<AbortController>());
  const source = useRef(transport); source.current = transport;
  const ownerKey = transport?.ownerKey;
  useEffect(() => () => { for (const abort of active.current) abort.abort(); active.current.clear(); requests.current.clear(); }, [ownerKey]);
  const read = async (partner: MobilePartnerAvatarIdentity, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    if (!ownerKey || source.current?.ownerKey !== ownerKey || typeof partner.avatar === "string") throw new Error("No current Partner image owner.");
    const key = `${ownerKey}:${partner.partnerId}:${partner.revision}:${partner.avatar.sha256}`;
    let request = requests.current.get(key);
    if (!request) {
      const abort = new AbortController();
      active.current.add(abort);
      const promise = source.current.read(partner, abort.signal).finally(() => active.current.delete(abort));
      request = { abort, promise, bytes: partner.avatar.byteLength }; requests.current.set(key, request);
      void promise.catch(() => { if (requests.current.get(key)?.promise === promise) requests.current.delete(key); });
      let bytes = 0; for (const value of requests.current.values()) bytes += value.bytes;
      for (const [candidate, value] of requests.current) {
        if (requests.current.size <= 32 && bytes <= 8 * 1024 * 1024) break;
        if (candidate !== key) { requests.current.delete(candidate); bytes -= value.bytes; }
      }
    }
    const uri = await request.promise;
    signal.throwIfAborted();
    if (source.current?.ownerKey !== ownerKey) throw new Error("The Partner image owner changed.");
    return uri;
  };
  return <AvatarOwner.Provider value={ownerKey ? { ownerKey, read } : undefined}>{children}</AvatarOwner.Provider>;
}

export function MobilePartnerAvatar({ preset, partner, colors, size = 44 }: {
  readonly preset: MobilePartnerAvatarDraft;
  readonly partner?: MobilePartnerAvatarIdentity;
  readonly colors: MobilePartnersColors;
  readonly size?: number;
}) {
  const transport = useContext(AvatarOwner);
  const source = useRef(transport); source.current = transport;
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly uri: string }>();
  const key = typeof preset === "string" ? preset : "base64" in preset ? preset.base64
    : `${transport?.ownerKey}:${partner?.partnerId}:${partner?.revision}:${preset.sha256}`;
  useEffect(() => {
    const abort = new AbortController();
    if (partner && typeof preset !== "string" && !("base64" in preset) && source.current) {
      void source.current.read(partner, abort.signal).then((uri) => { if (!abort.signal.aborted) setLoaded({ key, uri }); }).catch(() => undefined);
    }
    return () => abort.abort();
  }, [key, partner]);
  const uri = typeof preset !== "string" && "base64" in preset ? `data:image/jpeg;base64,${preset.base64}`
    : loaded?.key === key && transport ? loaded.uri : undefined;
  if (typeof preset !== "string") return <View accessible={false} testID="partner.avatar.photo"
    style={[styles.avatar, { width: size, height: size, backgroundColor: colors.brandBackground, borderColor: colors.border }]}>
    {uri && <Image source={{ uri }} style={{ width: size, height: size }} resizeMode="cover" />}
  </View>;
  const shape = preset === "spark" ? styles.spark : preset === "leaf" ? styles.leaf
    : preset === "wave" ? styles.wave : styles.orbit;
  return <View accessible={false} testID={`partner.avatar.${preset}`}
    style={[styles.avatar, { width: size, height: size, backgroundColor: colors.brandBackground,
      borderColor: colors.border }]}>
    <View style={[styles.shape, { borderColor: colors.accent }, shape]} />
    {(preset === "orbit" || !["spark", "leaf", "wave"].includes(preset))
      && <View style={[styles.satellite, { backgroundColor: colors.accent }]} />}
  </View>;
}

const styles = StyleSheet.create({
  avatar: { borderRadius: 14, borderWidth: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  shape: { width: 17, height: 17, borderWidth: 4 },
  orbit: { borderRadius: 9, transform: [{ rotate: "-12deg" }] },
  satellite: { position: "absolute", width: 7, height: 7, borderRadius: 4, right: 9, bottom: 9 },
  spark: { borderRadius: 4, transform: [{ rotate: "45deg" }] },
  leaf: { borderTopLeftRadius: 13, borderTopRightRadius: 2, borderBottomLeftRadius: 2,
    borderBottomRightRadius: 13, transform: [{ rotate: "-32deg" }] },
  wave: { height: 11, borderWidth: 0, borderBottomWidth: 4, borderRadius: 9, transform: [{ rotate: "-8deg" }] }
});
