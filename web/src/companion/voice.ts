// Microphone capture with a voice-activity detector tuned for older speakers:
// it adapts to the room's noise, tolerates long pauses mid-sentence, and can
// listen while the companion is talking so the person can interrupt.

export interface VadOptions {
  /** Silence that ends an utterance. Families can lengthen it for slower speakers. */
  silenceMs: number;
  onSpeechStart?: () => void;
  onUtterance: (pcm16k: Float32Array) => void;
  onLevel?: (level: number) => void;
}

const TARGET_RATE = 16000;
const FRAME_MS = 20;
const PRE_ROLL_MS = 400;
const START_MS = 140; // sustained speech needed to start
const BARGE_IN_MS = 380; // stricter while the companion is speaking
const MIN_UTTERANCE_MS = 350;
const MAX_UTTERANCE_MS = 30000;

const WORKLET = `
class Capture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('kindred-capture', Capture);
`;

export class Listener {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | ScriptProcessorNode | null = null;
  private rate = 48000;
  private frameLen = 960;
  private pending: number[] = [];

  private active = false; // collecting utterances at all
  private bargeIn = false; // companion is speaking: stricter detection
  private speaking = false;
  private noiseFloor = 0.004;
  private aboveMs = 0;
  private belowMs = 0;
  private preRoll: Float32Array[] = [];
  private chunks: Float32Array[] = [];
  private speechMs = 0;

  constructor(private opts: VadOptions) {}

  get running() {
    return !!this.ctx;
  }

  async start() {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.rate = ctx.sampleRate;
    this.frameLen = Math.round((this.rate * FRAME_MS) / 1000);
    const source = ctx.createMediaStreamSource(this.stream);
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, 'kindred-capture');
      node.port.onmessage = (e) => this.feed(e.data as Float32Array);
      source.connect(node);
      this.node = node;
    } catch {
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => this.feed(e.inputBuffer.getChannelData(0).slice(0));
      source.connect(node);
      node.connect(ctx.destination);
      this.node = node;
    }
    if (ctx.state === 'suspended') await ctx.resume();
  }

  stop() {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.stream = null;
    this.reset();
  }

  /** Start collecting an utterance. `bargeIn` = the companion is talking right now. */
  listen(bargeIn = false) {
    this.active = true;
    this.bargeIn = bargeIn;
    this.reset();
  }

  pause() {
    this.active = false;
    this.reset();
  }

  setSilenceMs(ms: number) {
    this.opts.silenceMs = ms;
  }

  /** Switch from barge-in watching to normal listening without losing speech in progress. */
  relax() {
    this.bargeIn = false;
  }

  private reset() {
    this.speaking = false;
    this.aboveMs = 0;
    this.belowMs = 0;
    this.chunks = [];
    this.speechMs = 0;
  }

  private feed(samples: Float32Array) {
    for (let i = 0; i < samples.length; i++) this.pending.push(samples[i]);
    while (this.pending.length >= this.frameLen) {
      const frame = Float32Array.from(this.pending.splice(0, this.frameLen));
      this.frame(frame);
    }
  }

  private frame(frame: Float32Array) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    this.opts.onLevel?.(Math.min(1, rms / 0.15));

    // Remember the last moments before speech starts so first syllables aren't clipped.
    this.preRoll.push(frame);
    while (this.preRoll.length * FRAME_MS > PRE_ROLL_MS) this.preRoll.shift();

    const threshold = Math.max(this.noiseFloor * 3, 0.012) * (this.bargeIn ? 2.2 : 1);
    const loud = rms > threshold;
    if (!this.speaking) {
      // Track the room's noise level while nobody is talking.
      if (!loud) this.noiseFloor = Math.max(0.002, this.noiseFloor * 0.95 + rms * 0.05);
      if (!this.active) return;
      this.aboveMs = loud ? this.aboveMs + FRAME_MS : 0;
      if (this.aboveMs >= (this.bargeIn ? BARGE_IN_MS : START_MS)) {
        this.speaking = true;
        this.belowMs = 0;
        this.chunks = [...this.preRoll];
        this.speechMs = this.aboveMs;
        this.opts.onSpeechStart?.();
      }
      return;
    }

    this.chunks.push(frame);
    this.speechMs += FRAME_MS;
    this.belowMs = loud ? 0 : this.belowMs + FRAME_MS;
    if (this.belowMs >= this.opts.silenceMs || this.speechMs >= MAX_UTTERANCE_MS) {
      const audio = concat(this.chunks);
      const voiced = this.speechMs - this.belowMs;
      this.reset();
      this.active = false;
      if (voiced >= MIN_UTTERANCE_MS) this.opts.onUtterance(downsample(audio, this.rate, TARGET_RATE));
      else this.active = true; // a cough or a click: keep listening
    }
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    // Average the source samples that fall into this output sample (a simple low-pass).
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

export function encodeWav(samples: Float32Array, sampleRate = TARGET_RATE): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
