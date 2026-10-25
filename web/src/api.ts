// Small fetch helpers. Family and device tokens live in localStorage on their
// own devices; every read is guarded because storage can be unavailable.

function store(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the app still works for this session.
  }
  return value ?? null;
}

const memory: Record<string, string | null> = {};
export const tokens = {
  get family() {
    return memory.family ?? store('kindred.family');
  },
  set family(v: string | null) {
    memory.family = v;
    store('kindred.family', v);
  },
  get device() {
    return memory.device ?? store('kindred.device');
  },
  set device(v: string | null) {
    memory.device = v;
    store('kindred.device', v);
  },
};

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown> = {}) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
  if (!res.ok) throw new ApiError(String(body.error ?? `Request failed (${res.status})`), res.status, body);
  return body as T;
}

const json = (b: unknown) => JSON.stringify(b);

export const family = {
  get: <T>(path: string) => request<T>(`/api${path}`, { token: tokens.family }),
  post: <T>(path: string, body: unknown = {}) => request<T>(`/api${path}`, { method: 'POST', body: json(body), token: tokens.family }),
  patch: <T>(path: string, body: unknown) => request<T>(`/api${path}`, { method: 'PATCH', body: json(body), token: tokens.family }),
  del: <T>(path: string) => request<T>(`/api${path}`, { method: 'DELETE', token: tokens.family }),
  upload: <T>(path: string, form: FormData) => request<T>(`/api${path}`, { method: 'POST', body: form, token: tokens.family }),
  events: (path: string) => new EventSource(`/api${path}?token=${encodeURIComponent(tokens.family ?? '')}`),
};

export const device = {
  get: <T>(path: string) => request<T>(`/api/device${path}`, { token: tokens.device }),
  post: <T>(path: string, body: unknown = {}) => request<T>(`/api/device${path}`, { method: 'POST', body: json(body), token: tokens.device }),
  upload: <T>(path: string, form: FormData) => request<T>(`/api/device${path}`, { method: 'POST', body: form, token: tokens.device }),
  events: () => new EventSource(`/api/device/events?token=${encodeURIComponent(tokens.device ?? '')}`),
};

// ---------- Shared types ----------

export type Mode = 'normal' | 'calm';

export type UiAction =
  | { type: 'show_photo'; id: string; title: string; caption: string; url: string }
  | { type: 'play_song'; id: string; title: string; url: string }
  | { type: 'reminder_card'; scheduleItemId: string; label: string; url: string | null }
  | { type: 'play_voice_note'; id: string; from: string; url: string }
  | { type: 'set_mode'; mode: Mode };

export interface TurnReply {
  conversationId: string;
  text: string;
  actions: UiAction[];
  mode: Mode;
  end: boolean;
  source: 'muse' | 'offline';
}
