export type WebRtcPeerFactory = (configuration: RTCConfiguration) => RTCPeerConnection | Promise<RTCPeerConnection>;
let factory: WebRtcPeerFactory | undefined;
/** Node registers a lazy local engine; Web and Mobile keep their platform engine. */
export function setWebRtcPeerFactory(value: WebRtcPeerFactory): void { factory = value; }
export async function createWebRtcPeer(configuration: RTCConfiguration): Promise<RTCPeerConnection> {
  if (factory !== undefined) return factory(configuration);
  if (typeof RTCPeerConnection === 'undefined') throw new Error('The selected WebRTC engine is unavailable in this client.');
  return new RTCPeerConnection(configuration);
}
