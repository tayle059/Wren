// Small fetch helpers. The family session is an HttpOnly cookie the page can't
// read. The tablet's device token lives in localStorage on the tablet; every
// storage access is guarded because storage can be unavailable.

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
  get: <T>(path: string) => request<T>(`/api${path}`),
  post: <T>(path: string, body: unknown = {}) => request<T>(`/api${path}`, { method: 'POST', body: json(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(`/api${path}`, { method: 'PATCH', body: json(body) }),
  del: <T>(path: string) => request<T>(`/api${path}`, { method: 'DELETE' }),
  upload: <T>(path: string, form: FormData) => request<T>(`/api${path}`, { method: 'POST', body: form }),
  events: (path: string) => new EventSource(`/api${path}`), // the session cookie goes along automatically
};

/** Remembers an invitation across a Google/Apple/Facebook round trip. */
export const pendingInvite = {
  get: () => {
    try {
      return sessionStorage.getItem('kindred.invite');
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) sessionStorage.setItem('kindred.invite', v);
      else sessionStorage.removeItem('kindred.invite');
    } catch {
      // Without storage the person just opens the invite link again after signing in.
    }
  },
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
