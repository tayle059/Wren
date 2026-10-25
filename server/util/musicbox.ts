// A small music-box synthesizer, so the demo can ship a favorite song without
// any copyrighted recording. "Amazing Grace" (melody "New Britain", 1829) is
// in the public domain; this rendition is generated from scratch.
import { encodeWav } from './wav.ts';

const NOTE: Record<string, number> = {
  C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88,
  C5: 523.25, D5: 587.33, E5: 659.25, G3: 196.0, B3: 246.94, D3: 146.83, C3: 130.81,
};

// [note, beats] in 3/4 time.
const AMAZING_GRACE: [string, number][] = [
  ['D4', 1],
  ['G4', 2], ['B4', 0.5], ['G4', 0.5],
  ['B4', 2], ['A4', 1],
  ['G4', 2], ['E4', 1],
  ['D4', 2], ['D4', 1],
  ['G4', 2], ['B4', 0.5], ['G4', 0.5],
  ['B4', 2], ['A4', 1],
  ['D5', 3],
  ['D5', 2], ['B4', 1],
  ['D5', 1.5], ['B4', 0.5], ['D5', 0.5], ['B4', 0.5],
  ['G4', 2], ['D4', 1],
  ['E4', 1.5], ['G4', 0.5], ['G4', 0.5], ['E4', 0.5],
  ['D4', 2], ['D4', 1],
  ['G4', 2], ['B4', 0.5], ['G4', 0.5],
  ['B4', 2], ['A4', 1],
  ['G4', 3],
];

// A soft bass note on the first beat of each bar.
const BASS: string[] = ['G3', 'G3', 'C3', 'G3', 'G3', 'G3', 'D3', 'G3', 'G3', 'C3', 'G3', 'G3', 'G3', 'D3', 'G3'];

export function amazingGraceWav(sampleRate = 22050, bpm = 80): Uint8Array {
  const beat = 60 / bpm;
  const totalBeats = AMAZING_GRACE.reduce((n, [, b]) => n + b, 0) + 3;
  const out = new Float32Array(Math.ceil(totalBeats * beat * sampleRate));
  const pluck = (freq: number, at: number, gain: number, decay: number) => {
    const start = Math.floor(at * sampleRate);
    const len = Math.min(out.length - start, Math.floor(decay * 5 * sampleRate));
    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t / decay) * Math.min(1, t * 400);
      // Bell-like partials give the music-box timbre.
      const s =
        Math.sin(2 * Math.PI * freq * t) +
        0.45 * Math.sin(2 * Math.PI * freq * 2 * t) * Math.exp(-t * 3) +
        0.18 * Math.sin(2 * Math.PI * freq * 3.01 * t) * Math.exp(-t * 6);
      out[start + i] += gain * env * s;
    }
  };
  let t = 0.3;
  for (const [n, b] of AMAZING_GRACE) {
    pluck(NOTE[n], t, 0.32, 0.55);
    t += b * beat;
  }
  // Bass on each downbeat, after the pickup.
  for (let bar = 0; bar < BASS.length; bar++) pluck(NOTE[BASS[bar]], 0.3 + beat * (1 + bar * 3), 0.16, 0.9);
  const peak = out.reduce((m, x) => Math.max(m, Math.abs(x)), 0) || 1;
  for (let i = 0; i < out.length; i++) out[i] = (out[i] / peak) * 0.8;
  return encodeWav(out, sampleRate);
}
