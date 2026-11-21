import { beginRegionRecording } from "./region-capture-live.js";

const bridge = window.jokoRegionCapture;
const element = (id) => document.getElementById(id);
const view = element("view");
const canvas = element("capture");
const context = canvas.getContext("2d");
const effectSample = document.createElement("canvas");
const effectContext = effectSample.getContext("2d");
const annotationTools = ["pen", "outline", "ellipse", "line", "arrow", "highlight", "text", "step", "mosaic", "blur"];
const controls = element("controls");
const annotationText = element("annotation-text");
const status = element("status");
let picture;
let mode;
let start;
let current;
let heldPointer;
let busy = false;
let tool = "pen";
const marks = [];
const redoMarks = [];
let liveMark;
let pendingPaint = 0;
let activeRecording;
let recordedBlob;
let playbackUrl;
let canRecord = false;

const chinese = {
  choose: "拖动以选择区域", full: "整个屏幕", windows: "选择窗口", pen: "画笔", outline: "矩形", mosaic: "马赛克", blur: "模糊",
  ellipse: "椭圆", line: "直线", arrow: "箭头", highlight: "荧光笔", text: "文字", annotationText: "标注文字", step: "步骤编号",
  undo: "撤销", redo: "重做", copy: "复制", save: "保存", pin: "置顶", attach: "附加到新任务", cancel: "关闭",
  taskActions: "分析截图", translationLanguage: "翻译语言", translate: "翻译", explain: "解释", extract: "提取文字",
  unavailable: "无法完成截图操作。", noWindows: "没有可截取的窗口。", select: "选择窗口", closed: "操作未完成。",
  scroll: "滚动截图", video: "录制视频", audio: "音频", microphone: "麦克风", systemAudio: "电脑声音",
  pause: "暂停", resume: "继续", finish: "完成", scrolling: "滚动选区内的窗口", joining: "请减小滚动距离以对齐画面",
  recording: "录制中", recordingFailed: "无法录制选中的屏幕或音频。"
};
const english = {
  unavailable: "Screen capture could not complete.", noWindows: "No capturable windows are available.",
  select: "Choose a window", closed: "The action did not complete.",
  pause: "Pause", resume: "Resume", scrolling: "Scroll within the selected area", joining: "Scroll a shorter distance to align the frames",
  recording: "Recording", recordingFailed: "The selected screen or audio could not be recorded."
};
let copy = english;

function notice(message) {
  status.textContent = message;
  status.hidden = message === "";
}

