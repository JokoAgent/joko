const allowed = new Set(['iroh', 'tailcat', 'webrtc', 'http-connect-native', 'iroh-native', 'iroh-relay', 'tailcat-relay', 'cloudflare', 'funnel', 'frp', 'rathole', 'bore', 'netbird', 'zrok', 'pangolin', 'pinggy-sdk']);
function selectedMobileLinkspanModes(value = process.env.JOKO_LINKSPAN_BUILD_BACKENDS ?? 'iroh-relay,tailcat-relay,webrtc') {
  const selected = new Set(value.split(',').map(item => item.trim()).filter(Boolean));
  if ([...selected].some(item => !allowed.has(item))) throw new Error('Unknown selected Mobile Linkspan mode.');
  return { relayBackends: ['iroh', 'tailcat'].filter(kind => selected.has(kind) || selected.has(`${kind}-relay`)), nativeIroh: selected.has('iroh-native'), nativeHttpConnect: selected.has('http-connect-native'), webRtc: selected.has('webrtc') };
}
module.exports = { selectedMobileLinkspanModes };
