// Time helpers. Everything is stored in UTC ISO strings; anything a person
// sees or a schedule depends on is computed in the patient's own timezone.

export type Clock = () => Date;

let clock: Clock = () => new Date();

/** Tests and the demo director can move time. */
export function setClock(c: Clock) {
  clock = c;
}
export function now(): Date {
  return clock();
}
export function nowIso(): string {
  return now().toISOString();
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export interface LocalParts {
  date: string; // YYYY-MM-DD
  hhmm: string; // HH:MM, 24h
  hour: number;
  minute: number;
  weekday: (typeof WEEKDAYS)[number];
}

export function localParts(tz: string, at: Date = now()): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const hour = Number(p.hour);
  const minute = Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hhmm: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    hour,
    minute,
    weekday: String(p.weekday).toLowerCase().slice(0, 3) as LocalParts['weekday'],
  };
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function hhmmOf(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** "Sunday, October 26th" in the patient's timezone. */
export function spokenDate(tz: string, at: Date = now()): string {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(at);
  const month = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long' }).format(at);
  const day = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric' }).format(at));
  return `${weekday}, ${month} ${day}${ordinal(day)}`;
}

export function spokenTime(tz: string, at: Date = now()): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(at);
}

export function partOfDay(hour: number): 'morning' | 'afternoon' | 'evening' | 'night' {
  if (hour < 5) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/** The UTC instant at which a local day starts, for range queries. */
export function localDayRangeUtc(tz: string, date: string): { start: string; end: string } {
  // Find the offset by probing: local midnight = UTC midnight minus offset.
  const guess = new Date(`${date}T00:00:00Z`);
  const offsetMin = tzOffsetMinutes(tz, guess);
  const start = new Date(guess.getTime() - offsetMin * 60000);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function tzOffsetMinutes(tz: string, at: Date): number {
  const p = localParts(tz, at);
  const asUtc = Date.UTC(
    Number(p.date.slice(0, 4)),
    Number(p.date.slice(5, 7)) - 1,
    Number(p.date.slice(8, 10)),
    p.hour,
    p.minute,
  );
  return Math.round((asUtc - Math.floor(at.getTime() / 60000) * 60000) / 60000);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