async function showImage(payload) {
  const url = URL.createObjectURL(new Blob([payload.png], { type: "image/png" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (image.naturalWidth !== payload.width || image.naturalHeight !== payload.height) throw new Error();
    picture = image;
    canvas.width = payload.width;
    canvas.height = payload.height;
    paint();
  } finally {
    URL.revokeObjectURL(url);
  }
}

function paint() {
  if (!picture) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(picture, 0, 0);
  if (mode === "screen") {
    context.fillStyle = "rgb(13 13 13 / 44%)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (start && current) {
      const bounds = rectangle(start, current);
      const x = bounds.left * canvas.width, y = bounds.top * canvas.height;
      const width = bounds.right * canvas.width - x, height = bounds.bottom * canvas.height - y;
      if (width > 0 && height > 0) {
        context.drawImage(picture, x, y, width, height, x, y, width, height);
        context.strokeStyle = "#ff9800";
        context.lineWidth = Math.max(2, canvas.width / 900);
        context.strokeRect(x, y, width, height);
      }
    }
  }
  if (mode === "edit") {
    for (const mark of marks) paintMark(mark);
    if (liveMark) paintMark(liveMark);
  }
}

function paintOnFrame() {
  if (pendingPaint) return;
  pendingPaint = requestAnimationFrame(() => {
    pendingPaint = 0;
    paint();
  });
}

function paintMark(mark) {
  const sample = mark.points[0];
  if (mark.tool === "mosaic" || mark.tool === "blur") {
    paintRedaction(rectangle(sample, mark.points.at(-1)), mark.tool);
    return;
  }
  const x = (point) => point.x * canvas.width;
  const y = (point) => point.y * canvas.height;
  const width = Math.max(3, Math.min(12, canvas.width / 240));
  const end = mark.points.at(-1);
  context.save();
  context.lineWidth = mark.tool === "highlight" ? width * 5 : width;
  if (mark.tool === "highlight") context.globalAlpha = 0.35;
  context.strokeStyle = "#ff9800";
  context.fillStyle = "#ff9800";
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  if (mark.tool === "outline") {
    context.strokeRect(x(sample), y(sample), x(end) - x(sample), y(end) - y(sample));
  } else if (mark.tool === "ellipse") {
    context.ellipse((x(sample) + x(end)) / 2, (y(sample) + y(end)) / 2,
      Math.abs(x(end) - x(sample)) / 2, Math.abs(y(end) - y(sample)) / 2, 0, 0, 2 * Math.PI);
    context.stroke();
  } else if (mark.tool === "line" || mark.tool === "arrow") {
    context.moveTo(x(sample), y(sample));
    context.lineTo(x(end), y(end));
    if (mark.tool === "arrow") {
      const angle = Math.atan2(y(end) - y(sample), x(end) - x(sample));
      const size = Math.min(width * 5, Math.hypot(x(end) - x(sample), y(end) - y(sample)) * 0.6);
      for (const side of [-1, 1]) {
        context.moveTo(x(end), y(end));
        context.lineTo(x(end) - size * Math.cos(angle + side * Math.PI / 6), y(end) - size * Math.sin(angle + side * Math.PI / 6));
      }
    }
    context.stroke();
  } else if (mark.tool === "text" || mark.tool === "step") {
    const size = Math.max(18, width * 4);
    context.font = `700 ${size}px system-ui`;
    context.textBaseline = "middle";
    if (mark.tool === "step") {
      const radius = size * 0.8;
      context.arc(x(sample), y(sample), radius, 0, 2 * Math.PI);
      context.fill();
      context.fillStyle = "#0d0d0d";
      context.textAlign = "center";
    }
    context.fillText(mark.label, x(sample), y(sample));
  } else if (mark.points.length === 1) {
    context.arc(x(sample), y(sample), context.lineWidth / 2, 0, 2 * Math.PI);
    context.fill();
  } else {
    context.moveTo(x(sample), y(sample));
    for (const point of mark.points.slice(1)) context.lineTo(x(point), y(point));
    context.stroke();
  }
  context.restore();
}

function updateAnnotationActions() {
  element("undo").disabled = marks.length === 0;
  element("redo").disabled = redoMarks.length === 0;
}

function moveMark(from, to) {
  if (busy || mode !== "edit" || heldPointer !== undefined || from.length === 0) return;
  to.push(from.pop());
  updateAnnotationActions();
  paint();
}

function paintRedaction(bounds, effect) {
  const left = Math.floor(bounds.left * canvas.width);
  const top = Math.floor(bounds.top * canvas.height);
  const width = Math.ceil(bounds.right * canvas.width) - left;
  const height = Math.ceil(bounds.bottom * canvas.height) - top;
  if (width < 2 || height < 2) return;
  // Sample only inside the selected rectangle. Blow the low-resolution image
  // back up with discrete blocks for mosaic or interpolation for blur.
  const scale = canvas.width / Math.max(1, canvas.clientWidth);
  const step = Math.max(8, (effect === "mosaic" ? 12 : 16) * scale);
  effectSample.width = Math.max(1, Math.round(width / step));
  effectSample.height = Math.max(1, Math.round(height / step));
  effectContext.imageSmoothingQuality = "high";
  effectContext.drawImage(canvas, left, top, width, height, 0, 0, effectSample.width, effectSample.height);
  context.save();
  context.imageSmoothingEnabled = effect === "blur";
  context.clearRect(left, top, width, height);
  context.drawImage(effectSample, left, top, width, height);
  context.restore();
}

function position(event) {
  const bounds = canvas.getBoundingClientRect();
  const clamp = (coordinate) => Math.max(0, Math.min(1, coordinate));
  return { x: clamp((event.clientX - bounds.left) / bounds.width), y: clamp((event.clientY - bounds.top) / bounds.height) };
}

function rectangle(a, b) {
  return { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
}

function changeMode(next) {
  mode = next;
  view.dataset.mode = mode;
  element("controls").hidden = false;
  element("select-actions").hidden = mode !== "screen";
  element("edit-actions").hidden = mode !== "edit";
  element("live-actions").hidden = mode !== "live";
  element("recording-actions").hidden = mode !== "recording";
  canvas.hidden = mode === "recording";
  for (const id of ["scroll", "gif", "video", "audio"]) element(id).hidden = !canRecord;
  paint();
}

async function choose(load, region = false) {
  if (busy || mode !== "screen") return;
  busy = true;
  notice("");
  try {
    const image = await load();
    await showImage(image);
    canRecord = region;
    changeMode("edit");
    element("copy").focus();
  } catch {
    paint();
    notice(copy.unavailable);
  } finally { busy = false; }
}

canvas.addEventListener("pointerdown", (event) => {
  if (busy || heldPointer !== undefined || event.button !== 0 || picture === undefined) return;
  if (mode === "edit" && marks.length >= 100) return;
  if (mode === "edit" && tool === "text" && !annotationText.value.trim()) { annotationText.focus(); return; }
  heldPointer = event.pointerId;
  canvas.setPointerCapture(heldPointer);
  if (mode === "screen") start = current = position(event);
  if (mode === "edit") liveMark = { tool, points: [position(event)],
    label: tool === "text" ? annotationText.value.trim() : String(1 + marks.filter(mark => mark.tool === "step").length) };
  paint();
});
canvas.addEventListener("pointermove", (event) => {
  if (heldPointer !== event.pointerId) return;
  if (mode === "screen") current = position(event);
  if (liveMark && (liveMark.tool === "pen" || liveMark.tool === "highlight")) {
    if (liveMark.points.length < 1500) liveMark.points.push(position(event));
  } else if (liveMark && liveMark.tool !== "text" && liveMark.tool !== "step") liveMark.points[1] = position(event);
  paintOnFrame();
});
canvas.addEventListener("pointerup", (event) => {
  if (heldPointer !== event.pointerId) return;
  heldPointer = undefined;
  if (liveMark) {
    const pointTool = ["pen", "highlight", "text", "step"].includes(liveMark.tool);
    if (!pointTool) liveMark.points[1] = position(event);
    const [first, last] = [liveMark.points[0], liveMark.points.at(-1)];
    const lineTool = liveMark.tool === "line" || liveMark.tool === "arrow";
    const moved = lineTool ? first.x !== last.x || first.y !== last.y : first.x !== last.x && first.y !== last.y;
    if (pointTool || moved) {
      marks.push(liveMark);
      redoMarks.length = 0;
    }
    liveMark = undefined;
    updateAnnotationActions();
    paint();
  }
  if (!start) return;
  const bounds = rectangle(start, position(event));
  start = current = undefined;
  if ((bounds.right - bounds.left) * canvas.clientWidth >= 3 && (bounds.bottom - bounds.top) * canvas.clientHeight >= 3) {
    void choose(() => bridge.select(bounds), true);
  } else paint();
});
canvas.addEventListener("lostpointercapture", () => {
  heldPointer = start = current = liveMark = undefined;
  paint();
});

element("full").addEventListener("click", () => choose(() => bridge.select({ left: 0, top: 0, right: 1, bottom: 1 }), true));
element("windows").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  try {
    const choices = await bridge.listWindows();
    const menu = element("window-choices");
    menu.replaceChildren(new Option(copy.select, ""), ...choices.map(({ label, id }) => new Option(label, id)));
    menu.hidden = choices.length === 0;
    notice(menu.hidden ? copy.noWindows : "");
    if (!menu.hidden) menu.focus();
  } catch { notice(copy.unavailable); }
  finally { busy = false; }
});
element("window-choices").addEventListener("change", (event) => {
  if (event.target.value) void choose(() => bridge.selectWindow(event.target.value));
});
for (const marker of annotationTools) {
  element(marker).addEventListener("click", () => {
    tool = marker;
    for (const id of annotationTools) element(id).setAttribute("aria-pressed", String(id === marker));
    element("annotation-text-field").hidden = marker !== "text";
    if (marker === "text") annotationText.focus();
  });
}
element("undo").addEventListener("click", () => moveMark(marks, redoMarks));
element("redo").addEventListener("click", () => moveMark(redoMarks, marks));
new ResizeObserver(() => view.style.setProperty("--editor-toolbar-height", `${controls.offsetHeight}px`)).observe(controls);
element("cancel").addEventListener("click", () => { void bridge.cancel().catch(() => undefined); });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); void bridge.cancel().catch(() => undefined); }
  if (mode !== "edit" || !(event.metaKey || event.ctrlKey) || event.altKey || event.target?.matches?.("input, textarea, select")) return;
  const key = event.key.toLowerCase();
  if (key === "z" || key === "y") {
    event.preventDefault();
    if (key === "y" || event.shiftKey) moveMark(redoMarks, marks);
    else moveMark(marks, redoMarks);
  }
});

