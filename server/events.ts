// In-process pub/sub that feeds the Server-Sent Event streams.
// Channels: `device:<patientId>` (the companion tablet) and `family:<patientId>`.

export interface KEvent {
  type: string;
  [key: string]: unknown;
}

type Listener = (e: KEvent) => void;

const channels = new Map<string, Set<Listener>>();

export function subscribe(channel: string, fn: Listener): () => void {
  let set = channels.get(channel);
  if (!set) channels.set(channel, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) channels.delete(channel);
  };
}

export function publish(channel: string, e: KEvent) {
  for (const fn of channels.get(channel) ?? []) {
    try {
      fn(e);
    } catch {
      // A broken listener must never break the publisher.
    }
  }
}

export const toDevice = (patientId: string, e: KEvent) => publish(`device:${patientId}`, e);
export const toFamily = (patientId: string, e: KEvent) => publish(`family:${patientId}`, e);

export function listenerCount(channel: string): number {
  return channels.get(channel)?.size ?? 0;
}
