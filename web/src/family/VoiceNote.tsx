import { useEffect, useRef, useState } from 'react';
import { family } from '../api';
import { useFamily } from './Family';

/** Record a short message in your own voice; the tablet plays it for them. */
export function VoiceNote({ onClose }: { onClose: () => void }) {
  const { pid, name, me, toast } = useFamily();
  const [state, setState] = useState<'idle' | 'recording' | 'recorded' | 'sending'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const blob = useRef<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (state !== 'recording') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  useEffect(() => () => recorder.current?.stream.getTracks().forEach((t) => t.stop()), []);

  const start = async () => {
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        blob.current = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        setUrl(URL.createObjectURL(blob.current));
        setState('recorded');
      };
      recorder.current = rec;
      rec.start();
      setSeconds(0);
      setState('recording');
    } catch {
      setError('Please allow the microphone to record a message.');
    }
  };

  const send = async () => {
    if (!blob.current) return;
    setState('sending');
    const form = new FormData();
    const type = blob.current.type.split(';')[0];
    form.append('audio', new File([blob.current], `message.${type.split('/')[1] ?? 'webm'}`, { type }));
    form.append('from', me.user.name.split(' ')[0]);
    try {
      await family.upload(`/patients/${pid}/voice-notes`, form);
      toast(`Sent. ${name} will hear it next time the tablet is free.`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setState('recorded');
    }
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h2>A message for {name}</h2>
        <p className="muted">Keep it short and warm. {name} will hear your own voice.</p>
        <div className="recorder">
          {state === 'recording' ? (
            <button className="record-button recording" onClick={() => recorder.current?.stop()}>
              Stop · {seconds}s
            </button>
          ) : (
            <button className="record-button" onClick={() => void start()} disabled={state === 'sending'}>
              {state === 'recorded' ? 'Record again' : 'Record'}
            </button>
          )}
          {url && state !== 'recording' && <audio src={url} controls />}
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="row end">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void send()} disabled={state !== 'recorded'}>
            {state === 'sending' ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
