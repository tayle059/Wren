// The conversation state machine for the companion tablet.
//   idle → inviting → speaking ⇄ listening → hearing → thinking → speaking …
// Pure TypeScript with a tiny subscribe API, wrapped by a React hook.
import { device, ApiError, type Mode, type TurnReply, type UiAction } from '../api';
import { Listener, encodeWav } from './voice';
import { browserRecognitionAvailable, chime, recognizeOnce, speak, stopSpeaking } from './speech';

export type Phase = 'idle' | 'inviting' | 'speaking' | 'listening' | 'hearing' | 'thinking' | 'playing';
export type SttMode = 'meta' | 'fake' | 'browser';

export interface Photo {
  id: string;
  title: string;
  caption: string;
  url: string;
}

export interface Reminder {
  scheduleItemId: string;
  label: string;
  url: string | null;
}

export interface ConvUI {
  phase: Phase;
  caption: string;
  heard: string;
  mode: Mode;
  photo: Photo | null;
  reminder: Reminder | null;
  nowPlaying: string | null;
  level: number;
  micError: string | null;
}

export interface OpenPlan {
  kind: 'chat' | 'checkin' | 'reminder' | 'session' | 'voice_note';
  scheduleItemId?: string | null;
  voiceNoteId?: string;
  calming?: boolean;
}

const NO_RESPONSE_MS = 25000;

export class Conversation {
  ui: ConvUI = {
    phase: 'idle',
    caption: '',
    heard: '',
    mode: 'normal',
    photo: null,
    reminder: null,
    nowPlaying: null,
    level: 0,
    micError: null,
  };
  private subs = new Set<() => void>();
  private listener: Listener | null = null;
  private conversationId: string | null = null;
  private generation = 0;
  private patientTurns = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private photoTimer: ReturnType<typeof setTimeout> | null = null;
  private calmTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelRecognition: (() => void) | null = null;
  private audio: HTMLAudioElement | null = null;
  private queue: OpenPlan[] = [];
  private bargedIn = false;
  /** Unintelligible sounds in a row (a TV, a cough). Too many and we let the conversation rest. */
  private emptyTurns = 0;
  /** Replies since the current photo was shown. */
  private photoAge = 0;

  constructor(
    private cfg: { stt: SttMode; patienceMs: number; patientName: string },
  ) {}

