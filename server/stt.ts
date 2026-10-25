// Speech to text. Muse Voice Transcribe when a key is set; a scripted queue for
// end-to-end tests; otherwise the tablet uses the browser's own recognizer and
// sends text instead of audio.
import { config, hasMeta } from './config.ts';
import { transcribe } from './meta.ts';
import { memoryItems } from './domain.ts';

const fakeQueue: string[] = [];

export function queueFakeTranscript(...texts: string[]) {
  fakeQueue.push(...texts);
}

export type SttMode = 'meta' | 'fake' | 'browser';

export function sttMode(): SttMode {
  if (config.sttMode === 'fake') return 'fake';
  return hasMeta() ? 'meta' : 'browser';
}

export async function speechToText(patientId: string, wav: Uint8Array): Promise<string> {
  const mode = sttMode();
  if (mode === 'fake') return fakeQueue.shift() ?? '';
  if (mode === 'browser') throw new Error('Server speech recognition needs META_API_KEY');
  const names = memoryItems(patientId).flatMap((m) => [m.title, ...m.title.split(/\s+/)]);
  return transcribe(wav, [...new Set(names)].filter((n) => n.length > 2));
}