for (const action of ["copy", "save", "pin", "attach", "translate", "explain", "extract"]) {
  element(action).addEventListener("click", async () => {
    if (busy || mode !== "edit" || heldPointer !== undefined) return;
    busy = true;
    notice("");
    try {
      paint();
      const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const language = action === "translate" ? element("translation-language").value : undefined;
      if (!png || !(await bridge.action(action, new Uint8Array(await png.arrayBuffer()), language))) notice(copy.closed);
    } catch { notice(copy.unavailable); }
    finally { busy = false; }
  });
}

async function startRecording(format) {
  if (busy || mode !== "edit" || !canRecord) return;
  busy = true;
  notice("");
  const recording = { format, abort: new AbortController(), runtime: undefined, paused: false, finishing: false };
  activeRecording = recording;
  const microphone = format === "video" && element("microphone").checked;
  const systemAudio = format === "video" && element("system-audio").checked;
  try {
    const capture = await bridge.startLive(format, microphone, systemAudio);
    recording.abort.signal.throwIfAborted();
    recording.runtime = await beginRegionRecording(format, capture, {
      microphone, systemAudio, signal: recording.abort.signal,
      showControls: () => {
        element("live-status").textContent = format === "scroll" ? copy.scrolling : copy.recording;
        element("pause").textContent = copy.pause;
        changeMode("live");
        return bridge.showLive();
      },
      progress: ({ seconds, height }) => {
        element("live-status").textContent = format === "scroll" ? `${copy.scrolling} · ${height} px` : `${copy.recording} · ${seconds}s`;
      },
      unmatched: () => { element("live-status").textContent = copy.joining; },
      finish: () => { setTimeout(() => { if (activeRecording === recording) void finishRecording(); }, 0); }
    });
  } catch {
    await bridge.endLive(false).catch(() => undefined);
    activeRecording = undefined;
    changeMode("edit");
    if (!recording.abort.signal.aborted) notice(copy.recordingFailed);
  } finally { busy = false; }
}

