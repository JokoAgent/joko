/** Trusted proxy script. Only its actual inner frame can submit standard App messages. */
export function mcpAppDirectSandboxDocument(resourceUrl: string, bridgeUrl: string, nativeOrigin = false): string {
  const encode = (value: string) => JSON.stringify(value).replace(/</gu, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body><script>
const frame=document.createElement('iframe');
frame.setAttribute('sandbox',${encode(nativeOrigin ? 'allow-scripts allow-same-origin' : 'allow-scripts')});
frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
frame.style.cssText='border:0;width:100%;height:100%;display:block';
let after=0,stopped=false;
const links=new Map();
const state=(message,fromHost=false)=>{
 if(['ui/notifications/initialized','ui/notifications/size-changed','ui/notifications/sandbox-escape'].includes(message.method)||(fromHost&&message.method==='ui/notifications/host-context-changed'))
  window.parent.postMessage(message,'*');
};
const fail=()=>{if(stopped)return;stopped=true;window.parent.postMessage({jsonrpc:'2.0',method:'ui/notifications/sandbox-failed'},'*');};
async function invoke(input){
 const response=await fetch(${encode(bridgeUrl)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
 if(!response.ok)throw new Error('MCP_APP_VIEW_UNAVAILABLE');
 return response.json();
}
window.addEventListener('message',event=>{
 if(stopped)return;
 if(event.source===window.parent&&event.data?.type==='joko:mcp-app-link-result'){
  links.get(event.data.id)?.(event.data.success===true);return;
 }
 if(event.source!==frame.contentWindow||${nativeOrigin ? `event.origin!==${encode(new URL(resourceUrl).protocol + '//' + new URL(resourceUrl).host)}` : 'false'})return;
 const message=event.data;
 if(!message||message.jsonrpc!=='2.0'||typeof message.method==='string'&&message.method.startsWith('ui/notifications/sandbox-'))return;
 state(message);
 void invoke({op:'message',message}).catch(fail);
});
window.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&!event.isComposing&&!event.repeat&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey)
  state({jsonrpc:'2.0',method:'ui/notifications/sandbox-escape',params:{}});
});
async function openLink(link){
 const started=performance.now();
 const grant=await invoke({op:'open-link',linkId:link.id,url:link.url});
 if(performance.now()-started>=grant.validForMs)throw new Error('MCP_APP_LINK_EXPIRED');
 return new Promise(resolve=>{
  const finish=success=>{clearTimeout(timer);links.delete(link.id);resolve(success);};
  const timer=setTimeout(()=>finish(false),Math.max(1,grant.validForMs-(performance.now()-started)));
  links.set(link.id,finish);
  window.parent.postMessage({type:'joko:mcp-app-link',id:link.id,url:grant.url},'*');
 });
}
async function poll(){
 try{while(!stopped){
  const events=await invoke({op:'poll',after});
  for(const event of events){
   if(!Number.isSafeInteger(event.seq)||event.seq<=after)continue;
   after=event.seq;
   if(event.openLink){
    let success=false;
    try{success=await openLink(event.openLink);}catch{}
    await invoke({op:'link-result',linkId:event.openLink.id,success});
   }else{state(event.message,true);frame.contentWindow.postMessage(event.message,'*');}
  }
  if(!events.length&&!stopped)await new Promise(resolve=>setTimeout(resolve,250));
 }}catch{fail();}
}
frame.src=${encode(resourceUrl)};
document.body.appendChild(frame);
void poll();
</script></body></html>`;
}
export const MCP_APP_SANDBOX_SCRIPT = `
const frame=document.createElement('iframe');
frame.setAttribute('sandbox','allow-scripts');
frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
frame.style.cssText='border:0;width:100%;height:100%;display:block';
let loaded=false;
let resourceOrigin='null';
const post=message=>window.ReactNativeWebView?window.ReactNativeWebView.postMessage(JSON.stringify({key:bridgeKey,message})):window.parent.postMessage(message,'*');
window.addEventListener('keydown',event=>{
 if(event.key==='Escape'&&!event.isComposing&&!event.repeat&&!event.ctrlKey&&!event.altKey&&!event.metaKey&&!event.shiftKey)
  post({jsonrpc:'2.0',method:'ui/notifications/sandbox-escape',params:{}});
});
window.addEventListener('message',event=>{
 const message=event.data;
 if(!message||message.jsonrpc!=='2.0')return;
 if(event.source===frame.contentWindow){
  // WindowProxy identity survives navigation; a replacement document gets no bridge.
  if(!loaded||event.origin!==resourceOrigin)return;
  if(typeof message.method==='string'&&message.method.startsWith('ui/notifications/sandbox-'))return;
  post(message);return;
 }
 if(event.source!==window.parent&&event.source!==window)return;
 if(message.method==='ui/notifications/sandbox-resource-ready'){
  if(loaded)return;
  const resourceUrl=typeof expectedResourceUrl==='string'?expectedResourceUrl:message.params.resourceUrl;
  if(resourceUrl){
   const resource=new URL(resourceUrl),proxy=new URL(window.location.href);
   if(!['http:','https:','joko-mcp-app:'].includes(resource.protocol)||resource.username||resource.password||
    resource.protocol===proxy.protocol&&resource.host===proxy.host)return;
   // URL.origin can be null for Electron's registered custom scheme.
   resourceOrigin=resource.protocol+'//'+resource.host;
   frame.setAttribute('sandbox','allow-scripts allow-same-origin');frame.src=resource.href;
  }
  else{return;}
  loaded=true;
  document.body.appendChild(frame);return;
 }
 if(loaded)frame.contentWindow?.postMessage(message,resourceOrigin==='null'?'*':resourceOrigin);
});
post({jsonrpc:'2.0',method:'ui/notifications/sandbox-proxy-ready',params:{}});
`;
export function mcpAppSandboxDocument(nativeBridgeKey: string, resourceUrl: string): string {
  const key = JSON.stringify(nativeBridgeKey).replace(/</g, '\\u003c');
  const resource = JSON.stringify(resourceUrl).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}</style></head><body><script>const bridgeKey=${key};const expectedResourceUrl=${resource};${MCP_APP_SANDBOX_SCRIPT}</script></body></html>`;
}

/** Native frame navigation needs its own gate; document CSP does not cover location. */
export function mcpAppFrameUrlAllowed(value: string, domains: readonly string[] = []): boolean {
  if (value === 'about:blank' || value === 'about:srcdoc') return true;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return false;
    return domains.some((domain) => {
      const wildcard = domain.includes('://*.');
      const anyPort = /:\*\/?$/.test(domain);
      const source = new URL(domain.replace('://*.', '://').replace(/:\*(\/?$)/, '$1'));
      return (
        source.protocol === url.protocol &&
        (anyPort || source.port === url.port) &&
        (wildcard ? url.hostname.endsWith('.' + source.hostname) : url.hostname === source.hostname)
      );
    });
  } catch {
    return false;
  }
}
