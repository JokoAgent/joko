interface VoicePrewarmMediaDevices {
  getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream>;
}

/** Keeps only an optional local microphone stream; callers receive clones. */
export class VoiceInputMicrophonePrewarmer {
  readonly #mediaDevices: VoicePrewarmMediaDevices;
  #stream?: MediaStream;
  #deviceId?: string;
  #generation = 0;

  constructor(mediaDevices: VoicePrewarmMediaDevices = navigator.mediaDevices) {
    this.#mediaDevices = mediaDevices;
  }

  async warm(deviceId?: string): Promise<boolean> {
    if (
      deviceId === this.#deviceId
      && this.#stream !== undefined
      && this.#stream.getAudioTracks().some((track) => track.readyState !== "ended")
    ) return true;
    const generation = ++this.#generation;
    this.#releaseStream();
    let stream: MediaStream;
    try {
      stream = await this.#mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(deviceId === undefined ? {} : { deviceId: { exact: deviceId } })
        },
        video: false
      });
    } catch { return false; }
    if (generation !== this.#generation) {
      stopStream(stream);
      return false;
    }
    this.#stream = stream;
    this.#deviceId = deviceId;
    return true;
  }

  checkout(): MediaStream | undefined {
    const stream = this.#stream;
    if (stream === undefined || stream.getAudioTracks().every((track) => track.readyState === "ended")) return undefined;
    try { return stream.clone(); }
    catch { return undefined; }
  }

  release(): void {
    this.#generation += 1;
    this.#releaseStream();
  }

  #releaseStream(): void {
    if (this.#stream !== undefined) stopStream(this.#stream);
    this.#stream = undefined;
    this.#deviceId = undefined;
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
