import { setWebRtcPeerFactory } from './webrtc-peer.js';
import { setHttpConnectCarrierFactory } from './http-connect.js';
setWebRtcPeerFactory(async configuration => (await import('@jokoagent/linkspan-webrtc-node')).createNodeWebRtcPeer(configuration));
setHttpConnectCarrierFactory(async (address, options) => (await import('@jokoagent/linkspan-http-connect/node')).connectHttpConnectStream({
  proxyOrigin: address.proxyOrigin, authority: address.authority, ...options
}));