  // ---------- subscription ----------
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  };
  getSnapshot = () => this.ui;
  private set(patch: Partial<ConvUI>) {
    this.ui = { ...this.ui, ...patch };
    this.subs.forEach((f) => f());
  }

  configure(cfg: Partial<Conversation['cfg']>) {
    this.cfg = { ...this.cfg, ...cfg };
    this.listener?.setSilenceMs(this.cfg.patienceMs);
  }

  get busy() {
    return this.ui.phase !== 'idle';
  }

  // ---------- microphone ----------
  private async ensureMic(): Promise<boolean> {
    if (this.cfg.stt === 'browser') return true; // the browser recognizer owns the mic
    if (this.listener?.running) return true;
    this.listener = new Listener({
      silenceMs: this.cfg.patienceMs,
      onSpeechStart: () => this.onSpeechStart(),
      onUtterance: (pcm) => void this.onUtterance(pcm),
      onLevel: (level) => {
        if (Math.abs(level - this.ui.level) > 0.04) this.set({ level });
      },
    });
    try {
      await this.listener.start();
      this.set({ micError: null });
      return true;
    } catch (e) {
      this.listener = null;
      this.set({ micError: 'I can’t hear you yet. Please allow the microphone.' });
      console.warn('[mic]', e);
      return false;
    }
  }

  // ---------- entry points ----------

  /** The companion starts a conversation (scheduled invite, voice note, or a tap on Talk). */
  async open(plan: OpenPlan) {
    if (this.busy) {
      if (plan.kind !== 'chat') this.queue.push(plan);
      return;
    }
    const gen = ++this.generation;
    this.patientTurns = 0;
    this.emptyTurns = 0;
    this.bargedIn = false;
    this.set({ phase: 'inviting', caption: '', heard: '', reminder: null, mode: plan.calming ? 'calm' : this.ui.mode });
    if (plan.kind !== 'chat') {
      chime(plan.calming);
      await sleep(1100);
    }
    await this.ensureMic();
    try {
      const reply = await device.post<TurnReply>('/open', plan);
      if (gen !== this.generation) return;
      await this.handle(reply, gen);
    } catch (e) {
      console.warn('[open]', e);
      if (gen === this.generation) this.reset();
    }
  }

  /** The big Talk button, or a tap on the orb. */
  async talk() {
    if (this.ui.phase === 'idle') return this.open({ kind: 'chat' });
    if (this.ui.phase === 'speaking') {
      // Interrupt: stop talking and listen.
      stopSpeaking();
      this.beginListening(this.generation);
    }
    if (this.ui.phase === 'playing') {
      this.audio?.pause();
      this.audio?.dispatchEvent(new Event('ended'));
    }
  }

  /** Typed words (demo director, or accessibility). */
  async say(text: string) {
    if (!text.trim()) return;
    if (this.ui.phase === 'idle' || !this.conversationId) {
      await this.open({ kind: 'chat' });
      await this.waitFor(() => this.ui.phase === 'listening' || this.ui.phase === 'idle', 20000);
    }
    stopSpeaking();
    this.stopListening();
    await this.sendText(text, this.generation);
  }

  async answerReminder(status: 'confirmed' | 'not_yet') {
    const reminder = this.ui.reminder;
    if (!reminder) return;
    const gen = ++this.generation;
    stopSpeaking();
    this.stopListening();
    this.set({ phase: 'thinking', reminder: null, heard: status === 'confirmed' ? 'I took it.' : 'Not yet.' });
    try {
      const { reply } = await device.post<{ reply: TurnReply | null }>('/reminder', {
        scheduleItemId: reminder.scheduleItemId,
        status,
        conversationId: this.conversationId,
      });
      if (gen !== this.generation) return;
      if (reply) await this.handle(reply, gen);
      else this.finish('closed');
    } catch (e) {
      console.warn('[reminder]', e);
      this.finish('closed');
    }
  }

  dismissPhoto() {
    this.set({ photo: null });
  }

  // ---------- the loop ----------

  private async handle(reply: TurnReply, gen: number): Promise<void> {
    this.conversationId = reply.conversationId;
    this.applyActions(reply.actions);
    const mode = reply.mode;
    this.set({ mode, caption: reply.text, phase: 'speaking' });
    if (mode === 'calm') this.holdCalm();

    // Listen while speaking so the person can interrupt.
    this.bargedIn = false;
    if (this.cfg.stt !== 'browser' && this.listener?.running && !reply.end) this.listener.listen(true);

    const result = await speak(reply.text, { calm: mode === 'calm' });
    if (gen !== this.generation) return;
    if (result === 'cancelled' && this.bargedIn) return; // onUtterance takes it from here

    const media = reply.actions.find((a) => a.type === 'play_song' || a.type === 'play_voice_note') as
      | Extract<UiAction, { type: 'play_song' | 'play_voice_note' }>
      | undefined;
    if (media) {
      this.stopListening();
      this.set({ phase: 'playing', nowPlaying: media.type === 'play_song' ? media.title : `A message from ${media.from}` });
      await this.play(media.url);
      if (gen !== this.generation) return;
      this.set({ nowPlaying: null, phase: 'thinking' });
      try {
        const { reply: follow } = await device.post<{ reply: TurnReply | null }>('/media-ended', { conversationId: reply.conversationId });
        if (gen !== this.generation) return;
        if (follow) return this.handle(follow, gen);
      } catch (e) {
        console.warn('[media-ended]', e);
      }
      return this.beginListening(gen);
    }
    if (reply.end) return this.finish('goodbye', true);
    this.beginListening(gen);
  }

  private beginListening(gen: number) {
    if (gen !== this.generation) return;
    this.set({ phase: 'listening' });
    this.armIdleTimer(gen);
    if (this.cfg.stt === 'browser') {
      if (!browserRecognitionAvailable()) {
        this.set({ micError: 'To talk out loud here, open Kindred in Chrome or Safari, or add a Meta API key.' });
        return;
      }
      this.cancelRecognition?.();
      const rec = recognizeOnce({
        patienceMs: this.cfg.patienceMs,
        onSpeechStart: () => this.onSpeechStart(),
        onInterim: (t) => this.set({ heard: t, phase: 'hearing' }),
      });
      this.cancelRecognition = rec.cancel;
      void rec.result.then((text) => {
        if (gen !== this.generation || !text) return;
        this.cancelRecognition = null;
        void this.sendText(text, gen);
      });
    } else {
      this.listener?.relax();
      this.listener?.listen(false);
    }
  }

  private stopListening() {
    this.clearIdleTimer();
    this.listener?.pause();
    this.cancelRecognition?.();
    this.cancelRecognition = null;
  }

  private onSpeechStart() {
    this.clearIdleTimer();
    if (this.ui.phase === 'speaking') {
      this.bargedIn = true;
      stopSpeaking();
    }
    this.set({ phase: 'hearing', heard: '' });
  }

  private async onUtterance(pcm: Float32Array) {
    const gen = this.generation;
    if (!this.conversationId) return;
    this.clearIdleTimer();
    this.set({ phase: 'thinking' });
    const form = new FormData();
    form.append('conversationId', this.conversationId);
    form.append('audio', encodeWav(pcm), 'utterance.wav');
    try {
      const { transcript, reply } = await device.upload<{ transcript: string; reply: TurnReply | null }>('/turn', form);
      if (gen !== this.generation) return;
      if (!reply) {
        // Nothing intelligible. Keep listening, but don't let background noise hold the tablet forever.
        if (++this.emptyTurns >= 3) return this.restAfterNoise(gen);
        return this.beginListening(gen);
      }
      this.emptyTurns = 0;
      this.patientTurns++;
      this.set({ heard: transcript });
      await this.handle(reply, gen);
    } catch (e) {
      if (gen !== this.generation) return;
      console.warn('[turn]', e);
      const text = e instanceof ApiError && e.status === 502 ? "Sorry, I didn't quite catch that. Could you say it again?" : "I'm having a little trouble right now. Let's try again in a moment.";
      this.set({ caption: text, phase: 'speaking' });
      await speak(text, { calm: this.ui.mode === 'calm' });
      if (gen === this.generation) this.beginListening(gen);
    }
  }

  private async sendText(text: string, gen: number) {
    if (!this.conversationId) return;
    this.clearIdleTimer();
    this.set({ phase: 'thinking', heard: text });
    try {
      const { reply } = await device.post<{ reply: TurnReply | null }>('/turn', { conversationId: this.conversationId, text });
      if (gen !== this.generation) return;
      this.patientTurns++;
      if (reply) await this.handle(reply, gen);
      else this.beginListening(gen);
    } catch (e) {
      console.warn('[turn]', e);
      if (gen === this.generation) this.beginListening(gen);
    }
  }

  private async restAfterNoise(gen: number) {
    this.stopListening();
    const text = `I'll be right here whenever you'd like to talk, ${this.cfg.patientName}.`;
    this.set({ phase: 'speaking', caption: text });
    await speak(text, { calm: this.ui.mode === 'calm' });
    if (gen === this.generation) this.finish(this.patientTurns === 0 ? 'no_response' : 'silence');
  }

  private armIdleTimer(gen: number) {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(async () => {
      if (gen !== this.generation || (this.ui.phase !== 'listening' && this.ui.phase !== 'hearing')) return;
      this.stopListening();
      const text =
        this.patientTurns === 0
          ? `That's okay, ${this.cfg.patientName}. I'm right here whenever you want me.`
          : `I'll be right here, ${this.cfg.patientName}.`;
      this.set({ phase: 'speaking', caption: text, reminder: this.ui.reminder });
      await speak(text, { calm: this.ui.mode === 'calm' });
      if (gen === this.generation) this.finish(this.patientTurns === 0 ? 'no_response' : 'silence');
    }, NO_RESPONSE_MS);
  }

  private clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private applyActions(actions: UiAction[]) {
    // A photo belongs to the moment it was shown for: it fades once the talk moves on,
    // and makes way at once for a reminder or a switch to calm.
    const showsPhoto = actions.some((a) => a.type === 'show_photo');
    const clears = actions.some((a) => a.type === 'reminder_card' || (a.type === 'set_mode' && a.mode === 'calm'));
    if (!showsPhoto && this.ui.photo && (clears || ++this.photoAge >= 2)) this.set({ photo: null });
    for (const a of actions) {
      if (a.type === 'show_photo') {
        this.photoAge = 0;
        this.set({ photo: { id: a.id, title: a.title, caption: a.caption, url: a.url } });
        if (this.photoTimer) clearTimeout(this.photoTimer);
        this.photoTimer = setTimeout(() => this.set({ photo: null }), 90000);
      }
      if (a.type === 'reminder_card') this.set({ reminder: { scheduleItemId: a.scheduleItemId, label: a.label, url: a.url } });
      if (a.type === 'set_mode') this.set({ mode: a.mode });
    }
  }

  private holdCalm() {
    // Calm mode lingers for a while after the conversation, then eases back.
    if (this.calmTimer) clearTimeout(this.calmTimer);
    this.calmTimer = setTimeout(() => {
      if (!this.busy) this.set({ mode: 'normal' });
    }, 5 * 60000);
  }

  private play(url: string): Promise<void> {
    return new Promise((resolve) => {
      const audio = new Audio(url);
      this.audio = audio;
      const done = () => {
        audio.onended = null;
        audio.onerror = null;
        this.audio = null;
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      void audio.play().catch(done);
    });
  }

  private finish(reason: 'goodbye' | 'silence' | 'no_response' | 'closed', serverAlreadyEnded = false) {
    const id = this.conversationId;
    this.generation++;
    this.stopListening();
    this.conversationId = null;
    this.set({ phase: 'idle', reminder: null, heard: '', nowPlaying: null });
    if (id && !serverAlreadyEnded) void device.post('/end', { conversationId: id, reason }).catch(() => {});
    // Captions fade a little after the conversation ends.
    setTimeout(() => {
      if (this.ui.phase === 'idle') this.set({ caption: '' });
    }, 12000);
    const next = this.queue.shift();
    if (next) setTimeout(() => void this.open(next), 1500);
  }

  private reset() {
    this.finish('closed');
  }

  private waitFor(pred: () => boolean, timeoutMs: number) {
    return new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = () => (pred() || Date.now() - start > timeoutMs ? resolve() : setTimeout(tick, 100));
      tick();
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
