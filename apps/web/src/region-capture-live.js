import { regionScrollOffset, regionScrollExtraRows } from "./region-capture-scroll.js";
import { finalizeRecordedWebm } from "./region-capture-webm.js";

const maxBytes = 36 * 1024 * 1024;

export async function beginRegionRecording(mode, grant, options) {
  const tracks = new Set();
  const source = document.createElement("video");
  source.muted = true;
  source.playsInline = true;
  let clock;
  let audioContext;
  let worker;
  let recorder;
  let disposed = false;
  let paused = false;
  let failure;
  let finishRequest;
  let frameRequest;
  const chunks = [];
  let byteCount = 0;
  let startedAt;
  let lastFrameAt;
  let parts;
  let previous;
  let position = 0, firstRow = 0, afterLastRow = grant.height;
  let lastStatus = -1;
  let pausedAt;
  let pauseTime = 0;
  const canvas = document.createElement("canvas");
  canvas.width = grant.width;
  canvas.height = grant.height;
  const context = canvas.getContext("2d", { willReadFrequently: mode !== "video" });
  if (!context) throw new Error("Canvas capture unavailable.");

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.clearInterval(clock);
    if (recorder?.state !== "inactive") {
      try { recorder?.stop(); } catch { /* The browser already retired the recorder. */ }
    }
    for (const track of tracks) track.stop();
    source.srcObject = null;
    worker?.terminate();
    frameRequest?.reject(new Error("Recording was cancelled."));
    finishRequest?.reject(new Error("Recording was cancelled."));
    void audioContext?.close().catch(() => undefined);
  };
  const retain = (stream) => {
    for (const track of stream.getTracks()) tracks.add(track);
    if (disposed || options.signal.aborted) {
      for (const track of stream.getTracks()) track.stop();
      options.signal.throwIfAborted();
      throw new Error("Recording was cancelled.");
    }
    return stream;
  };
  const fail = (error) => {
    failure = error;
    options.finish();
  };

  options.signal.addEventListener("abort", dispose, { once: true });
  try {
    const display = retain(await navigator.mediaDevices.getDisplayMedia({ video: true, audio: options.systemAudio }));
    const screen = display.getVideoTracks()[0];
    if (!screen || options.systemAudio && !display.getAudioTracks().some(track => track.readyState === "live")) {
      throw new Error("The selected screen or computer audio is unavailable.");
    }
    const microphone = options.microphone
      ? retain(await navigator.mediaDevices.getUserMedia({ audio: true, video: false })) : undefined;
    if (options.microphone && !microphone?.getAudioTracks().some(track => track.readyState === "live")) {
      throw new Error("The selected microphone is unavailable.");
    }
    source.srcObject = display;
    await source.play();
    await options.showControls();
    await new Promise(resolve => window.setTimeout(resolve, 180));
    options.signal.throwIfAborted();
    screen.addEventListener("ended", () => fail(new Error("The captured display closed.")), { once: true });

    let canvasTrack;
    if (mode === "video") {
      const content = canvas.captureStream(0);
      canvasTrack = content.getVideoTracks()[0];
      tracks.add(canvasTrack);
      const audio = [...display.getAudioTracks(), ...(microphone?.getAudioTracks() ?? [])];
      if (audio.length === 1) content.addTrack(audio[0]);
      if (audio.length > 1) {
        audioContext = new AudioContext();
        const mix = audioContext.createMediaStreamDestination();
        for (const track of audio) audioContext.createMediaStreamSource(new MediaStream([track])).connect(mix);
        const mixed = mix.stream.getAudioTracks()[0];
        tracks.add(mixed);
        content.addTrack(mixed);
        await audioContext.resume();
      }
      const formats = audio.length ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
        : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
      const mimeType = formats.find(format => MediaRecorder.isTypeSupported(format));
      if (!mimeType) throw new Error("WebM recording is unavailable.");
      recorder = new MediaRecorder(content, { mimeType, videoBitsPerSecond: 3_500_000 });
      recorder.addEventListener("dataavailable", ({ data }) => {
        if (!data.size || disposed) return;
        if (byteCount + data.size > maxBytes) {
          fail(new Error("The recording size limit was reached."));
          return;
        }
        chunks.push(data);
        byteCount += data.size;
        if (byteCount > maxBytes - 3 * 1024 * 1024) options.finish();
      });
      recorder.addEventListener("error", () => fail(new Error("WebM encoding failed.")));
      recorder.start(900);
    } else if (mode === "gif") {
      worker = new Worker(new URL("./region-capture-gif.worker.js", import.meta.url), { type: "module" });
      worker.onerror = () => fail(new Error("GIF encoding failed."));
      worker.onmessage = ({ data }) => {
        if (data.type === "frame") {
          const pending = frameRequest;
          frameRequest = undefined;
          pending?.resolve();
          if (data.nearLimit) options.finish();
        } else if (data.type === "done") finishRequest?.resolve(new Blob([data.buffer], { type: "image/gif" }));
        else {
          const error = new Error("GIF encoding failed.");
          frameRequest?.reject(error);
          finishRequest?.reject(error);
          fail(error);
        }
      };
      worker.postMessage({ type: "start", width: canvas.width, height: canvas.height });
    }

    const draw = () => {
      const { selection } = grant;
      const x = Math.floor(selection.left * source.videoWidth), y = Math.floor(selection.top * source.videoHeight);
      const width = Math.ceil(selection.right * source.videoWidth) - x, height = Math.ceil(selection.bottom * source.videoHeight) - y;
      if (width <= 0 || height <= 0) throw new Error("The selected region is no longer available.");
      context.drawImage(source, x, y, width, height, 0, 0, canvas.width, canvas.height);
    };
    const tick = () => {
      if (disposed || paused || options.signal.aborted) return;
      const now = performance.now(), seconds = Math.floor((now - startedAt - pauseTime) / 1000);
      if (seconds !== lastStatus) { options.progress({ seconds, height: afterLastRow - firstRow }); lastStatus = seconds; }
      if (seconds >= (mode === "gif" ? 24 : mode === "video" ? 100 : 160)) { options.finish(); return; }
      if (frameRequest !== undefined) return;
      try {
        draw();
        if (canvasTrack !== undefined) { canvasTrack.requestFrame(); return; }
        const frame = context.getImageData(0, 0, canvas.width, canvas.height);
        if (worker) {
          let resolve, reject;
          const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
          void promise.catch(() => undefined);
          frameRequest = { promise, resolve, reject };
          const delay = lastFrameAt === undefined ? 130 : now - lastFrameAt;
          lastFrameAt = now;
          worker.postMessage({ type: "frame", pixels: frame.data.buffer, delay }, [frame.data.buffer]);
        } else if (previous === undefined) {
          parts = [frame];
          previous = frame;
        } else {
          const offset = regionScrollOffset(previous, frame);
          if (offset === undefined) { options.unmatched(); return; }
          if (offset === 0) return;
          position += offset;
          const before = Math.max(0, firstRow - position);
          const after = Math.max(0, position + frame.height - afterLastRow);
          if ((afterLastRow - firstRow + before + after) > Math.min(16_000, Math.floor(36_000_000 / canvas.width))) {
            options.finish();
            return;
          }
          if (before) { parts.unshift(regionScrollExtraRows(frame, -before)); firstRow = position; }
          if (after) { parts.push(regionScrollExtraRows(frame, after)); afterLastRow = position + frame.height; }
          previous = frame;
          options.progress({ seconds, height: afterLastRow - firstRow });
        }
      } catch (error) { fail(error); }
    };
    startedAt = performance.now();
    clock = window.setInterval(tick, mode === "video" ? 66 : mode === "gif" ? 130 : 240);
    tick();

    return {
      pause(value) {
        if (disposed || value === paused) return;
        paused = value;
        if (paused) {
          pausedAt = performance.now();
          if (recorder?.state === "recording") recorder.pause();
        } else {
          pauseTime += performance.now() - pausedAt;
          lastFrameAt = undefined;
          if (recorder?.state === "paused") recorder.resume();
        }
      },
      async finish() {
        window.clearInterval(clock);
        try {
          if (failure) throw failure;
          if (recorder) {
            const duration = (paused ? pausedAt : performance.now()) - startedAt - pauseTime;
            await new Promise((resolve, reject) => {
              if (recorder.state === "inactive") { reject(new Error("The video encoder is unavailable.")); return; }
              const timeout = window.setTimeout(() => reject(new Error("The video encoder did not finish.")), 5000);
              recorder.addEventListener("stop", () => { window.clearTimeout(timeout); resolve(); }, { once: true });
              recorder.stop();
            });
            if (failure || !byteCount) throw failure ?? new Error("No video frames were recorded.");
            const bytes = finalizeRecordedWebm(new Uint8Array(await new Blob(chunks).arrayBuffer()), duration);
            if (bytes.byteLength > maxBytes) throw new Error("The recording exceeds the WebM size limit.");
            return new Blob([bytes], { type: "video/webm" });
          }
          if (worker) {
            await frameRequest?.promise;
            return await new Promise((resolve, reject) => {
              const timeout = window.setTimeout(() => reject(new Error("The GIF encoder did not finish.")), 5000);
              finishRequest = {
                resolve: value => { window.clearTimeout(timeout); resolve(value); },
                reject: error => { window.clearTimeout(timeout); reject(error); }
              };
              worker.postMessage({ type: "finish" });
            });
          }
          if (!parts?.length) throw new Error("No scrolling region was captured.");
          canvas.height = afterLastRow - firstRow;
          let y = 0;
          for (const strip of parts) { context.putImageData(strip, 0, y); y += strip.height; }
          const png = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
          if (!png || png.size > 24 * 1024 * 1024) throw new Error("The scrolling capture exceeds the PNG size limit.");
          return png;
        } finally {
          options.signal.removeEventListener("abort", dispose);
          dispose();
        }
      }
    };
  } catch (error) {
    options.signal.removeEventListener("abort", dispose);
    dispose();
    throw error;
  }
}
