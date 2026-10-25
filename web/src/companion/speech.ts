// The companion's voice (the device's own text-to-speech, so no audio leaves
// the home for speaking) and, when there's no Meta key, the browser's speech
// recognizer as a fallback ear.

let chosen: SpeechSynthesisVoice | null = null;

const PREFERRED = [/Samantha/i, /Google US English/i, /Aria/i, /Jenny/i, /Ava/i, /Allison/i, /Zira/i, /en-US.*Female/i];

function pickVoice(): SpeechSynthesisVoice | null {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('en'));
  for (const re of PREFERRED) {
    const v = voices.find((x) => re.test(x.name));
    if (v) return v;
  }
  return voices.find((v) => v.lang === 'en-US') ?? voices[0] ?? null;
}

if ('speechSynthesis' in window) {
  speechSynthesis.onvoiceschanged = () => (chosen = pickVoice());
}

export const canSpeak = () => 'speechSynthesis' in window;

let speakingToken = 0;

/** Speaks text sentence by sentence (avoids Chrome cutting long utterances). Resolves when done or cancelled. */
export function speak(text: string, opts: { calm?: boolean; onBoundary?: (spoken: string) => void } = {}): Promise<'done' | 'cancelled'> {
  if (!canSpeak() || !text.trim()) return Promise.resolve('done');
  chosen ??= pickVoice();
  const token = ++speakingToken;
  speechSynthesis.cancel();
  const sentences = text.match(/[^.!?]+[.!?]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (token !== speakingToken) return resolve('cancelled');
      if (i >= sentences.length) return resolve('done');
      const u = new SpeechSynthesisUtterance(sentences[i++]);
      if (chosen) u.voice = chosen;
      u.lang = chosen?.lang ?? 'en-US';
      u.rate = opts.calm ? 0.8 : 0.9;
      u.pitch = opts.calm ? 0.95 : 1;
      let advanced = false;
      const advance = () => {
        if (advanced) return;
        advanced = true;
        clearTimeout(guard);
        setTimeout(next, 180); // a small breath between sentences
      };
      u.onend = advance;
      u.onerror = advance;
      // Some engines never fire onend; never let that hang the conversation.
      const guard = setTimeout(advance, 2500 + sentences[i - 1].length * 110);
      opts.onBoundary?.(sentences.slice(0, i).join(' '));
      speechSynthesis.speak(u);
    };
    next();
  });
}

export function stopSpeaking() {
  speakingToken++;
  if (canSpeak()) speechSynthesis.cancel();
}

/** Browsers block audio until a tap. Call from a click handler once. */
export function unlockAudio() {
  if (canSpeak()) {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  }
  getAudioContext();
}

let ctx: AudioContext | null = null;
function getAudioContext() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** A soft two-note chime before the companion speaks first. */
export function chime(calm = false) {
  try {
    const ac = getAudioContext();
    const notes = calm ? [523.25, 659.25] : [659.25, 880];
    notes.forEach((f, i) => {
      const t = ac.currentTime + i * 0.28;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + 1.5);
    });
  } catch {
    // No audio available: the glow alone still invites.
  }
}

// ---------- Browser speech recognition (fallback ear) ----------

interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
}

export function browserRecognitionAvailable(): boolean {
  const w = window as unknown as Record<string, unknown>;
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/**
 * Listens for one utterance. Waits `patienceMs` after the last words before
 * deciding the person has finished, so slow speech isn't cut off.
 */
export function recognizeOnce(opts: { patienceMs: number; onSpeechStart?: () => void; onInterim?: (t: string) => void }): {
  result: Promise<string>;
  cancel: () => void;
} {
  const w = window as unknown as Record<string, new () => RecognitionLike>;
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';
  let finalText = '';
  let interim = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let done = false;
  let resolveFn: (t: string) => void = () => {};
  const result = new Promise<string>((resolve) => (resolveFn = resolve));
  const finish = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    try {
      rec.stop();
    } catch {
      // already stopped
    }
    resolveFn((finalText + ' ' + interim).trim());
  };
  rec.onspeechstart = () => opts.onSpeechStart?.();
  rec.onresult = (e) => {
    interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += ' ' + r[0].transcript;
      else interim += r[0].transcript;
    }
    opts.onInterim?.((finalText + ' ' + interim).trim());
    if (timer) clearTimeout(timer);
    timer = setTimeout(finish, opts.patienceMs);
  };
  rec.onerror = (e) => {
    if (e.error !== 'no-speech' && e.error !== 'aborted') console.warn('[speech]', e.error);
  };
  rec.onend = () => {
    // Engines stop on their own after silence; restart until we decide.
    if (!done && !finalText && !interim) {
      try {
        rec.start();
        return;
      } catch {
        // fall through to finish
      }
    }
    finish();
  };
  rec.start();
  return {
    result,
    cancel: () => {
      done = true;
      if (timer) clearTimeout(timer);
      try {
        rec.abort();
      } catch {
        // ignore
      }
      resolveFn('');
    },
  };
}