async function finishRecording() {
  const recording = activeRecording;
  if (!recording || recording.finishing) return;
  if (recording.runtime === undefined) {
    recording.abort.abort();
    await bridge.endLive(false).catch(() => undefined);
    return;
  }
  recording.finishing = true;
  busy = true;
  try {
    const result = await recording.runtime.finish();
    if (recording.format === "scroll") {
      const png = new Uint8Array(await result.arrayBuffer());
      const head = new DataView(png.buffer);
      marks.length = 0;
      redoMarks.length = 0;
      updateAnnotationActions();
      await showImage({ png, width: head.getUint32(16), height: head.getUint32(20) });
      await bridge.endLive(true);
      canRecord = false;
      changeMode("edit");
      element("copy").focus();
    } else {
      recordedBlob = result;
      await bridge.endLive(true);
      if (playbackUrl) URL.revokeObjectURL(playbackUrl);
      playbackUrl = URL.createObjectURL(result);
      const target = element(recording.format === "gif" ? "animation" : "playback");
      target.hidden = false;
      target.src = playbackUrl;
      changeMode("recording");
      element("save-recording").focus();
    }
  } catch {
    await bridge.endLive(false).catch(() => undefined);
    changeMode("edit");
    notice(copy.recordingFailed);
  } finally {
    activeRecording = undefined;
    busy = false;
  }
}

for (const format of ["scroll", "gif", "video"]) {
  element(format).addEventListener("click", () => { void startRecording(format); });
}
element("finish").addEventListener("click", () => { void finishRecording(); });
element("pause").addEventListener("click", () => {
  const record = activeRecording;
  if (!record?.runtime || record.finishing) return;
  record.paused = !record.paused;
  record.runtime.pause(record.paused);
  element("pause").textContent = record.paused ? copy.resume : copy.pause;
});
for (const action of ["copy", "save"]) {
  element(`${action}-recording`).addEventListener("click", async () => {
    if (busy || recordedBlob === undefined || mode !== "recording") return;
    busy = true;
    try {
      if (!(await bridge.recordingAction(action, new Uint8Array(await recordedBlob.arrayBuffer())))) notice(copy.closed);
    } catch { notice(copy.unavailable); }
    finally { busy = false; }
  });
}
if (bridge) {
  const clearShortcut = bridge.onShortcutStop(() => { void finishRecording(); });
  window.addEventListener("pagehide", () => {
    clearShortcut();
    activeRecording?.abort.abort();
    if (playbackUrl) URL.revokeObjectURL(playbackUrl);
  }, { once: true });
}

try {
  const initial = await bridge.read();
  const local = initial.locale === "zh-CN";
  copy = local ? chinese : english;
  document.documentElement.lang = local ? "zh-CN" : "en";
  document.documentElement.toggleAttribute("data-dark", initial.dark);
  for (const item of document.querySelectorAll("[data-label]")) {
    if (local && chinese[item.dataset.label]) item.textContent = chinese[item.dataset.label];
  }
  element("window-choices").setAttribute("aria-label", copy.select);
  element("attach").hidden = !initial.attachAvailable;
  element("capture-task-actions").hidden = !initial.attachAvailable;
  const languages = new Intl.DisplayNames([document.documentElement.lang], { type: "language" });
  const languagePicker = element("translation-language");
  languagePicker.replaceChildren(...["en", "zh-CN", "de", "es", "fr", "it", "ja", "ko", "pt", "ru"]
    .map(language => new Option(languages.of(language) ?? language, language)));
  languagePicker.value = document.documentElement.lang;
  await showImage(initial);
  changeMode(initial.mode);
} catch {
  element("controls").hidden = false;
  notice(copy.unavailable);
}
