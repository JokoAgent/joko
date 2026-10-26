import type { MobileRemoteDesktopViewerCommand } from "./remote-desktop-controller";
import { REMOTE_DESKTOP_ICE_LIMITS } from '@joko/contracts';

export const RTC_NETWORK = Object.freeze({
  ...REMOTE_DESKTOP_ICE_LIMITS,
  pollMs: 250,
  exchangeMs: 30_000,
  disconnectedMs: 5_000,
  answerMs: 45_000,
  connectMs: 15_000,
  stableMs: 30_000,
  retryMs: Object.freeze([1_000, 3_000, 8_000])
});

export const MOBILE_REMOTE_DESKTOP_KEY_CODES = Object.freeze([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((key) => `Key${key}`),
  ..."0123456789".split("").map((key) => `Digit${key}`),
  ...Array.from({ length: 12 }, (_value, index) => `F${index + 1}`),
  "Enter", "Escape", "Tab", "Space", "Backspace", "Delete", "Insert", "Home", "End",
  "PageUp", "PageDown", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft",
  "ControlLeft", "AltLeft", "MetaLeft", "Minus", "Equal", "BracketLeft", "BracketRight",
  "Backslash", "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash"
]);

export function remoteDesktopViewerHtml(surface: string, foreground: string, nativeMedia = false): string {
  const background = color(surface, "#15191d");
  const ink = color(foreground, "#f4f4f2");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; media-src blob:; connect-src 'none'"><style>
  *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:${nativeMedia ? "transparent" : background};touch-action:none;overscroll-behavior:none;-webkit-user-select:none;user-select:none}#stage{position:absolute;inset:0;overflow:hidden}video,img{position:absolute;max-width:none;pointer-events:none;transform-origin:0 0;border:0;outline:0}video{display:none;z-index:2}#image{z-index:1}img:not([src]){visibility:hidden}#cursor{position:absolute;z-index:3;width:18px;height:18px;border:2px solid ${ink};border-radius:50%;transform:translate(-50%,-50%);display:none;pointer-events:none}#cursor-image{position:absolute;inset:0;width:100%;height:100%}#keyboard{position:absolute;left:0;bottom:0;width:1px;height:1px;opacity:.01;font-size:16px;pointer-events:none;border:0;padding:0}
  :root{--surface:${background};--foreground:${ink}}
  #bg{position:absolute;inset:0;overflow:hidden;z-index:0;display:none;pointer-events:none}#bg-canvas{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;filter:blur(16px);transform:scale(1.12);transform-origin:center;opacity:.72}
  #mouse-buttons{position:absolute;inset:0;pointer-events:none;display:none;color:var(--foreground);opacity:.85}
  #mouse-buttons button{pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none;color:inherit;background:color-mix(in srgb,var(--surface) 90%,var(--foreground));border:1px solid color-mix(in srgb,var(--foreground) 18%,transparent)}
  .mouse-button{position:absolute;width:56px;height:56px;border-radius:9999px;padding:14px}.mouse-button svg{width:100%;height:100%;pointer-events:none}
  .mouse-button[aria-pressed="true"]{background:var(--foreground)!important;color:var(--surface)!important}
  #mouse-left{left:calc(50% - 96px);bottom:16px}#mouse-right{left:calc(50% + 40px);bottom:16px}
  #mouse-wheel{position:absolute;right:12px;bottom:80px;width:56px;height:120px;padding:12px 0;border-radius:9999px;display:flex;flex-direction:column;align-items:center;justify-content:space-between;font-size:20px}
  #mouse-wheel:active{background:var(--foreground);color:var(--surface)}#mouse-wheel>*{pointer-events:none}#mouse-wheel-grip{width:20px;height:34px}
  @media(max-height:400px){#mouse-wheel{bottom:12px}}
  </style></head><body><div id="stage"><div id="bg"><canvas id="bg-canvas"></canvas></div><img id="image" alt=""><video id="video" autoplay muted playsinline></video><div id="cursor"><img id="cursor-image" alt=""></div></div>
  <div id="mouse-buttons">${(["left", "right"] as const).map((button) => `<button type="button" id="mouse-${button}" class="mouse-button" aria-pressed="false"><svg viewBox="0 0 24 32" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="2" width="18" height="28" rx="9"/><path d="M12 2v12M3 14h18"/><path d="${button === "left" ? "M11 3C6 3 4 6 4 10v3h7Z" : "M13 3c5 0 7 3 7 7v3h-7Z"}" fill="currentColor" stroke="none"/></svg></button>`).join("")}<button type="button" id="mouse-wheel"><span aria-hidden="true">▴</span><svg id="mouse-wheel-grip" viewBox="0 0 20 34" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="1" y="1" width="18" height="32" rx="8"/><path d="M3 10h14M2 17h16M3 24h14"/></svg><span aria-hidden="true">▾</span></button></div>
  <textarea id="keyboard" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" aria-label="Keyboard"></textarea><script>
const net=${JSON.stringify(RTC_NETWORK)},validKeys=new Set(${JSON.stringify(MOBILE_REMOTE_DESKTOP_KEY_CODES)}),nativeMedia=${nativeMedia === true};
${VIEWER_SCRIPT}
</script></body></html>`;
}

export function remoteDesktopViewerCommand(message: MobileRemoteDesktopViewerCommand): string {
  const value = JSON.stringify(message).replace(/</gu, "\\u003c").replace(/\u2028/gu, "\\u2028").replace(/\u2029/gu, "\\u2029");
  return `window.__jokoRemoteDesktop&&window.__jokoRemoteDesktop.receive(${value});true;`;
}

function color(value: string, fallback: string): string {
  return /^#[0-9a-f]{3,8}$/iu.test(value) ? value : fallback;
}

const VIEWER_SCRIPT = String.raw`
(()=>{
  const stage=document.getElementById('stage'),image=document.getElementById('image'),video=document.getElementById('video');
  const cursor=document.getElementById('cursor'),cursorImage=document.getElementById('cursor-image'),keyboard=document.getElementById('keyboard');
  const bg=document.getElementById('bg'),bgCanvas=document.getElementById('bg-canvas');
  const mouseButtons=document.getElementById('mouse-buttons'),wheel=document.getElementById('mouse-wheel'),wheelGrip=document.getElementById('mouse-wheel-grip');
  let epoch=null,dw=1920,dh=1080,zoom=1,panX=0,panY=0,mode='touch',control=false;
  let pc=null,dc=null,attemptId=null,generation=0,retries=0,videoPresented=false,configPending=false;
  let nativeAttempt=null,nativeVideoActive=false;
  let deadline=null,disconnectTimer=null,retryTimer=null,stableTimer=null,iceTimer=null;
  let localCandidates=[],localAck=0,remoteAfter=0,remoteComplete=false,remoteSeen=new Set(),icePending=null,exchangeId=0,exchangeUntil=0;
  let seq=0,sequenceLimit=Number.MAX_SAFE_INTEGER,pending=[],sending=false,drag=false,hold=null,start=null,last=null,multi=null,gestureFrame=null;
  const pointers=new Map();let cx=.5,cy=.5,composing=false,keyboardEnabled=false;
  const heldMouse=new Map(),mouseControlHandlers=new Map();let showMouseButtons=false,nativeMouseControls=false,wheelY=null;
  let nativeTouchpad=null,fitToInsets=false,topInset=0,bottomInset=0,cursorNeedsEntry=true;
  let bgContext=null,bgRects=null,bgAxis='x',bgDpr=1,bgDrawFrame=null,bgLoopFrame=null;
  let remoteCursor=null,cursorOverlay=false,lastLocalMove=0,localCursorAwake=false,localCursorTimer=null,localCursorGeneration=0;
  const post=message=>window.ReactNativeWebView.postMessage(JSON.stringify({...message,epoch}));
  const clamp=value=>Math.max(0,Math.min(1,value));
  function viewport(){const sw=Math.max(1,stage.clientWidth),sh=Math.max(1,stage.clientHeight),top=fitToInsets?Math.min(sh-1,topInset):0,bottom=fitToInsets?Math.min(sh-top-1,bottomInset):0;return{width:sw,height:Math.max(1,sh-top-bottom),top,bottom};}
  function layout(){const v=viewport(),scale=Math.min(v.width/dw,v.height/dh)*zoom,w=dw*scale,h=dh*scale;return{w,h,x:(v.width-w)/2+panX,y:v.top+(v.height-h)/2+panY};}
  function boundPan(){const r=layout(),v=viewport(),margin=zoom>1?80:0;const minX=Math.min(0,v.width-r.w)-margin,maxX=Math.max(0,v.width-r.w)+margin;const minY=Math.min(0,v.height-r.h)-margin,maxY=Math.max(0,v.height-r.h)+margin;panX=Math.max(minX,Math.min(maxX,panX));panY=Math.max(minY,Math.min(maxY,panY));}
  function render(){const r=layout();if(nativeMedia&&epoch&&r.w>0&&r.h>0&&[r.x,r.y,r.w,r.h].every(Number.isFinite))post({type:'nativeViewport',x:r.x,y:r.y,width:r.w,height:r.h,fillHeight:false});for(const el of [image,video]){el.style.width=r.w+'px';el.style.height=r.h+'px';el.style.left=r.x+'px';el.style.top=r.y+'px';}if(remoteCursor){cursor.style.width=remoteCursor.width+'px';cursor.style.height=remoteCursor.height+'px';cursor.style.border='0';cursor.style.borderRadius='0';cursor.style.transform='none';cursor.style.left=(r.x+cx*r.w-remoteCursor.hotX)+'px';cursor.style.top=(r.y+cy*r.h-remoteCursor.hotY)+'px';cursor.style.display='block';cursor.style.opacity=(remoteCursor.visible||(control&&localCursorAwake))?'1':'0';}else{cursor.style.opacity='1';cursor.style.width='18px';cursor.style.height='18px';cursor.style.border='';cursor.style.borderRadius='';cursor.style.transform='';cursor.style.left=(r.x+cx*r.w)+'px';cursor.style.top=(r.y+cy*r.h)+'px';cursor.style.display=!cursorOverlay&&control&&(mode==='trackpad'||nativeTouchpad!==null||localCursorAwake)?'block':'none';}paintBackground();}
  function backgroundSegments(vw,vh){const scale=Math.min(vw/dw,vh/dh),w=dw*scale,h=dh*scale;if(w<vw){const centerW=w*.9,centerX=vw/2-centerW/2,sideW=centerX,top=(vh-h)/2;return{axis:'x',rects:[{x:0,y:top,w:sideW,h},{x:centerX,y:top,w:centerW,h},{x:centerX+centerW,y:top,w:sideW,h}]};}if(h<vh){const centerH=h*.9,centerY=vh/2-centerH/2,sideH=centerY,left=(vw-w)/2;return{axis:'y',rects:[{x:left,y:0,w,h:sideH},{x:left,y:centerY,w,h:centerH},{x:left,y:centerY+centerH,w,h:sideH}]};}return null;}
  function stopBackgroundLoop(){if(bgLoopFrame!==null)video.cancelVideoFrameCallback?.(bgLoopFrame);bgLoopFrame=null;}
  function clearBackground(){stopBackgroundLoop();if(bgDrawFrame!==null)cancelAnimationFrame(bgDrawFrame);bgDrawFrame=null;bgRects=null;bg.style.display='none';bgCanvas.width=bgCanvas.width;}
  function drawBackground(){if(!bgContext||!bgRects||!epoch||nativeVideoActive)return;const useVideo=videoPresented&&video.videoWidth>0&&video.videoHeight>0,src=useVideo?video:image,sw=useVideo?video.videoWidth:image.naturalWidth,sh=useVideo?video.videoHeight:image.naturalHeight;if((!useVideo&&!image.complete)||!(sw>0&&sh>0))return;bgContext.setTransform(bgDpr,0,0,bgDpr,0,0);bgContext.clearRect(0,0,stage.clientWidth,stage.clientHeight);const horizontal=bgAxis==='x',length=horizontal?sw:sh,cuts=[0,.05,.95,1];for(let i=0;i<3;i++){const rect=bgRects[i],origin=cuts[i]*length,span=(cuts[i+1]-cuts[i])*length;bgContext.drawImage(src,horizontal?origin:0,horizontal?0:origin,horizontal?span:sw,horizontal?sh:span,rect.x,rect.y,rect.w,rect.h);}}
  function scheduleBackgroundDraw(){if(bgDrawFrame!==null||!bgRects||!bgContext)return;const owner=epoch,frame=requestAnimationFrame(()=>{if(bgDrawFrame!==frame||epoch!==owner)return;bgDrawFrame=null;drawBackground();});bgDrawFrame=frame;}
  function startBackgroundLoop(){if(bgLoopFrame!==null||!bgContext||!bgRects||!videoPresented||typeof video.requestVideoFrameCallback!=='function')return;const owner=epoch,rtcGeneration=generation,frame=video.requestVideoFrameCallback(()=>{if(bgLoopFrame!==frame||epoch!==owner||generation!==rtcGeneration)return;bgLoopFrame=null;drawBackground();startBackgroundLoop();});bgLoopFrame=frame;}
  function paintBackground(){if(!epoch||nativeVideoActive){if(bgRects||bgDrawFrame!==null||bgLoopFrame!==null)clearBackground();return;}const vw=stage.clientWidth,vh=stage.clientHeight,seg=vw>0&&vh>0&&dw>0&&dh>0?backgroundSegments(vw,vh):null;if(!seg){clearBackground();return;}if(!bgContext){try{bgContext=bgCanvas.getContext('2d');}catch{return;}}if(!bgContext)return;bg.style.display='block';bgAxis=seg.axis;bgRects=seg.rects;bgDpr=Math.min(2,window.devicePixelRatio||1);const bw=Math.round(vw*bgDpr),bh=Math.round(vh*bgDpr);if(bgCanvas.width!==bw||bgCanvas.height!==bh){bgCanvas.width=bw;bgCanvas.height=bh;}scheduleBackgroundDraw();startBackgroundLoop();}
  image.addEventListener('load',scheduleBackgroundDraw);
  video.addEventListener('timeupdate',()=>{if(videoPresented&&typeof video.requestVideoFrameCallback!=='function')scheduleBackgroundDraw();});
  function validCursorPng(value){if(typeof value!=='string'||value.length>65536||!/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value))return false;let bytes;try{bytes=atob(value);}catch{return false;}if(bytes.length<33||bytes.length>49152||bytes.charCodeAt(8)!==0||bytes.charCodeAt(9)!==0||bytes.charCodeAt(10)!==0||bytes.charCodeAt(11)!==13||bytes.slice(12,16)!=='IHDR')return false;const dimension=offset=>bytes.charCodeAt(offset)*0x1000000+bytes.charCodeAt(offset+1)*0x10000+bytes.charCodeAt(offset+2)*0x100+bytes.charCodeAt(offset+3),width=dimension(16),height=dimension(20);return width>=1&&width<=512&&height>=1&&height<=512;}
  function validCursor(value){const keys=value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value):[];return keys.length===8&&['visible','x','y','width','height','hotX','hotY','png'].every(key=>Object.prototype.hasOwnProperty.call(value,key))&&typeof value.visible==='boolean'&&[value.x,value.y,value.width,value.height,value.hotX,value.hotY].every(Number.isFinite)&&value.x>=0&&value.x<=1&&value.y>=0&&value.y<=1&&value.width>0&&value.width<=256&&value.height>0&&value.height<=256&&value.hotX>=0&&value.hotX<=value.width&&value.hotY>=0&&value.hotY<=value.height&&validCursorPng(value.png);}
  function clearLocalCursorTimer(){clearTimeout(localCursorTimer);localCursorTimer=null;localCursorGeneration++;localCursorAwake=false;}
  function noteLocalCursorActivity(){lastLocalMove=performance.now();if(mode!=='trackpad'&&nativeTouchpad===null)return;localCursorAwake=true;clearTimeout(localCursorTimer);const token=++localCursorGeneration,cursorEpoch=epoch;localCursorTimer=setTimeout(()=>{if(token!==localCursorGeneration||epoch!==cursorEpoch)return;localCursorTimer=null;localCursorAwake=false;if(remoteCursor){cx=remoteCursor.x;cy=remoteCursor.y;}render();},205);}
  function receiveCursor(value){if(value===null){cursorOverlay=true;remoteCursor=null;clearLocalCursorTimer();cursorImage.removeAttribute('src');render();return;}if(!validCursor(value))return;cursorOverlay=true;if(!remoteCursor||remoteCursor.png!==value.png)cursorImage.src='data:image/png;base64,'+value.png;if(!control||mode!=='trackpad'||(!pointers.size&&performance.now()-lastLocalMove>200)){cx=value.x;cy=value.y;}if(value.visible)localCursorAwake=false;remoteCursor=value;render();}
  function resetCursor(){remoteCursor=null;clearLocalCursorTimer();cursorImage.removeAttribute('src');render();}
  function point(p){const r=layout();return{x:clamp((p.x-r.x)/r.w),y:clamp((p.y-r.y)/r.h)};}
  function inside(p){const r=layout();return p.x>=r.x&&p.x<=r.x+r.w&&p.y>=r.y&&p.y<=r.y+r.h;}
  function pan(dx,dy){panX+=dx;panY+=dy;cursorNeedsEntry=true;boundPan();render();}
  const bounded=(value,min,max)=>Math.max(min,Math.min(max,value));
  function cursorViewport(){const v=viewport(),hotX=remoteCursor?.hotX??9,hotY=remoteCursor?.hotY??9,w=remoteCursor?.width??18,h=remoteCursor?.height??18,minX=Math.min(v.width-1,8+hotX),minY=Math.min(v.top+v.height-1,v.top+8+hotY);return{minX,maxX:Math.max(minX,v.width-8-(w-hotX)),minY,maxY:Math.max(minY,v.top+v.height-8-(h-hotY))};}
  function moveTouchpad(dx,dy){const r=layout(),v=cursorViewport(),area=viewport();if(cursorNeedsEntry){cx=clamp((bounded(r.x+cx*r.w,v.minX,v.maxX)-r.x)/r.w);cy=clamp((bounded(r.y+cy*r.h,v.minY,v.maxY)-r.y)/r.h);cursorNeedsEntry=false;}cx=clamp(cx+dx/r.w);cy=clamp(cy+dy/r.h);const x=r.x+cx*r.w,y=r.y+cy*r.h;if(zoom>1||r.w>area.width||r.h>area.height){panX+=bounded(x,v.minX,v.maxX)-x;panY+=bounded(y,v.minY,v.maxY)-y;}queue({kind:'move',x:cx,y:cy});render();}
  function queue(event){if(!control)return;if(event.kind==='key'||event.kind==='text'){localCursorAwake=false;render();}if(event.kind==='move'||event.kind==='button')noteLocalCursorActivity();const tail=pending[pending.length-1];if(event.kind==='move'&&tail?.kind==='move')pending[pending.length-1]=event;else if(event.kind==='scroll'&&tail?.kind==='scroll'){tail.dx=Math.max(-2000,Math.min(2000,tail.dx+event.dx));tail.dy=Math.max(-2000,Math.min(2000,tail.dy+event.dy));}else pending.push(event);if(pending.length>64){pending=[{kind:'release'}];control=false;post({type:'inputOverflow'});}}
  function flush(){if(!pending.length||sending)return;if(seq>=sequenceLimit){pending=[];control=false;post({type:'inputOverflow'});render();return;}const events=pending.splice(0,64),sequence=++seq;if(pc?.connectionState==='connected'&&dc?.readyState==='open'&&dc.bufferedAmount<16384)dc.send(JSON.stringify({sequence,events}));else{sending=true;post({type:'input',sequence,events});}}
  setInterval(()=>{if(wheelY?.moved&&!sending){const offset=Math.max(-24,Math.min(24,wheelY.y-wheelY.start));if(Math.abs(offset)>4)scrollMouse(Math.sign(offset)*(Math.abs(offset)-4)*1.5);}flush();},33);
  function click(button=0){queue({kind:'button',button,down:true,x:cx,y:cy});queue({kind:'button',button,down:false,x:cx,y:cy});flush();}
  function resetWheel(){wheelY=null;wheelGrip.style.transform='translateY(0px)';}
  function updateMouseButtons(){mouseButtons.style.display=showMouseButtons&&control&&!nativeMouseControls?'block':'none';for(const[name,button]of[['left',0],['right',2]])document.getElementById('mouse-'+name).setAttribute('aria-pressed',String(heldMouse.has(button)));}
  function release(){clearTimeout(hold);if(gestureFrame!==null)cancelAnimationFrame(gestureFrame);gestureFrame=null;if(control){queue({kind:'release'});flush();}nativeTouchpad=null;heldMouse.clear();resetWheel();updateMouseButtons();drag=false;pointers.clear();start=last=multi=null;}
  function listenMouse(element,type,handler){element.addEventListener(type,handler);mouseControlHandlers.set(element.id+':'+type,handler);}
  for(const[name,button]of[['left',0],['right',2]]){
    const element=document.getElementById('mouse-'+name);
    listenMouse(element,'pointerdown',event=>{event.preventDefault();if(!control||!showMouseButtons||heldMouse.has(button))return;clearTimeout(hold);if(!event.nativeInput)element.setPointerCapture(event.pointerId);heldMouse.set(button,event.pointerId);queue({kind:'button',button,down:true,x:cx,y:cy});flush();updateMouseButtons();});
    const up=event=>{event.preventDefault();if(heldMouse.get(button)!==event.pointerId)return;heldMouse.delete(button);queue({kind:'button',button,down:false,x:cx,y:cy});flush();updateMouseButtons();};
    for(const type of['pointerup','pointercancel','lostpointercapture'])listenMouse(element,type,up);
    listenMouse(element,'click',event=>{if(event.detail===0&&control&&showMouseButtons){click(button);flush();}});
  }
  function scrollMouse(dy){if(control&&showMouseButtons&&Number.isFinite(dy))queue({kind:'scroll',dx:0,dy:Math.max(-2000,Math.min(2000,dy))});}
  listenMouse(wheel,'pointerdown',event=>{event.preventDefault();if(!control||!showMouseButtons||wheelY)return;if(!event.nativeInput)wheel.setPointerCapture(event.pointerId);wheelY={id:event.pointerId,y:event.clientY,start:event.clientY,moved:false};});
  listenMouse(wheel,'pointermove',event=>{if(!wheelY||wheelY.id!==event.pointerId)return;event.preventDefault();wheelGrip.style.transform='translateY('+Math.max(-24,Math.min(24,event.clientY-wheelY.start))+'px)';wheelY.y=event.clientY;if(Math.abs(event.clientY-wheelY.start)>4)wheelY.moved=true;});
  listenMouse(wheel,'pointerup',event=>{if(!wheelY||wheelY.id!==event.pointerId)return;event.preventDefault();if(!wheelY.moved&&control&&showMouseButtons){click(1);flush();}resetWheel();});
  const cancelWheel=event=>{if(wheelY?.id===event.pointerId)resetWheel();};
  listenMouse(wheel,'pointercancel',cancelWheel);listenMouse(wheel,'lostpointercapture',cancelWheel);
  listenMouse(wheel,'click',event=>{if(event.detail===0&&control&&showMouseButtons){click(1);flush();}});
  listenMouse(wheel,'keydown',event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();scrollMouse(event.key==='ArrowUp'?-120:120);}});
  function pair(){const [a,b]=[...pointers.values()];return{x:(a.x+b.x)/2,y:(a.y+b.y)/2,d:Math.hypot(a.x-b.x,a.y-b.y)};}
  function movePair(){gestureFrame=null;if(pointers.size<2||!multi)return;const next=pair(),span=Math.abs(next.d-multi.d),travel=Math.hypot(next.x-multi.x,next.y-multi.y);if(!multi.kind){if(span>8&&span>travel*.7)multi.kind='pinch';else if(travel>8)multi.kind='scroll';}if(multi.kind==='pinch'){zoom=Math.max(1,Math.min(5,multi.zoom*next.d/Math.max(1,multi.d)));boundPan();render();}else if(multi.kind==='scroll'){const dx=next.x-multi.lastX,dy=next.y-multi.lastY;if(control&&mode!=='pan')queue({kind:'scroll',dx:Math.max(-2000,Math.min(2000,-dx)),dy:Math.max(-2000,Math.min(2000,-dy))});else pan(dx,dy);}multi.lastX=next.x;multi.lastY=next.y;}
  stage.addEventListener('pointerdown',event=>{if(pointers.has(event.pointerId))return;event.preventDefault();stage.setPointerCapture(event.pointerId);pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});if(pointers.size===1){start=last={x:event.clientX,y:event.clientY};hold=setTimeout(()=>{if(control&&mode!=='pan'&&pointers.size===1&&start&&!heldMouse.size&&(mode!=='touch'||inside(start))){if(mode==='touch'){const p=point(start);cx=p.x;cy=p.y;}queue({kind:'button',button:0,down:true,x:cx,y:cy});flush();drag=true;}},400);}else{clearTimeout(hold);if(drag)queue({kind:'release'});drag=false;start=null;const p=pair();multi={...p,lastX:p.x,lastY:p.y,zoom,kind:null};}});
  stage.addEventListener('pointermove',event=>{if(!pointers.has(event.pointerId))return;event.preventDefault();pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});if(pointers.size>=2){if(gestureFrame===null)gestureFrame=requestAnimationFrame(movePair);return;}if(!start||!last)return;const now={x:event.clientX,y:event.clientY},dx=now.x-last.x,dy=now.y-last.y;last=now;if(Math.hypot(now.x-start.x,now.y-start.y)>6)clearTimeout(hold);if(!control||mode==='pan'||(mode==='touch'&&!drag&&!heldMouse.size)){pan(dx,dy);return;}if(mode==='trackpad'){const r=layout();cx=clamp(cx+dx/r.w*1.5);cy=clamp(cy+dy/r.h*1.5);}else{const p=point(now);cx=p.x;cy=p.y;}queue({kind:'move',x:cx,y:cy});render();});
  function pointerUp(event){if(!pointers.has(event.pointerId))return;clearTimeout(hold);const wasTap=start&&last&&Math.hypot(last.x-start.x,last.y-start.y)<=6;pointers.delete(event.pointerId);if(drag){queue({kind:'button',button:0,down:false,x:cx,y:cy});flush();drag=false;}else if(wasTap&&control&&mode!=='pan'&&!heldMouse.size&&event.type==='pointerup'&&(mode!=='touch'||inside({x:event.clientX,y:event.clientY}))){if(mode==='touch'){const p=point({x:event.clientX,y:event.clientY});cx=p.x;cy=p.y;}click();}start=last=multi=null;boundPan();render();}
  stage.addEventListener('pointerup',pointerUp);stage.addEventListener('pointercancel',()=>{release();boundPan();render();});
  stage.addEventListener('contextmenu',event=>event.preventDefault());stage.addEventListener('selectstart',event=>event.preventDefault());stage.addEventListener('dragstart',event=>event.preventDefault());
  const sentinel='\u200b';function resetKeyboard(){keyboard.value=sentinel;keyboard.setSelectionRange(1,1);}function showKeyboard(enabled){keyboardEnabled=enabled&&control;if(!keyboardEnabled){composing=false;resetKeyboard();keyboard.blur();return;}keyboard.blur();resetKeyboard();keyboard.focus({preventScroll:true});}
  function keyboardKey(code){if(!keyboardEnabled||!control)return;queue({kind:'key',code,down:true});queue({kind:'key',code,down:false});flush();}
  function commitKeyboard(){if(!keyboardEnabled||!control||composing)return;const text=keyboard.value.replace(sentinel,'');if(text){for(let index=0;index<text.length;index+=4096)queue({kind:'text',text:text.slice(index,index+4096)});flush();}resetKeyboard();}
  keyboard.addEventListener('compositionstart',()=>{composing=true;});keyboard.addEventListener('compositionend',()=>{composing=false;commitKeyboard();});keyboard.addEventListener('input',event=>{if(!event.isComposing)commitKeyboard();});keyboard.addEventListener('beforeinput',event=>{if(composing||event.isComposing)return;if(event.inputType==='deleteContentBackward'){event.preventDefault();keyboardKey('Backspace');}else if(event.inputType==='insertLineBreak'||event.inputType==='insertParagraph'){event.preventDefault();keyboardKey('Enter');}});
  const normalizedKey=code=>/^(Shift|Control|Alt|Meta)Right$/.test(code)?code.replace(/Right$/,'Left'):code;
  document.addEventListener('keydown',event=>{if(mouseButtons.contains(event.target))return;const code=normalizedKey(event.code);if(control&&validKeys.has(code)){event.preventDefault();queue({kind:'key',code,down:true});}});document.addEventListener('keyup',event=>{if(mouseButtons.contains(event.target))return;const code=normalizedKey(event.code);if(control&&validKeys.has(code)){event.preventDefault();queue({kind:'key',code,down:false});}});window.addEventListener('blur',()=>{release();if(epoch)post({type:'mouseControlsRetired'});});new ResizeObserver(()=>{release();if(epoch)post({type:'mouseControlsRetired'});cursorNeedsEntry=true;boundPan();render();}).observe(stage);
  function retainFrame(){if(!videoPresented||video.readyState<2||!video.videoWidth||!video.videoHeight)return;const canvas=document.createElement('canvas');try{const scale=Math.min(1,1280/Math.max(video.videoWidth,video.videoHeight));canvas.width=Math.max(1,Math.round(video.videoWidth*scale));canvas.height=Math.max(1,Math.round(video.videoHeight*scale));const context=canvas.getContext('2d');if(context){context.drawImage(video,0,0,canvas.width,canvas.height);image.src=canvas.toDataURL('image/jpeg',.7);}}catch{}finally{canvas.width=canvas.height=0;}}
  function presentationActive(){return video.webkitPresentationMode==='picture-in-picture'||document.pictureInPictureElement===video;}
  function presentationSupported(){try{return video.webkitSupportsPresentationMode?.('picture-in-picture')===true||document.pictureInPictureEnabled===true;}catch{return false;}}
  function reportPresentation(){if(!nativeMedia)post({type:'presentation',active:presentationActive()});}
  async function setPresentation(enabled){if(nativeMedia){release();showKeyboard(false);return;}try{if(enabled){if(video.webkitSupportsPresentationMode?.('picture-in-picture'))video.webkitSetPresentationMode('picture-in-picture');else if(document.pictureInPictureEnabled&&video.requestPictureInPicture)await video.requestPictureInPicture();else throw new Error();}else if(video.webkitPresentationMode==='picture-in-picture')video.webkitSetPresentationMode('inline');else if(document.pictureInPictureElement===video&&document.exitPictureInPicture)await document.exitPictureInPicture();}catch{post({type:'presentationFailed'});}}
  video.addEventListener('webkitpresentationmodechanged',reportPresentation);video.addEventListener('enterpictureinpicture',reportPresentation);video.addEventListener('leavepictureinpicture',reportPresentation);
  function clearRtcTimers(){for(const timer of [deadline,disconnectTimer,retryTimer,stableTimer,iceTimer])clearTimeout(timer);deadline=disconnectTimer=retryTimer=stableTimer=iceTimer=null;}
  function closeRtc(preserve=true){configPending=false;if(preserve)retainFrame();generation++;clearRtcTimers();stopBackgroundLoop();localCandidates=[];localAck=remoteAfter=0;remoteComplete=false;remoteSeen=new Set();icePending=null;attemptId=null;if(dc)dc.close();if(pc)pc.close();dc=pc=null;video.onplaying=null;video.srcObject=null;video.style.display='none';videoPresented=false;image.style.display='block';if(!preserve){image.removeAttribute('src');clearBackground();}}
  function failRtc(reason,canRetry=true){const failed=attemptId;release();sending=false;pending=[];closeRtc();post({type:'fallback',attemptId:failed,reason});const capturePending=reason==='capture-pending';if(canRetry&&epoch&&(capturePending||retries<net.retryMs.length)){const delay=capturePending?net.retryMs[net.retryMs.length-1]:net.retryMs[retries++];retryTimer=setTimeout(()=>{retryTimer=null;if(epoch)connect();},delay);}}
  function pollIce(){if(!pc||!pc.remoteDescription||icePending||Date.now()>=exchangeUntil)return;const candidates=localCandidates.slice(localAck,localAck+net.batchSize);icePending={after:remoteAfter,sent:candidates.length,exchangeId:++exchangeId};post({type:'ice',attemptId,candidates,after:remoteAfter,exchangeId});iceTimer=setTimeout(()=>{icePending=null;pollIce();},4500);}
  async function receiveIce(message){if(!pc||!icePending||message.attemptId!==attemptId||message.exchangeId!==icePending.exchangeId)return;const rtc=pc,g=generation,batch=icePending;clearTimeout(iceTimer);try{if(message.error){icePending=null;iceTimer=setTimeout(pollIce,1000);return;}if(!Array.isArray(message.candidates)||message.candidates.length>net.batchSize||message.next!==batch.after+message.candidates.length||message.next>net.maxCandidates)throw new Error();for(const candidate of message.candidates){if(g!==generation)return;const key=JSON.stringify(candidate);if(remoteSeen.has(key))continue;if(remoteSeen.size>=net.maxCandidates)throw new Error();await rtc.addIceCandidate(candidate);remoteSeen.add(key);}if(g!==generation)return;localAck+=batch.sent;remoteAfter=message.next;remoteComplete=message.complete===true;icePending=null;if(!(remoteComplete&&rtc.iceGatheringState==='complete'&&localAck===localCandidates.length))iceTimer=setTimeout(pollIce,net.pollMs);}catch{if(g===generation)failRtc('candidates');}}
  async function receiveAnswer(message){if(!pc||message.attemptId!==attemptId)return;const rtc=pc,g=generation;try{await rtc.setRemoteDescription({type:'answer',sdp:message.sdp});if(g!==generation)return;clearTimeout(deadline);deadline=setTimeout(()=>{if(g===generation&&rtc.connectionState!=='connected')failRtc('connect-timeout');},net.connectMs);exchangeUntil=Date.now()+net.exchangeMs;pollIce();}catch{if(g===generation)failRtc('answer');}}
  async function connect(){closeRtc();const g=generation;attemptId=String(g);post({type:'iceConfig',attemptId});if(!window.RTCPeerConnection){failRtc('unsupported',false);return;}configPending=true;deadline=setTimeout(()=>{if(g===generation&&configPending){configPending=false;void startRtc(g,[{urls:['stun:stun.cloudflare.com:3478']},{urls:['stun:stun.l.google.com:19302']}]);}},3500);}
  async function startRtc(g,iceServers){try{const rtc=new RTCPeerConnection({iceServers});pc=rtc;dc=rtc.createDataChannel('input-v1',{ordered:true});rtc.addTransceiver('video',{direction:'recvonly'});rtc.addTransceiver('audio',{direction:'recvonly'});dc.onmessage=event=>{try{if(g!==generation||pc!==rtc||typeof event.data!=='string'||event.data.length>80000)return;const message=JSON.parse(event.data);if(message.type==='reply')post({type:'channelReply',attemptId,reply:message});else if(message.type==='cursor'&&Object.prototype.hasOwnProperty.call(message,'cursor'))receiveCursor(message.cursor);else if(presentationActive()&&message.type==='viewPing'&&typeof message.challenge==='string'&&message.challenge.length<=64&&dc?.readyState==='open')dc.send(message.challenge);}catch{}};rtc.onicecandidate=({candidate})=>{if(g!==generation||!candidate?.candidate)return;if(localCandidates.length>=net.maxLocalCandidates){failRtc('candidate-limit',false);return;}localCandidates.push({candidate:candidate.candidate,sdpMid:candidate.sdpMid,sdpMLineIndex:candidate.sdpMLineIndex,...(candidate.usernameFragment?{usernameFragment:candidate.usernameFragment}:{})});};rtc.ontrack=event=>{if(g!==generation)return;const current=video.srcObject instanceof MediaStream?video.srcObject:null;if(current&&!event.streams[0])current.addTrack(event.track);else video.srcObject=event.streams[0]||new MediaStream([event.track]);video.play().catch(()=>{});};video.onplaying=()=>{if(g!==generation||videoPresented)return;videoPresented=true;video.style.display='block';render();post({type:'pipCapability',supported:presentationSupported()});requestAnimationFrame(()=>requestAnimationFrame(()=>{if(g!==generation)return;post({type:'streaming',attemptId});}));};rtc.onconnectionstatechange=()=>{if(g!==generation)return;if(['failed','closed'].includes(rtc.connectionState)){failRtc('transport');return;}if(rtc.connectionState==='disconnected'){clearTimeout(stableTimer);if(!disconnectTimer){release();post({type:'reconnecting',attemptId});disconnectTimer=setTimeout(()=>{if(g===generation)failRtc('disconnected');},net.disconnectedMs);}}else if(rtc.connectionState==='connected'){clearTimeout(disconnectTimer);disconnectTimer=null;clearTimeout(deadline);if(videoPresented)post({type:'streaming',attemptId});stableTimer=setTimeout(()=>{if(g===generation)retries=0;},net.stableMs);}};await rtc.setLocalDescription(await rtc.createOffer());if(g!==generation)return;post({type:'offer',attemptId,sdp:rtc.localDescription.sdp});deadline=setTimeout(()=>{if(g===generation)failRtc('answer-timeout');},net.answerMs);}catch{if(g===generation)failRtc('setup');}}
  async function receiveIceConfig(message){if(!epoch||!configPending||message.attemptId!==attemptId)return;configPending=false;clearTimeout(deadline);deadline=null;await startRtc(generation,message.iceServers);}
  function hideNativeVideo(){nativeVideoActive=false;image.style.visibility='visible';resetCursor();}
  function receive(message){
    if(!message||typeof message!=='object')return;
    switch(message.type){
      case'channelRequest':{
        if(nativeMedia||message.epoch!==epoch)break;
        const request=message.message;
        if(!request||request.type!=='request'||typeof request.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(request.id))break;
        if(message.attemptId!==attemptId||!dc||dc.readyState!=='open'||dc.bufferedAmount>65536){post({type:'channelUnavailable',attemptId:message.attemptId,id:request.id});break;}
        const wire=JSON.stringify(request);
        if(new TextEncoder().encode(wire).byteLength>32768){post({type:'channelUnavailable',attemptId:message.attemptId,id:request.id});break;}
        try{dc.send(wire);}catch{post({type:'channelReply',attemptId,reply:{type:'reply',id:request.id,ok:false,error:'REMOTE_DESKTOP_REQUEST_RESULT_UNKNOWN'}});}break;
      }
      case'init':
        release();showMouseButtons=false;nativeMouseControls=false;updateMouseButtons();nativeAttempt=null;hideNativeVideo();cursorOverlay=message.cursorOverlay===true;resetCursor();pending=[];sending=false;
        seq=Number.isSafeInteger(message.sequenceBase)&&message.sequenceBase>=0?message.sequenceBase:0;
        sequenceLimit=Number.isSafeInteger(message.sequenceLimit)&&message.sequenceLimit>seq?message.sequenceLimit:Number.MAX_SAFE_INTEGER;
        epoch=message.epoch;dw=message.width;dh=message.height;zoom=1;panX=panY=0;cursorNeedsEntry=true;fitToInsets=false;topInset=bottomInset=0;video.muted=message.audio!==true;retries=0;render();
        if(nativeMedia){closeRtc(false);break;}
        if(message.webrtc===false){closeRtc();post({type:'fallback',attemptId:null,reason:'unavailable'});}else connect();break;
      case'nativeAttempt':
        if(!nativeMedia||message.epoch!==epoch||typeof message.attemptId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(message.attemptId))break;
        if(nativeAttempt!==message.attemptId){nativeAttempt=message.attemptId;hideNativeVideo();}break;
      case'nativeVideo':
        if(!nativeMedia||message.epoch!==epoch||message.attemptId!==nativeAttempt)break;
        nativeVideoActive=true;image.style.visibility='hidden';paintBackground();break;
      case'nativeCursor':
        if(nativeMedia&&nativeVideoActive&&message.epoch===epoch&&message.attemptId===nativeAttempt)receiveCursor(message.cursor);break;
      case'mouseButtons':{
        const keys=Object.keys(message),labels=message.labels;
        if(message.epoch!==epoch||keys.length!==5||!['type','epoch','enabled','nativeControls','labels'].every(key=>Object.prototype.hasOwnProperty.call(message,key))||typeof message.enabled!=='boolean'||typeof message.nativeControls!=='boolean'||!labels||typeof labels!=='object'||Array.isArray(labels)||Object.keys(labels).length!==3||!['left','right','wheel'].every(name=>typeof labels[name]==='string'&&labels[name].length>0&&labels[name].length<=256))break;
        if(!message.enabled||nativeMouseControls!==message.nativeControls){for(const button of heldMouse.keys())queue({kind:'button',button,down:false,x:cx,y:cy});heldMouse.clear();resetWheel();flush();}
        showMouseButtons=message.enabled;nativeMouseControls=message.nativeControls;
        for(const name of['left','right','wheel'])document.getElementById('mouse-'+name).setAttribute('aria-label',labels[name]);
        updateMouseButtons();break;
      }
      case'nativeMouse':
        if(message.epoch!==epoch||!nativeMouseControls||!control||!showMouseButtons||Object.keys(message).length!==6||!['type','epoch','control','event','id','y'].every(key=>Object.prototype.hasOwnProperty.call(message,key))||!['left','right','wheel'].includes(message.control)||!['pointerdown','pointermove','pointerup','pointercancel','click'].includes(message.event)||message.id!==0||!Number.isFinite(message.y))break;
        mouseControlHandlers.get('mouse-'+message.control+':'+message.event)?.({pointerId:message.id,clientY:message.y,detail:0,nativeInput:true,preventDefault(){}});break;
      case'viewport':{
        if(message.epoch!==epoch||Object.keys(message).length!==5||!['type','epoch','fitToInsets','topInset','bottomInset'].every(key=>Object.prototype.hasOwnProperty.call(message,key))||typeof message.fitToInsets!=='boolean'||![message.topInset,message.bottomInset].every(value=>Number.isFinite(value)&&value>=0&&value<=32768))break;
        if(fitToInsets===message.fitToInsets&&topInset===message.topInset&&bottomInset===message.bottomInset)break;
        release();fitToInsets=message.fitToInsets;topInset=message.topInset;bottomInset=message.bottomInset;cursorNeedsEntry=true;panX=panY=0;render();break;
      }
      case'nativeTouchpad':{
        if(message.epoch!==epoch||!nativeMouseControls||!control||!Number.isSafeInteger(message.id)||message.id<1)break;
        const fields=message.event==='move'?['type','epoch','id','event','dx','dy']:message.event==='end'?['type','epoch','id','event','tap']:['type','epoch','id','event'];
        if(!['start','move','end','cancel'].includes(message.event)||Object.keys(message).length!==fields.length||!fields.every(key=>Object.prototype.hasOwnProperty.call(message,key)))break;
        if(message.event==='start'){if(nativeTouchpad===null)nativeTouchpad=message.id;break;}
        if(nativeTouchpad!==message.id)break;
        if(message.event==='move'){if(Number.isFinite(message.dx)&&Number.isFinite(message.dy))moveTouchpad(message.dx,message.dy);break;}
        if(message.event==='end'){if(typeof message.tap!=='boolean')break;nativeTouchpad=null;if(message.tap&&!heldMouse.size){click();flush();}break;}
        release();break;
      }
      case'answer':if(!nativeMedia&&message.epoch===epoch)void receiveAnswer(message);break;
      case'iceConfig':if(!nativeMedia&&message.epoch===epoch)void receiveIceConfig(message);break;
      case'ice':if(!nativeMedia&&message.epoch===epoch)void receiveIce(message);break;
      case'reconnecting':
        if(nativeMedia&&message.epoch===epoch&&message.attemptId===nativeAttempt)hideNativeVideo();break;
      case'fallback':
        if(nativeMedia){if(message.epoch===epoch&&message.attemptId===nativeAttempt)hideNativeVideo();break;}
        if(message.epoch===epoch&&message.attemptId===attemptId)failRtc(message.capturePending===true?'capture-pending':'host',message.retry!==false);break;
      case'frame':{
        if(message.epoch!==epoch||typeof message.frameId!=='string')break;
        if(!nativeVideoActive){if(Object.prototype.hasOwnProperty.call(message,'cursor'))receiveCursor(message.cursor);else resetCursor();}
        const frameEpoch=epoch,frameId=message.frameId;
        image.onload=()=>{if(epoch===frameEpoch)post({type:'framePresented',frameId,presented:!nativeVideoActive});};
        image.onerror=()=>{if(epoch===frameEpoch)post({type:'framePresented',frameId,presented:false});};
        image.src='data:image/jpeg;base64,'+message.jpeg;break;
      }
      case'control':{const enabled=message.enabled===true;if(control!==enabled||!enabled)release();control=enabled;if(!control)showKeyboard(false);updateMouseButtons();render();break;}
      case'mode':release();mode=message.mode;render();break;
      case'fit':zoom=1;panX=panY=0;cursorNeedsEntry=true;render();break;
      case'keyboard':showKeyboard(message.enabled===true);break;
      case'click':if(message.button===0||message.button===1||message.button===2)click(message.button);break;
      case'releaseInput':pending=[];release();break;
      case'events':for(const event of message.events||[])queue(event);flush();break;
      case'ack':if(message.epoch===epoch&&message.sequence===seq)sending=false;break;
      case'videoSettings':video.muted=message.audio!==true;retries=0;if(!nativeMedia)connect();break;
      case'presentation':void setPresentation(message.enabled===true);break;
      case'stop':
        void setPresentation(false);showKeyboard(false);release();control=false;showMouseButtons=false;nativeMouseControls=false;updateMouseButtons();nativeAttempt=null;hideNativeVideo();resetCursor();cursorOverlay=false;pending=[];sending=false;epoch=null;closeRtc(message.preserveFrame===true);render();break;
    }
  }
  window.__jokoRemoteDesktop={receive};window.addEventListener('message',event=>{try{receive(typeof event.data==='string'?JSON.parse(event.data):event.data);}catch{}});document.addEventListener('message',event=>{try{receive(typeof event.data==='string'?JSON.parse(event.data):event.data);}catch{}});render();post({type:'ready'});
})();`;

export const mobileRemoteDesktopViewerTesting = Object.freeze({ RTC_NETWORK, KEY_CODES: MOBILE_REMOTE_DESKTOP_KEY_CODES });
